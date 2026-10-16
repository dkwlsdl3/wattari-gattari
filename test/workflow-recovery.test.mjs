import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { acquireLock, durableProcess, readJson } from '../src/workflow-recovery.mjs';
import { codexResult } from '../src/workflow-provider.mjs';
import { taskGraph } from '../src/web/task-graph.mjs';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('a killed coordinator recovers its actual owned command result without executing the command twice', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'waga-proof-recovery-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const marker = path.join(root, 'side-effect'), file = path.join(root, 'job.json');
  const argv = [process.execPath, '-e', `require('fs').appendFileSync(${JSON.stringify(marker)},'once\\n');setTimeout(()=>console.log('finished'),500)`];
  const coordinator = path.join(root, 'coordinator.mjs');
  await fs.writeFile(coordinator, `import {durableProcess} from ${JSON.stringify(new URL('../src/workflow-recovery.mjs', import.meta.url).href)};await durableProcess(${JSON.stringify(file)},${JSON.stringify(argv)},{cwd:${JSON.stringify(root)},intervalMs:20});`);
  const child = spawn(process.execPath, [coordinator], { stdio: 'ignore' });
  t.after(() => { try { child.kill('SIGTERM'); } catch {} });
  for (let i = 0; i < 250; i++) { try { await fs.access(marker); break; } catch { await sleep(20); } }
  assert.equal(await fs.readFile(marker, 'utf8'), 'once\n');
  child.kill('SIGKILL'); await once(child, 'exit');
  const result = await durableProcess(file, argv, { cwd: root, intervalMs: 20 });
  assert.equal(result.exitCode, 0); assert.match(result.stdout, /finished/); assert.equal(await fs.readFile(marker, 'utf8'), 'once\n');
  assert.equal((await fs.stat(`${file}.result`)).mode & 0o777, 0o600);
});

test('only a confirmed dead lock owner is recovered; live or malformed ownership stays blocked', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'waga-proof-lock-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'lock');
  await fs.writeFile(file, String(process.pid)); await assert.rejects(acquireLock(file), /生|살아/);
  const child = spawn(process.execPath, ['-e', '']); await once(child, 'exit'); await fs.writeFile(file, String(child.pid));
  const lock = await acquireLock(file); await lock.close(); assert.equal(await fs.readFile(file, 'utf8'), String(process.pid));
  await fs.writeFile(file, 'unknown'); await assert.rejects(acquireLock(file), /확인되지/);
  assert.equal(await readJson(path.join(root, 'missing')), null);
});

test('real Codex JSONL fixture preserves native identity, reported tokens and independent verdict without fabricating cost', async () => {
  const raw = JSON.parse(await fs.readFile(new URL('./fixtures/codex-workflow-result.json', import.meta.url)));
  const result = codexResult(raw, 'gpt-6.1-sol', true);
  assert.equal(result.exitCode, 0); assert.ok(result.sessionId); assert.equal(result.verdict, 'pass'); assert.equal(result.usage.input_tokens, 41286); assert.equal(result.costUsd, null);
  for (const value of [{ verdict: 'pass' }, { verdict: 'pass', reason: '' }, { verdict: 'pass', reason: 123 }, { verdict: 'pass', reason: '   ' }]) {
    const events = [{ type: 'thread.started', thread_id: 'proof' }, { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(value) } }, { type: 'turn.completed', usage: {} }];
    assert.notEqual(codexResult({ ...raw, stdout: events.map(event => JSON.stringify(event)).join('\n') }, 'model', true).verdict, 'pass');
  }
  assert.equal(codexResult({ ...raw, stdout: '{"type":"turn.failed","error":{"code":"approval_required"}}' }, 'gpt-6.1-sol', false).failureKind, 'permission');
});

test('task relations are declared artifact dependencies, and missing verification explains the blocked node', () => {
  const run = { nodes: [{ id: 'fix', title: '수정', state: 'failed', dependsOn: [], inputs: [], outputs: ['a.mjs'], attempts: [] }, { id: 'verify', title: '동작 검사', state: 'pending', dependsOn: ['fix'], inputs: [{ from: 'fix', path: 'a.mjs' }], attempts: [] }] };
  const graph = taskGraph(run); assert.equal(graph.edges[0].basis, 'declared'); assert.equal(graph.edges[0].kind, 'artifact'); assert.match(graph.nodes[1].blockedReason, /수정/);
});

test('separate workflow jobs share two actual process slots rather than multiplying host concurrency', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'waga-proof-slots-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'active'));
  const code = `const fs=require('fs'),root=${JSON.stringify(root)},file=root+'/active/'+process.pid;fs.writeFileSync(file,'');fs.appendFileSync(root+'/counts',fs.readdirSync(root+'/active').length+'\\n');setTimeout(()=>{fs.unlinkSync(file);console.log('done')},300);`;
  const results = await Promise.all([0, 1, 2].map(index => durableProcess(path.join(root, `${index}.json`), [process.execPath, '-e', code], { cwd: root, intervalMs: 20, poolDirectory: path.join(root, 'slots') })));
  assert.ok(results.every(result => result.exitCode === 0));
  const counts = (await fs.readFile(path.join(root, 'counts'), 'utf8')).trim().split('\n').map(Number); assert.equal(counts.length, 3); assert.ok(Math.max(...counts) <= 2);
});

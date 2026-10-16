import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import { WorkStore } from '../src/work-store.mjs';
import { RunStore } from '../src/run-store.mjs';
import { ExecutionStore } from '../src/execution-store.mjs';
import { WorkAssistant, workSources, interpretAnalysis } from '../src/work-assistant.mjs';
import { nativeSpanIdentity } from '../src/native-execution.mjs';
import { startWebServer } from '../src/web-server.mjs';
const exec = promisify(execFile);
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'waga-proof-assistant-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await exec('git', ['init', '-q', root]); await fs.writeFile(path.join(root, 'value.mjs'), 'export default 1;\n');
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node check.mjs' } }));
  await exec('git', ['-C', root, 'add', '.']); await exec('git', ['-C', root, '-c', 'user.name=Proof', '-c', 'user.email=proof@invalid', 'commit', '-qm', 'proof']);
  const store = new WorkStore(path.join(root, '.state', 'works')); // outside the repo status below
  await fs.writeFile(path.join(root, '.git', 'info', 'exclude'), '.state/\n');
  const session = { id: 'claude:waga-proof', provider: 'claude', sessionId: 'waga-proof', name: 'waga-proof-assistant', cwd: root, status: 'idle' };
  const messages = [{ id: 'old', role: 'user', text: '다른 작업' }, { id: 'u1', role: 'user', text: 'value 값을 2로 바꾸고 확인해 주세요.' }, { id: 'tool:read', role: 'activity', tool: 'Read', text: 'value.mjs', state: 'completed', output: 'export default 1;' }, { id: 'a1', role: 'assistant', text: '아직 수정하지 않았습니다.' }, { id: 'u2', role: 'user', text: '그 다음 별도 작업' }];
  const work = store.observe(messages[1], session);
  return { root, store, session, messages, work, bridge: { history: async () => ({ messages }) } };
}
const output = () => ({ summary: '값을 2로 변경하고 동작 확인', goal: 'value를 2로 변경', decisions: [{ text: '값 2가 요구됨', sourceId: 'message:u1' }], facts: [{ text: '현재 값은 1로 관측됨', sourceId: 'message:tool:read' }], unknowns: [], next: [{ text: '수정과 검사가 필요함', sourceId: 'message:u1' }], nodes: [
  { id: 'edit', title: '값 수정', role: 'edit', prompt: 'value.mjs를 2로 수정', dependsOn: [], evidenceIds: ['message:u1', 'message:tool:read'], outputs: ['value.mjs'], inputs: [], check: ['npm', 'test'] },
  { id: 'verify', title: '변경 결과 확인', role: 'verify', prompt: '전달된 값 확인', dependsOn: ['edit'], evidenceIds: ['message:u1'], outputs: [], inputs: [{ from: 'edit', path: 'value.mjs' }], check: ['npm', 'test'] },
] });

test('native conversation adoption is idempotent and task sources exclude neighbouring instructions while linking exact tool IDs', async t => {
  const f = await fixture(t);
  assert.equal(f.store.observe(f.messages[1], f.session).id, f.work.id);
  assert.equal(f.work.delivery, 'observed'); assert.equal(f.work.submitAttemptedAt, undefined);
  const submitted = f.store.create({ id: crypto.randomUUID(), instruction: '새로 보낸 지시' }, f.session);
  f.store.submitted(submitted.id, f.session.id);
  const received = { id: 'native-new', role: 'user', text: submitted.instruction };
  f.store.reconcile(f.session.id, [received]); assert.equal(f.store.observe(received, f.session).id, submitted.id);
  const id = nativeSpanIdentity(f.session, 'tool:read').id;
  const bundle = await workSources(f.bridge, f.session, 'u1', { id: 'execution', spans: [{ id, name: 'Read', file: 'value.mjs' }] }, f.work.instruction);
  assert.ok(bundle.sources.some(row => row.id === 'message:u1')); assert.ok(bundle.sources.some(row => row.id === 'file:value.mjs' && row.text.includes('default 1')));
  assert.ok(!bundle.sources.some(row => ['message:old', 'message:u2'].includes(row.id)));
  assert.equal(bundle.sources.find(row => row.id === id).executionId, 'execution');
  assert.equal((await workSources(f.bridge, f.session, 'missing', null, 'original')).message, null);
});

test('LLM graph proposals require real source IDs and valid dependencies, never claiming observed calls are verified task completion', async t => {
  const f = await fixture(t), bundle = await workSources(f.bridge, f.session, 'u1', null, f.work.instruction);
  const result = interpretAnalysis(output(), bundle, f.work);
  assert.equal(result.nodes[0].basis, 'llm-proposal'); assert.equal(result.nodes[0].state, undefined);
  assert.equal(result.context.facts[0].kind, 'inference'); assert.match(result.context.facts[0].source, /message:tool:read/);
  assert.equal(result.manifest.nodes[1].inputs[0].from, 'edit');
  const invented = output(); invented.facts[0].sourceId = 'unseen'; assert.throws(() => interpretAnalysis(invented, bundle, f.work), /출처/);
  const cycle = output(); cycle.nodes[0].dependsOn = ['verify']; assert.throws(() => interpretAnalysis(cycle, bundle, f.work), /순환/);
  const missingCheck = output(); missingCheck.nodes[0].check = []; assert.equal(interpretAnalysis(missingCheck, bundle, f.work).manifest, null);
  const inventedCommand = output(); inventedCommand.nodes[0].check = ['sh', '-c', 'rm -rf /']; assert.equal(interpretAnalysis(inventedCommand, bundle, f.work).manifest, null);
});

test('automatic interpretation caches its result, creates sourced handoff, preserves user corrections and does not retry a failed model silently', async t => {
  const f = await fixture(t); let calls = 0;
  const assistant = new WorkAssistant({ store: f.store, root: path.join(f.root, '.state', 'runtime'), processRunner: async () => { calls++; return { exitCode: 0, stdout: JSON.stringify({ structured_output: output(), usage: { input_tokens: 7 }, total_cost_usd: 0.001, session_id: crypto.randomUUID() }) }; } });
  const bundle = await workSources(f.bridge, f.session, 'u1', null, f.work.instruction);
  assistant.start(f.work, bundle); assistant.start(f.work, bundle); await assistant.pending.get(f.work.id);
  assert.equal(calls, 1); assert.equal(f.store.read(f.work.id).analysis.state, 'ready'); assert.equal(f.store.read(f.work.id).context.origin, 'llm');
  assistant.start(f.work, bundle); assert.equal(calls, 1);
  f.store.context(f.work.id, { goal: '사용자가 정정한 목표' });
  const corrected = await workSources(f.bridge, f.session, 'u1', null, f.work.instruction, f.store.read(f.work.id).context);
  assert.ok(corrected.sources.find(source => source.id === 'selected-context').text.includes('사용자가 정정한 목표'));
  assistant.start(f.store.read(f.work.id), bundle, { refresh: true }); await assistant.pending.get(f.work.id);
  assert.equal(f.store.read(f.work.id).context.goal, '사용자가 정정한 목표');
  const failed = new WorkAssistant({ store: f.store, root: path.join(f.root, '.state', 'runtime'), processRunner: async () => { throw Error('lost response'); } });
  failed.start(f.work, bundle, { refresh: true }); await failed.pending.get(f.work.id);
  assert.equal(f.store.read(f.work.id).analysis.state, 'failed'); failed.start(f.work, bundle); assert.equal(failed.pending.size, 0);
});

test('web work interpretation reads existing native instructions, scopes generated plans and refuses busy or stale duplicate execution', async t => {
  const f = await fixture(t); let models = 0, launches = 0;
  const assistant = new WorkAssistant({ store: f.store, root: path.join(f.root, '.state', 'runtime'), processRunner: async () => { models++; return { exitCode: 0, stdout: JSON.stringify({ structured_output: output(), session_id: crypto.randomUUID() }) }; } });
  const runStore = new RunStore(path.join(f.root, '.state', 'runs'));
  const web = await startWebServer({ port: 0, cwd: f.root, workStore: f.store, assistant, runStore, executionStore: new ExecutionStore(path.join(f.root, '.state', 'executions')), launch: async () => { launches++; }, bridge: { ...f.bridge, discover: async () => ({ sessions: [f.session, { ...f.session, id: 'foreign' }], warnings: [] }) } }); t.after(() => web.close());
  const headers = { Cookie: `waga_web=${web.url.split('#')[1]}`, Origin: web.origin, 'Content-Type': 'application/json' };
  const request = async (tail, data, session = f.session.id) => fetch(`${web.origin}/api/${tail}?session=${encodeURIComponent(session)}`, { headers, ...(data ? { method: 'POST', body: JSON.stringify(data) } : {}) });
  const observe = await request('works', { nativeMessageId: 'u1' }); assert.equal((await observe.json()).id, f.work.id);
  assert.equal((await request('works', { nativeMessageId: 'invented' })).status, 404);
  assert.equal((await request(`works/${f.work.id}`, { analyze: true }, 'foreign')).status, 404); assert.equal(models, 0);
  assert.equal((await request(`works/${f.work.id}`, { analyze: true })).status, 202); await assistant.pending.get(f.work.id);
  const row = await (await request(`works/${f.work.id}`)).json(); assert.equal(row.analysis.state, 'ready'); assert.equal(models, 1);
  const plan = { analysisId: row.analysis.id, launchId: crypto.randomUUID() };
  f.session.status = 'working'; assert.equal((await request(`works/${row.id}`, plan)).status, 409); assert.equal(launches, 0);
  f.session.status = 'idle'; f.messages[3].text = '진행 내용 변경'; assert.equal((await request(`works/${row.id}`, plan)).status, 409); assert.equal(launches, 0);
  f.messages[3].text = '아직 수정하지 않았습니다.';
  const created = await Promise.all([request(`works/${row.id}`, plan), request(`works/${row.id}`, { ...plan, launchId: crypto.randomUUID() })]);
  assert.deepEqual(created.map(response => response.status).sort(), [200, 201]); assert.equal(launches, 1); assert.equal(runStore.list(f.root).length, 1);
  assert.equal((await request(`works/${row.id}`, plan)).status, 200); assert.equal(launches, 1);
  assert.equal((await request(`works/${row.id}`, { ...plan, launchId: crypto.randomUUID() })).status, 200); assert.equal(launches, 1);
});

test('captured Claude and Codex work interpretations preserve sourced claims, provider identity and reported usage without converting proposals to completion', async t => {
  for (const provider of ['claude', 'codex']) {
    const f = await fixture(t); f.session.provider = provider;
    const native = JSON.parse(await fs.readFile(new URL(`./fixtures/work-analysis-${provider}.json`, import.meta.url)));
    const assistant = new WorkAssistant({ store: f.store, root: path.join(f.root, '.state', 'runtime'), processRunner: async () => native });
    const bundle = await workSources(f.bridge, f.session, 'u1', null, f.work.instruction);
    assistant.start({ ...f.work, session: f.session }, bundle); await assistant.pending.get(f.work.id);
    const result = f.store.read(f.work.id).analysis;
    assert.equal(result.state, 'ready'); assert.ok(result.sessionId); assert.ok(result.usage);
    assert.ok(result.nodes.every(node => node.basis === 'llm-proposal' && node.state === undefined));
    if (provider === 'codex') { assert.equal(result.costUsd, null); assert.ok(result.manifest); }
    else assert.ok(result.costUsd > 0);
  }
});

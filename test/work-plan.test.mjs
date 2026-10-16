import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkStore } from '../src/work-store.mjs';
import { runCli } from '../src/cli.mjs';
import { startWebServer } from '../src/web-server.mjs';
import { taskGraph } from '../src/web/task-graph.mjs';

const output = () => { let value = ''; return { write(text) { value += text; }, get value() { return value; } }; };
const plan = () => ({ messageId: 'original-user', revision: 0, title: '순서 동기화 수정', skill: 'issue-loop', nodes: [
  { id: 'reproduce', title: '웹·TUI 불일치 재현', state: 'active', dependsOn: [], evidence: ['message:original-user'] },
  { id: 'fix', title: '순서 저장 경로 수정', state: 'pending', dependsOn: ['reproduce'], evidence: [] },
  { id: 'check', title: '웹·TUI 동작 확인', state: 'pending', dependsOn: ['fix'], evidence: [] },
] });
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'waga-proof-plan-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new WorkStore(path.join(root, 'works'));
  const session = { id: 'codex:waga-proof-plan', provider: 'codex', name: 'waga-proof-plan', cwd: root };
  const messages = [{ id: 'original-user', role: 'user', text: '이슈루프로 순서 동기화 문제를 수정해 주세요.' }];
  let writes = 0;
  const bridge = { discover: async () => ({ sessions: [session], warnings: [] }), history: async () => ({ messages }), instruct: async () => { writes++; throw Error('Unexpected native execution'); } };
  return { root, store, session, messages, bridge, writes: () => writes };
}

test('skill plans keep their identity and revision across updates, and reject invented verification/cycles/stale changes', async t => {
  const f = await fixture(t), work = f.store.observe(f.messages[0], f.session), input = plan();
  const initial = f.store.plan(work.id, input);
  assert.equal(initial.plan.revision, 1); assert.equal(initial.analysis, undefined);
  assert.deepEqual(f.store.plan(work.id, input), initial); // Replayed snapshot changes nothing.
  const changed = structuredClone(initial.plan); changed.nodes[0].state = 'reported'; changed.nodes[1].state = 'blocked'; changed.nodes[1].reason = '재현 조건 확인 대기';
  const updated = f.store.plan(work.id, changed);
  assert.equal(updated.id, work.id); assert.equal(updated.plan.revision, 2); assert.equal(updated.plan.nodes[1].reason, '재현 조건 확인 대기');
  assert.deepEqual(new WorkStore(f.store.directory).read(work.id).plan, updated.plan);
  assert.throws(() => f.store.plan(work.id, { ...input, title: '오래된 수정' }), { status: 409 });
  for (const mutate of [p => { p.nodes[0].state = 'passed'; }, p => { p.nodes[0].dependsOn = ['check']; }, p => { p.nodes[1].dependsOn = ['absent']; }, p => { p.nodes[1].state = 'blocked'; }]) {
    const invalid = plan(); invalid.revision = 2; mutate(invalid); assert.throws(() => f.store.plan(work.id, invalid), { status: 400 });
  }
  assert.equal(f.store.read(work.id).plan.revision, 2);
});

test('public plan CLI reads native IDs and records the skill plan without running a model, a duplicate workflow or native input', async t => {
  const f = await fixture(t), stdout = output(), stderr = output();
  const options = { bridge: f.bridge, workStore: f.store, stdout, stderr, workflowRuntime: () => { throw Error('Unexpected duplicate workflow'); } };
  assert.equal(await runCli(['plan', f.session.id], options), 0);
  assert.equal(JSON.parse(stdout.value).message.id, 'original-user'); assert.equal(f.store.list(f.session.id).length, 0);
  const file = path.join(f.root, 'plan.json'); await fs.writeFile(file, JSON.stringify(plan()));
  const written = output(); assert.equal(await runCli(['plan', f.session.id, file], { ...options, stdout: written }), 0);
  const recorded = JSON.parse(written.value);
  assert.equal(recorded.plan.revision, 1); assert.equal(recorded.messageId, 'original-user'); assert.equal(f.writes(), 0);
  f.messages.push({ id: 'follow-up', role: 'user', text: '재현은 됐나요?' });
  const updated = plan(); updated.revision = 1; updated.nodes[0].state = 'reported'; updated.nodes[0].evidence.push('file:proof/reproduction.md'); updated.nodes[1].state = 'active';
  await fs.writeFile(file, JSON.stringify(updated));
  assert.equal(await runCli(['plan', f.session.id, file], { ...options, stdout: output() }), 0);
  assert.equal(f.store.list(f.session.id).length, 1); assert.equal(f.store.read(recorded.workId).plan.revision, 2);
  const missing = { ...updated, messageId: 'invented-message' }; await fs.writeFile(file, JSON.stringify(missing));
  assert.equal(await runCli(['plan', f.session.id, file], { ...options, stdout: output() }), 1);
  assert.equal(f.store.list(f.session.id).length, 1); assert.equal(f.writes(), 0);
});

test('web reads the same skill plan as CLI and plan updates cannot escape the selected session', async t => {
  const f = await fixture(t), work = f.store.observe(f.messages[0], f.session);
  f.store.plan(work.id, plan());
  const other = { ...f.session, id: 'claude:waga-proof-other', provider: 'claude' };
  f.bridge.discover = async () => ({ sessions: [f.session, other], warnings: [] });
  const web = await startWebServer({ bridge: f.bridge, workStore: f.store, cwd: f.root, port: 0 });
  t.after(() => web.close());
  const headers = { Cookie: `waga_web=${web.url.split('#')[1]}`, Origin: web.origin, 'Content-Type': 'application/json' };
  const route = session => `${web.origin}/api/works/${work.id}?session=${session}`;
  const response = await fetch(route(f.session.id), { headers }); assert.equal(response.status, 200);
  const row = await response.json(); assert.equal(row.plan.title, plan().title); assert.equal(row.plan.nodes.length, 3);
  const changed = plan(); changed.revision = 1; changed.nodes[1].state = 'blocked'; changed.nodes[1].reason = '권한 대기';
  const denied = await fetch(route(other.id), { headers, method: 'POST', body: JSON.stringify({ plan: changed }) }); assert.equal(denied.status, 404);
  const accepted = await fetch(route(f.session.id), { headers, method: 'POST', body: JSON.stringify({ plan: changed }) }); assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).plan.nodes[1].reason, '권한 대기'); assert.equal(f.writes(), 0);
  const graph = taskGraph({ declaration: true, nodes: row.plan.nodes.map(node => ({ ...node, inputs: [], attempts: [] })) });
  assert.equal(graph.edges.length, 2); assert.equal(graph.edges[0].label, '계획한 선행 관계');
  assert.equal(graph.nodes[1].blockedReason, ''); // A declared dependency is not an enforced verification gate.
});

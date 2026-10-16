import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkStore } from '../src/work-store.mjs';
import { ExecutionStore } from '../src/execution-store.mjs';
import { WorkTracker } from '../src/work-tracker.mjs';
import { nativeSpanIdentity } from '../src/native-execution.mjs';
import { startWebServer } from '../src/web-server.mjs';

async function fixture(t, { register = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'waga-proof-tracker-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new WorkStore(path.join(root, 'works')), executions = new ExecutionStore(path.join(root, 'executions'));
  const session = { id: 'claude:waga-proof-tracker', provider: 'claude', sessionId: 'waga-proof-tracker', name: 'waga-proof-tracker', cwd: root, status: 'working' };
  const messages = [{ id: 'old', role: 'user', text: '이전 과제' }, { id: 'old-response', role: 'assistant', text: '이전 응답' }, { id: 'u1', role: 'user', text: '값을 바꾸고 검사해 주세요.' }];
  let clock = 10000, interpretations = 0, writes = 0;
  const bridge = { discover: async () => ({ sessions: [session], warnings: [] }), history: async () => ({ messages }), instruct: async () => { writes++; throw Error('Unexpected native resubmission'); } };
  const assistant = { pending: new Map(), start(work) { interpretations++; store.analysis(work.id, { id: 'proof-analysis', state: 'ready', summary: '원문 기반 제안', nodes: [] }); } };
  if (register) store.observe(messages[2], session);
  const tracker = new WorkTracker({ bridge, store, executions, assistant, now: () => clock });
  return { root, store, executions, session, messages, bridge, assistant, tracker, now: () => clock, advance: ms => { clock += ms; }, calls: () => interpretations, writes: () => writes };
}

test('explicit work progress follows native evidence without creating interpretation jobs', async t => {
  const f = await fixture(t);
  let row = f.tracker.observe(f.session, { messages: f.messages });
  assert.equal(f.store.list(f.session.id).length, 1); // No historical backfill of model jobs.
  assert.equal(row.progress.state, 'working');
  f.messages.push({ id: 'tool:change', role: 'activity', tool: 'Edit', text: 'value.mjs', state: 'running' });
  const id = nativeSpanIdentity(f.session, 'tool:change').id;
  f.executions.saveNative(f.session, [{ id, file: 'value.mjs', attributes: {} }], {});
  row = f.tracker.observe(f.session, { messages: f.messages });
  assert.equal(row.progress.current, 'value.mjs'); assert.deepEqual(row.progress.files, ['value.mjs']);
  f.advance(3000); await f.tracker.tick(); assert.equal(f.calls(), 0);
  f.messages[3].state = 'completed'; f.messages.push({ id: 'a1', role: 'assistant', text: '수정했습니다.' }); f.session.status = 'idle';
  await f.tracker.tick(); assert.equal(f.calls(), 0);
  f.advance(2001); await f.tracker.tick(); assert.equal(f.calls(), 0);
  row = f.store.read(row.id); assert.equal(row.progress.state, 'responded'); assert.equal(row.state, undefined); // Reply is not test completion.
  await f.tracker.tick(); assert.equal(f.calls(), 0); assert.equal(f.writes(), 0);
  assert.ok(!JSON.stringify(row.progress).includes('수정했습니다.')); // Progress does not copy the transcript.
  f.messages.push({ id: 'u2', role: 'user', text: '다른 값을 확인해 주세요.' });
  f.store.observe(f.messages.at(-1), f.session);
  f.session.status = 'needs-input'; row = f.tracker.observe(f.session, { messages: f.messages });
  assert.equal(row.progress.state, 'needs-input'); assert.equal(row.progress.calls, 0); assert.equal(row.progress.response, undefined);
  f.messages.push({ id: 'u3', role: 'user', text: '추가 지시입니다.' });
  f.store.observe(f.messages.at(-1), f.session);
  f.tracker.observe(f.session, { messages: f.messages });
  assert.equal(f.store.read(row.id).progress.state, 'continued');
});

test('errors and live changes stay with the exact instruction and a stopped tracker makes no model calls', async t => {
  const f = await fixture(t);
  f.messages.push({ id: 'tool:fail', role: 'activity', tool: 'Bash', text: 'npm test', output: 'assertion failed', state: 'error' });
  f.session.status = 'needs-input';
  const row = f.tracker.observe(f.session, { messages: f.messages });
  assert.equal(row.progress.errors, 1); assert.match(row.progress.lastError, /npm test/); assert.ok(!row.progress.lastError.includes('assertion failed'));
  f.session.status = 'idle'; f.messages.push({ id: 'a1', role: 'assistant', text: '확인 부탁드립니다.' });
  await f.tracker.tick(); f.advance(3000); f.tracker.close(); await f.tracker.tick();
  assert.equal(f.calls(), 0); assert.equal(f.writes(), 0);
});

test('a tool-only latest page is traced back to its actual user instruction instead of an unrelated stored work', async t => {
  const f = await fixture(t); const reads = [];
  const tool = { id: 'tool:long', role: 'activity', tool: 'Read', text: 'value.mjs', state: 'running' };
  f.bridge.history = async (session, options) => { reads.push(options.cursor); return options.cursor === 'before-tools' ? { messages: [f.messages[2]], nextCursor: null } : { messages: [tool], nextCursor: 'before-tools' }; };
  f.tracker.watch(f.session); await f.tracker.tick();
  const row = f.store.list(f.session.id).at(-1);
  assert.equal(row.messageId, 'u1'); assert.equal(row.progress.current, 'value.mjs'); assert.equal(row.progress.calls, 1);
  assert.deepEqual(reads, [undefined, 'before-tools']); assert.equal(f.calls(), 0);
});

test('old per-message interpretations are not relaunched by conversation tracking', async t => {
  const f = await fixture(t);
  const original = f.tracker.observe(f.session, { messages: f.messages });
  f.store.analysis(original.id, { id: 'existing-analysis', state: 'running' });
  f.messages.push({ id: 'u2', role: 'user', text: '새 작업입니다.' });
  let recovered;
  f.assistant.start = work => { recovered = work; f.store.analysis(work.id, { ...work.analysis, state: 'ready' }); };
  await f.tracker.tick();
  assert.equal(recovered, undefined); assert.equal(f.store.read(original.id).analysis.id, 'existing-analysis'); assert.equal(f.writes(), 0);
});

test('reading ordinary conversation does not register tasks or schedule model calls', async t => {
  const f = await fixture(t, { register: false }); f.session.status = 'idle'; f.messages.push({ id: 'a1', role: 'assistant', text: '응답입니다.' });
  const web = await startWebServer({ bridge: f.bridge, cwd: f.root, port: 0, workStore: f.store, executionStore: f.executions, assistant: f.assistant, now: f.now });
  t.after(() => web.close());
  const headers = { Cookie: `waga_web=${web.url.split('#')[1]}` };
  const response = await fetch(`${web.origin}/api/sessions/${encodeURIComponent(f.session.id)}/messages`, { headers });
  const page = await response.json(); assert.equal(response.status, 200); assert.equal(page.work, undefined); assert.equal(f.store.list(f.session.id).length, 0);
  f.advance(3000);
  const deadline = Date.now() + 2300;
  while (!f.calls() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(f.calls(), 0); assert.equal(f.writes(), 0);
});

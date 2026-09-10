import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ClaudeProvider } from '../src/providers/claude.mjs';
import { CodexProvider } from '../src/providers/codex.mjs';

// Same busy input observed in Keeper's 2026-09-10 ask incident. No live sockets.
test('busy Claude receives the request before any idle poll', async () => {
  const events = [];
  const provider = new ClaudeProvider({
    endpointFactory: () => ({
      async start() {},
      async send() { events.push('send'); return 'message'; },
      async waitForDisposition() { return { state: 'accepted' }; },
      async waitForReply() { return { text: 'answer' }; },
      async stop() {},
    }),
    wait: async () => { throw new Error('busy wait must not precede delivery'); },
  });
  provider.list = async () => [{ id: 'claude:proof', sessionId: 'proof', status: 'working', socketPath: '/tmp/proof.sock' }];
  const progress = [];
  const result = await provider.ask({ id: 'claude:proof', sessionId: 'proof', socketPath: '/tmp/proof.sock' }, 'question', {
    requestId: 'request', onProgress: event => progress.push(event),
  });
  assert.equal(result.reply, 'answer');
  assert.deepEqual(events, ['send']);
  assert.ok(progress.some(event => event.state === 'accepted'));
  assert.ok(progress.some(event => event.messageId === 'message'));
});

test('Codex result reads only the original turn and never submits or follows another turn', async () => {
  const methods = [];
  const provider = new CodexProvider({
    run: async () => ({ stdout: JSON.stringify({ status: 'running', socketPath: '/tmp/proof.sock' }) }),
    clientFactory: async () => ({
      async initialize() {}, async close() {},
      async request(method) {
        methods.push(method);
        if (method === 'thread/turns/list') return { data: [{ id: 'other', status: 'completed' }, { id: 'original', status: 'interrupted' }], nextCursor: null };
        throw new Error(`unexpected ${method}`);
      },
    }),
  });
  const result = await provider.result({ session: { nativeId: 'proof' }, turnId: 'original', requestId: 'request', untilIdle: true });
  assert.equal(result.state, 'interrupted');
  assert.equal(result.reply, undefined);
  assert.deepEqual(methods, ['thread/turns/list']);
});

const { RequestStore } = await import('../src/request-store.mjs');
const { SessionBridge } = await import('../src/session-bridge.mjs');
const { readClaudeReply } = await import('../src/providers/claude-reply.mjs');
const { runCli } = await import('../src/cli.mjs');
const session = { id: 'codex:proof', nativeId: 'proof', provider: 'codex', cwd: '/tmp/waga-proof' };
function storeFor(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'waga-proof-requests-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return new RequestStore(root);
}
function output() { return { value: '', write(text) { this.value += text; } }; }

test('timeout preserves request identity and result never resends', async t => {
  const store = storeFor(t);
  let sends = 0;
  const adapter = {
    name: 'codex', list: async () => [session],
    async ask(_session, _message, { onProgress }) {
      sends++;
      onProgress({ state: 'submitting', delivery: 'unknown' });
      onProgress({ state: 'submitted', delivery: 'accepted', turnId: 'original' });
      throw Object.assign(new Error('reply timed out'), { code: 'REPLY_TIMEOUT' });
    },
    async result(record) { assert.equal(record.turnId, 'original'); return { state: 'replied', reply: 'late answer' }; },
  };
  const bridge = new SessionBridge({ providers: [adapter], requestStore: store });
  let requestId;
  await assert.rejects(bridge.ask(session.id, 'sensitive prompt', { untilIdle: true }), error => {
    requestId = error.requestId;
    assert.equal(error.delivery, 'accepted');
    return error.code === 'REPLY_TIMEOUT';
  });
  const record = store.read(requestId);
  assert.equal(record.untilIdle, true);
  assert.doesNotMatch(fs.readFileSync(store.file(requestId), 'utf8'), /sensitive prompt/);
  const result = await bridge.result(requestId);
  assert.equal(result.reply, 'late answer');
  assert.equal(sends, 1);
});

test('FIFO serializes overlapping asks through completion and releases a failed request', async t => {
  const store = storeFor(t), order = [];
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const bridge = new SessionBridge({ requestStore: store, providers: [{
    name: 'codex', list: async () => [session],
    async ask(_session, message) {
      order.push(message);
      if (message === 'first') { entered(); await blocked; throw new Error('first failed'); }
      return { target: session.id, reply: 'second answer' };
    },
  }] });
  const first = assert.rejects(bridge.ask(session.id, 'first'), /first failed/);
  await started;
  let queued;
  const waiting = new Promise(resolve => { queued = resolve; });
  const second = bridge.ask(session.id, 'second', { onProgress: event => { if (event.state === 'waiting-local') queued(); } });
  await waiting;
  assert.deepEqual(order, ['first']);
  release();
  await first;
  assert.equal((await second).reply, 'second answer');
  assert.deepEqual(order, ['first', 'second']);
});

test('dead and PID-reused owners never block or auto-submit a new request', async t => {
  const store = storeFor(t);
  const old = store.create(session);
  await store.acquire(old, { timeoutMs: 100 });
  store.update(old, { owner: { pid: process.pid, start: 'different-start-time' } });
  const current = store.create(session);
  await store.acquire(current, { timeoutMs: 100 });
  assert.equal(store.active(old), false);
  assert.equal(store.read(old.requestId).delivery, 'not-sent');
});

test('local queue deadline expires without calling the provider', async t => {
  const store = storeFor(t);
  const first = store.create(session);
  await store.acquire(first, { timeoutMs: 100 });
  let sends = 0;
  const bridge = new SessionBridge({ requestStore: store, providers: [{ name: 'codex', list: async () => [session], ask: async () => { sends++; } }] });
  await assert.rejects(bridge.ask(session.id, 'second', { waitTimeoutMs: 5 }), error => error.code === 'TARGET_BUSY_TIMEOUT' && error.delivery === 'not-sent');
  assert.equal(sends, 0);
});

test('unknown submission survives an RPC failure and cannot be mistaken for not-sent', async t => {
  const store = storeFor(t);
  const bridge = new SessionBridge({ requestStore: store, providers: [{
    name: 'codex', list: async () => [session],
    async ask(_session, _message, { onProgress }) { onProgress({ state: 'submitting', delivery: 'unknown' }); throw new Error('connection lost'); },
    async result(record) { assert.equal(record.turnId, undefined); return { state: 'result-unknown' }; },
  }] });
  let id;
  await assert.rejects(bridge.ask(session.id, 'question'), error => { id = error.requestId; return error.delivery === 'unknown'; });
  assert.equal((await bridge.result(id)).state, 'result-unknown');
});

test('request store rejects traversal and refuses to follow record symlinks', t => {
  const store = storeFor(t);
  assert.throws(() => store.read('../elsewhere'), { code: 'REQUEST_ID_INVALID' });
  const record = store.create(session);
  assert.equal(fs.statSync(store.file(record.requestId)).mode & 0o777, 0o600);
  fs.unlinkSync(store.file(record.requestId));
  fs.symlinkSync('/etc/passwd', store.file(record.requestId));
  assert.throws(() => store.read(record.requestId), { code: 'ELOOP' });
});

test('Claude recovery excludes wrong requests, user input and sidechains', async t => {
  const store = storeFor(t), home = store.directory;
  const target = { cwd: '/tmp/waga-proof-reply', sessionId: '12345678-1234-1234-1234-123456789abc' };
  const dir = path.join(home, '.claude', 'projects', '-tmp-waga-proof-reply');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${target.sessionId}.jsonl`);
  const row = { type: 'assistant', sessionId: target.sessionId, timestamp: '2026-09-10T00:00:00Z', message: { content: [{ type: 'text', text: '[WAGA REPLY wanted]\nRIGHT' }] } };
  const rows = [
    { ...row, type: 'user' }, { ...row, isSidechain: true },
    { ...row, sessionId: 'another-session' },
    { ...row, message: { content: [{ type: 'text', text: '[WAGA REPLY other]\nWRONG' }] } }, row,
  ];
  fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  assert.equal(await readClaudeReply(target, 'wanted', { homeDirectory: home, since: 0 }), '[WAGA REPLY wanted]\nRIGHT');
  assert.equal(await readClaudeReply(target, 'missing', { homeDirectory: home, since: 0 }), null);
  assert.equal(await readClaudeReply(target, 'wanted', { homeDirectory: home, since: Date.now() + 86400000 }), null);
});

test('CLI recovery distinguishes pending from a reply and reports request metadata on failure', async () => {
  const stdout = output(), stderr = output();
  const bridge = { result: async () => ({ state: 'result-unknown', requestId: 'r', target: 'codex:proof', delivery: 'unknown' }) };
  assert.equal(await runCli(['result', 'r', '--json'], { bridge, stdout, stderr }), 3);
  assert.equal(JSON.parse(stdout.value).state, 'result-unknown');
  bridge.result = async () => ({ state: 'replied', requestId: 'r', reply: 'late reply' });
  stdout.value = '';
  assert.equal(await runCli(['result', 'r'], { bridge, stdout, stderr }), 0);
  assert.equal(stdout.value, 'late reply\n');
  stdout.value = '';
  bridge.ask = async () => { throw Object.assign(new Error('timeout'), { code: 'REPLY_TIMEOUT', requestId: 'r', target: 'codex:proof', delivery: 'accepted' }); };
  assert.equal(await runCli(['ask', 'codex:proof', 'hello', '--json'], { bridge, stdout, stderr }), 1);
  assert.equal(JSON.parse(stdout.value).delivery, 'accepted');
  assert.match(stderr.value, /waga result r/);
});

test('FIFO admission is shared across independent Node processes', async t => {
  const { spawn } = await import('node:child_process');
  const store = storeFor(t);
  const first = store.create(session);
  await store.acquire(first, { timeoutMs: 2000 });
  const ready = path.join(store.directory, 'child-waiting');
  const done = path.join(store.directory, 'child-acquired');
  const code = `
    import fs from 'node:fs';
    import { RequestStore } from ${JSON.stringify(new URL('../src/request-store.mjs', import.meta.url).href)};
    const store = new RequestStore(process.argv[1]);
    const record = store.create(${JSON.stringify(session)});
    await store.acquire(record, { timeoutMs: 2000, onProgress: () => fs.writeFileSync(${JSON.stringify(ready)}, 'waiting') });
    fs.writeFileSync(${JSON.stringify(done)}, 'acquired');
    store.update(record, { finished: true });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, store.directory], { stdio: ['ignore', 'ignore', 'pipe'] });
  t.after(() => child.kill());
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  const finished = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)); });
  const deadline = Date.now() + 1500;
  while (!fs.existsSync(ready) && Date.now() < deadline && child.exitCode === null) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(fs.existsSync(ready), errors || 'child must enter the queue');
  assert.equal(fs.existsSync(done), false);
  store.update(first, { finished: true });
  assert.equal(await finished, 0, errors);
  assert.equal(fs.readFileSync(done, 'utf8'), 'acquired');
});

test('concurrent recovery and original completion publish just one immutable answer', async t => {
  const store = storeFor(t);
  const record = store.create(session);
  assert.deepEqual(store.reply(record.requestId, { state: 'replied', reply: 'first' }), { state: 'replied', reply: 'first' });
  assert.deepEqual(store.reply(record.requestId, { state: 'replied', reply: 'later' }), { state: 'replied', reply: 'first' });
  assert.equal(store.reply(record.requestId).reply, 'first');
});

test('Claude recovery reads the measured native transcript fixture, requiring an explicit reply tag', async t => {
  const store = storeFor(t), home = store.directory;
  const rows = fs.readFileSync(new URL('./fixtures/claude-preview.jsonl', import.meta.url), 'utf8').trim().split('\n').map(JSON.parse);
  const native = rows.find(row => row.type === 'assistant');
  const target = { cwd: native.cwd, sessionId: native.sessionId };
  const dir = path.join(home, '.claude', 'projects', target.cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${target.sessionId}.jsonl`);
  fs.writeFileSync(file, rows.map(JSON.stringify).join('\n') + '\n');
  assert.equal(await readClaudeReply(target, 'proof', { homeDirectory: home, since: 0 }), null);
  // Replay the measured shape with only the answer text replaced by the new contract.
  native.message.content[0].text = '[WAGA REPLY proof]\nANSWER';
  fs.appendFileSync(file, JSON.stringify(native) + '\n');
  assert.equal(await readClaudeReply(target, 'proof', { homeDirectory: home, since: 0 }), '[WAGA REPLY proof]\nANSWER');
});

test('SIGTERM closes only the caller and leaves its acknowledged request recoverable', async t => {
  const { spawn } = await import('node:child_process');
  const store = storeFor(t);
  const ready = path.join(store.directory, 'signal-ready');
  const cleaned = path.join(store.directory, 'exit-cleanup');
  const code = `
    import fs from 'node:fs';
    import { runCli } from ${JSON.stringify(new URL('../src/cli.mjs', import.meta.url).href)};
    import { SessionBridge } from ${JSON.stringify(new URL('../src/session-bridge.mjs', import.meta.url).href)};
    import { RequestStore } from ${JSON.stringify(new URL('../src/request-store.mjs', import.meta.url).href)};
    const provider = {
      name: 'codex', list: async () => [${JSON.stringify(session)}],
      async ask(session, message, { requestId, onProgress }) {
        onProgress({ state: 'submitted', delivery: 'accepted', turnId: 'original' });
        process.once('exit', () => fs.writeFileSync(${JSON.stringify(cleaned)}, 'cleaned'));
        fs.writeFileSync(${JSON.stringify(ready)}, requestId);
        await new Promise(resolve => setTimeout(resolve, 10000));
      },
    };
    await runCli(['ask', 'codex:proof', 'question'], { handleSignals: true,
      bridge: new SessionBridge({ providers: [provider], requestStore: new RequestStore(process.argv[1]) }),
    });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, store.directory], { stdio: 'ignore' });
  t.after(() => child.kill());
  const finished = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)); });
  const deadline = Date.now() + 2000;
  while (!fs.existsSync(ready) && Date.now() < deadline && child.exitCode === null) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(fs.existsSync(ready), 'child must submit before interruption');
  child.kill('SIGTERM');
  assert.equal(await finished, 143);
  assert.equal(fs.readFileSync(cleaned, 'utf8'), 'cleaned');
  const record = store.read(fs.readFileSync(ready, 'utf8'));
  assert.equal(record.turnId, 'original');
  assert.equal(record.delivery, 'accepted');
  assert.equal(store.active(record), false);
});

test('Claude live reply wait ignores another request on the same peer socket', async t => {
  const net = await import('node:net');
  const { EventEmitter } = await import('node:events');
  const { ClaudePeerEndpoint, buildClaudeFrame } = await import('../src/providers/claude-peer.mjs');
  const store = storeFor(t);
  let accept;
  // Transport fixture: exercises the real endpoint parser/listener without a
  // Unix listener, which is prohibited in the current test sandbox.
  t.mock.method(net.default, 'createServer', listener => {
    accept = listener;
    return { once() {}, listen(file, done) { fs.writeFileSync(file, 'socket fixture'); done(); }, close(done) { done(); } };
  });
  const endpoint = new ClaudePeerEndpoint({ homeDirectory: store.directory });
  t.after(() => endpoint.stop());
  await endpoint.start({ socketDirectory: store.directory });
  const socket = new EventEmitter();
  socket.setEncoding = () => {};
  socket.destroy = () => socket.emit('close');
  accept(socket);
  let replied = false;
  const waiting = endpoint.waitForReply('/target', 'message', { timeoutMs: 500, requestId: 'wanted' }).then(reply => { replied = true; return reply; });
  const frame = (fromSocket, text) => JSON.stringify(buildClaudeFrame({ fromSocket, text })) + '\n';
  socket.emit('data', frame('/target', '[WAGA REPLY other]\nWRONG'));
  socket.emit('data', frame('/different', '[WAGA REPLY wanted]\nWRONG'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(replied, false);
  socket.emit('data', frame('/target', '[WAGA REPLY wanted]\nRIGHT'));
  assert.equal((await waiting).text, '[WAGA REPLY wanted]\nRIGHT');
});

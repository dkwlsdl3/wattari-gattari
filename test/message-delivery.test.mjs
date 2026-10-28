import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { MessageDelivery, launchDelivery } from '../src/message-delivery.mjs';
import { drainMessages } from '../src/message-worker.mjs';
import { RequestStore } from '../src/request-store.mjs';
import { SessionBridge } from '../src/session-bridge.mjs';
import { runCli } from '../src/cli.mjs';

const session = { id: 'codex:12345678-1234-1234-1234-123456789abc', nativeId: '12345678-1234-1234-1234-123456789abc', provider: 'codex', name: 'proof', cwd: '/tmp/waga-proof' };
function setup(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'waga-proof-delivery-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new RequestStore(directory);
  const provider = { name: 'codex', list: async () => [session], ...overrides };
  const bridge = new SessionBridge({ requestStore: store, providers: [provider] });
  const delivery = new MessageDelivery({ store, bridge, launch: async () => {} });
  return { store, bridge, delivery };
}
const output = () => ({ value: '', write(text) { this.value += text; } });

test('busy ask cannot block durable CLI acceptance; request ID and actual reply survive dispatch', async t => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  const calls = [];
  const { store, bridge, delivery } = setup(t, {
    async ask(_session, message, { requestId, onProgress }) {
      calls.push({ message, requestId });
      onProgress({ state: 'submitting', delivery: 'unknown' });
      onProgress({ state: 'submitted', delivery: 'accepted', turnId: 'original' });
      entered(); await hold;
      return { reply: 'received', delivery: 'accepted' };
    },
    async send(_session, message, { requestId }) { calls.push({ message, requestId }); return { delivery: 'accepted' }; },
  });
  const stdout = output();
  assert.equal(await runCli(['ask', session.id, 'handoff', '--async', '--json'], { bridge, delivery, stdout, stderr: output() }), 0);
  const first = JSON.parse(stdout.value);
  assert.equal(first.delivery, 'local-queued');
  assert.equal((await bridge.result(first.requestId)).delivery, 'local-queued');
  const draining = drainMessages({ store, target: session.id, bridge });
  await started;
  try {
    const second = await delivery.enqueue(session.id, 'notification');
    assert.equal(second.delivery, 'local-queued');
    assert.equal(store.read(second.requestId).payload, 'notification');
    assert.equal(store.read(first.requestId).payload, undefined);
    assert.equal(calls.length, 1);
    release(); await draining;
    assert.deepEqual(calls, [{ message: 'handoff', requestId: first.requestId }, { message: 'notification', requestId: second.requestId }]);
    assert.equal((await delivery.wait(first.requestId)).reply, 'received');
    assert.equal(store.read(second.requestId).payload, undefined);
  } finally { release(); await draining; }
});

test('worker crash before submission resumes; unknown submission never replays and original result remains recoverable', async t => {
  let submits = 0;
  const { store, bridge, delivery } = setup(t, {
    async ask(_session, _message, { onProgress }) {
      submits++;
      onProgress({ state: 'submitting', delivery: 'unknown' });
      onProgress({ state: 'submitted', delivery: 'accepted', turnId: 'original' });
      throw Object.assign(Error('reply timeout'), { code: 'REPLY_TIMEOUT' });
    },
    async result(record) { assert.equal(record.turnId, 'original'); return { state: 'replied', delivery: 'accepted', reply: 'late reply' }; },
  });
  const first = await delivery.enqueue(session.id, 'handoff', { kind: 'ask' });
  const unknown = await delivery.enqueue(session.id, 'do not resend');
  store.update(store.read(unknown.requestId), { delivery: 'unknown', state: 'submitting', payload: undefined, owner: null });
  const historical = store.create(session);
  let launches = 0;
  delivery.launch = async () => { launches++; };
  await delivery.recover(first.requestId);
  await delivery.recover(unknown.requestId);
  assert.equal(launches, 1);
  assert.equal(store.read(unknown.requestId).error.code, 'DELIVERY_INTERRUPTED');
  assert.equal(store.read(historical.requestId).finished, false);
  await drainMessages({ store, target: session.id, bridge });
  await delivery.recover(first.requestId);
  assert.equal(submits, 1);
  assert.equal(launches, 1);
  assert.equal((await bridge.result(first.requestId)).reply, 'late reply');
  assert.equal((await bridge.result(first.requestId)).reply, 'late reply');
  assert.equal(submits, 1);
});

test('expired or changed targets fail without sending and discard pending bodies', async t => {
  let sends = 0;
  const { store, bridge, delivery } = setup(t, { async send() { sends++; } });
  const expired = await delivery.enqueue(session.id, 'expired');
  store.update(store.read(expired.requestId), { createdAt: Date.now() - 1800001 });
  const changed = await delivery.enqueue(session.id, 'wrong identity');
  store.update(store.read(changed.requestId), { session: { ...session, nativeId: 'other' } });
  await drainMessages({ store, target: session.id, bridge });
  assert.equal(sends, 0);
  assert.equal(store.read(expired.requestId).error.code, 'TARGET_BUSY_TIMEOUT');
  assert.equal(store.read(changed.requestId).error.code, 'TARGET_CHANGED');
  assert.equal(store.read(expired.requestId).payload, undefined);
  assert.equal(store.read(changed.requestId).payload, undefined);
});

test('dead submitted workers do not exhaust target capacity and result closes recovered requests', async t => {
  const { store, bridge, delivery } = setup(t, {
    async result() { return { state: 'replied', delivery: 'accepted', reply: 'late answer' }; },
  });
  let original;
  for (let index = 0; index < 16; index++) {
    const id = `codex:aaaaaaaa-aaaa-aaaa-aaaa-${String(index).padStart(12, '0')}`;
    const record = store.create({ ...session, id });
    store.update(record, { durable: true, sequence: index + 1, waitTimeoutMs: 1800000, replyTimeoutMs: 180000,
      delivery: 'accepted', state: 'submitted', turnId: 'original', owner: null });
    original ??= record;
  }
  const next = await delivery.enqueue(session.id, 'new target');
  assert.equal(next.delivery, 'local-queued');
  const stdout = output();
  assert.equal(await runCli(['result', original.requestId, '--json'], { bridge, delivery, stdout, stderr: output() }), 0);
  assert.equal(JSON.parse(stdout.value).reply, 'late answer');
  assert.equal(store.read(original.requestId).finished, true);
});

test('disk and launch failures never return acceptance; launch failure retains one recoverable request', async t => {
  const { store, delivery } = setup(t);
  const original = store.update.bind(store);
  store.update = () => { throw Object.assign(Error('disk full'), { code: 'ENOSPC' }); };
  await assert.rejects(delivery.enqueue(session.id, 'not stored'), { code: 'ENOSPC' });
  store.update = original;
  delivery.launch = async () => { throw Object.assign(Error('cannot spawn'), { code: 'DELIVERY_LAUNCH_FAILED' }); };
  let id;
  await assert.rejects(delivery.enqueue(session.id, 'stored'), error => {
    id = error.requestId;
    return error.code === 'DELIVERY_LAUNCH_FAILED' && error.locallyStored && error.delivery === 'not-sent';
  });
  assert.equal(store.read(id).payload, 'stored');
  assert.equal(store.pending(session.id).length, 1);
  delivery.launch = async () => {};
  await assert.rejects(delivery.enqueue(session.id, 'x'.repeat(64001)), { code: 'MESSAGE_INVALID' });
  fs.chmodSync(store.file(id), 0o644);
  assert.throws(() => store.read(id), { code: 'REQUEST_RECORD_INVALID' });
});

test('answer is durable before notification and notification failure cannot replace it', async t => {
  const { store, bridge, delivery } = setup(t, { async ask() { return { reply: 'answer', delivery: 'accepted' }; } });
  const receipt = await delivery.enqueue(session.id, 'handoff', { kind: 'ask', origin: 'claude:12345678-1234-1234-1234-123456789abc' });
  let notifications = 0;
  await drainMessages({ store, target: session.id, bridge, notify: async () => {
    notifications++;
    assert.equal(store.reply(receipt.requestId).reply, 'answer');
    throw Error('origin offline');
  } });
  assert.equal(notifications, 1);
  assert.equal((await delivery.wait(receipt.requestId)).reply, 'answer');
  assert.equal(store.read(receipt.requestId).notification.error, 'origin offline');
  assert.equal((await bridge.result(receipt.requestId)).notification.error, 'origin offline');
  // Model a crash after the answer commit but before notification starts.
  store.update(store.read(receipt.requestId), { notification: undefined });
  await delivery.recover(receipt.requestId);
  assert.equal((await bridge.result(receipt.requestId)).notification.delivery, 'unconfirmed');
  assert.equal((await store.recent()).records[0].notification.delivery, 'unconfirmed');
  assert.equal(notifications, 1);
});

test('result reads a stored answer without starting unrelated workers; queued restart failure stays inspectable', async () => {
  const stdout = output(), stderr = output();
  let recoveries = 0;
  const bridge = { result: async () => ({ state: 'replied', delivery: 'accepted', requestId: 'r', reply: 'stored answer' }) };
  const delivery = { recover: async id => { assert.equal(id, 'r'); recoveries++; throw Error('cannot launch'); } };
  assert.equal(await runCli(['result', 'r', '--json'], { bridge, delivery, stdout, stderr }), 0);
  assert.equal(JSON.parse(stdout.value).reply, 'stored answer');
  assert.equal(recoveries, 1);
  bridge.result = async () => ({ state: 'queued', delivery: 'local-queued', requestId: 'r' });
  stdout.value = '';
  assert.equal(await runCli(['result', 'r', '--json'], { bridge, delivery, stdout, stderr }), 3);
  assert.equal(JSON.parse(stdout.value).delivery, 'local-queued');
  assert.equal(recoveries, 2);
  assert.match(stderr.value, /DELIVERY_RECOVERY_FAILED/);
});

test('detached worker survives sender exit and concurrent launch cannot duplicate dispatch', { timeout: 10000 }, async t => {
  const { store, bridge, delivery } = setup(t);
  const moduleUrl = name => new URL(`../src/${name}.mjs`, import.meta.url).href;
  const releaseFile = path.join(store.directory, 'release');
  const worker = `
    import fs from 'node:fs';
    import { RequestStore } from ${JSON.stringify(moduleUrl('request-store'))};
    import { SessionBridge } from ${JSON.stringify(moduleUrl('session-bridge'))};
    import { drainMessages } from ${JSON.stringify(moduleUrl('message-worker'))};
    const store = new RequestStore(process.argv[1]);
    const session = ${JSON.stringify(session)};
    process.send({ ready: true });
    while (!fs.existsSync(${JSON.stringify(releaseFile)})) {
      if (!fs.existsSync(store.directory)) process.exit(0);
      await new Promise(r => setTimeout(r, 10));
    }
    const bridge = new SessionBridge({ requestStore: store, providers: [{ name: 'codex', list: async () => [session],
      async send(_session, message, { requestId, onProgress }) {
        onProgress({ state: 'submitting', delivery: 'unknown' });
        fs.appendFileSync(store.directory + '/dispatches.jsonl', JSON.stringify({ requestId, message }) + '\\n');
        return { delivery: 'accepted' };
      }
    }] });
    await drainMessages({ store, target: session.id, bridge, release: () => fs.closeSync(3) });
    if (process.connected) process.disconnect();
  `;
  const sender = `
    import { spawn } from 'node:child_process';
    import { RequestStore } from ${JSON.stringify(moduleUrl('request-store'))};
    import { MessageDelivery, launchDelivery } from ${JSON.stringify(moduleUrl('message-delivery'))};
    const store = new RequestStore(process.argv[1]);
    const delivery = new MessageDelivery({ store, bridge: { discover: async () => ({ sessions: [${JSON.stringify(session)}] }) },
      launch: (store, target) => launchDelivery(store, target, { spawnWorker: (_exe, _args, options) => spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(worker)}, store.directory], options) })
    });
    console.log(JSON.stringify(await delivery.enqueue(${JSON.stringify(session.id)}, 'after parent exit')));
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', sender, store.directory], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { child.kill(); if (fs.existsSync(store.directory)) fs.writeFileSync(releaseFile, 'release'); });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  assert.equal(await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }), 0, stderr);
  const first = JSON.parse(stdout);
  delivery.launch = (store, target) => launchDelivery(store, target, { spawnWorker: () => { throw Error('duplicate worker'); } });
  const second = await delivery.enqueue(session.id, 'second');
  assert.equal((await bridge.result(first.requestId)).delivery, 'local-queued');
  fs.writeFileSync(releaseFile, 'release');
  const deadline = Date.now() + 4000;
  while (!store.read(second.requestId).finished && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
  assert.equal(store.read(second.requestId).finished, true);
  assert.deepEqual(fs.readFileSync(path.join(store.directory, 'dispatches.jsonl'), 'utf8').trim().split('\n').map(JSON.parse), [
    { requestId: first.requestId, message: 'after parent exit' }, { requestId: second.requestId, message: 'second' },
  ]);
});

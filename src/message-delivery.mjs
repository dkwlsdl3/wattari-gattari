import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withFileLock } from './file-lock.mjs';

const workerPath = fileURLToPath(new URL('./message-worker.mjs', import.meta.url));
const fail = (code, message) => Object.assign(new Error(message), { code });
export function deliveryLock(store, target) {
  return path.join(store.directory, crypto.createHash('sha256').update(target).digest('hex') + '.delivery');
}

// Both enqueue/start and the worker's final empty scan use this admission lock.
// The inherited open-file description keeps flock alive across parent exit.
export async function launchDelivery(store, target, { spawnWorker = spawn } = {}) {
  let child;
  withFileLock(deliveryLock(store, target) + '.admission', () => {
    const fd = fs.openSync(deliveryLock(store, target), fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw fail('DELIVERY_LOCK_UNSAFE', 'Unsafe delivery lock');
      const lock = spawnSync('flock', ['--exclusive', '--nonblock', '3'], { stdio: ['ignore', 'ignore', 'pipe', fd], timeout: 5000 });
      if (lock.error) throw lock.error;
      if (lock.status === 1) return;
      if (lock.status !== 0) throw fail('DELIVERY_LOCK_FAILED', 'Cannot acquire delivery ownership');
      child = spawnWorker(process.execPath, [workerPath, store.directory, target], {
        detached: true, stdio: ['ignore', 'ignore', 'ignore', fd, 'ipc'],
        // Do not inherit Node injection flags into a background executor.
        env: { ...process.env, NODE_OPTIONS: '' },
      });
    } finally { fs.closeSync(fd); }
  });
  if (!child) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); finish(fail('DELIVERY_LAUNCH_FAILED', 'Delivery worker did not become ready')); }, 5000);
    const finish = error => {
      clearTimeout(timer);
      child.removeListener('error', onError); child.removeListener('exit', onExit);
      if (child.connected) child.disconnect();
      child.unref();
      error ? reject(error) : resolve();
    };
    const onError = error => finish(error);
    const onExit = () => finish(fail('DELIVERY_LAUNCH_FAILED', 'Delivery worker exited before readiness'));
    child.once('error', onError); child.once('exit', onExit);
    child.once('message', message => finish(message?.ready === true ? null : fail('DELIVERY_LAUNCH_FAILED', 'Invalid worker readiness')));
  });
}

export class MessageDelivery {
  constructor({ store, bridge, launch = launchDelivery }) { this.store = store; this.bridge = bridge; this.launch = launch; }

  async enqueue(target, payload, { kind = 'send', cwd, origin, waitTimeoutMs = 1800000, replyTimeoutMs = 180000 } = {}) {
    if (!['send', 'ask'].includes(kind) || typeof payload !== 'string' || !payload.trim() || Buffer.byteLength(payload) > 64000) throw fail('MESSAGE_INVALID', 'Message must contain 1–64000 UTF-8 bytes');
    for (const timeout of [waitTimeoutMs, replyTimeoutMs]) if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 86400000) throw fail('TIMEOUT_INVALID', 'Delivery timeouts must be within one day');
    if (origin && !/^claude:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(origin)) throw fail('ORIGIN_INVALID', 'Invalid origin identity');
    const { sessions } = await this.bridge.discover({ provider: /^(claude|codex):/.exec(target)?.[1], cwd });
    const matches = sessions.filter(row => [row.id, row.nativeId, row.sessionId, row.name].includes(target));
    if (matches.length !== 1) throw fail(matches.length ? 'TARGET_AMBIGUOUS' : 'SESSION_NOT_FOUND', 'Expected one current target');
    const session = matches[0];
    if (!/^(claude|codex):[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(session.id)) throw fail('TARGET_INVALID', 'Durable delivery requires an exact native UUID');
    let record;
    // Bound unfinished message bodies and concurrent target workers. Historical
    // metadata is never reclassified as a message that should be sent.
    withFileLock(path.join(this.store.directory, 'delivery-capacity'), () => {
      const directory = fs.lstatSync(this.store.directory);
      if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid() || (directory.mode & 0o077)) throw fail('REQUEST_STORE_UNSAFE', 'Unsafe request directory');
      const names = fs.readdirSync(this.store.directory).filter(name => name.endsWith('.json'));
      const pending = names.filter(name => /^[0-9a-f-]{36}\.json$/i.test(name)).map(name => this.store.read(name.slice(0, -5))).filter(row => row.durable && !row.finished && (row.delivery === 'not-sent' || this.store.active(row)));
      if (pending.length >= 128 || new Set([...pending.map(row => row.target), session.id]).size > 16) throw fail('DELIVERY_FULL', 'Pending delivery limit reached (128 messages / 16 targets)');
      record = this.store.create(session, { kind });
      const sequence = Math.max(0, ...pending.map(row => row.sequence ?? 0)) + 1;
      this.store.update(record, { durable: true, payload, origin, sequence, owner: null, waitTimeoutMs, replyTimeoutMs, state: 'queued', finished: false });
    });
    try { await this.launch(this.store, session.id); }
    catch (error) {
      const current = this.store.read(record.requestId);
      Object.assign(error, { requestId: record.requestId, target: record.target, delivery: current.delivery, locallyStored: true });
      throw error;
    }
    return { requestId: record.requestId, target: record.target, kind, state: 'queued', delivery: 'local-queued' };
  }

  async wait(requestId, { onProgress = () => {} } = {}) {
    let previous;
    while (true) {
      const row = this.store.read(requestId);
      const answer = this.store.reply(requestId);
      if (answer) return { ...answer, requestId, target: row.target };
      if (row.state !== previous) {
        onProgress({ state: row.state, target: row.target, requestId, delivery: row.delivery });
        previous = row.state;
      }
      if (row.finished) throw Object.assign(fail(row.error?.code ?? 'DELIVERY_FAILED', row.error?.message ?? 'Request ended without a reply'), { requestId, target: row.target, delivery: row.delivery });
      if (!this.store.active(row)) await this.recover(requestId);
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }

  async recover(requestId) {
    const row = this.store.read(requestId);
    if (!row.durable || row.finished) return;
    if (row.delivery === 'not-sent' && typeof row.payload === 'string') await this.launch(this.store, row.target);
    else if (!this.store.active(row)) {
      const answer = this.store.reply(requestId);
      this.store.update(row, {
        finished: true, payload: undefined,
        ...(answer ? { state: 'replied', delivery: 'accepted' }
          : { error: { code: 'DELIVERY_INTERRUPTED', message: 'Delivery worker stopped; inspect the original native request without resending' } }),
        ...(row.origin && !row.notification ? { notification: { error: 'Delivery worker stopped before origin notification was confirmed' } } : {}),
      });
    }
  }
}

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RequestStore } from './request-store.mjs';
import { SessionBridge } from './session-bridge.mjs';
import { ClaudeProvider } from './providers/claude.mjs';
import { CodexProvider } from './providers/codex.mjs';
import { deliveryLock } from './message-delivery.mjs';
import { withFileLock } from './file-lock.mjs';
import { notifyOrigin } from './origin-notifier.mjs';

// Exported execution seam accepts fixture adapters; production argv never selects code.
export async function drainMessages({ store, target, bridge, release = () => {}, notify = notifyOrigin }) {
  while (true) {
    let record;
    withFileLock(deliveryLock(store, target) + '.admission', () => {
      record = store.pending(target)[0];
      if (!record) release();
    });
    if (!record) return;
    try {
      const result = await bridge.deliverStored(record);
      // The immutable answer is committed by the bridge before notification.
      if (record.origin && result.reply !== undefined) {
        try {
          const notification = await notify({ origin: record.origin, requestId: record.requestId, target, reply: result.reply });
          store.update(record, { notification: { requestId: notification.requestId, delivery: notification.delivery } });
        } catch (error) { store.update(record, { notification: { error: error.message } }); }
      }
    } catch (error) {
      // A live failure ends this attempt. A later explicit result can recover an
      // answer; unknown/submitted records are never candidates for replay.
      store.update(record, { finished: true, payload: undefined, error: { code: error.code ?? 'DELIVERY_FAILED', message: error.message } });
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [, , directory, target] = process.argv;
  let released = false;
  const release = () => { if (!released) { fs.closeSync(3); released = true; } };
  try {
    if (!/^(claude|codex):[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(target ?? '')) throw Error('Invalid worker target');
    const store = new RequestStore(directory);
    const inherited = fs.fstatSync(3), expected = fs.lstatSync(deliveryLock(store, target));
    if (!inherited.isFile() || inherited.uid !== process.getuid() || inherited.ino !== expected.ino || inherited.dev !== expected.dev || expected.isSymbolicLink()) throw Error('Invalid worker ownership descriptor');
    const bridge = new SessionBridge({ requestStore: store, providers: [new ClaudeProvider(), new CodexProvider({ autoStartDaemon: false })] });
    store.pending(target); // Validate before acknowledging executable readiness.
    process.send?.({ ready: true });
    await drainMessages({ store, target, bridge, release });
  } catch { process.exitCode = 1; }
  finally { release(); if (process.connected) process.disconnect(); }
}

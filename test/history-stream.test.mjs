import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { historyStreams } from '../src/history-stream.mjs';

test('a cancelled startup subscriber cannot close another subscriber waiting for the same watcher', async t => {
  let ready, stops = 0, reads = 0;
  const started = new Promise(resolve => { ready = resolve; });
  const streams = historyStreams({ watchHistory: () => started, history: async () => { reads++; return { messages: [] }; } });
  t.after(() => streams.close());
  const response = destroyed => Object.assign(new EventEmitter(), {
    destroyed, writableLength: 0, headers: 0, ended: false, frames: [],
    writeHead() { this.headers++; }, write(frame) { this.frames.push(frame); }, end() { this.ended = true; },
  });
  const closed = response(true), live = response(false), session = { id: 'codex:proof', cwd: '/tmp/waga-proof-history' };
  const first = streams.open(session, closed), second = streams.open(session, live);
  await Promise.resolve(); ready(() => { stops++; });
  await Promise.all([first, second]);
  assert.equal(live.headers, 1); assert.equal(live.ended, false); assert.equal(stops, 0);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(reads, 1); assert.match(live.frames[0], /messages/);
  live.emit('close'); assert.equal(stops, 1);
});

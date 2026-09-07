import assert from "node:assert/strict";
import test from "node:test";

import { readBeforeDeadline } from "../src/bridge/deadline.mjs";

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("expired read deadline never starts the operation", async () => {
  const error = new Error("expired");
  let calls = 0;
  for (const now of [100, 101]) {
    await assert.rejects(readBeforeDeadline(() => { calls += 1; }, { deadline: 100, now: () => now, error }), (caught) => caught === error);
  }
  assert.equal(calls, 0);
});

test("successful or rejected reads clear their timer without aborting completed operations", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const cleared = t.mock.method(globalThis, "clearTimeout");
  const timeout = new Error("deadline");
  const failure = new Error("read failed");
  const signals = [];
  const run = (operation) => readBeforeDeadline((signal) => { signals.push(signal); return operation(); }, { deadline: 100, now: () => 1, error: timeout });
  const value = { result: "right" };
  assert.equal(await run(() => value), value);
  await assert.rejects(run(() => { throw failure; }), (error) => error === failure);
  await assert.rejects(run(() => Promise.reject(failure)), (error) => error === failure);
  assert.equal(cleared.mock.callCount(), 3);
  t.mock.timers.tick(100);
  assert.equal(signals.some((signal) => signal.aborted), false);
});

test("deadline aborts an unresponsive read and handles a later rejection", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const error = new Error("deadline");
  let signal;
  let rejectRead;
  const result = assert.rejects(readBeforeDeadline((value) => {
    signal = value;
    return new Promise((_, reject) => { rejectRead = reject; });
  }, { deadline: 100, now: () => 0, error }), (caught) => caught === error);
  await flush();
  t.mock.timers.tick(99);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  await result;
  assert.equal(signal.aborted, true);
  assert.equal(signal.reason, error);
  rejectRead(new Error("late rejection"));
  await flush();
});

test("read result must arrive strictly before the deadline even if the timer has not fired", async () => {
  for (const observedAt of [99, 100, 101]) {
    let now = 0;
    const error = new Error("deadline");
    const result = readBeforeDeadline(() => { now = observedAt; return "answer"; }, { deadline: 100, now: () => now, error });
    if (observedAt < 100) assert.equal(await result, "answer");
    else await assert.rejects(result, (caught) => caught === error);
  }
});

test("long read deadlines are split without overflowing Node timers or expiring early", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const scheduled = t.mock.method(globalThis, "setTimeout");
  const maxDelay = 2_147_483_647;
  let now = 0;
  let signal;
  const error = new Error("deadline");
  const pending = assert.rejects(readBeforeDeadline((value) => { signal = value; return new Promise(() => {}); }, {
    deadline: maxDelay + 100, now: () => now, error,
  }), (caught) => caught === error);
  await flush();
  assert.equal(scheduled.mock.calls[0].arguments[1], maxDelay);
  now = maxDelay;
  t.mock.timers.tick(maxDelay);
  assert.equal(signal.aborted, false);
  assert.equal(scheduled.mock.calls[1].arguments[1], 100);
  now += 99;
  t.mock.timers.tick(99);
  assert.equal(signal.aborted, false);
  now += 1;
  t.mock.timers.tick(1);
  await pending;
});

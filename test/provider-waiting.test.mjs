import assert from "node:assert/strict";
import test from "node:test";

import { ClaudeProvider } from "../src/providers/claude.mjs";
import { CodexProvider } from "../src/providers/codex.mjs";

const session = { id: "claude:target", sessionId: "target", projectCwd: "/proof", socketPath: "/proof/target.sock" };
const target = { id: "codex:target", nativeId: "target" };
const options = { requestId: "proof", waitTimeoutMs: 100, replyTimeoutMs: 200 };
const flush = () => new Promise((resolve) => setImmediate(resolve));

function codex(responder, overrides = {}) {
  const calls = [];
  const client = {
    async initialize() {},
    request(method, params, requestOptions) { calls.push(method); return responder(method, params, requestOptions); },
    async close() { calls.push("close"); },
  };
  return { calls, provider: new CodexProvider({
    run: async () => ({ stdout: '{"status":"running","socketPath":"/proof/codex.sock"}' }),
    clientFactory: async () => client,
    eventLog: { record() {} },
    ...overrides,
  }) };
}

function claude(list, overrides = {}) {
  const calls = [];
  const provider = new ClaudeProvider({
    endpointFactory: () => ({
      async start() { calls.push("start"); },
      async send() { calls.push("send"); return "message"; },
      async waitForReply() { return { text: "ANSWER" }; },
      async stop() { calls.push("stop"); },
    }),
    ...overrides,
  });
  provider.list = list;
  return { calls, provider };
}

function cachedProvider(name, read, now) {
  return name === "claude" ? new ClaudeProvider({
    run: async () => ({ stdout: "[]" }), aliasCatalog: { load: () => new Map() },
    usageReader: read, now, usageCacheMs: 100,
  }) : codex((method) => method === "account/rateLimits/read" ? read() : { data: [], nextCursor: null }, { now, usageCacheMs: 100 }).provider;
}

test("Claude must not send when an idle lookup finishes at the wait deadline", async () => {
  let now = 0;
  const { provider, calls } = claude(async () => { now = 100; return [{ ...session, status: "idle" }]; }, { now: () => now });
  await assert.rejects(provider.ask(session, "hello", options), { code: "TARGET_BUSY_TIMEOUT" });
  assert.deepEqual(calls, []);
});

test("Codex must not send when an idle lookup finishes at the wait deadline", async () => {
  let now = 0;
  const { provider, calls } = codex((method) => {
    if (method === "thread/read") { now = 100; return { thread: { status: { type: "idle" } } }; }
    if (method === "turn/start") return { turn: { id: "wanted" } };
    return { data: [{ turnId: "wanted", item: { type: "agentMessage", text: "LATE" } }] };
  }, { now: () => now });
  await assert.rejects(provider.ask(target, "hello", options), { code: "TARGET_BUSY_TIMEOUT" });
  assert.deepEqual(calls, ["thread/read", "close"]);
});

test("Codex does not accept an answer received at the reply deadline", async () => {
  let now = 0;
  const { provider, calls } = codex((method) => {
    if (method === "thread/read") return { thread: { status: { type: "idle" } } };
    if (method === "turn/start") return { turn: { id: "wanted" } };
    now = 200;
    return { data: [{ turnId: "wanted", item: { type: "agentMessage", text: "LATE" } }] };
  }, { now: () => now });
  await assert.rejects(provider.ask(target, "hello", options), { code: "REPLY_TIMEOUT" });
  assert.equal(calls.at(-1), "close");
  assert.equal(calls.filter((method) => method === "turn/start").length, 1);
});

test("Claude completion waits through needs-input and uses the remaining reply deadline", async () => {
  let now = 0;
  let reads = 0;
  const progress = [];
  const { provider, calls } = claude(async () => [{ ...session, status: reads++ === 0 ? "idle" : "needs-input" }], {
    now: () => now,
    wait: async (ms) => { now += ms; },
  });
  await assert.rejects(provider.ask(session, "hello", { ...options, untilIdle: true, onProgress: ({ state }) => progress.push(state) }), { code: "REPLY_TIMEOUT" });
  assert.deepEqual(calls, ["start", "send", "stop"]);
  assert.deepEqual(progress, ["submitted", "working"]);
});

test("Claude unavailable state is not idle and cannot receive a new request", async () => {
  const { provider, calls } = claude(async () => [{ ...session, status: "unavailable" }]);
  await assert.rejects(provider.ask(session, "hello", options), { code: "TARGET_UNAVAILABLE" });
  assert.deepEqual(calls, []);
});

test("Claude approval and work transitions complete only at idle without sending twice", async () => {
  let now = 0;
  const states = ["needs-input", "idle", "working", "needs-input", "idle"];
  const waits = [];
  const progress = [];
  const { provider, calls } = claude(async () => [{ ...session, status: states.shift() }], {
    now: () => now,
    wait: async (ms) => { waits.push(ms); now += ms; },
  });
  const result = await provider.ask(session, "hello", { ...options, waitTimeoutMs: 1000, replyTimeoutMs: 2000, untilIdle: true, onProgress: ({ state }) => progress.push(state) });
  assert.equal(result.reply, "ANSWER");
  assert.deepEqual(calls, ["start", "send", "stop"]);
  assert.deepEqual(waits, [500, 500, 1000]);
  assert.deepEqual(states, []);
  assert.deepEqual(progress, ["waiting", "submitted", "working", "replied"]);
});

test("Claude revalidates the exact target among decoys and never substitutes a missing target", async () => {
  const decoy = { ...session, id: "claude:decoy", sessionId: "decoy", socketPath: "/wrong/decoy.sock", status: "idle" };
  for (const missing of [false, true]) {
    let endpoints = 0;
    const { provider } = claude(async () => missing ? [decoy] : [decoy, { ...session, status: "idle" }], {
      endpointFactory: () => { endpoints += 1; return {
        async start({ socketDirectory }) { assert.equal(socketDirectory, "/proof"); },
        async send(socket) { assert.equal(socket, session.socketPath); return "message"; },
        async waitForReply(socket, id) { assert.equal(socket, session.socketPath); assert.equal(id, "message"); return { text: "RIGHT" }; },
        async stop() {},
      }; },
    });
    if (missing) await assert.rejects(provider.ask(session, "hello", options), { code: "TARGET_UNAVAILABLE" });
    else assert.equal((await provider.ask(session, "hello", options)).reply, "RIGHT");
    assert.equal(endpoints, missing ? 0 : 1);
  }
});

test("Claude polling never sleeps beyond the remaining busy-wait budget", async () => {
  let now = 1000;
  const waits = [];
  const { provider, calls } = claude(async () => [{ ...session, status: "working" }], {
    now: () => now,
    wait: async (ms) => { waits.push(ms); now += ms; },
  });
  await assert.rejects(provider.ask(session, "hello", options), { code: "TARGET_BUSY_TIMEOUT" });
  assert.deepEqual(waits, [100]);
  assert.equal(now, 1100);
  assert.deepEqual(calls, []);
});

for (const stalledMethod of ["thread/items/list", "thread/turns/list", "thread/read"]) {
  test(`Codex reply deadline bounds stalled ${stalledMethod} without interrupting or resending work`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let signal;
    let reads = 0;
    const { provider, calls } = codex((method, _params, settings) => {
      if (method === "thread/read" && reads++ === 0) return { thread: { status: { type: "idle" } } };
      if (method === "turn/start") return { turn: { id: "wanted" } };
      if (method === stalledMethod) { signal = settings.signal; return new Promise(() => {}); }
      return { data: [] };
    }, { now: () => 0 });
    const pending = provider.ask(target, "hello", { ...options, untilIdle: stalledMethod === "thread/turns/list" })
      .then(() => "success", (error) => error.code);
    await flush();
    t.mock.timers.tick(200);
    await flush();
    assert.equal(await Promise.race([pending, Promise.resolve("still pending")]), "REPLY_TIMEOUT");
    assert.equal(signal.aborted, true);
    assert.equal(calls.filter((method) => method === "turn/start").length, 1);
    assert.equal(calls.at(-1), "close");
    assert.equal(calls.some((method) => /interrupt|cancel|archive/.test(method)), false);
  });
}

for (const name of ["claude", "codex"]) {
  test(`${name} bounds a stalled idle lookup and aborts only the local read`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let signal;
    const stalled = (options) => { signal = options?.signal; return new Promise(() => {}); };
    const { provider, calls } = name === "claude"
      ? claude((options) => stalled(options), { now: () => 0 })
      : codex((_method, _params, options) => stalled(options), { now: () => 0 });
    const pending = provider.ask(name === "claude" ? session : target, "hello", options)
      .then(() => "unexpected success", (error) => error.code);
    await flush();
    t.mock.timers.tick(100);
    await flush();
    assert.equal(await Promise.race([pending, Promise.resolve("still pending")]), "TARGET_BUSY_TIMEOUT");
    assert.equal(signal.aborted, true);
    assert.equal(calls.includes("send") || calls.includes("turn/start"), false);
    if (name === "codex") assert.equal(calls.at(-1), "close");
  });

  test(`${name} usage cache recovers after a synchronous adapter exception`, async () => {
    let now = 0;
    let reads = 0;
    const read = () => { reads += 1; if (reads === 1) throw new Error("temporary adapter failure"); return null; };
    const provider = cachedProvider(name, read, () => now);
    await provider.list({ includeUsage: true });
    await flush();
    now = 99;
    await provider.list({ includeUsage: true });
    assert.equal(reads, 1);
    now = 100;
    await provider.list({ includeUsage: true });
    await flush();
    assert.equal(reads, 2);
    assert.equal(provider.usageSnapshot(), null);
  });

  test(`${name} usage shares concurrent refreshes and preserves the last good observation on failure`, async () => {
    let now = 0;
    let reads = 0;
    let finish;
    const provider = cachedProvider(name, () => {
      reads += 1;
      return new Promise((resolve, reject) => { finish = { resolve, reject }; });
    }, () => now);
    const value = name === "claude" ? { weekly: { remainingPercent: 75 }, observedAt: 0 }
      : { rateLimits: { primary: { usedPercent: 25, windowDurationMins: 10_080, resetsAt: 123 } } };
    const first = provider.list({ includeUsage: true });
    const second = provider.list({ includeUsage: true });
    await flush();
    assert.equal(reads, 1);
    assert.equal(provider.usageSnapshot(), null);
    finish.resolve(value);
    await Promise.all([first, second]);
    await flush();
    const good = structuredClone(provider.usageSnapshot());
    assert.equal(good.observedAt, 0);
    for (const outcome of ["reject", "invalid"]) {
      now += 100;
      const pending = provider.list({ includeUsage: true });
      await flush();
      if (outcome === "reject") finish.reject(new Error("usage unavailable"));
      else finish.resolve(null);
      await pending;
      await flush();
      assert.deepEqual(provider.usageSnapshot(), good);
      const previousReads = reads;
      now += 99;
      await provider.list({ includeUsage: true });
      assert.equal(reads, previousReads, "failure must be negatively cached too");
      now -= 99;
    }
    assert.equal(reads, 3);
  });
}

test("Claude forwards the deadline signal through its real list path to the read-only CLI adapter", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal;
  const provider = new ClaudeProvider({
    aliasCatalog: { load: () => new Map() }, now: () => 0,
    run: (args, settings) => {
      assert.deepEqual(args, ["agents", "--json", "--cwd", "/proof"]);
      signal = settings.signal;
      return new Promise(() => {});
    },
  });
  const pending = provider.ask(session, "hello", options).then(() => "success", (error) => error.code);
  await flush();
  t.mock.timers.tick(100);
  await flush();
  assert.equal(await Promise.race([pending, Promise.resolve("still pending")]), "TARGET_BUSY_TIMEOUT");
  assert.equal(signal.aborted, true);
});

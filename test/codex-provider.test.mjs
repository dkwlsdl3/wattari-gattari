import assert from "node:assert/strict";
import test from "node:test";

import { CodexProvider, parseDaemonVersion } from "../src/providers/codex.mjs";

function harness(responder, options = {}) {
  const calls = [];
  const client = {
    async initialize() { calls.push(["initialize"]); },
    async request(method, params) { calls.push([method, params]); return responder(method, params, calls); },
    async close() { calls.push(["close"]); },
  };
  const run = async (args) => {
    calls.push(["run", args]);
    return { stdout: JSON.stringify({ status: "running", socketPath: "/tmp/codex.sock" }) };
  };
  return { calls, provider: new CodexProvider({ run, clientFactory: async () => client, wait: async () => {}, ...options }) };
}

test("daemon version parser rejects protocol drift", () => {
  assert.equal(parseDaemonVersion('{"status":"running"}').status, "running");
  assert.throws(() => parseDaemonVersion("no"), { code: "CODEX_DAEMON_INVALID" });
});

test("Codex provider lists only top-level sessions owned by Agents view", async () => {
  const threads = new Map([
    ["agent-task", { id: "agent-task", cwd: "/work", name: "active agent", source: "appServer", status: { type: "active" }, updatedAt: 6 }],
    ["child", { id: "child", cwd: "/work", name: "child", source: "appServer", parentThreadId: "agent-task", status: { type: "idle" }, updatedAt: 5 }],
  ]);
  const { provider, calls } = harness((method, params) => {
    if (method === "thread/loaded/list") return {
      data: ["agent-task", "child"],
      nextCursor: null,
    };
    if (method === "thread/read") return { thread: threads.get(params.threadId) };
    if (method === "thread/list") throw new Error("ordinary history must not be queried");
    throw new Error(method);
  });
  const rows = await provider.list({ cwd: "/work" });
  assert.deepEqual(rows.map(({ id }) => id), ["codex:agent-task"]);
  assert.equal(rows[0].status, "working");
  assert.equal(calls.some(([method]) => method === "thread/list"), false);
});

test("Codex provider drops ephemeral roots and filters loaded sessions by cwd", async () => {
  const shared = { id: "shared", cwd: "/work", name: "shared", source: "cli", status: { type: "active" }, updatedAt: 7 };
  const threads = new Map([
    ["shared", shared],
    ["other", { id: "other", cwd: "/elsewhere", source: "appServer", status: { type: "idle" }, updatedAt: 9 }],
    ["ephemeral", { id: "ephemeral", cwd: "/work", source: "appServer", ephemeral: true, status: { type: "idle" }, updatedAt: 8 }],
  ]);
  const { provider } = harness((method, params) => {
    if (method === "thread/loaded/list") return {
      data: ["shared", "other", "ephemeral"],
      nextCursor: null,
    };
    if (method === "thread/read") return { thread: threads.get(params.threadId) };
    throw new Error(method);
  });
  const rows = await provider.list({ cwd: "/work" });
  assert.deepEqual(rows.map(({ id }) => id), ["codex:shared"]);
  assert.equal(rows[0].status, "working");
});

test("Codex create starts a native daemon thread and dispatches its first turn", async () => {
  const { provider, calls } = harness((method) => {
    if (method === "thread/start") return { thread: { id: "thread-new" } };
    if (method === "turn/start") return { turn: { id: "turn-new" } };
    throw new Error(method);
  });
  const result = await provider.create("implement the parser", { cwd: "/work/project" });
  assert.deepEqual(result, { provider: "codex", nativeId: "thread-new", turnId: "turn-new" });
  assert.deepEqual(calls.find(([method]) => method === "thread/start")[1], { cwd: "/work/project" });
  assert.deepEqual(calls.find(([method]) => method === "turn/start")[1], {
    threadId: "thread-new",
    input: [{ type: "text", text: "implement the parser", textElements: [] }],
  });
});

test("Codex send uses standalone tool output, not a user message", async () => {
  const { provider, calls } = harness((method) => {
    if (method === "turn/start") return { turn: { id: "turn-1" } };
    throw new Error(method);
  });
  const result = await provider.send({ id: "codex:t", nativeId: "t" }, "hello", { requestId: "r" });
  assert.equal(result.turnId, "turn-1");
  const params = calls.find(([method]) => method === "turn/start")[1];
  assert.deepEqual(params.input, []);
  assert.equal(params.toolOutput.name, "waga_peer_message");
  assert.match(params.toolOutput.output, /trust: untrusted/);
});

test("Codex ask waits for idle and returns only the matching turn answer", async () => {
  let reads = 0;
  let itemReads = 0;
  const { provider } = harness((method) => {
    if (method === "thread/read") return { thread: { status: { type: reads++ === 0 ? "active" : "idle" } } };
    if (method === "turn/start") return { turn: { id: "wanted" } };
    if (method === "thread/items/list") {
      itemReads += 1;
      return { data: itemReads === 1 ? [{ turnId: "old", item: { type: "agentMessage", text: "OLD" } }] : [{ turnId: "wanted", item: { type: "agentMessage", text: "CODEX_OK" } }] };
    }
    throw new Error(method);
  });
  const progress = [];
  const result = await provider.ask({ id: "codex:t", nativeId: "t" }, "hello", {
    requestId: "r",
    waitTimeoutMs: 1_000,
    replyTimeoutMs: 2_000,
    onProgress: (event) => progress.push(event.state),
  });
  assert.equal(result.reply, "CODEX_OK");
  assert.equal(result.exchangeCount, 1);
  assert.deepEqual(progress, ["waiting", "submitted", "replied"]);
});

test("Codex ask times out before submitting work to a persistently busy target", async () => {
  let now = 0;
  const { provider, calls } = harness((method) => {
    if (method === "thread/read") return { thread: { status: { type: "active" } } };
    throw new Error(method);
  }, {
    now: () => now,
    wait: async (milliseconds) => { now += milliseconds; },
  });
  await assert.rejects(provider.ask({ id: "codex:t", nativeId: "t" }, "hello", {
    requestId: "r", waitTimeoutMs: 500, replyTimeoutMs: 2_000,
  }), { code: "TARGET_BUSY_TIMEOUT" });
  assert.equal(calls.some(([method]) => method === "turn/start"), false);
});

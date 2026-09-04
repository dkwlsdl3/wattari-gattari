import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CodexProvider, parseCodexUsage, parseDaemonVersion } from "../src/providers/codex.mjs";
import { WAGA_SESSION_INSTRUCTIONS } from "../src/managed-session-instructions.mjs";

process.env.XDG_STATE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "waga-codex-test-state-"));

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

test("Codex usage parser selects the weekly window", () => {
  assert.deepEqual(parseCodexUsage({ rateLimits: {
    primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 10 },
    secondary: { usedPercent: 98.6, windowDurationMins: 10_080, resetsAt: 20 },
  } }, 30), {
    usedPercent: 99,
    remainingPercent: 1,
    windowDurationMins: 10_080,
    resetsAt: 20,
    observedAt: 30,
  });
  assert.equal(parseCodexUsage({ rateLimits: {} }), null);
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

test("Codex provider reuses fresh daemon discovery across overview refreshes", async () => {
  let now = 1_000;
  const { provider, calls } = harness((method) => {
    if (method === "thread/loaded/list") return { data: [], nextCursor: null };
    throw new Error(method);
  }, { now: () => now, daemonCacheMs: 30_000 });

  await provider.list();
  now += 3_000;
  await provider.list();
  assert.equal(calls.filter(([kind, args]) => kind === "run" && args[2] === "version").length, 1);
});

test("Codex provider fetches optional usage at most once per five-minute cache window", async () => {
  let now = 1_000;
  let usedPercent = 98;
  const { provider, calls } = harness((method) => {
    if (method === "thread/loaded/list") return { data: [], nextCursor: null };
    if (method === "account/rateLimits/read") return {
      rateLimits: { primary: { usedPercent, windowDurationMins: 10_080, resetsAt: 2_000 } },
    };
    throw new Error(method);
  }, { now: () => now });

  await provider.list();
  await provider.list({ includeUsage: true });
  usedPercent = 99;
  now += 3 * 60_000;
  await provider.list({ includeUsage: true });
  assert.equal(calls.filter(([method]) => method === "account/rateLimits/read").length, 1);
  assert.equal(provider.usageSnapshot().remainingPercent, 2);

  now += 2 * 60_000;
  await provider.list({ includeUsage: true });
  assert.equal(calls.filter(([method]) => method === "account/rateLimits/read").length, 2);
  assert.equal(provider.usageSnapshot().remainingPercent, 1);
});

test("Codex usage failure does not fail discovery and is negatively cached", async () => {
  let now = 1_000;
  const { provider, calls } = harness((method) => {
    if (method === "thread/loaded/list") return { data: [], nextCursor: null };
    if (method === "account/rateLimits/read") throw new Error("quota unavailable");
    throw new Error(method);
  }, { now: () => now, usageCacheMs: 60_000 });

  assert.deepEqual(await provider.list({ includeUsage: true }), []);
  now += 3_000;
  assert.deepEqual(await provider.list({ includeUsage: true }), []);
  assert.equal(calls.filter(([method]) => method === "account/rateLimits/read").length, 1);
  assert.equal(provider.usageSnapshot(), null);
});

test("Codex provider records the first loaded-set removal", async () => {
  const snapshots = [["kept", "removed"], ["kept"], ["kept"]];
  const events = [];
  const { provider } = harness((method, params) => {
    if (method === "thread/loaded/list") return { data: snapshots.shift(), nextCursor: null };
    if (method === "thread/read") return { thread: { id: params.threadId, cwd: "/work", status: { type: "idle" } } };
    throw new Error(method);
  }, { eventLog: { record(event, details) { events.push([event, details]); } } });

  await provider.list();
  await provider.list();
  await provider.list();

  assert.deepEqual(events, [
    ["codex_loaded_snapshot", { sessionIds: ["kept", "removed"] }],
    ["codex_loaded_changed", { addedSessionIds: [], removedSessionIds: ["removed"], sessionIds: ["kept"] }],
  ]);
});

test("Codex provider bounds concurrent thread reads", async () => {
  const ids = Array.from({ length: 25 }, (_, index) => `thread-${index}`);
  let activeReads = 0;
  let maxActiveReads = 0;
  const { provider } = harness(async (method, params) => {
    if (method === "thread/loaded/list") return { data: ids, nextCursor: null };
    if (method === "thread/read") {
      activeReads += 1;
      maxActiveReads = Math.max(maxActiveReads, activeReads);
      await new Promise((resolve) => setImmediate(resolve));
      activeReads -= 1;
      return { thread: { id: params.threadId, cwd: "/work", status: { type: "idle" } } };
    }
    throw new Error(method);
  });

  assert.equal((await provider.list()).length, ids.length);
  assert.equal(maxActiveReads, 8);
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
  assert.deepEqual(calls.find(([method]) => method === "thread/start")[1], {
    cwd: "/work/project",
    developerInstructions: WAGA_SESSION_INSTRUCTIONS,
  });
  assert.deepEqual(calls.find(([method]) => method === "turn/start")[1], {
    threadId: "thread-new",
    input: [{ type: "text", text: "implement the parser", textElements: [] }],
  });
});

test("Codex archive uses the App Server archive boundary and keeps delete separate", async () => {
  const { provider, calls } = harness((method) => {
    if (method === "thread/archive") return {};
    throw new Error(method);
  });
  const result = await provider.archive({ id: "codex:thread-1", nativeId: "thread-1" });
  assert.deepEqual(result, { target: "codex:thread-1", archived: true });
  assert.deepEqual(calls.find(([method]) => method === "thread/archive"), ["thread/archive", { threadId: "thread-1" }]);
  assert.equal(calls.some(([method]) => method === "thread/delete"), false);
});

test("Codex rename updates the native user-facing thread name", async () => {
  const { provider, calls } = harness((method) => {
    if (method === "thread/name/set") return {};
    throw new Error(method);
  });
  const result = await provider.rename({ id: "codex:thread-1", nativeId: "thread-1" }, "  review parser  ");
  assert.deepEqual(result, { target: "codex:thread-1", renamed: true, name: "review parser" });
  assert.deepEqual(calls.find(([method]) => method === "thread/name/set"), ["thread/name/set", { threadId: "thread-1", name: "review parser" }]);
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

test("Codex ask can wait for the matching turn to complete and return its final answer", async () => {
  let turnReads = 0;
  let itemReads = 0;
  const { provider } = harness((method) => {
    if (method === "thread/read") return { thread: { status: { type: "idle" } } };
    if (method === "turn/start") return { turn: { id: "wanted" } };
    if (method === "thread/turns/list") {
      turnReads += 1;
      return { data: [{ id: "wanted", status: turnReads === 1 ? "inProgress" : "completed", items: [] }] };
    }
    if (method === "thread/items/list") {
      itemReads += 1;
      return { data: [
        { turnId: "wanted", item: { type: "agentMessage", text: "FINAL" } },
        { turnId: "wanted", item: { type: "agentMessage", text: "STARTED" } },
      ] };
    }
    throw new Error(method);
  });

  const result = await provider.ask({ id: "codex:t", nativeId: "t" }, "hello", {
    requestId: "r", waitTimeoutMs: 1_000, replyTimeoutMs: 2_000, untilIdle: true,
  });

  assert.equal(result.reply, "FINAL");
  assert.equal(turnReads, 2);
  assert.equal(itemReads, 1);
});

test("Codex completion waiting reports a terminal turn failure instead of returning progress", async () => {
  const { provider, calls } = harness((method) => {
    if (method === "thread/read") return { thread: { status: { type: "idle" } } };
    if (method === "turn/start") return { turn: { id: "wanted" } };
    if (method === "thread/turns/list") return { data: [{ id: "wanted", status: "failed", items: [] }] };
    throw new Error(method);
  });

  await assert.rejects(provider.ask({ id: "codex:t", nativeId: "t" }, "hello", {
    requestId: "r", waitTimeoutMs: 1_000, replyTimeoutMs: 2_000, untilIdle: true,
  }), { code: "TARGET_ERROR" });
  assert.equal(calls.some(([method]) => method === "thread/items/list"), false);
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

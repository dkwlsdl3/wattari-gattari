import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { CodexProvider, parseCodexUsage, parseDaemonVersion } from "../src/providers/codex.mjs";
import { CODEX_EXECUTION_MODES } from "../src/codex-execution.mjs";
import { WAGA_SESSION_INSTRUCTIONS } from "../src/managed-session-instructions.mjs";

process.env.XDG_STATE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "waga-codex-test-state-"));
const testStateDirectory = process.env.XDG_STATE_HOME;
after(() => fs.rmSync(testStateDirectory, { recursive: true, force: true }));

// 2026-09-18 measured on codex 0.152.1-0.155.0: `daemon version` never prints a
// "stopped" JSON. With the socket stale it exits non-zero on ECONNREFUSED, and with
// no socket file at all on ENOENT, so both stopped shapes arrive as a run failure.
const STOPPED_DAEMON_STDERR = "Error: failed to connect to /home/admin/.codex/app-server-control/app-server-control.sock\n\nCaused by:\n    Connection refused (os error 111)\n";

function stoppedDaemonFailure() {
  return Object.assign(new Error(`Command failed: codex app-server daemon version\n${STOPPED_DAEMON_STDERR}`), {
    code: 1, stdout: "", stderr: STOPPED_DAEMON_STDERR,
  });
}

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

test("Codex preview reads descending bounded history and skips tools without resuming or submitting", async () => {
  // ThreadItemEntry/UserInput shapes from Codex 0.153.4 generated v2 schema.
  const { provider, calls } = harness((method, params) => {
    assert.equal(method, "thread/items/list");
    assert.equal(params.threadId, "preview-thread");
    assert.equal(params.limit, 50);
    assert.equal(params.sortDirection, "desc");
    assert.equal(params.turnId, undefined);
    return params.cursor ? { data: [{ turnId: "old", item: { type: "userMessage", content: [{ type: "text", text: "last prompt", text_elements: [] }] } }], nextCursor: null }
      : { data: [
        { turnId: "new", item: { type: "commandExecution", aggregatedOutput: "SECRET TOOL OUTPUT" } },
        { turnId: "new", item: { type: "agentMessage", text: "latest answer", phase: "final_answer" } },
        { turnId: "old", item: { type: "agentMessage", text: "older answer", phase: "commentary" } },
      ], nextCursor: "older" };
  });
  assert.deepEqual(await provider.preview({ nativeId: "preview-thread" }), { input: "last prompt", output: "latest answer", limited: false });
  assert.deepEqual(calls.map(([name]) => name), ["run", "initialize", "thread/items/list", "thread/items/list", "close"]);
});

test("Codex preview reads the real offline 0.153.4 items fixture", async () => {
  // 2026-09-08: isolated waga-proof-preview-* daemon, no credentials or model response.
  const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/codex-preview.json", import.meta.url), "utf8"));
  const { provider } = harness(() => fixture);
  assert.deepEqual(await provider.preview({ nativeId: "01a07f99-0b5e-7550-a247-fb85254bbe78" }), {
    input: "WAGA_PREVIEW_READ_ONLY_PROOF", output: "", limited: false,
  });
});

test("Codex image-only latest input must not be replaced by an older text prompt", async () => {
  const { provider } = harness(() => ({ data: [
    { item: { type: "userMessage", content: [{ type: "image", url: "image" }] } },
    { item: { type: "userMessage", content: [{ type: "text", text: "WRONG OLD INPUT" }] } },
  ], nextCursor: null }));
  assert.equal((await provider.preview({ nativeId: "t" })).input, "[텍스트 없는 입력]");
});

test("Codex preview bounds history scans, isolates empty history and closes on protocol failure", async () => {
  let pages = 0;
  const bounded = harness(() => ({ data: [], nextCursor: `page-${++pages}` }));
  assert.deepEqual(await bounded.provider.preview({ nativeId: "t" }), { input: "", output: "", limited: true });
  assert.equal(pages, 3);
  const empty = harness(() => ({ data: [], nextCursor: null }));
  assert.equal((await empty.provider.preview({ nativeId: "t" })).limited, false);
  const invalid = harness(() => ({ data: "invalid" }));
  await assert.rejects(invalid.provider.preview({ nativeId: "t" }), { code: "CODEX_PAGE_INVALID" });
  assert.equal(invalid.calls.at(-1)[0], "close");
});

test("Codex preview does not start a daemon and respects cancellation", async () => {
  const calls = [];
  const provider = new CodexProvider({
    run: async (args) => { calls.push(args); throw stoppedDaemonFailure(); },
    eventLog: { record() {} },
  });
  await assert.rejects(provider.preview({ nativeId: "t" }), { code: "CODEX_DAEMON_UNAVAILABLE" });
  assert.deepEqual(calls, [["app-server", "daemon", "version"]]);
  await assert.rejects(provider.preview({ nativeId: "t" }, { signal: AbortSignal.abort() }));
  assert.equal(calls.length, 1);
});

test("A stopped daemon is started instead of surfacing the raw command failure", async () => {
  const calls = [];
  const client = { async initialize() {}, async request() { return { data: [], nextCursor: null }; }, async close() {} };
  const provider = new CodexProvider({
    run: async (args) => {
      const started = calls.includes("app-server daemon start");
      calls.push(args.join(" "));
      if (args[2] === "start") return { stdout: "" };
      if (!started) throw stoppedDaemonFailure();
      return { stdout: JSON.stringify({ status: "running", socketPath: "/tmp/codex.sock" }) };
    },
    clientFactory: async () => client, eventLog: { record() {} },
  });
  assert.deepEqual(await provider.list(), []);
  assert.deepEqual(calls, ["app-server daemon version", "app-server daemon start", "app-server daemon version"]);
});

test("A daemon that stays stopped after start reports unavailability, not a shell error", async () => {
  const provider = new CodexProvider({
    run: async (args) => { if (args[2] === "start") return { stdout: "" }; throw stoppedDaemonFailure(); },
    eventLog: { record() {} },
  });
  await assert.rejects(provider.list(), { code: "CODEX_DAEMON_UNAVAILABLE" });
});

test("Codex completion finds the matching turn and answer beyond the first page", async () => {
  const { provider, calls } = harness((method, params) => {
    if (method === "thread/read") return { thread: { status: { type: "idle" } } };
    if (method === "turn/start") return { turn: { id: "wanted" } };
    if (method === "thread/turns/list") return params.cursor
      ? { data: [{ id: "wanted", status: "completed" }], nextCursor: null }
      : { data: [{ id: "unrelated", status: "failed" }], nextCursor: "turn-page-2" };
    if (method === "thread/items/list") return params.cursor
      ? { data: [{ turnId: "wanted", item: { type: "agentMessage", text: "FINAL" } }], nextCursor: null }
      : { data: [{ turnId: "other", item: { type: "agentMessage", text: "WRONG" } }], nextCursor: "item-page-2" };
    throw new Error(method);
  });
  const result = await provider.ask({ id: "codex:t", nativeId: "t" }, "review", { requestId: "r", untilIdle: true, timeoutMs: 100 });
  assert.equal(result.reply, "FINAL");
  assert.equal(calls.filter(([method]) => method === "turn/start").length, 1);
  for (const method of ["thread/items/list", "thread/turns/list"]) {
    assert.equal(calls.filter(([name]) => name === method).length, 2);
  }
});

test("Codex loaded pagination rejects cursor loops instead of polling forever", async () => {
  let pages = 0;
  const { provider, calls } = harness((method) => {
    if (method === "thread/loaded/list") {
      if (++pages > 3) throw new Error("test guard: pagination did not terminate");
      return { data: [], nextCursor: "same" };
    }
    throw new Error(method);
  });
  await assert.rejects(provider.list(), { code: "CODEX_PAGE_INVALID" });
  assert.equal(calls.filter(([method]) => method === "thread/loaded/list").length, 2);
  assert.equal(calls.at(-1)[0], "close");
});

test("daemon version parser rejects protocol drift", () => {
  assert.equal(parseDaemonVersion('{"status":"running"}').status, "running");
  assert.throws(() => parseDaemonVersion("no"), { code: "CODEX_DAEMON_INVALID" });
});

test("Codex partial thread read failure is not reported as a healthy complete snapshot", async () => {
  const { provider, calls } = harness((method, params) => {
    if (method === "thread/loaded/list") return { data: ["good", "failed"], nextCursor: null };
    if (method === "thread/read" && params.threadId === "good") return { thread: { id: "good", cwd: "/work" } };
    throw Object.assign(new Error("temporary read failure"), { code: "READ_FAILED" });
  });
  await assert.rejects(provider.list(), { code: "READ_FAILED" });
  assert.equal(calls.at(-1)[0], "close");
});

test("Codex maps generated native approval and user-input flags without calling them ready", async () => {
  // Codex 0.153.2 generated ThreadStatus/ThreadActiveFlag schema.
  for (const [status, expected] of [
    [{ type: "active", activeFlags: ["waitingOnApproval"] }, "needs-input"],
    [{ type: "active", activeFlags: ["waitingOnUserInput"] }, "needs-input"],
    [{ type: "active", activeFlags: [] }, "working"],
    [{ type: "notLoaded" }, "unavailable"],
    [{ type: "systemError" }, "error"],
    [{ type: "idle" }, "idle"],
  ]) {
    const { provider } = harness((method) => method === "thread/loaded/list" ? { data: ["t"] } : { thread: { id: "t", cwd: "/work", status } });
    assert.equal((await provider.list())[0].status, expected);
  }
});

test("Codex ask refuses a target that is no longer loaded without submitting", async () => {
  const { provider, calls } = harness((method) => {
    if (method === "thread/read") return { thread: { status: { type: "notLoaded" } } };
    if (method === "turn/start") throw new Error("must not submit");
    throw new Error(method);
  });
  await assert.rejects(provider.ask({ id: "codex:t", nativeId: "t" }, "hello", { requestId: "r" }), { code: "TARGET_UNAVAILABLE" });
  assert.equal(calls.some(([method]) => method === "turn/start"), false);
});

test("hung Codex usage cannot indefinitely hold up session discovery", async () => {
  let aborted = false;
  const provider = new CodexProvider({
    usageTimeoutMs: 10, eventLog: { record() {} },
    run: async () => ({ stdout: JSON.stringify({ status: "running", socketPath: "/tmp/proof.sock" }) }),
    clientFactory: async () => ({
      initialize: async () => {}, close: async () => {},
      request: async (method, _params, { signal } = {}) => {
        if (method === "account/rateLimits/read") { signal?.addEventListener("abort", () => { aborted = true; }); return new Promise(() => {}); }
        return { data: [], nextCursor: null };
      },
    }),
  });
  assert.deepEqual(await provider.list({ includeUsage: true }), []);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(aborted, true);
  assert.equal(provider.usageSnapshot(), null);
});

test("slow usage runs on its own connection without holding discovery or duplicating concurrent refreshes", async () => {
  let release; const quota = new Promise((resolve) => { release = resolve; });
  const clients = []; let quotaReads = 0;
  const provider = new CodexProvider({
    usageTimeoutMs: 5000, eventLog: { record() {} },
    run: async () => ({ stdout: JSON.stringify({ status: "running", socketPath: "/tmp/proof.sock" }) }),
    clientFactory: async () => {
      const state = { closed: false, quota: false }; clients.push(state);
      return { initialize: async () => {}, close: async () => { state.closed = true; }, request: async (method) => {
        if (method === "account/rateLimits/read") { state.quota = true; quotaReads++; return quota; }
        return { data: [], nextCursor: null };
      } };
    },
  });
  let finished = false;
  const listing = provider.list({ includeUsage: true }).then(() => { finished = true; });
  try {
    await new Promise(setImmediate);
    assert.equal(finished, true, "session discovery must finish while quota is still pending");
    assert.equal(clients.find((client) => client.quota)?.closed, false);
    assert.equal(clients.find((client) => !client.quota)?.closed, true);
    await provider.list({ includeUsage: true });
    assert.equal(quotaReads, 1);
  } finally { release({ rateLimits: { primary: { usedPercent: 20, windowDurationMins: 10080 } } }); await listing; }
  await new Promise(setImmediate);
  assert.ok(clients.every((client) => client.closed));
  assert.equal(provider.usageSnapshot().remainingPercent, 80);
});

test("Codex connection recovery retries discovery but never repeats initialized operations", async () => {
  const failure = new Error("initialize failed");
  let attempts = 0;
  let discoveries = 0;
  let closes = 0;
  const provider = new CodexProvider({
    run: async () => ({ stdout: JSON.stringify({ status: "running", socketPath: `/tmp/proof-${++discoveries}.sock` }) }),
    clientFactory: async (socket) => {
      assert.equal(socket, `/tmp/proof-${attempts + 1}.sock`);
      if (++attempts === 1) throw new Error("old socket");
      return { initialize: async () => { throw failure; }, close: async () => { closes++; }, request: async () => assert.fail("must not submit") };
    },
  });
  await assert.rejects(provider.create("not submitted"), (error) => error === failure);
  assert.deepEqual([attempts, discoveries, closes], [2, 2, 1]);
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
  await new Promise(setImmediate); // Quota is deliberately independent of list completion.
  usedPercent = 99;
  now += 3 * 60_000;
  await provider.list({ includeUsage: true });
  assert.equal(calls.filter(([method]) => method === "account/rateLimits/read").length, 1);
  assert.equal(provider.usageSnapshot().remainingPercent, 2);

  now += 2 * 60_000;
  await provider.list({ includeUsage: true });
  await new Promise(setImmediate);
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
  await new Promise(setImmediate);
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

test("Codex create applies the routed model and effort to the new thread", async () => {
  const { provider, calls } = harness((method) => {
    if (method === "thread/start") return { thread: { id: "routed-thread" } };
    if (method === "turn/start") return { turn: { id: "routed-turn" } };
    throw new Error(method);
  });
  await provider.create("inspect the issue", {
    cwd: "/work/sample-app",
    model: "gpt-6-astra",
    effort: "low",
  });
  assert.deepEqual(calls.find(([method]) => method === "thread/start")[1], {
    cwd: "/work/sample-app",
    developerInstructions: WAGA_SESSION_INSTRUCTIONS,
    model: "gpt-6-astra",
  });
  assert.deepEqual(calls.find(([method]) => method === "turn/start")[1], {
    threadId: "routed-thread",
    input: [{ type: "text", text: "inspect the issue", textElements: [] }],
    model: "gpt-6-astra",
    effort: "low",
  });
});

test("Codex create applies the explicit YOLO policy to the thread and first turn", async () => {
  const { provider, calls } = harness((method) => {
    if (method === "thread/start") return { thread: { id: "yolo-thread" } };
    if (method === "turn/start") return { turn: { id: "yolo-turn" } };
    throw new Error(method);
  });
  await provider.create("run the proof", {
    cwd: "/work/sample-app",
    model: "gpt-6-astra",
    effort: "xhigh",
    executionMode: CODEX_EXECUTION_MODES.YOLO,
  });
  assert.deepEqual(calls.find(([method]) => method === "thread/start")[1], {
    cwd: "/work/sample-app",
    developerInstructions: WAGA_SESSION_INSTRUCTIONS,
    model: "gpt-6-astra",
    approvalPolicy: "never",
    sandbox: "danger-full-access",
  });
  assert.deepEqual(calls.find(([method]) => method === "turn/start")[1], {
    threadId: "yolo-thread",
    input: [{ type: "text", text: "run the proof", textElements: [] }],
    model: "gpt-6-astra",
    effort: "xhigh",
    approvalPolicy: "never",
    sandboxPolicy: { type: "dangerFullAccess" },
  });
});

test("Codex create applies each configured execution category to the thread and first turn", async () => {
  const { provider, calls } = harness((method) => {
    if (method === "thread/start") return { thread: { id: "configured-thread" } };
    if (method === "turn/start") return { turn: { id: "configured-turn" } };
    throw new Error(method);
  });
  await provider.create("run the configured task", {
    cwd: "/work/sample-app",
    executionSettings: {
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      approvalsReviewer: "auto_review",
      summary: "detailed",
      options: { allowProviderModelFallback: true },
    },
  });
  assert.deepEqual(calls.find(([method]) => method === "thread/start")[1], {
    cwd: "/work/sample-app",
    developerInstructions: WAGA_SESSION_INSTRUCTIONS,
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
    approvalsReviewer: "auto_review",
    allowProviderModelFallback: true,
  });
  assert.deepEqual(calls.find(([method]) => method === "turn/start")[1], {
    threadId: "configured-thread",
    input: [{ type: "text", text: "run the configured task", textElements: [] }],
    approvalPolicy: "on-request",
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: ["/work/sample-app"],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    },
    approvalsReviewer: "auto_review",
    summary: "detailed",
  });
});

test("Codex create rejects an unknown execution mode before submitting", async () => {
  const { provider, calls } = harness(() => { throw new Error("must not call App Server"); });
  await assert.rejects(provider.create("unsafe", { executionMode: "unknown" }), { code: "CODEX_EXECUTION_MODE_INVALID" });
  assert.equal(calls.some(([method]) => method === "thread/start"), false);
});

test("existing Codex thread applies YOLO through settings update and verifies resume", async () => {
  const { provider, calls } = harness((method, params) => {
    if (method === "thread/settings/update") return {};
    if (method === "thread/resume") return { thread: { id: params.threadId }, approvalPolicy: "never", sandbox: { type: "dangerFullAccess" } };
    throw new Error(method);
  });
  assert.deepEqual(await provider.prepareNativeSession({ nativeId: "existing" }, "yolo"), { socketPath: "/tmp/codex.sock" });
  assert.deepEqual(calls.find(([method]) => method === "thread/settings/update"), ["thread/settings/update", {
    threadId: "existing", approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" },
  }]);
  assert.deepEqual(calls.find(([method]) => method === "thread/resume"), ["thread/resume", { threadId: "existing", excludeTurns: true }]);
});

test("existing Codex thread restores daemon defaults and rejects a silent permission mismatch", async () => {
  const { provider, calls } = harness((method, params) => {
    if (method === "config/read") return { config: { approval_policy: "on-request", sandbox_mode: "read-only" } };
    if (method === "thread/settings/update") return {};
    if (method === "thread/resume") return { thread: { id: params.threadId }, approvalPolicy: "never", sandbox: { type: "dangerFullAccess" } };
    throw new Error(method);
  });
  await assert.rejects(provider.prepareNativeSession({ nativeId: "existing" }, "default"), { code: "CODEX_PERMISSION_MISMATCH" });
  assert.deepEqual(calls.find(([method]) => method === "thread/settings/update"), ["thread/settings/update", {
    threadId: "existing", approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly", networkAccess: false },
  }]);
});

test("unsupported settings update fails before native Codex reconnect", async () => {
  const { provider } = harness((method) => { throw new Error(`${method} unsupported`); });
  await assert.rejects(provider.prepareNativeSession({ nativeId: "existing" }, "yolo"), /thread\/settings\/update unsupported/);
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
    if (method === "thread/read") return { thread: { status: { type: "idle" } } };
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
  assert.deepEqual(progress, ["waiting", "submitting", "submitted", "replied"]);
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

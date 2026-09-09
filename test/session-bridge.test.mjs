import assert from "node:assert/strict";
import test from "node:test";

import { BridgeError, SessionBridge } from "../src/session-bridge.mjs";

function publicError(code) {
  return (error) => {
    assert.ok(error instanceof BridgeError);
    assert.equal(error.code, code);
    assert.ok(error.message.trim(), "public errors need a readable explanation");
    return true;
  };
}

function provider(name, sessions, calls = []) {
  return {
    name,
    async list(options) { calls.push(["list", options]); return sessions; },
    async create(message, options) { calls.push(["create", message, options]); return { provider: name, nativeId: `${name}-new` }; },
    async archive(session) { calls.push(["archive", session]); return { target: session.id, archived: true }; },
    async rename(session, name) { calls.push(["rename", session, name]); return { target: session.id, renamed: true, name }; },
    async send(session, message, options) { calls.push(["send", session, message, options]); return { target: session.id, requestId: options.requestId }; },
    async ask(session, message, options) { calls.push(["ask", session, message, options]); return { target: session.id, requestId: options.requestId, reply: "yes" }; },
  };
}

test("preview delegates the exact discovered identity without rediscovery or name resolution", async () => {
  const session = { id: "codex:full", nativeId: "full", provider: "codex", name: "duplicate" };
  const options = { signal: new AbortController().signal };
  const bridge = new SessionBridge({ providers: [{ name: "codex", list: () => { throw new Error("must not rediscover"); }, preview: async (actual, passed) => {
    assert.equal(actual, session); assert.equal(passed, options); return { input: "preview" };
  } }, { name: "claude" }] });
  assert.deepEqual(await bridge.preview(session, options), { input: "preview" });
  await assert.rejects(bridge.preview({ provider: "claude" }), { code: "PREVIEW_UNAVAILABLE" });
});

test("discovery keeps healthy provider results and exposes warnings", async () => {
  const claude = provider("claude", [{ id: "claude:1", provider: "claude", name: "one", updatedAt: 1 }]);
  const codex = { name: "codex", async list() { throw Object.assign(new Error("offline"), { code: "DOWN" }); } };
  const result = await new SessionBridge({ providers: [claude, codex] }).discover();
  assert.deepEqual(result.sessions.map((row) => row.id), ["claude:1"]);
  assert.deepEqual(result.warnings, [{ provider: "codex", code: "DOWN", message: "offline" }]);
  assert.deepEqual(result.availableProviders, ["claude"]);
  assert.deepEqual(result.providerUsage, {});
});

test("discovery requests and exposes optional provider usage", async () => {
  const calls = [];
  const usage = { remainingPercent: 2, windowDurationMins: 10_080 };
  const codex = provider("codex", [], calls);
  codex.usageSnapshot = () => usage;

  const result = await new SessionBridge({ providers: [codex] }).discover({ cwd: "/work", includeUsage: true });

  assert.deepEqual(calls, [["list", { cwd: "/work", includeUsage: true }]]);
  assert.deepEqual(result.providerUsage, { codex: usage });
});

test("provider-prefixed target limits discovery and ask is one request", async () => {
  const calls = [];
  const session = { id: "codex:full", nativeId: "full", sessionId: "full", provider: "codex", name: "proof" };
  const bridge = new SessionBridge({ providers: [provider("claude", [], calls), provider("codex", [session], calls)] });
  const onProgress = () => {};
  const result = await bridge.ask("codex:full", "hello", { waitTimeoutMs: 12_000, replyTimeoutMs: 1234, untilIdle: true, onProgress });
  assert.equal(result.reply, "yes");
  assert.deepEqual(calls, [
    ["list", { cwd: undefined }],
    ["ask", session, "hello", { requestId: result.requestId, waitTimeoutMs: 12_000, replyTimeoutMs: 1234, untilIdle: true, onProgress, expectsReply: true }],
  ]);
});

test("ambiguous unprefixed name fails with exact candidates", async () => {
  const calls = [];
  const bridge = new SessionBridge({ providers: [
    provider("claude", [{ id: "claude:a", provider: "claude", name: "same" }], calls),
    provider("codex", [{ id: "codex:b", provider: "codex", name: "same" }], calls),
  ] });
  for (const action of [() => bridge.send("same", "hello"), () => bridge.ask("same", "hello"), () => bridge.archive("same"), () => bridge.rename("same", "new")]) {
    calls.length = 0;
    await assert.rejects(action(), (error) => {
      publicError("TARGET_AMBIGUOUS")(error);
      assert.match(error.message, /claude:a/);
      assert.match(error.message, /codex:b/);
      return true;
    });
    assert.deepEqual(calls.map(([kind]) => kind), ["list", "list"]);
  }
});

test("send resolves each exact identity among decoys and never sends to a missing or partial target", async () => {
  const calls = [];
  const target = { id: "codex:target", nativeId: "native-target", sessionId: "thread-target", provider: "codex", name: "review" };
  const decoy = { id: "codex:other", nativeId: "native-other", sessionId: "thread-other", provider: "codex", name: "other" };
  const bridge = new SessionBridge({ providers: [provider("codex", [decoy, target], calls)] });

  for (const identity of [target.id, target.nativeId, target.sessionId, target.name]) {
    calls.length = 0;
    const result = await bridge.send(identity, "check this", { cwd: "/work/project" });
    assert.equal(result.target, target.id);
    assert.equal(typeof result.requestId, "string");
    assert.ok(result.requestId.length > 0);
    assert.deepEqual(calls, [
      ["list", { cwd: "/work/project" }],
      ["send", target, "check this", { requestId: result.requestId, expectsReply: false }],
    ]);
  }
  for (const missing of ["codex:missing", "native-", "thread-", "rev"]) {
    calls.length = 0;
    await assert.rejects(bridge.send(missing, "must not be sent"), { code: "SESSION_NOT_FOUND" });
    assert.deepEqual(calls, [["list", { cwd: undefined }]]);
  }
});

test("create delegates one prompt to the selected native provider", async () => {
  const calls = [];
  const bridge = new SessionBridge({ providers: [provider("claude", [], calls), provider("codex", [], calls)] });
  const result = await bridge.create("codex", "  implement the parser  ", { cwd: "/work/project" });
  assert.deepEqual(result, { provider: "codex", nativeId: "codex-new" });
  assert.deepEqual(calls, [["create", "implement the parser", { cwd: "/work/project" }], ["list", { cwd: "/work/project" }]]);
  await assert.rejects(bridge.create("codex", "   ", { cwd: "/work/project" }), { code: "PROMPT_REQUIRED" });
});

test("create forwards a routed model and returns the routing decision", async () => {
  const calls = [];
  const routing = { provider: "codex", model: "gpt-6-astra", effort: "low", tier: "promoted", reasons: ["issue-loop (+3)"] };
  const bridge = new SessionBridge({
    providers: [provider("codex", [], calls)],
    router: () => routing,
  });
  const result = await bridge.create("codex", "inspect the issue", { cwd: "/work/project" });
  assert.deepEqual(result.routing, routing);
  assert.deepEqual(calls, [
    ["create", "inspect the issue", { cwd: "/work/project", model: "gpt-6-astra", effort: "low" }],
    ["list", { cwd: "/work/project" }],
  ]);
});

test("create forwards Codex execution mode but keeps it out of Claude options", async () => {
  const calls = [];
  const bridge = new SessionBridge({ providers: [provider("claude", [], calls), provider("codex", [], calls)] });
  await bridge.create("codex", "run without prompts", { cwd: "/work/project", executionMode: "yolo" });
  await bridge.create("claude", "review safely", { cwd: "/work/project", executionMode: "yolo" });
  assert.deepEqual(calls.filter(([kind]) => kind === "create"), [
    ["create", "run without prompts", { cwd: "/work/project", executionMode: "yolo" }],
    ["create", "review safely", { cwd: "/work/project" }],
  ]);
});

test("an explicit routing decision avoids re-running the bridge router", async () => {
  const calls = [];
  let routed = 0;
  const routing = { provider: "claude", model: "opus", effort: "high", tier: "default", reasons: [] };
  const bridge = new SessionBridge({
    providers: [provider("claude", [], calls)],
    router: () => { routed += 1; return routing; },
  });
  await bridge.create("claude", "review", { cwd: "/work/project", routing });
  assert.equal(routed, 0);
  assert.deepEqual(calls[0], ["create", "review", { cwd: "/work/project", model: "opus", effort: "high" }]);
});

test("create awaits the dedicated router only at session creation", async () => {
  const calls = [];
  const routing = { provider: "codex", model: "large", effort: "low", tier: "promoted", reasons: ["issue metadata"] };
  const bridge = new SessionBridge({
    providers: [provider("codex", [], calls)],
    router: () => { throw new Error("preview router must not be used when createRouter is provided"); },
    createRouter: async (input) => {
      assert.deepEqual(input, { provider: "codex", prompt: "inspect the issue", cwd: "/work/project" });
      return routing;
    },
  });
  const result = await bridge.create("codex", "inspect the issue", { cwd: "/work/project" });
  assert.deepEqual(result.routing, routing);
  assert.deepEqual(calls[0], ["create", "inspect the issue", { cwd: "/work/project", model: "large", effort: "low" }]);
});

test("create resolves only the acknowledged native identity without querying the other provider or usage", async () => {
  const calls = [];
  const session = { id: "claude:full-new", nativeId: "claude-new", provider: "claude", cwd: "/work/project" };
  const claude = provider("claude", [{ ...session, nativeId: "other", id: "claude:other" }, session], calls);
  const codex = { name: "codex", list() { throw new Error("unrelated provider queried"); } };
  const bridge = new SessionBridge({ providers: [claude, codex] });
  assert.equal((await bridge.create("claude", "new", { cwd: session.cwd })).session, session);
  assert.deepEqual(calls, [["create", "new", { cwd: session.cwd }], ["list", { cwd: session.cwd }]]);
  claude.list = async () => { throw new Error("temporary discovery failure"); };
  assert.deepEqual(await bridge.create("claude", "second"), { provider: "claude", nativeId: "claude-new" });
  assert.equal(calls.filter(([kind]) => kind === "create").length, 2, "a discovery error must not repeat creation");
});

test("archive resolves one live target and delegates to its native provider", async () => {
  const calls = [];
  const session = { id: "claude:full", nativeId: "1234abcd", sessionId: "full", provider: "claude", name: "proof" };
  const bridge = new SessionBridge({ providers: [provider("claude", [session], calls), provider("codex", [], calls)] });
  assert.deepEqual(await bridge.archive("claude:full", { cwd: "/work/project" }), { target: "claude:full", archived: true });
  assert.deepEqual(calls, [
    ["list", { cwd: "/work/project" }],
    ["archive", session],
  ]);
});

test("rename resolves one live target and validates the new name", async () => {
  const calls = [];
  const session = { id: "codex:full", nativeId: "full", provider: "codex", name: "before" };
  const bridge = new SessionBridge({ providers: [provider("codex", [session], calls)] });
  assert.deepEqual(await bridge.rename("codex:full", "  after  "), { target: "codex:full", renamed: true, name: "after" });
  assert.deepEqual(calls, [["list", { cwd: undefined }], ["rename", session, "after"]]);
  await assert.rejects(bridge.rename("codex:full", "  "), { code: "NAME_REQUIRED" });
});

test("bridge errors preserve their public code and original cause", () => {
  const cause = new Error("transport closed");
  const error = new BridgeError("DOWN", "provider unavailable", { cause });
  assert.ok(error instanceof Error);
  assert.equal(error.code, "DOWN");
  assert.equal(error.message, "provider unavailable");
  assert.equal(error.cause, cause);
});

test("bridge rejects missing or invalid provider collections at construction", () => {
  for (const providers of [undefined, null, [], {}, "codex"]) {
    assert.throws(() => new SessionBridge({ providers }), (error) => {
      assert.ok(error instanceof TypeError);
      assert.match(error.message, /SessionBridge/);
      return true;
    });
  }
});

test("invalid target, prompt, or name never reaches a provider", async () => {
  const calls = [];
  const bridge = new SessionBridge({ providers: [provider("codex", [], calls)] });
  for (const invalid of [undefined, null, 42, {}, "", " \n\t "]) {
    await assert.rejects(bridge.create("codex", invalid), publicError("PROMPT_REQUIRED"));
    await assert.rejects(bridge.rename("codex:x", invalid), publicError("NAME_REQUIRED"));
    await assert.rejects(bridge.send(invalid, "message"), publicError("TARGET_REQUIRED"));
    await assert.rejects(bridge.ask(invalid, "message"), publicError("TARGET_REQUIRED"));
    await assert.rejects(bridge.archive(invalid), publicError("TARGET_REQUIRED"));
    await assert.rejects(bridge.rename(invalid, "valid"), publicError("TARGET_REQUIRED"));
  }
  assert.deepEqual(calls, []);
});

test("unknown providers are rejected without consulting a configured provider", async () => {
  const calls = [];
  const bridge = new SessionBridge({ providers: [provider("codex", [], calls)] });
  for (const action of [() => bridge.discover({ provider: "unknown" }), () => bridge.create("unknown", "prompt"), () => bridge.send("claude:x", "message")]) {
    await assert.rejects(action(), (error) => {
      publicError("PROVIDER_NOT_FOUND")(error);
      assert.match(error.message, /unknown|claude/);
      return true;
    });
  }
  assert.deepEqual(calls, []);
});

test("discovery distinguishes an empty healthy provider from total failure", async () => {
  const offline = { name: "codex", async list() { throw Object.assign(new Error("offline"), { code: "DOWN" }); } };
  const bridge = new SessionBridge({ providers: [provider("claude", []), offline] });
  const result = await bridge.discover();
  assert.deepEqual(result.sessions, []);
  assert.deepEqual(result.availableProviders, ["claude"]);
  assert.deepEqual(result.warnings, [{ provider: "codex", code: "DOWN", message: "offline" }]);
  const broken = { name: "claude", async list() { throw new Error("broken"); } };
  await assert.rejects(new SessionBridge({ providers: [broken, offline] }).discover(), (error) => {
    publicError("DISCOVERY_FAILED")(error);
    assert.match(error.message, /claude: broken/);
    assert.match(error.message, /codex: offline/);
    return true;
  });
});

test("discovery tolerates non-Error rejections and retains missing-target diagnostics", async () => {
  const calls = [];
  for (const reason of [null, undefined, "offline"]) {
    const offline = { name: "codex", async list() { throw reason; } };
    const bridge = new SessionBridge({ providers: [provider("claude", [], calls), offline] });
    const result = await bridge.discover();
    assert.deepEqual(result.warnings, [{ provider: "codex", code: "PROVIDER_ERROR", message: String(reason) }]);
    await assert.rejects(bridge.send("missing", "message"), (error) => {
      publicError("SESSION_NOT_FOUND")(error);
      assert.ok(error.message.includes("missing"));
      assert.ok(error.message.includes(`codex: ${String(reason)}`));
      return true;
    });
  }
  assert.ok(calls.every(([kind]) => kind === "list"));
});

test("discovery sorts mixed timestamps without changing provider-owned arrays", async () => {
  const rows = [{ id: "missing" }, { id: "new", updatedAt: 30 }, { id: "old", updatedAt: 10 }, { id: "null", updatedAt: null }];
  const original = structuredClone(rows);
  const bridge = new SessionBridge({ providers: [provider("claude", rows), provider("codex", [{ id: "middle", updatedAt: 20 }])] });
  assert.deepEqual((await bridge.discover()).sessions.map(({ id }) => id), ["new", "middle", "old", "missing", "null"]);
  assert.deepEqual(rows, original);
});

test("usage remains opt-in and adapters without usage snapshots are supported", async () => {
  let reads = 0;
  const claude = provider("claude", []);
  claude.usageSnapshot = () => { reads += 1; return { remainingPercent: 50 }; };
  const bridge = new SessionBridge({ providers: [claude, provider("codex", [])] });
  assert.deepEqual((await bridge.discover()).providerUsage, {});
  assert.equal(reads, 0);
  assert.deepEqual((await bridge.discover({ includeUsage: true })).providerUsage, { claude: { remainingPercent: 50 } });
  assert.equal(reads, 1);
});

test("provider-like text inside a name does not restrict discovery", async () => {
  const session = { id: "claude:x", provider: "claude", name: "review codex:task" };
  const calls = [];
  const bridge = new SessionBridge({ providers: [provider("claude", [session], calls), provider("codex", [], calls)] });
  assert.equal((await bridge.send(session.name, "message")).target, session.id);
  assert.deepEqual(calls.map(([kind]) => kind), ["list", "list", "send"]);
});

test("ask defaults retain separate deadlines and fresh IDs across requests", async () => {
  const session = { id: "codex:x", provider: "codex" };
  const calls = [];
  const bridge = new SessionBridge({ providers: [provider("codex", [session], calls)] });
  const first = await bridge.ask(session.id, "first", { cwd: "/work" });
  const second = await bridge.ask(session.id, "second", { cwd: "/work" });
  assert.equal(typeof first.requestId, "string");
  assert.ok(first.requestId.length > 0);
  assert.notEqual(first.requestId, second.requestId);
  assert.deepEqual(calls, [
    ["list", { cwd: "/work" }],
    ["ask", session, "first", { requestId: first.requestId, waitTimeoutMs: 1_800_000, replyTimeoutMs: 180_000, untilIdle: false, onProgress: undefined, expectsReply: true }],
    ["list", { cwd: "/work" }],
    ["ask", session, "second", { requestId: second.requestId, waitTimeoutMs: 1_800_000, replyTimeoutMs: 180_000, untilIdle: false, onProgress: undefined, expectsReply: true }],
  ]);
});

test("provider delivery failure is propagated without retrying or relaying", async () => {
  const session = { id: "codex:x", provider: "codex" };
  const calls = [];
  const adapter = provider("codex", [session], calls);
  const failure = new Error("delivery failed");
  for (const method of ["send", "ask", "archive", "rename"]) {
    adapter[method] = async (...args) => { calls.push([method, ...args]); throw failure; };
    calls.length = 0;
    const bridge = new SessionBridge({ providers: [adapter] });
    const action = method === "archive" ? bridge.archive(session.id) : bridge[method](session.id, "message");
    await assert.rejects(action, (error) => error === failure);
    assert.deepEqual(calls.map(([kind]) => kind), ["list", method]);
  }
});

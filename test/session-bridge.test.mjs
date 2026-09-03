import assert from "node:assert/strict";
import test from "node:test";

import { SessionBridge } from "../src/session-bridge.mjs";

function provider(name, sessions, calls = []) {
  return {
    name,
    async list(options) { calls.push(["list", options]); return sessions; },
    async create(message, options) { calls.push(["create", message, options]); return { provider: name, nativeId: `${name}-new` }; },
    async archive(session) { calls.push(["archive", session]); return { target: session.id, archived: true }; },
    async send(session, message, options) { calls.push(["send", session, message, options]); return { target: session.id, requestId: options.requestId }; },
    async ask(session, message, options) { calls.push(["ask", session, message, options]); return { target: session.id, requestId: options.requestId, reply: "yes" }; },
  };
}

test("discovery keeps healthy provider results and exposes warnings", async () => {
  const claude = provider("claude", [{ id: "claude:1", provider: "claude", name: "one", updatedAt: 1 }]);
  const codex = { name: "codex", async list() { throw Object.assign(new Error("offline"), { code: "DOWN" }); } };
  const result = await new SessionBridge({ providers: [claude, codex] }).discover();
  assert.deepEqual(result.sessions.map((row) => row.id), ["claude:1"]);
  assert.deepEqual(result.warnings, [{ provider: "codex", code: "DOWN", message: "offline" }]);
  assert.deepEqual(result.availableProviders, ["claude"]);
});

test("provider-prefixed target limits discovery and ask is one request", async () => {
  const calls = [];
  const session = { id: "codex:full", nativeId: "full", sessionId: "full", provider: "codex", name: "proof" };
  const bridge = new SessionBridge({ providers: [provider("claude", [], calls), provider("codex", [session], calls)] });
  const onProgress = () => {};
  const result = await bridge.ask("codex:full", "hello", { waitTimeoutMs: 12_000, replyTimeoutMs: 1234, onProgress });
  assert.equal(result.reply, "yes");
  assert.equal(calls.filter(([kind]) => kind === "list").length, 1);
  assert.equal(calls.at(-1)[0], "ask");
  assert.equal(calls.at(-1)[3].waitTimeoutMs, 12_000);
  assert.equal(calls.at(-1)[3].replyTimeoutMs, 1234);
  assert.equal(calls.at(-1)[3].onProgress, onProgress);
});

test("ambiguous unprefixed name fails with exact candidates", async () => {
  const bridge = new SessionBridge({ providers: [
    provider("claude", [{ id: "claude:a", provider: "claude", name: "same" }]),
    provider("codex", [{ id: "codex:b", provider: "codex", name: "same" }]),
  ] });
  await assert.rejects(bridge.send("same", "hello"), { code: "TARGET_AMBIGUOUS" });
});

test("create delegates one prompt to the selected native provider", async () => {
  const calls = [];
  const bridge = new SessionBridge({ providers: [provider("claude", [], calls), provider("codex", [], calls)] });
  const result = await bridge.create("codex", "implement the parser", { cwd: "/work/project" });
  assert.deepEqual(result, { provider: "codex", nativeId: "codex-new" });
  assert.deepEqual(calls, [["create", "implement the parser", { cwd: "/work/project" }]]);
  await assert.rejects(bridge.create("codex", "   ", { cwd: "/work/project" }), { code: "PROMPT_REQUIRED" });
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

import assert from "node:assert/strict";
import test from "node:test";

import { CodexProvider, parseDaemonVersion } from "../src/providers/codex.mjs";

function harness(responder) {
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
  return { calls, provider: new CodexProvider({ run, clientFactory: async () => client, wait: async () => {} }) };
}

test("daemon version parser rejects protocol drift", () => {
  assert.equal(parseDaemonVersion('{"status":"running"}').status, "running");
  assert.throws(() => parseDaemonVersion("no"), { code: "CODEX_DAEMON_INVALID" });
});

test("Codex provider lists only native top-level source kinds", async () => {
  const { provider, calls } = harness((method) => {
    if (method === "thread/list") return { data: [{ id: "thread-1", cwd: "/work", name: "proof", status: { type: "idle" }, updatedAt: 5 }], nextCursor: null };
    throw new Error(method);
  });
  const rows = await provider.list({ cwd: "/work" });
  assert.equal(rows[0].id, "codex:thread-1");
  const params = calls.find(([method]) => method === "thread/list")[1];
  assert.deepEqual(params.sourceKinds, ["cli", "vscode", "exec", "appServer"]);
  assert.equal(params.cwd, "/work");
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
  const result = await provider.ask({ id: "codex:t", nativeId: "t" }, "hello", { requestId: "r", timeoutMs: 2_000 });
  assert.equal(result.reply, "CODEX_OK");
  assert.equal(result.exchangeCount, 1);
});

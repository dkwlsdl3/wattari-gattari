import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.mjs";
import { ClaudeProvider } from "../src/providers/claude.mjs";
import { CodexProvider } from "../src/providers/codex.mjs";
import { RequestStore } from "../src/request-store.mjs";
import { SessionBridge } from "../src/session-bridge.mjs";

function storeFor(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "waga-proof-query-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return new RequestStore(directory);
}
function output() { return { value: "", write(text) { this.value += text; } }; }

for (const status of ["working", "needs-input"]) {
  test(`Claude CLI returns its answer while the peer remains ${status}, including legacy --until-idle`, async t => {
    const store = storeFor(t);
    const session = { id: "claude:proof", sessionId: "proof", provider: "claude", socketPath: "/proof/peer.sock", status };
    let sent = 0, stopped = 0, reads = 0;
    const provider = new ClaudeProvider({
      endpointFactory: () => ({
        async start() {},
        async send() { sent++; return "message"; },
        async waitForDisposition() { return { state: "accepted" }; },
        async waitForReply(_socket, _message, { requestId }) { return { text: `[WAGA REPLY ${requestId}] 안 씀` }; },
        async stop() { stopped++; },
      }),
      wait: async () => { throw new Error("must not wait for the peer's other work"); },
    });
    provider.list = async () => { reads++; return [session]; };
    const bridge = new SessionBridge({ providers: [provider], requestStore: store });
    const stdout = output(), stderr = output();
    assert.equal(await runCli(["ask", session.id, "사용 중입니까?", "--until-idle", "--notify-origin"], {
      bridge, stdout, stderr, origin: "claude:origin",
      originNotifier: async ({ requestId, reply }) => {
        // The answer must already be recoverable before notification or caller interruption.
        const recovered = await bridge.result(requestId);
        assert.equal(recovered.state, "replied");
        assert.equal(recovered.reply, reply);
      },
    }), 0);
    assert.match(stdout.value, /안 씀\n$/);
    assert.doesNotMatch(stderr.value, /waiting for idle|target still busy|ORIGIN_NOTIFY_FAILED/);
    assert.equal(sent, 1);
    assert.equal(stopped, 1);
    assert.equal(reads, 2, "only discovery and identity validation may read peer status");
  });
}

test("legacy Claude reply-received records return their stored answer offline in plain and JSON result", async t => {
  const store = storeFor(t);
  const session = { id: "claude:proof", sessionId: "proof", provider: "claude" };
  const record = store.create(session, { untilIdle: true });
  store.update(record, { state: "reply-received", delivery: "accepted", reply: "안 씀", finished: true });
  const provider = new ClaudeProvider();
  provider.list = async () => { throw new Error("the answer must not depend on a live peer"); };
  const bridge = new SessionBridge({ providers: [provider], requestStore: store });
  for (const json of [false, true]) {
    const stdout = output();
    assert.equal(await runCli(["result", record.requestId, ...(json ? ["--json"] : [])], {
      bridge, stdout, stderr: output(),
    }), 0);
    if (json) assert.equal(JSON.parse(stdout.value).reply, "안 씀");
    else assert.equal(stdout.value, "안 씀\n");
  }
});

test("default Codex ask and result require the original turn's final answer, independent of thread idle", async () => {
  let completed = false, submitted = 0, itemReads = 0;
  const provider = new CodexProvider({
    run: async () => ({ stdout: '{"status":"running","socketPath":"/proof/codex.sock"}' }),
    eventLog: { record() {} },
    clientFactory: async () => ({
      async initialize() {}, async close() {},
      async request(method) {
        if (method === "thread/read") return { thread: { status: { type: submitted ? "active" : "idle" } } };
        if (method === "turn/start") { submitted++; return { turn: { id: "original" } }; }
        if (method === "thread/turns/list") return { data: [
          { id: "other", status: "completed" },
          { id: "original", status: completed ? "completed" : "inProgress" },
        ] };
        if (method === "thread/items/list") {
          itemReads++;
          return { data: [{ turnId: "original", item: { type: "agentMessage", text: completed ? "FINAL" : "checking…" } }] };
        }
        throw new Error(method);
      },
    }),
    wait: async () => { completed = true; },
  });
  const session = { id: "codex:proof", nativeId: "proof" };
  assert.deepEqual(await provider.result({ session, turnId: "original" }), { state: "working" });
  assert.equal(itemReads, 0, "progress text must not become an immutable answer");
  const answer = await provider.ask(session, "question", { requestId: "proof", timeoutMs: 1000 });
  assert.equal(answer.reply, "FINAL");
  assert.equal(submitted, 1);
  assert.deepEqual(await provider.result({ session, turnId: "original" }), { state: "replied", reply: "FINAL" });
});

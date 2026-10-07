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

test("Claude ask recovers the measured screen-only answer without waiting for SendMessage or idle", async t => {
  const store = storeFor(t), home = store.directory;
  // Keeper #259, 2026-10-07: assistant printed this answer four minutes before SendMessage.
  const row = JSON.parse(fs.readFileSync(new URL("./fixtures/claude-screen-reply.jsonl", import.meta.url), "utf8"));
  const requestId = "fd6cbf57-f39c-482d-a025-40555a93a9f3";
  const session = { id: `claude:${row.sessionId}`, sessionId: row.sessionId, provider: "claude", cwd: "/tmp/waga-proof-screen-reply", socketPath: "/proof/peer.sock", status: "working" };
  const directory = path.join(home, ".claude", "projects", "-tmp-waga-proof-screen-reply");
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${row.sessionId}.jsonl`);
  // A prior answer with the same tag must not satisfy this new invocation.
  fs.writeFileSync(file, JSON.stringify({ ...row, timestamp: new Date().toISOString() }) + "\n");
  let sent = 0, stopped = 0, envelope, appended = false;
  let rejectSocket;
  const provider = new ClaudeProvider({ homeDirectory: home, endpointFactory: () => ({
    socketPath: "/proof/origin.sock",
    async start() {},
    async send(_socket, text) {
      sent++; envelope = text;
      // A proposed tool call is not delivery. The live fallback must leave the
      // socket open until the tool actually sends, or assistant text appears.
      fs.appendFileSync(file, JSON.stringify({ ...row, timestamp: new Date().toISOString(), message: {
        role: "assistant", content: [{ type: "tool_use", name: "SendMessage", input: {
          to: "uds:/proof/origin.sock", message: `[WAGA REPLY ${requestId}] UNSENT_TOOL_CALL`,
        } }],
      } }) + "\n");
      // The actual answer is assistant text. No socket response is ever sent.
      setTimeout(() => {
        fs.appendFileSync(file, JSON.stringify({ ...row, timestamp: new Date().toISOString() }) + "\n");
        appended = true;
      }, 10);
      return "message";
    },
    async waitForDisposition() { return { state: "accepted" }; },
    waitForReply() { return new Promise((_, reject) => { rejectSocket = reject; }); },
    async stop() { stopped++; rejectSocket?.(new Error("closed")); },
  }) });
  provider.list = async () => [session];
  const progress = [];
  const answer = await provider.ask(session, "사용 중입니까?", {
    requestId, replyTimeoutMs: 800, untilIdle: true, onProgress: event => progress.push(event.state),
  });
  assert.equal(answer.reply, row.message.content[0].text);
  assert.equal(appended, true, "the old tagged answer must not satisfy this request");
  assert.equal(sent, 1);
  assert.equal(stopped, 1);
  assert.deepEqual(progress, ["submitting", "submitted", "accepted", "reply-received", "replied"]);
  assert.match(envelope, /SendMessage/);
  assert.match(envelope, /uds:\/proof\/origin\.sock/);
});

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

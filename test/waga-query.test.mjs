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

test("web user instructions retain native turn recovery and never fall back to Claude peer delivery", async t => {
  const store = storeFor(t);
  const session = { id: "codex:proof", nativeId: "proof", provider: "codex" };
  let submissions = 0;
  const provider = {
    name: "codex", list: async () => [session],
    async instruct(_session, message, { onProgress }) {
      submissions++;
      assert.equal(message, "파일을 수정해 주세요");
      onProgress({ state: "submitted", delivery: "accepted", turnId: "native-user-turn" });
      throw Object.assign(new Error("answer still running"), { code: "REPLY_TIMEOUT" });
    },
    async result(record) {
      assert.equal(record.kind, "instruct");
      assert.equal(record.turnId, "native-user-turn");
      return { state: "replied", reply: "수정했습니다" };
    },
  };
  const bridge = new SessionBridge({ providers: [provider], requestStore: store });
  let requestId;
  await assert.rejects(bridge.instruct(session.id, "파일을 수정해 주세요"), error => {
    requestId = error.requestId;
    return error.code === "REPLY_TIMEOUT";
  });
  const restarted = new SessionBridge({ providers: [provider], requestStore: store });
  assert.equal((await restarted.result(requestId)).reply, "수정했습니다");
  assert.equal((await restarted.result(requestId)).reply, "수정했습니다");
  assert.equal(submissions, 1);
  const claude = { name: "claude", list: async () => [{ id: "claude:proof", provider: "claude" }],
    async ask() { assert.fail("a user instruction must never become a peer query"); } };
  await assert.rejects(new SessionBridge({ providers: [claude], requestStore: store }).instruct("claude:proof", "실행해 주세요"), { code: "USER_INPUT_UNAVAILABLE" });
});

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

for (const initialStatus of ["inProgress", "interrupted"]) {
test(`default Codex ask recovers ${initialStatus} to the original turn's final answer, independent of thread idle`, async () => {
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
          { id: "original", status: completed ? "completed" : initialStatus },
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
  assert.deepEqual(await provider.result({ session, turnId: "original" }), { state: initialStatus === "interrupted" ? "interrupted" : "working" });
  assert.equal(itemReads, 0, "progress text must not become an immutable answer");
  const answer = await provider.ask(session, "question", { requestId: "proof", timeoutMs: 1000 });
  assert.equal(answer.reply, "FINAL");
  assert.equal(submitted, 1);
  assert.deepEqual(await provider.result({ session, turnId: "original" }), { state: "replied", reply: "FINAL" });
});
}

test("Claude send result recovers measured queue receipt after the reply socket closes", async t => {
  const store = storeFor(t), home = store.directory;
  const rows = fs.readFileSync(new URL('./fixtures/claude-send-receipt.jsonl', import.meta.url), 'utf8').trim().split('\n').map(JSON.parse);
  const session = { id: `claude:${rows[0].sessionId}`, provider: 'claude', sessionId: rows[0].sessionId, cwd: '/tmp/waga-proof-receipt' };
  const record = store.create(session, { kind: 'send' });
  // Preserve the measured native shape; substitute only correlation and timestamp.
  const measuredId = '97b45169-cf5c-4a61-b197-7cd340cb13ed';
  for (const row of rows) {
    if (row.content) row.content = row.content.replace(measuredId, record.requestId);
    if (row.attachment) row.attachment.origin.body = row.attachment.origin.body.replace(measuredId, record.requestId);
    row.timestamp = new Date(record.createdAt + 1).toISOString();
  }
  store.update(record, { state: 'submitted', delivery: 'submitted', finished: true, messageId: '9669d5f1-a37f-409e-825b-4599e940481d' });
  const directory = path.join(home, '.claude/projects', session.cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${session.sessionId}.jsonl`);
  const provider = new ClaudeProvider({ homeDirectory: home, run: async () => { throw new Error('no native process or message may be started'); } });
  const bridge = new SessionBridge({ providers: [provider], requestStore: store });
  assert.equal((await bridge.result(record.requestId)).state, 'submitted');
  fs.writeFileSync(file, JSON.stringify({ ...rows[0], content: rows[0].content.replace(record.requestId, measuredId) }) + '\n');
  assert.equal((await bridge.result(record.requestId)).state, 'submitted', 'another request is not a receipt');
  fs.appendFileSync(file, JSON.stringify(rows[0]) + '\n');
  let result = await bridge.result(record.requestId);
  assert.equal(result.delivery, 'accepted');
  assert.equal(result.receipt, 'queued');
  assert.equal(result.reply, undefined);
  const queuedOutput = output();
  assert.equal(await runCli(['result', record.requestId], { bridge, stdout: queuedOutput, stderr: output() }), 0);
  assert.match(queuedOutput.value, /receipt=queued/);
  fs.appendFileSync(file, JSON.stringify(rows[1]) + '\n');
  assert.equal((await bridge.result(record.requestId)).receipt, 'queued', 'removal alone does not prove conversation consumption');
  fs.appendFileSync(file, JSON.stringify({ ...rows[2], attachment: { ...rows[2].attachment, origin: { ...rows[2].attachment.origin, msg_id: 'another-message' } } }) + '\n');
  assert.equal((await bridge.result(record.requestId)).receipt, 'queued', 'native message identity must also match');
  fs.appendFileSync(file, JSON.stringify(rows[2]) + '\n');
  result = await bridge.result(record.requestId);
  assert.equal(result.receipt, 'consumed');
  assert.equal(store.read(record.requestId).receipt, 'consumed');
  fs.unlinkSync(file);
  const stdout = output();
  assert.equal(await runCli(['result', record.requestId, '--json'], { bridge, stdout, stderr: output() }), 0);
  assert.equal(JSON.parse(stdout.value).receipt, 'consumed', 'confirmed receipt survives native log disappearance');
});

test("an accepted ask still exits pending until its answer arrives", async () => {
  const stdout = output();
  assert.equal(await runCli(['result', 'proof', '--json'], {
    bridge: { async result() { return { state: 'accepted', delivery: 'accepted' }; } }, stdout, stderr: output(),
  }), 3);
});

test("a genuinely interrupted Codex request stays bounded and is never resubmitted", async () => {
  let clock = 0, submissions = 0;
  const provider = new CodexProvider({
    now: () => clock, wait: async milliseconds => { clock += milliseconds; }, eventLog: { record() {} },
    run: async () => ({ stdout: '{"status":"running","socketPath":"/proof/codex.sock"}' }),
    clientFactory: async () => ({
      async initialize() {}, async close() {},
      async request(method) {
        if (method === 'thread/read') return { thread: { status: { type: submissions ? 'active' : 'idle' } } };
        if (method === 'turn/start') { submissions++; return { turn: { id: 'original' } }; }
        if (method === 'thread/turns/list') return { data: [{ id: 'original', status: 'interrupted' }] };
        throw new Error(`must not fetch progress or submit another turn: ${method}`);
      },
    }),
  });
  await assert.rejects(provider.ask({ id: 'codex:proof', nativeId: 'proof' }, 'question', {
    requestId: 'proof', replyTimeoutMs: 750,
  }), { code: 'TARGET_ERROR' });
  assert.equal(clock, 750);
  assert.equal(submissions, 1);
});

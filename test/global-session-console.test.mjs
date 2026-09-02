import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { runSessionConsole } from "../src/global-session-console.mjs";

class FakeControlClient extends EventEmitter {
  requests = [];
  closed = false;

  async connect() {}

  session(status = "Awaiting input") {
    return {
      id: "codex:thread-1",
      threadId: "thread-1",
      provider: "codex",
      name: "first",
      cwd: "/workspace",
      status,
      lastActivity: "ready",
      updatedAt: 1,
      routable: true,
      gitBranch: "main",
      model: "gpt-test",
      reasoningEffort: "high",
      tokenUsage: {
        last: { totalTokens: 10_000 },
        total: { totalTokens: 12_000 },
        modelContextWindow: 200_000,
      },
      rateLimits: { secondary: { usedPercent: 40, windowDurationMins: 10_080 } },
    };
  }

  state(status = "Awaiting input") {
    return {
      revision: status === "Working" ? 2 : 1,
      approval: null,
      workspaces: [{ path: "/workspace", name: "workspace", sessions: [this.session(status)] }],
    };
  }

  async request(method, params) {
    this.requests.push({ method, params });
    if (method === "workspace/register") return this.state();
    if (method === "session/open" || method === "session/read") {
      return {
        ...this.session(),
        messages: [
          { id: "user-1", role: "user", text: "세션을 확인해 주세요" },
          { id: "agent-1", role: "agent", text: "확인했습니다" },
        ],
        hasOlderMessages: false,
      };
    }
    return { changed: true };
  }

  close() { this.closed = true; }
}

test("runs the real console interface with fake terminal and control adapters", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.columns = 100;
  output.rows = 30;
  let rendered = "";
  output.on("data", (chunk) => { rendered += chunk.toString("utf8"); });
  const client = new FakeControlClient();

  const running = runSessionConsole({
    paths: { controlSocketPath: "/tmp/not-used.sock" },
    ensureDaemon: async () => {},
    createClient: () => client,
    inputStream: input,
    outputStream: output,
    workspacePath: "/workspace",
    listenForSignals: false,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(rendered, /Wattari Gattari/);
  assert.match(rendered, /first/);
  input.emit("keypress", "", { name: "down", ctrl: false, meta: false, shift: false });
  input.emit("keypress", "", { name: "f3", ctrl: false, meta: false, shift: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(client.requests.at(-1), {
    method: "session/setCompleted",
    params: { workspacePath: "/workspace", sessionId: "codex:thread-1", completed: true },
  });

  input.emit("keypress", "", { name: "c", ctrl: true, meta: false, shift: false });
  assert.deepEqual(await running, { exitCode: 0 });
  assert.equal(client.closed, true);
  assert.equal(input.listenerCount("keypress"), 0);
  assert.equal(output.listenerCount("resize"), 0);
  assert.equal(input.isPaused(), true);
});

test("renders a bottom composer, compact transcript, status line, slash menu, and Esc interrupt", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.columns = 96;
  output.rows = 24;
  let rendered = "";
  output.on("data", (chunk) => { rendered += chunk.toString("utf8"); });
  const client = new FakeControlClient();
  const running = runSessionConsole({
    paths: { controlSocketPath: "/tmp/not-used.sock" },
    ensureDaemon: async () => {},
    createClient: () => client,
    inputStream: input,
    outputStream: output,
    workspacePath: "/workspace",
    listenForSignals: false,
  });
  await new Promise((resolve) => setImmediate(resolve));

  input.emit("keypress", "", { name: "down", ctrl: false, meta: false, shift: false });
  input.emit("keypress", "", { name: "return", ctrl: false, meta: false, shift: false });
  await new Promise((resolve) => setImmediate(resolve));
  const frame = rendered.slice(rendered.lastIndexOf("\x1b[2J"));
  assert.match(frame, /\[ first \]/);
  assert.match(frame, /48;2;44;48;64m/);
  assert.match(frame, /•\x1b\[0m 확인했습니다/);
  const plainLines = frame.replaceAll(/\x1b\[[0-9;? ]*[A-Za-z]/g, "").split("\n");
  const userLine = plainLines.findIndex((line) => line.trimEnd() === "› 세션을 확인해 주세요");
  const agentLine = plainLines.findIndex((line) => line === "• 확인했습니다");
  assert.equal(agentLine, userLine + 2, "사용자 메시지와 다음 에이전트 답변 사이에 빈 줄이 필요하다");
  assert.doesNotMatch(frame, /You:/);
  assert.doesNotMatch(frame, /Codex:/);
  assert.match(frame, /git:main/);
  assert.match(frame, /gpt-test high/);
  assert.match(frame, /tokens 10k\/200k \(5%\)/);
  assert.match(frame, /weekly 60% left/);
  assert.doesNotMatch(frame, /PgUp\/PgDn transcript/);
  assert.equal(frame.split("\n").length, 24);

  output.columns = 20;
  output.rows = 18;
  output.emit("resize");
  const resizedFrame = rendered.slice(rendered.lastIndexOf("\x1b[2J"));
  assert.equal(resizedFrame.split("\n").length, 18);
  assert.ok(
    resizedFrame.split("48;2;44;48;64m").length - 1 >= 2,
    "좁아진 열 너비에 맞춰 사용자 메시지를 다시 줄바꿈해야 한다",
  );
  const plainResizedFrame = resizedFrame.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
  assert.match(plainResizedFrame, /^───────── \[ first \]$/m);
  assert.match(plainResizedFrame, /^───────────────────$/m);
  assert.match(plainResizedFrame, /^› message this Code$/m);
  assert.match(plainResizedFrame, /^  x session$/m);
  output.columns = 96;
  output.rows = 24;
  output.emit("resize");

  input.emit("keypress", "/status", { name: undefined, ctrl: false, meta: false, shift: false });
  input.emit("keypress", "", { name: "return", ctrl: false, meta: false, shift: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.requests.some(({ method }) => method === "session/send"), false);

  input.emit("keypress", "/compact", { name: undefined, ctrl: false, meta: false, shift: false });
  input.emit("keypress", "", { name: "return", ctrl: false, meta: false, shift: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(client.requests.findLast(({ method }) => method === "session/command"), {
    method: "session/command",
    params: { workspacePath: "/workspace", threadId: "thread-1", command: "/compact", argument: "" },
  });

  const commandCount = client.requests.filter(({ method }) => method === "session/command").length;
  input.emit("keypress", "/ide", { name: undefined, ctrl: false, meta: false, shift: false });
  input.emit("keypress", "", { name: "return", ctrl: false, meta: false, shift: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.requests.filter(({ method }) => method === "session/command").length, commandCount);
  const attachFrame = rendered.slice(rendered.lastIndexOf("\x1b[2J"));
  assert.match(attachFrame, /원본 CLI/);

  input.emit("keypress", "/issue-loop continue", { name: undefined, ctrl: false, meta: false, shift: false });
  input.emit("keypress", "", { name: "return", ctrl: false, meta: false, shift: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(client.requests.findLast(({ method }) => method === "session/send"), {
    method: "session/send",
    params: { workspacePath: "/workspace", threadId: "thread-1", text: "/issue-loop continue" },
  });

  const working = client.state("Working");
  working.workspaces[0].sessions[0].workingSince = Date.now() - 3_000;
  working.workspaces[0].sessions[0].activeTurnId = "turn-1";
  working.workspaces[0].sessions[0].tokenUsage = null;
  client.emit("state", working);
  const workingFrame = rendered.slice(rendered.lastIndexOf("\x1b[2J"));
  const plainWorkingFrame = workingFrame.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
  assert.match(plainWorkingFrame, /Working \d+s · Esc interrupt/);
  assert.match(plainWorkingFrame, /tokens ~\d+ visible/);
  assert.ok(
    plainWorkingFrame.indexOf("Working") < plainWorkingFrame.indexOf("[ first ]"),
    "작업 표시는 입력창 윗 구분선보다 위에 있어야 한다",
  );
  input.emit("keypress", "", { name: "escape", ctrl: false, meta: false, shift: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(client.requests.findLast(({ method }) => method === "session/interrupt"), {
    method: "session/interrupt",
    params: { workspacePath: "/workspace", threadId: "thread-1" },
  });

  input.emit("keypress", "", { name: "c", ctrl: true, meta: false, shift: false });
  assert.deepEqual(await running, { exitCode: 0 });
});

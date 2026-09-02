import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { runSessionConsole } from "../src/global-session-console.mjs";

class FakeControlClient extends EventEmitter {
  requests = [];
  closed = false;

  async connect() {}

  session(provider = "codex") {
    return {
      id: `${provider}:thread-1`,
      threadId: provider === "codex" ? "thread-1" : "a1b2c3d4",
      provider,
      name: provider === "codex" ? "Codex 작업" : "Claude 작업",
      cwd: "/workspace",
      status: "Awaiting input",
      lastActivity: "ready",
      updatedAt: 1,
      routable: true,
    };
  }

  state() {
    return {
      revision: 1,
      workspaces: [{ path: "/workspace", name: "workspace", sessions: [this.session()] }],
    };
  }

  async request(method, params) {
    this.requests.push({ method, params });
    if (method === "workspace/register") return this.state();
    return { changed: true };
  }

  close() { this.closed = true; }
}

function terminal() {
  const input = new PassThrough();
  const rawModes = [];
  input.setRawMode = (value) => rawModes.push(value);
  const output = new PassThrough();
  output.columns = 92;
  output.rows = 24;
  let rendered = "";
  output.on("data", (chunk) => { rendered += chunk.toString("utf8"); });
  return { input, output, rawModes, rendered: () => rendered };
}

function key(input, name, text = "", options = {}) {
  input.emit("keypress", text, { name, ctrl: false, meta: false, shift: false, ...options });
}

test("renders only the global session overview and never enables terminal mouse reporting", async () => {
  const tty = terminal();
  const client = new FakeControlClient();
  let ensured;
  const running = runSessionConsole({
    paths: { controlSocketPath: "/tmp/control.sock", socketPath: "/tmp/codex.sock" },
    ensureDaemon: async (options) => { ensured = options; },
    createClient: () => client,
    launchNative: async () => ({ exitCode: 0, signal: null }),
    inputStream: tty.input,
    outputStream: tty.output,
    workspacePath: "/workspace",
    listenForSignals: false,
  });
  await new Promise((resolve) => setImmediate(resolve));
  key(tty.input, "down");

  const frame = tty.rendered().slice(tty.rendered().lastIndexOf("\x1b[2J"));
  assert.match(frame, /Wattari Gattari/);
  assert.match(frame, /Codex 작업/);
  assert.match(frame, /Enter open native TUI/);
  assert.doesNotMatch(frame, /message this|tokens|slash|direct approval/);
  assert.doesNotMatch(tty.rendered(), /\x1b\[\?100[026]h/);
  assert.deepEqual(ensured, { paths: { controlSocketPath: "/tmp/control.sock", socketPath: "/tmp/codex.sock" } });

  key(tty.input, "c", "", { ctrl: true });
  assert.deepEqual(await running, { exitCode: 0 });
  assert.equal(client.closed, true);
});

test("hands the terminal to the selected native TUI and restores the overview afterwards", async () => {
  const tty = terminal();
  const client = new FakeControlClient();
  const launches = [];
  let finishLaunch;
  const running = runSessionConsole({
    paths: { controlSocketPath: "/tmp/control.sock", socketPath: "/tmp/codex.sock" },
    ensureDaemon: async () => {},
    createClient: () => client,
    launchNative: (target) => {
      launches.push(target);
      return new Promise((resolve) => { finishLaunch = resolve; });
    },
    inputStream: tty.input,
    outputStream: tty.output,
    workspacePath: "/workspace",
    listenForSignals: false,
  });
  await new Promise((resolve) => setImmediate(resolve));
  key(tty.input, "down");
  key(tty.input, "return");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(launches, [{ action: "open", session: client.session() }]);
  assert.deepEqual(tty.rawModes.slice(-2), [true, false]);
  const before = tty.rendered();
  key(tty.input, "down");
  assert.equal(tty.rendered(), before, "Waga must not consume input while the provider TUI owns the terminal");

  finishLaunch({ exitCode: 0, signal: null });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(tty.rawModes.at(-1), true);
  assert.equal(client.requests.filter(({ method }) => method === "workspace/register").length, 2);

  key(tty.input, "c", "", { ctrl: true });
  assert.deepEqual(await running, { exitCode: 0 });
});

test("delegates new Codex and Claude sessions to their native TUI", async () => {
  const tty = terminal();
  const client = new FakeControlClient();
  const launches = [];
  const running = runSessionConsole({
    paths: { controlSocketPath: "/tmp/control.sock", socketPath: "/tmp/codex.sock" },
    ensureDaemon: async () => {},
    createClient: () => client,
    launchNative: async (target) => { launches.push(target); return { exitCode: 0, signal: null }; },
    inputStream: tty.input,
    outputStream: tty.output,
    workspacePath: "/workspace",
    listenForSignals: false,
  });
  await new Promise((resolve) => setImmediate(resolve));

  key(tty.input, "n", "n");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.requests.some(({ method }) => method === "session/create"), false);
  assert.deepEqual(launches[0], { action: "new", provider: "codex", cwd: "/workspace" });

  key(tty.input, "tab");
  key(tty.input, "n", "n");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(launches[1], { action: "new", provider: "claude", cwd: "/workspace" });

  key(tty.input, "c", "", { ctrl: true });
  assert.deepEqual(await running, { exitCode: 0 });
});

test("keeps overview metadata controls without implementing a conversation composer", async () => {
  const tty = terminal();
  const client = new FakeControlClient();
  const running = runSessionConsole({
    paths: { controlSocketPath: "/tmp/control.sock", socketPath: "/tmp/codex.sock" },
    ensureDaemon: async () => {},
    createClient: () => client,
    launchNative: async () => ({ exitCode: 0, signal: null }),
    inputStream: tty.input,
    outputStream: tty.output,
    workspacePath: "/workspace",
    listenForSignals: false,
  });
  await new Promise((resolve) => setImmediate(resolve));
  key(tty.input, "down");
  key(tty.input, "f3");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(client.requests.at(-1), {
    method: "session/setCompleted",
    params: { workspacePath: "/workspace", sessionId: "codex:thread-1", completed: true },
  });

  key(tty.input, "f2");
  key(tty.input, undefined, "새 이름");
  key(tty.input, "return");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(client.requests.at(-1), {
    method: "session/rename",
    params: { workspacePath: "/workspace", threadId: "thread-1", name: "새 이름" },
  });

  key(tty.input, "c", "", { ctrl: true });
  assert.deepEqual(await running, { exitCode: 0 });
});

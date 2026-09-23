import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { CodexAppServerClient } from "../src/codex-app-server.mjs";
import { nativeSessionCommand } from "../src/native-launcher.mjs";
import { CodexProvider } from "../src/providers/codex.mjs";

const execFileAsync = promisify(execFile);

// Native proof is opt-in because it needs an installed Codex, a local PTY, and
// credentials for one real turn. All daemon, thread, and workspace state is private.
test("native daemon keeps one thread and applies F4 permissions to later turns", {
  skip: process.env.WAGA_CODEX_NATIVE_PROOF !== "1",
  timeout: 90_000,
}, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "waga-proof-permissions-"));
  const home = path.join(directory, "codex");
  const cwd = path.join(directory, "waga-proof-work");
  fs.mkdirSync(home);
  fs.mkdirSync(cwd);
  const authSource = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "auth.json");
  fs.copyFileSync(authSource, path.join(home, "auth.json"));
  const env = { ...process.env, CODEX_HOME: home, TERM: "xterm-256color" };
  const run = (args) => execFileAsync("codex", args, { env, timeout: 30_000 });
  let started = false;
  let tmuxStarted = false;
  const tmuxSocket = path.join(directory, "tmux.sock");
  const tmux = (args) => execFileAsync("tmux", ["-S", tmuxSocket, ...args], { env, timeout: 10_000 });
  let client;
  try {
    await run(["app-server", "daemon", "start"]);
    started = true;
    const version = JSON.parse((await run(["app-server", "daemon", "version"])).stdout);
    assert.equal(version.appServerVersion, "0.156.0");
    const socketPath = version.socketPath;
    const completed = new Map();
    client = await CodexAppServerClient.connectUnixWebSocket({ socketPath, onNotification({ method, params }) {
      if (method === "turn/completed") completed.get(params.turn.id)?.(params.turn);
    } });
    await client.initialize();
    const { thread } = await client.request("thread/start", { cwd, approvalPolicy: "on-request", sandbox: "read-only" });
    const session = { provider: "codex", nativeId: thread.id, cwd };
    const first = await client.request("turn/start", {
      threadId: thread.id, input: [{ type: "text", text: "Reply OK.", textElements: [] }],
    });
    const firstDone = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("initial native turn did not finish")), 45_000);
      completed.set(first.turn.id, (turn) => { clearTimeout(timer); resolve(turn); });
    });
    assert.equal((await firstDone).status, "completed");
    const restricted = await client.request("thread/resume", { threadId: thread.id, excludeTurns: true });
    assert.equal(restricted.approvalPolicy, "on-request");
    assert.equal(restricted.sandbox.type, "readOnly");

    const provider = new CodexProvider({ run, clientFactory: (socket) => CodexAppServerClient.connectUnixWebSocket({ socketPath: socket }) });
    const yolo = await nativeSessionCommand(session, { codexProvider: provider, codexExecutionMode: "yolo" });
    assert.deepEqual(yolo.args.slice(0, 4), ["resume", thread.id, "--remote", `unix://${socketPath}`]);
    assert.equal(yolo.args.some((arg) => String(arg).includes("approval_policy=") || String(arg).includes("sandbox_mode=")), false);
    const enabled = await client.request("thread/resume", { threadId: thread.id, excludeTurns: true });
    assert.equal(enabled.thread.id, thread.id);
    assert.equal(enabled.approvalPolicy, "never");
    assert.equal(enabled.sandbox.type, "dangerFullAccess");

    const wrapper = path.join(directory, "remote.mjs");
    fs.writeFileSync(wrapper, `import { spawn } from 'node:child_process';\nconst child = spawn('codex', ${JSON.stringify(yolo.args)}, {stdio:'inherit', env:process.env});\nprocess.on('SIGTERM',()=>child.kill('SIGTERM'));\nchild.on('exit',(code)=>process.exit(code ?? 0));\n`);
    await tmux(["new-session", "-d", "-s", "waga-proof", "-x", "100", "-y", "30", `node ${wrapper}`]);
    tmuxStarted = true;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const prompt = (await tmux(["capture-pane", "-p", "-t", "waga-proof"])).stdout;
    if (/Trust this folder\?/.test(prompt)) {
      await tmux(["send-keys", "-t", "waga-proof", "Enter"]);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    const screen = (await tmux(["capture-pane", "-p", "-t", "waga-proof"])).stdout;
    assert.doesNotMatch(screen, /Permission overrides are not supported|Session not found|no rollout found|Error:/);
    assert.match(screen, /permissions: YOLO mode/);
    assert.match(screen, /Reply OK\./, "remote TUI must show the original thread history");
    const marker = path.join(directory, "outside-workspace.txt");
    const later = await client.request("turn/start", {
      threadId: thread.id,
      input: [{ type: "text", text: `Run this shell command exactly: printf YES > ${marker} ; then reply DONE.`, textElements: [] }],
    });
    const laterDone = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("later native turn did not finish")), 45_000);
      completed.set(later.turn.id, (turn) => { clearTimeout(timer); resolve(turn); });
    });
    assert.equal((await laterDone).status, "completed");
    assert.equal(fs.readFileSync(marker, "utf8"), "YES", "later turn must write outside its workspace without sandbox denial");
    const afterRemote = await client.request("thread/resume", { threadId: thread.id, excludeTurns: true });
    assert.equal(afterRemote.approvalPolicy, "never");
    assert.equal(afterRemote.sandbox.type, "dangerFullAccess");

    const restored = await nativeSessionCommand(session, { codexProvider: provider, codexExecutionMode: "default" });
    assert.deepEqual(restored.args.slice(0, 4), yolo.args.slice(0, 4));
    const defaultState = await client.request("thread/resume", { threadId: thread.id, excludeTurns: true });
    assert.equal(defaultState.approvalPolicy, "on-request");
    assert.equal(defaultState.sandbox.type, "workspaceWrite");
  } finally {
    if (tmuxStarted) {
      await tmux(["kill-server"]);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await client?.close();
    if (started) await run(["app-server", "daemon", "stop"]);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

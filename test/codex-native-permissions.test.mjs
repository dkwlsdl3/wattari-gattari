import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { CodexAppServerClient } from "../src/codex-app-server.mjs";
import { nativeSessionCommand } from "../src/native-launcher.mjs";
import { CodexProvider } from "../src/providers/codex.mjs";
import { retainedSessionName, TmuxWorkspace } from "../src/tmux-workspace.mjs";

const execFileAsync = promisify(execFile);

async function until(check, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("native proof condition did not arrive");
}

function rolloutFor(home, threadId) {
  const root = path.join(home, "sessions");
  for (const year of fs.readdirSync(root)) for (const month of fs.readdirSync(path.join(root, year))) {
    for (const day of fs.readdirSync(path.join(root, year, month))) {
      const file = fs.readdirSync(path.join(root, year, month, day)).find((name) => name.endsWith(`${threadId}.jsonl`));
      if (file) return path.join(root, year, month, day, file);
    }
  }
  throw new Error(`native rollout not found for ${threadId}`);
}

function stopTemporaryDaemon(home) {
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    let command;
    try { command = fs.readFileSync(`/proc/${entry}/cmdline`, "utf8").replaceAll("\0", " "); } catch { continue; }
    if (command.startsWith(`${home}/packages/app-server-daemon/`) && command.includes(" pid-update-loop")) {
      process.kill(Number(entry), "SIGTERM");
    }
  }
}

// Opt in: this proof needs installed Codex 0.156.0, tmux, and credentials for two real turns.
test("one F4 after a managed TUI reattach applies verified permissions before the first turn", {
  skip: process.env.WAGA_CODEX_NATIVE_PROOF !== "1",
  timeout: 120_000,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "waga-proof-permissions-"));
  const home = path.join(root, "codex");
  const cwd = path.join(root, "waga-proof-work");
  const socket = path.join(root, "tmux.sock");
  const dock = "waga-proof-dock";
  fs.mkdirSync(home);
  fs.mkdirSync(cwd);
  fs.copyFileSync(path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "auth.json"), path.join(home, "auth.json"));
  fs.writeFileSync(path.join(home, "config.toml"), `default_permissions = ":workspace"\napproval_policy = "on-request"\nsandbox_mode = "workspace-write"\n[projects.${JSON.stringify(cwd)}]\ntrust_level = "trusted"\n`);
  const env = { ...process.env, CODEX_HOME: home, XDG_STATE_HOME: path.join(root, "state"), TERM: "xterm-256color", WAGA_TMUX_MODE: "isolated", WAGA_TMUX_INDEPENDENT: "1", WAGA_TMUX_SESSION: dock };
  const codex = (args) => execFileAsync("codex", args, { env, timeout: 30_000 });
  const tmux = async (args) => {
    try { return { ...await execFileAsync("tmux", ["-S", socket, "-f", "/dev/null", ...args], { env, timeout: 5_000 }), code: 0 }; }
    catch (error) { return { stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? error.message), code: Number.isInteger(error.code) ? error.code : 1 }; }
  };
  let tmuxStarted = false;
  let client;
  let server;
  try {
    await codex(["app-server", "daemon", "start"]);
    const version = JSON.parse((await codex(["app-server", "daemon", "version"])).stdout);
    assert.equal(version.appServerVersion, "0.156.0");
    const completed = new Map();
    client = await CodexAppServerClient.connectUnixWebSocket({ socketPath: version.socketPath, onNotification({ method, params }) {
      if (method === "turn/completed") completed.get(params.turn.id)?.(params.turn);
    } });
    await client.initialize();
    const { thread } = await client.request("thread/start", { cwd, approvalPolicy: "on-request", permissions: ":workspace" });
    const session = { id: `codex:${thread.id}`, provider: "codex", nativeId: thread.id, cwd, name: "waga-proof-permissions" };
    const first = await client.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "Reply OK.", textElements: [] }] });
    const initial = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("initial turn timed out")), 45_000);
      completed.set(first.turn.id, (turn) => { clearTimeout(timer); resolve(turn); });
    });
    assert.equal((await initial).status, "completed");

    await tmux(["new-session", "-d", "-s", dock, "-n", "overview", "-x", "110", "-y", "35", "sleep 120"]);
    tmuxStarted = true;
    const provider = new CodexProvider({ run: codex, clientFactory: (socketPath) => CodexAppServerClient.connectUnixWebSocket({ socketPath }) });
    const workspace = new TmuxWorkspace({ run: tmux, env, eventLog: { record() {} } });
    const defaultCommand = await nativeSessionCommand(session, { codexProvider: provider, codexExecutionMode: "default" });
    const initialView = await workspace.focusOrOpen(session, defaultCommand);
    assert.equal(initialView.reused, false);
    assert.equal((await client.request("thread/resume", { threadId: thread.id, excludeTurns: true })).sandbox.type, "workspaceWrite");
    await tmux(["select-window", "-t", `${dock}:overview`]);

    const yolo = await nativeSessionCommand(session, { codexProvider: provider, codexExecutionMode: "yolo" });
    assert.deepEqual(yolo.args.slice(0, 4), ["resume", thread.id, "--remote", `unix://${version.socketPath}`]);
    assert.equal(yolo.args.some((arg) => /approval_policy=|sandbox_mode=/.test(String(arg))), false);
    const applyAfterAttach = yolo.afterAttach;
    let attachObserved = false;
    yolo.afterAttach = async () => {
      const frame = (await tmux(["capture-pane", "-p", "-t", initialView.windowId])).stdout;
      assert.match(frame, /› Ask Codex/);
      assert.doesNotMatch(frame, /Resuming session/);
      assert.equal((await tmux(["display-message", "-p", "-t", dock, "#{window_name}"])).stdout.trim(), "overview");
      attachObserved = true;
      // Deterministically model the managed profile reassertion observed from the real TUI.
      await client.request("thread/resume", { threadId: thread.id, permissions: ":workspace", excludeTurns: true });
      assert.equal((await client.request("thread/resume", { threadId: thread.id, excludeTurns: true })).sandbox.type, "workspaceWrite");
      await applyAfterAttach();
    };
    const reattached = await workspace.focusOrOpen(session, yolo, { force: true });
    assert.equal(reattached.windowId, initialView.windowId);
    assert.equal(attachObserved, true);
    const afterF4 = await client.request("thread/resume", { threadId: thread.id, excludeTurns: true });
    assert.equal(afterF4.thread.id, thread.id);
    assert.equal(afterF4.sandbox.type, "dangerFullAccess");
    assert.equal(afterF4.approvalPolicy, "never");
    assert.equal(afterF4.activePermissionProfile, null);

    let networkHits = 0;
    server = http.createServer((_request, response) => { networkHits += 1; response.end("NETWORK_OK"); });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const marker = path.join(root, "outside-workspace.txt");
    const url = `http://127.0.0.1:${server.address().port}/proof`;
    const later = await client.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: `Run this shell command exactly: curl --fail --silent ${url} > ${marker} ; then reply DONE.`, textElements: [] }] });
    const laterDone = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("first post-F4 turn timed out")), 45_000);
      completed.set(later.turn.id, (turn) => { clearTimeout(timer); resolve(turn); });
    });
    assert.equal((await laterDone).status, "completed");
    assert.equal(fs.readFileSync(marker, "utf8"), "NETWORK_OK");
    assert.ok(networkHits > 0);
    const rollout = fs.readFileSync(rolloutFor(home, thread.id), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const context = rollout.find((line) => line.type === "turn_context" && line.payload?.turn_id === later.turn.id)?.payload;
    assert.equal(context?.approval_policy, "never");
    assert.equal(context?.sandbox_policy?.type, "danger-full-access");
    assert.equal(context?.permission_profile?.type, "disabled");

    await tmux(["select-window", "-t", `${dock}:overview`]);
    const restore = await nativeSessionCommand(session, { codexProvider: provider, codexExecutionMode: "default" });
    const reused = await workspace.focusOrOpen(session, restore);
    assert.equal(reused.windowId, initialView.windowId);
    const defaultState = await client.request("thread/resume", { threadId: thread.id, excludeTurns: true });
    assert.equal(defaultState.approvalPolicy, "on-request");
    assert.equal(defaultState.sandbox.type, "workspaceWrite");
    assert.equal(defaultState.sandbox.networkAccess, false);
    const defaultTurn = await client.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "Reply DEFAULT.", textElements: [] }] });
    const defaultDone = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("post-restore turn timed out")), 45_000);
      completed.set(defaultTurn.turn.id, (turn) => { clearTimeout(timer); resolve(turn); });
    });
    assert.equal((await defaultDone).status, "completed");
    const restoredRollout = fs.readFileSync(rolloutFor(home, thread.id), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const restoredContext = restoredRollout.find((line) => line.type === "turn_context" && line.payload?.turn_id === defaultTurn.turn.id)?.payload;
    assert.equal(restoredContext?.approval_policy, "on-request");
    assert.equal(restoredContext?.sandbox_policy?.type, "workspace-write");
    assert.equal(restoredContext?.sandbox_policy?.network_access, false);

    await tmux(["select-window", "-t", `${dock}:overview`]);
    await tmux(["kill-session", "-t", retainedSessionName(session.id)]);
    const newView = await workspace.focusOrOpen(session, await nativeSessionCommand(session, { codexProvider: provider, codexExecutionMode: "yolo" }));
    assert.equal(newView.reused, false);
    assert.equal((await client.request("thread/resume", { threadId: thread.id, excludeTurns: true })).sandbox.type, "dangerFullAccess");
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (tmuxStarted) await tmux(["kill-server"]);
    await client?.close();
    stopTemporaryDaemon(home);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

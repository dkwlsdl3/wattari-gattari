import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { TmuxWorkspace, shellCommand } from "../src/tmux-workspace.mjs";
import { defaultEventLogPath } from "../src/event-log.mjs";

const execFileAsync = promisify(execFile);
const commandTimeoutMs = 5_000;
const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore", timeout: commandTimeoutMs, killSignal: "SIGKILL" }).status === 0;

async function waitFor(check, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`condition was not met within ${timeoutMs}ms`);
}

test("real isolated tmux reuses, revives, and removes one retained session view", { skip: !hasTmux, timeout: 30_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "waga-proof-tmux-"));
  const env = { ...process.env, XDG_STATE_HOME: path.join(root, "state") };
  const socketPath = path.join(root, "tmux.sock");
  const sessionName = "waga-proof-integration";
  const prefix = ["-S", socketPath, "-f", "/dev/null"];
  const call = async (args, { check = true } = {}) => {
    try {
      const result = await execFileAsync("tmux", [...prefix, ...args], {
        encoding: "utf8", env, timeout: commandTimeoutMs, killSignal: "SIGKILL", signal: t.signal,
      });
      return { ...result, code: 0 };
    } catch (error) {
      if (error.killed || error.name === "AbortError") throw error;
      const result = {
        stdout: String(error.stdout ?? ""),
        stderr: String(error.stderr ?? error.message ?? ""),
        code: Number.isInteger(error.code) ? error.code : 1,
      };
      if (check) throw error;
      return result;
    }
  };
  t.after(() => {
    spawnSync("tmux", [...prefix, "kill-server"], { stdio: "ignore", env, timeout: commandTimeoutMs, killSignal: "SIGKILL" });
    fs.rmSync(root, { recursive: true, force: true });
  });

  await call([
    "new-session", "-d", "-s", sessionName, "-n", "overview", "-c", root,
    shellCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"]),
  ]);

  const workspace = new TmuxWorkspace({
    run: (args) => call(args, { check: false }),
    env: { WAGA_TMUX_MODE: "isolated", WAGA_TMUX_SESSION: sessionName },
    eventLog: { record() {} },
  });
  const session = {
    id: "codex:waga-proof-session",
    nativeId: "01a07a2e-c4ce-75c1-9fb4-02192b587721",
    provider: "codex",
    name: "integration proof",
    cwd: root,
  };
  const command = (marker) => ({
    command: process.execPath,
    args: ["-e", `process.stdout.write('\x1b]0;${session.nativeId.slice(0, 29)}...\x07'); console.log(${JSON.stringify(marker)}); setInterval(() => {}, 1000)`],
    cwd: root,
  });

  const opened = await workspace.focusOrOpen(session, command("WAGA_PROOF_READY_ONE"));
  assert.equal(opened.reused, false);
  await waitFor(async () => (await call(["capture-pane", "-p", "-t", opened.windowId])).stdout.includes("WAGA_PROOF_READY_ONE"));
  const events = fs.readFileSync(defaultEventLogPath(env), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(events.some((event) => event.event === "native_session_started" && event.sessionId === session.id));

  const reused = await workspace.focusOrOpen(session, command("MUST_NOT_RESTART"));
  assert.deepEqual(reused, { reused: true, windowId: opened.windowId });
  assert.equal((await call(["list-windows", "-t", sessionName, "-F", "#{@waga_session_id}"])).stdout
    .split("\n").filter((id) => id === session.id).length, 1);

  await call(["set-window-option", "-t", opened.windowId, "remain-on-exit", "on"]);
  await call(["send-keys", "-t", opened.windowId, "C-c"]);
  await waitFor(async () => (await call(["display-message", "-p", "-t", opened.windowId, "#{pane_dead}"])).stdout.trim() === "1");

  const revived = await workspace.focusOrOpen(session, command("WAGA_PROOF_READY_TWO"));
  assert.deepEqual(revived, { reused: true, windowId: opened.windowId });
  await waitFor(async () => (await call(["capture-pane", "-p", "-t", opened.windowId])).stdout.includes("WAGA_PROOF_READY_TWO"));

  assert.deepEqual(await workspace.closeSessionView(session), { closed: true, windowId: opened.windowId });
  assert.equal((await call(["list-windows", "-t", sessionName, "-F", "#{window_name}"])).stdout.trim(), "overview");

  // Disposable native-lookalike: Claude 2.1.263 relaunches its attach process as
  // agents on Left, then that frontend can display a different session on Right.
  const agentsCode = `process.stdin.setRawMode(true); process.stdin.resume(); console.log('WAGA_PROOF_AGENTS');
    process.stdin.on('data', () => console.log('WAGA_PROOF_SESSION_TWO'));`;
  const attachCode = `process.stdin.setRawMode(true); process.stdin.resume(); console.log('WAGA_PROOF_SESSION_ONE');
    process.stdin.once('data', async () => {
      const args = ['-e', ${JSON.stringify(agentsCode)}];
      if (process.execve) process.execve(process.execPath, [process.execPath, ...args], process.env);
      else { process.stdin.pause(); const {spawn} = await import('node:child_process'); spawn(process.execPath, args, {stdio:'inherit'}).on('exit', code => process.exit(code ?? 1)); }
    });`;
  const claudeSession = { ...session, provider: "claude", id: "claude:waga-proof-navigation" };
  const claudeCommand = { command: process.execPath, args: ["-e", attachCode], cwd: root };
  const view = await workspace.focusOrOpen(claudeSession, claudeCommand);
  const frame = async () => (await call(["capture-pane", "-p", "-t", view.windowId])).stdout;
  await waitFor(async () => (await frame()).includes("WAGA_PROOF_SESSION_ONE"));
  const panePid = async () => (await call(["display-message", "-p", "-t", view.windowId, "#{pane_pid}"])).stdout.trim();
  const originalPid = await panePid();
  await workspace.focusOrOpen(claudeSession, claudeCommand);
  assert.equal(await panePid(), originalPid, "unchanged native view must not restart");

  await call(["send-keys", "-t", view.windowId, "Left"]);
  await waitFor(async () => (await frame()).includes("WAGA_PROOF_AGENTS"));
  await call(["send-keys", "-t", view.windowId, "Right"]);
  await waitFor(async () => (await frame()).includes("WAGA_PROOF_SESSION_TWO"));
  await call(["select-window", "-t", `${sessionName}:overview`]);
  await workspace.focusOrOpen(claudeSession, claudeCommand);
  assert.notEqual(await panePid(), originalPid, "native navigation must invalidate the old frontend");
  await waitFor(async () => (await frame()).includes("WAGA_PROOF_SESSION_ONE") && !(await frame()).includes("WAGA_PROOF_SESSION_TWO"));
  const repairedPid = await panePid();
  await workspace.focusOrOpen(claudeSession, claudeCommand);
  assert.equal(await panePid(), repairedPid, "repaired view must return to the fast reuse path");
  await workspace.closeSessionView(claudeSession);

  // Codex 0.153.2 switches threads in the same frontend, keeping its argv.
  // /agents keeps the old OSC title; opening another thread replaces that title.
  const otherId = "01a07a2e-cabf-7fe0-84f7-f4557a6be9a4";
  const codexCode = `process.stdin.setRawMode(true); process.stdin.resume();
    const title = id => process.stdout.write('\\x1b]0;' + id.slice(0,29) + '...\\x07');
    title(${JSON.stringify(session.nativeId)});
    console.log('WAGA_PROOF_CODEX_ONE');
    process.stdin.on('data', input => {
      process.stdout.write('\\x1b[2J\\x1b[H');
      if(input.toString() === 'a') console.log('  Agent command center\\n  0 need input   0 working   2 ready');
      else if(input.toString() === 'c') console.log('\\n\\n\\nWAGA_PROOF_BLANK_TOP');
      else {title(${JSON.stringify(otherId)}); console.log('WAGA_PROOF_CODEX_TWO');}
    });`;
  const codexCommand = { command: process.execPath, args: ["-e", codexCode], cwd: root };
  const codexView = await workspace.focusOrOpen(session, codexCommand);
  const codexFrame = async () => (await call(["capture-pane", "-p", "-t", codexView.windowId])).stdout;
  const codexPid = async () => (await call(["display-message", "-p", "-t", codexView.windowId, "#{pane_pid}"])).stdout.trim();
  await waitFor(async () => (await codexFrame()).includes("WAGA_PROOF_CODEX_ONE"));
  let retainedPid = await codexPid();
  await workspace.focusOrOpen(session, codexCommand);
  assert.equal(await codexPid(), retainedPid, "Codex unchanged view must be reused");
  await call(["send-keys", "-t", codexView.windowId, "c"]);
  await waitFor(async () => (await codexFrame()).includes("WAGA_PROOF_BLANK_TOP"));
  assert.equal((await call(["capture-pane", "-p", "-t", codexView.windowId, "-S", "0", "-E", "1"])).stdout, "\n\n");
  await call(["select-window", "-t", `${sessionName}:overview`]);
  await workspace.focusOrOpen(session, codexCommand);
  assert.equal(await codexPid(), retainedPid, "blank top rows must not respawn the same native thread");
  assert.ok((await codexFrame()).includes("WAGA_PROOF_BLANK_TOP"), "retain the actual native frame");
  for (const openOther of [false, true]) {
    await call(["send-keys", "-t", codexView.windowId, "a"]);
    await waitFor(async () => (await codexFrame()).includes("Agent command center"));
    if (openOther) {
      await call(["send-keys", "-t", codexView.windowId, "b"]);
      await waitFor(async () => (await codexFrame()).includes("WAGA_PROOF_CODEX_TWO"));
    }
    assert.equal(await codexPid(), retainedPid, "native navigation does not change Codex PID");
    await call(["select-window", "-t", `${sessionName}:overview`]);
    await workspace.focusOrOpen(session, codexCommand);
    assert.notEqual(await codexPid(), retainedPid, "Codex navigation must invalidate the retained frontend");
    await waitFor(async () => (await codexFrame()).includes("WAGA_PROOF_CODEX_ONE"));
    retainedPid = await codexPid();
    await workspace.focusOrOpen(session, codexCommand);
    assert.equal(await codexPid(), retainedPid, "repaired Codex view must be reused");
  }
  await workspace.closeSessionView(session);

  assert.deepEqual(await workspace.leave(), { closeOverview: true });
  assert.notEqual((await call(["has-session", "-t", sessionName], { check: false })).code, 0);
});

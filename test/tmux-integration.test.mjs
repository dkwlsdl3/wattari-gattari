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

test("real tmux dock previews follow key selection and disappear on terminal resize", { skip: !hasTmux, timeout: 15_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "waga-proof-preview-tmux-"));
  const prefix = ["-S", path.join(root, "tmux.sock"), "-f", "/dev/null"];
  const call = async (...args) => (await execFileAsync("tmux", [...prefix, ...args], { encoding: "utf8", timeout: commandTimeoutMs, signal: t.signal })).stdout;
  t.after(() => {
    spawnSync("tmux", [...prefix, "kill-server"], { stdio: "ignore", timeout: commandTimeoutMs });
    fs.rmSync(root, { recursive: true, force: true });
  });
  const code = `
    import {runOverview} from ${JSON.stringify(new URL("../src/overview.mjs", import.meta.url).href)};
    const sessions = ['codex', 'claude'].map(provider => ({id: provider + ':proof', provider, name: 'waga-proof-' + provider, cwd: ${JSON.stringify(root)}, status: 'working'}));
    await runOverview({ defaultCwd: ${JSON.stringify(root)}, workspace: {}, bridge: {
      discover: async () => ({sessions, warnings: []}),
      preview: async session => ({input: session.provider + '-INPUT 한글', output: session.provider + '-OUTPUT 완료'})
    }});
  `;
  await call("new-session", "-d", "-s", "waga-proof-preview", "-x", "160", "-y", "35", "-c", root,
    shellCommand(process.execPath, ["--input-type=module", "-e", code]));
  const frame = () => call("capture-pane", "-p", "-t", "waga-proof-preview");
  await waitFor(async () => (await frame()).includes("WATTARI GATTARI"));
  await call("send-keys", "-t", "waga-proof-preview", "Down");
  const codex = await waitFor(async () => { const text = await frame(); return text.includes("codex-OUTPUT 완료") && text; });
  assert.ok(codex.includes("codex-INPUT 한글"));
  assert.ok(codex.includes("Alt+Q"));
  await call("send-keys", "-t", "waga-proof-preview", "Down");
  const claude = await waitFor(async () => { const text = await frame(); return text.includes("claude-OUTPUT 완료") && text; });
  assert.ok(!claude.includes("codex-OUTPUT"));
  await call("resize-window", "-t", "waga-proof-preview", "-x", "100", "-y", "35");
  await waitFor(async () => !(await frame()).includes("마지막 입력"));
  const narrow = await frame();
  assert.ok(narrow.includes("waga-proof-claude"));
  assert.ok(narrow.includes("Alt+Q"));
});

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

test("real tmux independent docks share frontends while selection, resize and exit remain separate", { skip: !hasTmux, timeout: 20_000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "waga-proof-independent-"));
  const prefix = ["-S", path.join(root, "tmux.sock"), "-f", "/dev/null"];
  const call = async args => {
    try {
      const result = await execFileAsync("tmux", [...prefix, ...args], { encoding: "utf8", timeout: commandTimeoutMs, signal: t.signal });
      return { code: 0, ...result };
    } catch (error) {
      if (error.killed || error.name === "AbortError") throw error;
      return { code: Number.isInteger(error.code) ? error.code : 1, stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? error.message) };
    }
  };
  const checked = async args => { const result = await call(args); assert.equal(result.code, 0, result.stderr); return result.stdout.trim(); };
  t.after(() => {
    spawnSync("tmux", [...prefix, "kill-server"], { stdio: "ignore", timeout: commandTimeoutMs });
    fs.rmSync(root, { recursive: true, force: true });
  });
  const idle = shellCommand(process.execPath, ["-e", "console.log('waga-proof-overview'); setInterval(() => {}, 1000)"]);
  for (const name of ["waga-proof-left", "waga-proof-right"]) {
    await checked(["new-session", "-d", "-s", name, "-n", "overview", "-c", root, idle]);
  }
  const workspace = name => new TmuxWorkspace({
    run: call, env: { WAGA_TMUX_SESSION: name, WAGA_TMUX_INDEPENDENT: "1" },
    eventLog: { record() {} }, claudeViewMatches: async () => true,
  });
  const left = workspace("waga-proof-left");
  const right = workspace("waga-proof-right");
  const agent = { id: "claude:waga-proof-independent", provider: "claude", name: "waga-proof-shared" };
  const command = { command: process.execPath, args: ["-e", "console.log('waga-proof-native'); setInterval(() => {}, 1000)"], cwd: root };
  const results = await Promise.all([left.focusOrOpen(agent, command), right.focusOrOpen(agent, command)]);
  assert.equal(results[0].windowId, results[1].windowId);
  const windowId = results[0].windowId;
  const panePid = await checked(["display-message", "-p", "-t", windowId, "#{pane_pid}"]);
  await checked(["select-window", "-t", "waga-proof-left:overview"]);
  assert.equal(await checked(["display-message", "-p", "-t", "waga-proof-right", "#{window_id}"]), windowId);
  const second = await left.focusOrOpen({ ...agent, id: "claude:waga-proof-other" }, command);
  assert.notEqual(second.windowId, windowId);
  assert.equal(await checked(["display-message", "-p", "-t", "waga-proof-right", "#{window_id}"]), windowId);
  await checked(["resize-window", "-t", "waga-proof-left:overview", "-x", "100", "-y", "25"]);
  await checked(["resize-window", "-t", "waga-proof-right:overview", "-x", "160", "-y", "40"]);
  assert.equal(await checked(["display-message", "-p", "-t", "waga-proof-left:overview", "#{window_width},#{window_height}"]), "100,25");
  assert.equal(await checked(["display-message", "-p", "-t", "waga-proof-right:overview", "#{window_width},#{window_height}"]), "160,40");
  await left.leave();
  assert.equal((await call(["has-session", "-t", "waga-proof-left"])).code, 1);
  assert.equal(await checked(["display-message", "-p", "-t", "waga-proof-right", "#{window_id}"]), windowId);
  assert.equal(await checked(["display-message", "-p", "-t", windowId, "#{pane_pid}"]), panePid);
  await right.leave();
  assert.equal(await checked(["display-message", "-p", "-t", windowId, "#{pane_pid}"]), panePid);
});

test("Codex selection waits for post-attach permission checks on new, forced, dead, and reused views", { skip: !hasTmux, timeout: 30_000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "waga-proof-attach-gate-"));
  const prefix = ["-S", path.join(root, "tmux.sock"), "-f", "/dev/null"];
  const env = { ...process.env, XDG_STATE_HOME: path.join(root, "state"), WAGA_TMUX_SESSION: "waga-proof-gate", WAGA_TMUX_INDEPENDENT: "1" };
  const call = async args => {
    try { return { ...await execFileAsync("tmux", [...prefix, ...args], { env, timeout: commandTimeoutMs }), code: 0 }; }
    catch (error) { return { stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? error.message), code: Number.isInteger(error.code) ? error.code : 1 }; }
  };
  t.after(() => {
    spawnSync("tmux", [...prefix, "kill-server"], { stdio: "ignore", env, timeout: commandTimeoutMs });
    fs.rmSync(root, { recursive: true, force: true });
  });
  await call(["new-session", "-d", "-s", env.WAGA_TMUX_SESSION, "-n", "overview", "-x", "100", "-y", "30", "sleep 60"]);
  const workspace = new TmuxWorkspace({ run: call, env, eventLog: { record() {} } });
  const session = { id: "codex:waga-proof-gate", nativeId: "01a07a2e-c4ce-75c1-9fb4-02192b587721", provider: "codex", name: "waga-proof-gate", cwd: root };
  const code = `process.stdout.write('\\x1b]0;${session.nativeId.slice(0, 29)}...\\x07'); console.log('ready\\n›'); setInterval(() => {}, 1000)`;
  const selected = async () => (await call(["display-message", "-p", "-t", env.WAGA_TMUX_SESSION, "#{window_name}"])).stdout.trim();
  let checks = 0;
  const command = () => ({ command: process.execPath, args: ["-e", code], cwd: root, async afterAttach() { checks += 1; assert.equal(await selected(), "overview"); } });
  const opened = await workspace.focusOrOpen(session, command());
  assert.equal(opened.reused, false);
  await call(["select-window", "-t", `${env.WAGA_TMUX_SESSION}:overview`]);
  const reused = await workspace.focusOrOpen(session, command());
  assert.equal(reused.windowId, opened.windowId);
  await call(["select-window", "-t", `${env.WAGA_TMUX_SESSION}:overview`]);
  await workspace.focusOrOpen(session, command(), { force: true });
  await call(["set-window-option", "-t", opened.windowId, "remain-on-exit", "on"]);
  await call(["select-window", "-t", `${env.WAGA_TMUX_SESSION}:overview`]);
  await call(["send-keys", "-t", opened.windowId, "C-c"]);
  await waitFor(async () => (await call(["display-message", "-p", "-t", opened.windowId, "#{pane_dead}"])).stdout.trim() === "1");
  await workspace.focusOrOpen(session, command());
  assert.equal(checks, 4);
  await call(["select-window", "-t", `${env.WAGA_TMUX_SESSION}:overview`]);
  await assert.rejects(workspace.focusOrOpen(session, { ...command(), async afterAttach() { throw new Error("permission mismatch"); } }), /permission mismatch/);
  assert.equal(await selected(), "overview");
});

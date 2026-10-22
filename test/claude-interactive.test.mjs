import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import * as pty from "node-pty";
import { ClaudeInteractive, interactiveRetainedName } from "../src/providers/claude-interactive.mjs";
import { ClaudeProvider } from "../src/providers/claude.mjs";
import { nativeSessionCommand } from "../src/native-launcher.mjs";
import { TmuxWorkspace } from "../src/tmux-workspace.mjs";

const exec = promisify(execFile);
const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore", timeout: 5000 }).status === 0;
async function eventually(check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("Disposable Claude did not become ready");
}

test("real tmux keeps the original interactive CLI across F4, lost discovery and dock closure", { skip: !hasTmux, timeout: 15_000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "waga-proof-interactive-"));
  const prefix = ["-S", path.join(root, "tmux.sock"), "-f", "/dev/null"];
  const env = { ...process.env, TMUX: "", PATH: `${root}:${process.env.PATH}`, XDG_STATE_HOME: path.join(root, "state"), CLAUDE_CONFIG_DIR: path.join(root, "config") };
  const recordPath = path.join(root, "invocation.json");
  // Real host + real tmux; the provider executable is a controllable stand-in.
  fs.writeFileSync(path.join(root, "claude"), `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({pid:process.pid, args:process.argv.slice(2), launch:process.env.WAGA_CLAUDE_LAUNCH}));
process.stdin.resume();
process.stdin.on('data', chunk => { if (String(chunk).trim() === '/exit') process.exit(0); });
`, { mode: 0o700 });
  const call = async args => ({ ...await exec("tmux", [...prefix, ...args], { env, encoding: "utf8", timeout: 5000 }), code: 0 });
  t.after(() => {
    spawnSync("tmux", [...prefix, "kill-server"], { stdio: "ignore", timeout: 5000 });
    fs.rmSync(root, { recursive: true, force: true });
  });
  const interactive = new ClaudeInteractive({ env: { ...env, TMUX: "test-server" }, run: args => call(args) });
  const provider = new ClaudeProvider({ homeDirectory: root, interactive, titleSync: { settings: () => '{"hooks":{}}', display: () => null },
    run: async args => { assert.equal(args[0], "agents", "interactive creation must not run --bg"); return { stdout: "[]" }; } });
  const prompt = "한글 ' \" ; $(touch injected) `touch injected2`\nsecond line";
  const created = await provider.create(prompt, { cwd: root, model: "sonnet", effort: "high", executionSettings: { permissionMode: "acceptEdits" } });
  const recorded = await eventually(() => fs.existsSync(recordPath) && JSON.parse(fs.readFileSync(recordPath)));
  assert.equal(created.kind, "interactive");
  assert.equal(recorded.args[recorded.args.indexOf("--session-id") + 1], created.sessionId);
  assert.equal(recorded.args[recorded.args.indexOf("--model") + 1], "sonnet");
  assert.equal(recorded.args[recorded.args.indexOf("--effort") + 1], "high");
  assert.equal(recorded.args[recorded.args.indexOf("--permission-mode") + 1], "acceptEdits");
  assert.equal(recorded.args.at(-1), prompt);
  assert.equal(recorded.launch, undefined, "launch prompt must not remain in Claude's environment");
  assert.equal(fs.existsSync(path.join(root, "injected")), false);
  assert.equal(fs.existsSync(path.join(root, "injected2")), false);
  const session = { ...created, id: `claude:${created.sessionId}`, pid: recorded.pid, cwd: root };
  const [pending] = await provider.list({ cwd: root });
  assert.equal(pending.id, session.id, "startup prompts must be accessible before native enumeration");
  assert.equal(pending.pid, recorded.pid);
  assert.equal(pending.status, "needs-input");
  assert.deepEqual(await provider.list({ cwd: path.join(root, "other-project") }), []);
  const spec = await nativeSessionCommand(session, { claudeInteractive: interactive });
  assert.equal(spec.reuseOnly, true);
  const retained = interactiveRetainedName(session.id);
  const before = (await call(["list-panes", "-t", retained, "-F", "#{pane_id}\t#{pane_pid}"])).stdout;
  await call(["new-session", "-d", "-s", "waga-proof-dock", "-n", "overview", "-c", root, "sleep", "60"]);
  const workspace = new TmuxWorkspace({ env: { TMUX: "test-server", WAGA_TMUX_SESSION: "waga-proof-dock", WAGA_TMUX_INDEPENDENT: "1" },
    run: async args => { try { return await call(args); } catch (error) { return { code: 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" }; } },
    eventLog: { record() {} } });
  assert.equal((await workspace.focusOrOpen(session, spec)).reused, true);
  assert.equal((await workspace.focusOrOpen(session, spec, { force: true })).reused, true);
  const terminal = pty.spawn("tmux", [...prefix, "attach-session", "-t", "waga-proof-dock"], {
    name: "xterm-256color", cols: 120, rows: 40, cwd: root, env,
  });
  terminal.onData(() => {});
  const terminalExited = new Promise(resolve => terminal.onExit(resolve));
  t.after(() => { try { terminal.kill(); } catch {} });
  await eventually(async () => (await call(["display-message", "-p", "-t", "waga-proof-dock", "#{session_attached}"])).stdout.trim() === "1");
  terminal.kill("SIGHUP");
  await terminalExited;
  await interactive.verify(session);
  assert.deepEqual(await workspace.reconcileSessionViews([], { availableProviders: ["claude"] }), { closed: [] });
  await workspace.leave();
  assert.equal((await call(["list-panes", "-t", retained, "-F", "#{pane_id}\t#{pane_pid}"])).stdout, before);
  await interactive.verify(session);
  assert.doesNotThrow(() => process.kill(recorded.pid, 0));
  await assert.rejects(provider.archive({ ...session, pid: process.pid }), { code: "CLAUDE_INTERACTIVE_UNAVAILABLE" });
  assert.doesNotThrow(() => process.kill(recorded.pid, 0));
  // A different native PID or an ended process must never trigger a replacement.
  await assert.rejects(interactive.verify({ ...session, pid: process.pid }), { code: "CLAUDE_INTERACTIVE_UNAVAILABLE" });
  const registry = path.join(env.CLAUDE_CONFIG_DIR, "sessions");
  fs.mkdirSync(registry, { recursive: true });
  fs.writeFileSync(path.join(registry, `${session.pid}.json`), JSON.stringify({ pid: session.pid, sessionId: "a-different-session" }));
  await assert.rejects(interactive.verify(session), { code: "CLAUDE_INTERACTIVE_UNAVAILABLE" });
  await assert.rejects(provider.archive(session), { code: "CLAUDE_INTERACTIVE_UNAVAILABLE" });
  assert.doesNotThrow(() => process.kill(recorded.pid, 0));
  assert.deepEqual(await provider.list({ cwd: root }), [], "native navigation cannot leave an old UUID pointing at a different session");
  fs.rmSync(path.join(registry, `${session.pid}.json`));
  // Old sessions used remain-on-exit on. Closing one must remove every link,
  // without ending the overview process in either independent view.
  const siblings = [];
  for (const name of ["waga-proof-first", "waga-proof-second"]) {
    await call(["new-session", "-d", "-s", name, "-n", "overview", "-c", root, "sleep", "60"]);
    siblings.push(Number((await call(["display-message", "-p", "-t", name, "#{pane_pid}"])).stdout.trim()));
    await call(["link-window", "-s", retained, "-t", `${name}:`]);
  }
  await call(["set-window-option", "-t", retained, "remain-on-exit", "on"]);
  assert.deepEqual(await provider.archive(session), { target: session.id, archived: true });
  await eventually(() => { try { process.kill(recorded.pid, 0); return false; } catch (error) { return error.code === "ESRCH"; } });
  assert.equal((await call(["list-panes", "-a", "-F", "#{@waga_session_id}"])).stdout.includes(session.id), false);
  for (const pid of siblings) assert.doesNotThrow(() => process.kill(pid, 0));
  await assert.rejects(interactive.verify(session), { code: "CLAUDE_INTERACTIVE_UNAVAILABLE" });
  assert.deepEqual(await provider.list({ cwd: root }), []);

  const normal = await provider.create("normal exit", { cwd: root });
  const normalSession = await eventually(async () => (await provider.list({ cwd: root })).find(row => row.sessionId === normal.sessionId));
  const normalRetained = interactiveRetainedName(normalSession.id);
  await call(["link-window", "-s", normalRetained, "-t", "waga-proof-first:"]);
  await call(["send-keys", "-t", normalRetained, "-l", "/exit"]);
  await call(["send-keys", "-t", normalRetained, "Enter"]);
  await eventually(async () => !(await call(["list-panes", "-a", "-F", "#{@waga_session_id}"])).stdout.includes(normalSession.id));
  assert.throws(() => process.kill(normalSession.pid, 0), { code: "ESRCH" });
  for (const pid of siblings) assert.doesNotThrow(() => process.kill(pid, 0));
});

test("external interactive CLI cannot be attached or duplicated by Waga", async () => {
  const interactive = new ClaudeInteractive({ run: async () => { throw new Error("retained pane does not exist"); } });
  const provider = new ClaudeProvider({ interactive });
  await assert.rejects(provider.archive({ provider: "claude", kind: "interactive", id: "claude:external", pid: process.pid }), { code: "CLAUDE_INTERACTIVE_UNAVAILABLE" });
  await assert.rejects(nativeSessionCommand({ provider: "claude", kind: "interactive", id: "claude:external",
    nativeId: "external", cwd: "/tmp/waga-proof-external", pid: process.pid }, { claudeInteractive: interactive }), { code: "CLAUDE_INTERACTIVE_UNAVAILABLE" });
});

test("an uncertain tmux creation preserves identity and does not retry", async () => {
  let attempts = 0;
  const interactive = new ClaudeInteractive({ run: async () => { attempts++; throw Object.assign(new Error("timeout"), { killed: true }); } });
  await assert.rejects(interactive.create(["--", "proof"], "/tmp/waga-proof-timeout", "proof-uuid"), { code: "CLAUDE_CREATION_UNCONFIRMED", nativeId: "proof-uuid" });
  assert.equal(attempts, 1);
  const missing = new ClaudeInteractive({ run: async () => { throw Object.assign(new Error("missing tmux"), { code: "ENOENT" }); } });
  await assert.rejects(missing.create([], "/tmp/waga-proof-missing"), { code: "ENOENT" });
});

import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { sharedNativeTerminal } from "../src/web-native-terminal.mjs";
import { retainedSessionName, shellCommand } from "../src/tmux-workspace.mjs";
import { nativeQuestion } from "../src/web/native-question.mjs";

const exec = promisify(execFile);
const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
async function until(check) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error("Expected shared native screen did not arrive");
}
async function fixture(t, provider = "claude") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "waga-proof-web-shared-"));
  const socketName = `waga-proof-web-${path.basename(root)}`;
  const call = async (...args) => (await exec("tmux", ["-L", socketName, ...args], { encoding: "utf8", timeout: 3000 })).stdout;
  t.after(async () => { await call("kill-server").catch(() => {}); await fs.rm(root, { recursive: true, force: true }); });
  const target = `${provider}:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`;
  // A real raw-mode child reproduces a native frontend; no model or user session.
  const code = `process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write('\\x1b]0;aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\\x07');process.stdout.write('❯ waga-proof-ready\\r\\n');process.stdin.on('data',d=>{require('node:fs').appendFileSync(${JSON.stringify(path.join(root, "input"))},d);process.stdout.write('INPUT:'+JSON.stringify(d.toString())+'\\r\\n')});`;
  const spec = { command: process.execPath, args: ["-e", code], cwd: root };
  return { root, target, spec, call, socketName, retained: retainedSessionName(target),
    open: options => sharedNativeTerminal(spec, { target, socketName, interval: 30, ...options }),
    input: () => fs.readFile(path.join(root, "input"), "utf8").catch(() => "") };
}

test("observing an unopened session creates neither a tmux server nor a provider frontend", { skip: !hasTmux }, async t => {
  const f = await fixture(t);
  assert.equal(await f.open({ observe: true }), null);
  await assert.rejects(f.call("has-session", "-t", f.retained));
});

for (const provider of ["claude", "codex"]) test(`${provider}: web shares one frontend, cannot resize it, and disconnect leaves it running`, { skip: !hasTmux }, async t => {
  const f = await fixture(t, provider);
  // Exact same native-session-host arrangement as the dock, at a local TUI size.
  const host = new URL("../src/native-session-host.mjs", import.meta.url).pathname;
  await f.call("new-session", "-d", "-s", f.retained, "-x", "190", "-y", "47", "-c", f.root,
    shellCommand(process.execPath, [host, provider, f.target, "--", f.spec.command, ...f.spec.args]),
    ";", "set-window-option", "-t", f.retained, "@waga_session_id", f.target);
  await until(async () => (await f.call("capture-pane", "-p", "-t", f.retained)).includes("waga-proof-ready"));
  const before = await f.call("display-message", "-p", "-t", f.retained, "#{pane_pid}\t#{pane_width}\t#{pane_height}");
  const terminal = await f.open({ observe: true }); t.after(() => terminal.kill());
  let output = "", size;
  terminal.onData(data => { output = data; }); terminal.onSize(value => { size = value; });
  await until(() => output.includes("waga-proof-ready"));
  assert.deepEqual(size, { cols: 190, rows: 47 });
  terminal.resize(80, 24);
  assert.equal(await f.call("display-message", "-p", "-t", f.retained, "#{pane_pid}\t#{pane_width}\t#{pane_height}"), before);
  await terminal.write("한글 후속 지시\r");
  await until(async () => (await f.input()).includes("한글 후속 지시\r"));
  // A second browser observation still reads that same pane; never another attach.
  const second = await f.open({ observe: true }); second.kill(); terminal.kill();
  assert.equal(await f.call("display-message", "-p", "-t", f.retained, "#{pane_pid}\t#{pane_width}\t#{pane_height}"), before);
  assert.equal((await f.call("list-panes", "-a", "-F", "#{pane_pid}")).trim().split("\n").length, 1);
});

test("shared controls reject changed identity and stale approval before writing anything", { skip: !hasTmux }, async t => {
  const f = await fixture(t);
  const terminal = await f.open(); t.after(() => terminal.kill());
  await until(async () => (await f.call("capture-pane", "-p", "-t", f.retained)).includes("waga-proof-ready"));
  await assert.rejects(terminal.write("1\r", { question: "stale question" }), /질문이 변경/);
  assert.equal(await f.input(), "");
  await f.call("set-window-option", "-t", f.retained, "@waga_session_id", "claude:another");
  await assert.rejects(terminal.write("wrong target\r"), /변경/);
  assert.equal(await f.input(), "");
});

test("web approval uses the current native question, and a dead pane is never respawned", { skip: !hasTmux }, async t => {
  const f = await fixture(t);
  f.spec.args = ["-e", `process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write('❯ Do you want to proceed?\\r\\n  1. Yes\\r\\n  2. No\\r\\n');process.stdin.on('data',d=>require('node:fs').appendFileSync(${JSON.stringify(path.join(f.root, "input"))},d));`];
  const terminal = await f.open(); t.after(() => terminal.kill());
  let screen = ""; terminal.onData(value => { screen = value; });
  await until(() => screen.includes("2. No"));
  const frame = await f.call("capture-pane", "-p", "-t", f.retained);
  const question = nativeQuestion(frame.split("\n"), "claude");
  assert.ok(question);
  await terminal.write("2\r", { question: question.signature });
  await until(async () => await f.input() === "2\r");
  await f.call("set-window-option", "-t", f.retained, "remain-on-exit", "on");
  await f.call("send-keys", "-t", f.retained, "C-c");
  // The raw-mode child does not handle Ctrl-C, so end only this proof pane process.
  const child = (await f.call("display-message", "-p", "-t", f.retained, "#{pane_pid}")).trim();
  process.kill(Number(child), "SIGTERM");
  await until(async () => (await f.call("display-message", "-p", "-t", f.retained, "#{pane_dead}")).trim() === "1");
  await assert.rejects(f.open(), /변경/);
});

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.mjs";

function output() { let value = ""; return { write(chunk) { value += chunk; }, get value() { return value; } }; }

test("help explains that cwd filtering is optional for the global dock", async () => {
  const stdout = output();
  assert.equal(await runCli(["--help"], { stdout, stderr: output(), bridge: {} }), 0);
  assert.match(stdout.value, /waga \[--cwd PATH\] \[--backend auto\|direct\|tmux\]/);
  assert.match(stdout.value, /global dock/);
});

test("list renders provider-prefixed ids", async () => {
  const stdout = output();
  const bridge = { async discover() { return { sessions: [{ id: "claude:1", status: "idle", name: "proof", cwd: "/tmp" }], warnings: [] }; } };
  assert.equal(await runCli([], { stdout, stderr: output(), bridge }), 0);
  assert.match(stdout.value, /^claude:1\tidle\tproof\t\/tmp/);
});

test("bare CLI opens the dock on an interactive terminal", async () => {
  const stdout = output();
  stdout.isTTY = true;
  const stdin = { isTTY: true };
  let seen;
  const dock = async (options) => { seen = options; return { code: 4 }; };
  const orderStore = {};
  assert.equal(await runCli([], { stdin, stdout, stderr: output(), bridge: {}, dock, orderStore }), 4);
  assert.equal(seen.cwd, path.resolve(process.cwd()));
  assert.equal(seen.filterCwd, null);
  assert.equal(seen.backend, "auto");
  assert.equal(seen.orderStore, orderStore);
});

test("interactive CLI filters the dock only when cwd is explicit", async () => {
  const stdout = output();
  stdout.isTTY = true;
  const stdin = { isTTY: true };
  let seen;
  const dock = async (options) => { seen = options; return { code: 0 }; };
  assert.equal(await runCli(["--cwd", "/tmp", "--backend", "direct"], { stdin, stdout, stderr: output(), bridge: {}, dock }), 0);
  assert.equal(seen.cwd, path.resolve("/tmp"));
  assert.equal(seen.filterCwd, path.resolve("/tmp"));
  assert.equal(seen.backend, "direct");
});

test("bare CLI keeps the text list when output is not interactive", async () => {
  const stdout = output();
  const bridge = { async discover() { return { sessions: [], warnings: [] }; } };
  assert.equal(await runCli([], { stdin: { isTTY: false }, stdout, stderr: output(), bridge }), 0);
  assert.equal(stdout.value, "");
});

test("internal overview delegates to the dashboard", async () => {
  const stdin = { isTTY: true };
  const stdout = output();
  stdout.isTTY = true;
  let seen;
  const overview = async (options) => { seen = options; return 6; };
  const orderStore = {};
  assert.equal(await runCli(["overview", "--cwd", "/tmp"], {
    stdin, stdout, stderr: output(), bridge: {}, overview, orderStore,
  }), 6);
  assert.equal(seen.filterCwd, path.resolve("/tmp"));
  assert.equal(seen.orderStore, orderStore);
});

test("internal overview discovers all projects without an explicit cwd", async () => {
  const stdin = { isTTY: true };
  const stdout = output();
  stdout.isTTY = true;
  let seen;
  const overview = async (options) => { seen = options; return 0; };
  assert.equal(await runCli(["overview"], { stdin, stdout, stderr: output(), bridge: {}, overview }), 0);
  assert.equal(seen.filterCwd, null);
  assert.equal(seen.defaultCwd, path.resolve(process.cwd()));
});

test("text list keeps provider warnings off stdout", async () => {
  const stdout = output();
  const stderr = output();
  const bridge = { async discover() { return { sessions: [{ id: "codex:1", status: "idle", name: "ok", cwd: "/tmp" }], warnings: [{ provider: "claude", message: "offline" }] }; } };
  assert.equal(await runCli([], { stdout, stderr, bridge }), 0);
  assert.doesNotMatch(stdout.value, /warning/);
  assert.match(stderr.value, /warning\tclaude\toffline/);
});

test("ask prints exactly the peer reply", async () => {
  const stdout = output();
  const stderr = output();
  const bridge = { async ask(target, message, options) {
    assert.equal(target, "codex:x");
    assert.equal(message, "ping");
    assert.equal(options.waitTimeoutMs, 1000);
    assert.equal(options.replyTimeoutMs, 1000);
    options.onProgress({ state: "waiting", target: "codex:x" });
    options.onProgress({ state: "submitted", target: "codex:x" });
    return { reply: "PONG" };
  } };
  assert.equal(await runCli(["ask", "codex:x", "ping", "--timeout", "1"], { stdout, stderr, bridge }), 0);
  assert.equal(stdout.value, "PONG\n");
  assert.match(stderr.value, /status\twaiting\tcodex:x/);
  assert.match(stderr.value, /status\tsubmitted\tcodex:x/);
});

test("open delegates to the native Agents command", async () => {
  let seen;
  const code = await runCli(["open", "codex"], { stdout: output(), stderr: output(), bridge: {}, launcher: async (provider, options) => { seen = [provider, options.cwd]; return { code: 7 }; } });
  assert.equal(code, 7);
  assert.deepEqual(seen, ["codex", path.resolve(process.cwd())]);
});

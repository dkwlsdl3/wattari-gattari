import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.mjs";

function output() { let value = ""; return { write(chunk) { value += chunk; }, get value() { return value; } }; }

test("list renders provider-prefixed ids", async () => {
  const stdout = output();
  const bridge = { async discover() { return { sessions: [{ id: "claude:1", status: "idle", name: "proof", cwd: "/tmp" }], warnings: [] }; } };
  assert.equal(await runCli([], { stdout, stderr: output(), bridge }), 0);
  assert.match(stdout.value, /^claude:1\tidle\tproof\t\/tmp/);
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
  const bridge = { async ask(target, message, options) { assert.equal(target, "codex:x"); assert.equal(message, "ping"); assert.equal(options.timeoutMs, 1000); return { reply: "PONG" }; } };
  assert.equal(await runCli(["ask", "codex:x", "ping", "--timeout", "1"], { stdout, stderr: output(), bridge }), 0);
  assert.equal(stdout.value, "PONG\n");
});

test("open delegates to the native Agents command", async () => {
  let seen;
  const code = await runCli(["open", "codex"], { stdout: output(), stderr: output(), bridge: {}, launcher: async (provider, options) => { seen = [provider, options.cwd]; return { code: 7 }; } });
  assert.equal(code, 7);
  assert.deepEqual(seen, ["codex", path.resolve(process.cwd())]);
});

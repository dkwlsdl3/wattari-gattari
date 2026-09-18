import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { codexResumeConfigOverrides, nativeAgentsCommand, nativeSessionCommand, openNativeAgents } from "../src/native-launcher.mjs";

test("native launcher delegates to provider-owned Agents TUIs", async () => {
  const calls = [];
  const launch = async (...args) => { calls.push(args); return { code: 0 }; };
  await openNativeAgents("claude", { cwd: "/tmp", launch });
  await openNativeAgents("codex", { cwd: "/tmp", launch });
  assert.deepEqual(calls[0].slice(0, 2), ["claude", ["agents", "--cwd", path.resolve("/tmp")]]);
  assert.deepEqual(calls[1].slice(0, 2), ["codex", ["agents", "-C", path.resolve("/tmp")]]);
});

test("native Agents commands are reusable by retained tmux views", () => {
  assert.deepEqual(nativeAgentsCommand("claude", { cwd: "/tmp" }), {
    command: "claude", args: ["agents", "--cwd", path.resolve("/tmp")], cwd: path.resolve("/tmp"),
  });
  assert.deepEqual(nativeAgentsCommand("codex", { cwd: "/work" }), {
    command: "codex", args: ["agents", "-C", path.resolve("/work")], cwd: path.resolve("/work"),
  });
});

test("native session commands attach exact provider sessions", async () => {
  const claude = await nativeSessionCommand({ provider: "claude", nativeId: "abc12345", cwd: "/tmp" });
  assert.deepEqual(claude, { command: "claude", args: ["attach", "abc12345"], cwd: path.resolve("/tmp") });

  const codexProvider = {
    async daemonInfo(options) {
      assert.deepEqual(options, { start: true });
      return { status: "running", socketPath: "/tmp/codex.sock" };
    },
  };
  const codex = await nativeSessionCommand({ provider: "codex", nativeId: "thread-1", cwd: "/work" }, { codexProvider });
  assert.deepEqual(codex, {
    command: "codex",
    args: ["resume", "thread-1", "--remote", "unix:///tmp/codex.sock", "-C", path.resolve("/work"),
      "-c", 'tui.terminal_title=["thread-id"]'],
    cwd: path.resolve("/work"),
  });
});

test("a resumed Codex view carries the configured approval and sandbox policy", async () => {
  // 2026-09-18: the frontend is spawned without a shell, so an interactive alias never
  // reaches it, and a thread created earlier keeps its original policy.
  const codexProvider = { async daemonInfo() { return { status: "running", socketPath: "/tmp/codex.sock" }; } };
  const session = { provider: "codex", nativeId: "thread-1", cwd: "/work" };

  const yolo = await nativeSessionCommand(session, {
    codexProvider, executionSettings: { approvalPolicy: "never", sandbox: "danger-full-access" },
  });
  assert.deepEqual(yolo.args.slice(-4), [
    "-c", 'approval_policy="never"', "-c", 'sandbox_mode="danger-full-access"',
  ]);

  const plain = await nativeSessionCommand(session, { codexProvider });
  assert.equal(plain.args.at(-1), 'tui.terminal_title=["thread-id"]');
});

test("only scalar Codex policies become config overrides", () => {
  assert.deepEqual(codexResumeConfigOverrides(null), []);
  assert.deepEqual(codexResumeConfigOverrides({ approvalPolicy: "default", sandbox: "default" }), []);
  // `granular` is a table in config.toml, so it stays with the thread instead of guessing a scalar.
  assert.deepEqual(codexResumeConfigOverrides({ approvalPolicy: "granular", sandbox: "read-only" }), [
    "-c", 'sandbox_mode="read-only"',
  ]);
  assert.deepEqual(codexResumeConfigOverrides({ approvalPolicy: "on-request" }), [
    "-c", 'approval_policy="on-request"',
  ]);
});

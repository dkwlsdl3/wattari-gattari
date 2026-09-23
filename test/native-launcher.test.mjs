import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { nativeAgentsCommand, nativeSessionCommand, openNativeAgents } from "../src/native-launcher.mjs";

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
    async daemonInfo() { return { status: "running", socketPath: "/tmp/codex.sock" }; },
    async prepareNativeSession(session, mode, { socketPath }) {
      assert.equal(session.nativeId, "thread-1");
      assert.equal(mode, "default");
      assert.equal(socketPath, "/tmp/codex.sock");
    },
  };
  const codex = await nativeSessionCommand({ provider: "codex", nativeId: "thread-1", cwd: "/work" }, { codexProvider });
  assert.deepEqual({ ...codex, afterAttach: undefined }, {
    command: "codex",
    args: ["resume", "thread-1", "--remote", "unix:///tmp/codex.sock", "-C", path.resolve("/work"),
      "-c", 'tui.terminal_title=["thread-id"]'],
    cwd: path.resolve("/work"),
    afterAttach: undefined,
  });
  await codex.afterAttach();
});

test("a resumed Codex view carries no CLI permission overrides", async () => {
  // 2026-09-22, codex 0.155.1: `codex resume --remote` exits 1 with
  // "Permission overrides are not supported when resuming a remote task."
  // as soon as -c approval_policy or -c sandbox_mode is present, so passing the
  // dock's execution settings here breaks attaching outright.
  const codexProvider = { async daemonInfo() { return { status: "running", socketPath: "/tmp/codex.sock" }; } };
  const spec = await nativeSessionCommand({ provider: "codex", nativeId: "thread-1", cwd: "/work" }, { codexProvider });
  assert.deepEqual(spec.args.filter((arg) => /^(approval_policy|sandbox_mode)=/.test(String(arg))), []);
});

test("YOLO selection prepares the owning thread only after remote attach", async () => {
  const modes = [];
  const codexProvider = {
    async daemonInfo() { return { status: "running", socketPath: "/tmp/codex.sock" }; },
    async prepareNativeSession(session, mode, { socketPath }) { modes.push([session.nativeId, mode, socketPath]); },
  };
  const spec = await nativeSessionCommand(
    { provider: "codex", nativeId: "thread-1", cwd: "/work" },
    { codexProvider, codexExecutionMode: "yolo" },
  );
  assert.deepEqual(spec.args.slice(0, 4), ["resume", "thread-1", "--remote", "unix:///tmp/codex.sock"]);
  assert.deepEqual(modes, []);
  await spec.afterAttach();
  assert.deepEqual(modes, [["thread-1", "yolo", "/tmp/codex.sock"]]);
  assert.equal(spec.args.includes("--dangerously-bypass-approvals-and-sandbox"), false);
});

test("failed post-attach permission synchronization blocks F4 selection", async () => {
  const codexProvider = {
    async daemonInfo() { return { status: "running", socketPath: "/tmp/codex.sock" }; },
    async prepareNativeSession() { throw new Error("thread/settings/update unsupported"); },
  };
  const command = await nativeSessionCommand({ provider: "codex", nativeId: "thread-1", cwd: "/work" }, { codexProvider, codexExecutionMode: "yolo" });
  await assert.rejects(command.afterAttach(), /unsupported/);
});

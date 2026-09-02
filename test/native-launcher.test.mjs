import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { nativeSessionCommand, openNativeAgents } from "../src/native-launcher.mjs";

test("native launcher delegates to provider-owned Agents TUIs", async () => {
  const calls = [];
  const launch = async (...args) => { calls.push(args); return { code: 0 }; };
  await openNativeAgents("claude", { cwd: "/tmp", launch });
  await openNativeAgents("codex", { cwd: "/tmp", launch });
  assert.deepEqual(calls[0].slice(0, 2), ["claude", ["agents", "--cwd", path.resolve("/tmp")]]);
  assert.deepEqual(calls[1].slice(0, 2), ["codex", ["agents", "-C", path.resolve("/tmp")]]);
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
    args: ["resume", "thread-1", "--remote", "unix:///tmp/codex.sock", "-C", path.resolve("/work")],
    cwd: path.resolve("/work"),
  });
});

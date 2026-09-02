import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { NativeSessionLauncher } from "../src/native-session-launcher.mjs";
import { MANAGED_DEVELOPER_INSTRUCTIONS } from "../src/peer-protocol.mjs";

function fixture() {
  const calls = [];
  const spawnProcess = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit", 0, null));
    return child;
  };
  return {
    calls,
    launcher: new NativeSessionLauncher({
      codexSocketPath: "/run/user/1001/wattari-gattari/codex-app-server.sock",
      claudePluginPath: "/opt/waga/integrations/claude-peer",
      spawnProcess,
      env: { TERM: "xterm-256color" },
    }),
  };
}

test("opens an existing Codex thread in the native remote TUI", async () => {
  const { calls, launcher } = fixture();
  assert.deepEqual(await launcher.launch({
    action: "open",
    session: { provider: "codex", threadId: "thread-1", cwd: "/workspace" },
  }), { exitCode: 0, signal: null });
  assert.deepEqual(calls, [{
    command: "codex",
    args: [
      "--remote",
      "unix:///run/user/1001/wattari-gattari/codex-app-server.sock",
      "-C",
      "/workspace",
      "resume",
      "thread-1",
    ],
    options: { cwd: "/workspace", env: { TERM: "xterm-256color" }, stdio: "inherit" },
  }]);
});

test("lets native Codex create a persistent thread with the peer protocol", async () => {
  const { calls, launcher } = fixture();
  await launcher.launch({ action: "new", provider: "codex", cwd: "/workspace" });
  assert.deepEqual(calls.map(({ command, args }) => ({ command, args })), [{
    command: "codex",
    args: [
      "--remote",
      "unix:///run/user/1001/wattari-gattari/codex-app-server.sock",
      "-C",
      "/workspace",
      "-c",
      `developer_instructions=${JSON.stringify(MANAGED_DEVELOPER_INSTRUCTIONS)}`,
    ],
  }]);
});

test("opens Claude background sessions and delegates new sessions to Agents View", async () => {
  const { calls, launcher } = fixture();
  await launcher.launch({
    action: "open",
    session: { provider: "claude", threadId: "a1b2c3d4", cwd: "/workspace" },
  });
  await launcher.launch({ action: "new", provider: "claude", cwd: "/workspace" });
  assert.deepEqual(calls.map(({ command, args, options }) => ({ command, args, cwd: options.cwd })), [
    { command: "claude", args: ["attach", "a1b2c3d4"], cwd: "/workspace" },
    {
      command: "claude",
      args: [
        "agents",
        "--cwd",
        "/workspace",
        "--plugin-dir",
        "/opt/waga/integrations/claude-peer",
        "--agent",
        "waga-session",
      ],
      cwd: "/workspace",
    },
  ]);
});

test("rejects unsupported or incomplete launch targets before spawning", async () => {
  const { calls, launcher } = fixture();
  await assert.rejects(
    launcher.launch({ action: "open", session: { provider: "codex", cwd: "/workspace" } }),
    { code: "NATIVE_SESSION_INVALID" },
  );
  assert.equal(calls.length, 0);
});

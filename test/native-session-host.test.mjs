import assert from "node:assert/strict";
import test from "node:test";

import { runNativeSessionHost } from "../src/native-session-host.mjs";

test("native session host records the provider process lifecycle", async () => {
  const events = [];
  let launched;
  const code = await runNativeSessionHost(
    ["codex", "codex:thread-1", "--", "codex", "resume", "thread-1"],
    {
      cwd: "/work",
      processId: 77,
      eventLog: { record(event, details) { events.push([event, details]); } },
      launch: async (command, args, options) => {
        launched = { command, args, options };
        return { code: 7, signal: null };
      },
    },
  );

  assert.equal(code, 7);
  assert.equal(launched.command, "codex");
  assert.deepEqual(launched.args, ["resume", "thread-1"]);
  assert.equal(launched.options.cwd, "/work");
  assert.equal(typeof launched.options.onSignal, "function");
  launched.options.onSignal("SIGHUP");
  assert.deepEqual(events, [
    ["native_session_started", { provider: "codex", sessionId: "codex:thread-1", hostPid: 77, command: "codex" }],
    ["native_session_exited", { provider: "codex", sessionId: "codex:thread-1", hostPid: 77, code: 7, signal: null }],
    ["native_session_host_signal", { provider: "codex", sessionId: "codex:thread-1", hostPid: 77, signal: "SIGHUP" }],
  ]);
});

test("native session host records launch failures", async () => {
  const events = [];
  await assert.rejects(runNativeSessionHost(
    ["claude", "claude:agent-1", "--", "claude", "attach", "agent-1"],
    {
      eventLog: { record(event, details) { events.push([event, details]); } },
      launch: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    },
  ), { code: "ENOENT" });
  assert.equal(events.at(-1)[0], "native_session_launch_failed");
  assert.deepEqual(events.at(-1)[1], {
    provider: "claude",
    sessionId: "claude:agent-1",
    hostPid: process.pid,
    code: "ENOENT",
    message: "missing",
  });
});

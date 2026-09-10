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

test("Codex cannot probe terminal colours until its pane has a visible client", async () => {
  const { waitForVisibleTerminal } = await import("../src/native-session-host.mjs");
  const counts = ["0\n", "0\n", "1\n"];
  let queries = 0;
  let launched = false;
  await runNativeSessionHost(["codex", "codex:proof", "--", "fake"], {
    eventLog: { record() {} },
    waitForTerminal: () => waitForVisibleTerminal({ pane: "%7", query: async () => {
      assert.equal(launched, false);
      queries++;
      return counts.shift();
    }, wait: async () => {} }),
    launch: async () => { launched = true; assert.equal(queries, 3); return { code: 0 }; },
  });
  assert.equal(launched, true);
});

test("failed terminal visibility never starts the native process", async () => {
  const { waitForVisibleTerminal } = await import("../src/native-session-host.mjs");
  await assert.rejects(runNativeSessionHost(["codex", "codex:proof", "--", "fake"], {
    eventLog: { record() {} },
    waitForTerminal: () => waitForVisibleTerminal({ pane: "%7", query: async () => "0\n", attempts: 2, wait: async () => {} }),
    launch: async () => assert.fail("must not start without a terminal"),
  }), { code: "TMUX_VIEW_TIMEOUT" });
  await assert.rejects(waitForVisibleTerminal({ pane: "%7", query: async () => "invalid" }), /Invalid tmux/);
});

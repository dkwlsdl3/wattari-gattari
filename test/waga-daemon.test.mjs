import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startWagaDaemon } from "../src/waga-daemon.mjs";

function fixture(t, { failBroker = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "waga-lifecycle-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true }));
  const calls = [];
  const host = new EventEmitter();
  host.start = async () => { calls.push("host:start"); };
  host.close = async () => { calls.push("host:close"); };
  const broker = {
    start: async () => { calls.push("broker:start"); if (failBroker) throw new Error("broker failed"); },
    close: async () => { calls.push("broker:close"); },
  };
  const control = {
    start: async () => { calls.push("control:start"); },
    close: async () => { calls.push("control:close"); },
  };
  return {
    calls,
    paths: {
      stateDirectory: path.join(directory, "state"),
      daemonPidPath: path.join(directory, "run", "daemon.pid"),
    },
    createRuntime: async () => ({
      host,
      broker,
      control,
      stopCodex: async () => { calls.push("codex:stop"); },
    }),
  };
}

test("owns daemon startup and reverse-order cleanup behind one interface", async (t) => {
  const setup = fixture(t);
  const daemon = await startWagaDaemon(setup);
  assert.deepEqual(setup.calls, ["host:start", "broker:start", "control:start"]);
  assert.deepEqual(await daemon.close(0), { exitCode: 0 });
  assert.deepEqual(await daemon.close(9), { exitCode: 0 });
  assert.deepEqual(setup.calls, [
    "host:start", "broker:start", "control:start",
    "control:close", "broker:close", "host:close", "codex:stop",
  ]);
});

test("cleans up a partial daemon start", async (t) => {
  const setup = fixture(t, { failBroker: true });
  await assert.rejects(startWagaDaemon(setup), /broker failed/);
  assert.deepEqual(setup.calls, [
    "host:start", "broker:start",
    "control:close", "broker:close", "host:close", "codex:stop",
  ]);
});

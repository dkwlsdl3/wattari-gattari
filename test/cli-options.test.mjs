import assert from "node:assert/strict";
import test from "node:test";

import { parseCliArgs } from "../src/cli-options.mjs";

test("parses the global TUI, diagnostics, stop, version, and cwd forms", () => {
  assert.deepEqual(parseCliArgs([]), { command: "tui", cwd: null });
  assert.deepEqual(parseCliArgs(["--cwd", "/workspace"]), { command: "tui", cwd: "/workspace" });
  assert.deepEqual(parseCliArgs(["doctor"]), { command: "doctor", cwd: null });
  assert.deepEqual(parseCliArgs(["stop"]), { command: "stop", cwd: null });
  assert.deepEqual(parseCliArgs(["agents"]), { command: "agents", cwd: null });
  assert.deepEqual(parseCliArgs(["ask", "claude:abc", "check", "this"]), {
    command: "ask", cwd: null, target: "claude:abc", task: "check this",
  });
  assert.throws(() => parseCliArgs(["ask", "missing-task"]), { code: "INVALID_ARGUMENT" });
  assert.deepEqual(parseCliArgs(["--version"]), { command: "version", cwd: null });
  assert.throws(() => parseCliArgs(["unknown"]), { code: "INVALID_ARGUMENT" });
});

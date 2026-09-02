import assert from "node:assert/strict";
import test from "node:test";

import { parseCliArgs } from "../src/cli-options.mjs";

test("bare CLI lists sessions and agents remains an alias", () => {
  assert.equal(parseCliArgs([]).command, "list");
  assert.equal(parseCliArgs(["agents"]).command, "list");
});

test("ask parses target, message, timeout, and cwd", () => {
  assert.deepEqual(parseCliArgs(["ask", "codex:x", "hello", "there", "--timeout", "1.5", "--cwd", "/tmp"]), {
    command: "ask", cwd: "/tmp", provider: null, timeoutMs: 1500, json: false, target: "codex:x", message: "hello there",
  });
});

test("open accepts only native providers", () => {
  assert.equal(parseCliArgs(["open", "claude"]).provider, "claude");
  assert.throws(() => parseCliArgs(["open", "other"]), { code: "INVALID_ARGUMENT" });
});

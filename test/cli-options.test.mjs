import assert from "node:assert/strict";
import test from "node:test";

import { parseCliArgs } from "../src/cli-options.mjs";

test("bare CLI selects the interactive default and agents remains a list alias", () => {
  assert.equal(parseCliArgs([]).command, "default");
  assert.equal(parseCliArgs(["agents"]).command, "list");
  assert.equal(parseCliArgs(["list"]).command, "list");
  assert.equal(parseCliArgs(["--json"]).command, "list");
  assert.equal(parseCliArgs(["--provider", "claude"]).command, "list");
  assert.equal(parseCliArgs(["overview", "--cwd", "/tmp"]).command, "overview");
});

test("interactive dock backend is explicit and validated", () => {
  assert.equal(parseCliArgs([]).backend, "auto");
  assert.equal(parseCliArgs(["--backend", "direct"]).backend, "direct");
  assert.equal(parseCliArgs(["--backend", "tmux"]).backend, "tmux");
  assert.throws(() => parseCliArgs(["--backend", "other"]), { code: "INVALID_ARGUMENT" });
  assert.throws(() => parseCliArgs(["list", "--backend", "direct"]), { code: "INVALID_ARGUMENT" });
});

test("ask parses target, message, timeout, and cwd", () => {
  assert.deepEqual(parseCliArgs(["ask", "codex:x", "hello", "there", "--timeout", "1.5", "--cwd", "/tmp"]), {
    command: "ask", cwd: "/tmp", provider: null, backend: "auto", waitTimeoutMs: 1500, replyTimeoutMs: 1500, json: false, target: "codex:x", message: "hello there",
  });
});

test("ask keeps busy-wait and reply timeouts independent", () => {
  const options = parseCliArgs(["ask", "claude:x", "review", "--wait-timeout", "600", "--reply-timeout", "90"]);
  assert.equal(options.waitTimeoutMs, 600_000);
  assert.equal(options.replyTimeoutMs, 90_000);
  assert.throws(() => parseCliArgs(["ask", "claude:x", "review", "--wait-timeout", "no"]), { code: "INVALID_ARGUMENT" });
});

test("open accepts only native providers", () => {
  assert.equal(parseCliArgs(["open", "claude"]).provider, "claude");
  assert.throws(() => parseCliArgs(["open", "other"]), { code: "INVALID_ARGUMENT" });
});

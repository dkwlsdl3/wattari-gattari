import assert from "node:assert/strict";
import test from "node:test";

import { retainedClaudeViewMatches } from "../src/providers/claude-view.mjs";

// Shape measured from Linux /proc for Claude Code 2.1.263's attach frontend.
// Native Left relaunches `claude agents`; the original tmux mapping survives.
const command = { command: "claude", args: ["attach", "12345678"] };
function fixture(overrides = {}) {
  const files = {
    "/proc/100/task/100/children": "200 ",
    "/proc/200/cmdline": ["claude", "attach", "12345678", ""].join("\0"),
    "/proc/200/task/200/children": "",
    ...overrides,
  };
  return { readProc: async (file) => {
    if (!(file in files)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return files[file];
  } };
}

test("retained Claude view matches only the original leaf attach command", async () => {
  assert.equal(await retainedClaudeViewMatches("100", command, fixture()), true);
  assert.equal(await retainedClaudeViewMatches("100", command, fixture({
    "/proc/200/cmdline": "/home/proof/bin/claude\0attach\0" + "12345678\0",
  })), true);
});

test("native Agents View and a different attached session invalidate the retained view", async () => {
  for (const argv of [["claude", "agents"], ["claude", "attach", "87654321"], ["other", "attach", "12345678"]]) {
    assert.equal(await retainedClaudeViewMatches("100", command, fixture({
      "/proc/200/cmdline": argv.join("\0") + "\0",
    })), false);
  }
});

test("unknown, truncated or ambiguous process identity cannot justify reuse", async () => {
  for (const overrides of [
    { "/proc/100/task/100/children": "" },
    { "/proc/100/task/100/children": "200 201 " },
    { "/proc/100/task/100/children": "../200" },
    { "/proc/200/cmdline": "claude\0attach\0" + "12345678" },
    { "/proc/200/task/200/children": "300 " }, // Relaunch fallback retains its parent.
  ]) assert.equal(await retainedClaudeViewMatches("100", command, fixture(overrides)), false);
  assert.equal(await retainedClaudeViewMatches("100", command, { readProc: async () => { throw new Error("unreadable"); } }), false);
  assert.equal(await retainedClaudeViewMatches("../100", command, { readProc: async () => { throw new Error("must not read"); } }), false);
});

test("a frontend replaced during inspection cannot justify reuse", async () => {
  const original = fixture();
  let reads = 0;
  assert.equal(await retainedClaudeViewMatches("100", command, { readProc: (file) => {
    if (file === "/proc/100/task/100/children" && ++reads === 2) return "201 ";
    return original.readProc(file);
  } }), false);
});

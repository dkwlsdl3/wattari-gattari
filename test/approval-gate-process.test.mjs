import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const gatePath = fileURLToPath(new URL("../src/approval-gate.mjs", import.meta.url));

function runGate(command) {
  return spawnSync(process.execPath, [gatePath], {
    encoding: "utf8",
    env: { ...process.env, WAGA_APPROVAL_SOCKET: "" },
    input: JSON.stringify({
      session_id: "session",
      turn_id: "turn",
      tool_use_id: "tool",
      cwd: "/workspace",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command },
    }),
  });
}

test("approval gate executable allows routine commands without output", () => {
  const result = runGate("npm test");
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("approval gate executable denies risky commands without a foreground screen", () => {
  const result = runGate("find . -name '*.tmp' -delete");
  assert.equal(result.status, 0);
  const response = JSON.parse(result.stdout);
  assert.equal(response.hookSpecificOutput.permissionDecision, "deny");
  assert.match(response.hookSpecificOutput.permissionDecisionReason, /승인 소켓/);
});

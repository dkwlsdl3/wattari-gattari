import assert from "node:assert/strict";
import test from "node:test";

import { classifyApprovalRequest } from "../src/approval-policy.mjs";

function bash(command) {
  return { tool_name: "Bash", tool_input: { command } };
}

test("allows routine investigation, tests, and apply_patch updates", () => {
  assert.equal(classifyApprovalRequest(bash("rg -n TODO .")), null);
  assert.equal(classifyApprovalRequest(bash("npm test")), null);
  assert.equal(classifyApprovalRequest({
    tool_name: "apply_patch",
    tool_input: { command: "*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n*** End Patch" },
  }), null);
});

test("requires direct approval for destructive or external shell actions", () => {
  for (const command of [
    "rm -rf build/output",
    "  /usr/bin/rm -f stale.tmp",
    "find . -name '*.tmp' -delete",
    "python -c \"import os; os.remove('target')\"",
    "bash -c 'rm -f target'",
    "xargs rm -f < stale-files.txt",
    "git push origin main",
    "git reset --hard HEAD~1",
    "sudo systemctl restart demo-api",
    "docker compose down",
    "curl -X DELETE https://example.invalid/resource",
    "kubectl delete pod demo-api-0",
    "npm publish",
  ]) {
    assert.ok(classifyApprovalRequest(bash(command)), command);
  }
});

test("does not mistake documentation text for a destructive command", () => {
  assert.equal(classifyApprovalRequest(bash("echo rm is documented here")), null);
  assert.equal(classifyApprovalRequest(bash("rg -n 'git push' docs")), null);
});

test("requires direct approval for file deletion, process input, and permission widening", () => {
  assert.equal(classifyApprovalRequest({
    tool_name: "apply_patch",
    tool_input: { command: "*** Begin Patch\n*** Delete File: secret.txt\n*** End Patch" },
  })?.kind, "file-delete");
  assert.equal(classifyApprovalRequest({ tool_name: "write_stdin", tool_input: { chars: "y\n" } })?.kind, "process-input");
  assert.equal(classifyApprovalRequest({ tool_name: "request_permissions", tool_input: {} })?.kind, "permission");
});

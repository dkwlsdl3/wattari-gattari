import assert from "node:assert/strict";
import test from "node:test";

import { DirectApprovalLedger } from "../src/direct-approval-ledger.mjs";

const HOOK_APPROVAL = {
  session_id: "11111111-1111-7111-8111-111111111111",
  turn_id: "22222222-2222-7222-8222-222222222222",
  tool_use_id: "tool-3333",
  cwd: "/workspace",
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "rm -f disposable.txt" },
};

function commandRequest(overrides = {}) {
  return {
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: HOOK_APPROVAL.session_id,
      turnId: HOOK_APPROVAL.turn_id,
      itemId: HOOK_APPROVAL.tool_use_id,
      kind: "command",
      command: HOOK_APPROVAL.tool_input.command,
      cwd: HOOK_APPROVAL.cwd,
      ...overrides,
    },
  };
}

test("accepts exactly one matching App Server request after direct hook approval", () => {
  const ledger = new DirectApprovalLedger({ now: () => 1_000 });
  assert.equal(ledger.authorizeHook(HOOK_APPROVAL), true);

  assert.deepEqual(ledger.consumeServerRequest(commandRequest()), { decision: "accept" });
  assert.equal(ledger.consumeServerRequest(commandRequest()), undefined);
});

test("declines mismatched identity or command", () => {
  for (const request of [
    commandRequest({ threadId: "other-thread" }),
    commandRequest({ turnId: "other-turn" }),
    commandRequest({ itemId: "other-item" }),
    commandRequest({ command: "rm -f other.txt" }),
  ]) {
    const ledger = new DirectApprovalLedger({ now: () => 1_000 });
    assert.equal(ledger.authorizeHook(HOOK_APPROVAL), true);
    assert.equal(ledger.consumeServerRequest(request), undefined);
  }
});

test("burns a grant when the same item changes its approved command", () => {
  const ledger = new DirectApprovalLedger({ now: () => 1_000 });
  assert.equal(ledger.authorizeHook(HOOK_APPROVAL), true);

  assert.equal(ledger.consumeServerRequest(commandRequest({ command: "rm -f other.txt" })), undefined);
  assert.equal(ledger.consumeServerRequest(commandRequest()), undefined);
});

test("does not create a grant for permission widening that cannot be correlated safely", () => {
  const ledger = new DirectApprovalLedger({ now: () => 1_000 });
  assert.equal(ledger.authorizeHook({
    ...HOOK_APPROVAL,
    tool_name: "request_permissions",
    tool_input: { permissions: ["network"] },
  }), false);
});

test("expires a direct approval instead of accepting it later", () => {
  let now = 1_000;
  const ledger = new DirectApprovalLedger({ ttlMs: 5_000, now: () => now });
  assert.equal(ledger.authorizeHook(HOOK_APPROVAL), true);
  now = 6_001;

  assert.equal(ledger.consumeServerRequest(commandRequest()), undefined);
});

test("correlates file changes by the exact hook tool item", () => {
  const ledger = new DirectApprovalLedger({ now: () => 1_000 });
  assert.equal(ledger.authorizeHook({
    ...HOOK_APPROVAL,
    tool_name: "apply_patch",
    tool_input: { command: "*** Begin Patch\n*** Delete File: disposable.txt\n*** End Patch" },
  }), true);

  assert.deepEqual(ledger.consumeServerRequest({
    method: "item/fileChange/requestApproval",
    params: {
      threadId: HOOK_APPROVAL.session_id,
      turnId: HOOK_APPROVAL.turn_id,
      itemId: HOOK_APPROVAL.tool_use_id,
    },
  }), { decision: "accept" });
});

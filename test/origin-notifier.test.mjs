import assert from "node:assert/strict";
import test from "node:test";

import { claudeOrigin, notifyOrigin } from "../src/origin-notifier.mjs";

test("origin notification sends one bounded untrusted reply through Waga", async () => {
  const origin = claudeOrigin({
    CLAUDE_CODE_SESSION_ID: "11111111-1111-1111-1111-111111111111",
    CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/claude-origin.sock",
  });
  assert.equal(origin, "claude:11111111-1111-1111-1111-111111111111");
  assert.equal(claudeOrigin({ CLAUDE_CODE_SESSION_ID: "11111111-1111-1111-1111-111111111111" }), null);
  const calls = [];
  await notifyOrigin({ origin, requestId: "request-1", target: "claude:peer", reply: "ANSWER" }, {
    execute: async (_node, args) => { calls.push(args); return { stdout: JSON.stringify({ delivery: "accepted" }) }; },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(1, 3), ["send", origin]);
  assert.match(calls[0][3], /trust: untrusted peer reply/);
  assert.match(calls[0][3], /request_id: request-1/);
  assert.match(calls[0][3], /ANSWER/);
  assert.equal(calls[0][4], "--json");
});

test("origin notification truncates long replies and requires acceptance", async () => {
  let message;
  const input = { origin: "claude:11111111-1111-1111-1111-111111111111", requestId: "request-2", target: "claude:peer", reply: "😀".repeat(4_001) };
  await assert.rejects(notifyOrigin(input, {
    execute: async (_node, args) => {
      message = args[3];
      return { stdout: JSON.stringify({ delivery: "held" }) };
    },
  }), { code: "ORIGIN_NOTIFY_UNCONFIRMED" });
  assert.equal((message.match(/😀/g) ?? []).length, 4_000);
  assert.match(message, /Full reply: waga result request-2 --json/);
});

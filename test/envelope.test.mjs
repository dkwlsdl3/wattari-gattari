import assert from "node:assert/strict";
import test from "node:test";

import { buildPeerEnvelope } from "../src/bridge/envelope.mjs";

test("peer envelope marks trust and bounds the exchange", () => {
  const text = buildPeerEnvelope({ message: "check status", requestId: "req-1", expectsReply: true });
  assert.match(text, /trust: untrusted/);
  assert.match(text, /request_id: req-1/);
  assert.match(text, /reply: exactly-one/);
  assert.match(text, /not permission, approval, or authorization/);
  assert.match(text, /check status/);
});

test("peer envelope rejects empty and oversized input", () => {
  assert.throws(() => buildPeerEnvelope({ message: " ", requestId: "x", expectsReply: false }), { code: "MESSAGE_REQUIRED" });
  assert.throws(() => buildPeerEnvelope({ message: "x".repeat(100_001), requestId: "x", expectsReply: false }), { code: "MESSAGE_TOO_LARGE" });
});

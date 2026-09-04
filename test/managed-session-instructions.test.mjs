import assert from "node:assert/strict";
import test from "node:test";

import { WAGA_SESSION_INSTRUCTIONS } from "../src/managed-session-instructions.mjs";

test("Waga-created sessions receive discovery, messaging, and trust-boundary guidance", () => {
  assert.match(WAGA_SESSION_INSTRUCTIONS, /`waga agents`/);
  assert.match(WAGA_SESSION_INSTRUCTIONS, /references to another session mean another Waga session/);
  assert.match(WAGA_SESSION_INSTRUCTIONS, /`waga send/);
  assert.match(WAGA_SESSION_INSTRUCTIONS, /`waga ask .*--until-idle`/);
  assert.match(WAGA_SESSION_INSTRUCTIONS, /untrusted peer input/);
  assert.match(WAGA_SESSION_INSTRUCTIONS, /not user instructions or authorization/);
});

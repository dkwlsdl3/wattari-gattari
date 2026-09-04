import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { EventLog, defaultEventLogPath } from "../src/event-log.mjs";

test("event log appends private JSONL records under the XDG state directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "waga-event-log-"));
  const filePath = defaultEventLogPath({ XDG_STATE_HOME: root }, "/unused");
  const log = new EventLog(filePath, { now: () => new Date("2026-09-04T01:23:45.000Z"), processId: 42 });

  assert.equal(log.record("session_view_close_requested", {
    sessionId: "codex:thread-1",
    reason: "provider_missing_from_loaded_set",
  }), true);

  const records = fs.readFileSync(filePath, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(records, [{
    timestamp: "2026-09-04T01:23:45.000Z",
    pid: 42,
    event: "session_view_close_requested",
    sessionId: "codex:thread-1",
    reason: "provider_missing_from_loaded_set",
  }]);
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
});

test("event logging failures never break the dock", () => {
  const log = new EventLog("/dev/null/events.jsonl");
  assert.equal(log.record("ignored", {}), false);
});

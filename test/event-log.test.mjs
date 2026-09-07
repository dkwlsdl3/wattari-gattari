import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { EventLog, defaultEventLogPath } from "../src/event-log.mjs";

test("event log appends private JSONL records under the XDG state directory", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "waga-event-log-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
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

test("event logger never follows a symlink or lets details replace provenance", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "waga-proof-log-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const victim = path.join(root, "keep");
  const file = path.join(root, "events.jsonl");
  fs.writeFileSync(victim, "unchanged", { mode: 0o644 });
  fs.symlinkSync(victim, file);
  const log = new EventLog(file, { processId: 42, now: () => 0 });
  assert.equal(log.record("event", {}), false);
  assert.equal(fs.readFileSync(victim, "utf8"), "unchanged");
  assert.equal(fs.statSync(victim).mode & 0o777, 0o644);
  fs.unlinkSync(file);
  assert.equal(log.record("actual", { event: "forged", timestamp: "forged", pid: 99, sessionId: "proof" }), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { event: "actual", timestamp: "1970-01-01T00:00:00.000Z", pid: 42, sessionId: "proof" });
});

test("event logger closes the descriptor on failed writes and tolerates rotation", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "waga-proof-log-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "events.jsonl");
  const log = new EventLog(file);
  assert.equal(log.record("before"), true);
  fs.renameSync(file, file + ".1");
  assert.equal(log.record("after"), true);
  assert.equal(JSON.parse(fs.readFileSync(file)).event, "after");
  assert.equal(JSON.parse(fs.readFileSync(file + ".1")).event, "before");
  const write = fs.writeFileSync;
  let descriptor;
  t.mock.method(fs, "writeFileSync", (file, ...args) => {
    if (typeof file === "number") { descriptor = file; throw new Error("disk full"); }
    return write(file, ...args);
  });
  assert.equal(log.record("failed"), false);
  assert.throws(() => fs.fstatSync(descriptor), { code: "EBADF" });
});

test("event logging failures never break the dock", () => {
  const log = new EventLog("/dev/null/events.jsonl");
  assert.equal(log.record("ignored", {}), false);
});

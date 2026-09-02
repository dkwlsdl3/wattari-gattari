import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openRotatingLog } from "../src/rotating-log.mjs";

test("rotates bounded private logs before opening the next writer", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "waga-log-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true }));
  const logPath = path.join(directory, "logs", "daemon.log");
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, "0123456789");
  fs.writeFileSync(`${logPath}.1`, "previous");

  const fd = openRotatingLog(logPath, { maxBytes: 10, backups: 2 });
  fs.writeSync(fd, "fresh");
  fs.closeSync(fd);

  assert.equal(fs.readFileSync(logPath, "utf8"), "fresh");
  assert.equal(fs.readFileSync(`${logPath}.1`, "utf8"), "0123456789");
  assert.equal(fs.readFileSync(`${logPath}.2`, "utf8"), "previous");
  assert.equal(fs.statSync(logPath).mode & 0o777, 0o600);
});

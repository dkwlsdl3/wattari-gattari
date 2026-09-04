import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseClaudeUsage, readClaudeUsage } from "../src/claude-usage.mjs";

test("Claude usage parser reads the measured OAuth response shape", () => {
  assert.deepEqual(parseClaudeUsage({
    five_hour: { utilization: 12.4, resets_at: "2026-09-04T06:00:00Z" },
    seven_day: { utilization: 94.2, resets_at: "2026-09-07T02:24:00Z" },
  }, 10), {
    fiveHour: { usedPercent: 12, remainingPercent: 88, resetsAt: 1_788_501_600 },
    weekly: { usedPercent: 94, remainingPercent: 6, resetsAt: 1_788_747_840 },
    observedAt: 10,
  });
  assert.equal(parseClaudeUsage({}), null);
});

test("Claude usage reader reuses valid credentials without exposing or rewriting them", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "waga-claude-usage-"));
  const credentialDirectory = path.join(root, ".claude");
  fs.mkdirSync(credentialDirectory, { recursive: true });
  const credentialsPath = path.join(credentialDirectory, ".credentials.json");
  const original = JSON.stringify({ claudeAiOauth: { accessToken: "secret-token", expiresAt: 2_000_000 } });
  fs.writeFileSync(credentialsPath, original);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let receivedToken;

  const usage = await readClaudeUsage({
    homeDirectory: root,
    now: () => 1_000_000,
    request: async (token) => {
      receivedToken = token;
      return { status: 200, body: JSON.stringify({ seven_day: { utilization: 98, resets_at: "2026-09-07T02:24:00Z" } }) };
    },
  });

  assert.equal(receivedToken, "secret-token");
  assert.equal(usage.weekly.remainingPercent, 2);
  assert.equal(fs.readFileSync(credentialsPath, "utf8"), original);
});

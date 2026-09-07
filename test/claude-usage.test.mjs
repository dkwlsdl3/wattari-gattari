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

test("Claude usage validates windows independently and clamps only numeric percentages", () => {
  for (const utilization of [null, "50", Infinity, NaN, undefined]) assert.equal(parseClaudeUsage({ seven_day: { utilization } }), null);
  assert.deepEqual(parseClaudeUsage({ five_hour: { utilization: -5, resets_at: "invalid" }, seven_day: { utilization: 120 } }, 7), {
    fiveHour: { usedPercent: 0, remainingPercent: 100, resetsAt: null },
    weekly: { usedPercent: 100, remainingPercent: 0, resetsAt: null }, observedAt: 7,
  });
});

test("Claude usage rejects unsafe credentials and exact expiry boundary without making requests", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "waga-proof-usage-auth-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, ".claude"));
  const file = path.join(root, ".claude", ".credentials.json");
  let requests = 0;
  const options = { homeDirectory: root, now: () => 1000, request: async () => { requests++; return { status: 401 }; } };
  for (const token of ["", "line\nbreak", 'quote"', "escape\\", "tab\t", "space token", "nul\0"]) {
    fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt: 100000 } }));
    assert.equal(await readClaudeUsage(options), null);
  }
  fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: "valid", expiresAt: 61000 } }));
  assert.equal(await readClaudeUsage(options), null);
  assert.equal(requests, 0);
  fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: "valid", expiresAt: 61001 } }));
  const body = JSON.stringify({ seven_day: { utilization: 10 } });
  for (const response of [{ status: 401, body }, { status: 429, body }, { status: 500, body }, { status: 200, body: "not JSON" }]) {
    assert.equal(await readClaudeUsage({ ...options, request: async () => response }), null);
  }
  assert.equal(await readClaudeUsage({ ...options, request: async () => { throw new Error("network down"); } }), null);
  assert.equal(JSON.parse(fs.readFileSync(file)).claudeAiOauth.expiresAt, 61001);
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

test("default usage transport passes credentials through stdin and handles executable failures", { timeout: 3000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "waga-proof-curl-"));
  const previousPath = process.env.PATH;
  t.after(() => { process.env.PATH = previousPath; fs.rmSync(root, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(root, ".claude"));
  fs.writeFileSync(path.join(root, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "proof-token", expiresAt: 100000 } }));
  process.env.PATH = root;
  const curl = path.join(root, "curl");
  const install = (code) => fs.writeFileSync(curl, `#!${process.execPath}\n${code}\n`, { mode: 0o700 });
  install(`let input = ''; process.stdin.on('data', chunk => input += chunk); process.stdin.on('end', () => {
    const args = process.argv.slice(2);
    if (args.some(arg => arg.includes('proof-token')) || !args.includes('--config') || !args.includes('--max-time') || !input.includes('Authorization: Bearer proof-token')) process.exit(9);
    process.stdout.write(JSON.stringify({seven_day:{utilization:33}})+'\\n200');
  });`);
  const options = { homeDirectory: root, now: () => 1000 };
  assert.equal((await readClaudeUsage(options)).weekly.remainingPercent, 67);
  for (const code of ["process.exit(7);", "process.stdout.write('no status');", "process.stdout.write('{}\\n401');"]) {
    install(code);
    assert.equal(await readClaudeUsage(options), null);
  }
  fs.unlinkSync(curl);
  assert.equal(await readClaudeUsage(options), null);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { defaultClaudeAliasPath, SessionAliasCatalog } from "../src/session-alias-catalog.mjs";

test("Claude aliases reuse the historical state path and persist privately", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "waga-alias-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true }));
  assert.equal(defaultClaudeAliasPath({ XDG_STATE_HOME: "/tmp/state" }, "/home/demo"), "/tmp/state/wattari-gattari/claude-aliases.json");
  assert.equal(defaultClaudeAliasPath({}, "/home/demo"), "/home/demo/.local/state/wattari-gattari/claude-aliases.json");

  const filePath = path.join(directory, "claude-aliases.json");
  fs.writeFileSync(filePath, `${JSON.stringify({ version: 1, aliases: { "claude:old": "old alias" }, hidden: ["claude:hidden"] })}\n`);
  const catalog = new SessionAliasCatalog(filePath);
  catalog.set("claude:full-id", "renamed");
  assert.deepEqual([...new SessionAliasCatalog(filePath).load()], [["claude:old", "old alias"], ["claude:full-id", "renamed"]]);
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, "utf8")).hidden, ["claude:hidden"]);
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
});

test("Claude aliases fail closed on malformed state", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "waga-alias-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true }));
  const filePath = path.join(directory, "claude-aliases.json");
  fs.writeFileSync(filePath, "{}\n");
  assert.throws(() => new SessionAliasCatalog(filePath).load(), { code: "SESSION_ALIAS_CATALOG_INVALID" });
});

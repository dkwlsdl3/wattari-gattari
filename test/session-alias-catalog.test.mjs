import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SessionAliasCatalog } from "../src/session-alias-catalog.mjs";

test("persists aliases atomically with private permissions", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "waga-alias-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true }));
  const filePath = path.join(directory, "aliases.json");
  const catalog = new SessionAliasCatalog(filePath);
  catalog.set("claude:12345678", "renamed");
  assert.equal(new SessionAliasCatalog(filePath).get("claude:12345678"), "renamed");
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  assert.equal(catalog.remove("claude:12345678"), true);
  assert.equal(catalog.get("claude:12345678"), null);
  assert.equal(catalog.remove("claude:12345678"), false);
  assert.equal(catalog.hide("claude:12345678"), true);
  assert.equal(catalog.isHidden("claude:12345678"), true);
  assert.equal(catalog.unhide("claude:12345678"), true);
  assert.equal(catalog.isHidden("claude:12345678"), false);
});

test("fails closed on malformed alias state", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "waga-alias-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true }));
  const filePath = path.join(directory, "aliases.json");
  fs.writeFileSync(filePath, "{}\n");
  assert.throws(() => new SessionAliasCatalog(filePath).get("claude:x"), {
    code: "SESSION_ALIAS_CATALOG_INVALID",
  });
});

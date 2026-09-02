import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ManagedThreadCatalog } from "../src/managed-thread-catalog.mjs";

const THREAD_ID = "11111111-1111-7111-8111-111111111111";

test("persists managed thread ids for a later screen client", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "waga-catalog-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true }));
  const filePath = path.join(directory, "codex-sessions.json");

  new ManagedThreadCatalog(filePath).record(THREAD_ID);

  assert.deepEqual([...new ManagedThreadCatalog(filePath).read()], [THREAD_ID]);
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
});

test("removes a stopped thread id while keeping the catalog file", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "waga-catalog-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true }));
  const filePath = path.join(directory, "codex-sessions.json");
  const catalog = new ManagedThreadCatalog(filePath);
  catalog.record(THREAD_ID);

  catalog.remove(THREAD_ID);

  assert.deepEqual([...catalog.read()], []);
  assert.equal(fs.existsSync(filePath), true);
});

test("fails closed when the managed thread catalog is malformed", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "waga-catalog-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true }));
  const filePath = path.join(directory, "codex-sessions.json");
  fs.writeFileSync(filePath, "{broken", { mode: 0o600 });

  assert.throws(() => new ManagedThreadCatalog(filePath).read(), {
    code: "MANAGED_THREAD_CATALOG_INVALID",
  });
});

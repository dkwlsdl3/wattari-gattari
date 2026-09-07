import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DockOrderStore } from "../src/dock-order.mjs";
import { SessionAliasCatalog } from "../src/session-alias-catalog.mjs";

for (const kind of ["order", "alias"]) {
  test(`${kind} store preserves the last valid file and removes temporary data after rename failure`, (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "waga-proof-storage-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, "state.json");
    const store = kind === "order" ? new DockOrderStore(file) : new SessionAliasCatalog(file);
    const save = (name) => kind === "order" ? store.saveWorkspace("/work", [name]) : store.set("claude:id", name);
    save("before");
    const original = fs.readFileSync(file, "utf8");
    const failure = Object.assign(new Error("disk full"), { code: "ENOSPC" });
    t.mock.method(fs, "renameSync", () => { throw failure; });
    assert.throws(() => save("after"), (error) => error === failure);
    assert.equal(fs.readFileSync(file, "utf8"), original);
    assert.deepEqual(fs.readdirSync(root), ["state.json"]);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });

  test(`${kind} store re-reads other writers and refuses malformed data without overwriting it`, (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "waga-proof-storage-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, "state.json");
    const Type = kind === "order" ? DockOrderStore : SessionAliasCatalog;
    const first = new Type(file);
    const second = new Type(file);
    const save = (store, key, value) => kind === "order" ? store.saveWorkspace(key, [value]) : store.set(key, value);
    save(first, "/one", "one");
    save(second, "/two", "two");
    save(first, "/one", "updated");
    assert.deepEqual([...second.load()], kind === "order" ? [["/one", ["updated"]], ["/two", ["two"]]] : [["/one", "updated"], ["/two", "two"]]);
    const invalid = kind === "order" ? ["{", '{}', '{"version":1,"workspaces":[{"path":"relative","sessionOrder":[]}]}', '{"version":1,"workspaces":[{"path":"/a","sessionOrder":["x","x"]}]}']
      : ["{", '{}', '{"version":1,"aliases":[]}', '{"version":1,"aliases":{"x":" "}}'];
    for (const text of invalid) {
      fs.writeFileSync(file, text);
      const code = kind === "order" ? "DOCK_ORDER_INVALID" : "SESSION_ALIAS_CATALOG_INVALID";
      assert.throws(() => second.load(), { code });
      assert.throws(() => save(first, "/one", "ignored"), { code });
      assert.equal(fs.readFileSync(file, "utf8"), text);
    }
  });
}

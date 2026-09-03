import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { defaultDockOrderPath, DockOrderStore } from "../src/dock-order.mjs";

test("dock order path follows XDG state conventions", () => {
  assert.equal(defaultDockOrderPath({ XDG_STATE_HOME: "/tmp/state" }, "/home/demo"), "/tmp/state/wattari-gattari/dock-order.json");
  assert.equal(defaultDockOrderPath({}, "/home/demo"), "/home/demo/.local/state/wattari-gattari/dock-order.json");
});

test("dock order persists unique session ids per workspace", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "waga-dock-order-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "state", "dock-order.json");
  const store = new DockOrderStore(filePath);

  assert.deepEqual([...store.load()], []);
  store.saveWorkspace("/work/a", ["codex:2", "codex:1"]);
  store.saveWorkspace("/work/b", ["claude:1"]);
  assert.deepEqual([...new DockOrderStore(filePath).load()], [
    ["/work/a", ["codex:2", "codex:1"]],
    ["/work/b", ["claude:1"]],
  ]);
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  assert.throws(() => store.saveWorkspace("/work/a", ["codex:1", "codex:1"]), /unique session ids/);
});

test("dock order rejects corrupt persisted state", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "waga-dock-order-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "dock-order.json");
  fs.writeFileSync(filePath, "{}\n");
  assert.throws(() => new DockOrderStore(filePath).load(), { code: "DOCK_ORDER_INVALID" });
});

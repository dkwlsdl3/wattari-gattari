import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { SessionBridge } from "../src/session-bridge.mjs";
import { runOverview } from "../src/overview.mjs";

const tick = () => new Promise(setImmediate);
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
const claude = { id: "claude:new-proof", nativeId: "825745c2", provider: "claude", name: "new-visible-proof", cwd: "/tmp/waga-proof-discovery", status: "working" };
const codex = { ...claude, id: "codex:old-proof", nativeId: "old-proof", provider: "codex", name: "old-codex-proof" };
function dock(t, providers) {
  const writes = [];
  const input = Object.assign(new EventEmitter(), { isTTY: true, setRawMode() {}, resume() {}, pause() {} });
  const output = Object.assign(new EventEmitter(), { isTTY: true, columns: 110, rows: 25, write: x => writes.push(x) });
  const running = runOverview({ bridge: new SessionBridge({ providers }), workspace: {}, defaultCwd: claude.cwd, inputStream: input, outputStream: output, refreshMs: 60_000, listenForSignals: false });
  t.after(async () => { input.emit("end"); await running; });
  return { input, writes, key: (name, extra = {}) => input.emit("keypress", "", { name, ...extra }), frame: () => writes.at(-1) };
}

test("new Claude session becomes visible while an unrelated Codex read remains pending", async t => {
  const slow = deferred(); t.after(() => slow.resolve([]));
  let ready = false, created = false, codexReads = 0, claudeReads = 0;
  const ui = dock(t, [
    { name: "claude", create: async () => { created = true; return { provider: "claude", nativeId: claude.nativeId }; }, list: async () => { claudeReads++; return ready ? [claude] : []; } },
    { name: "codex", list: async () => ++codexReads === 1 ? [codex] : slow.promise },
  ]);
  await tick();
  ui.key("n", { meta: true }); ui.input.emit("keypress", "proof", { sequence: "proof" }); ui.key("return");
  await tick();
  assert.ok(created);
  ready = true;
  ui.key("r", { meta: true }); await tick();
  assert.match(ui.frame(), /new-visible-proof/);
  assert.match(ui.frame(), /old-codex-proof/, "pending provider must retain its existing rows");
  assert.ok(claudeReads >= 4, "healthy provider must continue polling");
  assert.equal(codexReads, 2, "refresh must not duplicate the slow provider request");
});

test("initial healthy provider renders without waiting for the other provider", async t => {
  const slow = deferred(); t.after(() => slow.resolve([]));
  const ui = dock(t, [{ name: "claude", list: async () => [claude] }, { name: "codex", list: () => slow.promise }]);
  await tick();
  assert.match(ui.frame(), /new-visible-proof/);
});

test("independent polls retain provider errors and still confirm removals", async t => {
  let rows = [claude], broken = false;
  const ui = dock(t, [
    { name: "claude", list: async () => rows },
    { name: "codex", list: async () => { if (broken) throw new Error("codex-proof-offline"); return [codex]; } },
  ]);
  await tick(); rows = []; broken = true;
  for (let i = 0; i < 3; i++) { ui.key("r", { meta: true }); await tick(); }
  assert.doesNotMatch(ui.frame(), /new-visible-proof/, "other provider polls must not reset removal confirmations");
  assert.match(ui.frame(), /old-codex-proof/);
  assert.match(ui.frame(), /codex-proof-offline/);
});

test("healthy refresh cannot erase the other provider's unresolved error", async t => {
  const slow = deferred(); t.after(() => slow.resolve([]));
  let reads = 0;
  const ui = dock(t, [
    { name: "claude", list: async () => [claude] },
    { name: "codex", list: async () => { if (++reads === 1) throw new Error("codex-proof-offline"); return slow.promise; } },
  ]);
  await tick();
  for (let i = 0; i < 2; i++) { ui.key("r", { meta: true }); await tick(); }
  assert.match(ui.frame(), /codex-proof-offline/);
  assert.match(ui.frame(), /new-visible-proof/);
});

test("interleaved healthy providers each retain their own removal confirmations", async t => {
  let rows = [claude];
  const ui = dock(t, [
    { name: "claude", list: async () => rows },
    { name: "codex", list: async () => [codex] },
  ]);
  await tick(); rows = [];
  ui.key("r", { meta: true }); await tick();
  assert.match(ui.frame(), /new-visible-proof/, "first omission is tolerated");
  ui.key("r", { meta: true }); await tick();
  assert.doesNotMatch(ui.frame(), /new-visible-proof/, "second Claude omission confirms removal despite the intervening Codex poll");
  assert.match(ui.frame(), /old-codex-proof/);
});

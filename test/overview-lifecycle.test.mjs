import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { runOverview } from "../src/overview.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
const active = { id: "codex:proof", nativeId: "proof", provider: "codex", name: "Before", cwd: "/work", status: "idle" };
const snapshot = (sessions = [active]) => ({ sessions, warnings: [], availableProviders: ["codex"] });
function setup(t, options = {}) {
  const writes = [];
  const input = Object.assign(new EventEmitter(), { isTTY: true, setRawMode() {}, resume() {}, pause() {} });
  const output = Object.assign(new EventEmitter(), { isTTY: true, columns: 100, rows: 20, write: (value) => writes.push(value) });
  const workspace = { leave: async () => ({ closeOverview: true }), ...options.workspace };
  const running = runOverview({ defaultCwd: "/work", refreshMs: 60000, listenForSignals: false, ...options, workspace, inputStream: input, outputStream: output });
  t.after(async () => { input.emit("end"); await running; });
  const key = (name, extra = {}) => input.emit("keypress", "", { name, ...extra });
  return { input, output, writes, running, key };
}

test("overview can close during initial discovery and ignores its late result", { timeout: 1000 }, async (t) => {
  const pending = deferred();
  let reconciles = 0;
  const ui = setup(t, { bridge: { discover: () => pending.promise }, workspace: { reconcileSessionViews: async () => { reconciles++; } } });
  t.after(() => pending.resolve(snapshot()));
  ui.input.emit("close");
  const result = await Promise.race([ui.running, new Promise((resolve) => setTimeout(() => resolve("blocked"), 30))]);
  const count = ui.writes.length;
  pending.resolve(snapshot());
  await tick();
  assert.equal(result, 0);
  assert.equal(reconciles, 0);
  assert.equal(ui.writes.length, count);
});

test("overview cleanup removes process and stream listeners", async (t) => {
  const counts = [process.listenerCount("SIGTERM"), process.listenerCount("SIGHUP")];
  const ui = setup(t, { bridge: { discover: async () => snapshot() }, listenForSignals: true });
  await tick();
  ui.input.emit("end");
  await ui.running;
  assert.deepEqual([process.listenerCount("SIGTERM"), process.listenerCount("SIGHUP")], counts);
  for (const event of ["end", "close", "keypress"]) assert.equal(ui.input.listenerCount(event), 0);
  assert.equal(ui.output.listenerCount("resize"), 0);
});

test("in-flight discovery and resize never paint over a native TUI", async (t) => {
  const pending = deferred();
  const native = deferred();
  let calls = 0;
  const ui = setup(t, {
    bridge: { discover: async () => ++calls === 2 ? pending.promise : snapshot() },
    commandFor: async () => ({}), workspace: { focusOrOpen: () => native.promise },
  });
  await tick();
  ui.key("r", { meta: true });
  ui.key("down");
  ui.key("return");
  await tick();
  const count = ui.writes.length;
  ui.output.emit("resize");
  pending.resolve(snapshot([{ ...active, status: "working" }]));
  await tick();
  const busyWrites = ui.writes.length;
  native.resolve({ code: 0 });
  await tick();
  assert.equal(busyWrites, count);
  assert.ok(ui.writes.length > count);
});

test("forced refresh during a pending read queues one newer snapshot", async (t) => {
  const pending = deferred();
  let calls = 0;
  const ui = setup(t, { bridge: { discover: async () => {
    calls++;
    if (calls === 2) return pending.promise;
    return snapshot([{ ...active, name: calls === 1 ? "Before" : "Fresh" }]);
  } } });
  await tick();
  ui.key("r", { meta: true });
  ui.key("r", { meta: true });
  ui.key("r", { meta: true });
  pending.resolve(snapshot([{ ...active, name: "STALE" }]));
  await tick();
  assert.equal(calls, 3);
  assert.match(ui.writes.at(-1), /Fresh/);
  assert.ok(ui.writes.every((frame) => !frame.includes("STALE")));
});

test("failed order save remains visible as a warning without losing the selection", async (t) => {
  const second = { ...active, id: "codex:second", name: "Second" };
  const ui = setup(t, {
    bridge: { discover: async () => snapshot([active, second]) },
    orderStore: { load: () => new Map(), saveWorkspace: () => { throw new Error("disk full"); } },
  });
  await tick();
  ui.key("down");
  ui.key("down", { shift: true });
  assert.match(ui.writes.at(-1), /disk full/);
  assert.ok(ui.writes.at(-1).indexOf("Second") < ui.writes.at(-1).indexOf("Before"));
  ui.key("r", { meta: true });
  await tick();
  assert.match(ui.writes.at(-1), /disk full/);
});

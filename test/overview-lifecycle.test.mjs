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

test("animation does not poll providers and pauses in editors, hidden Docks and after cleanup", async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let now = 0, calls = 0, visible = true, status = 'working';
  const ui = setup(t, { now: () => now, refreshMs: 600,
    bridge: { discover: async () => { calls++; return snapshot([{ ...active, status }]); } },
    workspace: { shouldRefreshOverview: async () => visible } });
  await tick();
  assert.doesNotMatch(ui.writes.at(-1), /최근 변경/);
  const initial = ui.writes.length;
  now = 120; t.mock.timers.tick(120); await tick();
  assert.ok(ui.writes.length > initial, 'a visible working row animates');
  assert.equal(calls, 1, 'painting a frame must not discover sessions');
  ui.key('n', { meta: true });
  const editing = ui.writes.length;
  now = 240; t.mock.timers.tick(120); await tick();
  assert.equal(ui.writes.length, editing);
  ui.key('escape');
  visible = false;
  now = 600; t.mock.timers.tick(360); await tick();
  const hidden = ui.writes.length;
  now = 840; t.mock.timers.tick(240); await tick();
  assert.equal(ui.writes.length, hidden);
  assert.equal(calls, 1);
  visible = true;
  status = 'idle';
  now = 1200; t.mock.timers.tick(360); await tick();
  assert.equal(calls, 2);
  assert.match(ui.writes.at(-1), /작업 중 → 대기/);
  now = 1320; t.mock.timers.tick(120); await tick();
  const highlighted = ui.writes.length;
  now = 2500; t.mock.timers.tick(120); await tick();
  assert.equal(ui.writes.length, highlighted + 1, 'one final frame clears expired highlighting');
  const settled = ui.writes.length;
  now = 2620; t.mock.timers.tick(120); await tick();
  assert.equal(ui.writes.length, settled, 'idle rows do not keep repainting');
  assert.equal(calls, 2);
  ui.input.emit('end'); await ui.running;
  const closed = ui.writes.length;
  now = 1800; t.mock.timers.tick(600); await tick();
  assert.equal(ui.writes.length, closed);
});

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
  t.mock.timers.enable({ apis: ['setInterval'] });
  const pending = deferred();
  const native = deferred();
  let calls = 0;
  const ui = setup(t, {
    bridge: { discover: async () => ++calls === 2 ? pending.promise : snapshot([{ ...active, status: 'working' }]) },
    commandFor: async () => ({}), workspace: { focusOrOpen: () => native.promise },
  });
  await tick();
  ui.key("r", { meta: true });
  ui.key("down");
  ui.key("return");
  await tick();
  const count = ui.writes.length;
  ui.output.emit("resize");
  t.mock.timers.tick(120);
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

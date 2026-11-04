import assert from "node:assert/strict";
import test from "node:test";
import { GlobalDock, DockNavigationStore } from "../src/global-dock.mjs";
import { buildGlobalDockFrame, runOverview } from "../src/overview.mjs";
import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from 'node:timers/promises';

test("independent failures preserve registration order, ID selection and last good summary", async () => {
  const config = { local: { id: "here", name: "Same name" }, hosts: [{ id: "b", name: "Same name" }, { id: "a", name: "Same name" }] };
  let fail = false;
  const dock = new GlobalDock(config, { query: async host => {
    if (host.id === "a" || fail) throw Object.assign(new Error("Command failed: ssh -T -o lots-of-options remote-command"), { stderr: "DISCOVERY_FAILED: provider unavailable\n" });
    return { sessions: [{ id: "codex:remote", cwd: "/remote" }], warnings: [] };
  } });
  dock.selectedId = "b";
  await dock.refresh();
  assert.deepEqual(dock.rows().map(row => row.id), ["here", "b", "a"]);
  assert.equal(dock.states.get("a").status, "unavailable");
  assert.equal(dock.states.get("a").summary, null);
  assert.equal(dock.states.get("a").error, "DISCOVERY_FAILED: provider unavailable");
  const good = dock.states.get("b").summary;
  fail = true;
  await dock.refresh();
  assert.equal(dock.states.get("b").status, "stale");
  assert.equal(dock.states.get("b").summary, good);
  assert.equal(dock.states.get("b").summary.sessions.length, 1);
  assert.equal(dock.selectedId, "b");
});

test("overlapping manual refreshes share one bounded query per host", async () => {
  let resolve;
  let calls = 0;
  const dock = new GlobalDock({ local: { id: "here" }, hosts: [{ id: "there" }] }, { query: () => { calls++; return new Promise(done => { resolve = done; }); } });
  const first = dock.refresh();
  assert.equal(dock.refresh(), first);
  resolve({ sessions: [] });
  await first;
  assert.equal(calls, 1);
});

test("a healthy host publishes before a different host finishes, and partial discovery is labeled", async () => {
  let finishSlow;
  const dock = new GlobalDock({ local: { id: "local" }, hosts: [{ id: "slow" }, { id: "fast" }] }, {
    query: host => host.id === "slow" ? new Promise(resolve => { finishSlow = resolve; }) : Promise.resolve({ sessions: [], warnings: [{ message: "Codex unavailable" }] }),
  });
  const published = [];
  const running = dock.refresh(() => published.push(dock.states.get("fast").status));
  await setImmediate();
  assert.deepEqual(published, ["partial"]);
  finishSlow({ sessions: [], warnings: [] });
  await running;
  assert.equal(dock.states.get("slow").status, "available");
});

test("global frame shows project locations and last successful data without claiming offline or zero sessions", () => {
  const rows = [{ id: "home", name: "Home", type: "wsl", status: "stale", error: "SSH refused", summary: { sessions: [{ cwd: "/home/me/keeper", status: "working" }] } },
    { id: "server", name: "Server", type: "vm", status: "unavailable" }];
  const frame = buildGlobalDockFrame({ rows, selectedId: "home", currentHost: "Work", width: 100, height: 24 });
  assert.match(frame, /이전 자료/);
  assert.match(frame, /1개 세션/);
  assert.match(frame, /세션 미확인/);
  assert.match(frame, /\/home\/me\/keeper/);
  assert.match(frame, /\[WSL\]/);
  assert.match(frame, /\[VM\]/);
  assert.doesNotMatch(frame, /오프라인|0개 세션/);
});

const config = { version: 1, local: { id: "work", name: "Work" }, hosts: [{ id: "home", name: "Home", ssh: "home-box", command: "waga" }] };
function dockFixture(t, options = {}) {
  const input = Object.assign(new EventEmitter(), { isTTY: true, setRawMode() {}, resume() {} });
  const output = Object.assign(new EventEmitter(), { isTTY: true, columns: 120, rows: 30, write() {} });
  const session = { id: "codex:local", provider: "codex", name: "Local", cwd: "/tmp/waga-proof-global", status: "idle" };
  const running = runOverview({ hosts: config, defaultCwd: session.cwd, bridge: { discover: async () => ({ sessions: [session], warnings: [] }) },
    inputStream: input, outputStream: output, errorOutput: { write() {} }, listenForSignals: false, refreshMs: 60_000, ...options });
  t.after(async () => { input.emit("end"); await running; });
  return { input, session, running, press: async (name, text = "", extra = {}) => { input.emit("keypress", text, { name, sequence: text, ...extra }); await setImmediate(); } };
}

test("PC switching preserves local session selection and global search never becomes local native input", async t => {
  const opened = [], native = [];
  const globalDock = new GlobalDock(config, { query: async () => ({ sessions: [], warnings: [] }) });
  const f = dockFixture(t, { globalDock, workspace: { openRemoteHost: async host => { opened.push(host.id); }, focusOrOpen: async session => { native.push(session.id); } }, commandFor: () => ({}) });
  await setImmediate();
  await f.press("down"); await f.press("down"); // PC row, project, session.
  await f.press("f4");
  assert.deepEqual(native, [f.session.id]);
  await f.press("up"); await f.press("up"); await f.press("return");
  await f.press("/", "/"); await f.press("h", "home"); await f.press("return"); await f.press("return");
  assert.deepEqual(opened, ["home"]);
  assert.deepEqual(native, [f.session.id]);
  await f.press("escape"); await f.press("escape"); // Clear host filter, then return to local selection.
  await f.press("return");
  assert.deepEqual(native, [f.session.id, f.session.id]);
});

test("remote PC back exits only that Dock view without dispatching a native session locally", async t => {
  let leaves = 0;
  const f = dockFixture(t, { remoteHost: "Home", workspace: { leave: async () => { leaves++; return { closeOverview: true }; } }, commandFor: () => { throw Error("must not launch"); } });
  await setImmediate(); await f.press("return");
  assert.equal(await f.running, 0);
  assert.equal(leaves, 1);
});

test("late host queries and resize never paint over a direct SSH terminal", async t => {
  let finishQuery, finishConnection, writes = 0;
  const globalDock = new GlobalDock(config, { query: () => new Promise(resolve => { finishQuery = resolve; }) });
  const output = Object.assign(new EventEmitter(), { isTTY: true, columns: 120, rows: 30, write() { writes++; } });
  const f = dockFixture(t, { globalDock, outputStream: output, workspace: { openRemoteHost: () => new Promise(resolve => { finishConnection = resolve; }) } });
  await setImmediate(); await f.press("return"); await f.press("down"); await f.press("return");
  const before = writes;
  output.emit("resize"); finishQuery({ sessions: [], warnings: [] }); await setImmediate();
  assert.equal(writes, before, "the remote terminal owns the output while SSH is active");
  finishConnection({ code: 0 }); await setImmediate();
  assert.ok(writes > before, "Global Dock renders again after SSH returns the terminal");
});

test("remote navigation survives a new Dock process with canonical selection and project state", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "waga-proof-global-nav-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new DockNavigationStore("home", root);
  const original = { selectedKey: "codex:local", query: "Local", collapsed: ["/tmp/another-project"], provider: null, previewOutputOffset: 0 };
  store.save(original);
  const opened = [];
  const f = dockFixture(t, { navigationStore: store, workspace: { focusOrOpen: async session => { opened.push(session.id); } }, commandFor: () => ({}) });
  await setImmediate(); await f.press("return");
  assert.deepEqual(opened, ["codex:local"]);
  f.input.emit("end"); await f.running;
  assert.deepEqual(store.load(), { ...original, version: 1 });
  assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);
});

test("PC list round trip keeps the last session's response scroll position", async t => {
  let previewStarted;
  const ready = new Promise(resolve => { previewStarted = resolve; });
  const saved = [];
  const output = Object.assign(new EventEmitter(), { isTTY: true, columns: 160, rows: 35, write() {} });
  const f = dockFixture(t, { outputStream: output, navigationStore: { load: () => null, save: value => saved.push(value) }, previewDebounceMs: 0,
    workspace: {}, bridge: { discover: async () => ({ sessions: [{ id: "codex:local", provider: "codex", name: "Local", cwd: "/tmp/waga-proof-global" }], warnings: [] }),
      preview: async () => { previewStarted(); return { input: "request", output: Array.from({ length: 100 }, (_, i) => `response ${i}`).join("\n") }; } } });
  await setImmediate(); await f.press("down"); await f.press("down"); await ready; await setImmediate();
  await f.press("pagedown");
  await f.press("up"); await f.press("up"); await f.press("return"); await f.press("escape");
  f.input.emit("end"); await f.running;
  assert.ok(saved.at(-1).previewOutputOffset > 0, "returning from the PC list did not reset the response to its beginning");
});

test('update keys select registered PCs and never deploy typed search text', async t => {
  const targets = [];
  const globalDock = new GlobalDock(config, { query: async () => ({ sessions: [], warnings: [] }) });
  const f = dockFixture(t, { globalDock, workspace: {}, hostUpdater: async hosts => { targets.push(hosts.map(host => host.id)); return []; } });
  await setImmediate(); await f.press('return');
  await f.press('u', 'u'); assert.deepEqual(targets, []);
  await f.press('down'); await f.press('u', 'u'); assert.deepEqual(targets, [['home']]);
  await f.press('/', '/'); await f.press('u', 'u'); assert.equal(targets.length, 1);
  await f.press('escape'); await f.press('u', 'U', { shift: true }); assert.deepEqual(targets, [['home'], ['home']]);
});

test('installed update waits for the owning Dock to become visible before reloading, retaining navigation', async t => {
  let visible = false, installed = 'old';
  const reloads = [], saved = [];
  let reloaded;
  const ready = new Promise(resolve => { reloaded = resolve; });
  const f = dockFixture(t, { refreshMs: 10,
    readRelease: () => ({ root: '/waga-proof-install', runningRevision: 'old', installedRevision: installed }),
    navigationStore: { load: () => null, save: state => saved.push(state) },
    workspace: { shouldRefreshOverview: async () => visible, reloadOverview: async release => { reloads.push(release.installedRevision); reloaded(); } } });
  await setImmediate(); installed = 'new';
  await delay(35); assert.deepEqual(reloads, [], 'a native TUI is still active');
  visible = true;
  await Promise.race([ready, delay(1000).then(() => { throw Error('Dock did not reload'); })]);
  assert.deepEqual(reloads, ['new']);
  assert.equal(saved.length, 1);
  f.input.emit('end'); await f.running;
});

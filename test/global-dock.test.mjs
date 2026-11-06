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
import { stripVTControlCharacters } from 'node:util';

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
  let frame = '';
  const input = Object.assign(new EventEmitter(), { isTTY: true, setRawMode() {}, resume() {} });
  const output = Object.assign(new EventEmitter(), { isTTY: true, columns: 120, rows: 30, write(text) { frame = stripVTControlCharacters(text); } });
  const session = { id: "codex:local", provider: "codex", name: "Local", cwd: "/tmp/waga-proof-global", status: "idle" };
  const running = runOverview({ hosts: config, defaultCwd: session.cwd, bridge: { discover: async () => ({ sessions: [session], warnings: [] }) },
    inputStream: input, outputStream: output, errorOutput: { write() {} }, listenForSignals: false, refreshMs: 60_000, ...options });
  t.after(async () => { input.emit("end"); await running; });
  return { input, session, running, frame: () => frame, press: async (name, text = "", extra = {}) => { input.emit("keypress", text, { name, sequence: text, ...extra }); await setImmediate(); } };
}

test('startup combines PCs and Tab and Shift+Tab independently wrap PC and provider filters', async t => {
  const local = ['codex', 'claude'].map(provider => ({ id: `${provider}:same`, nativeId: 'same', provider, cwd: '/same/project', name: `local-${provider}` }));
  const remote = local.map(session => ({ ...session, name: `remote-${session.provider}` }));
  const globalDock = new GlobalDock(config, { query: async () => ({ sessions: remote, warnings: [] }) });
  const f = dockFixture(t, { globalDock, workspace: {}, bridge: { discover: async () => ({ sessions: local, warnings: [] }) } });
  await setImmediate();
  assert.match(f.frame(), /\[전체 PC\]/);
  for (const session of [...local, ...remote]) assert.match(f.frame(), new RegExp(session.name));
  await f.press('tab');
  assert.match(f.frame(), /\[Work\]/); assert.doesNotMatch(f.frame(), /remote-codex|remote-claude/);
  await f.press('tab', '', { shift: true });
  assert.match(f.frame(), /local-codex/); assert.doesNotMatch(f.frame(), /local-claude/);
  await f.press('tab');
  assert.match(f.frame(), /\[Home\]/); assert.match(f.frame(), /remote-codex/); assert.doesNotMatch(f.frame(), /local-codex|remote-claude/);
  await f.press('tab', '', { shift: true });
  assert.match(f.frame(), /remote-claude/); assert.doesNotMatch(f.frame(), /remote-codex/);
  await f.press('tab', '', { shift: true });
  assert.match(f.frame(), /remote-codex/); assert.match(f.frame(), /remote-claude/);
  await f.press('tab');
  assert.match(f.frame(), /\[전체 PC\]/);
  for (const session of [...local, ...remote]) assert.match(f.frame(), new RegExp(session.name));
});

test('same canonical ID and cwd on two PCs open their own session and remote management never uses the local bridge', async t => {
  const session = { id: 'codex:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', nativeId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', provider: 'codex', cwd: '/same/project', name: 'same' };
  let openSession = true;
  const globalDock = new GlobalDock(config, { query: async () => ({ sessions: [session], warnings: [], openSession, createSession: true }) });
  const local = [], remote = [], previews = [];
  const f = dockFixture(t, { globalDock, previewDebounceMs: 0,
    bridge: { discover: async () => ({ sessions: [session], warnings: [] }), preview: async target => { previews.push(target); return {}; },
      rename: () => { throw Error('wrong PC'); }, archive: () => { throw Error('wrong PC'); }, create: () => { throw Error('wrong PC'); } },
    commandFor: target => { local.push(target.id); return {}; },
    workspace: { focusOrOpen: async () => {}, openRemoteHost: async (host, spec) => { remote.push({ host: host.id, spec }); } } });
  await setImmediate(); await f.press('tab'); await f.press('return');
  assert.deepEqual(local, [session.id]);
  await f.press('tab'); await f.press('return');
  assert.equal(remote[0].host, 'home'); assert.equal(remote[0].spec.sessionId, session.id);
  assert.match(remote[0].spec.args.at(-1), new RegExp(`WAGA_OPEN_SESSION=${session.id}`));
  for (const [name, extra] of [['f2', {}], ['x', { meta: true }], ['n', { meta: true }]]) await f.press(name, '', extra);
  assert.deepEqual(local, [session.id]);
  assert.ok(remote.slice(1).every(row => row.host === 'home' && row.spec.sessionId === undefined));
  assert.ok(previews.every(target => !target.hostId));
  openSession = false; await globalDock.refresh();
  const before = remote.length;
  await f.press('return');
  assert.equal(remote.length, before);
  assert.match(f.frame(), /Waga 업데이트가 필요/);
});

test('remote target opens once by exact canonical ID without selecting a PC or session again', async t => {
  const opened = [];
  const f = dockFixture(t, { remoteHost: 'Home', initialSessionId: 'codex:local',
    commandFor: session => { opened.push(session.id); return {}; }, workspace: { focusOrOpen: async () => {} } });
  await setImmediate();
  assert.deepEqual(opened, ['codex:local']);
  await f.press('r', '', { meta: true }); await setImmediate();
  assert.deepEqual(opened, ['codex:local']);
});

test('first connection keeps the account editable on failure, then registers and selects that PC in the unified Dock', async t => {
  const candidate = { ...config.hosts[0], discovered: true };
  const opened = [], accounts = [], updates = [];
  let fail = true, frame = '';
  const dock = new GlobalDock({ ...config, hosts: [candidate] }, { connect: async (host, username) => {
    if (!username) throw Error('Account required');
    accounts.push(username);
    if (fail) throw Error('SSH refused');
    return { host: { ...host, discovered: false, ssh: `${username}@home-box` }, summary: { sessions: [], warnings: [] } };
  } });
  const output = Object.assign(new EventEmitter(), { isTTY: true, columns: 120, rows: 30, write(text) { frame = text; } });
  const f = dockFixture(t, { globalDock: dock, outputStream: output, hostUpdater: async hosts => { updates.push(hosts); return []; }, workspace: { openRemoteHost: async host => { opened.push(host); } } });
  await setImmediate(); assert.doesNotMatch(stripVTControlCharacters(frame), /Home/);
  await f.press('p', '', { meta: true }); await f.press('down'); await f.press('return');
  assert.match(frame, /SSH 계정/);
  await f.press('u', 'ubuntu'); await f.press('return');
  assert.match(frame, /SSH refused/); assert.match(frame, /ubuntu/);
  assert.deepEqual(opened, []); assert.deepEqual(updates, []);
  fail = false; await f.press('return');
  assert.deepEqual(accounts, ['ubuntu', 'ubuntu']);
  assert.equal(opened.length, 0); assert.match(stripVTControlCharacters(frame), /\[Home\]/);
  assert.equal(dock.config.hosts[0].ssh, 'ubuntu@home-box');
});

test('automatic discovery failure preserves known PCs, and offline candidates never start SSH or updates', async t => {
  const known = config.hosts[0], offline = { id: 'off', name: 'Off', ssh: 'off', command: 'waga', discovered: true, online: false };
  const queries = [];
  let fail = false, unavailable = false;
  const dock = new GlobalDock({ ...config, hosts: [known] }, {
    discover: async current => { if (fail) throw Error('Tailscale stopped'); return { ...current, hosts: [known, offline] }; },
    query: async host => { queries.push(host.id); if (unavailable) throw Error('SSH refused'); return { sessions: [], warnings: [] }; },
    connect: async () => { throw Error('must not connect offline'); },
  });
  await dock.refresh(); fail = true; await dock.refresh(() => {}, { force: true });
  assert.deepEqual(queries, ['home', 'home']);
  assert.equal(dock.states.get('off').status, 'offline'); assert.match(dock.discoveryError, /Tailscale stopped/);
  const updates = [];
  const f = dockFixture(t, { globalDock: dock, workspace: {}, hostUpdater: async hosts => { updates.push(hosts.map(row => row.id)); return []; } });
  await setImmediate(); assert.doesNotMatch(f.frame(), /\bOff\b/);
  await f.press('p', '', { meta: true }); assert.match(f.frame(), /\bOff\b/);
  await f.press('u', 'U', { shift: true });
  assert.deepEqual(updates, [['home']]);
  await f.press('escape'); unavailable = true; await dock.refresh(); await f.press('tab');
  assert.doesNotMatch(f.frame(), /Home|\bOff\b/);
  await f.press('p', '', { meta: true }); assert.match(f.frame(), /Home/); assert.match(f.frame(), /\bOff\b/);
});

test('discovered PCs require an explicit account and repeated Enter cannot submit a second connection', async t => {
  const host = { ...config.hosts[0], discovered: true };
  let finish, frame = '', calls = 0;
  const opened = [];
  const dock = new GlobalDock({ ...config, hosts: [host] }, { connect: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  const output = Object.assign(new EventEmitter(), { isTTY: true, columns: 120, rows: 30, write(text) { frame = text; } });
  const f = dockFixture(t, { globalDock: dock, outputStream: output, workspace: { openRemoteHost: async ready => { opened.push(ready.id); } } });
  await setImmediate(); await f.press('return'); await f.press('down'); await f.press('return');
  assert.equal(calls, 0); assert.match(frame, /SSH 계정/);
  await f.press('u', 'ubuntu'); await f.press('return'); await f.press('return');
  assert.equal(calls, 1);
  finish({ host: { ...host, discovered: false }, summary: { sessions: [], warnings: [] } }); await setImmediate();
  assert.equal(calls, 1); assert.deepEqual(opened, []); assert.match(stripVTControlCharacters(frame), /\[Home\]/);
});

test("PC switching preserves local session selection and global search never becomes local native input", async t => {
  const opened = [], native = [];
  const globalDock = new GlobalDock(config, { query: async () => ({ sessions: [], warnings: [] }) });
  const f = dockFixture(t, { globalDock, workspace: { openRemoteHost: async host => { opened.push(host.id); }, focusOrOpen: async session => { native.push(session.id); } }, commandFor: () => ({}) });
  await setImmediate();
  await f.press("down"); await f.press("down"); await f.press("down"); // Settings, PC, project, session.
  await f.press("f4");
  assert.deepEqual(native, [f.session.id]);
  await f.press("up"); await f.press("up"); await f.press("up"); await f.press("return");
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
  await setImmediate(); await f.press("down"); await f.press("down"); await f.press("down"); await ready; await setImmediate();
  await f.press("pagedown");
  await f.press("up"); await f.press("up"); await f.press("up"); await f.press("return"); await f.press("escape");
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

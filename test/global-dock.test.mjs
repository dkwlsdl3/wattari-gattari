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
import headless from '@xterm/headless';

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

function terminalOutput() {
  const terminal = new headless.Terminal({ cols: 190, rows: 48, allowProposedApi: true, convertEol: true });
  const writes = [];
  const output = Object.assign(new EventEmitter(), { isTTY: true, columns: 190, rows: 48,
    write(data) { writes.push(data); terminal.write(data); } });
  return { terminal, output, writes,
    flush: () => new Promise(resolve => terminal.write('\x1b[0m', resolve)),
    frame: () => Array.from({ length: terminal.rows }, (_, row) => terminal.buffer.active.getLine(row).translateToString(true)).join('\n'),
  };
}

test('working status animation updates changed rows without blanking or resending the whole Dock', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const screen = terminalOutput();
  let now = 0, queries = 0, clears = 0, starts = 0, ends = 0;
  screen.terminal.parser.registerCsiHandler({ final: 'J' }, params => {
    if (params[0] === 2 || (params[0] ?? 0) === 0 && screen.terminal.buffer.active.cursorY === 0 && screen.terminal.buffer.active.cursorX === 0) clears++;
    return false;
  });
  screen.terminal.parser.registerCsiHandler({ prefix: '?', final: 'h' }, params => { if (params.includes(2026)) starts++; return false; });
  screen.terminal.parser.registerCsiHandler({ prefix: '?', final: 'l' }, params => { if (params.includes(2026)) ends++; return false; });
  const session = { id: 'codex:working', provider: 'codex', cwd: '/tmp/waga-proof-render', name: 'Local animation', status: 'working' };
  const globalDock = new GlobalDock(config, { query: async () => { queries++; return { sessions: [{ ...session, name: 'Remote animation' }], warnings: [] }; } });
  const f = dockFixture(t, { globalDock, now: () => now, outputStream: screen.output, workspace: {},
    bridge: { discover: async () => { queries++; return { sessions: [session], warnings: [] }; } } });
  t.after(async () => { await screen.flush(); screen.terminal.dispose(); });
  await setImmediate(); await f.press('v', '', { meta: true }); await screen.flush();
  const before = screen.frame();
  const baseline = { clears, starts, ends, queries, writes: screen.writes.length, fullBytes: Buffer.byteLength(screen.writes.at(-1)) };
  now = 120; t.mock.timers.tick(120); await setImmediate(); await screen.flush();
  const after = screen.frame();
  const bytes = screen.writes.slice(baseline.writes).reduce((total, data) => total + Buffer.byteLength(data), 0);
  assert.notEqual(after, before, 'the working indicators still animate');
  assert.equal(clears, baseline.clears, 'animation must not expose a blank screen');
  assert.equal(starts - baseline.starts, 1);
  assert.equal(ends - baseline.ends, 1);
  assert.ok(bytes < baseline.fullBytes / 2, 'an indicator update must not resend unrelated rows');
  assert.equal(queries, baseline.queries, 'animation must not poll providers or PCs');
  t.diagnostic(JSON.stringify({ initialFrameBytes: baseline.fullBytes, animationBytes: bytes, screenClears: clears - baseline.clears }));
});

test('Dock redraws clear old rows across provider filters, PC settings, input, resizing and native return', async t => {
  const screen = terminalOutput();
  const session = { id: 'codex:render', provider: 'codex', cwd: '/tmp/waga-proof-render', name: 'Local preserved row', status: 'idle' };
  const remote = { ...session, id: 'claude:render', provider: 'claude', name: 'Remote preserved row' };
  const globalDock = new GlobalDock(config, { query: async () => ({ sessions: [remote], warnings: [], openSession: true }) });
  const f = dockFixture(t, { globalDock, outputStream: screen.output, commandFor: () => ({}),
    workspace: { focusOrOpen: async () => { screen.terminal.reset(); } },
    bridge: { discover: async () => ({ sessions: [session], warnings: [] }) } });
  t.after(async () => { await screen.flush(); screen.terminal.dispose(); });
  await setImmediate(); await f.press('v', '', { meta: true }); await screen.flush();
  assert.match(screen.frame(), /Local preserved row/); assert.match(screen.frame(), /Remote preserved row/);
  await f.press('tab', '', { shift: true }); await screen.flush();
  assert.match(screen.frame(), /Local preserved row/); assert.doesNotMatch(screen.frame(), /Remote preserved row/);
  await f.press('tab', '', { shift: true }); await screen.flush();
  assert.match(screen.frame(), /Remote preserved row/); assert.doesNotMatch(screen.frame(), /Local preserved row/);
  await f.press('tab', '', { shift: true });
  await f.press('p', '', { meta: true }); await screen.flush();
  assert.match(screen.frame(), /WAGA GLOBAL/);
  assert.doesNotMatch(screen.frame(), /Local preserved row|Remote preserved row/);
  await f.press('escape'); await f.press('n', '', { meta: true }); await screen.flush();
  assert.match(screen.frame(), /새 세션 생성/);
  await f.press(undefined, 'waga-proof-prompt'); await f.press('escape'); await screen.flush();
  assert.doesNotMatch(screen.frame(), /새 세션 생성|waga-proof-prompt/);
  for (const [columns, rows] of [[80, 20], [190, 48]]) {
    screen.terminal.resize(columns, rows); screen.output.columns = columns; screen.output.rows = rows;
    screen.output.emit('resize'); await screen.flush();
    assert.match(screen.frame(), /상태별/);
    assert.match(screen.frame(), /Local preserved row/);
  }
  await f.press('tab'); await f.press('return'); await screen.flush();
  assert.match(screen.frame(), /Local preserved row/);
  assert.doesNotMatch(screen.frame(), /Remote preserved row/);
});

test('recent status changes include hidden PCs without confusing matching native IDs or filters', async t => {
  let now = 0, localStatus = 'working', remoteStatus = 'working';
  const session = { id: 'codex:same', provider: 'codex', cwd: '/work/project', name: 'Local feedback' };
  const globalDock = new GlobalDock(config, { query: async () => ({ sessions: [{ ...session, name: 'Remote feedback', status: remoteStatus }], warnings: [] }) });
  const f = dockFixture(t, { now: () => now, globalDock, workspace: {},
    bridge: { discover: async () => ({ sessions: [{ ...session, status: localStatus }], warnings: [] }) } });
  await setImmediate();
  assert.doesNotMatch(f.frame(), /최근 변경/);
  await f.press('v', '', { meta: true });
  await f.press('tab'); await f.press('tab'); // Only the remote PC is visible.
  await f.press('tab', '', { shift: true });
  assert.doesNotMatch(f.frame(), /최근 변경/);
  now = 1000; localStatus = 'idle';
  await f.press('r', '', { meta: true }); await setImmediate();
  assert.match(f.frame(), /최근 변경: Work \/ project · Local feedback/);
  assert.match(f.frame(), /작업 중 → 대기 · 0초 전/);
  now = 2000; remoteStatus = 'needs-input';
  await f.press('r', '', { meta: true }); await setImmediate();
  assert.match(f.frame(), /최근 변경: Home \/ project · Remote feedback/);
  assert.match(f.frame(), /작업 중 → 입력 필요 · 0초 전/);
});

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

test('PC settings Enter after an update selects a unified PC tab and preserves Tab navigation and selections', async t => {
  const local = ['one', 'two'].map(id => ({ id: `codex:${id}`, provider: 'codex', cwd: '/work/project', name: `local-${id}`, status: 'idle' }));
  const remote = local.map(session => ({ ...session, name: `remote-${session.id}` }));
  const native = [], opened = [], updated = [];
  const dock = new GlobalDock(config, { query: async () => ({ sessions: remote, warnings: [], openSession: true }) });
  const f = dockFixture(t, { globalDock: dock,
    bridge: { discover: async () => ({ sessions: local, warnings: [] }) },
    commandFor: target => { native.push(target.id); return {}; },
    workspace: { focusOrOpen: async () => {}, openRemoteHost: async (host, spec) => { opened.push({ host: host.id, sessionId: spec.sessionId }); } },
    hostUpdater: async targets => { updated.push(targets.map(host => host.id)); return []; },
  });
  await setImmediate();
  await f.press('v', '', { meta: true });
  await f.press('tab'); await f.press('down'); // Keep the second local session selected.
  await f.press('tab', '', { shift: true }); await f.press('down'); // Codex filter, second session again.
  await f.press('p', '', { meta: true }); await f.press('down');
  await f.press('u', 'u'); await f.press('return');
  assert.deepEqual(updated, [['home']]);
  assert.deepEqual(opened, [], 'choosing a PC must not start an SSH management Dock');
  assert.match(f.frame(), /\[Home\]/); assert.match(f.frame(), /제공자: CODEX/);
  assert.doesNotMatch(f.frame(), /WAGA GLOBAL · PC 선택|local-one/);
  await f.press('down'); // Second remote session.
  await f.press('tab');
  assert.match(f.frame(), /\[전체 PC\]/);
  await f.press('tab'); await f.press('return');
  assert.deepEqual(native, ['codex:two'], 'Tab restores the previous local selection');
  await f.press('tab'); await f.press('return');
  assert.deepEqual(opened, [{ host: 'home', sessionId: 'codex:two' }], 'only a session Enter starts SSH with its exact target');
  await f.press('p', '', { meta: true }); await f.press('up'); await f.press('return');
  assert.match(f.frame(), /\[Work\]/);
  assert.doesNotMatch(f.frame(), /remote-codex/);
  await f.press('return');
  assert.deepEqual(native, ['codex:two', 'codex:two'], 'choosing this PC restores its tab and session');
});

test('status mode retains host identity, filters and native Enter/F4 ownership', async t => {
  const session = { id: 'codex:same-canonical-id', provider: 'codex', cwd: '/same/project', name: 'Shared', status: 'idle' };
  const local = [], remote = [];
  let remoteStatus = 'idle';
  const globalDock = new GlobalDock(config, { query: async () => ({ sessions: [{ ...session, status: remoteStatus }], warnings: [], openSession: true }) });
  const f = dockFixture(t, { globalDock,
    bridge: { discover: async () => ({ sessions: [session], warnings: [] }) },
    commandFor: target => { local.push(target.id); return {}; },
    workspace: { focusOrOpen: async () => {}, openRemoteHost: async (host, spec) => { remote.push({ host: host.id, spec }); } } });
  await setImmediate();
  await f.press('v', '', { meta: true });
  assert.doesNotMatch(f.frame(), /▾|▸|━━ \[PC\]/);
  assert.equal((f.frame().match(/Shared/g) ?? []).length, 2);
  await f.press('return'); // A group header must not launch a session.
  await f.press('f4');
  assert.deepEqual(local, []); assert.deepEqual(remote, []);
  await f.press('tab'); // Current PC, first session.
  await f.press('tab', '', { shift: true }); // Codex filter.
  await f.press('return');
  assert.deepEqual(local, [session.id]);
  await f.press('tab'); // Remote PC, same canonical ID.
  await f.press('v', '', { meta: true });
  assert.match(f.frame(), /\[Home\]/); assert.match(f.frame(), /제공자: CODEX/);
  await f.press('v', '', { meta: true });
  remoteStatus = 'needs-input';
  await globalDock.refresh();
  // Repaint after regrouping without choosing another row.
  await f.press('left'); // No tree parent in status mode.
  assert.match(f.frame(), /입력 필요/);
  await f.press('return'); await f.press('f4');
  assert.equal(remote.length, 2);
  assert.ok(remote.every(row => row.host === 'home' && row.spec.sessionId === session.id));
  assert.equal(remote[1].spec.force, true);
  assert.deepEqual(local, [session.id]);
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

test('remote F2 carries the exact rename target and status view into a fresh management screen', async t => {
  const session = { id: 'codex:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', provider: 'codex', cwd: '/remote/project', name: 'Target', status: 'idle' };
  const opened = [];
  let canRename = true;
  const globalDock = new GlobalDock(config, { query: async () => ({ sessions: [session], warnings: [], renameSession: canRename }) });
  const f = dockFixture(t, { globalDock, workspace: { openRemoteHost: async (host, spec) => { opened.push({ host: host.id, spec }); } } });
  await setImmediate();
  await f.press('v', '', { meta: true });
  await f.press('tab'); await f.press('tab');
  await f.press('f2');
  assert.equal(opened.length, 1);
  assert.equal(opened[0].host, 'home');
  assert.equal(opened[0].spec.renameSessionId, session.id);
  assert.equal(opened[0].spec.viewMode, 'status');
  assert.equal(opened[0].spec.force, true, 'a previous management screen must not swallow the edit request');
  assert.equal(opened[0].spec.sessionId, undefined, 'rename must never attach the native TUI');
  canRename = false; await globalDock.refresh();
  await f.press('f2');
  assert.equal(opened.length, 1);
  assert.match(f.frame(), /Waga 업데이트가 필요/);
});

test('remote rename opens once for the exact target despite saved selection; cancel and retry keep the status view', async t => {
  const target = { id: 'codex:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', provider: 'codex', cwd: '/remote/project', name: 'Target', status: 'idle' };
  const other = { ...target, id: 'codex:bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee', name: 'Other' };
  let name = target.name, fail = true;
  const calls = [];
  const f = dockFixture(t, { remoteHost: 'Home', initialRenameId: target.id, initialViewMode: 'status', workspace: {},
    navigationStore: { load: () => ({ selectedKey: other.id, collapsed: [target.cwd], query: 'Other', provider: 'claude', previewOutputOffset: 0 }), save() {} },
    bridge: { discover: async () => ({ sessions: [other, { ...target, name }], warnings: [] }),
      rename: async (id, value) => { calls.push({ id, value }); if (fail) throw Error('rename refused'); name = value; return { target: id, name }; } } });
  await setImmediate();
  assert.match(f.frame(), /\[상태별\]/);
  assert.match(f.frame(), /세션 이름 변경/);
  assert.match(f.frame(), /현재: Target/);
  await f.press('escape');
  await f.press('r', '', { meta: true });
  assert.doesNotMatch(f.frame(), /세션 이름 변경/);
  assert.match(f.frame(), new RegExp(target.id));
  assert.deepEqual(calls, []);
  await f.press('f2'); await f.press('u', '', { ctrl: true }); await f.press('x', 'Renamed'); await f.press('return');
  assert.match(f.frame(), /rename refused/);
  assert.match(f.frame(), /세션 이름 변경/);
  fail = false;
  await f.press('return'); await setImmediate();
  assert.deepEqual(calls, [{ id: target.id, value: 'Renamed' }, { id: target.id, value: 'Renamed' }]);
  assert.match(f.frame(), /\[상태별\]/);
  assert.doesNotMatch(f.frame(), /세션 이름 변경/);
  assert.match(f.frame(), new RegExp(target.id));
});

test('a vanished remote rename target reports its absence without editing another session', async t => {
  const f = dockFixture(t, { remoteHost: 'Home', initialRenameId: 'codex:missing', initialViewMode: 'status', workspace: {} });
  await setImmediate();
  assert.match(f.frame(), /이름을 변경할 세션을 찾지 못했습니다: codex:missing/);
  assert.doesNotMatch(f.frame(), /세션 이름 변경/);
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
  await f.press('down'); await f.press('return');
  assert.match(f.frame(), /WAGA GLOBAL · PC 선택/);
  assert.match(f.frame(), /이 PC의 목록을 조회할 수 없습니다/);
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
  assert.deepEqual(opened, []);
  assert.match(f.frame(), /\[Home\]/);
  assert.deepEqual(native, [f.session.id]);
  await f.press('tab'); // Home -> All, restoring the previous local session.
  await f.press("return");
  assert.deepEqual(native, [f.session.id, f.session.id]);
});

test('remote PC shortcut leaves the management Dock without querying or opening another PC', async t => {
  let leaves = 0, queries = 0, opened = 0;
  const globalDock = new GlobalDock(config, { query: async () => { queries++; return { sessions: [], warnings: [] }; } });
  const f = dockFixture(t, { remoteHost: 'Home', globalDock, workspace: {
    leave: async () => { leaves++; return { closeOverview: true }; },
    openRemoteHost: async () => { opened++; },
  } });
  await setImmediate();
  await f.press('p', '', { meta: true });
  assert.equal(leaves, 1);
  assert.equal(queries, 0);
  assert.equal(opened, 0);
  assert.equal(await f.running, 0);
});

test('independently started Docks keep outbound session access in both directions', async t => {
  const session = { id: 'codex:proof', provider: 'codex', name: 'Proof', cwd: '/tmp/waga-proof-global', status: 'idle' };
  for (const [current, target] of [['Ubuntu', 'Oracle'], ['Oracle', 'Ubuntu']]) {
    const topology = { version: 1, local: { id: current, name: current }, hosts: [{ id: target, name: target, ssh: 'proof-host', command: 'waga' }] };
    const opened = [];
    const globalDock = new GlobalDock(topology, { query: async () => ({ sessions: [session], warnings: [], openSession: true }) });
    const f = dockFixture(t, { hosts: topology, globalDock, remoteHost: null,
      workspace: { openRemoteHost: async (host, spec) => { opened.push({ host: host.id, sessionId: spec.sessionId, force: spec.force }); } } });
    await setImmediate();
    await f.press('tab'); await f.press('tab');
    await f.press('return'); await f.press('f4');
    assert.deepEqual(opened, [
      { host: target, sessionId: session.id, force: false },
      { host: target, sessionId: session.id, force: true },
    ]);
  }
});

test('remote creation keeps Alt+P folder selection and Tab provider selection', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'waga-proof-remote-create-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let leaves = 0;
  const f = dockFixture(t, { remoteHost: 'Home', initialCreate: { provider: 'codex', cwd: root, skipRouting: true },
    workspace: { leave: async () => { leaves++; return { closeOverview: true }; } } });
  await setImmediate();
  await f.press('p', '', { meta: true });
  assert.match(f.frame(), /현재 폴더 선택/);
  assert.equal(leaves, 0);
  await f.press('escape');
  await f.press('tab');
  assert.match(f.frame(), /새 세션 생성\s+◆\s+CLAUDE/);
  assert.equal(leaves, 0);
  await f.press('escape');
  assert.equal(leaves, 1);
  assert.equal(await f.running, 0);
});

test("remote PC back exits only that Dock view without dispatching a native session locally", async t => {
  let leaves = 0;
  const f = dockFixture(t, { remoteHost: "Home", workspace: { leave: async () => { leaves++; return { closeOverview: true }; } }, commandFor: () => { throw Error("must not launch"); } });
  await setImmediate();
  assert.match(f.frame(), /\[Home\]/);
  assert.match(f.frame(), /통합 Dock/);
  await f.press('tab');
  assert.equal(await f.running, 0);
  assert.equal(leaves, 1);
});

test("late host queries and resize never paint over a direct SSH terminal", async t => {
  let finishQuery, finishConnection, writes = 0, queries = 0;
  const summary = { sessions: [{ id: 'codex:remote', provider: 'codex', name: 'Remote', cwd: '/remote' }], warnings: [], openSession: true };
  const globalDock = new GlobalDock(config, { query: () => queries++ === 0 ? Promise.resolve(summary) : new Promise(resolve => { finishQuery = resolve; }) });
  const output = Object.assign(new EventEmitter(), { isTTY: true, columns: 120, rows: 30, write() { writes++; } });
  const f = dockFixture(t, { globalDock, outputStream: output, workspace: { openRemoteHost: () => new Promise(resolve => { finishConnection = resolve; }) } });
  await setImmediate(); await f.press('tab'); await f.press('tab');
  const refreshing = globalDock.refresh();
  await f.press('return'); // Enter the remote native session, not a second PC list.
  const before = writes;
  output.emit("resize"); finishQuery(summary); await refreshing; await setImmediate();
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
  const targets = [], locals = [];
  const globalDock = new GlobalDock(config, { query: async () => ({ sessions: [], warnings: [] }) });
  const f = dockFixture(t, { globalDock, workspace: {}, hostUpdater: async (hosts, options) => { targets.push(hosts.map(host => host.id)); locals.push(options.local); return []; } });
  await setImmediate(); await f.press('return');
  await f.press('u', 'u'); assert.deepEqual(targets, [['home']]);
  await f.press('down'); await f.press('u', 'u'); assert.deepEqual(targets, [['home'], ['home']]);
  await f.press('/', '/'); await f.press('u', 'u'); assert.equal(targets.length, 2);
  await f.press('escape'); await f.press('u', 'U', { shift: true }); assert.deepEqual(targets, [['home'], ['home'], ['home']]);
  assert.deepEqual(locals, [true, false, true]);
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

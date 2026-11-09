import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import pty from 'node-pty';
import xterm from '@xterm/headless';
import { CodexAppServerClient } from '../src/codex-app-server.mjs';
import { nativeAgentsCommand, nativeSessionCommand } from '../src/native-launcher.mjs';
import { retainedCodexViewState } from '../src/providers/codex-view.mjs';
import { CodexProvider } from '../src/providers/codex.mjs';
import { TmuxWorkspace } from '../src/tmux-workspace.mjs';

// Opt in: uses the installed Codex TUI and a private app server, never the user's daemon.
for (const entrypoint of ['resume', 'agents']) test(`Codex ${entrypoint} restores the selected historical session directory`, {
  skip: process.env.WAGA_CODEX_NATIVE_NAV_PROOF !== '1', timeout: 90_000,
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'waga-proof-native-navigation-'));
  const home = path.join(root, 'waga-proof-codex');
  const folders = ['waga-proof-a', 'waga-proof-b'].map(name => path.join(root, name));
  const socket = path.join(root, 'app.sock');
  const tmuxPrefix = ['-S', path.join(root, 'tmux.sock'), '-f', '/dev/null'];
  const dock = 'waga-proof-navigation';
  fs.mkdirSync(home);
  for (const cwd of folders) fs.mkdirSync(cwd);
  fs.copyFileSync(path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'auth.json'), path.join(home, 'auth.json'));
  fs.chmodSync(path.join(home, 'auth.json'), 0o600);
  fs.writeFileSync(path.join(home, 'config.toml'), `check_for_update_on_startup = false\n[tui]\nterminal_title = ["thread-id"]\n${folders.map(cwd => `[projects.${JSON.stringify(cwd)}]\ntrust_level = "trusted"\n`).join('')}`);
  const env = { ...process.env, CODEX_HOME: home, XDG_STATE_HOME: path.join(root, 'waga-proof-state'),
    WAGA_TMUX_SESSION: dock, WAGA_TMUX_MODE: 'isolated', WAGA_TMUX_INDEPENDENT: '1' };
  delete env.TMUX; delete env.TMUX_PANE; delete env.WAGA_REMOTE_HOST;
  const execute = promisify(execFile);
  const tmux = async args => {
    try { return { ...await execute('tmux', [...tmuxPrefix, ...args], { env, timeout: 5000 }), code: 0 }; }
    catch (error) { return { stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? error.message), code: error.code }; }
  };
  const serverLog = fs.openSync(path.join(root, 'server.log'), 'w');
  let server = spawn('codex', ['app-server', '--listen', `unix://${socket}`], { cwd: folders[0], env, stdio: ['ignore', serverLog, serverLog] });
  let serverExit = new Promise(resolve => server.once('exit', resolve));
  let client, frontend, frontendExit;
  const screen = new xterm.Terminal({ cols: 160, rows: 45, allowProposedApi: true });
  // Use xterm's screen/OSC APIs, the same parser as the existing native permission proof.
  const frame = () => Array.from({ length: screen.buffer.active.length }, (_, row) => screen.buffer.active.getLine(row)?.translateToString(true) ?? '').join('\n');
  for (const osc of [10, 11]) screen.parser.registerOscHandler(osc, value => {
    if (value === '?') frontend?.write(`\x1b]${osc};rgb:${osc === 10 ? 'ffff/ffff/ffff' : '0000/0000/0000'}\x07`);
    return true;
  });
  const until = async (read, description, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await read();
      if (value) return value;
      assert.equal(server.exitCode, null, fs.readFileSync(path.join(root, 'server.log'), 'utf8'));
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    fs.writeFileSync('/tmp/waga-proof-codex-navigation-last-frame.txt', frame());
    throw new Error(`${description}\n${frame()}`);
  };
  t.after(async () => {
    frontend?.kill(); await frontendExit;
    await tmux(['kill-server']);
    await client?.close();
    if (server.exitCode === null && server.signalCode === null) server.kill();
    await serverExit;
    fs.closeSync(serverLog); screen.dispose();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });
  await until(() => fs.existsSync(socket), 'private server starts');
  const turns = [];
  const onNotification = ({ method, params }) => {
    if (method === 'turn/completed') turns.push(params);
  };
  client = await CodexAppServerClient.connectUnixWebSocket({ socketPath: socket, onNotification });
  await client.initialize();
  const sessions = [];
  for (const cwd of folders) {
    const { thread } = await client.request('thread/start', { cwd, ephemeral: false });
    const name = path.basename(cwd);
    await client.request('thread/name/set', { threadId: thread.id, name });
    sessions.push({ id: `codex:${thread.id}`, nativeId: thread.id, provider: 'codex', name, cwd });
  }
  // A historical session can take a different resume path from a thread already in memory.
  await client.request('turn/start', { threadId: sessions[1].nativeId, input: [{ type: 'text', text: 'Reply READY.', textElements: [] }] });
  await until(() => turns.length === 1, 'the second session is persisted', 45_000);
  assert.equal(turns[0].turn.status, 'completed');
  const seedTurnId = turns[0].turn.id;
  await client.close();
  server.kill(); await serverExit;
  fs.rmSync(socket, { force: true });
  server = spawn('codex', ['app-server', '--listen', `unix://${socket}`], { cwd: folders[0], env, stdio: ['ignore', serverLog, serverLog] });
  serverExit = new Promise(resolve => server.once('exit', resolve));
  await until(() => fs.existsSync(socket), 'the private server reopens persisted history');
  client = await CodexAppServerClient.connectUnixWebSocket({ socketPath: socket, onNotification });
  await client.initialize();
  assert.equal((await client.request('thread/loaded/list', {})).data.includes(sessions[1].nativeId), false);
  const provider = new CodexProvider();
  provider.daemonInfo = async () => ({ status: 'running', socketPath: socket });
  let spec;
  if (entrypoint === 'resume') spec = await nativeSessionCommand(sessions[0], { codexProvider: provider });
  else {
    await client.request('thread/resume', { threadId: sessions[0].nativeId, excludeTurns: true });
    spec = nativeAgentsCommand('codex', { cwd: folders[0] });
    spec.args.push('--remote', `unix://${socket}`); // Keep this native CLI on the proof's private server.
  }
  assert.equal((await tmux(['new-session', '-d', '-s', dock, '-n', 'overview', '-x', '160', '-y', '45', 'sleep 90'])).code, 0);
  frontend = pty.spawn('tmux', [...tmuxPrefix, 'attach-session', '-t', dock], { cwd: spec.cwd, env, name: 'xterm-256color', cols: 160, rows: 45 });
  frontendExit = new Promise(resolve => frontend.onExit(resolve));
  frontend.onData(data => screen.write(data));
  screen.onData(data => frontend.write(data));
  const workspace = new TmuxWorkspace({ run: tmux, env, eventLog: { record() {} } });
  const opened = await workspace.focusOrOpen(sessions[0], spec);
  const ids = sessions.map(session => session.nativeId);
  const viewState = async id => retainedCodexViewState(id, (await tmux(['display-message', '-p', '-t', opened.windowId, '#{pane_title}'])).stdout, frame(), ids);
  if (entrypoint === 'resume') {
    await until(async () => await viewState(ids[0]) === 'same' && frame().includes('Ask Codex'), 'first session is attached');
    frontend.write('\x1b[D');
  }
  await until(() => frame().includes('Agent command center'), 'Left opens native Agents');
  frontend.write('\x1b[B');
  await until(() => frame().includes('› ● waga-proof-b'), 'the other directory is selected in native Agents');
  frontend.write('\r');
  await until(async () => await viewState(ids[1]) === 'same' && frame().includes('Ask Codex'), 'the selected native session opens');
  const { thread } = await client.request('thread/read', { threadId: ids[1], includeTurns: false });
  t.diagnostic(JSON.stringify({ selectedThread: ids[1], actualThread: thread.id, expectedCwd: folders[1], actualCwd: thread.cwd }));
  assert.equal(thread.id, ids[1]);
  assert.equal(thread.cwd, folders[1]);
  frontend.write('\x1b[200~Run pwd exactly once, then reply with its output only. Do not change directories.\x1b[201~');
  await until(() => frame().includes('Run pwd exactly once'), 'the proof prompt is ready');
  frontend.write('\r');
  const completed = await until(async () => {
    const { thread } = await client.request('thread/read', { threadId: ids[1], includeTurns: true });
    return thread.turns.find(turn => turn.id !== seedTurnId && turn.status === 'completed');
  }, 'the selected session completes the real pwd turn', 45_000);
  const items = await client.request('thread/items/list', { threadId: ids[1], turnId: completed.id, limit: 20 });
  const commands = items.data.filter(entry => entry.item.type === 'commandExecution');
  assert.equal(commands.length, 1);
  t.diagnostic(JSON.stringify({ turnId: completed.id, commandDirectory: commands[0].item.cwd, pwd: commands[0].item.aggregatedOutput }));
  assert.equal(commands[0].item.cwd, folders[1]);
  assert.equal(commands[0].item.aggregatedOutput.trim(), folders[1]);
});

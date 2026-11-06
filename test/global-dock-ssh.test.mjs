import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import pty from "node-pty";
import crypto from 'node:crypto';
import { deployHost } from '../src/host-update.mjs';
import { queryHost } from "../src/global-hosts.mjs";
import { TmuxWorkspace, retainedSessionName, shellCommand } from "../src/tmux-workspace.mjs";

const exec = promisify(execFile);
const hasSshd = fs.existsSync("/usr/sbin/sshd");
const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
async function until(read, expected, description) {
  const deadline = Date.now() + 8000;
  let actual;
  do {
    actual = await read();
    if (actual === expected) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  } while (Date.now() < deadline);
  assert.equal(actual, expected, description);
}

test("real SSH and nested tmux open a remote Dock, route Alt+G and preserve its native process after disconnect", { skip: !hasSshd || !hasTmux, timeout: 45_000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "waga-proof-global-ssh-"));
  const bin = path.join(root, "bin"); fs.mkdirSync(bin);
  const localSocket = `waga-proof-global-local-${process.pid}`;
  const remoteSocket = `waga-proof-global-remote-${process.pid}`;
  let sshd, client, ownerClient;
  t.after(async () => {
    client?.kill();
    ownerClient?.kill();
    for (const socket of [localSocket, remoteSocket]) await exec("tmux", ["-L", socket, "kill-server"]).catch(() => {});
    if (sshd && sshd.exitCode === null && sshd.signalCode === null) {
      const exited = new Promise(resolve => sshd.once("exit", resolve)); sshd.kill(); await exited;
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  for (const key of ["server-key", "client-key"]) await exec("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path.join(root, key)]);
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const serverConfig = path.join(root, "sshd.conf");
  fs.writeFileSync(serverConfig, `Port ${port}\nListenAddress 127.0.0.1\nHostKey ${root}/server-key\nPidFile ${root}/sshd.pid\nAuthorizedKeysFile ${root}/client-key.pub\nStrictModes no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nAllowUsers ${os.userInfo().username}\nLogLevel ERROR\n`);
  await exec("/usr/sbin/sshd", ["-t", "-f", serverConfig]);
  sshd = spawn("/usr/sbin/sshd", ["-D", "-f", serverConfig, "-E", path.join(root, "sshd.log")], { stdio: "ignore" });
  await until(() => new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.end(); resolve(true); });
    socket.once('error', () => resolve(false));
  }), true, 'disposable SSH server is listening');
  const publicKey = fs.readFileSync(`${root}/server-key.pub`, "utf8");
  fs.writeFileSync(path.join(root, "known_hosts"), `waga-proof-global ${publicKey}`);
  const clientConfig = path.join(root, "ssh.conf");
  fs.writeFileSync(clientConfig, `Host waga-proof-global\n HostName 127.0.0.1\n Port ${port}\n User ${os.userInfo().username}\n HostKeyAlias waga-proof-global\n IdentityFile ${root}/client-key\n IdentitiesOnly yes\n UserKnownHostsFile ${root}/known_hosts\n`);
  fs.writeFileSync(path.join(bin, "ssh"), `#!/bin/sh\n${shellCommand("/usr/bin/ssh", ["-F", clientConfig])} "$@"\n`, { mode: 0o700 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_CONFIG_HOME: path.join(root, "config"), XDG_STATE_HOME: path.join(root, "local-state") };
  delete env.TMUX; delete env.TMUX_PANE; delete env.WAGA_REMOTE_HOST; delete env.WAGA_REMOTE_HOST_ID;
  const session = { id: "claude:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", nativeId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", provider: "claude", name: "waga-proof-native", cwd: root, status: "idle" };
  const sibling = { ...session, id: 'claude:bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee', nativeId: 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee', name: 'waga-proof-sibling' };
  const cliUrl = new URL("../src/cli.mjs", import.meta.url).href;
  const overviewUrl = new URL("../src/overview.mjs", import.meta.url).href;
  const workspaceUrl = new URL("../src/tmux-workspace.mjs", import.meta.url).href;
  const dockUrl = new URL("../src/session-dock.mjs", import.meta.url).href;
  const releaseFile = path.join(root, 'remote-release.json');
  fs.mkdirSync(path.join(root, 'managed'));
  fs.writeFileSync(releaseFile, JSON.stringify({ root: path.join(root, 'managed'), installedRevision: 'old' }));
  fs.writeFileSync(path.join(root, 'managed/waga'), `#!/bin/sh\n${shellCommand(process.execPath, [path.join(root, "remote waga's.mjs")])} "$@"\n`, { mode: 0o700 });
  const nativeCode = `process.stdin.setRawMode(true); process.stdin.resume(); require('node:fs').writeFileSync(${JSON.stringify(path.join(root, "native-ready"))},'ready'); process.stdout.write(Array.from({length:100},(_,i)=>'waga-proof-history-'+i+'\\r\\n').join('')+'waga-proof-ready\\r\\n'); process.stdin.on('data', data => require('node:fs').appendFileSync(${JSON.stringify(path.join(root, "native-input"))}, data));`;
  const fixture = path.join(root, "fixture.mjs");
  fs.writeFileSync(fixture, `
    import fs from 'node:fs';
    import {runCli} from ${JSON.stringify(cliUrl)};
    import {runOverview} from ${JSON.stringify(overviewUrl)};
    import {TmuxWorkspace,enterWagaDock} from ${JSON.stringify(workspaceUrl)};
    import {GlobalDock} from ${JSON.stringify(new URL('../src/global-dock.mjs', import.meta.url).href)};
    import {queryHost} from ${JSON.stringify(new URL('../src/global-hosts.mjs', import.meta.url).href)};
    import {enterSessionDock} from ${JSON.stringify(dockUrl)};
    const side = process.env.WAGA_PROOF_SIDE;
    const runningRevision = JSON.parse(fs.readFileSync(${JSON.stringify(releaseFile)})).installedRevision;
    process.env.PATH = ${JSON.stringify(env.PATH)};
    process.env.XDG_CONFIG_HOME = ${JSON.stringify(env.XDG_CONFIG_HOME)};
    process.env.XDG_STATE_HOME = ${JSON.stringify(root)} + '/' + side + '-state';
    const workspace = new TmuxWorkspace({socketName: side === 'remote' ? ${JSON.stringify(remoteSocket)} : ${JSON.stringify(localSocket)}, cliPath: process.argv[1], eventLog: {record(){}}, claudeViewMatches: async () => true});
    const bridge = {discover: async () => {
      if(process.argv[2] === 'overview') fs.writeFileSync(${JSON.stringify(root)} + '/' + side + '-view.json', JSON.stringify({view:process.env.WAGA_TMUX_SESSION}));
      return {sessions: side === 'remote' ? [${JSON.stringify(session)},${JSON.stringify(sibling)}] : [], warnings: []};
    }, create: async (provider,prompt,options) => {
      if(side!=='remote') throw Error('creation reached the wrong PC');
      fs.writeFileSync(${JSON.stringify(path.join(root, 'created.json'))},JSON.stringify({side,provider,prompt,cwd:options.cwd,routing:options.routing}));
      return {provider,nativeId:'waga-proof-created'};
    }, result: async requestId => ({requestId, target:${JSON.stringify(session.id)}, state:'replied', reply:'waga-proof-reply'})};
    const delivery = {enqueue: async (target,payload,options) => {
      fs.writeFileSync(${JSON.stringify(path.join(root, "message.json"))},JSON.stringify({target,payload,kind:options.kind}));
      return {requestId:'aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb',target,delivery:'local-queued'};
    },recover:async()=>{}};
    process.exitCode = await runCli(process.argv.slice(2), {bridge,delivery,globalDockFactory:config=>new GlobalDock(config,{query:async host=>{
      const summary=await queryHost(host); fs.writeFileSync(${JSON.stringify(root)}+'/remote-summary.json',JSON.stringify(summary)); return summary;
    }}),
      tmuxAgentsView: async window => { fs.writeFileSync(${JSON.stringify(path.join(root, "agents-key.json"))},JSON.stringify({side,window})); return {code:0}; },
      dock: options => enterSessionDock({...options,enterTmux: options => enterWagaDock({...options,workspace})}),
      overview: options => runOverview({...options, defaultCwd:${JSON.stringify(root)}, workspace, refreshMs:100,
        readRelease: () => side === 'remote' ? {...JSON.parse(fs.readFileSync(${JSON.stringify(releaseFile)})),runningRevision} : {root:null},
        commandFor: () => ({command:process.execPath,args:['-e',${JSON.stringify(nativeCode)}],cwd:${JSON.stringify(root)}})})
    });
  `);
  const localCli = path.join(root, "local-waga.mjs"), remoteCli = path.join(root, "remote waga's.mjs");
  for (const [file, side] of [[localCli, "local"], [remoteCli, "remote"]]) fs.writeFileSync(file, `#!${process.execPath}\nprocess.env.WAGA_PROOF_SIDE=${JSON.stringify(side)}; await import(${JSON.stringify(new URL(`file://${fixture}`).href)});\n`, { mode: 0o700 });
  const host = { id: "home", name: "Home WSL", ssh: `${os.userInfo().username}@waga-proof-global`, command: remoteCli };
  const hostsFile = path.join(root, "hosts.json");
  fs.writeFileSync(hostsFile, JSON.stringify({ version: 1, local: { id: "work", name: "Work Ubuntu" }, hosts: [host] }));
  const summary = await queryHost(host, { run: (command, args, options) => exec(command, args, { ...options, env }) });
  assert.deepEqual(summary.sessions, [session, sibling], "quoted executable path works over actual SSH");
  const payload = `한글 인계 ' 첫 줄\n둘째 줄 $(touch ${root}/must-not-exist)`;
  const sent = await exec(process.execPath, [localCli, "send", session.id, payload, "--host", "home", "--hosts", hostsFile, "--json"], { env, timeout: 10_000 });
  const receipt = JSON.parse(sent.stdout);
  assert.equal(receipt.delivery, "local-queued");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "message.json"), "utf8")), { target: session.id, payload });
  assert.equal(fs.existsSync(path.join(root, "must-not-exist")), false, "message text is never evaluated by the remote shell");
  const reply = await exec(process.execPath, [localCli, "result", receipt.requestId, "--host", "home", "--hosts", hostsFile, "--json"], { env, timeout: 10_000 });
  assert.equal(JSON.parse(reply.stdout).requestId, receipt.requestId);
  const call = async (socket, ...args) => (await exec("tmux", ["-L", socket, ...args], { env, timeout: 3000 })).stdout.trim();
  const view = side => { try { return JSON.parse(fs.readFileSync(path.join(root, `${side}-view.json`), "utf8")).view; } catch { return null; } };
  client = pty.spawn(process.execPath, [localCli, "--hosts", hostsFile], { cwd: root, env, name: "xterm-256color", cols: 120, rows: 35 });
  // No terminal-output parser: readiness and navigation use JSON and tmux's documented format fields.
  client.onData(() => {});
  await until(() => Boolean(view("local")), true, "local Dock starts");
  await until(() => fs.existsSync(path.join(root, 'remote-summary.json')), true, 'integrated Dock discovers remote sessions');
  client.write("\t\t\r"); // All PCs -> local PC -> remote PC -> exact session.
  await until(() => Boolean(view("remote")), true, "remote Dock starts through SSH");
  const firstView = view("remote");
  const nativeTarget = retainedSessionName(session.id);
  await until(() => call(remoteSocket, "display-message", "-p", "-t", firstView, "#{@waga_session_id}"), session.id, "remote native view selected");
  const nativePid = await call(remoteSocket, "display-message", "-p", "-t", nativeTarget, "#{pane_pid}");
  await until(() => fs.existsSync(path.join(root, "native-ready")), true, "fixture is ready for terminal input");
  const typedInput = "waga-proof-input\r\t\x1b[Z";
  client.write(typedInput);
  await until(() => { try { return fs.readFileSync(path.join(root, "native-input"), "utf8"); } catch { return ""; } }, typedInput, "native input including Tab and Shift+Tab reaches only the remote fixture");
  // Xterm SGR mouse wheel events; inspect tmux's state rather than parsing the PTY output.
  client.write('\x1b[<64;10;10M'.repeat(3));
  await until(async () => Number(await call(remoteSocket, 'display-message', '-p', '-t', nativeTarget, '#{scroll_position}')) > 0, true, 'wheel up reaches remote scrollback');
  assert.equal(await call(localSocket, 'display-message', '-p', '-t', view('local'), '#{pane_in_mode}'), '0', 'the outer SSH pane does not consume scrolling');
  const scrolled = Number(await call(remoteSocket, 'display-message', '-p', '-t', nativeTarget, '#{scroll_position}'));
  client.write('\x1b[<65;10;10M');
  await until(async () => Number(await call(remoteSocket, 'display-message', '-p', '-t', nativeTarget, '#{scroll_position}')) < scrolled, true, 'wheel down moves toward the live prompt');
  await call(remoteSocket, 'send-keys', '-t', nativeTarget, '-X', 'cancel');
  ownerClient = pty.spawn("tmux", ["-L", remoteSocket, "attach-session", "-t", nativeTarget], { cwd: root, env, name: "xterm-256color", cols: 150, rows: 40 });
  ownerClient.onData(() => {});
  await until(() => call(remoteSocket, "display-message", "-p", "-t", nativeTarget, "#{pane_width}"), "150", "the owning PC has its own larger native terminal");
  const originalSize = await call(remoteSocket, "display-message", "-p", "-t", nativeTarget, "#{pane_width},#{pane_height}");
  client.resize(90, 25);
  await until(() => call(remoteSocket, "list-clients", "-t", firstView, "-F", "#{client_width}"), "90", "remote client received the new viewport");
  client.write("resize-proof");
  await until(() => fs.readFileSync(path.join(root, "native-input"), "utf8"), `${typedInput}resize-proof`, "remote activity does not take ownership of the local viewport");
  assert.equal(await call(remoteSocket, "display-message", "-p", "-t", nativeTarget, "#{pane_width},#{pane_height}"), originalSize, "remote viewport does not resize a locally attached provider terminal");
  const ownerExited = new Promise(resolve => ownerClient.onExit(resolve)); ownerClient.kill(); await ownerExited;
  client.write("\x1ba");
  await until(() => { try { return JSON.parse(fs.readFileSync(path.join(root, "agents-key.json"), "utf8")).side; } catch { return null; } }, "remote", "Alt+A also passes through to the owning PC");
  const oldOverviewPid = await call(remoteSocket, 'display-message', '-p', '-t', `${firstView}:overview`, '#{pane_pid}');
  fs.writeFileSync(releaseFile, JSON.stringify({ root: path.join(root, 'managed'), installedRevision: 'new' }));
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(await call(remoteSocket, 'display-message', '-p', '-t', `${firstView}:overview`, '#{pane_pid}'), oldOverviewPid, 'update leaves the native TUI and hidden Dock alone');
  client.write("\x1bg");
  await until(() => call(localSocket, "display-message", "-p", "-t", view('local'), "#{window_name}"), "overview", "Alt+G returns directly to the originating integrated Dock");
  client.write('\x1b[B\r');
  await until(() => view('remote') !== firstView, true, 'another session on the same PC gets its own connection');
  const siblingView = view('remote');
  await until(() => call(remoteSocket, 'display-message', '-p', '-t', siblingView, '#{@waga_session_id}'), sibling.id, 'the second selection opens the second native session');
  client.write('\x1bg');
  await until(() => call(localSocket, 'display-message', '-p', '-t', view('local'), '#{window_name}'), 'overview', 'second remote session returns to the same Dock');
  client.write('\x1b[A\r');
  await until(() => call(localSocket, 'display-message', '-p', '-t', view('local'), '#{window_name}'), 'PC Home WSL', 'original remote session connection is reused');
  assert.equal(await call(remoteSocket, 'display-message', '-p', '-t', firstView, '#{@waga_session_id}'), session.id);
  client.write('\x1bg');
  await until(() => call(localSocket, 'display-message', '-p', '-t', view('local'), '#{window_name}'), 'overview', 'original selection returns again');
  assert.equal(await call(remoteSocket, 'display-message', '-p', '-t', nativeTarget, '#{pane_pid}'), nativePid);
  // Show only this fixture's remote overview to exercise its existing release reload contract.
  await call(remoteSocket, 'select-window', '-t', `${firstView}:overview`);
  await until(() => call(remoteSocket, 'display-message', '-p', '-t', `${firstView}:overview`, '#{@waga_release}'), 'new', 'visible Dock automatically applies the installed release');
  assert.notEqual(await call(remoteSocket, 'display-message', '-p', '-t', `${firstView}:overview`, '#{pane_pid}'), oldOverviewPid);
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(await call(remoteSocket, 'display-message', '-p', '-t', firstView, '#{window_name}'), 'overview', 'a release reload does not repeat the one-time native session open');
  assert.equal(await call(remoteSocket, 'display-message', '-p', '-t', nativeTarget, '#{pane_pid}'), nativePid, 'only the Dock process was replaced');
  await call(remoteSocket, 'kill-session', '-t', firstView);
  assert.equal(await call(remoteSocket, "display-message", "-p", "-t", nativeTarget, "#{pane_pid}"), nativePid);
  const workspace = new TmuxWorkspace({ env: { ...env, WAGA_TMUX_SESSION: view("local") }, eventLog: { record() {} }, run: async args => {
    try { return { ...await exec("tmux", ["-L", localSocket, ...args], { env, timeout: 3000 }), code: 0 }; }
    catch (error) { return { stdout: error.stdout ?? "", stderr: error.stderr ?? "", code: error.code }; }
  } });
  const failed = await workspace.openRemoteHost({ id: "failed", name: "Failed SSH fixture" }, { command: "/bin/sh", args: ["-c", "exit 23"] });
  await until(() => call(localSocket, "display-message", "-p", "-t", failed.windowId, "#{pane_dead_status}"), "23", "failed connection remains visible");
  client.write("\x1bg");
  await until(() => call(localSocket, "display-message", "-p", "-t", view("local"), "#{window_name}"), "overview", "Alt+G can leave a failed connection");
  client.write("\r"); // Integrated selection is still the same exact remote session.
  await until(() => view("remote") !== firstView, true, "remote Dock can reopen");
  await until(() => call(remoteSocket, "display-message", "-p", "-t", view("remote"), "#{@waga_session_id}"), session.id, "saved remote selection opens the original session");
  assert.equal(await call(remoteSocket, "display-message", "-p", "-t", nativeTarget, "#{pane_pid}"), nativePid);
  client.write('\x1bg');
  await until(() => call(localSocket, 'display-message', '-p', '-t', view('local'), '#{window_name}'), 'overview', 'return before creating a remote session');
  client.write('\x1b[A\x1b[A'); // Selected session -> its project -> the remote PC header.
  const beforeCreateView = view('remote');
  client.write('\x1bd');
  await until(() => view('remote') !== beforeCreateView, true, 'Alt+D opens the remote composer');
  const canceledView = view('remote');
  client.write('\x1b');
  await until(() => call(localSocket, 'display-message', '-p', '-t', view('local'), '#{window_name}'), 'overview', 'Escape cancels the remote composer and returns to the originating Dock');
  assert.equal(fs.existsSync(path.join(root, 'created.json')), false);
  client.write('\x1bd');
  await until(() => view('remote') !== canceledView, true, 'Alt+D opens a fresh composer after cancellation');
  client.write('waga-proof-create-prompt\r');
  await until(() => fs.existsSync(path.join(root, 'created.json')), true, 'the prompt directly creates on the owning PC without another Alt+D');
  const created = JSON.parse(fs.readFileSync(path.join(root, 'created.json'), 'utf8'));
  assert.equal(created.side, 'remote'); assert.equal(created.prompt, 'waga-proof-create-prompt'); assert.equal(created.cwd, root);
  assert.match(created.routing.reasons[0], /조회 생략/);
  const exited = new Promise(resolve => client.onExit(resolve)); client.kill(); await exited;
  await until(() => call(remoteSocket, "display-message", "-p", "-t", nativeTarget, "#{session_attached}"), "0", "SSH disconnect detaches its native view");
  assert.equal(await call(remoteSocket, "display-message", "-p", "-t", nativeTarget, "#{pane_pid}"), nativePid);
  assert.doesNotThrow(() => process.kill(Number(nativePid), 0), "native host survives local terminal close");

  // Exercise the real SSH bootstrap and installer with an offline, dependency-free CLI fixture.
  const packageDir = path.join(root, 'deploy-package');
  fs.mkdirSync(packageDir);
  fs.cpSync(new URL('../src', import.meta.url), path.join(packageDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'package.json'), '{"name":"waga-proof-deploy","version":"1.0.0","private":true}');
  await exec('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: packageDir });
  fs.writeFileSync(path.join(packageDir, 'src/cli.mjs'), `import fs from 'node:fs'; import path from 'node:path'; import {fileURLToPath} from 'node:url';
    const p=path.dirname(path.dirname(fileURLToPath(import.meta.url))),m=JSON.parse(fs.readFileSync(path.join(p,'release.json')));
    let active=null;try{active=JSON.parse(fs.readFileSync(path.join(m.root,'current/release.json')));}catch{}
    console.log(JSON.stringify({runningRevision:m.revision,installedRevision:active?.revision??null}));`);
  const archive = path.join(root, 'deploy.tar.gz');
  await exec('tar', ['-czf', archive, '-C', packageDir, '.']);
  const bytes = fs.readFileSync(archive), release = { revision: 'a'.repeat(40), archive: bytes, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  const node = path.join(root, 'proof-node');
  fs.writeFileSync(node, `#!/bin/sh\n${shellCommand('env', [`HOME=${path.join(root, 'deploy-home')}`, process.execPath])} "$@"\n`, { mode: 0o700 });
  const deployed = await deployHost({ ...host, node }, release, { env });
  assert.equal(deployed.state, 'updated');
  assert.equal(JSON.parse((await exec(deployed.command, ['--version', '--json'])).stdout).runningRevision, release.revision);
  assert.equal((await deployHost({ ...host, node }, release, { env })).state, 'current');
  await assert.rejects(deployHost({ ...host, node }, { ...release, sha256: '0'.repeat(64) }, { env }), /checksum mismatch/);
  assert.equal(JSON.parse((await exec(deployed.command, ['--version', '--json'])).stdout).installedRevision, release.revision, 'a rejected SSH transfer does not change the active release');
  assert.equal(await call(remoteSocket, 'display-message', '-p', '-t', nativeTarget, '#{pane_pid}'), nativePid, 'SSH deployment also leaves native sessions alive');
});

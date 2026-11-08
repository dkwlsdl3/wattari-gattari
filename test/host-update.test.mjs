import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { installRelease } from '../src/release-install.mjs';
import { prepareRelease, updateHosts, saveUpdatedHosts } from '../src/host-update.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'waga-proof-update-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const install = path.join(root, 'installed');
  const bundle = (digit, { failInstall = false, failActivation = false, history = Array.from({ length: Number(digit) }, (_, index) => String(Number(digit) - index).repeat(40)) } = {}) => {
    const source = path.join(root, `source-${digit}`);
    fs.mkdirSync(path.join(source, 'src'), { recursive: true });
    fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'waga-proof-release', version: '1.0.0', private: true,
      ...(failInstall ? { scripts: { install: 'exit 17' } } : {}) }));
    if (history !== null) fs.writeFileSync(path.join(source, 'release-history.json'), JSON.stringify({ revision: digit.repeat(40), history }));
    execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: source, stdio: 'ignore' });
    // A disposable CLI, not Claude/Codex. Its real exit status tests activation rollback.
    fs.writeFileSync(path.join(source, 'src/cli.mjs'), `import fs from 'node:fs'; import path from 'node:path'; import {fileURLToPath} from 'node:url';
      const dir=path.dirname(path.dirname(fileURLToPath(import.meta.url))), running=JSON.parse(fs.readFileSync(path.join(dir,'release.json')));
      let installed=null; try {installed=JSON.parse(fs.readFileSync(path.join(running.root,'current/release.json')));}catch(e){if(e.code!=='ENOENT')throw e;}
      if(${failActivation} && installed?.revision===running.revision) process.exit(19);
      if(process.argv[2]==='spawn-provider') {
        const { spawnSync } = await import('node:child_process');
        const r=spawnSync('waga-proof-npm-provider',[],{encoding:'utf8'}); if(r.error) throw r.error; process.stdout.write(r.stdout); process.exit(r.status);
      }
      console.log(JSON.stringify({runningRevision:running.revision,installedRevision:installed?.revision??null}));`);
    const archive = path.join(root, `${digit}.tar.gz`);
    execFileSync('tar', ['-czf', archive, '-C', source, '.']);
    return { source, archive, root: install, binDirectory: path.join(root, 'bin'), revision: digit.repeat(40), sha256: crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex') };
  };
  return { root, install, bundle };
}

test('release switch preserves old files, is idempotent and rolls back an unhealthy activation', t => {
  const f = fixture(t), first = f.bundle('1');
  const receipt = installRelease(first);
  assert.equal(receipt.state, 'updated');
  assert.equal(JSON.parse(execFileSync(receipt.command, ['--version', '--json'], { encoding: 'utf8' })).installedRevision, first.revision);
  assert.equal(JSON.parse(execFileSync(path.join(first.binDirectory, 'waga'), ['--version', '--json'], { encoding: 'utf8' })).installedRevision, first.revision);
  assert.equal(installRelease(first).state, 'current');
  const failed = f.bundle('2', { failActivation: true });
  assert.throws(() => installRelease(failed), /failed/);
  assert.equal(fs.readlinkSync(path.join(f.install, 'current')), `releases/${first.revision}`);
  const next = f.bundle('3');
  assert.equal(installRelease(next).revision, next.revision);
  assert.ok(fs.existsSync(path.join(f.install, 'releases', first.revision, 'src/cli.mjs')), 'running old processes retain their files');
  assert.equal(fs.statSync(path.join(f.install, 'releases', next.revision, 'waga')).mode & 0o777, 0o700);
});

test('a newer installation refuses an older or divergent release before changing current', t => {
  const f = fixture(t), old = f.bundle('1'), latest = f.bundle('3');
  installRelease(old); installRelease(latest);
  assert.throws(() => installRelease(old), /downgrade|후속/);
  assert.throws(() => installRelease(f.bundle('4', { history: ['4'.repeat(40), '1'.repeat(40)] })), /downgrade|후속/);
  assert.throws(() => installRelease(f.bundle('5', { history: null })), /history|이력/);
  assert.throws(() => installRelease(f.bundle('6', { history: ['6'.repeat(40), 'invalid'] })), /history/);
  assert.equal(fs.readlinkSync(path.join(f.install, 'current')), `releases/${latest.revision}`);
});

test('default update fetches main instead of redistributing the initiating PC; archives are reproducible', async t => {
  const f = fixture(t), repository = path.join(f.root, 'origin');
  execFileSync('git', ['init', '-q', '-b', 'main', repository]);
  const commit = text => {
    fs.writeFileSync(path.join(repository, 'file'), text);
    execFileSync('git', ['-C', repository, 'add', 'file']);
    execFileSync('git', ['-C', repository, '-c', 'user.name=waga-proof', '-c', 'user.email=proof@invalid', 'commit', '-qm', text]);
    return execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  };
  const first = commit('old'), latest = commit('latest');
  const gitConfig = path.join(f.root, 'gitconfig');
  fs.writeFileSync(gitConfig, `[url "file://${repository}"]\n insteadOf = https://github.com/dkwlsdl3/wattari-gattari.git\n`);
  const saved = process.env.GIT_CONFIG_GLOBAL; process.env.GIT_CONFIG_GLOBAL = gitConfig;
  t.after(() => { if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = saved; });
  const release = await prepareRelease();
  assert.equal(release.revision, latest);
  assert.deepEqual(JSON.parse(execFileSync('tar', ['-xzOf', '-', 'release-history.json'], { input: release.archive, encoding: 'utf8' })), { revision: latest, history: [latest, first] });
  assert.equal((await prepareRelease()).sha256, release.sha256, 'the same commit has the same archive even from a different clone');
  const shallow = path.join(f.root, 'shallow');
  execFileSync('git', ['clone', '--quiet', '--depth=1', `file://${repository}`, shallow]);
  await assert.rejects(prepareRelease(shallow), /shallow/, 'incomplete commit history cannot authorize upgrades');
  fs.renameSync(repository, `${repository}-offline`);
  await assert.rejects(prepareRelease(), /git|repository|clone/i, 'failure to fetch never falls back to an old installed archive');
});

test('local update prepares once and distributes the candidate; local failure prevents remote deployment', async () => {
  const release = { revision: 'a'.repeat(40) }, host = { id: 'home', command: '/old', ssh: 'home' };
  let preparations = 0, installed = false, deployments = 0;
  const options = { local: true,
    prepare: async () => { preparations++; return release; },
    install: async received => { assert.equal(received, release); installed = true; return { revision: release.revision, state: 'updated' }; },
    deploy: async (_host, received) => { assert.equal(installed, true); assert.equal(received, release); deployments++; return { revision: release.revision, state: 'updated' }; },
  };
  const results = await updateHosts([host], options);
  assert.equal(results[0].local, true); assert.equal(results[1].id, 'home');
  assert.equal(preparations, 1); assert.equal(deployments, 1);
  await assert.rejects(updateHosts([host], { ...options, install: async () => { throw Error('local install failed'); } }), /local install failed/);
  assert.equal(deployments, 1);
});

test('generated launcher exposes the npm global bin to child processes', t => {
  const f = fixture(t), release = f.bundle('1');
  const prefix = path.join(f.root, 'npm global'), bin = path.join(prefix, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'waga-proof-npm-provider'), '#!/bin/sh\necho npm-provider-fixture\n', { mode: 0o755 });
  const saved = process.env.NPM_CONFIG_PREFIX;
  process.env.NPM_CONFIG_PREFIX = prefix;
  let receipt;
  try { receipt = installRelease(release); }
  finally { if (saved === undefined) delete process.env.NPM_CONFIG_PREFIX; else process.env.NPM_CONFIG_PREFIX = saved; }
  assert.ok(!process.env.PATH.split(':').includes(bin));
  assert.equal(execFileSync(receipt.command, ['spawn-provider'], { encoding: 'utf8' }).trim(), 'npm-provider-fixture');
});

test('bad archive and failed dependency installation leave the current launcher untouched', t => {
  const f = fixture(t), first = f.bundle('1');
  installRelease(first);
  const corrupt = f.bundle('2');
  assert.throws(() => installRelease({ ...corrupt, sha256: '0'.repeat(64) }), /checksum/);
  assert.throws(() => installRelease(f.bundle('3', { failInstall: true })), /failed/);
  assert.equal(fs.readlinkSync(path.join(f.install, 'current')), `releases/${first.revision}`);
  const next = f.bundle('4');
  const publicLauncher = path.join(first.binDirectory, 'waga');
  fs.rmSync(publicLauncher); fs.writeFileSync(publicLauncher, 'user executable');
  assert.throws(() => installRelease(next), /Public waga launcher/);
  assert.equal(fs.readFileSync(publicLauncher, 'utf8'), 'user executable');
  assert.equal(fs.readlinkSync(path.join(f.install, 'current')), `releases/${first.revision}`);
});

test('a process holding the installation lock excludes another installer', async t => {
  const f = fixture(t), bundle = f.bundle('1');
  fs.mkdirSync(f.install, { mode: 0o700 });
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import {withFileLock} from ${JSON.stringify(new URL('../src/file-lock.mjs', import.meta.url).href)}; withFileLock(${JSON.stringify(path.join(f.install, 'update'))},()=>{process.stdout.write('locked');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000);});`], { stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = new Promise(resolve => child.once('exit', resolve));
  t.after(async () => { child.kill(); await exited; });
  await new Promise(resolve => child.stdout.once('data', resolve));
  assert.throws(() => installRelease(bundle), { code: 'FILE_LOCK_BUSY' });
  assert.equal(fs.existsSync(path.join(f.install, 'current')), false);
  child.kill(); await exited;
  assert.equal(installRelease(bundle).state, 'updated', 'kernel lock releases on process exit');
});

test('batch update skips failed PCs, preserves stable IDs and refuses to overwrite a changed registration', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'waga-proof-update-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hosts = [{ id: 'off', ssh: 'off', command: '/old/waga' }, { id: 'on', ssh: 'on', command: '/old/waga', name: 'Same name' }];
  const file = path.join(root, 'hosts.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, local: { id: 'local', name: 'Local' }, hosts }));
  const results = await updateHosts(hosts, { prepare: async () => ({ revision: 'a'.repeat(40) }), deploy: async host => {
    if (host.id === 'off') throw Error('offline');
    return { state: 'updated', revision: 'a'.repeat(40), command: '/stable/waga', node: '/node' };
  } });
  assert.deepEqual(results.map(row => row.state), ['failed', 'updated']);
  saveUpdatedHosts(file, results);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).hosts.map(host => [host.id, host.command]), [['off', '/old/waga'], ['on', '/stable/waga']]);
  assert.throws(() => saveUpdatedHosts(file, results), /변경/);
});

test('uncommitted source is not deployed', async t => {
  const f = fixture(t);
  execFileSync('git', ['init', '-q', f.root]);
  fs.writeFileSync(path.join(f.root, 'file'), 'one');
  execFileSync('git', ['-C', f.root, 'add', 'file']);
  execFileSync('git', ['-C', f.root, '-c', 'user.name=waga-proof', '-c', 'user.email=proof@invalid', 'commit', '-qm', 'initial']);
  fs.writeFileSync(path.join(f.root, 'file'), 'two');
  await assert.rejects(prepareRelease(f.root), /커밋/);
});

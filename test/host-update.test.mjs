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
  const bundle = (digit, { failInstall = false, failActivation = false } = {}) => {
    const source = path.join(root, `source-${digit}`);
    fs.mkdirSync(path.join(source, 'src'), { recursive: true });
    fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'waga-proof-release', version: '1.0.0', private: true,
      ...(failInstall ? { scripts: { install: 'exit 17' } } : {}) }));
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
    return { source, archive, root: install, revision: digit.repeat(40), sha256: crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex') };
  };
  return { root, install, bundle };
}

test('release switch preserves old files, is idempotent and rolls back an unhealthy activation', t => {
  const f = fixture(t), first = f.bundle('1');
  const receipt = installRelease(first);
  assert.equal(receipt.state, 'updated');
  assert.equal(JSON.parse(execFileSync(receipt.command, ['--version', '--json'], { encoding: 'utf8' })).installedRevision, first.revision);
  assert.equal(installRelease(first).state, 'current');
  const failed = f.bundle('2', { failActivation: true });
  assert.throws(() => installRelease(failed), /failed/);
  assert.equal(fs.readlinkSync(path.join(f.install, 'current')), `releases/${first.revision}`);
  const next = f.bundle('3');
  assert.equal(installRelease(next).revision, next.revision);
  assert.ok(fs.existsSync(path.join(f.install, 'releases', first.revision, 'src/cli.mjs')), 'running old processes retain their files');
  assert.equal(fs.statSync(path.join(f.install, 'releases', next.revision, 'waga')).mode & 0o777, 0o700);
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

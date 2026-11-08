import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withFileLock } from './file-lock.mjs';
import { quote, shellCommand } from './shell-command.mjs';

const sourceDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let checkoutRevision;
function readManifest(directory) {
  try { return JSON.parse(fs.readFileSync(path.join(directory, 'release.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export function releaseInfo(directory = sourceDirectory) {
  const running = readManifest(directory);
  if (!running && !checkoutRevision) {
    try { checkoutRevision = execFileSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
    catch { checkoutRevision = 'unmanaged'; }
  }
  let installedDirectory = null;
  try { if (running) installedDirectory = fs.realpathSync(path.join(running.root, 'current')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const installed = installedDirectory ? readManifest(installedDirectory) : null;
  return { runningRevision: running?.revision ?? checkoutRevision, installedRevision: installed?.revision ?? null,
    root: running?.root ?? null, installedDirectory, node: installed?.node ?? process.execPath };
}

function checked(command, args, options) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 180_000, maxBuffer: 1024 * 1024, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error(`${command} failed: ${result.stderr?.trim() || result.signal || result.status}`);
  return result.stdout;
}

// Runs only in the verified archive's temporary directory, on the owning PC.
export function installRelease({ archive, sha256, revision, root = path.join(os.homedir(), '.local/share/wattari-gattari'), source = sourceDirectory, binDirectory = path.join(os.homedir(), '.local/bin') }) {
  if (!/^[a-f0-9]{40}$/.test(revision) || !/^[a-f0-9]{64}$/.test(sha256) || !path.isAbsolute(root) || !path.isAbsolute(binDirectory)) throw Error('Invalid release identity');
  if (fs.statSync(archive).size > 64 * 1024 * 1024 || crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex') !== sha256) throw Error('Release checksum mismatch');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const directory = fs.lstatSync(root);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid() || (directory.mode & 0o022)) throw Error('Unsafe installation directory');
  return withFileLock(path.join(root, 'update'), () => {
    const releases = path.join(root, 'releases'), current = path.join(root, 'current'), launcher = path.join(root, 'waga');
    fs.mkdirSync(releases, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(releases).isSymbolicLink()) throw Error('Unsafe releases directory');
    let previous = null;
    try { previous = fs.readlinkSync(current); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const existingLauncher = fs.lstatSync(launcher, { throwIfNoEntry: false });
    if (existingLauncher && (!existingLauncher.isSymbolicLink() || fs.readlinkSync(launcher) !== 'current/waga')) throw Error('Installation launcher is not managed by Waga');
    const publicLauncher = path.join(binDirectory, 'waga');
    const existingPublic = fs.lstatSync(publicLauncher, { throwIfNoEntry: false });
    if (existingPublic && (!existingPublic.isSymbolicLink() || path.resolve(binDirectory, fs.readlinkSync(publicLauncher)) !== launcher)) throw Error('Public waga launcher is not managed by Waga');
    const target = path.join(releases, revision), link = `releases/${revision}`;
    const historyFile = path.join(fs.existsSync(source) ? source : target, 'release-history.json');
    let lineage = null;
    try { lineage = JSON.parse(fs.readFileSync(historyFile, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (lineage && (lineage.revision !== revision || !Array.isArray(lineage.history)
        || lineage.history[0] !== revision || lineage.history.some(id => typeof id !== 'string' || !/^[a-f0-9]{40}$/.test(id)))) throw Error('Invalid release history');
    if (previous && previous !== link) {
      const active = readManifest(current);
      if (!lineage) throw Error('업데이트 이력(history)이 없는 버전은 설치할 수 없습니다.');
      if (!active?.revision || !lineage.history.includes(active.revision)) throw Error('현재 설치본의 후속 커밋이 아닙니다. downgrade 및 다른 Git 이력의 설치를 거부합니다.');
    }
    const env = { ...process.env, PATH: `${path.dirname(process.execPath)}:${path.join(os.homedir(), '.local/bin')}:${process.env.PATH}` };
    if (!fs.existsSync(target)) {
      checked('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: source, env });
      checked(process.execPath, ['--input-type=module', '-e', "import fs from 'node:fs'; const p=JSON.parse(fs.readFileSync('package.json')); for(const name of ['node-pty','@xterm/headless']) if(p.dependencies?.[name]) await import(name);"], { cwd: source, env });
      checked('tmux', ['-V'], { env });
      fs.writeFileSync(path.join(source, 'release.json'), JSON.stringify({ revision, sha256, root, node: process.execPath, installerVersion: 1 }), { mode: 0o600 });
      const npmBin = path.join(checked('npm', ['prefix', '--global'], { env }).trim(), 'bin');
      const prefix = `${path.dirname(process.execPath)}:${path.join(os.homedir(), '.local/bin')}:${npmBin}`;
      fs.writeFileSync(path.join(source, 'waga'), `#!/bin/sh\nPATH=${quote(prefix)}:"$PATH"\nexport PATH\n${shellCommand(process.execPath, [path.join(target, 'src/cli.mjs')])} "$@"\n`, { mode: 0o700 });
      fs.copyFileSync(archive, path.join(source, 'release.tar.gz'));
      fs.renameSync(source, target);
    }
    const manifest = readManifest(target);
    if (fs.lstatSync(target).isSymbolicLink() || manifest?.revision !== revision || manifest.sha256 !== sha256) throw Error('Existing release does not match the requested archive');
    // Check the candidate before touching current. Provider installation is not a health requirement.
    const candidate = JSON.parse(checked(path.join(target, 'waga'), ['--version', '--json'], { env }));
    if (candidate.runningRevision !== revision) throw Error('Candidate release did not identify itself');
    const switchCurrent = destination => {
      const temporary = path.join(root, `.current-${crypto.randomUUID()}`);
      try { fs.symlinkSync(destination, temporary); fs.renameSync(temporary, current); }
      finally { fs.rmSync(temporary, { force: true }); }
    };
    let createdLauncher = false;
    try {
      if (!existingLauncher) { fs.symlinkSync('current/waga', launcher); createdLauncher = true; }
      switchCurrent(link);
      const active = JSON.parse(checked(launcher, ['--version', '--json'], { env }));
      if (active.runningRevision !== revision || active.installedRevision !== revision) throw Error('Activated release did not identify itself');
      if (!existingPublic) {
        fs.mkdirSync(binDirectory, { recursive: true, mode: 0o700 });
        fs.symlinkSync(launcher, publicLauncher);
      }
    } catch (error) {
      if (previous) switchCurrent(previous); else fs.rmSync(current, { force: true });
      if (createdLauncher) fs.rmSync(launcher, { force: true });
      throw error;
    }
    return { revision, command: launcher, node: process.execPath, state: previous === link ? 'current' : 'updated' };
  });
}

if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [archive, sha256, revision, source = sourceDirectory] = process.argv.slice(2);
    process.stdout.write(`${JSON.stringify(installRelease({ archive, sha256, revision, source }))}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}

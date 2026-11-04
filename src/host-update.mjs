import fs from 'node:fs/promises';
import sync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { remoteCommand } from './global-hosts.mjs';
import { shellCommand } from './shell-command.mjs';
import { releaseInfo } from './release-install.mjs';
import { withFileLock } from './file-lock.mjs';

const exec = promisify(execFile);
const sourceDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// The shell handles its own grammar; tar and sha256sum handle the archive.
const bootstrap = `set -eu
umask 077
base="$HOME/.local/share/wattari-gattari"
mkdir -p "$base"
stage=$(mktemp -d "$base/.incoming-XXXXXXXX")
trap 'rm -rf "$stage"' EXIT
cat > "$stage/release.tar.gz"
printf '%s  %s\\n' "$1" "$stage/release.tar.gz" | sha256sum --status -c - || { echo 'Release checksum mismatch' >&2; exit 1; }
mkdir "$stage/package"
tar -xzf "$stage/release.tar.gz" -C "$stage/package"
"$3" "$stage/package/src/release-install.mjs" "$stage/release.tar.gz" "$1" "$2"
`;

export async function prepareRelease(directory = sourceDirectory) {
  const installed = releaseInfo(directory);
  if (installed.root) {
    const activeDirectory = installed.installedDirectory ?? directory;
    const archive = await fs.readFile(path.join(activeDirectory, 'release.tar.gz'));
    const sha256 = crypto.createHash('sha256').update(archive).digest('hex');
    const manifest = JSON.parse(await fs.readFile(path.join(activeDirectory, 'release.json'), 'utf8'));
    if (sha256 !== manifest.sha256) throw Error('Installed source archive checksum mismatch');
    return { revision: manifest.revision, sha256, archive };
  }
  const root = (await exec('git', ['-C', directory, 'rev-parse', '--show-toplevel'])).stdout.trim();
  if (path.resolve(root) !== path.resolve(directory)) throw Error('Updates require the Waga checkout root');
  if ((await exec('git', ['-C', root, 'status', '--porcelain'])).stdout.trim()) throw Error('먼저 Waga 변경을 커밋해 주세요. 원격에는 확정된 버전만 배포합니다.');
  const revision = (await exec('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
  const { stdout: archive } = await exec('git', ['-C', root, 'archive', '--format=tar.gz', revision], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  return { revision, sha256: crypto.createHash('sha256').update(archive).digest('hex'), archive };
}

export function deployHost(host, release, { env = process.env } = {}) {
  const spec = remoteCommand(host);
  spec.args[spec.args.length - 1] = shellCommand('sh', ['-c', bootstrap, 'waga-update', release.sha256, release.revision, host.node ?? 'node']);
  return new Promise((resolve, reject) => {
    const child = execFile(spec.command, spec.args, { env, encoding: 'utf8', timeout: 240_000, killSignal: 'SIGTERM', maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) { reject(Error(error.killed ? '원격 업데이트 응답이 중단됐습니다. 설치 버전을 확인해 주세요.' : stderr.trim() || error.message)); return; }
      try {
        const receipt = JSON.parse(stdout);
        if (receipt.revision !== release.revision || !path.posix.isAbsolute(receipt.command) || !path.posix.isAbsolute(receipt.node) || !['current', 'updated'].includes(receipt.state)) throw Error('Invalid update receipt');
        resolve(receipt);
      } catch (failure) { reject(failure); }
    });
    child.stdin.on('error', () => {}); // An SSH failure is reported by execFile, once.
    child.stdin.end(release.archive);
  });
}

export async function updateHosts(hosts, { prepare = prepareRelease, deploy = deployHost, changed = () => {} } = {}) {
  const release = await prepare(), results = [];
  // One deployment at a time; an unreachable PC does not cancel the others.
  for (const host of hosts) {
    const previous = { command: host.command, node: host.node, ssh: host.ssh };
    changed(host, { state: 'updating', revision: release.revision });
    try {
      const receipt = await deploy(host, release);
      host.command = receipt.command;
      host.node = receipt.node;
      const result = { id: host.id, previous, ...receipt };
      results.push(result); changed(host, result);
    } catch (error) {
      const result = { id: host.id, state: 'failed', revision: release.revision, error: error.message };
      results.push(result); changed(host, result);
    }
  }
  return results;
}

export function saveUpdatedHosts(file, results) {
  const location = file ?? path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'wattari-gattari/hosts.json');
  if (!results.some(row => row.state !== 'failed')) return;
  return withFileLock(location, () => {
    const current = JSON.parse(sync.readFileSync(location, 'utf8'));
    for (const result of results.filter(row => row.state !== 'failed')) {
      const row = current.hosts.find(row => row.id === result.id);
      if (!row || row.ssh !== result.previous.ssh || row.command !== result.previous.command || row.node !== result.previous.node) throw Error('PC 등록이 변경됐습니다. 업데이트된 실행 경로를 확인해 주세요.');
      row.command = result.command; row.node = result.node;
    }
    const temporary = `${location}.${crypto.randomUUID()}.tmp`;
    try { sync.writeFileSync(temporary, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600, flag: 'wx' }); sync.renameSync(temporary, location); }
    finally { sync.rmSync(temporary, { force: true }); }
  });
}

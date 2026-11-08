import fs from 'node:fs/promises';
import sync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { remoteCommand } from './global-hosts.mjs';
import { shellCommand } from './shell-command.mjs';
import { installRelease } from './release-install.mjs';
import { withFileLock } from './file-lock.mjs';

const exec = promisify(execFile);
const repository = 'https://github.com/dkwlsdl3/wattari-gattari.git';
// The shell handles its own grammar; tar and sha256sum handle the archive.
const bootstrap = `set -eu
umask 077
base=$("$3" -e 'process.stdout.write(require("node:path").join(require("node:os").homedir(),".local/share/wattari-gattari"))')
mkdir -p "$base"
stage=$(mktemp -d "$base/.incoming-XXXXXXXX")
trap 'rm -rf "$stage"' EXIT
cat > "$stage/release.tar.gz"
printf '%s  %s\\n' "$1" "$stage/release.tar.gz" | sha256sum --status -c - || { echo 'Release checksum mismatch' >&2; exit 1; }
mkdir "$stage/package"
tar -xzf "$stage/release.tar.gz" -C "$stage/package"
installer="$stage/package/src/release-install.mjs"
if [ -f "$base/current/release.json" ]; then
  guarded=$("$3" -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1])).installerVersion===1?"yes":"no")' "$base/current/release.json")
  if [ "$guarded" = yes ]; then installer="$base/current/src/release-install.mjs"; fi
fi
"$3" "$installer" "$stage/release.tar.gz" "$1" "$2" "$stage/package"
`;

export async function prepareRelease(directory) {
  if (directory === undefined) {
    const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'waga-release-fetch-'));
    try {
      const checkout = path.join(stage, 'checkout');
      await exec('git', ['clone', '--quiet', '--single-branch', '--branch', 'main', repository, checkout], { timeout: 60_000, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
      return await prepareRelease(checkout);
    } finally { await fs.rm(stage, { recursive: true, force: true }); }
  }
  const root = (await exec('git', ['-C', directory, 'rev-parse', '--show-toplevel'])).stdout.trim();
  if (path.resolve(root) !== path.resolve(directory)) throw Error('Updates require the Waga checkout root');
  if ((await exec('git', ['-C', root, 'status', '--porcelain'])).stdout.trim()) throw Error('먼저 Waga 변경을 커밋해 주세요. 원격에는 확정된 버전만 배포합니다.');
  const revision = (await exec('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
  if ((await exec('git', ['-C', root, 'rev-parse', '--is-shallow-repository'])).stdout.trim() === 'true') throw Error('업데이트에는 전체 Git 이력이 필요합니다. shallow clone을 해제해 주세요.');
  const history = (await exec('git', ['-C', root, 'rev-list', revision], { maxBuffer: 4 * 1024 * 1024 })).stdout.trim().split('\n');
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'waga-release-history-'));
  try {
    const file = path.join(stage, 'release-history.json');
    await fs.writeFile(file, JSON.stringify({ revision, history }));
    const { stdout: archive } = await exec('git', ['-C', root, 'archive', '--format=tar.gz', `--add-file=${file}`, revision], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
    return { revision, sha256: crypto.createHash('sha256').update(archive).digest('hex'), archive };
  } finally { await fs.rm(stage, { recursive: true, force: true }); }
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

export async function installLocalRelease(release) {
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'waga-release-'));
  try {
    const archive = path.join(stage, 'release.tar.gz'), source = path.join(stage, 'package');
    await fs.writeFile(archive, release.archive); await fs.mkdir(source);
    await exec('tar', ['-xzf', archive, '-C', source]);
    return installRelease({ archive, source, sha256: release.sha256, revision: release.revision });
  } finally { await fs.rm(stage, { recursive: true, force: true }); }
}

export async function updateHosts(hosts, { local = false, source, prepare = () => prepareRelease(source), deploy = deployHost, install = installLocalRelease, changed = () => {} } = {}) {
  const release = await prepare(), results = [];
  if (local) {
    changed({ id: 'local' }, { state: 'updating', revision: release.revision });
    const result = { id: 'local', local: true, ...await install(release) };
    results.push(result); changed({ id: 'local' }, result);
  }
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
  results = results.filter(row => !row.local);
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

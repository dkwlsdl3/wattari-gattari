import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { isIP } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GlobalDock } from './global-dock.mjs';
import { loadHosts, validateHosts, validateHostStatus, remoteCommand, queryHost } from './global-hosts.mjs';
import { withFileLock } from './file-lock.mjs';

const execute = promisify(execFile);
const options = { encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL' };
// Let the remote shell expand its own HOME. No user shell profiles or provider daemons are started.
const probe = 'if [ -x "$HOME/.local/share/wattari-gattari/waga" ]; then exec "$HOME/.local/share/wattari-gattari/waga" host-status --json; else exec waga host-status --json; fi';

export async function discoverHosts(config, { run = execute } = {}) {
  let data;
  try { data = JSON.parse((await run('tailscale', ['status', '--json'], options)).stdout); }
  catch (error) { if (error.code === 'ENOENT') return config; throw error; }
  if (data.BackendState !== 'Running' || !data.Self?.ID || (data.Peer != null && (typeof data.Peer !== 'object' || Array.isArray(data.Peer)))) throw Error('Tailscale 연결 상태를 확인해 주세요.');
  const local = { ...config.local, tailscaleId: data.Self.ID };
  if (local.id === 'local') {
    local.name = data.Self.DNSName?.split('.')[0] || data.Self.HostName;
    local.type = os.release().toLowerCase().includes('microsoft') ? 'wsl' : 'pc';
  }
  const hosts = config.hosts.map(host => ({ ...host }));
  const resolved = new Map(await Promise.all(hosts.filter(host => !host.discovered && !host.tailscaleId).map(async host => {
    let destination = host.ssh.split('@').at(-1);
    try {
      // OpenSSH resolves its own config grammar; -G exposes one documented hostname field.
      const { stdout } = await run('ssh', ['-G', host.ssh], { ...options, timeout: 2000, maxBuffer: 64 * 1024 });
      destination = /^hostname (.+)$/m.exec(stdout)?.[1] ?? destination;
    } catch { /* Existing direct destinations still work when SSH config lookup is unavailable. */ }
    return [host.id, destination.replace(/\.$/, '').toLowerCase()];
  })));
  for (const peer of Object.values(data.Peer ?? {})) {
    if (peer.ID === data.Self.ID || !['linux', 'windows', 'macOS'].includes(peer.OS)) continue;
    const dns = peer.DNSName?.replace(/\.$/, '');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(dns ?? '') || !/^[a-zA-Z0-9_-]{1,64}$/.test(peer.ID ?? '')) continue;
    const name = dns.split('.')[0];
    const transport = peer.sshHostKeys?.length ? 'tailscale' : undefined;
    const destination = transport ? dns : peer.TailscaleIPs?.find(ip => isIP(ip) === 4) ?? dns;
    const found = hosts.find(host => host.tailscaleId === peer.ID || [dns, name, ...(peer.TailscaleIPs ?? [])].includes(resolved.get(host.id)));
    if (found) {
      found.tailscaleId = peer.ID; found.online = peer.Online === true;
      if (found.discovered) { found.name = name; found.ssh = destination; found.transport = transport; }
      else if (found.transport === 'tailscale') {
        const previous = found.ssh.split('@');
        if (found.name === previous.at(-1).split('.')[0]) found.name = name;
        found.ssh = previous.length > 1 ? `${previous[0]}@${dns}` : dns;
      }
    }
    else if (hosts.length < 16) hosts.push({ id: peer.ID, name, ssh: destination, command: 'waga', ...(transport ? { transport } : {}), tailscaleId: peer.ID, online: peer.Online === true, discovered: true });
  }
  validateHosts({ version: 1, local, hosts });
  return { ...config, local, hosts };
}

export async function connectHost(host, username = os.userInfo().username, { file, config, run = execute } = {}) {
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}$/.test(username)) throw Error('SSH 계정명을 입력해 주세요.');
  const destination = host.ssh.split('@').at(-1);
  const candidate = { ...host, ssh: `${username}@${destination}`, command: 'sh' };
  const local = config?.local ?? { id: 'local', name: os.hostname() };
  validateHosts({ version: 1, local, hosts: [candidate] });
  const spec = remoteCommand(candidate, { args: ['-c', probe] });
  const result = await run(spec.command, spec.args, options);
  const summary = validateHostStatus(JSON.parse(result.stdout));
  const release = summary.release;
  if (!release || typeof release.node !== 'string' || !path.posix.isAbsolute(release.node)
      || (release.root !== null && (typeof release.root !== 'string' || !path.posix.isAbsolute(release.root)))) throw Error('상대 PC의 Waga 응답을 확인할 수 없습니다.');
  const ready = { ...candidate, type: host.type ?? summary.host?.type, command: release.root ? path.posix.join(release.root, 'waga') : 'waga', node: release.node };
  const hostConfig = validateHosts({ version: 1, local, hosts: [ready] });
  const registered = hostConfig.hosts[0];
  const location = file ?? path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'wattari-gattari/hosts.json');
  const stored = withFileLock(location, () => {
    const stat = fs.lstatSync(location, { throwIfNoEntry: false });
    if (stat && (!stat.isFile() || stat.uid !== process.getuid())) throw Error('PC 등록 파일의 소유 정보를 확인해 주세요.');
    let current;
    try { current = loadHosts(location); }
    catch (error) { if (error.code !== 'ENOENT') throw error; current = { version: 1, local: hostConfig.local, hosts: [] }; }
    const existing = current.hosts.findIndex(row => row.id === registered.id || row.tailscaleId && row.tailscaleId === registered.tailscaleId);
    if (existing >= 0) {
      const row = current.hosts[existing];
      if (row.id === registered.id && row.ssh === registered.ssh && row.command === registered.command && row.node === registered.node) return row;
      throw Error('이미 등록되었거나 다른 화면에서 변경한 PC입니다. 목록을 새로고침해 주세요.');
    }
    current.hosts.push(registered);
    const order = new Map((config?.hosts ?? []).map((row, index) => [row.id, index]));
    current.hosts.sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity));
    const body = JSON.stringify(validateHosts(current), null, 2) + '\n';
    const temporary = `${location}.${crypto.randomUUID()}.tmp`;
    try { fs.writeFileSync(temporary, body, { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, location); }
    finally { fs.rmSync(temporary, { force: true }); }
    return registered;
  });
  return { host: stored, summary };
}

export function createGlobalDock(config, { file, run = execute } = {}) {
  return new GlobalDock(config, {
    query: host => queryHost(host, { run }),
    discover: current => {
      const saved = loadHosts(file);
      const hosts = [...saved.hosts, ...current.hosts.filter(host => host.discovered && !saved.hosts.some(row => row.id === host.id || row.tailscaleId === host.tailscaleId))];
      return discoverHosts({ ...saved, hosts }, { run });
    },
    connect: (host, username, current) => connectHost(host, username, { file, config: current, run }),
  });
}

// CLI operations use verified registrations, while following a renamed Tailscale node.
export async function loadConnectedHosts(file, { run = execute } = {}) {
  const config = loadHosts(file);
  if (!config.hosts.some(host => host.transport === 'tailscale')) return config;
  try {
    const found = await discoverHosts(config, { run });
    return { ...found, hosts: found.hosts.filter(host => !host.discovered) };
  } catch { return config; }
}

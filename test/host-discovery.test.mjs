import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverHosts, connectHost, createGlobalDock, loadConnectedHosts } from '../src/host-discovery.mjs';

const status = JSON.parse(fs.readFileSync(new URL('./fixtures/tailscale-status.json', import.meta.url)));
const config = { version: 1, local: { id: 'local', name: 'Local' }, hosts: [] };
const summary = { sessions: [], warnings: [], host: { type: 'wsl' }, release: { root: '/home/proof/waga install', node: '/usr/bin/node', installedRevision: 'a'.repeat(40), docks: [] } };
const response = data => ({ stdout: JSON.stringify(data) });
const candidate = { id: 'proof-oracle', name: 'oracle', ssh: 'oracle.example.ts.net', command: 'waga', transport: 'tailscale', tailscaleId: 'proof-oracle', discovered: true };
function fileFor(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'waga-proof-discovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, 'hosts.json');
}

test('actual Tailscale JSON shape discovers PCs, separates WSL/Windows names, preserves registered IDs and excludes phones', async () => {
  const existing = { ...config, hosts: [{ id: 'oracle', name: 'My VM', type: 'vm', ssh: 'ubuntu@oracle-box', command: '/waga' }] };
  const found = await discoverHosts(existing, { run: async (command, args) => {
    if (command === 'ssh') { assert.deepEqual(args, ['-G', 'ubuntu@oracle-box']); return { stdout: 'user ubuntu\nhostname oracle.example.ts.net\n' }; }
    assert.equal(command, 'tailscale'); assert.deepEqual(args, ['status', '--json']); return response(status);
  } });
  assert.equal(found.local.name, 'work');
  assert.equal(found.local.tailscaleId, 'self-node');
  assert.deepEqual(found.hosts.map(host => host.id), ['oracle', 'proof-home', 'proof-windows', 'proof-mac']);
  assert.equal(found.hosts[0].name, 'My VM');
  assert.equal(found.hosts[0].ssh, 'ubuntu@oracle-box');
  assert.equal(found.hosts[0].type, 'vm');
  assert.equal(found.hosts.at(-1).online, false);
  const again = await discoverHosts(found, { run: async () => response({ ...status, Peer: Object.fromEntries(Object.entries(status.Peer).reverse()) }) });
  assert.deepEqual(again.hosts.map(host => host.id), found.hosts.map(host => host.id), 'refresh never sorts by response or status');
});

test('node identity follows a DNS rename while preserving the configured PC ID and user', async () => {
  const initial = { ...config, hosts: [{ ...candidate, discovered: false, ssh: 'ubuntu@old.example.ts.net', name: 'old' }] };
  const found = await discoverHosts(initial, { run: async () => response(status) });
  assert.equal(found.hosts[0].id, candidate.id);
  assert.equal(found.hosts[0].ssh, 'ubuntu@oracle.example.ts.net');
  assert.equal(found.hosts[0].name, 'oracle');
});

test('missing Tailscale remains optional, an empty tailnet is valid, and malformed state is reported', async () => {
  assert.equal(await discoverHosts(config, { run: async () => { throw Object.assign(Error('missing'), { code: 'ENOENT' }); } }), config);
  assert.deepEqual((await discoverHosts(config, { run: async () => response({ ...status, Peer: null }) })).hosts, []);
  await assert.rejects(discoverHosts(config, { run: async () => response({ BackendState: 'Stopped' }) }), /Tailscale/);
});

test('verified SSH connection registers its real runtime atomically; failed discovery and injected usernames save nothing', async t => {
  const file = fileFor(t);
  const run = async (command, args) => {
    assert.equal(command, 'tailscale'); assert.deepEqual(args.slice(0, 2), ['ssh', 'ubuntu@oracle.example.ts.net']);
    return response(summary);
  };
  await assert.rejects(connectHost(candidate, 'ubuntu;id', { file, run: () => { throw Error('must not execute'); } }), /계정/);
  await assert.rejects(connectHost(candidate, 'ubuntu', { file, run: async () => { throw Error('SSH refused'); } }), /SSH refused/);
  assert.equal(fs.existsSync(file), false);
  const result = await connectHost(candidate, 'ubuntu', { file, run });
  assert.equal(result.host.command, '/home/proof/waga install/waga');
  assert.equal(result.host.node, '/usr/bin/node');
  assert.equal(result.host.type, 'wsl');
  assert.equal(result.host.discovered, undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).hosts, [result.host]);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const edited = JSON.parse(fs.readFileSync(file)); edited.hosts[0].name = 'Custom PC name';
  fs.writeFileSync(file, JSON.stringify(edited));
  const again = await connectHost(candidate, 'ubuntu', { file, run });
  assert.equal(again.host.name, 'Custom PC name', 'another view cannot replace an already saved display name');
  assert.equal(JSON.parse(fs.readFileSync(file)).hosts.length, 1, 'matching concurrent registration is idempotent');
});

test('reverse connection completion preserves discovered order and existing manual settings', async t => {
  const file = fileFor(t), other = { ...candidate, id: 'proof-home', tailscaleId: 'proof-home', name: 'home', ssh: 'home.example.ts.net' };
  const manual = { id: 'manual', name: 'Manual', ssh: 'manual', command: '/waga' };
  fs.writeFileSync(file, JSON.stringify({ ...config, hosts: [manual] }));
  const current = { ...config, hosts: [manual, candidate, other] };
  let finishFirst;
  const first = connectHost(candidate, 'ubuntu', { file, config: current, run: () => new Promise(resolve => { finishFirst = resolve; }) });
  await connectHost(other, 'kth', { file, config: current, run: async () => response(summary) });
  finishFirst(response(summary)); await first;
  const saved = JSON.parse(fs.readFileSync(file));
  assert.deepEqual(saved.hosts.map(host => host.id), ['manual', 'proof-oracle', 'proof-home']);
  assert.deepEqual(saved.hosts[0], manual);
});

test('a provider-less Waga can register, but malformed sessions and unsafe registry files cannot', async t => {
  const file = fileFor(t);
  await assert.rejects(connectHost(candidate, 'ubuntu', { file, run: async () => response({ ...summary, sessions: [{}] }) }), /sessions/);
  assert.equal(fs.existsSync(file), false);
  const providerless = { ...summary, sessions: null, warnings: [{ message: 'Codex unavailable' }] };
  await connectHost(candidate, 'ubuntu', { file, run: async () => response(providerless) });
  const link = `${file}.link`; fs.symlinkSync(file, link);
  await assert.rejects(connectHost(candidate, 'ubuntu', { file: link, run: async () => response(summary) }), /소유/);
});

test('production Dock discovers without attempting an account, connects explicitly, and CLI reads the saved registration', async t => {
  const file = fileFor(t); fs.writeFileSync(file, JSON.stringify(config));
  const onlyOracle = { ...status, Peer: { oracle: status.Peer['0'] } };
  let probes = 0;
  const run = async (command, args) => {
    if (args[0] === 'status') return response(onlyOracle);
    probes++;
    if (args[1] !== 'ubuntu@oracle.example.ts.net') throw Error('Wrong account');
    return response(summary);
  };
  const dock = createGlobalDock(config, { file, run });
  await dock.refresh(); await dock.refresh();
  assert.equal(dock.rows()[1].status, 'setup'); assert.equal(probes, 0);
  await dock.connect('proof-oracle', 'ubuntu');
  assert.equal(dock.rows()[1].status, 'available');
  await dock.refresh(() => {}, { force: true });
  assert.equal(dock.rows().length, 2);
  const saved = await loadConnectedHosts(file, { run });
  assert.equal(saved.hosts[0].ssh, 'ubuntu@oracle.example.ts.net');
  assert.equal(saved.hosts[0].discovered, undefined);
});

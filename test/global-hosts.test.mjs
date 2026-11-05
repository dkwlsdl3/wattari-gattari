import assert from "node:assert/strict";
import test from "node:test";
import { loadHosts, validateHosts, remoteCommand, queryHost } from "../src/global-hosts.mjs";
import { shellCommand } from "../src/tmux-workspace.mjs";

const host = { id: "dev", name: "Dev PC", ssh: "dev-box", command: "/opt/Waga's bin/waga" };
const config = { version: 1, local: { id: "desktop", name: "Desktop" }, hosts: [host] };

test("optional configuration reads no file into existence; explicit missing and relative paths fail", () => {
  const read = () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); };
  assert.deepEqual(loadHosts(undefined, { read }).hosts, []);
  assert.throws(() => loadHosts("/missing", { read }), { code: "ENOENT" });
  assert.throws(() => loadHosts("relative", { read }), { code: "INVALID_HOSTS" });
  let location;
  assert.deepEqual(loadHosts(undefined, { env: { XDG_CONFIG_HOME: "/config" }, read: file => { location = file; return JSON.stringify(config); } }), config);
  assert.equal(location, "/config/wattari-gattari/hosts.json");
});

test("host IDs and SSH aliases are validated rather than interpreted as shell input", () => {
  assert.deepEqual(validateHosts(config), config);
  const typed = { ...config, local: { ...config.local, type: "pc" }, hosts: [{ ...host, type: "wsl" }] };
  assert.deepEqual(validateHosts(typed), typed);
  assert.throws(() => validateHosts({ ...config, hosts: [{ ...host, type: "unknown" }] }), { code: "INVALID_HOSTS" });
  assert.equal(validateHosts({ ...config, hosts: [{ ...host, ssh: "user@home-wsl" }] }).hosts[0].ssh, "user@home-wsl");
  for (const ssh of ["-oProxyCommand=bad", "dev;touch /tmp/bad", "a b", "$(id)", "x\ny"]) {
    assert.throws(() => validateHosts({ ...config, hosts: [{ ...host, ssh }] }), { code: "INVALID_HOSTS" });
  }
  assert.throws(() => validateHosts({ ...config, hosts: [host, host] }), { code: "INVALID_HOSTS" });
  assert.throws(() => validateHosts({ ...config, hosts: [{ ...host, id: "desktop" }] }), { code: "INVALID_HOSTS" });
  for (const id of [123, true, null]) assert.throws(() => validateHosts({ ...config, hosts: [{ ...host, id }] }), { code: "INVALID_HOSTS" });
});

test("SSH uses bounded public JSON command, quoted executable and strict noninteractive authentication", async () => {
  let calls = 0;
  const summary = { sessions: [{ id: "codex:1", name: "proof", cwd: "/project" }], warnings: [] };
  assert.deepEqual(await queryHost(host, { run: async (command, args, options) => {
    calls++;
    assert.equal(command, "ssh");
    assert.ok(args.includes("StrictHostKeyChecking=yes"));
    assert.ok(args.includes("BatchMode=yes"));
    assert.deepEqual(args.slice(-3), ["--", host.ssh, shellCommand(host.command, ["host-status", "--json"])]);
    assert.equal(options.timeout, 10_000);
    assert.equal(options.maxBuffer, 1024 * 1024);
    return { stdout: JSON.stringify(summary) };
  } }), summary);
  assert.equal(calls, 1);
  const spec = remoteCommand(host, { interactive: true });
  assert.equal(spec.args[0], "-tt");
  assert.equal(spec.args.at(-1), shellCommand("env", ["WAGA_REMOTE_HOST=Dev PC", "WAGA_REMOTE_HOST_ID=dev", "WAGA_OPEN_SESSION=", "WAGA_OPEN_FORCE=", host.command, "--backend", "tmux"]));
});

test('old remote Waga falls back only for an unsupported command, and installation status survives missing providers', async () => {
  let calls = 0;
  const old = await queryHost(host, { run: async () => {
    if (++calls === 1) throw Object.assign(Error('unsupported command'), { code: 2 });
    return { stdout: JSON.stringify({ sessions: [], warnings: [] }) };
  } });
  assert.equal(calls, 2); assert.deepEqual(old.sessions, []);
  const release = { installedRevision: 'a'.repeat(40), docks: [{ revision: null }] };
  await assert.rejects(queryHost(host, { run: async () => ({ stdout: JSON.stringify({ sessions: null, warnings: [{ message: 'no providers' }], release }) }) }), error => error.release.installedRevision === release.installedRevision && /providers/.test(error.message));
});

test("failed or malformed remote command is never retried or converted to empty sessions", async () => {
  let calls = 0;
  await assert.rejects(queryHost(host, { run: async () => { calls++; throw new Error("ambiguous disconnect"); } }), /disconnect/);
  assert.equal(calls, 1);
  for (const data of ["not JSON", "null", JSON.stringify({ sessions: [null] }), JSON.stringify({ sessions: [], warnings: [null] }), "{}"])
    await assert.rejects(queryHost(host, { run: async () => ({ stdout: data }) }));
});

test("partial provider discovery remains explicitly partial rather than becoming zero confirmed sessions", async () => {
  const summary = { sessions: [], warnings: [{ provider: "codex", message: "daemon unavailable" }] };
  assert.deepEqual(await queryHost(host, { run: async () => ({ stdout: JSON.stringify(summary) }) }), summary);
});

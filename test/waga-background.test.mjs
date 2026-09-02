import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DAEMON_ENTRY_PATH,
  ensureWagaDaemon,
  migrateLegacyState,
  stopWagaDaemon,
} from "../src/waga-background.mjs";
import { DAEMON_PROTOCOL_VERSION, VERSION } from "../src/product.mjs";

function testPaths(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "waga-daemon-test-"));
  t.after(() => fs.rmSync(root, { recursive: true }));
  const runtimeDirectory = path.join(root, "run");
  const stateDirectory = path.join(root, "state");
  const legacyStateDirectory = path.join(root, "legacy-state");
  return {
    runtimeDirectory,
    stateDirectory,
    controlSocketPath: path.join(runtimeDirectory, "control.sock"),
    daemonPidPath: path.join(runtimeDirectory, "daemon.pid"),
    daemonLogPath: path.join(stateDirectory, "daemon.log"),
    catalogPath: path.join(stateDirectory, "codex-sessions.json"),
    legacyCatalogPath: path.join(runtimeDirectory, "codex-sessions.json"),
    claudeAliasCatalogPath: path.join(stateDirectory, "claude-aliases.json"),
    workspaceRegistryPath: path.join(stateDirectory, "workspaces.json"),
    legacyStatePaths: {
      catalogPath: path.join(legacyStateDirectory, "codex-sessions.json"),
      claudeAliasCatalogPath: path.join(legacyStateDirectory, "claude-aliases.json"),
      workspaceRegistryPath: path.join(legacyStateDirectory, "workspaces.json"),
    },
  };
}

test("starts one detached daemon and reuses its reachable control socket", async (t) => {
  const paths = testPaths(t);
  let reachable = false;
  let starts = 0;
  const first = await ensureWagaDaemon({
    paths,
    probe: async () => reachable,
    inspect: async () => ({ version: VERSION, protocolVersion: DAEMON_PROTOCOL_VERSION }),
    alive: () => true,
    startDaemon: () => {
      starts += 1;
      reachable = true;
      return 4242;
    },
  });
  const second = await ensureWagaDaemon({
    paths,
    probe: async () => true,
    inspect: async () => ({ version: VERSION, protocolVersion: DAEMON_PROTOCOL_VERSION }),
    alive: () => true,
  });
  assert.equal(first.started, true);
  assert.equal(second.started, false);
  assert.equal(starts, 1);
  assert.equal(fs.readFileSync(paths.daemonPidPath, "utf8"), "4242\n");
});

test("migrates the runtime catalog once without deleting the legacy copy", (t) => {
  const paths = testPaths(t);
  fs.mkdirSync(paths.runtimeDirectory, { recursive: true });
  fs.writeFileSync(paths.legacyCatalogPath, "legacy", { mode: 0o600 });
  assert.equal(migrateLegacyState(paths), true);
  assert.equal(migrateLegacyState(paths), false);
  assert.equal(fs.readFileSync(paths.catalogPath, "utf8"), "legacy");
  assert.equal(fs.readFileSync(paths.legacyCatalogPath, "utf8"), "legacy");
});

test("copies durable agent-bus catalogs into Wattari Gattari state once", (t) => {
  const paths = testPaths(t);
  fs.mkdirSync(path.dirname(paths.legacyStatePaths.catalogPath), { recursive: true });
  fs.writeFileSync(paths.legacyStatePaths.catalogPath, "codex", { mode: 0o600 });
  fs.writeFileSync(paths.legacyStatePaths.claudeAliasCatalogPath, "claude", { mode: 0o600 });
  fs.writeFileSync(paths.legacyStatePaths.workspaceRegistryPath, "workspaces", { mode: 0o600 });
  assert.equal(migrateLegacyState(paths), true);
  assert.equal(migrateLegacyState(paths), false);
  assert.equal(fs.readFileSync(paths.catalogPath, "utf8"), "codex");
  assert.equal(fs.readFileSync(paths.claudeAliasCatalogPath, "utf8"), "claude");
  assert.equal(fs.readFileSync(paths.workspaceRegistryPath, "utf8"), "workspaces");
  assert.equal(fs.readFileSync(paths.legacyStatePaths.workspaceRegistryPath, "utf8"), "workspaces");
});

test("refuses to reuse a daemon from a different installed version", async (t) => {
  const paths = testPaths(t);
  await assert.rejects(ensureWagaDaemon({
    paths,
    probe: async () => true,
    inspect: async () => ({ version: "0.1.0", protocolVersion: DAEMON_PROTOCOL_VERSION }),
  }), { code: "DAEMON_VERSION_MISMATCH" });
});

test("refuses to reuse stale code under the same package version", async (t) => {
  const paths = testPaths(t);
  await assert.rejects(ensureWagaDaemon({
    paths,
    probe: async () => true,
    inspect: async () => ({ version: VERSION, protocolVersion: DAEMON_PROTOCOL_VERSION - 1 }),
  }), { code: "DAEMON_VERSION_MISMATCH" });
});

test("never replaces an unreachable socket when a sandbox cannot see the host pid", async (t) => {
  const paths = testPaths(t);
  fs.mkdirSync(paths.runtimeDirectory, { recursive: true });
  fs.writeFileSync(paths.daemonPidPath, "4242\n", { mode: 0o600 });
  fs.writeFileSync(paths.controlSocketPath, "host socket placeholder", { mode: 0o600 });
  let starts = 0;

  await assert.rejects(ensureWagaDaemon({
    paths,
    probe: async () => false,
    alive: () => false,
    startDaemon: () => { starts += 1; return 9999; },
  }), /Refusing to replace an unreachable control socket/);

  assert.equal(starts, 0);
  assert.equal(fs.readFileSync(paths.daemonPidPath, "utf8"), "4242\n");
  assert.equal(fs.readFileSync(paths.controlSocketPath, "utf8"), "host socket placeholder");
});

test("stops only a verified daemon through its control interface", async (t) => {
  const paths = testPaths(t);
  fs.mkdirSync(paths.runtimeDirectory, { recursive: true });
  fs.writeFileSync(paths.daemonPidPath, "4242\n", { mode: 0o600 });
  let alive = true;
  let requested = 0;
  const result = await stopWagaDaemon({
    paths,
    alive: () => alive,
    probe: async () => alive,
    readCommandLine: () => [process.execPath, DAEMON_ENTRY_PATH],
    requestShutdown: async () => {
      requested += 1;
      alive = false;
    },
    wait: async () => {},
  });
  assert.deepEqual(result, { stopped: true, pid: 4242 });
  assert.equal(requested, 1);
});

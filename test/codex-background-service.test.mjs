import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ensureManagedCodexService,
  stopManagedCodexService,
} from "../src/codex-background-service.mjs";

function testPaths(directory) {
  return {
    directory,
    socketPath: path.join(directory, "codex.sock"),
    pidPath: path.join(directory, "codex.pid"),
    logPath: path.join(directory, "codex.log"),
    catalogPath: path.join(directory, "codex-sessions.json"),
    approvalSocketPath: path.join(directory, "approval.sock"),
  };
}

test("reuses an already reachable background service", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "waga-service-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true }));
  let starts = 0;
  const result = await ensureManagedCodexService({
    paths: testPaths(directory),
    probe: async () => true,
    startServer: () => {
      starts += 1;
      return 999;
    },
  });
  assert.equal(result.started, false);
  assert.equal(starts, 0);
});

test("starts a detached socket service and records its pid", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "waga-service-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true }));
  const paths = testPaths(directory);
  let started = false;
  let seenArgs;
  let seenOptions;
  const result = await ensureManagedCodexService({
    paths,
    configPath: "/missing/config.toml",
    probe: async () => started,
    startServer: (args, options) => {
      seenArgs = args;
      seenOptions = options;
      started = true;
      return process.pid;
    },
  });
  assert.equal(result.started, true);
  assert.equal(fs.readFileSync(paths.pidPath, "utf8"), `${process.pid}\n`);
  assert.deepEqual(seenArgs.slice(0, 4), [
    "--dangerously-bypass-hook-trust",
    "app-server",
    "--listen",
    `unix://${paths.socketPath}`,
  ]);
  assert.equal(seenOptions.approvalSocketPath, paths.approvalSocketPath);
});

test("stops only the recorded managed app-server process and keeps its catalog", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "waga-service-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true }));
  const paths = testPaths(directory);
  fs.writeFileSync(paths.pidPath, "4242\n");
  fs.writeFileSync(paths.socketPath, "socket placeholder");
  fs.writeFileSync(paths.catalogPath, "catalog");
  let alive = true;
  let signal;

  const result = await stopManagedCodexService({
    paths,
    readCommandLine: () => [
      "/usr/bin/codex",
      "--dangerously-bypass-hook-trust",
      "app-server",
      "--listen",
      `unix://${paths.socketPath}`,
    ],
    processAlive: () => alive,
    signalProcess: (pid, nextSignal) => {
      signal = [pid, nextSignal];
      alive = false;
    },
    probe: async () => alive,
    wait: async () => {},
  });

  assert.deepEqual(signal, [4242, "SIGTERM"]);
  assert.deepEqual(result, { stopped: true, pid: 4242 });
  assert.equal(fs.existsSync(paths.pidPath), false);
  assert.equal(fs.existsSync(paths.socketPath), false);
  assert.equal(fs.readFileSync(paths.catalogPath, "utf8"), "catalog");
});

test("refuses to signal a pid that is not the recorded managed app-server", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "waga-service-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true }));
  const paths = testPaths(directory);
  fs.writeFileSync(paths.pidPath, "4242\n");
  let signalled = false;

  await assert.rejects(
    stopManagedCodexService({
      paths,
      readCommandLine: () => ["/usr/bin/something-else"],
      processAlive: () => true,
      signalProcess: () => {
        signalled = true;
      },
      probe: async () => true,
      wait: async () => {},
    }),
    /Refusing to stop unverified process 4242/,
  );
  assert.equal(signalled, false);
});

test("refuses a reachable background socket when its ownership pid is missing", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "waga-service-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true }));
  const paths = testPaths(directory);

  await assert.rejects(
    stopManagedCodexService({ paths, probe: async () => true }),
    /without a recorded pid/,
  );
});

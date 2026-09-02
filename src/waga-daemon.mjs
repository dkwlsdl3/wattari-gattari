#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { WagaHost } from "./waga-host.mjs";
import { HostPeerAdapter } from "./adapters/host-peer.mjs";
import { appPaths } from "./app-paths.mjs";
import { ApprovalServer } from "./approval-server.mjs";
import { Broker } from "./broker.mjs";
import { ensureManagedCodexService, stopManagedCodexService } from "./codex-background-service.mjs";
import { CodexSessionService } from "./codex-session-service.mjs";
import { ClaudeSessionService } from "./claude-session-service.mjs";
import { ControlServer } from "./control-server.mjs";
import { DirectApprovalLedger } from "./direct-approval-ledger.mjs";
import { WorkspaceRegistry } from "./workspace-registry.mjs";
import { UnifiedSessionService } from "./unified-session-service.mjs";

async function createDaemonRuntime(paths) {
  const codex = await ensureManagedCodexService({ cwd: os.homedir(), paths });
  const approvalLedger = new DirectApprovalLedger();
  const host = new WagaHost({
    registry: new WorkspaceRegistry(paths.workspaceRegistryPath),
    approvalServer: new ApprovalServer(paths.approvalSocketPath),
    approvalLedger,
    sessionFactory: (workspacePath, { onServerRequest }) => new UnifiedSessionService({
      codex: new CodexSessionService({
        cwd: workspacePath,
        socketPath: codex.socketPath,
        catalogPath: codex.catalogPath,
        onServerRequest,
      }),
      claude: new ClaudeSessionService({
        cwd: workspacePath,
        aliasCatalogPath: paths.claudeAliasCatalogPath,
      }),
    }),
  });
  return {
    host,
    control: new ControlServer({ socketPath: paths.controlSocketPath, host }),
    broker: new Broker({
      socketPath: paths.busSocketPath,
      adapters: [
        new HostPeerAdapter({ provider: "codex", host }),
        new HostPeerAdapter({ provider: "claude", host }),
      ],
    }),
    stopCodex: () => stopManagedCodexService({ paths }),
  };
}

export async function startWagaDaemon({
  paths = appPaths(),
  createRuntime = createDaemonRuntime,
  errorOutput = process.stderr,
} = {}) {
  fs.mkdirSync(paths.stateDirectory, { recursive: true, mode: 0o700 });
  const runtime = await createRuntime(paths);
  let closing = null;

  const close = (exitCode = 0) => {
    if (closing) return closing;
    closing = (async () => {
      await runtime.control.close().catch(() => {});
      await runtime.broker.close().catch(() => {});
      await runtime.host.close().catch(() => {});
      await runtime.stopCodex().catch(() => {});
      if (fs.existsSync(paths.daemonPidPath)) {
        const recorded = Number.parseInt(fs.readFileSync(paths.daemonPidPath, "utf8").trim(), 10);
        if (recorded === process.pid) fs.unlinkSync(paths.daemonPidPath);
      }
      return { exitCode };
    })();
    return closing;
  };

  runtime.host.on?.("error", (error) => errorOutput.write(`${error.stack ?? error.message}\n`));
  runtime.host.on?.("shutdownRequested", () => void close());
  try {
    await runtime.host.start();
    await runtime.broker.start();
    await runtime.control.start();
  } catch (error) {
    await close(1);
    throw error;
  }
  return { close, runtime };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const daemon = await startWagaDaemon();
  const shutdown = (exitCode) => {
    void daemon.close(exitCode).then((result) => { process.exitCode = result.exitCode; });
  };
  process.on("SIGTERM", () => shutdown(143));
  process.on("SIGINT", () => shutdown(130));
}

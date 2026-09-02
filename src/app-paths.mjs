import os from "node:os";
import path from "node:path";

import { APP_ID, LEGACY_APP_ID } from "./product.mjs";

export function appPaths(env = process.env, homeDirectory = os.homedir()) {
  const runtimeBase = env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;
  const stateBase = env.XDG_STATE_HOME || path.join(homeDirectory, ".local", "state");
  const runtimeDirectory = path.join(runtimeBase, APP_ID);
  const stateDirectory = path.join(stateBase, APP_ID);
  const legacyRuntimeDirectory = path.join(runtimeBase, LEGACY_APP_ID);
  const legacyStateDirectory = path.join(stateBase, LEGACY_APP_ID);
  return {
    directory: runtimeDirectory,
    runtimeDirectory,
    stateDirectory,
    controlSocketPath: path.join(runtimeDirectory, "control.sock"),
    busSocketPath: path.join(runtimeDirectory, "bus.sock"),
    daemonPidPath: path.join(runtimeDirectory, "daemon.pid"),
    daemonLogPath: path.join(stateDirectory, "logs", "daemon.log"),
    socketPath: path.join(runtimeDirectory, "codex-app-server.sock"),
    pidPath: path.join(runtimeDirectory, "codex-app-server.pid"),
    logPath: path.join(stateDirectory, "logs", "codex-app-server.log"),
    catalogPath: path.join(stateDirectory, "codex-sessions.json"),
    claudeAliasCatalogPath: path.join(stateDirectory, "claude-aliases.json"),
    workspaceRegistryPath: path.join(stateDirectory, "workspaces.json"),
    approvalSocketPath: path.join(runtimeDirectory, "approval.sock"),
    legacyCatalogPath: path.join(legacyRuntimeDirectory, "codex-sessions.json"),
    legacyStatePaths: {
      catalogPath: path.join(legacyStateDirectory, "codex-sessions.json"),
      claudeAliasCatalogPath: path.join(legacyStateDirectory, "claude-aliases.json"),
      workspaceRegistryPath: path.join(legacyStateDirectory, "workspaces.json"),
    },
  };
}

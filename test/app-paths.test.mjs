import assert from "node:assert/strict";
import test from "node:test";

import { appPaths } from "../src/app-paths.mjs";

test("separates ephemeral sockets from durable catalogs and logs", () => {
  const paths = appPaths({ XDG_RUNTIME_DIR: "/runtime", XDG_STATE_HOME: "/state" }, "/home/test");
  assert.equal(paths.controlSocketPath, "/runtime/wattari-gattari/control.sock");
  assert.equal(paths.busSocketPath, "/runtime/wattari-gattari/bus.sock");
  assert.equal(paths.workspaceRegistryPath, "/state/wattari-gattari/workspaces.json");
  assert.equal(paths.catalogPath, "/state/wattari-gattari/codex-sessions.json");
  assert.equal(paths.claudeAliasCatalogPath, "/state/wattari-gattari/claude-aliases.json");
  assert.equal(paths.daemonLogPath, "/state/wattari-gattari/logs/daemon.log");
  assert.equal(paths.legacyStatePaths.workspaceRegistryPath, "/state/agent-bus/workspaces.json");
});

#!/usr/bin/env node

import { runSessionConsole } from "../src/global-session-console.mjs";
import { DemoControlClient } from "./demo-control-client.mjs";

const result = await runSessionConsole({
  paths: { controlSocketPath: "/demo/wattari-gattari.sock" },
  ensureDaemon: async () => {},
  createClient: () => new DemoControlClient(),
  workspacePath: "/demo/sample-app",
});

process.exitCode = result.exitCode;

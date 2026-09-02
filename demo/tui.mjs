#!/usr/bin/env node

import { runSessionConsole } from "../src/global-session-console.mjs";
import { DemoControlClient } from "./demo-control-client.mjs";

const result = await runSessionConsole({
  paths: { controlSocketPath: "/demo/wattari-gattari.sock", socketPath: "/demo/codex.sock" },
  ensureDaemon: async () => {},
  createClient: () => new DemoControlClient(),
  launchNative: async ({ provider, session }) => {
    const name = session?.name ?? `New ${provider} session`;
    process.stdout.write(`\x1b[2J\x1b[HNative ${session?.provider ?? provider} TUI\n\n  ${name}\n\n  Conversation, slash commands, approvals, and scrolling live here.\n`);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    return { exitCode: 0, signal: null };
  },
  workspacePath: "/demo/sample-app",
});

process.exitCode = result.exitCode;

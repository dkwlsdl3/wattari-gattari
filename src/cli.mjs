#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseCliArgs } from "./cli-options.mjs";
import { DockOrderStore } from "./dock-order.mjs";
import { runDoctor } from "./doctor.mjs";
import { fallbackRouting } from "./model-router.mjs";
import { LocalRouterClient } from "./local-router-client.mjs";
import { openNativeAgents } from "./native-launcher.mjs";
import { runOverview } from "./overview.mjs";
import { CLI_NAME, VERSION } from "./product.mjs";
import { ClaudeProvider } from "./providers/claude.mjs";
import { CodexProvider } from "./providers/codex.mjs";
import { RequestStore } from "./request-store.mjs";
import { SessionBridge } from "./session-bridge.mjs";
import { enterSessionDock } from "./session-dock.mjs";
import { TmuxWorkspace } from "./tmux-workspace.mjs";
import { WagaSettingsStore } from "./waga-settings.mjs";

function usage() {
  return [
    `${CLI_NAME} [--cwd PATH] [--backend auto|direct|tmux]`,
    "                                Open the global dock, optionally filtered by workspace",
    `${CLI_NAME} list [--provider claude|codex] [--cwd PATH] [--json]`,
    `${CLI_NAME} send <session-id-or-name> <message> [--cwd PATH]    One-way notification`,
    `${CLI_NAME} ask <session-id-or-name> <message> [--until-idle] [--wait-timeout SEC] [--reply-timeout SEC] [--cwd PATH]`,
    `${CLI_NAME} result <request-id> [--json]    Read an existing request; never resend`,
    "                                ask: busy wait 1800s; reply wait 180s. Use explicit timeouts for long work.",
    `${CLI_NAME} open <claude|codex> [--cwd PATH]`,
    `${CLI_NAME} doctor`,
    `${CLI_NAME} --version`,
  ].join("\n");
}

function defaultBridge() {
  const localRouter = new LocalRouterClient();
  return new SessionBridge({
    providers: [new ClaudeProvider(), new CodexProvider()],
    requestStore: new RequestStore(),
    router: fallbackRouting,
    createRouter: async (input) => {
      try {
        return await localRouter.route(input);
      } catch (error) {
        return { ...fallbackRouting(input), warnings: [error.message] };
      }
    },
  });
}

async function openTmuxAgentsView(windowId) {
  return new TmuxWorkspace().focusAgentsViewFromWindow(windowId, process.env.WAGA_TMUX_TARGET_SESSION ?? null);
}

function writeList(output, errorOutput, { sessions, warnings }, json) {
  if (json) {
    output.write(`${JSON.stringify({ sessions, warnings }, null, 2)}\n`);
    return;
  }
  const field = (value) => String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
  for (const session of sessions) output.write(`${[session.id, session.status, session.name, session.cwd].map(field).join("\t")}\n`);
  for (const warning of warnings) errorOutput.write(`warning\t${field(warning.provider)}\t${field(warning.message)}\n`);
}

export async function runCli(args = process.argv.slice(2), {
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  bridge = defaultBridge(),
  doctor = runDoctor,
  launcher = openNativeAgents,
  dock = enterSessionDock,
  overview = runOverview,
  tmuxAgentsView = openTmuxAgentsView,
  orderStore = new DockOrderStore(),
  settingsStore = new WagaSettingsStore(),
  handleSignals = false,
} = {}) {
  let options;
  try { options = parseCliArgs(args); }
  catch (error) { stderr.write(`${error.message}\n${usage()}\n`); return 2; }

  const cwd = path.resolve(options.cwd ?? process.cwd());
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    stderr.write(`Workspace is not a directory: ${cwd}\n`);
    return 2;
  }

  let lastProgress;
  const progress = ({ state, target, requestId, delivery }) => {
    lastProgress = { state, target, requestId, delivery };
    const explanation = {
      "not-sent": "not sent", "waiting-local": "not sent; waiting behind another Waga request",
      waiting: "not sent; target busy", submitting: "submission in progress; delivery unknown",
      submitted: delivery === "accepted" ? "native submission acknowledged" : "written; receiver acceptance unconfirmed",
      accepted: "receiver acknowledged", "reply-received": "reply received; waiting for idle", working: "reply received; target still busy",
      replied: "reply ready",
    }[state] ?? state;
    stderr.write(`status\t${state}\t${target}\t${requestId ?? "-"}\t${explanation}\n`);
  };
  const signals = new Map();
  if (handleSignals && ["ask", "send"].includes(options.command)) {
    for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
      const stop = () => {
        if (lastProgress?.requestId) stderr.write(`REQUEST_INTERRUPTED: delivery=${lastProgress.delivery}; inspect without resending: ${CLI_NAME} result ${lastProgress.requestId}\n`);
        // process.exit emits the exit hook that removes our ephemeral Claude
        // identity. No native target is interrupted; the request record survives.
        process.exit(code);
      };
      signals.set(signal, stop);
      process.once(signal, stop);
    }
  }
  try {
    if (options.command === "version") stdout.write(`${VERSION}\n`);
    else if (options.command === "help") stdout.write(`${usage()}\n`);
    else if (options.command === "doctor") return (await doctor({ output: stdout, cwd })).exitCode;
    else if (options.command === "default" && stdin.isTTY && stdout.isTTY) return (await dock({
      cwd,
      filterCwd: options.cwd ? cwd : null,
      backend: options.backend,
      bridge,
      inputStream: stdin,
      outputStream: stdout,
      errorOutput: stderr,
      orderStore,
      settingsStore,
    })).code;
    else if (options.command === "overview") return await overview({ filterCwd: options.cwd ? cwd : null, defaultCwd: cwd, bridge, inputStream: stdin, outputStream: stdout, errorOutput: stderr, orderStore, settingsStore });
    else if (options.command === "tmux-agents-view") return (await tmuxAgentsView(options.windowId)).code ?? 0;
    else if (options.command === "list" || options.command === "default") writeList(stdout, stderr, await bridge.discover({ provider: options.provider, cwd: options.cwd ? cwd : undefined }), options.json);
    else if (options.command === "send") {
      const result = await bridge.send(options.target, options.message, { cwd: options.cwd ? cwd : undefined, onProgress: progress, waitTimeoutMs: options.waitTimeoutMs });
      stdout.write(options.json ? `${JSON.stringify(result)}\n` : `${result.delivery ?? "submitted"}\t${result.target}\t${result.requestId}\n`);
    } else if (options.command === "ask") {
      const result = await bridge.ask(options.target, options.message, {
        cwd: options.cwd ? cwd : undefined,
        waitTimeoutMs: options.waitTimeoutMs,
        replyTimeoutMs: options.replyTimeoutMs,
        untilIdle: options.untilIdle,
        onProgress: progress,
      });
      stdout.write(options.json ? `${JSON.stringify(result)}\n` : `${result.reply}\n`);
    } else if (options.command === "result") {
      const result = await bridge.result(options.requestId);
      stdout.write(options.json ? `${JSON.stringify(result)}\n` : result.state === "replied" ? `${result.reply}\n` : `${result.state}\t${result.target}\t${result.requestId}\tdelivery=${result.delivery}\n`);
      return result.state === "replied" ? 0 : 3;
    } else if (options.command === "open") {
      const result = await launcher(options.provider, { cwd });
      return result.code;
    }
    return 0;
  } catch (error) {
    stderr.write(`${error.code ? `${error.code}: ` : ""}${error.message}\n`);
    if (error.requestId) {
      stderr.write(`request\t${error.requestId}\ttarget=${error.target}\tdelivery=${error.delivery}\nInspect without resending: ${CLI_NAME} result ${error.requestId}\n`);
      if (options.json) stdout.write(`${JSON.stringify({ error: { code: error.code ?? "REQUEST_FAILED", message: error.message }, requestId: error.requestId, target: error.target, delivery: error.delivery })}\n`);
    }
    return 1;
  } finally {
    for (const [signal, stop] of signals) process.removeListener(signal, stop);
  }
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  try { return fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1]); } catch { return false; }
}

if (isDirectExecution()) process.exitCode = await runCli(process.argv.slice(2), { handleSignals: true });

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
import { claudeOrigin, notifyOrigin } from "./origin-notifier.mjs";
import { runOverview } from "./overview.mjs";
import { CLI_NAME, VERSION } from "./product.mjs";
import { ClaudeProvider } from "./providers/claude.mjs";
import { CodexProvider } from "./providers/codex.mjs";
import { RequestStore } from "./request-store.mjs";
import { SessionBridge } from "./session-bridge.mjs";
import { enterSessionDock } from "./session-dock.mjs";
import { TmuxWorkspace } from "./tmux-workspace.mjs";
import { WagaSettingsStore } from "./waga-settings.mjs";
import { runWorkflow } from "./workflow-runtime.mjs";
import { serveWeb } from "./web-server.mjs";
import { WorkStore } from './work-store.mjs';
import { workSources } from './work-assistant.mjs';
import { validateWorkPlan } from './work-plan.mjs';
import { executePlan, planRequest } from './work-plan-client.mjs';

function usage() {
  return [
    `${CLI_NAME} [--cwd PATH] [--backend auto|direct|tmux]`,
    "                                Open the global dock, optionally filtered by workspace",
    `${CLI_NAME} list [--provider claude|codex] [--cwd PATH] [--json]`,
    `${CLI_NAME} run <workflow.json> [--resume RUN_ID]    Run isolated native work with checks and independent review`,
    `${CLI_NAME} plan <provider:session-id> [plan.json] [--execute] [--json]    Record a skill plan, or hand its execution to Waga with --execute`,
    `${CLI_NAME} serve [--port 4317] [--cwd PATH]    Open the local browser workspace`,
    `${CLI_NAME} send <session-id-or-name> <message> [--cwd PATH]    One-way notification`,
    `${CLI_NAME} ask <session-id-or-name> <message> [--notify-origin] [--wait-timeout SEC] [--reply-timeout SEC] [--cwd PATH]`,
    "                                ask returns the request's answer, independent of session idle.",
    "                                --until-idle is accepted for compatibility; it adds no session-idle wait.",
    `${CLI_NAME} result <request-id> [--json]    Read an existing request; never resend`,
    "                                ask: busy wait 1800s; reply wait 180s. Use explicit timeouts for long work.",
    `${CLI_NAME} open <claude|codex> [--cwd PATH]`,
    `${CLI_NAME} doctor`,
    `${CLI_NAME} --version`,
  ].join("\n");
}

function defaultBridge({ autoStartDaemon = true } = {}) {
  const localRouter = new LocalRouterClient();
  return new SessionBridge({
    providers: [new ClaudeProvider(), new CodexProvider({ autoStartDaemon })],
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
  bridge = null,
  doctor = runDoctor,
  launcher = openNativeAgents,
  dock = enterSessionDock,
  overview = runOverview,
  tmuxAgentsView = openTmuxAgentsView,
  orderStore = new DockOrderStore(),
  settingsStore = new WagaSettingsStore(),
  originNotifier = notifyOrigin,
  origin = claudeOrigin(),
  web = serveWeb,
  workflowRuntime = runWorkflow,
  workStore = new WorkStore(),
  planUrl = process.env.WAGA_WEB_URL,
  handleSignals = false,
} = {}) {
  let options;
  try { options = parseCliArgs(args); }
  catch (error) { stderr.write(`${error.message}\n${usage()}\n`); return 2; }
  if (options.command === "run") {
    const controller = new AbortController(), stop = () => controller.abort();
    if (handleSignals) { process.once("SIGINT", stop); process.once("SIGTERM", stop); }
    try { const run = await workflowRuntime(path.resolve(options.manifest), { resume: options.resume, output: stdout, signal: controller.signal }); stdout.write(`${run.state}\n`); return ["review_required", "approved"].includes(run.state) ? 0 : 2; }
    catch (error) { stderr.write(`${error.message}\n`); return 1; }
    finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
  }
  bridge ??= defaultBridge({ autoStartDaemon: !['serve', 'plan'].includes(options.command) });

  const cwd = path.resolve(options.cwd ?? process.cwd());
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    stderr.write(`Workspace is not a directory: ${cwd}\n`);
    return 2;
  }
  if (options.notifyOrigin && !origin) {
    stderr.write("--notify-origin requires a Claude Code session with a messaging socket\n");
    return 2;
  }

  let lastProgress;
  const progress = ({ state, target, requestId, delivery }) => {
    lastProgress = { state, target, requestId, delivery };
    const explanation = {
      "not-sent": "not sent", "waiting-local": "not sent; waiting behind another Waga request",
      waiting: "not sent; target busy", submitting: "submission in progress; delivery unknown",
      submitted: delivery === "accepted" ? "native submission acknowledged" : "written; receiver acceptance unconfirmed",
      accepted: "receiver acknowledged", "reply-received": "request answer received", working: "request turn still running",
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
    if (options.command === 'plan') {
      const { sessions } = await bridge.discover({ cwd: options.cwd ? cwd : undefined });
      const session = sessions.find(row => row.id === options.target);
      if (!session) throw Error('Exact native session not found');
      if (!options.manifest) {
        let page = await bridge.history(session, { activities: true });
        for (let count = 1; count < 8 && !page.messages.some(row => row.role === 'user') && page.nextCursor; count++) {
          const older = await bridge.history(session, { activities: true, cursor: page.nextCursor });
          if (older.nextCursor === page.nextCursor) break;
          page = older;
        }
        const message = page.messages.findLast(row => row.role === 'user');
        const plans = workStore.list(session.id).filter(row => row.plan).map(row => ({ workId: row.id, messageId: row.messageId, plan: row.plan, launches: row.launches ?? [] }));
        for (const planned of plans.filter(row => row.launches.length)) {
          try { const data = await planRequest(`works/${planned.workId}?session=${encodeURIComponent(session.id)}`, undefined, planUrl); planned.runs = data.runs; }
          catch (error) { planned.executionError = error.message; }
        }
        stdout.write(`${JSON.stringify({ sessionId: session.id, message: message ? { id: message.id, text: message.text } : null, plans })}\n`);
        return 0;
      }
      const fd = fs.openSync(path.resolve(options.manifest), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      let input;
      try { const stat = fs.fstatSync(fd); if (!stat.isFile() || stat.size > 128 * 1024) throw Error('Plan must be a JSON file of at most 128KiB'); input = JSON.parse(fs.readFileSync(fd, 'utf8')); }
      finally { fs.closeSync(fd); }
      validateWorkPlan(input);
      if (typeof input.messageId !== 'string' || !input.messageId || input.messageId.length > 500) throw Error('Plan requires the original native user messageId');
      const previous = workStore.list(session.id).find(row => row.messageId === input.messageId);
      let work = previous;
      if (!work) {
        const bundle = await workSources(bridge, session, input.messageId, null, '');
        if (!bundle.message) throw Error('Original native user message not found');
        work = workStore.observe(bundle.message, session);
      }
      const row = input.replanFrom ? await planRequest(`works/${work.id}?session=${encodeURIComponent(session.id)}`, { plan: input }, planUrl) : workStore.plan(work.id, input);
      const launch = options.execute ? await executePlan(row, planUrl) : undefined;
      stdout.write(`${JSON.stringify({ workId: row.id, messageId: row.messageId, plan: row.plan, ...(launch ? { launch } : {}) })}\n`);
    } else if (options.command === "version") stdout.write(`${VERSION}\n`);
    else if (options.command === "serve") return await web({ bridge, cwd, filterCwd: options.cwd ? cwd : undefined, port: options.port, output: stdout, orderStore });
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
      const onReply = options.notifyOrigin ? async (reply, { requestId, target }) => {
        try {
          await originNotifier({ origin, requestId, target, reply });
          stderr.write(`origin-notified\t${origin}\t${requestId}\n`);
        } catch (error) {
          stderr.write(`ORIGIN_NOTIFY_FAILED: ${error.message}; inspect without resending: ${CLI_NAME} result ${requestId} --json\n`);
        }
      } : undefined;
      const result = await bridge.ask(options.target, options.message, {
        cwd: options.cwd ? cwd : undefined,
        waitTimeoutMs: options.waitTimeoutMs,
        replyTimeoutMs: options.replyTimeoutMs,
        untilIdle: options.untilIdle,
        onProgress: progress,
        onReply,
      });
      stdout.write(options.json ? `${JSON.stringify(result)}\n` : `${result.reply}\n`);
    } else if (options.command === "result") {
      const result = await bridge.result(options.requestId);
      stdout.write(options.json ? `${JSON.stringify(result)}\n` : result.state === "replied" ? `${result.reply}\n` : `${result.state}\t${result.target}\t${result.requestId}\tdelivery=${result.delivery}${result.receipt ? `\treceipt=${result.receipt}` : ""}\n`);
      return result.state === "replied" || (result.kind === "send" && result.state === "accepted") ? 0 : 3;
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

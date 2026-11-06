#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import os from 'node:os';
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
import { MessageDelivery } from './message-delivery.mjs';
import { enterSessionDock } from "./session-dock.mjs";
import { loadHosts, remoteCommand, runRemoteCommand } from "./global-hosts.mjs";
import { TmuxWorkspace } from "./tmux-workspace.mjs";
import { WagaSettingsStore } from "./waga-settings.mjs";
import { runWorkflow } from "./workflow-runtime.mjs";
import { serveWeb } from "./web-server.mjs";
import { WorkStore } from './work-store.mjs';
import { workSources } from './work-assistant.mjs';
import { validateWorkPlan } from './work-plan.mjs';
import { executePlan, planRequest } from './work-plan-client.mjs';
import { releaseInfo } from './release-install.mjs';
import { updateHosts, saveUpdatedHosts } from './host-update.mjs';
import { createGlobalDock, loadConnectedHosts } from './host-discovery.mjs';

async function describeRelease() {
  return { ...releaseInfo(), docks: await new TmuxWorkspace().dockReleases() };
}

function usage() {
  return [
    `${CLI_NAME} [--cwd PATH] [--backend auto|direct|tmux] [--hosts /absolute/hosts.json]`,
    "                                Open the local dock; its PC list opens the global dock. --cwd filters the local workspace.",
    `${CLI_NAME} list [--provider claude|codex] [--cwd PATH] [--json]`,
    `${CLI_NAME} run <workflow.json> [--resume RUN_ID]    Run isolated native work with checks and independent review`,
    `${CLI_NAME} plan <provider:session-id> [plan.json] [--execute] [--json]    Record a skill plan, or hand its execution to Waga with --execute`,
    `${CLI_NAME} serve [--port 4317] [--cwd PATH]    Open the local browser workspace`,
    `${CLI_NAME} send <session-id-or-name> <message> [--cwd PATH]    Durably queue a one-way notification`,
    `${CLI_NAME} ask <session-id-or-name> <message> [--async] [--notify-origin] [--wait-timeout SEC] [--reply-timeout SEC] [--cwd PATH]`,
    "                                ask returns the request's answer, independent of session idle.",
    "                                --async returns a local queue receipt; inspect the request with result.",
    "                                --until-idle is accepted for compatibility; it adds no session-idle wait.",
    `${CLI_NAME} result <request-id> [--json]    Read an existing request; never resend`,
    "                                list/send/ask/result: --host HOST_ID [--hosts /absolute/hosts.json] runs on that PC over SSH.",
    "                                ask: busy wait 1800s; reply wait 180s. Use explicit timeouts for long work.",
    `${CLI_NAME} open <claude|codex> [--cwd PATH]`,
    `${CLI_NAME} doctor`,
    `${CLI_NAME} update (--host HOST_ID | --all) [--hosts /absolute/hosts.json] [--json]    Deploy this committed release over SSH`,
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
  delivery = null,
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
  remoteRunner = runRemoteCommand,
  hostUpdater = updateHosts,
  globalDockFactory = createGlobalDock,
} = {}) {
  let options;
  try { options = parseCliArgs(args); }
  catch (error) { stderr.write(`${error.message}\n${usage()}\n`); return 2; }
  if (options.command === 'version') {
    try { stdout.write(`${options.json ? JSON.stringify(await describeRelease()) : VERSION}\n`); return 0; }
    catch (error) { stderr.write(`${error.message}\n`); return 1; }
  }
  if (options.command === 'update') {
    try {
      const config = await loadConnectedHosts(options.hosts);
      const hosts = options.all ? config.hosts : config.hosts.filter(host => host.id === options.host);
      if (!hosts.length) throw Error('업데이트할 등록 PC가 없습니다.');
      const results = await hostUpdater(hosts);
      stdout.write(options.json ? `${JSON.stringify({ results })}\n` : results.map(row => `${row.id}\t${row.state}\t${row.revision.slice(0, 8)}${row.error ? `\t${row.error}` : ''}\n`).join(''));
      try { saveUpdatedHosts(options.hosts, results); }
      catch (error) { stderr.write(`원격 설치 결과는 위와 같습니다. PC 등록 경로 저장 실패: ${error.message}\n`); return 1; }
      return results.some(row => row.state === 'failed') ? 1 : 0;
    } catch (error) { stderr.write(`${error.message}\n`); return 1; }
  }
  if (options.host) {
    try {
      const host = (await loadConnectedHosts(options.hosts)).hosts.find(host => host.id === options.host);
      if (!host) throw Error(`Registered remote PC not found: ${options.host}`);
      const remoteArgs = [options.command];
      if (options.target) remoteArgs.push(options.target, options.message);
      if (options.requestId) remoteArgs.push(options.requestId);
      if (options.cwd) remoteArgs.push("--cwd", options.cwd);
      if (options.provider) remoteArgs.push("--provider", options.provider);
      if (options.json) remoteArgs.push("--json");
      if (options.async) remoteArgs.push("--async");
      if (options.untilIdle) remoteArgs.push("--until-idle");
      if (options.command === "ask" || options.command === "send") remoteArgs.push("--wait-timeout", String(options.waitTimeoutMs / 1000));
      if (options.command === "ask") remoteArgs.push("--reply-timeout", String(options.replyTimeoutMs / 1000));
      const code = await remoteRunner(remoteCommand(host, { args: remoteArgs }), { stdout, stderr });
      if (code && ["send", "ask"].includes(options.command)) stderr.write(`원격 접수·전달 상태를 확인하지 못했습니다. 자동 재전송하지 않았습니다. request ID를 받았다면 result --host ${host.id}로 확인하세요.\n`);
      return code;
    } catch (error) { stderr.write(`${error.message}\n`); return 1; }
  }
  if (options.command === "run") {
    const controller = new AbortController(), stop = () => controller.abort();
    if (handleSignals) { process.once("SIGINT", stop); process.once("SIGTERM", stop); }
    try { const run = await workflowRuntime(path.resolve(options.manifest), { resume: options.resume, output: stdout, signal: controller.signal }); stdout.write(`${run.state}\n`); return ["review_required", "approved"].includes(run.state) ? 0 : 2; }
    catch (error) { stderr.write(`${error.message}\n`); return 1; }
    finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
  }
  const nativeBridge = bridge === null;
  bridge ??= defaultBridge({ autoStartDaemon: !['serve', 'plan', 'send', 'list', 'host-status'].includes(options.command) && !options.async });
  if (nativeBridge) delivery ??= new MessageDelivery({ store: new RequestStore(), bridge });

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
      queued: "stored by Waga; native delivery pending", "not-sent": "not sent", "waiting-local": "not sent; waiting behind another Waga request",
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
    } else if (options.command === 'host-status') {
      const release = await describeRelease();
      let data;
      try { data = await bridge.discover({}); }
      catch (error) { data = { sessions: null, warnings: [{ provider: 'waga', message: error.message }] }; }
      stdout.write(`${JSON.stringify({ ...data, release, openSession: true, createSession: true, host: { type: os.release().toLowerCase().includes('microsoft') ? 'wsl' : 'pc' } })}\n`);
    }
    else if (options.command === "serve") return await web({ bridge, cwd, filterCwd: options.cwd ? cwd : undefined, port: options.port, output: stdout, orderStore });
    else if (options.command === "help") stdout.write(`${usage()}\n`);
    else if (options.command === "doctor") return (await doctor({ output: stdout, cwd })).exitCode;
    else if (options.command === "default" && stdin.isTTY && stdout.isTTY) return (await dock({
      cwd,
      filterCwd: options.cwd ? cwd : null,
      backend: options.backend,
      hostsPath: options.hosts,
      hosts: loadHosts(options.hosts),
      globalDock: globalDockFactory(loadHosts(options.hosts), { file: options.hosts }),
      bridge,
      inputStream: stdin,
      outputStream: stdout,
      errorOutput: stderr,
      orderStore,
      settingsStore,
    })).code;
    else if (options.command === "overview") return await overview({ hosts: loadHosts(options.hosts), globalDock: globalDockFactory(loadHosts(options.hosts), { file: options.hosts }), hostsPath: options.hosts, filterCwd: options.cwd ? cwd : null, defaultCwd: cwd, bridge, inputStream: stdin, outputStream: stdout, errorOutput: stderr, orderStore, settingsStore });
    else if (options.command === "tmux-agents-view") return (await tmuxAgentsView(options.windowId)).code ?? 0;
    else if (options.command === "list" || options.command === "default") writeList(stdout, stderr, await bridge.discover({ provider: options.provider, cwd: options.cwd ? cwd : undefined }), options.json);
    else if (options.command === "send") {
      const result = delivery
        ? await delivery.enqueue(options.target, options.message, { cwd: options.cwd ? cwd : undefined, waitTimeoutMs: options.waitTimeoutMs })
        : await bridge.send(options.target, options.message, { cwd: options.cwd ? cwd : undefined, onProgress: progress, waitTimeoutMs: options.waitTimeoutMs });
      stdout.write(options.json ? `${JSON.stringify(result)}\n` : `${result.delivery ?? "submitted"}\t${result.target}\t${result.requestId}\n`);
    } else if (options.command === "ask") {
      if (delivery) {
        const receipt = await delivery.enqueue(options.target, options.message, { kind: 'ask', cwd: options.cwd ? cwd : undefined, origin: options.notifyOrigin ? origin : undefined, waitTimeoutMs: options.waitTimeoutMs, replyTimeoutMs: options.replyTimeoutMs });
        progress({ ...receipt, delivery: 'local-queued' });
        const result = options.async ? receipt : await delivery.wait(receipt.requestId, { onProgress: progress });
        stdout.write(options.json ? `${JSON.stringify(result)}\n` : options.async ? `${result.delivery}\t${result.target}\t${result.requestId}\n` : `${result.reply}\n`);
        return 0;
      }
      if (options.async) throw Object.assign(Error('Asynchronous ask requires a delivery service'), { code: 'DELIVERY_UNAVAILABLE' });
      const onReply = options.notifyOrigin ? async (reply, { requestId, target }) => {
        try {
          const notification = await originNotifier({ origin, requestId, target, reply });
          stderr.write(`${notification?.delivery === 'local-queued' ? 'origin-local-queued' : 'origin-notified'}\t${origin}\t${requestId}\n`);
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
      if (delivery) {
        try { await delivery.recover(options.requestId); }
        catch (error) { stderr.write(`DELIVERY_RECOVERY_FAILED: ${error.message}; request remains stored: ${options.requestId}\n`); }
      }
      if (options.json) stdout.write(`${JSON.stringify(result)}\n`);
      else if (result.state === "replied") stdout.write(`${result.reply}\n`);
      else {
        stdout.write(`${result.state}\t${result.target}\t${result.requestId}\tdelivery=${result.delivery}${result.receipt ? `\treceipt=${result.receipt}` : ""}${result.continuedTo ? `\tcontinuedTo=${result.continuedTo}` : ""}\n`);
        if (result.warning) stdout.write(`warning: ${result.warning}\n`);
      }
      return result.state === "replied" || (result.kind === "send" && result.state === "accepted") ? 0 : 3;
    } else if (options.command === "open") {
      const result = await launcher(options.provider, { cwd });
      return result.code;
    }
    return 0;
  } catch (error) {
    stderr.write(`${error.code ? `${error.code}: ` : ""}${error.message}\n`);
    if (error.requestId) {
      if (error.locallyStored) stderr.write('Message remains stored locally; inspect the same request ID instead of resending.\n');
      stderr.write(`request\t${error.requestId}\ttarget=${error.target}\tdelivery=${error.delivery}\nInspect without resending: ${CLI_NAME} result ${error.requestId}\n`);
      if (options.json) stdout.write(`${JSON.stringify({ error: { code: error.code ?? "REQUEST_FAILED", message: error.message }, requestId: error.requestId, target: error.target, delivery: error.delivery, ...(error.locallyStored ? { locallyStored: true } : {}), ...(error.continuedTo ? { continuedTo: error.continuedTo } : {}) })}\n`);
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

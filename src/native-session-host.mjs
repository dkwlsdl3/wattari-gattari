#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { EventLog } from "./event-log.mjs";

const execFileAsync = promisify(execFile);

export async function waitForVisibleTerminal({
  pane = process.env.TMUX_PANE,
  query = async pane => (await execFileAsync("tmux", ["display-message", "-p", "-t", pane, "#{window_active_clients}"], { encoding: "utf8", timeout: 2000 })).stdout,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  attempts = 300,
} = {}) {
  if (!/^%[0-9]+$/.test(pane ?? "")) throw new Error("Native frontend requires a tmux pane");
  for (let attempt = 0; attempt < attempts; attempt++) {
    const count = String(await query(pane)).trim();
    if (!/^\d+$/.test(count)) throw new Error("Invalid tmux active client count");
    if (Number(count) > 0) return;
    await wait(100);
  }
  throw Object.assign(new Error("No terminal is viewing the native frontend; reopen it from the dock"), { code: "TMUX_VIEW_TIMEOUT" });
}

function defaultLaunch(command, args, { cwd, onSignal }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: process.env, stdio: "inherit" });
    const handlers = new Map(["SIGHUP", "SIGTERM"].map((signal) => [signal, () => {
      onSignal(signal);
      child.kill(signal);
    }]));
    const cleanup = () => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
    };
    for (const [signal, handler] of handlers) process.on(signal, handler);
    child.once("error", (error) => { cleanup(); reject(error); });
    child.once("exit", (code, signal) => {
      cleanup();
      resolve({ code: code ?? (signal ? 1 : 0), signal });
    });
  });
}

function parseArgs(args) {
  const separator = args.indexOf("--");
  const provider = args[0];
  const sessionId = args[1];
  const command = separator >= 0 ? args[separator + 1] : null;
  if (!["claude", "codex"].includes(provider) || !sessionId || separator !== 2 || !command) {
    throw Object.assign(new Error("Native session host requires <provider> <session-id> -- <command> [args...]"), { code: "INVALID_ARGUMENT" });
  }
  return { provider, sessionId, command, commandArgs: args.slice(separator + 2) };
}

export async function runNativeSessionHost(args = process.argv.slice(2), {
  cwd = process.cwd(),
  processId = process.pid,
  eventLog = new EventLog(),
  launch = defaultLaunch,
  waitForTerminal = process.env.WAGA_WAIT_FOR_VISIBLE === "1" ? waitForVisibleTerminal : null,
} = {}) {
  const { provider, sessionId, command, commandArgs } = parseArgs(args);
  const context = { provider, sessionId, hostPid: processId };
  try {
    if (waitForTerminal) await waitForTerminal();
    eventLog.record("native_session_started", { ...context, command });
    const result = await launch(command, commandArgs, {
      cwd,
      onSignal: (signal) => eventLog.record("native_session_host_signal", { ...context, signal }),
    });
    eventLog.record("native_session_exited", {
      ...context,
      code: result.code,
      signal: result.signal ?? null,
    });
    return result.code;
  } catch (error) {
    eventLog.record("native_session_launch_failed", {
      ...context,
      code: error.code ?? null,
      message: error.message,
    });
    throw error;
  }
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  try { return fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1]); } catch { return false; }
}

if (isDirectExecution()) {
  try { process.exitCode = await runNativeSessionHost(); }
  catch (error) {
    process.stderr.write(`${error.code ? `${error.code}: ` : ""}${error.message}\n`);
    process.exitCode = 1;
  }
}

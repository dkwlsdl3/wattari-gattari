#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseCliArgs } from "./cli-options.mjs";
import { runDoctor } from "./doctor.mjs";
import { openNativeAgents } from "./native-launcher.mjs";
import { runOverview } from "./overview.mjs";
import { CLI_NAME, VERSION } from "./product.mjs";
import { ClaudeProvider } from "./providers/claude.mjs";
import { CodexProvider } from "./providers/codex.mjs";
import { SessionBridge } from "./session-bridge.mjs";
import { enterWagaDock } from "./tmux-workspace.mjs";

function usage() {
  return [
    `${CLI_NAME}                         Open the unified session dock`,
    `${CLI_NAME} list [--provider claude|codex] [--cwd PATH] [--json]`,
    `${CLI_NAME} send <session-id-or-name> <message> [--cwd PATH]`,
    `${CLI_NAME} ask <session-id-or-name> <message> [--timeout SEC] [--cwd PATH]`,
    `${CLI_NAME} open <claude|codex> [--cwd PATH]`,
    `${CLI_NAME} doctor`,
    `${CLI_NAME} --version`,
  ].join("\n");
}

function defaultBridge() {
  return new SessionBridge({ providers: [new ClaudeProvider(), new CodexProvider()] });
}

function writeList(output, errorOutput, { sessions, warnings }, json) {
  if (json) {
    output.write(`${JSON.stringify({ sessions, warnings }, null, 2)}\n`);
    return;
  }
  for (const session of sessions) output.write(`${session.id}\t${session.status}\t${session.name}\t${session.cwd}\n`);
  for (const warning of warnings) errorOutput.write(`warning\t${warning.provider}\t${warning.message}\n`);
}

export async function runCli(args = process.argv.slice(2), {
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  bridge = defaultBridge(),
  doctor = runDoctor,
  launcher = openNativeAgents,
  dock = enterWagaDock,
  overview = runOverview,
} = {}) {
  let options;
  try { options = parseCliArgs(args); }
  catch (error) { stderr.write(`${error.message}\n${usage()}\n`); return 2; }

  const cwd = path.resolve(options.cwd ?? process.cwd());
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    stderr.write(`Workspace is not a directory: ${cwd}\n`);
    return 2;
  }

  try {
    if (options.command === "version") stdout.write(`${VERSION}\n`);
    else if (options.command === "help") stdout.write(`${usage()}\n`);
    else if (options.command === "doctor") return (await doctor({ output: stdout, cwd })).exitCode;
    else if (options.command === "default" && stdin.isTTY && stdout.isTTY) return (await dock({ cwd, filterCwd: options.cwd ? cwd : null })).code;
    else if (options.command === "overview") return await overview({ filterCwd: options.cwd ? cwd : null, bridge, inputStream: stdin, outputStream: stdout, errorOutput: stderr });
    else if (options.command === "list" || options.command === "default") writeList(stdout, stderr, await bridge.discover({ provider: options.provider, cwd: options.cwd ? cwd : undefined }), options.json);
    else if (options.command === "send") {
      const result = await bridge.send(options.target, options.message, { cwd: options.cwd ? cwd : undefined });
      stdout.write(options.json ? `${JSON.stringify(result)}\n` : `sent\t${result.target}\t${result.requestId}\n`);
    } else if (options.command === "ask") {
      const result = await bridge.ask(options.target, options.message, { cwd: options.cwd ? cwd : undefined, timeoutMs: options.timeoutMs });
      stdout.write(options.json ? `${JSON.stringify(result)}\n` : `${result.reply}\n`);
    } else if (options.command === "open") {
      const result = await launcher(options.provider, { cwd });
      return result.code;
    }
    return 0;
  } catch (error) {
    stderr.write(`${error.code ? `${error.code}: ` : ""}${error.message}\n`);
    return 1;
  }
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  try { return fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1]); } catch { return false; }
}

if (isDirectExecution()) process.exitCode = await runCli();

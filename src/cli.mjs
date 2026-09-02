#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ensureWagaDaemon, stopWagaDaemon } from "./waga-background.mjs";
import { parseCliArgs } from "./cli-options.mjs";
import { CLI_NAME, VERSION } from "./product.mjs";
import { request as brokerRequest } from "./client.mjs";
import { runDoctor } from "./doctor.mjs";

function usage() {
  return `${CLI_NAME} [tui] [--cwd PATH]\n${CLI_NAME} agents\n${CLI_NAME} ask <session-id-or-name> <task>\n${CLI_NAME} doctor\n${CLI_NAME} stop\n${CLI_NAME} --version`;
}

export async function runCli(args = process.argv.slice(2), {
  stdout = process.stdout,
  stderr = process.stderr,
  env = process.env,
  changeDirectory = process.chdir,
  ensureDaemon = ensureWagaDaemon,
  stopDaemon = stopWagaDaemon,
  request = brokerRequest,
  doctor = runDoctor,
  runConsole = async () => {
    const { runSessionConsole } = await import("./global-session-console.mjs");
    return runSessionConsole();
  },
} = {}) {
  let options;
  try {
    options = parseCliArgs(args);
  } catch (error) {
    stderr.write(`${error.message}\n${usage()}\n`);
    return 2;
  }

  if (options.cwd) {
    const workspacePath = path.resolve(options.cwd);
    if (!fs.existsSync(workspacePath) || !fs.statSync(workspacePath).isDirectory()) {
      stderr.write(`Workspace is not a directory: ${workspacePath}\n`);
      return 2;
    }
    changeDirectory(workspacePath);
  }

  if (options.command === "version") stdout.write(`${VERSION}\n`);
  else if (options.command === "help") stdout.write(`${usage()}\n`);
  else if (options.command === "doctor") return (await doctor({ output: stdout })).exitCode;
  else if (options.command === "stop") {
    const result = await stopDaemon();
    stdout.write(result.stopped ? `Stopped daemon ${result.pid}\n` : "Daemon is not running\n");
  } else if (options.command === "agents") {
    await ensureDaemon();
    const agents = await request("list_agents");
    for (const agent of agents) stdout.write(`${agent.id}\t${agent.status}\t${agent.name}\n`);
  } else if (options.command === "ask") {
    if (env.WAGA_PEER_HOP) {
      throw Object.assign(new Error("peer shadow 안에서는 다른 waga 요청을 시작할 수 없습니다"), { code: "PEER_HOP_LIMIT" });
    }
    await ensureDaemon();
    const result = await request("ask_agent", { target: options.target, task: options.task });
    stdout.write(`${result.reply}\n`);
  } else {
    return (await runConsole()).exitCode;
  }
  return 0;
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  process.exitCode = await runCli();
}

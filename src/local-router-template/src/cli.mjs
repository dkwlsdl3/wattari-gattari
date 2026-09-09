#!/usr/bin/env node

import { routeTask } from "./router.mjs";

function usage() {
  return [
    "local-llm-router route --provider codex|claude --prompt TEXT --cwd PATH --json",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") { options.json = true; continue; }
    if (!arg.startsWith("--")) {
      if (!options.command) options.command = arg;
      else throw new Error(`알 수 없는 인자: ${arg}`);
      continue;
    }
    const key = arg.slice(2);
    const value = argv[++index];
    if (value === undefined) throw new Error(`${arg} 값이 필요합니다.`);
    options[key] = value;
  }
  return options;
}

export async function runCli(argv = process.argv.slice(2), { output = process.stdout, errorOutput = process.stderr } = {}) {
  try {
    const options = parseArgs(argv);
    if (options.command !== "route" || !options.provider || !options.prompt) {
      errorOutput.write(`${usage()}\n`);
      return 2;
    }
    const routing = await routeTask({ provider: options.provider, prompt: options.prompt, cwd: options.cwd });
    output.write(`${JSON.stringify(routing)}\n`);
    return 0;
  } catch (error) {
    errorOutput.write(`${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  process.exitCode = await runCli();
}

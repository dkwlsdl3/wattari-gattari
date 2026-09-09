#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

import { MAX_PROMPT_BYTES, routeTask, SUPPORTED_PROVIDERS } from "./router.mjs";

const VALUE_OPTIONS = new Set(["provider", "prompt", "cwd"]);

class CliInputError extends Error {
  constructor(message) {
    super(message);
    this.code = "CLI_INPUT";
  }
}

function usage() {
  return [
    "local-llm-router route --provider codex|claude --prompt TEXT [--cwd PATH] [--json]",
  ].join("\n");
}

export function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") { options.json = true; continue; }
    if (!arg.startsWith("--")) {
      if (!options.command) options.command = arg;
      else throw new CliInputError(`알 수 없는 인자: ${arg}`);
      continue;
    }
    const separator = arg.indexOf("=");
    const key = (separator === -1 ? arg : arg.slice(0, separator)).slice(2);
    if (!VALUE_OPTIONS.has(key)) throw new CliInputError(`알 수 없는 옵션: --${key}`);
    let value = separator === -1 ? undefined : arg.slice(separator + 1);
    if (value === undefined) value = argv[++index];
    if (value === undefined || (separator === -1 && value.startsWith("--"))) throw new CliInputError(`--${key} 값이 필요합니다.`);
    options[key] = value;
  }
  return options;
}

async function validateOptions(options) {
  if (options.command !== "route") throw new CliInputError("route 명령이 필요합니다.");
  if (typeof options.provider !== "string" || !SUPPORTED_PROVIDERS.includes(options.provider)) {
    throw new CliInputError("--provider는 codex 또는 claude여야 합니다.");
  }
  if (typeof options.prompt !== "string" || !options.prompt.trim()) throw new CliInputError("--prompt 값이 필요합니다.");
  if (Buffer.byteLength(options.prompt.trim(), "utf8") > MAX_PROMPT_BYTES) {
    throw new CliInputError(`--prompt는 UTF-8 ${MAX_PROMPT_BYTES} bytes 이하여야 합니다.`);
  }
  if (options.cwd === undefined) return;
  if (typeof options.cwd !== "string" || !path.isAbsolute(options.cwd) || options.cwd.includes("\0")) {
    throw new CliInputError("--cwd는 absolute path여야 합니다.");
  }
  try {
    const stat = await fs.stat(options.cwd);
    if (!stat.isDirectory()) throw new CliInputError(`--cwd가 디렉터리가 아닙니다: ${options.cwd}`);
  } catch (error) {
    if (error instanceof CliInputError) throw error;
    throw new CliInputError(`--cwd 디렉터리를 확인하지 못했습니다: ${options.cwd}`);
  }
}

export async function runCli(argv = process.argv.slice(2), {
  output = process.stdout,
  errorOutput = process.stderr,
  routeTaskImpl = routeTask,
} = {}) {
  try {
    const options = parseArgs(argv);
    await validateOptions(options);
    const routing = await routeTaskImpl({ provider: options.provider, prompt: options.prompt, cwd: options.cwd });
    output.write(`${JSON.stringify(routing)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof CliInputError) {
      errorOutput.write(`${error.message}\n${usage()}\n`);
      return 2;
    }
    errorOutput.write(`${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  process.exitCode = await runCli();
}

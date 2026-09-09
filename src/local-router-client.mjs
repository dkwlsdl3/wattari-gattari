import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_ROUTER_DIR = path.join(os.homedir(), "Projects", "local-llm-router");
const TEMPLATE_DIR = fileURLToPath(new URL("./local-router-template/", import.meta.url));
const ROUTER_ENTRY = path.join("src", "cli.mjs");
const MAX_OUTPUT_BYTES = 256 * 1024;

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function copyTree(source, destination) {
  await fs.mkdir(destination, { recursive: true });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) await copyTree(from, to);
    else if (entry.isFile()) await fs.copyFile(from, to);
  }
}

export async function ensureLocalRouterProject({ dir = DEFAULT_ROUTER_DIR, templateDir = TEMPLATE_DIR } = {}) {
  const routerDir = path.resolve(dir);
  const entry = path.join(routerDir, ROUTER_ENTRY);
  if (await exists(entry)) return { dir: routerDir, entry, created: false };

  if (await exists(routerDir)) {
    const entries = await fs.readdir(routerDir);
    if (entries.length) {
      throw new Error(`local-llm-router 경로에 다른 파일이 있어 덮어쓰지 않았습니다: ${routerDir}`);
    }
  }
  if (!await exists(templateDir)) throw new Error(`local-llm-router 기본 템플릿을 찾을 수 없습니다: ${templateDir}`);
  await copyTree(templateDir, routerDir);
  return { dir: routerDir, entry, created: true };
}

function parseOutput(stdout, provider) {
  let routing;
  try {
    routing = JSON.parse(String(stdout ?? "").trim());
  } catch (error) {
    throw new Error(`local-llm-router가 JSON을 반환하지 않았습니다: ${error.message}`);
  }
  if (!routing || typeof routing !== "object" || routing.provider !== provider || typeof routing.label !== "string") {
    throw new Error("local-llm-router 응답 형식이 올바르지 않습니다.");
  }
  return { ...routing, source: "local-llm-router" };
}

export class LocalRouterClient {
  #dir;
  #run;
  #ensure;

  constructor({ dir = process.env.WAGA_LOCAL_ROUTER_DIR || DEFAULT_ROUTER_DIR, run = execFileAsync, ensure = ensureLocalRouterProject } = {}) {
    this.#dir = path.resolve(dir);
    this.#run = run;
    this.#ensure = ensure;
  }

  get dir() {
    return this.#dir;
  }

  async route({ provider = "codex", prompt = "", cwd = process.cwd() } = {}) {
    if (!String(prompt).trim()) throw new TypeError("local-llm-router prompt is required");
    const project = await this.#ensure({ dir: this.#dir });
    const args = [
      project.entry,
      "route",
      "--provider", provider,
      "--prompt", String(prompt),
      "--cwd", path.resolve(cwd),
      "--json",
    ];
    let result;
    try {
      result = await this.#run(process.execPath, args, {
        cwd: path.resolve(cwd),
        timeout: 30_000,
        maxBuffer: MAX_OUTPUT_BYTES,
      });
    } catch (error) {
      const detail = String(error.stderr || error.message || error).trim();
      throw new Error(`local-llm-router 실행에 실패했습니다${detail ? `: ${detail}` : ""}`);
    }
    return parseOutput(result.stdout, provider);
  }
}

export { DEFAULT_ROUTER_DIR, ROUTER_ENTRY };

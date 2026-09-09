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
const CONTRACT_VERSION = 1;
const ROUTING_PROVIDERS = new Set(["codex", "claude"]);
const ROUTING_TIERS = new Set(["fast", "routine", "complex", "critical"]);
const ROUTING_CONFIDENCE = new Set(["low", "medium", "high"]);
const MAX_PROMPT_BYTES = 128 * 1024;
const ROUTING_FIELDS = new Set([
  "contractVersion", "provider", "model", "effort", "label", "tier", "score", "confidence",
  "skills", "reasons", "cwd", "source", "issueRefs", "issues", "warnings",
]);
const ISSUE_FIELDS = new Set(["iid", "title", "labels", "commentCount"]);

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

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function stringArray(value, field) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`local-llm-router 응답의 ${field} 필드가 string 배열이 아닙니다.`);
  }
}

function allowedKeys(value, allowed, field) {
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length) {
    throw new Error(`local-llm-router 응답의 ${field}에 허용되지 않는 필드가 있습니다: ${unexpected.join(", ")}`);
  }
}

function validateIssue(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`local-llm-router 응답의 issues[${index}]가 객체가 아닙니다.`);
  }
  allowedKeys(value, ISSUE_FIELDS, `issues[${index}]`);
  if (typeof value.iid !== "string" || typeof value.title !== "string") {
    throw new Error(`local-llm-router 응답의 issues[${index}] 식별자 또는 제목이 올바르지 않습니다.`);
  }
  stringArray(value.labels, `issues[${index}].labels`);
  if (!Number.isInteger(value.commentCount) || value.commentCount < 0) {
    throw new Error(`local-llm-router 응답의 issues[${index}].commentCount가 올바르지 않습니다.`);
  }
}

function validateRouting(routing, provider, expectedCwd) {
  if (!routing || typeof routing !== "object" || Array.isArray(routing)) {
    throw new Error("local-llm-router 응답 형식이 객체가 아닙니다.");
  }
  allowedKeys(routing, ROUTING_FIELDS, "응답");
  if (routing.contractVersion !== CONTRACT_VERSION) {
    throw new Error(`local-llm-router 응답 contractVersion이 ${CONTRACT_VERSION}이 아닙니다.`);
  }
  if (routing.provider !== provider || !ROUTING_PROVIDERS.has(routing.provider)) {
    throw new Error("local-llm-router 응답 provider가 요청과 일치하지 않습니다.");
  }
  for (const field of ["model", "effort", "label"]) {
    if (!nonEmptyString(routing[field])) {
      throw new Error(`local-llm-router 응답의 ${field} 필드가 비어 있거나 문자열이 아닙니다.`);
    }
  }
  if (!ROUTING_TIERS.has(routing.tier)) {
    throw new Error("local-llm-router 응답의 tier가 올바르지 않습니다.");
  }
  if (!Number.isInteger(routing.score) || routing.score < 0) {
    throw new Error("local-llm-router 응답의 score가 0 이상 정수가 아닙니다.");
  }
  if (!ROUTING_CONFIDENCE.has(routing.confidence)) {
    throw new Error("local-llm-router 응답의 confidence가 올바르지 않습니다.");
  }
  for (const field of ["skills", "reasons", "issueRefs", "warnings"]) stringArray(routing[field], field);
  if (new Set(routing.issueRefs).size !== routing.issueRefs.length) {
    throw new Error("local-llm-router 응답의 issueRefs에 중복 항목이 있습니다.");
  }
  if (routing.source !== "local-llm-router") {
    throw new Error("local-llm-router 응답의 source가 올바르지 않습니다.");
  }
  if (!nonEmptyString(routing.cwd) || !path.isAbsolute(routing.cwd) || routing.cwd !== path.resolve(routing.cwd) || routing.cwd !== expectedCwd) {
    throw new Error("local-llm-router 응답의 cwd가 요청 작업 디렉터리와 일치하지 않습니다.");
  }
  if (!Array.isArray(routing.issues)) {
    throw new Error("local-llm-router 응답의 issues 필드가 배열이 아닙니다.");
  }
  routing.issues.forEach(validateIssue);
  return routing;
}

function parseOutput(stdout, provider, expectedCwd) {
  let routing;
  try {
    routing = JSON.parse(String(stdout ?? "").trim());
  } catch (error) {
    throw new Error(`local-llm-router가 JSON을 반환하지 않았습니다: ${error.message}`);
  }
  return { ...validateRouting(routing, provider, expectedCwd), source: "local-llm-router" };
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
    if (!ROUTING_PROVIDERS.has(provider)) throw new TypeError(`local-llm-router provider is unsupported: ${provider}`);
    if (typeof prompt !== "string" || !prompt.trim()) throw new TypeError("local-llm-router prompt is required");
    if (Buffer.byteLength(prompt.trim(), "utf8") > MAX_PROMPT_BYTES) throw new TypeError(`local-llm-router prompt must be at most ${MAX_PROMPT_BYTES} UTF-8 bytes`);
    if (typeof cwd !== "string" || !cwd.trim()) throw new TypeError("local-llm-router cwd is required");
    const normalizedCwd = path.resolve(cwd);
    const project = await this.#ensure({ dir: this.#dir });
    const args = [
      project.entry,
      "route",
      "--provider", provider,
      "--prompt", String(prompt),
      "--cwd", normalizedCwd,
      "--json",
    ];
    let result;
    try {
      result = await this.#run(process.execPath, args, {
        cwd: normalizedCwd,
        timeout: 15_000,
        maxBuffer: MAX_OUTPUT_BYTES,
      });
    } catch (error) {
      const detail = String(error.stderr || error.message || error).trim();
      throw new Error(`local-llm-router 실행에 실패했습니다${detail ? `: ${detail}` : ""}`);
    }
    return parseOutput(result.stdout, provider, normalizedCwd);
  }
}

export { CONTRACT_VERSION, DEFAULT_ROUTER_DIR, MAX_OUTPUT_BYTES, MAX_PROMPT_BYTES, ROUTER_ENTRY, validateRouting };

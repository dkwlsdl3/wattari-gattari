import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CONFIG_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "router.config.json");
const ISSUE_OUTPUT_BYTES = 512 * 1024;
const ISSUE_REFERENCE = /(?:^|\s)#(\d{1,})\b/g;
export const SUPPORTED_PROVIDERS = Object.freeze(["codex", "claude"]);
const PROVIDERS = new Set(SUPPORTED_PROVIDERS);
const TIER_IDS = Object.freeze(["fast", "routine", "complex", "critical"]);
const CONFIDENCE_LEVELS = Object.freeze(["low", "medium", "high"]);
const ROUTING_FIELDS = new Set([
  "contractVersion", "provider", "model", "effort", "label", "tier", "score", "confidence",
  "skills", "reasons", "cwd", "source", "issueRefs", "issues", "warnings",
]);
const PUBLIC_ISSUE_FIELDS = new Set(["iid", "title", "labels", "commentCount"]);
export const MAX_PROMPT_BYTES = 128 * 1024;
const DEFAULT_ISSUE_DEADLINE_MS = 12_000;

const SKILL_SIGNALS = [
  { id: "issue-loop", label: "issue-loop", weight: 3, pattern: /(?:\$|\/)?issue[- ]?loop|이슈\s*루프|이슈루프/i },
  { id: "diagnose", label: "진단", weight: 3, pattern: /(?:\$|\/)?diagnose|진단해|버그 찾아|오류 원인|디버그/i },
  { id: "architecture", label: "아키텍처 검토", weight: 3, pattern: /(?:\$|\/)?(?:improve-codebase-architecture|codebase-design)|아키텍처 개선|코드 구조 개선|설계 검토/i },
  { id: "review", label: "적대 리뷰", weight: 3, pattern: /(?:\$|\/)?claude-review|적대 리뷰|교차검증|클로드 검증|독립 리뷰/i },
  { id: "research", label: "심층 조사", weight: 3, pattern: /(?:\$|\/)?deep-research|딥 리서치|심층 조사/i },
  { id: "grill", label: "설계 인터뷰", weight: 2, pattern: /(?:\$|\/)?grill(?:-me|-with-docs)?|설계 피드백|인터뷰해/i },
  { id: "tdd", label: "TDD", weight: 1, pattern: /(?:\$|\/)?tdd|테스트 주도|red[- ]?green[- ]?refactor/i },
  { id: "prototype", label: "프로토타입", weight: 1, pattern: /(?:\$|\/)?prototype|프로토타입|UI 시안/i },
];

const TASK_SIGNALS = [
  { id: "storage", label: "스토리지/파일시스템", weight: 2, pattern: /lustre|zvol|filesystem|file system|storage|스토리지|파일\s*시스템|저장소/i },
  { id: "reliability", label: "장애 감시/복구", weight: 2, pattern: /watchdog|d[- ]?state|fail[- ]?closed|recovery|감시|복구|장애/i },
  { id: "concurrency", label: "동시성", weight: 2, pattern: /race\s*condition|deadlock|concurren|동시성|경쟁\s*조건|데드락/i },
  { id: "migration", label: "마이그레이션", weight: 2, pattern: /migration|마이그레이션|스키마\s*(?:변경|전환)/i },
  { id: "security", label: "보안/인증", weight: 2, pattern: /security|credential|authentication|authorization|보안|인증|권한/i },
  { id: "production", label: "운영 변경", weight: 2, pattern: /production|deploy|deployment|rollback|배포|롤백|운영\s*(?:장애|변경)/i },
  { id: "root-cause", label: "원인 분석", weight: 1, pattern: /root[- ]?cause|investigate|debug|원인\s*분석|장애\s*분석|재현/i },
  { id: "issue-work", label: "이슈 작업", weight: 2, pattern: /(?:#\d{1,}|issue|이슈)[^\n]{0,60}(?:확인|처리|해결|수정|구현|검토)/i },
  { id: "review", label: "검토", weight: 1, pattern: /review|검토|리뷰|역검증/i },
  { id: "change", label: "구현 변경", weight: 1, pattern: /implement|refactor|fix|수정|구현|리팩터링|고쳐/i },
  { id: "issue-reference", label: "이슈 참조", weight: 1, pattern: ISSUE_REFERENCE,
  },
];

export const DEFAULT_CONFIG = Object.freeze({
  routing: Object.freeze({
    tiers: Object.freeze([
      Object.freeze({ id: "fast", minScore: 0 }),
      Object.freeze({ id: "routine", minScore: 1 }),
      Object.freeze({ id: "complex", minScore: 3 }),
      Object.freeze({ id: "critical", minScore: 6 }),
    ]),
    minimumTierBySignal: Object.freeze({
      "issue-loop": "complex",
      diagnose: "complex",
      architecture: "complex",
      review: "complex",
      research: "complex",
      storage: "complex",
      reliability: "complex",
      concurrency: "complex",
      migration: "complex",
      security: "complex",
      production: "critical",
      "root-cause": "complex",
    }),
  }),
  issue: Object.freeze({ enabled: true, timeoutMs: 5_000, deadlineMs: DEFAULT_ISSUE_DEADLINE_MS, maxIssues: 3, maxComments: 50, maxChars: 65_536 }),
  profiles: Object.freeze({
    codex: Object.freeze({
      tiers: Object.freeze({
        fast: Object.freeze({ model: "gpt-5.6-sol", effort: "low", label: "GPT-5.6 Sol · low" }),
        routine: Object.freeze({ model: "gpt-5.6-sol", effort: "medium", label: "GPT-5.6 Sol · medium" }),
        complex: Object.freeze({ model: "gpt-6-astra", effort: "low", label: "GPT-6 Astra · low" }),
        critical: Object.freeze({ model: "gpt-6-astra", effort: "xhigh", label: "GPT-6 Astra · xhigh" }),
      }),
    }),
    claude: Object.freeze({
      tiers: Object.freeze({
        fast: Object.freeze({ model: "sonnet", effort: "low", label: "Claude Sonnet · low" }),
        routine: Object.freeze({ model: "opus", effort: "low", label: "Claude Opus · low" }),
        complex: Object.freeze({ model: "fable", effort: "low", label: "Claude Fable · low" }),
        critical: Object.freeze({ model: "fable", effort: "high", label: "Claude Fable · high" }),
      }),
    }),
  }),
});

function clean(value) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
}

function bounded(value, maxChars) {
  return clean(value).slice(0, maxChars);
}

function labelsFrom(issue) {
  const labels = issue?.labels ?? issue?.label_details ?? issue?.labelDetails ?? [];
  if (!Array.isArray(labels)) return [];
  return [...new Set(labels.map((label) => typeof label === "string" ? label : label?.name).filter(Boolean).map(clean))];
}

function notesFrom(issue) {
  const direct = issue?.notes ?? issue?.comments ?? [];
  if (Array.isArray(direct)) return direct;
  if (!Array.isArray(issue?.discussions)) return [];
  return issue.discussions.flatMap((discussion) => Array.isArray(discussion?.notes) ? discussion.notes : []);
}

function noteBody(note) {
  return note?.body ?? note?.text ?? note?.note ?? "";
}

export function extractIssueReferences(prompt) {
  const references = [];
  const seen = new Set();
  for (const match of String(prompt ?? "").matchAll(ISSUE_REFERENCE)) {
    if (seen.has(match[1])) continue;
    seen.add(match[1]);
    references.push(match[1]);
  }
  return references;
}

export function normalizeIssue(issue, { iid = issue?.iid, maxComments = 50, maxChars = 65_536 } = {}) {
  const title = bounded(issue?.title, 2_000);
  const description = bounded(issue?.description ?? issue?.body, maxChars);
  const labels = labelsFrom(issue);
  const notes = notesFrom(issue).filter((note) => !note?.system);
  const comments = notes.slice(-maxComments).map((note) => bounded(noteBody(note), Math.max(1_000, Math.floor(maxChars / Math.max(1, maxComments))))).filter(Boolean);
  const text = bounded([title, description, labels.join(" "), ...comments].filter(Boolean).join("\n"), maxChars);
  return {
    iid: String(iid ?? ""),
    title,
    labels,
    commentCount: notes.length,
    text,
  };
}

export function parseIssueOutput(stdout) {
  try {
    const parsed = JSON.parse(String(stdout ?? "").trim());
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("object expected");
    return parsed;
  } catch (error) {
    throw new Error(`glab issue view JSON을 해석하지 못했습니다: ${error.message}`);
  }
}

export async function fetchIssueFromGlab(iid, { cwd = process.cwd(), run = execFileAsync, timeoutMs = 5_000, signal } = {}) {
  const result = await run("glab", ["issue", "view", String(iid), "--comments", "--output", "json"], {
    cwd: path.resolve(cwd),
    timeout: timeoutMs,
    maxBuffer: ISSUE_OUTPUT_BYTES,
    signal,
  });
  return parseIssueOutput(result.stdout);
}

function mergeProfile(provider, rawProfile) {
  const base = DEFAULT_CONFIG.profiles[provider];
  if (rawProfile === undefined || rawProfile === null) return base;
  if (typeof rawProfile !== "object" || Array.isArray(rawProfile)) return { ...base, tiers: rawProfile };
  const hasLegacyProfile = Object.hasOwn(rawProfile, "default") || Object.hasOwn(rawProfile, "promoted");
  if (hasLegacyProfile) {
    return { ...rawProfile, tiers: null, legacy: true };
  }
  if (Object.hasOwn(rawProfile, "tiers") && (rawProfile.tiers === null || typeof rawProfile.tiers !== "object" || Array.isArray(rawProfile.tiers))) {
    return { ...base, ...rawProfile };
  }
  return {
    ...base,
    ...rawProfile,
    tiers: {
      ...base.tiers,
      ...(rawProfile.tiers ?? {}),
    },
  };
}

function mergeConfig(raw = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    routing: {
      ...DEFAULT_CONFIG.routing,
      ...(raw.routing ?? {}),
      tiers: Array.isArray(raw.routing?.tiers) ? raw.routing.tiers : DEFAULT_CONFIG.routing.tiers,
      minimumTierBySignal: {
        ...DEFAULT_CONFIG.routing.minimumTierBySignal,
        ...(raw.routing?.minimumTierBySignal ?? {}),
      },
    },
    issue: { ...DEFAULT_CONFIG.issue, ...(raw.issue ?? {}) },
    profiles: {
      codex: mergeProfile("codex", raw.profiles?.codex),
      claude: mergeProfile("claude", raw.profiles?.claude),
    },
  };
}

async function readConfig(configPath) {
  try {
    const raw = JSON.parse(await fs.readFile(configPath, "utf8"));
    return mergeConfig(raw);
  } catch (error) {
    if (error.code === "ENOENT") return DEFAULT_CONFIG;
    throw new Error(`라우터 설정을 읽지 못했습니다: ${error.message}`);
  }
}

function matchedSignals(text, signals) {
  return signals.filter(({ pattern }) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

function reasonFor(signal, source) {
  return source === "issue" ? `이슈 메타데이터 · ${signal.label} (+${signal.weight})` : `${signal.label} (+${signal.weight})`;
}

function routingTiers(settings) {
  const configured = Array.isArray(settings.routing?.tiers) ? settings.routing.tiers : DEFAULT_CONFIG.routing.tiers;
  const tiers = configured
    .filter((tier) => tier && TIER_IDS.includes(tier.id) && Number.isInteger(Number(tier.minScore)) && Number(tier.minScore) >= 0)
    .map((tier) => ({ id: tier.id, minScore: Number(tier.minScore) }))
    .sort((left, right) => left.minScore - right.minScore);
  return tiers.length ? tiers : DEFAULT_CONFIG.routing.tiers;
}

function tierRank(tiers, tierId) {
  return tiers.findIndex((tier) => tier.id === tierId);
}

function selectTier(settings, score, matchRows) {
  const tiers = routingTiers(settings);
  let selected = tiers[0];
  for (const tier of tiers) {
    if (score >= tier.minScore) selected = tier;
  }

  const minimums = settings.routing?.minimumTierBySignal ?? {};
  for (const { signal } of matchRows) {
    const requiredId = minimums[signal.id];
    if (tierRank(tiers, requiredId) > tierRank(tiers, selected.id)) {
      selected = tiers[tierRank(tiers, requiredId)];
    }
  }
  return selected.id;
}

function selectProfile(profile, settings, score, matchRows) {
  if (profile?.legacy) {
    throw new TypeError("Legacy default/promoted profiles are not supported by routing contract v1");
  }
  if (!profile?.tiers || typeof profile.tiers !== "object" || Array.isArray(profile.tiers)) {
    throw new TypeError("Routing profile must define v1 tiers");
  }

  const tier = selectTier(settings, score, matchRows);
  const selected = profile.tiers[tier];
  if (!selected || typeof selected !== "object" || Array.isArray(selected)) {
    throw new TypeError(`Routing profile is missing tier: ${tier}`);
  }
  if (![selected.model, selected.effort, selected.label].every((value) => typeof value === "string" && value.trim())) {
    throw new TypeError(`Routing profile has invalid model, effort, or label for tier: ${tier}`);
  }
  return { selected, tier };
}

function invalidRouting(field, detail = "") {
  throw new TypeError(`Invalid routing response: ${field}${detail ? ` (${detail})` : ""}`);
}

function assertStringArray(value, field) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) invalidRouting(field, "expected string[]");
}

function assertAllowedFields(value, allowed, field) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalidRouting(field, `unknown field: ${key}`);
  }
}

export function validateRoutingResponse(routing, { expectedProvider } = {}) {
  if (!routing || typeof routing !== "object" || Array.isArray(routing)) invalidRouting("root", "expected object");
  assertAllowedFields(routing, ROUTING_FIELDS, "root");
  if (routing.contractVersion !== 1) invalidRouting("contractVersion", "expected 1");
  if (!SUPPORTED_PROVIDERS.includes(routing.provider)) invalidRouting("provider", "unsupported provider");
  if (expectedProvider !== undefined && routing.provider !== expectedProvider) invalidRouting("provider", "does not match request");
  for (const field of ["model", "effort", "label"]) {
    if (typeof routing[field] !== "string" || !routing[field].trim()) invalidRouting(field, "expected non-empty string");
  }
  if (!TIER_IDS.includes(routing.tier)) invalidRouting("tier", "unsupported tier");
  if (!Number.isInteger(routing.score) || routing.score < 0) invalidRouting("score", "expected non-negative integer");
  if (!CONFIDENCE_LEVELS.includes(routing.confidence)) invalidRouting("confidence", "unsupported level");
  for (const field of ["skills", "reasons", "issueRefs", "warnings"]) assertStringArray(routing[field], field);
  if (new Set(routing.issueRefs).size !== routing.issueRefs.length) invalidRouting("issueRefs", "must be unique");
  if (typeof routing.cwd !== "string" || !path.isAbsolute(routing.cwd) || path.resolve(routing.cwd) !== routing.cwd) {
    invalidRouting("cwd", "expected absolute normalized path");
  }
  if (routing.source !== "local-llm-router") invalidRouting("source", "unexpected source");
  if (!Array.isArray(routing.issues)) invalidRouting("issues", "expected issue[]");
  for (const issue of routing.issues) {
    if (!issue || typeof issue !== "object" || Array.isArray(issue)) invalidRouting("issues", "invalid issue object");
    assertAllowedFields(issue, PUBLIC_ISSUE_FIELDS, "issues[]");
    for (const field of ["iid", "title"]) {
      if (typeof issue[field] !== "string") invalidRouting(`issues[].${field}`, "expected string");
    }
    assertStringArray(issue.labels, "issues[].labels");
    if (!Number.isInteger(issue.commentCount) || issue.commentCount < 0) invalidRouting("issues[].commentCount", "expected non-negative integer");
  }
  return routing;
}

function publicIssue(issue) {
  return {
    iid: issue.iid,
    title: issue.title,
    labels: issue.labels,
    commentCount: issue.commentCount,
  };
}

async function normalizeWorkspace(cwd) {
  if (typeof cwd !== "string" || !cwd.trim() || !path.isAbsolute(cwd) || cwd.includes("\0")) {
    throw new TypeError("cwd must be an absolute path");
  }
  const workspace = path.resolve(cwd);
  try {
    const stat = await fs.stat(workspace);
    if (!stat.isDirectory()) throw new TypeError(`cwd is not a directory: ${workspace}`);
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError(`cwd directory could not be accessed: ${workspace}`);
  }
  return workspace;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function nonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

class IssueDeadlineExceeded extends Error {
  constructor() {
    super("issue lookup deadline exceeded");
    this.code = "ISSUE_DEADLINE_EXCEEDED";
  }
}

async function fetchIssueWithinDeadline(fetchIssue, iid, options, remainingMs) {
  const controller = new AbortController();
  let timer;
  const request = Promise.resolve().then(() => fetchIssue(iid, { ...options, signal: controller.signal }));
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new IssueDeadlineExceeded());
    }, remainingMs);
  });
  try {
    return await Promise.race([request, deadline]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export async function routeTask({
  provider,
  prompt = "",
  cwd = process.cwd(),
  config,
  configPath = CONFIG_PATH,
  fetchIssue = fetchIssueFromGlab,
} = {}) {
  if (typeof provider !== "string" || !PROVIDERS.has(provider)) {
    throw new TypeError(`Unknown routing provider: ${provider ?? "(missing)"}`);
  }
  const settings = mergeConfig(config ?? await readConfig(configPath));
  const profile = settings.profiles?.[provider];
  if (!profile) throw new TypeError(`Unknown routing provider: ${provider}`);
  if (typeof prompt !== "string") throw new TypeError("Prompt must be a string");
  const text = clean(prompt);
  if (!text) throw new TypeError("Prompt is required");
  if (Buffer.byteLength(text, "utf8") > MAX_PROMPT_BYTES) throw new TypeError(`Prompt exceeds ${MAX_PROMPT_BYTES} UTF-8 bytes`);
  const workspace = await normalizeWorkspace(cwd);
  const references = extractIssueReferences(text);
  const issueContexts = [];
  const warnings = [];
  const issueSettings = settings.issue ?? DEFAULT_CONFIG.issue;
  const maxIssues = nonNegativeInteger(issueSettings.maxIssues, DEFAULT_CONFIG.issue.maxIssues);
  const issueTimeoutMs = positiveInteger(issueSettings.timeoutMs, DEFAULT_CONFIG.issue.timeoutMs);
  const issueDeadlineMs = positiveInteger(issueSettings.deadlineMs, DEFAULT_ISSUE_DEADLINE_MS);
  if (issueSettings.enabled !== false && references.length) {
    const deadlineAt = Date.now() + issueDeadlineMs;
    for (const iid of references.slice(0, maxIssues)) {
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) {
        warnings.push(`이슈 조회 전체 deadline(${issueDeadlineMs}ms)을 초과해 프롬프트만으로 라우팅했습니다.`);
        break;
      }
      try {
        const issue = await fetchIssueWithinDeadline(fetchIssue, iid, {
          cwd: workspace,
          timeoutMs: Math.max(1, Math.min(issueTimeoutMs, remainingMs)),
        }, remainingMs);
        issueContexts.push(normalizeIssue(issue, { iid, maxComments: issueSettings.maxComments, maxChars: issueSettings.maxChars }));
      } catch (error) {
        if (error?.code === "ISSUE_DEADLINE_EXCEEDED") {
          warnings.push(`이슈 조회 전체 deadline(${issueDeadlineMs}ms)을 초과해 프롬프트만으로 라우팅했습니다.`);
          break;
        }
        warnings.push(`#${iid}: ${clean(error.message || error)}`);
      }
    }
    if (references.length > maxIssues) warnings.push(`이슈 ${maxIssues}개까지만 조회했습니다.`);
  }

  const matches = new Map();
  for (const signal of matchedSignals(text, [...SKILL_SIGNALS, ...TASK_SIGNALS])) {
    if (!matches.has(signal.id)) matches.set(signal.id, { signal, source: "prompt" });
  }
  for (const issue of issueContexts) {
    for (const signal of matchedSignals(issue.text, [...SKILL_SIGNALS, ...TASK_SIGNALS])) {
      if (!matches.has(signal.id)) matches.set(signal.id, { signal, source: "issue" });
    }
  }
  const matchRows = [...matches.values()];
  const score = matchRows.reduce((total, { signal }) => total + signal.weight, 0);
  const { selected, tier } = selectProfile(profile, settings, score, matchRows);
  const reasons = matchRows.map(({ signal, source }) => reasonFor(signal, source));
  for (const issue of issueContexts) {
    const detail = issue.labels.length ? `라벨 ${issue.labels.slice(0, 3).join(", ")}` : `본문/코멘트 ${issue.commentCount}개`;
    reasons.push(`#${issue.iid} 조회 · ${detail}`);
  }
  if (!reasons.length) reasons.push("기본 작업 프로파일 (+0)");
  const substantive = matchRows.filter(({ signal }) => !["change", "review", "issue-reference"].includes(signal.id));

  const routing = {
    contractVersion: 1,
    provider,
    model: selected.model ?? null,
    effort: selected.effort ?? null,
    label: selected.label ?? `${provider} profile`,
    tier,
    score,
    confidence: matchRows.some(({ signal }) => SKILL_SIGNALS.includes(signal)) || substantive.length > 1 ? "high" : substantive.length ? "medium" : "low",
    skills: matchRows.filter(({ signal }) => SKILL_SIGNALS.includes(signal)).map(({ signal }) => signal.id),
    reasons,
    cwd: workspace,
    source: "local-llm-router",
    issueRefs: references,
    issues: issueContexts.map(publicIssue),
    warnings,
  };
  return validateRoutingResponse(routing, { expectedProvider: provider });
}

export { CONFIG_PATH };

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
  promotionThreshold: 3,
  issue: Object.freeze({ enabled: true, timeoutMs: 5_000, maxIssues: 3, maxComments: 50, maxChars: 65_536 }),
  profiles: Object.freeze({
    codex: Object.freeze({
      default: Object.freeze({ model: "gpt-5.6-luna", effort: "max", label: "GPT-5.6 Luna · max" }),
      promoted: Object.freeze({ model: "gpt-6-astra", effort: "low", label: "GPT-6 Astra · low" }),
    }),
    claude: Object.freeze({
      default: Object.freeze({ model: "opus", effort: "high", label: "Claude Opus · high" }),
      promoted: Object.freeze({ model: "fable", effort: "high", label: "Claude Fable · high" }),
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

export async function fetchIssueFromGlab(iid, { cwd = process.cwd(), run = execFileAsync, timeoutMs = 5_000 } = {}) {
  const result = await run("glab", ["issue", "view", String(iid), "--comments", "--output", "json"], {
    cwd: path.resolve(cwd),
    timeout: timeoutMs,
    maxBuffer: ISSUE_OUTPUT_BYTES,
  });
  return parseIssueOutput(result.stdout);
}

async function readConfig(configPath) {
  try {
    const raw = JSON.parse(await fs.readFile(configPath, "utf8"));
    return {
      ...DEFAULT_CONFIG,
      ...raw,
      issue: { ...DEFAULT_CONFIG.issue, ...(raw.issue ?? {}) },
      profiles: { ...DEFAULT_CONFIG.profiles, ...(raw.profiles ?? {}) },
    };
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

export async function routeTask({
  provider = "codex",
  prompt = "",
  cwd = process.cwd(),
  config,
  configPath = CONFIG_PATH,
  fetchIssue = fetchIssueFromGlab,
} = {}) {
  const settings = config ?? await readConfig(configPath);
  const profile = settings.profiles?.[provider];
  if (!profile?.default || !profile?.promoted) throw new TypeError(`Unknown routing provider: ${provider}`);
  const text = clean(prompt);
  const references = extractIssueReferences(text);
  const issueContexts = [];
  const warnings = [];
  const issueSettings = settings.issue ?? DEFAULT_CONFIG.issue;
  if (issueSettings.enabled !== false && references.length) {
    for (const iid of references.slice(0, issueSettings.maxIssues ?? 3)) {
      try {
        const issue = await fetchIssue(iid, { cwd, timeoutMs: issueSettings.timeoutMs ?? 5_000 });
        issueContexts.push(normalizeIssue(issue, { iid, maxComments: issueSettings.maxComments, maxChars: issueSettings.maxChars }));
      } catch (error) {
        warnings.push(`#${iid}: ${clean(error.message || error)}`);
      }
    }
    if (references.length > (issueSettings.maxIssues ?? 3)) warnings.push(`이슈 ${issueSettings.maxIssues ?? 3}개까지만 조회했습니다.`);
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
  const promoted = score >= (settings.promotionThreshold ?? 3);
  const selected = promoted ? profile.promoted : profile.default;
  const reasons = matchRows.map(({ signal, source }) => reasonFor(signal, source));
  for (const issue of issueContexts) {
    const detail = issue.labels.length ? `라벨 ${issue.labels.slice(0, 3).join(", ")}` : `본문/코멘트 ${issue.commentCount}개`;
    reasons.push(`#${issue.iid} 조회 · ${detail}`);
  }
  if (!reasons.length) reasons.push("기본 작업 프로파일 (+0)");
  const substantive = matchRows.filter(({ signal }) => !["change", "review", "issue-reference"].includes(signal.id));

  return {
    provider,
    model: selected.model ?? null,
    effort: selected.effort ?? null,
    label: selected.label ?? `${provider} profile`,
    tier: promoted ? "promoted" : "default",
    score,
    confidence: matchRows.some(({ signal }) => SKILL_SIGNALS.includes(signal)) || substantive.length > 1 ? "high" : substantive.length ? "medium" : "low",
    skills: matchRows.filter(({ signal }) => SKILL_SIGNALS.includes(signal)).map(({ signal }) => signal.id),
    reasons,
    cwd: typeof cwd === "string" ? cwd : "",
    source: "local-llm-router",
    issueRefs: references,
    issues: issueContexts,
    warnings,
  };
}

export { CONFIG_PATH };

const ISSUE_REFERENCE = /(?:^|\s)#\d{3,}\b/;

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
  { id: "root-cause", label: "원인 분석", weight: 1, pattern: /root[- ]cause|investigate|debug|원인\s*분석|장애\s*분석|재현/i },
  { id: "issue-work", label: "이슈 작업", weight: 2, pattern: /(?:issue|이슈)\s*(?:확인|처리|해결|수정|구현|검토)/i },
  { id: "review", label: "검토", weight: 1, pattern: /review|검토|리뷰|역검증/i },
  { id: "change", label: "구현 변경", weight: 1, pattern: /implement|refactor|fix|수정|구현|리팩터링|고쳐/i },
  { id: "issue-reference", label: "이슈 참조", weight: 1, pattern: ISSUE_REFERENCE },
];

export const DEFAULT_ROUTING_PROFILES = Object.freeze({
  codex: Object.freeze({
    default: Object.freeze({ model: "gpt-5.6-luna", effort: "max", label: "GPT-5.6 Luna · max" }),
    promoted: Object.freeze({ model: "gpt-6-astra", effort: "low", label: "GPT-6 Astra · low" }),
  }),
  claude: Object.freeze({
    default: Object.freeze({ model: "opus", effort: "high", label: "Claude Opus · high" }),
    promoted: Object.freeze({ model: "fable", effort: "high", label: "Claude Fable · high" }),
  }),
});

function cleanPrompt(prompt) {
  return typeof prompt === "string" ? prompt.trim() : "";
}

function matchedSignals(prompt, signals) {
  return signals.filter(({ pattern }) => pattern.test(prompt));
}

function reasonFor(signal) {
  return `${signal.label} (+${signal.weight})`;
}

export function routeTask({ provider = "codex", prompt = "", cwd = "" } = {}, { profiles = DEFAULT_ROUTING_PROFILES, promotionThreshold = 3 } = {}) {
  const profile = profiles?.[provider];
  if (!profile?.default || !profile?.promoted) throw new TypeError(`Unknown routing provider: ${provider}`);
  const text = cleanPrompt(prompt);
  const skills = matchedSignals(text, SKILL_SIGNALS);
  const taskSignals = matchedSignals(text, TASK_SIGNALS);
  const matches = [...skills, ...taskSignals];
  const score = matches.reduce((total, signal) => total + signal.weight, 0);
  const promoted = score >= promotionThreshold;
  const selected = promoted ? profile.promoted : profile.default;
  const reasons = matches.map(reasonFor);
  const substantiveSignals = taskSignals.filter(({ id }) => !["change", "review", "issue-reference"].includes(id));
  if (!reasons.length) reasons.push("기본 작업 프로파일 (+0)");

  return {
    provider,
    model: selected.model,
    effort: selected.effort,
    label: selected.label,
    tier: promoted ? "promoted" : "default",
    score,
    confidence: skills.length || substantiveSignals.length > 1 ? "high" : substantiveSignals.length ? "medium" : "low",
    skills: skills.map(({ id }) => id),
    reasons,
    cwd: typeof cwd === "string" ? cwd : "",
  };
}

export function routingSummary(routing) {
  if (!routing) return "자동 라우팅: 기본 프로파일";
  const reason = routing.reasons?.slice(0, 2).join(", ") || "기본 작업 프로파일 (+0)";
  return `자동 라우팅: ${routing.label} · ${reason}`;
}

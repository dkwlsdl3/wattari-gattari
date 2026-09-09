import { CODEX_EXECUTION_MODES, isCodexExecutionMode } from "./codex-execution.mjs";

const CLAUDE_PERMISSION_VALUES = new Set(["default", "manual", "acceptEdits", "auto", "dontAsk", "plan", "bypassPermissions"]);
const CODEX_APPROVAL_VALUES = new Set(["default", "untrusted", "on-request", "never", "granular"]);
const CODEX_SANDBOX_VALUES = new Set(["default", "read-only", "workspace-write", "danger-full-access"]);
const CODEX_REVIEWER_VALUES = new Set(["default", "user", "auto_review", "guardian_subagent"]);
const CODEX_SUMMARY_VALUES = new Set(["default", "auto", "concise", "detailed", "none"]);

const CLAUDE_DEFAULTS = {
  permissionMode: "default",
  options: {
    dangerouslySkipPermissions: false,
    restricted: false,
    bare: false,
    disableSlashCommands: false,
    strictMcpConfig: false,
  },
};

const CODEX_DEFAULTS = {
  approvalPolicy: "default",
  sandbox: "default",
  approvalsReviewer: "default",
  summary: "default",
  granularApproval: {
    sandboxApproval: true,
    rules: true,
    skillApproval: true,
    requestPermissions: true,
    mcpElicitations: true,
  },
  options: {
    allowProviderModelFallback: false,
  },
};

export const PROVIDER_EXECUTION_GROUPS = Object.freeze({
  claude: Object.freeze([
    Object.freeze({
      type: "radio",
      field: "permissionMode",
      title: "승인 권한",
      options: Object.freeze([
        Object.freeze({ value: "default", label: "기본값", description: "Claude 설정 파일의 권한 정책을 사용합니다." }),
        Object.freeze({ value: "manual", label: "수동 승인", description: "도구 실행마다 명시적인 승인을 요청합니다." }),
        Object.freeze({ value: "acceptEdits", label: "편집 자동 승인", description: "파일 편집은 자동 승인하고 나머지는 확인합니다." }),
        Object.freeze({ value: "auto", label: "자동", description: "Claude의 자동 권한 모드를 사용합니다." }),
        Object.freeze({ value: "dontAsk", label: "묻지 않음", description: "권한 프롬프트를 표시하지 않습니다." }),
        Object.freeze({ value: "plan", label: "계획만", description: "계획을 만들고 실행은 승인 후 진행합니다." }),
        Object.freeze({ value: "bypassPermissions", label: "권한 우회", description: "Claude의 permission-mode 우회 옵션입니다." }),
      ]),
    }),
    Object.freeze({
      type: "checkbox",
      field: "options",
      title: "실행 추가 옵션",
      options: Object.freeze([
        Object.freeze({ key: "dangerouslySkipPermissions", label: "dangerously-skip-permissions", description: "Claude의 모든 권한 확인을 우회합니다.", danger: true }),
        Object.freeze({ key: "restricted", label: "restricted", description: "명령 실행 도구를 제한하고 우회 권한을 거부합니다." }),
        Object.freeze({ key: "bare", label: "bare", description: "훅·플러그인·자동 설정을 줄인 최소 실행입니다." }),
        Object.freeze({ key: "disableSlashCommands", label: "disable-slash-commands", description: "스킬과 슬래시 명령을 비활성화합니다." }),
        Object.freeze({ key: "strictMcpConfig", label: "strict-mcp-config", description: "명시한 MCP 설정만 사용합니다." }),
      ]),
    }),
  ]),
  codex: Object.freeze([
    Object.freeze({
      type: "radio",
      field: "approvalPolicy",
      title: "승인 권한",
      options: Object.freeze([
        Object.freeze({ value: "default", label: "기본값", description: "Codex 설정 파일의 승인 정책을 사용합니다." }),
        Object.freeze({ value: "untrusted", label: "신뢰되지 않은 명령만", description: "신뢰되지 않은 명령에만 승인을 요청합니다." }),
        Object.freeze({ value: "on-request", label: "필요할 때 승인", description: "모델이 필요하다고 판단한 작업을 확인합니다." }),
        Object.freeze({ value: "never", label: "승인 안 함", description: "사용자 승인 요청을 하지 않습니다." }),
        Object.freeze({ value: "granular", label: "세부 승인", description: "아래 세부 승인 항목을 조합합니다." }),
      ]),
    }),
    Object.freeze({
      type: "radio",
      field: "sandbox",
      title: "샌드박스",
      options: Object.freeze([
        Object.freeze({ value: "default", label: "기본값", description: "Codex 설정 파일의 샌드박스 정책을 사용합니다." }),
        Object.freeze({ value: "read-only", label: "읽기 전용", description: "파일 변경 없이 읽기 작업만 허용합니다." }),
        Object.freeze({ value: "workspace-write", label: "워크스페이스 쓰기", description: "현재 워크스페이스에 파일 쓰기를 허용합니다." }),
        Object.freeze({ value: "danger-full-access", label: "전체 접근", description: "샌드박스 제한 없이 실행합니다.", danger: true }),
      ]),
    }),
    Object.freeze({
      type: "radio",
      field: "approvalsReviewer",
      title: "승인 검토자",
      options: Object.freeze([
        Object.freeze({ value: "default", label: "기본값", description: "Codex의 기본 사용자 검토를 사용합니다." }),
        Object.freeze({ value: "user", label: "사용자", description: "승인 요청을 사용자에게 보냅니다." }),
        Object.freeze({ value: "auto_review", label: "자동 검토", description: "Codex 자동 검토 에이전트가 승인 요청을 판단합니다." }),
        Object.freeze({ value: "guardian_subagent", label: "Guardian subagent", description: "호환용 Guardian 검토자를 사용합니다." }),
      ]),
    }),
    Object.freeze({
      type: "radio",
      field: "summary",
      title: "추론 요약",
      options: Object.freeze([
        Object.freeze({ value: "default", label: "기본값", description: "Codex 설정 파일의 추론 요약 설정을 사용합니다." }),
        Object.freeze({ value: "auto", label: "자동", description: "Codex가 요약 수준을 선택합니다." }),
        Object.freeze({ value: "concise", label: "간결", description: "짧은 추론 요약을 요청합니다." }),
        Object.freeze({ value: "detailed", label: "상세", description: "상세한 추론 요약을 요청합니다." }),
        Object.freeze({ value: "none", label: "표시 안 함", description: "추론 요약을 표시하지 않습니다." }),
      ]),
    }),
    Object.freeze({
      type: "checkbox",
      field: "granularApproval",
      title: "세부 승인 항목 (승인 권한이 세부 승인일 때 적용)",
      options: Object.freeze([
        Object.freeze({ key: "sandboxApproval", label: "샌드박스 탈출", description: "샌드박스 밖 실행 요청을 승인 대상으로 둡니다." }),
        Object.freeze({ key: "rules", label: "명령 규칙", description: "명령 규칙 확인을 승인 대상으로 둡니다." }),
        Object.freeze({ key: "skillApproval", label: "스킬", description: "스킬 실행 확인을 승인 대상으로 둡니다." }),
        Object.freeze({ key: "requestPermissions", label: "권한 요청", description: "추가 권한 요청을 승인 대상으로 둡니다." }),
        Object.freeze({ key: "mcpElicitations", label: "MCP 입력", description: "MCP의 사용자 입력 요청을 승인 대상으로 둡니다." }),
      ]),
    }),
    Object.freeze({
      type: "checkbox",
      field: "options",
      title: "실행 추가 옵션",
      options: Object.freeze([
        Object.freeze({ key: "allowProviderModelFallback", label: "provider 모델 대체 허용", description: "요청한 모델을 사용할 수 없으면 provider 기본 모델로 대체합니다." }),
      ]),
    }),
  ]),
});

function invalid(message) {
  return Object.assign(new Error(message), { code: "EXECUTION_SETTINGS_INVALID" });
}

function clone(value) {
  return structuredClone(value);
}

function bool(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

export function defaultProviderExecutionSettings() {
  return { claude: clone(CLAUDE_DEFAULTS), codex: clone(CODEX_DEFAULTS) };
}

export function normalizeProviderExecutionSettings(provider, value = {}) {
  if (provider === "claude") {
    const settings = {
      ...clone(CLAUDE_DEFAULTS),
      ...(value && typeof value === "object" ? value : {}),
      options: { ...CLAUDE_DEFAULTS.options, ...(value?.options && typeof value.options === "object" ? value.options : {}) },
    };
    if (!CLAUDE_PERMISSION_VALUES.has(settings.permissionMode)) throw invalid("Unknown Claude permission mode");
    for (const key of Object.keys(CLAUDE_DEFAULTS.options)) settings.options[key] = bool(settings.options[key], CLAUDE_DEFAULTS.options[key]);
    // These CLI flags are mutually exclusive with bypass/restricted execution.
    if (settings.permissionMode === "bypassPermissions") {
      settings.options.dangerouslySkipPermissions = false;
      settings.options.restricted = false;
    }
    if (settings.options.dangerouslySkipPermissions || settings.options.restricted) settings.permissionMode = "default";
    if (settings.options.dangerouslySkipPermissions) settings.options.restricted = false;
    return settings;
  }
  if (provider === "codex") {
    const settings = {
      ...clone(CODEX_DEFAULTS),
      ...(value && typeof value === "object" ? value : {}),
      granularApproval: { ...CODEX_DEFAULTS.granularApproval, ...(value?.granularApproval && typeof value.granularApproval === "object" ? value.granularApproval : {}) },
      options: { ...CODEX_DEFAULTS.options, ...(value?.options && typeof value.options === "object" ? value.options : {}) },
    };
    if (!CODEX_APPROVAL_VALUES.has(settings.approvalPolicy)) throw invalid("Unknown Codex approval policy");
    if (!CODEX_SANDBOX_VALUES.has(settings.sandbox)) throw invalid("Unknown Codex sandbox mode");
    if (!CODEX_REVIEWER_VALUES.has(settings.approvalsReviewer)) throw invalid("Unknown Codex approvals reviewer");
    if (!CODEX_SUMMARY_VALUES.has(settings.summary)) throw invalid("Unknown Codex reasoning summary");
    for (const key of Object.keys(CODEX_DEFAULTS.granularApproval)) settings.granularApproval[key] = bool(settings.granularApproval[key], CODEX_DEFAULTS.granularApproval[key]);
    for (const key of Object.keys(CODEX_DEFAULTS.options)) settings.options[key] = bool(settings.options[key], CODEX_DEFAULTS.options[key]);
    return settings;
  }
  throw invalid(`Unknown provider: ${provider}`);
}

export function normalizeAllProviderExecutionSettings(value = {}) {
  const source = value?.providers && typeof value.providers === "object" ? value.providers : value;
  return {
    claude: normalizeProviderExecutionSettings("claude", source?.claude),
    codex: normalizeProviderExecutionSettings("codex", source?.codex),
  };
}

export function migrateLegacyProviderExecutionSettings(value) {
  const settings = defaultProviderExecutionSettings();
  if (isCodexExecutionMode(value)) {
    if (value === CODEX_EXECUTION_MODES.YOLO) {
      settings.codex.approvalPolicy = "never";
      settings.codex.sandbox = "danger-full-access";
    }
    return settings;
  }
  return normalizeAllProviderExecutionSettings(value);
}

export function codexExecutionModeForSettings(value) {
  const settings = normalizeProviderExecutionSettings("codex", value);
  return settings.approvalPolicy === "never" && settings.sandbox === "danger-full-access"
    ? CODEX_EXECUTION_MODES.YOLO
    : CODEX_EXECUTION_MODES.DEFAULT;
}

export function codexSettingsForExecutionMode(mode, current = CODEX_DEFAULTS) {
  if (!isCodexExecutionMode(mode)) throw Object.assign(new TypeError("Unknown Codex execution mode"), { code: "CODEX_EXECUTION_MODE_INVALID" });
  const settings = normalizeProviderExecutionSettings("codex", current);
  if (mode === CODEX_EXECUTION_MODES.YOLO) {
    settings.approvalPolicy = "never";
    settings.sandbox = "danger-full-access";
  } else {
    settings.approvalPolicy = "default";
    settings.sandbox = "default";
  }
  return settings;
}

export function providerExecutionSummary(provider, value) {
  const settings = normalizeProviderExecutionSettings(provider, value);
  if (provider === "claude") {
    const permission = settings.options.dangerouslySkipPermissions
      ? "dangerously-skip-permissions"
      : settings.permissionMode === "default" ? "기본 승인" : settings.permissionMode;
    const options = Object.entries(settings.options).filter(([, enabled]) => enabled).map(([key]) => key);
    return `Claude 승인: ${permission}${options.length ? ` · ${options.join(", ")}` : ""}`;
  }
  const approval = settings.approvalPolicy === "default" ? "기본 승인" : settings.approvalPolicy;
  const sandbox = settings.sandbox === "default" ? "기본 샌드박스" : settings.sandbox;
  const reviewer = settings.approvalsReviewer === "default" ? "기본 검토" : settings.approvalsReviewer;
  return `Codex 승인: ${approval} · 샌드박스: ${sandbox} · 검토: ${reviewer}`;
}

export function providerExecutionSections(provider, value) {
  const settings = normalizeProviderExecutionSettings(provider, value);
  return PROVIDER_EXECUTION_GROUPS[provider].map((group) => ({
    ...group,
    rows: group.options.map((option) => ({
      ...option,
      kind: group.type,
      field: group.field,
      selected: group.type === "radio"
        ? settings[group.field] === option.value
        : Boolean(settings[group.field]?.[option.key]),
      disabled: group.field === "granularApproval" && settings.approvalPolicy !== "granular",
    })),
  }));
}

export function providerExecutionRows(provider, value) {
  return providerExecutionSections(provider, value).flatMap((section) => section.rows);
}

export function updateProviderExecutionSetting(provider, value, row) {
  const settings = normalizeProviderExecutionSettings(provider, value);
  if (row.kind === "radio") settings[row.field] = row.value;
  else if (row.kind === "checkbox") settings[row.field][row.key] = !settings[row.field][row.key];
  else throw new TypeError("Unknown execution setting row");
  return normalizeProviderExecutionSettings(provider, settings);
}

function granularPolicy(settings) {
  return {
    granular: {
      sandbox_approval: settings.granularApproval.sandboxApproval,
      rules: settings.granularApproval.rules,
      skill_approval: settings.granularApproval.skillApproval,
      request_permissions: settings.granularApproval.requestPermissions,
      mcp_elicitations: settings.granularApproval.mcpElicitations,
    },
  };
}

function codexSandboxPolicy(mode, cwd) {
  if (mode === "danger-full-access") return { type: "dangerFullAccess" };
  if (mode === "read-only") return { type: "readOnly", networkAccess: false };
  if (mode === "workspace-write") {
    return {
      type: "workspaceWrite",
      writableRoots: cwd ? [cwd] : [],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    };
  }
  return null;
}

export function applyClaudeExecutionSettings(args, value) {
  const settings = normalizeProviderExecutionSettings("claude", value);
  if (settings.permissionMode !== "default" && !settings.options.dangerouslySkipPermissions && !settings.options.restricted) {
    args.push("--permission-mode", settings.permissionMode);
  }
  if (settings.options.dangerouslySkipPermissions) args.push("--dangerously-skip-permissions");
  if (settings.options.restricted) args.push("--restricted");
  if (settings.options.bare) args.push("--bare");
  if (settings.options.disableSlashCommands) args.push("--disable-slash-commands");
  if (settings.options.strictMcpConfig) args.push("--strict-mcp-config");
  return args;
}

export function applyCodexExecutionSettings(target, value, phase, { cwd } = {}) {
  const settings = normalizeProviderExecutionSettings("codex", value);
  const result = { ...target };
  if (settings.approvalPolicy !== "default") result.approvalPolicy = settings.approvalPolicy === "granular" ? granularPolicy(settings) : settings.approvalPolicy;
  if (settings.approvalsReviewer !== "default") result.approvalsReviewer = settings.approvalsReviewer;
  if (phase === "thread") {
    if (settings.sandbox !== "default") result.sandbox = settings.sandbox;
    if (settings.options.allowProviderModelFallback) result.allowProviderModelFallback = true;
  } else if (phase === "turn") {
    const sandbox = codexSandboxPolicy(settings.sandbox, cwd);
    if (sandbox) result.sandboxPolicy = sandbox;
    if (settings.summary !== "default") result.summary = settings.summary;
  } else {
    throw new TypeError("Codex execution settings phase must be thread or turn");
  }
  return result;
}

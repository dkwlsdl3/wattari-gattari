const CODEX_NAMES = `
/permissions /ide /keymap /vim /agent /subagents /apps /plugins /hooks
/clear /rename /archive /delete /compact /copy /diff /exit /experimental
/approve /memories /skills /import /feedback /init /logout /mcp /mention
/model /fast /plan /goal /personality /ps /stop /fork /app /side /btw
/raw /resume /new /quit /review /status /usage /debug-config /statusline
/title /theme /pets /pet
`.trim().split(/\s+/);

const CLAUDE_NAMES = `
/add-dir /advisor /agents /artifacts /auto-mode-setup /autocompact /autofix-pr
/background /batch /branch /btw /bug /cd /chrome /claude-api /clear
/code-review /color /compact /config /context /copy /cost /dataviz /debug
/deep-research /design /design-login /design-sync /desktop /diff /doctor
/effort /exit /export /fast /feedback /fewer-permission-prompts /focus
/fork /goal /heapdump /help /hooks /ide /import /init /insights
/install-github-app /install-slack-app /keybindings /list-agents /login
/logout /loop /mcp /memory /mobile /model /passes /permissions /plan
/plugin /powerup /pr-comments /privacy-settings /radio /rate-limit-options
/recap /release-notes /reload-plugins /reload-skills /remote-control
/remote-env /rename /resume /review /rewind /run /run-skill-generator
/sandbox /schedule /scroll-speed /security-review /setup-bedrock /setup-vertex
/simplify /skills /stats /status /statusline /stickers /stop /subtask /tasks
/team-onboarding /teleport /terminal-setup /theme /tui /ultraplan
/ultrareview /upgrade /usage /usage-credits /verify /vim /voice /web-setup
/workflow-authoring /workflows
`.trim().split(/\s+/);

const WAGA_NAMES = ["/back", "/interrupt", "/help"];

const descriptions = {
  "/add-dir": "현재 세션에 접근 가능한 작업 디렉터리 추가",
  "/advisor": "보조 모델 advisor 설정",
  "/agent": "활성 에이전트 선택",
  "/agents": "서브에이전트 설정 안내",
  "/app": "연결된 앱 사용",
  "/apps": "앱 연결 관리",
  "/approve": "대기 중인 승인 요청 처리",
  "/archive": "현재 세션 보관",
  "/artifacts": "Claude artifact 탐색·첨부",
  "/auto-mode-setup": "프로젝트용 auto mode 환경 초안 생성",
  "/autocompact": "자동 압축 시점 설정",
  "/autofix-pr": "PR CI·리뷰 자동 수정 세션 시작",
  "/background": "현재 Claude 세션을 background로 전환",
  "/batch": "대규모 작업을 병렬 작업 단위로 분해",
  "/branch": "현재 대화 지점에서 분기",
  "/btw": "대화 기록에 넣지 않는 곁가지 질문",
  "/bug": "버그 신고 및 선택적 대화 공유",
  "/cd": "세션 작업 디렉터리 이동",
  "/chrome": "Claude in Chrome 설정",
  "/claude-api": "Claude API 개발 참고자료 로드",
  "/code-review": "코드 변경 리뷰 실행",
  "/color": "세션 색상 설정",
  "/config": "Claude Code 설정 화면",
  "/dataviz": "데이터 시각화 작업 스킬 실행",
  "/debug": "디버그 로그 설정",
  "/debug-config": "적용 중인 Codex 설정 진단",
  "/deep-research": "심층 웹 조사 실행",
  "/delete": "저장된 세션 영구 삭제",
  "/design": "디자인 작업 스킬 실행",
  "/design-login": "디자인 도구 계정 연결",
  "/design-sync": "디자인 컨텍스트 동기화",
  "/desktop": "Claude Desktop에서 열기",
  "/doctor": "Claude Code 설치·환경 진단",
  "/experimental": "실험 기능 설정",
  "/export": "현재 대화 내보내기",
  "/feedback": "제품 피드백 전송",
  "/fewer-permission-prompts": "권한 프롬프트 감소 설정",
  "/focus": "집중형 작업 스킬 실행",
  "/goal": "세션 목표 설정·확인",
  "/heapdump": "진단용 메모리 heap dump 생성",
  "/hooks": "hook 설정·상태 보기",
  "/ide": "IDE 연결 관리",
  "/import": "외부 에이전트 설정 가져오기",
  "/init": "프로젝트 에이전트 지침 초기화",
  "/insights": "Claude Code 사용 패턴 보고서 생성",
  "/install-github-app": "Claude GitHub App 설치",
  "/install-slack-app": "Claude Slack App 설치",
  "/keybindings": "키 바인딩 설정",
  "/keymap": "Codex 키맵 설정",
  "/list-agents": "현재 에이전트와 peer 목록 보기",
  "/login": "계정 로그인",
  "/logout": "계정 로그아웃",
  "/loop": "명령 또는 프롬프트 반복 예약",
  "/mcp": "MCP 서버 연결 관리",
  "/memories": "Codex memory 보기·관리",
  "/memory": "Claude memory 파일 편집",
  "/mention": "파일 또는 리소스를 대화에 첨부",
  "/mobile": "모바일 앱 연결 안내",
  "/passes": "Claude 사용권 pass 상태 보기",
  "/permissions": "도구 권한 보기·설정",
  "/pet": "Codex 화면 pet 설정",
  "/pets": "Codex 화면 pet 선택",
  "/plan": "계획 모드 전환",
  "/plugin": "Claude plugin 관리",
  "/plugins": "Codex plugin 관리",
  "/powerup": "Claude Code 기능 안내",
  "/pr-comments": "제거된 명령",
  "/privacy-settings": "개인정보 설정 열기",
  "/ps": "실행 중인 agent·process 보기",
  "/radio": "Claude Code radio 기능",
  "/rate-limit-options": "사용량 한도 도달 시 선택지 보기",
  "/raw": "가공하지 않은 출력 보기",
  "/recap": "최근 작업 요약 보기",
  "/release-notes": "릴리스 노트 보기",
  "/reload-plugins": "설치된 plugin 다시 로드",
  "/reload-skills": "사용 가능한 skill 다시 로드",
  "/remote-control": "원격 제어 연결 시작",
  "/remote-env": "원격 실행 환경 관리",
  "/rewind": "이전 대화 지점으로 되돌리기",
  "/run": "저장된 workflow 실행",
  "/run-skill-generator": "새 skill 생성 도우미 실행",
  "/sandbox": "sandbox 상태·설정 보기",
  "/schedule": "반복 작업 예약",
  "/scroll-speed": "대화 스크롤 속도 설정",
  "/security-review": "변경사항 보안 리뷰",
  "/setup-bedrock": "Amazon Bedrock provider 설정",
  "/setup-vertex": "Google Vertex AI provider 설정",
  "/side": "현재 대화와 분리된 곁가지 작업",
  "/simplify": "변경 코드를 검토하고 단순화",
  "/skills": "사용 가능한 skill 보기",
  "/stickers": "Claude Code sticker 안내",
  "/subagents": "Codex 서브에이전트 보기·관리",
  "/subtask": "현재 작업에서 서브태스크 위임",
  "/tasks": "백그라운드 task 목록 보기",
  "/team-onboarding": "팀용 Claude Code 온보딩",
  "/teleport": "원격 세션을 로컬로 가져오기",
  "/terminal-setup": "터미널 줄바꿈 키 설정",
  "/theme": "터미널 색상 테마 설정",
  "/title": "터미널 제목 설정",
  "/tui": "Claude TUI renderer 전환",
  "/ultraplan": "제거된 명령; plan mode 사용",
  "/ultrareview": "cloud multi-agent 심층 리뷰",
  "/upgrade": "요금제 업그레이드 페이지 열기",
  "/usage-credits": "추가 사용량 credit 설정",
  "/verify": "앱을 직접 실행해 변경사항 검증",
  "/vim": "Vim 입력 모드 설정",
  "/voice": "음성 받아쓰기 설정",
  "/web-setup": "Claude Code on the web 연결",
  "/workflow-authoring": "동적 workflow 작성 참고자료 로드",
  "/workflows": "workflow 진행 화면 열기",
  "/status": "현재 세션 상태 보기",
  "/statusline": "하단 상태선 정보 보기",
  "/usage": "토큰 및 사용 한도 보기",
  "/context": "컨텍스트 사용량 보기",
  "/cost": "세션 사용량 보기",
  "/stats": "세션 활동 통계 보기",
  "/stop": "현재 작업 중단",
  "/interrupt": "현재 작업 중단 (Waga)",
  "/rename": "세션 이름 변경: /rename 새 이름",
  "/back": "세션 목록으로 돌아가기 (Waga)",
  "/help": "사용 가능한 명령 안내",
  "/compact": "대화 컨텍스트 압축",
  "/fork": "현재 지점에서 세션 복제",
  "/review": "현재 변경사항 코드 리뷰",
  "/model": "모델 확인/변경: /model [이름]",
  "/effort": "추론 강도 확인/변경: /effort [단계]",
  "/fast": "빠른 응답 모드 전환",
  "/personality": "응답 성격 확인/변경",
  "/copy": "마지막 에이전트 답변 복사",
  "/diff": "현재 작업 트리 변경 보기",
  "/exit": "Waga 화면 닫기",
  "/quit": "Waga 화면 닫기",
  "/new": "새 세션 작성 화면으로 이동",
  "/resume": "세션 목록으로 이동",
  "/clear": "새 세션 작성 화면으로 이동",
};

const local = new Set([
  "/status", "/statusline", "/usage", "/context", "/cost", "/stats",
  "/stop", "/interrupt", "/rename", "/back", "/help", "/copy", "/diff",
  "/exit", "/quit", "/new", "/resume", "/clear",
]);

const codexRpc = new Set([
  "/compact", "/fork", "/review", "/model", "/effort", "/fast",
  "/personality", "/permissions", "/mcp", "/skills",
]);
const claudeBackground = new Set([
  "/compact", "/model", "/effort", "/fork", "/branch", "/batch",
  "/claude-api", "/code-review", "/dataviz", "/deep-research", "/design",
  "/init", "/loop", "/review", "/security-review", "/simplify", "/verify",
  "/workflow-authoring",
]);

function description(name, provider, support) {
  if (descriptions[name]) return descriptions[name];
  const product = provider === "claude" ? "Claude Code" : "Codex";
  return support === "attach"
    ? `${product} 원본 TUI에서 사용`
    : `${product} 기본 명령`;
}

function supportFor(provider, name) {
  if (local.has(name)) return "local";
  if (provider === "codex" && codexRpc.has(name)) return "provider";
  if (provider === "claude" && claudeBackground.has(name)) return "provider";
  return "attach";
}

/**
 * The names mirror the built-in command tables shipped in the official
 * Codex and Claude Code documentation. Availability still varies by platform,
 * account, feature flag and installed plugin, so Waga labels commands it
 * cannot faithfully execute in a managed background session as attach-only.
 */
export function slashCommandsFor(provider) {
  const names = provider === "claude" ? CLAUDE_NAMES : CODEX_NAMES;
  const unique = [...new Set([...names, ...WAGA_NAMES])];
  return unique.map((name) => {
    const support = supportFor(provider, name);
    return { name, description: description(name, provider, support), support };
  });
}

export function slashCommand(provider, name) {
  return slashCommandsFor(provider).find((command) => command.name === name) ?? null;
}

export function matchSlashCommands(provider, input) {
  if (typeof input !== "string" || !input.startsWith("/") || /\s/.test(input)) return [];
  const query = input.slice(1).toLowerCase();
  return slashCommandsFor(provider).filter(({ name, description }) => (
    name.slice(1).includes(query) || description.toLowerCase().includes(query)
  ));
}

export const officialSlashCommandCounts = Object.freeze({
  codex: CODEX_NAMES.length,
  claude: CLAUDE_NAMES.length,
});

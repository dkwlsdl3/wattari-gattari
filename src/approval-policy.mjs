const COMMAND_PREFIX = String.raw`(?:^|[;&|()\n])\s*(?:(?:command|nohup)\s+|env(?:\s+[A-Za-z_]\w*=\S+)*\s+)?(?:[^\s;&|()]+/)?`;

function commandPattern(source) {
  return new RegExp(`${COMMAND_PREFIX}${source}`, "i");
}

const SHELL_RULES = [
  [commandPattern(String.raw`(?:sudo|su)\b`), "권한 상승"],
  [commandPattern(String.raw`(?:rm|rmdir|unlink|shred|truncate|wipefs|mkfs(?:\.[\w-]+)?|fdisk|parted)\b`), "파일 또는 저장장치 삭제"],
  [commandPattern(String.raw`find\b[^;\n]*(?:\s-delete\b|\s-exec(?:dir)?\b[^;\n]*(?:rm|rmdir|unlink|shred)\b)`), "find를 통한 파일 삭제"],
  [commandPattern(String.raw`xargs\b[^;\n]*(?:rm|rmdir|unlink|shred)\b`), "xargs를 통한 파일 삭제"],
  [commandPattern(String.raw`(?:bash|dash|sh|zsh)\b[^;\n]*\s-c\b`), "인라인 셸 실행"],
  [commandPattern(String.raw`(?:node|python(?:\d+(?:\.\d+)?)?|ruby|perl)\b[^;\n]*\s-(?:c|e)\b`), "인라인 프로그램 실행"],
  [commandPattern(String.raw`dd\b[^;\n]*(?:\bof=|--output\b)`), "원시 데이터 덮어쓰기"],
  [commandPattern(String.raw`git\s+(?:push|clean)\b`), "Git 원격 반영 또는 작업트리 정리"],
  [commandPattern(String.raw`git\s+reset\b[^;\n]*--hard\b`), "Git 작업트리 강제 초기화"],
  [commandPattern(String.raw`git\s+(?:checkout|restore)\b[^;\n]*\s--(?:\s|$)`), "Git 작업트리 덮어쓰기"],
  [commandPattern(String.raw`git\s+(?:branch\s+-D|tag\s+-d)\b`), "Git 참조 강제 삭제"],
  [commandPattern(String.raw`(?:shutdown|reboot|poweroff|halt|systemctl\s+(?:stop|restart|disable)|service\s+\S+\s+(?:stop|restart)|killall|pkill|kill)\b`), "프로세스 또는 서비스 중단"],
  [commandPattern(String.raw`(?:docker|podman)(?:\s+compose)?\s+(?:down|kill|rm|stop|restart)\b`), "컨테이너 또는 서비스 중단"],
  [commandPattern(String.raw`terraform\s+(?:apply|destroy)\b`), "인프라 변경"],
  [commandPattern(String.raw`kubectl\s+(?:apply|delete|patch|replace|scale|rollout\s+restart)\b`), "클러스터 변경"],
  [commandPattern(String.raw`helm\s+(?:install|upgrade|uninstall|rollback)\b`), "클러스터 릴리스 변경"],
  [commandPattern(String.raw`curl\b[^;\n]*(?:-X|--request)\s*(?:POST|PUT|PATCH|DELETE)\b`), "외부 HTTP 변경"],
  [commandPattern(String.raw`(?:npm\s+publish|cargo\s+publish|twine\s+upload)\b`), "패키지 배포"],
  [commandPattern(String.raw`gh\s+(?:pr\s+(?:create|close|comment|edit|merge|review)|issue\s+(?:create|close|comment|edit)|release\s+(?:create|delete)|repo\s+delete)\b`), "GitHub 원격 변경"],
];

function shellRisk(command) {
  for (const [pattern, reason] of SHELL_RULES) {
    if (pattern.test(command)) return { kind: "shell", reason, summary: command };
  }
  return null;
}

export function classifyApprovalRequest(payload) {
  if (!payload || typeof payload !== "object") return null;
  const toolName = payload.tool_name;
  const toolInput = payload.tool_input;
  if (typeof toolName !== "string" || !toolInput || typeof toolInput !== "object") return null;

  if (toolName === "Bash") {
    const command = toolInput.command;
    return typeof command === "string" ? shellRisk(command) : null;
  }
  if (toolName === "apply_patch") {
    const patch = toolInput.command;
    if (typeof patch === "string" && /^\*\*\* Delete File:/m.test(patch)) {
      return { kind: "file-delete", reason: "파일 삭제", summary: patch };
    }
    return null;
  }
  if (toolName === "write_stdin") {
    return { kind: "process-input", reason: "실행 중인 프로세스 입력", summary: JSON.stringify(toolInput) };
  }
  if (toolName === "request_permissions") {
    return { kind: "permission", reason: "권한 범위 확대", summary: JSON.stringify(toolInput) };
  }
  return null;
}

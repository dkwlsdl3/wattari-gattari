export const CODEX_EXECUTION_MODES = Object.freeze({
  DEFAULT: "default",
  YOLO: "yolo",
});

export function isCodexExecutionMode(value) {
  return value === CODEX_EXECUTION_MODES.DEFAULT || value === CODEX_EXECUTION_MODES.YOLO;
}

export function codexExecutionLabel(mode) {
  return mode === CODEX_EXECUTION_MODES.YOLO
    ? "Codex 생성·열기: YOLO (승인·샌드박스 해제)"
    : "Codex 새 세션: 기본값";
}

export function applyCodexExecutionMode(target, mode, phase) {
  if (mode === undefined || mode === CODEX_EXECUTION_MODES.DEFAULT) return target;
  if (mode !== CODEX_EXECUTION_MODES.YOLO) {
    throw Object.assign(new TypeError("Unknown Codex execution mode"), { code: "CODEX_EXECUTION_MODE_INVALID" });
  }
  if (phase === "thread") return { ...target, approvalPolicy: "never", sandbox: "danger-full-access" };
  if (phase === "turn") return { ...target, approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } };
  throw new TypeError("Codex execution phase must be thread or turn");
}

#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { ensureWagaDaemon } from "./waga-background.mjs";
import { appPaths } from "./app-paths.mjs";
import { ControlClient } from "./control-client.mjs";
import { InputHistory } from "./input-history.mjs";
import { DISPLAY_NAME } from "./product.mjs";
import { sessionTree, preserveCursor } from "./session-tree.mjs";
import { shutdownDialogDecision, stopDialogDecision } from "./session-console-keys.mjs";

const ESC = "\x1b[";
const reset = `${ESC}0m`;
const bold = (text) => `${ESC}1m${text}${reset}`;
const dim = (text) => `${ESC}2m${text}${reset}`;
const blue = (text) => `${ESC}94m${text}${reset}`;
const green = (text) => `${ESC}92m${text}${reset}`;
const yellow = (text) => `${ESC}93m${text}${reset}`;
const red = (text) => `${ESC}91m${text}${reset}`;
const cursorAnchor = "\u0000WAGA_CURSOR\u0000";
const cursorSave = `${ESC}s`;
const cursorRestore = `${ESC}u`;
const cursorShow = `${ESC}?25h`;
const cursorHide = `${ESC}?25l`;
const cursorBlinkingBar = `${ESC}5 q`;
const cursorDefaultShape = `${ESC}0 q`;

export async function runSessionConsole({
  paths = appPaths(),
  ensureDaemon = ensureWagaDaemon,
  createClient = (socketPath) => new ControlClient(socketPath),
  inputStream = process.stdin,
  outputStream = process.stdout,
  workspacePath = process.cwd(),
  listenForSignals = true,
} = {}) {
await ensureDaemon({ paths });
const client = createClient(paths.controlSocketPath);
await client.connect();
const defaultWorkspace = (() => {
  try { return fs.realpathSync(workspacePath); } catch { return workspacePath; }
})();

let state = { revision: 0, approval: null, workspaces: [] };
let collapsed = new Set();
let cursor = 0;
let view = "overview";
let detail = null;
let input = "";
let quickReply = null;
let dialog = null;
let notice = "전역 세션 허브에 연결 중";
let lastFrame = null;
let closing = false;
let loadingDetail = false;
let detailRefreshTimer = null;
let resolveRun;
let newSessionProvider = "codex";
let detailScroll = 0;
const submittedHistory = [];
const inputHistory = new InputHistory();

function nodes() {
  return sessionTree(state, collapsed);
}

function focusedNode() {
  return nodes()[cursor] ?? null;
}

function safeDisplay(text, limit = 600) {
  return String(text ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, limit);
}

function fit(text, width) {
  const value = safeDisplay(text, width * 4);
  if (value.length <= width) return value.padEnd(width);
  return `${value.slice(0, Math.max(0, width - 1))}…`;
}

function statusText(status) {
  if (status === "Working") return blue(status);
  if (status === "Awaiting input") return green(status);
  if (status === "Completed") return green(status);
  if (status === "Sleeping") return dim(status);
  if (status === "Approval") return yellow(status);
  if (status === "Needs input") return yellow(status);
  if (status === "Stopped" || status === "Error") return red(status);
  return status;
}

function displayedStatus(session) {
  return state.approval?.payload?.session_id === session.threadId ? "Approval" : session.status;
}

function inputPanel(width) {
  const divider = dim("─".repeat(Math.max(1, width - 1)));
  const anchor = dialog ? "" : cursorAnchor;
  let placeholder = `describe a task for a new ${newSessionProvider === "codex" ? "Codex" : "Claude"} session`;
  if (view !== "overview") placeholder = `message this ${detail?.provider === "claude" ? "Claude" : "Codex"} session`;
  if (quickReply) placeholder = `reply to ${quickReply.name}`;
  const value = input ? `${input}${anchor}` : `${anchor}${dim(placeholder)}`;
  return [divider, `${bold(">")} ${value}`, divider];
}

function overviewHelp() {
  const focused = focusedNode();
  if (quickReply) return "Enter send · Esc cancel · ↑/↓ input history";
  if (focused?.type === "workspace") return "↑/↓ select · Enter collapse/expand · Tab Codex/Claude · type+Enter new · Ctrl+X stop all · Ctrl+C detach · Ctrl+Q stop service";
  if (focused?.type === "session") return "↑/↓ select · Enter/→ open · Space reply · Shift+↑/↓ reorder · F2 rename · F3 complete/reopen · Ctrl+X stop";
  return "type+Enter new · Ctrl+C detach · Ctrl+Q stop service";
}

function renderOverview(width) {
  const allSessions = state.workspaces.flatMap((workspace) => workspace.sessions);
  const counts = new Map();
  for (const session of allSessions) {
    const status = displayedStatus(session);
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  const countLine = allSessions.length
    ? [...counts].map(([status, count]) => `${count} ${status.toLowerCase()}`).join(" · ")
    : "0 sessions";
  const lines = [
    `${bold(DISPLAY_NAME)}  ${blue("codex")} + ${yellow("claude")}  ${dim(`global · revision ${state.revision} · direct approval`)}`,
    dim(`${state.workspaces.length} projects · ${countLine}`),
    "",
  ];
  const focusedKey = focusedNode()?.key;
  for (const workspace of state.workspaces) {
    const workspaceKey = `workspace:${workspace.path}`;
    const workspaceMarker = focusedKey === workspaceKey ? "›" : " ";
    const folded = collapsed.has(workspace.path);
    lines.push(`${workspaceMarker} ${folded ? "▸" : "▾"} ${bold(workspace.name)} ${dim(`${workspace.sessions.length} sessions · ${workspace.path}`)}`);
    if (folded) continue;
    if (!workspace.sessions.length) {
      lines.push(dim("      아직 세션이 없습니다."));
      continue;
    }
    for (const session of workspace.sessions) {
      const marker = focusedKey === session.id ? "›" : " ";
      const name = fit(session.name, Math.min(42, Math.max(24, Math.floor(width * 0.34))));
      const provider = session.provider === "claude" ? yellow("C") : blue("X");
      lines.push(`${marker}  ${provider} ${name} ${statusText(fit(displayedStatus(session), 16))} ${dim(safeDisplay(session.lastActivity, 180))}`);
    }
    lines.push("");
  }
  lines.push(dim(`new session provider: ${newSessionProvider === "codex" ? "Codex" : "Claude"} (Tab to switch)`));
  lines.push(...inputPanel(width), dim(overviewHelp()));
  if (notice) lines.push("", yellow(notice));
  return lines;
}

function renderDetail(width) {
  if (!detail) return [red("세션을 찾을 수 없습니다."), dim("←: 목록으로")];
  const lines = [
    `${bold(detail.name)}  ${detail.provider === "claude" ? yellow("Claude") : blue("Codex")}  ${statusText(displayedStatus(detail))}`,
    dim(`${detail.sessionId ?? detail.threadId} · ${detail.cwd}`),
    "",
  ];
  const messages = detail.messages ?? [];
  const capacity = Math.max(3, (outputStream.rows ?? 30) - 10);
  const end = Math.max(0, messages.length - detailScroll);
  const start = Math.max(0, end - capacity);
  if (start > 0 || detail.hasOlderMessages) lines.push(dim(`↑ ${start}${detail.hasOlderMessages ? "+" : ""} older messages · PgUp`), "");
  for (const message of messages.slice(start, end)) {
    const agentName = detail.provider === "claude" ? "Claude" : "Codex";
    lines.push(`${message.role === "user" ? blue("You") : yellow(agentName)}: ${safeDisplay(message.text, 2_000)}`);
  }
  if (end < messages.length) lines.push(dim(`↓ ${messages.length - end} newer messages · PgDn`));
  lines.push("", ...inputPanel(width), dim("↑/↓ input history · PgUp/PgDn transcript · empty ← back · type+Enter send · Ctrl+C detach · Ctrl+Q stop service"));
  if (notice) lines.push("", yellow(notice));
  return lines;
}

function renderDialog(lines) {
  if (dialog?.kind === "rename") {
    lines.push("", `${yellow(`Rename: ${dialog.value}`)}${cursorAnchor}`, dim("Enter save · Esc cancel"));
  } else if (dialog?.kind === "stopSession") {
    lines.push("", red(`Stop '${dialog.name}'? 진행 중인 턴은 interrupt되고 transcript는 남습니다.`));
    lines.push(dim("Ctrl+X again to stop · any other key cancels"));
  } else if (dialog?.kind === "stopWorkspace") {
    lines.push("", red(`Stop all ${dialog.count} managed sessions in '${dialog.name}'?`));
    lines.push(dim("Ctrl+X again to stop all · any other key cancels"));
  } else if (dialog?.kind === "shutdown") {
    lines.push("", red("모든 TUI가 공유하는 백그라운드 서비스를 종료하시겠습니까?"));
    lines.push(dim("Ctrl+Q again to stop service · any other key cancels"));
  } else if (dialog?.kind === "approval") {
    const approval = dialog.approval;
    lines.push("", red(`직접 사용자 승인 필요${approval.pendingCount > 1 ? ` · ${approval.pendingCount - 1} queued` : ""}`));
    lines.push(yellow(`${safeDisplay(approval.risk?.reason)} · ${safeDisplay(approval.payload.tool_name)}`));
    lines.push(dim(`${safeDisplay(approval.payload.cwd, 180)} · session ${safeDisplay(approval.payload.session_id, 80)}`));
    lines.push(safeDisplay(approval.risk?.summary));
    lines.push(dim("y approve once · n deny · 다른 TUI에서 해결되면 즉시 닫힘"));
  }
  return lines;
}

function render() {
  const width = outputStream.columns ?? 120;
  const lines = view === "overview" ? renderOverview(width) : renderDetail(width);
  const frame = renderDialog(lines).join("\n");
  const hasCursor = frame.includes(cursorAnchor);
  const content = hasCursor ? frame.replace(cursorAnchor, cursorSave).replaceAll(cursorAnchor, "") : frame;
  const cursorState = hasCursor ? `${cursorRestore}${cursorBlinkingBar}${cursorShow}` : cursorHide;
  const nextFrame = `${ESC}2J${ESC}H${content}\n${cursorState}`;
  if (nextFrame === lastFrame) return;
  lastFrame = nextFrame;
  outputStream.write(nextFrame);
}

function applyState(nextState) {
  if (!nextState || nextState.revision < state.revision) return;
  const previousKey = focusedNode()?.key;
  state = nextState;
  cursor = preserveCursor(nodes(), previousKey, cursor);
  if (state.approval) dialog = { kind: "approval", approval: state.approval };
  else if (dialog?.kind === "approval") dialog = null;
  if (view !== "overview") {
    const session = state.workspaces.flatMap((workspace) => workspace.sessions).find((candidate) => candidate.threadId === view);
    if (!session) {
      view = "overview";
      detail = null;
      notice = "다른 화면에서 세션이 종료됐습니다";
    } else {
      detail = { ...detail, ...session };
      scheduleDetailRefresh();
    }
  }
  render();
}

function scheduleDetailRefresh() {
  if (loadingDetail || detailRefreshTimer || view === "overview") return;
  detailRefreshTimer = setTimeout(() => {
    detailRefreshTimer = null;
    void refreshDetail();
  }, 25);
}

async function refreshDetail() {
  if (loadingDetail || view === "overview") return;
  loadingDetail = true;
  const target = view;
  try {
    const loaded = await client.request("session/read", { workspacePath: detail.cwd, threadId: target });
    if (view === target) {
      detail = loaded;
      inputHistory.setEntries([...submittedHistory, ...(detail.messages ?? []).filter((message) => message.role === "user").map((message) => message.text)]);
    }
  } catch (error) {
    if (view === target) notice = `${error.code ?? "ERROR"}: ${error.message}`;
  } finally {
    loadingDetail = false;
    render();
  }
}

async function openFocusedSession() {
  const focused = focusedNode();
  if (focused?.type !== "session") return;
  view = focused.session.threadId;
  detail = { ...focused.session, messages: [] };
  detailScroll = 0;
  input = "";
  inputHistory.reset();
  notice = focused.session.status === "Sleeping" ? "저장된 대화 불러오는 중" : "대화 불러오는 중";
  render();
  try {
    detail = await client.request("session/open", {
      workspacePath: focused.workspacePath,
      threadId: focused.session.threadId,
    });
    inputHistory.setEntries((detail.messages ?? []).filter((message) => message.role === "user").map((message) => message.text));
    notice = "";
  } catch (error) {
    notice = `${error.code ?? "ERROR"}: ${error.message}`;
  }
  render();
}

async function submitInput() {
  const text = input.trim();
  if (!text) return;
  input = "";
  inputHistory.reset();
  submittedHistory.push(text);
  if (submittedHistory.length > 100) submittedHistory.shift();
  inputHistory.setEntries(submittedHistory);
  try {
    if (quickReply) {
      const target = quickReply;
      quickReply = null;
      notice = `메시지를 ${target.name}에 전달 중`;
      render();
      await client.request("session/send", { workspacePath: target.cwd, threadId: target.threadId, text });
    } else if (view !== "overview") {
      notice = "메시지 전달 중";
      render();
      await client.request("session/send", { workspacePath: detail.cwd, threadId: detail.threadId, text });
    } else {
      const workspacePath = focusedNode()?.workspacePath ?? defaultWorkspace;
      notice = `${workspacePath}에 실제 ${newSessionProvider === "codex" ? "Codex" : "Claude"} session 생성 중`;
      render();
      await client.request("session/create", { workspacePath, prompt: text, provider: newSessionProvider });
    }
    notice = "";
  } catch (error) {
    notice = `${error.code ?? "ERROR"}: ${error.message}`;
  }
  render();
}

async function loadOlder() {
  if (!detail || loadingDetail) return;
  const capacity = Math.max(3, (outputStream.rows ?? 30) - 10);
  if (detailScroll + capacity < (detail.messages?.length ?? 0)) {
    detailScroll = Math.min((detail.messages?.length ?? 0) - 1, detailScroll + capacity);
    render();
    return;
  }
  if (!detail.hasOlderMessages) return;
  loadingDetail = true;
  notice = "이전 기록 불러오는 중";
  render();
  try {
    const previousLength = detail.messages?.length ?? 0;
    detail = await client.request("session/older", { workspacePath: detail.cwd, threadId: detail.threadId });
    detailScroll += Math.max(0, (detail.messages?.length ?? 0) - previousLength);
    notice = detail.hasOlderMessages ? "PgUp으로 이전 기록을 한 페이지 더 불러올 수 있습니다" : "가장 오래된 대화까지 불러왔습니다";
  } catch (error) {
    notice = `${error.code ?? "ERROR"}: ${error.message}`;
  } finally {
    loadingDetail = false;
    render();
  }
}

function loadNewer() {
  const capacity = Math.max(3, (outputStream.rows ?? 30) - 10);
  detailScroll = Math.max(0, detailScroll - capacity);
  render();
}

async function confirmDialog() {
  const current = dialog;
  dialog = null;
  try {
    if (current.kind === "stopSession") {
      await client.request("session/stop", { workspacePath: current.workspacePath, threadId: current.threadId });
      notice = "세션을 종료했습니다";
    } else if (current.kind === "stopWorkspace") {
      const result = await client.request("workspace/stopAll", { path: current.workspacePath });
      notice = `${result.stopped.length}개 세션을 종료했습니다`;
    } else if (current.kind === "shutdown") {
      await client.request("daemon/shutdown");
      return cleanup();
    }
  } catch (error) {
    notice = `${error.code ?? "ERROR"}: ${error.message}`;
  }
  render();
}

async function saveRename() {
  const current = dialog;
  dialog = null;
  try {
    await client.request("session/rename", {
      workspacePath: current.workspacePath,
      threadId: current.threadId,
      name: current.value,
    });
  } catch (error) {
    notice = `${error.code ?? "ERROR"}: ${error.message}`;
  }
  render();
}

async function resolveApproval(decision) {
  const approval = dialog.approval;
  try {
    const result = await client.request("approval/resolve", { requestId: approval.requestId, decision });
    notice = result.decision === "approve" ? "정확히 일치하는 요청을 한 번 승인했습니다" : "승인 요청을 거부했습니다";
  } catch (error) {
    notice = `${error.code ?? "ERROR"}: ${error.message}`;
  }
  render();
}

function cleanup(exitCode = 0) {
  if (closing) return;
  closing = true;
  if (detailRefreshTimer) clearTimeout(detailRefreshTimer);
  inputStream.off("keypress", onKeypress);
  inputStream.setRawMode?.(false);
  inputStream.pause?.();
  outputStream.write(`${cursorShow}${cursorDefaultShape}${reset}\n`);
  client.close();
  if (listenForSignals) process.off("SIGTERM", onSigterm);
  resolveRun?.({ exitCode });
}

client.on("state", applyState);
client.on("approval", (approval) => {
  state = { ...state, approval };
  if (approval) dialog = { kind: "approval", approval };
  else if (dialog?.kind === "approval") dialog = null;
  render();
});
client.on("disconnected", () => {
  if (!closing) {
    notice = "전역 세션 허브 연결이 종료됐습니다";
    render();
  }
});

state = await client.request("workspace/register", { path: defaultWorkspace });
notice = "";
render();

readline.emitKeypressEvents(inputStream);
inputStream.setRawMode?.(true);
inputStream.resume();
outputStream.write(cursorHide);
const onKeypress = (text, key) => {
  if (dialog?.kind === "approval") {
    if (key.name === "y" || key.name === "n") void resolveApproval(key.name === "y" ? "approve" : "deny");
    return;
  }
  if (["stopSession", "stopWorkspace"].includes(dialog?.kind)) {
    if (stopDialogDecision(key) === "confirm") void confirmDialog();
    else { dialog = null; render(); }
    return;
  }
  if (dialog?.kind === "shutdown") {
    if (shutdownDialogDecision(key) === "confirm") void confirmDialog();
    else { dialog = null; render(); }
    return;
  }
  if (dialog?.kind === "rename") {
    if (key.name === "return" && dialog.value.trim()) void saveRename();
    else if (key.name === "escape") { dialog = null; render(); }
    else if (key.name === "backspace") { dialog.value = dialog.value.slice(0, -1); render(); }
    else if (!key.ctrl && !key.meta && text) { dialog.value += text; render(); }
    return;
  }
  if (key.ctrl && key.name === "c") return cleanup();
  if (key.ctrl && key.name === "q") {
    dialog = { kind: "shutdown" };
    render();
    return;
  }
  if (key.name === "escape" && quickReply) {
    quickReply = null;
    input = "";
    render();
    return;
  }
  if (view !== "overview") {
    if (key.name === "left" && !input) { view = "overview"; detail = null; render(); }
    else if (key.name === "pageup") void loadOlder();
    else if (key.name === "pagedown") loadNewer();
    else if (key.name === "up") { input = inputHistory.previous(input); render(); }
    else if (key.name === "down") { input = inputHistory.next(input); render(); }
    else if (key.name === "return") void submitInput();
    else if (key.name === "backspace") { input = input.slice(0, -1); render(); }
    else if (!key.ctrl && !key.meta && text) { input += text; render(); }
    return;
  }

  const currentNodes = nodes();
  const focused = focusedNode();
  if ((input || quickReply) && key.name === "up") {
    input = inputHistory.previous(input);
    render();
  } else if ((input || quickReply) && key.name === "down") {
    input = inputHistory.next(input);
    render();
  } else if (key.name === "tab" && !input && !quickReply) {
    newSessionProvider = newSessionProvider === "codex" ? "claude" : "codex";
    notice = `새 세션 provider: ${newSessionProvider === "codex" ? "Codex" : "Claude"}`;
    render();
  } else if (key.shift && (key.name === "up" || key.name === "down") && focused?.type === "session") {
    void client.request("session/reorder", {
      workspacePath: focused.workspacePath,
      sessionId: focused.session.id,
      direction: key.name,
    }).catch((error) => { notice = `${error.code ?? "ERROR"}: ${error.message}`; render(); });
  } else if (key.name === "up" && !input) {
    cursor = Math.max(0, cursor - 1);
    render();
  } else if (key.name === "down" && !input) {
    cursor = Math.min(Math.max(0, currentNodes.length - 1), cursor + 1);
    render();
  } else if ((key.name === "return" || key.name === "right") && !input && focused?.type === "workspace") {
    if (key.name === "right") collapsed.delete(focused.workspacePath);
    else if (collapsed.has(focused.workspacePath)) collapsed.delete(focused.workspacePath);
    else collapsed.add(focused.workspacePath);
    cursor = preserveCursor(nodes(), focused.key, cursor);
    render();
  } else if ((key.name === "return" || key.name === "right") && !input && focused?.type === "session") {
    void openFocusedSession();
  } else if (key.name === "space" && !input && focused?.type === "session") {
    quickReply = focused.session;
    inputHistory.setEntries(submittedHistory);
    render();
  } else if (key.name === "return") {
    void submitInput();
  } else if (key.name === "backspace") {
    input = input.slice(0, -1);
    render();
  } else if (key.name === "f2" && focused?.type === "session") {
    dialog = {
      kind: "rename",
      workspacePath: focused.workspacePath,
      threadId: focused.session.threadId,
      value: focused.session.name,
    };
    render();
  } else if (key.name === "f3" && focused?.type === "session") {
    const completed = focused.session.status !== "Completed";
    void client.request("session/setCompleted", {
      workspacePath: focused.workspacePath,
      sessionId: focused.session.id,
      completed,
    }).then(() => {
      notice = completed ? "세션을 완료로 표시했습니다" : "세션을 다시 열었습니다";
      render();
    }).catch((error) => { notice = `${error.code ?? "ERROR"}: ${error.message}`; render(); });
  } else if (key.ctrl && key.name === "x" && focused?.type === "session") {
    dialog = {
      kind: "stopSession",
      workspacePath: focused.workspacePath,
      threadId: focused.session.threadId,
      name: focused.session.name,
    };
    render();
  } else if (key.ctrl && key.name === "x" && focused?.type === "workspace") {
    dialog = {
      kind: "stopWorkspace",
      workspacePath: focused.workspacePath,
      name: focused.workspace.name,
      count: focused.workspace.sessions.length,
    };
    render();
  } else if (!key.ctrl && !key.meta && text) {
    input += text;
    render();
  }
};
inputStream.on("keypress", onKeypress);

const onSigterm = () => cleanup(143);
if (listenForSignals) process.on("SIGTERM", onSigterm);
return new Promise((resolve) => { resolveRun = resolve; });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { exitCode } = await runSessionConsole();
  process.exitCode = exitCode;
}

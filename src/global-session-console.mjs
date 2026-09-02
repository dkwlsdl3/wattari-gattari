#!/usr/bin/env node

import fs from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { ensureWagaDaemon } from "./waga-background.mjs";
import { appPaths } from "./app-paths.mjs";
import { ControlClient } from "./control-client.mjs";
import { InputHistory } from "./input-history.mjs";
import { DISPLAY_NAME } from "./product.mjs";
import { sessionTree, preserveCursor } from "./session-tree.mjs";
import { shutdownDialogDecision, stopDialogDecision } from "./session-console-keys.mjs";
import { matchSlashCommands, slashCommand, slashCommandsFor } from "./slash-commands.mjs";

const ESC = "\x1b[";
const reset = `${ESC}0m`;
const rgb = (red, green, blue) => (text) => `${ESC}38;2;${red};${green};${blue}m${text}${reset}`;
const bold = (text) => `${ESC}1m${text}${reset}`;
// Muted true-colour palette tuned for a dark terminal. WezTerm renders the font;
// waga only supplies semantic foreground/background colours.
const dim = rgb(139, 148, 176);
const blue = rgb(130, 170, 255);
const cyan = rgb(137, 221, 255);
const green = rgb(195, 232, 141);
const magenta = rgb(199, 146, 234);
const yellow = rgb(255, 203, 107);
const red = rgb(255, 83, 112);
const orange = rgb(247, 140, 108);
const userBackground = (text) => `${ESC}38;2;238;240;246m${ESC}48;2;44;48;64m${text}${reset}`;
const cursorAnchor = "\u0000WAGA_CURSOR\u0000";
const cursorSave = `${ESC}s`;
const cursorRestore = `${ESC}u`;
const cursorShow = `${ESC}?25h`;
const cursorHide = `${ESC}?25l`;
const cursorBlinkingBar = `${ESC}5 q`;
const cursorDefaultShape = `${ESC}0 q`;
const execFileAsync = promisify(execFile);

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
let workingTimer = null;
let resolveRun;
let newSessionProvider = "codex";
let detailScroll = 0;
let slashCursor = 0;
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

function safeText(text, limit = 20_000) {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "  ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
    .slice(0, limit);
}

function cellWidth(character) {
  const code = character.codePointAt(0);
  if (code >= 0x300 && code <= 0x36f) return 0;
  if (
    code >= 0x1100 && (
      code <= 0x115f || code === 0x2329 || code === 0x232a
      || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f)
      || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe10 && code <= 0xfe19)
      || (code >= 0xfe30 && code <= 0xfe6f)
      || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6)
      || (code >= 0x1f300 && code <= 0x1faff)
    )
  ) return 2;
  return 1;
}

function displayWidth(text) {
  return [...String(text)].reduce((width, character) => width + cellWidth(character), 0);
}

function padCells(text, width) {
  return `${text}${" ".repeat(Math.max(0, width - displayWidth(text)))}`;
}

function truncateCells(text, width) {
  if (displayWidth(text) <= width) return text;
  let value = "";
  let used = 0;
  for (const character of String(text)) {
    const size = cellWidth(character);
    if (used + size > Math.max(0, width - 1)) break;
    value += character;
    used += size;
  }
  return `${value}…`;
}

function fitCells(text, width) {
  return padCells(truncateCells(safeDisplay(text, width * 4), width), width);
}

function wrapCells(text, width) {
  const lines = [];
  for (const paragraph of safeText(text).split("\n")) {
    if (!paragraph) {
      lines.push("");
      continue;
    }
    let line = "";
    let used = 0;
    for (const character of paragraph) {
      const size = cellWidth(character);
      if (line && used + size > width) {
        lines.push(line);
        line = "";
        used = 0;
      }
      line += character;
      used += size;
    }
    lines.push(line);
  }
  return lines.length ? lines : [""];
}

function fit(text, width) {
  const value = safeDisplay(text, width * 4);
  if (value.length <= width) return value.padEnd(width);
  return `${value.slice(0, Math.max(0, width - 1))}…`;
}

function statusText(status) {
  if (status === "Working" || status.startsWith("Working ")) return blue(status);
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

function workingLabel(session) {
  const status = displayedStatus(session);
  if (status !== "Working") return status;
  if (!Number.isFinite(session.workingSince)) return "Working · Esc interrupt";
  const seconds = Math.max(0, Math.floor((Date.now() - session.workingSince) / 1_000));
  const elapsed = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `Working ${elapsed} · Esc interrupt`;
}

function shortPath(value) {
  const home = process.env.HOME;
  return home && (value === home || value.startsWith(`${home}/`)) ? `~${value.slice(home.length)}` : value;
}

function rateLimitText(window) {
  if (!window || !Number.isFinite(window.usedPercent)) return null;
  const remaining = Math.max(0, 100 - window.usedPercent);
  const duration = window.windowDurationMins;
  const label = duration >= 10_000 ? "weekly" : duration >= 60 ? `${Math.round(duration / 60)}h` : `${duration ?? "?"}m`;
  return `${label} ${remaining}% left`;
}

function formatTokenCount(value) {
  if (value < 1_000) return String(Math.round(value));
  if (value < 10_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

function estimateVisibleTokens(messages) {
  let ascii = 0;
  let nonAscii = 0;
  for (const message of messages ?? []) {
    for (const character of String(message.text ?? "")) {
      if (/\s/u.test(character)) continue;
      if (character.codePointAt(0) <= 0x7f) ascii += 1;
      else nonAscii += 1;
    }
  }
  const estimate = Math.ceil(ascii / 4 + nonAscii);
  return estimate > 0 ? estimate : null;
}

function statusLine(session, width) {
  const parts = [{ text: shortPath(session.cwd), style: green }];
  if (session.gitBranch) parts.push({ text: `git:${session.gitBranch}`, style: blue });
  if (session.model) parts.push({
    text: `${session.model}${session.reasoningEffort ? ` ${session.reasoningEffort}` : ""}`,
    style: cyan,
  });
  else parts.push({ text: session.provider === "claude" ? "Claude" : "Codex", style: cyan });
  const contextTokens = session.tokenUsage?.last?.totalTokens;
  const contextWindow = session.tokenUsage?.modelContextWindow;
  if (Number.isFinite(contextTokens)) {
    const context = Number.isFinite(contextWindow) && contextWindow > 0
      ? `/${formatTokenCount(contextWindow)} (${Math.min(100, Math.round((contextTokens / contextWindow) * 100))}%)`
      : "";
    parts.push({
      text: `tokens ${formatTokenCount(contextTokens)}${context}`,
      style: yellow,
    });
  } else {
    const estimate = estimateVisibleTokens(session.messages);
    if (estimate) parts.push({ text: `tokens ~${formatTokenCount(estimate)} visible`, style: yellow });
  }
  for (const window of [session.rateLimits?.primary, session.rateLimits?.secondary]) {
    const text = rateLimitText(window);
    if (text) parts.push({ text, style: magenta });
  }
  if (session.serviceTier) parts.push({ text: `tier:${session.serviceTier}`, style: dim });

  const lineWidth = Math.max(1, width - 1);
  const rendered = [];
  let used = 0;
  for (const part of parts) {
    const separator = used ? " · " : "";
    const separatorWidth = displayWidth(separator);
    const available = lineWidth - used - separatorWidth;
    if (available <= 0) break;
    const value = truncateCells(safeDisplay(part.text, available * 4), available);
    if (!value) break;
    if (separator) rendered.push(dim(separator));
    rendered.push(part.style(value));
    used += separatorWidth + displayWidth(value);
    if (displayWidth(value) < displayWidth(part.text)) break;
  }
  return `${rendered.join("")}${" ".repeat(Math.max(0, lineWidth - used))}`;
}

function namedDivider(width, title = null) {
  const lineWidth = Math.max(1, width - 1);
  if (!title) return dim("─".repeat(lineWidth));
  const name = truncateCells(safeDisplay(title), Math.max(1, Math.floor(width / 2) - 4));
  const label = `[ ${name} ]`;
  const left = Math.max(1, lineWidth - displayWidth(label) - 1);
  const accent = detail?.provider === "claude" ? orange : blue;
  return `${dim("─".repeat(left))} ${accent(label)}`;
}

function inputPanel(width, { title = null } = {}) {
  const divider = dim("─".repeat(Math.max(1, width - 1)));
  const anchor = dialog ? "" : cursorAnchor;
  let placeholder = `describe a task for a new ${newSessionProvider === "codex" ? "Codex" : "Claude"} session`;
  if (view !== "overview") placeholder = `message this ${detail?.provider === "claude" ? "Claude" : "Codex"} session`;
  if (quickReply) placeholder = `reply to ${quickReply.name}`;
  const provider = view === "overview" ? newSessionProvider : detail?.provider;
  const accent = provider === "claude" ? orange : blue;
  const contentWidth = Math.max(1, width - 3);
  const values = wrapCells(input || placeholder, contentWidth);
  const inputLines = values.map((line, index) => {
    const marker = index === 0 ? accent("›") : " ";
    if (input) return `${marker} ${line}${index === values.length - 1 ? anchor : ""}`;
    return `${marker} ${index === 0 ? anchor : ""}${dim(line)}`;
  });
  return [namedDivider(width, title), ...inputLines, divider];
}

function slashMatches() {
  if (view === "overview") return [];
  return matchSlashCommands(detail?.provider, input);
}

function slashMenuLines(width) {
  const matches = slashMatches();
  if (!matches.length) return [];
  slashCursor = Math.min(slashCursor, matches.length - 1);
  const start = Math.max(0, Math.min(slashCursor - 5, matches.length - 6));
  return matches.slice(start, start + 6).map((command, index) => {
    const absoluteIndex = start + index;
    const marker = absoluteIndex === slashCursor ? "›" : " ";
    const availability = command.support === "attach" ? "○" : "●";
    return fitCells(`${marker} ${availability} ${command.name.padEnd(19)} ${command.description}`, Math.max(1, width - 1));
  });
}

function messageLines(message, width) {
  const contentWidth = Math.max(8, width - 4);
  const wrapped = wrapCells(message.text, contentWidth);
  if (message.role === "user") {
    return wrapped.map((line, index) => {
      const plain = `${index === 0 ? "›" : " "} ${line}`;
      return userBackground(padCells(plain, Math.max(1, width - 1)));
    });
  }
  const accent = detail?.provider === "claude" ? orange : blue;
  return wrapped.map((line, index) => `${index === 0 ? accent("•") : " "} ${line}`);
}

function allTranscriptLines(width) {
  const messages = detail?.messages ?? [];
  return messages.flatMap((message, index) => {
    const lines = messageLines(message, width);
    const nextMessage = messages[index + 1];
    return message.role === "user" && nextMessage && nextMessage.role !== "user"
      ? [...lines, ""]
      : lines;
  });
}

function noticeLines(width) {
  if (!notice) return [];
  return wrapCells(notice, Math.max(8, width - 3)).map((line) => yellow(line));
}

function detailFooter(width) {
  const activity = displayedStatus(detail) === "Working"
    ? `${blue("•")} ${statusText(workingLabel(detail))}`
    : null;
  return [
    ...slashMenuLines(width),
    ...noticeLines(width),
    ...(activity ? [activity] : []),
    ...inputPanel(width, { title: detail?.name }),
    statusLine(detail, width),
  ];
}

function transcriptCapacity(width) {
  const rows = outputStream.rows ?? 30;
  return Math.max(1, rows - 3 - detailFooter(width).length);
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

function renderDetail(width, height) {
  if (!detail) return [red("세션을 찾을 수 없습니다."), dim("←: 목록으로")];
  const transcript = allTranscriptLines(width);
  const footer = detailFooter(width);
  const capacity = Math.max(1, height - footer.length);
  const end = Math.max(0, transcript.length - detailScroll);
  const start = Math.max(0, end - capacity);
  const visible = transcript.slice(start, end);
  if ((start > 0 || detail.hasOlderMessages) && visible.length) {
    visible[0] = dim(`↑ ${start}${detail.hasOlderMessages ? "+" : ""} older lines · PgUp`);
  }
  if (end < transcript.length && visible.length) visible[visible.length - 1] = dim(`↓ ${transcript.length - end} newer lines · PgDn`);
  const padding = Array(Math.max(0, height - visible.length - footer.length)).fill("");
  return [...visible, ...padding, ...footer].slice(0, height);
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
  const height = outputStream.rows ?? 30;
  const lines = view === "overview" ? renderOverview(width) : renderDetail(width, height);
  const dialogLines = dialog && view !== "overview" ? renderDialog([]) : null;
  const renderedLines = dialogLines
    ? [...lines.slice(0, Math.max(0, height - dialogLines.length)), ...dialogLines]
    : renderDialog(lines);
  const frame = renderedLines.join("\n");
  const hasCursor = frame.includes(cursorAnchor);
  const content = hasCursor ? frame.replace(cursorAnchor, cursorSave).replaceAll(cursorAnchor, "") : frame;
  const cursorState = hasCursor ? `${cursorRestore}${cursorBlinkingBar}${cursorShow}` : cursorHide;
  const nextFrame = `${ESC}2J${ESC}H${content}${cursorState}`;
  if (nextFrame === lastFrame) return;
  lastFrame = nextFrame;
  outputStream.write(nextFrame);
  syncWorkingTimer();
}

function onResize() {
  if (closing) return;
  lastFrame = null;
  if (detail) {
    const lineCount = allTranscriptLines(outputStream.columns ?? 120).length;
    detailScroll = Math.min(detailScroll, Math.max(0, lineCount - 1));
  }
  render();
}

function syncWorkingTimer() {
  const shouldTick = view !== "overview" && detail && displayedStatus(detail) === "Working";
  if (shouldTick && !workingTimer) {
    workingTimer = setInterval(render, 1_000);
    workingTimer.unref?.();
  } else if (!shouldTick && workingTimer) {
    clearInterval(workingTimer);
    workingTimer = null;
  }
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
  const commandName = text.split(/\s+/, 1)[0];
  if (view !== "overview" && slashCommand(detail?.provider, commandName)) {
    input = "";
    inputHistory.reset();
    try {
      await runSlashCommand(text);
    } catch (error) {
      notice = `${error.code ?? "ERROR"}: ${error.message}`;
    }
    render();
    return;
  }
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

async function interruptCurrent() {
  if (!detail || displayedStatus(detail) !== "Working") {
    notice = "현재 중단할 작업이 없습니다";
    return;
  }
  notice = `${detail.provider === "claude" ? "Claude" : "Codex"} 작업 중단 요청 중`;
  render();
  try {
    await client.request("session/interrupt", { workspacePath: detail.cwd, threadId: detail.threadId });
    notice = "현재 작업을 중단했습니다. 세션과 대화 기록은 유지됩니다";
  } catch (error) {
    notice = `${error.code ?? "ERROR"}: ${error.message}`;
  }
}

async function runSlashCommand(text) {
  const [command, ...arguments_] = text.split(/\s+/);
  const argument = arguments_.join(" ").trim();
  if (["/status", "/statusline", "/usage", "/context", "/cost", "/stats"].includes(command)) {
    notice = statusLine(detail, Math.max(40, outputStream.columns ?? 120)).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").trim();
  } else if (command === "/interrupt" || command === "/stop") {
    await interruptCurrent();
  } else if (command === "/rename") {
    if (!argument) {
      notice = "사용법: /rename 새 세션 이름";
      return;
    }
    await client.request("session/rename", { workspacePath: detail.cwd, threadId: detail.threadId, name: argument });
    detail.name = argument;
    notice = `세션 이름을 '${argument}'(으)로 변경했습니다`;
  } else if (["/back", "/new", "/resume", "/clear"].includes(command)) {
    view = "overview";
    detail = null;
    notice = command === "/back" ? "" : "새 세션을 만들거나 기존 세션을 선택하세요";
  } else if (command === "/copy") {
    const last = [...(detail.messages ?? [])].reverse().find((message) => message.role === "agent")?.text;
    if (!last) {
      notice = "복사할 에이전트 답변이 없습니다";
      return;
    }
    outputStream.write(`\x1b]52;c;${Buffer.from(last).toString("base64")}\x07`);
    notice = "마지막 에이전트 답변을 클립보드로 복사했습니다";
  } else if (command === "/diff") {
    const { stdout } = await execFileAsync("git", ["diff", "--stat", "--", "."], {
      cwd: detail.cwd,
      encoding: "utf8",
      timeout: 5_000,
    });
    notice = stdout.trim() || "추적 중인 파일의 변경사항이 없습니다";
  } else if (command === "/exit" || command === "/quit") {
    cleanup();
  } else if (command === "/help") {
    const commands = slashCommandsFor(detail.provider);
    const runnable = commands.filter(({ support }) => support !== "attach").length;
    notice = `${detail.provider === "claude" ? "Claude Code" : "Codex"} 기본 명령 ${commands.length}개 · ● Waga 실행 가능 ${runnable}개 · ○ 원본 TUI에서 실행 · / 뒤에 검색어를 입력하세요`;
  } else {
    const selected = slashCommand(detail.provider, command);
    if (selected?.support === "attach") {
      notice = `${command}은(는) ${detail.provider === "claude" ? "Claude Code" : "Codex"}의 대화형 터미널 UI가 필요합니다. 해당 세션을 원본 CLI에서 attach/resume해 실행하세요`;
      return;
    }
    const result = await client.request("session/command", {
      workspacePath: detail.cwd,
      threadId: detail.threadId,
      command,
      argument,
    });
    notice = result.message ?? `${command} 명령을 실행했습니다`;
    if (result.session?.threadId) {
      view = result.session.threadId;
      detail = { ...result.session, messages: [] };
      await refreshDetail();
    }
  }
}

async function loadOlder() {
  if (!detail || loadingDetail) return;
  const width = outputStream.columns ?? 120;
  const capacity = transcriptCapacity(width);
  const lineCount = allTranscriptLines(width).length;
  if (detailScroll + capacity < lineCount) {
    detailScroll = Math.min(Math.max(0, lineCount - 1), detailScroll + capacity);
    render();
    return;
  }
  if (!detail.hasOlderMessages) return;
  loadingDetail = true;
  notice = "이전 기록 불러오는 중";
  render();
  try {
    const previousLength = allTranscriptLines(width).length;
    detail = await client.request("session/older", { workspacePath: detail.cwd, threadId: detail.threadId });
    detailScroll += Math.max(0, allTranscriptLines(width).length - previousLength);
    notice = detail.hasOlderMessages ? "PgUp으로 이전 기록을 한 페이지 더 불러올 수 있습니다" : "가장 오래된 대화까지 불러왔습니다";
  } catch (error) {
    notice = `${error.code ?? "ERROR"}: ${error.message}`;
  } finally {
    loadingDetail = false;
    render();
  }
}

function loadNewer() {
  const capacity = transcriptCapacity(outputStream.columns ?? 120);
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
  if (workingTimer) clearInterval(workingTimer);
  inputStream.off("keypress", onKeypress);
  outputStream.off?.("resize", onResize);
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
    const matches = slashMatches();
    if (key.name === "escape" && input) { input = ""; slashCursor = 0; render(); }
    else if (key.name === "escape" && displayedStatus(detail) === "Working") {
      void interruptCurrent().finally(render);
    }
    else if (key.name === "left" && !input) { view = "overview"; detail = null; render(); }
    else if (key.name === "pageup") void loadOlder();
    else if (key.name === "pagedown") loadNewer();
    else if (key.name === "up" && matches.length) { slashCursor = Math.max(0, slashCursor - 1); render(); }
    else if (key.name === "down" && matches.length) { slashCursor = Math.min(matches.length - 1, slashCursor + 1); render(); }
    else if (key.name === "tab" && matches.length) { input = matches[slashCursor].name; render(); }
    else if (key.name === "up") { input = inputHistory.previous(input); render(); }
    else if (key.name === "down") { input = inputHistory.next(input); render(); }
    else if (key.name === "return" && matches.length && !matches.some(({ name }) => name === input)) {
      input = matches[slashCursor].name;
      void submitInput();
    }
    else if (key.name === "return") void submitInput();
    else if (key.name === "backspace") { input = input.slice(0, -1); slashCursor = 0; render(); }
    else if (!key.ctrl && !key.meta && text) { input += text; slashCursor = 0; render(); }
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
outputStream.on?.("resize", onResize);

const onSigterm = () => cleanup(143);
if (listenForSignals) process.on("SIGTERM", onSigterm);
return new Promise((resolve) => { resolveRun = resolve; });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { exitCode } = await runSessionConsole();
  process.exitCode = exitCode;
}

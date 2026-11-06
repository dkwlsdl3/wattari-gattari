import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { stripVTControlCharacters } from "node:util";

import { CODEX_EXECUTION_MODES, codexExecutionLabel } from "./codex-execution.mjs";
import { fallbackRouting, routingSummary } from "./model-router.mjs";
import { nativeSessionCommand } from "./native-launcher.mjs";
import {
  codexExecutionModeForSettings,
  codexSettingsForExecutionMode,
  defaultProviderExecutionSettings,
  migrateLegacyProviderExecutionSettings,
  normalizeAllProviderExecutionSettings,
  providerExecutionRows,
  providerExecutionSections,
  providerExecutionSummary,
  updateProviderExecutionSetting,
} from "./provider-execution.mjs";
import { TmuxWorkspace } from "./tmux-workspace.mjs";
import { previewText, SessionPreview } from "./session-preview.mjs";
import { GlobalDock, DockNavigationStore } from "./global-dock.mjs";
import { remoteCommand } from "./global-hosts.mjs";
import { updateHosts, saveUpdatedHosts } from './host-update.mjs';
import { releaseInfo } from './release-install.mjs';

const ESC = "\x1b[";
const KOREAN_META_KEYS = new Map([
  ["ㅁ", "a"], ["ㅇ", "d"], ["ㅎ", "g"], ["ㅜ", "n"], ["ㅔ", "p"],
  ["ㅂ", "q"], ["ㄱ", "r"], ["ㄴ", "s"], ["ㅌ", "x"], ["ㅛ", "y"],
  ["ㅍ", "v"],
]);
const RESET = `${ESC}0m`;
const BRACKETED_PASTE_ON = `${ESC}?2004h`;
const BRACKETED_PASTE_OFF = `${ESC}?2004l`;
const ESCAPE_CODE_TIMEOUT_MS = 25;
const SESSION_REMOVAL_CONFIRMATIONS = 2;
const color = (code, text) => `${ESC}${code}m${text}${RESET}`;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const THEME = {
  title: "1;38;2;186;213;232",
  primary: "1;38;2;241;245;249",
  muted: "38;2;190;199;211",
  divider: "38;2;100;116;139",
  selected: "48;2;58;72;94",
  tabActive: "1;38;2;15;23;42;48;2;56;189;248",
  filterActive: "1;38;2;15;23;42;48;2;226;232;240",
  cursor: "1;38;2;226;232;240",
  // Claude's brand coral and the native Codex TUI's terminal-defined cyan.
  claude: "1;38;2;217;119;87",
  codex: "1;36",
  working: "1;32",
  idle: "1;34",
  needsInput: "1;31",
  error: "1;38;2;224;154;164",
  warning: "1;38;2;224;190;132",
  pc: "1;38;2;125;211;252",
  wsl: "1;38;2;94;234;212",
  vm: "1;38;2;196;181;253",
};

function safeText(value) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
}

function cellWidth(character) {
  const code = character.codePointAt(0);
  if (code >= 0x300 && code <= 0x36f) return 0;
  if (code >= 0x1100 && (code <= 0x115f || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0x1f300 && code <= 0x1faff))) return 2;
  return 1;
}

function graphemes(value) {
  return [...graphemeSegmenter.segment(String(value))].map(({ segment }) => segment);
}

function widthOf(value) {
  return [...String(value)].reduce((sum, character) => sum + cellWidth(character), 0);
}

function fit(value, width) {
  const clean = safeText(value);
  if (width <= 0) return "";
  if (widthOf(clean) <= width) return `${clean}${" ".repeat(width - widthOf(clean))}`;
  let result = "";
  let used = 0;
  for (const grapheme of graphemes(clean)) {
    const size = widthOf(grapheme);
    if (used + size > width - 1) break;
    result += grapheme;
    used += size;
  }
  return `${result}…${" ".repeat(Math.max(0, width - used - 1))}`;
}

function editorLine(value, cursor, width) {
  const cells = graphemes(value).map((cell) => cell === "\n" ? "↵" : cell === "\t" ? "⇥" : cell);
  const contentWidth = Math.max(1, width - 2);
  let start = 0;
  while (start < cursor && widthOf(cells.slice(start, cursor).join("")) >= contentWidth) start += 1;
  let end = start;
  let used = 0;
  while (end < cells.length) {
    const size = widthOf(cells[end]);
    if (used + size > contentWidth - 1) break;
    used += size;
    end += 1;
  }
  const before = cells.slice(start, cursor).join("");
  const atCursor = cells[cursor] ?? " ";
  const after = cells.slice(cursor + 1, end).join("");
  return `› ${before}${ESC}7m${atCursor}${RESET}${after}`;
}

function promptRows(value, cursor, width, maxRows = 5) {
  const cells = graphemes(value);
  const rows = [];
  let start = 0;
  for (let index = 0; index <= cells.length; index++) {
    if (index === cells.length || cells[index] === "\n") {
      rows.push({ start, end: index, text: cells.slice(start, index).join("") });
      start = index + 1;
    }
  }
  const current = Math.max(0, rows.findIndex(row => cursor >= row.start && cursor <= row.end));
  const offset = Math.max(0, current - maxRows + 1);
  return rows.slice(offset, offset + maxRows).map((row, index) => index + offset === current
    ? editorLine(row.text, cursor - row.start, width)
    : `  ${fit(row.text, Math.max(1, width - 2))}`);
}

function movePromptCursor(value, cursor, direction) {
  const cells = graphemes(value);
  let start = cursor;
  let end = cursor;
  while (start > 0 && cells[start - 1] !== "\n") start--;
  while (end < cells.length && cells[end] !== "\n") end++;
  if (direction === "home") return start;
  if (direction === "end") return end;
  const column = cursor - start;
  if (direction === "up") {
    if (start === 0) return cursor;
    let previous = start - 1;
    while (previous > 0 && cells[previous - 1] !== "\n") previous--;
    return previous + Math.min(column, start - 1 - previous);
  }
  return end === cells.length ? cursor : end + 1 + Math.min(column, cells.slice(end + 1).indexOf("\n") < 0 ? cells.length - end - 1 : cells.slice(end + 1).indexOf("\n"));
}

function creationModal(lines, task, width, height) {
  const inner = Math.max(1, Math.min(68, width - 6));
  const routing = task.routing;
  const details = routing && (routing.source === "local-llm-router" || routing.warnings?.length) ? [
    `실행 모델: ${routing.model ?? "provider 기본값"} · 추론: ${routing.effort ?? "기본값"}`,
    `작업 등급: ${routing.tier} · 확신도: ${routing.confidence}`,
    ...(routing.warnings ?? []).map(value => `경고: ${value}`),
    ...[...(routing.reasons ?? [])].sort((a, b) => Number(b.startsWith("LLM 판정기")) - Number(a.startsWith("LLM 판정기"))),
    ...(routing.issues ?? []).map(issue => `이슈 #${issue.iid}: ${issue.title} · 댓글 ${issue.commentCount}개`),
  ] : [];
  const header = [`새 세션 생성 중 · ${Math.max(0, Math.floor((Date.now() - (task.startedAt ?? Date.now())) / 1000))}초`, `${task.provider === "claude" ? "Claude" : "Codex"} · ${task.cwd}`];
  const progress = (task.progress?.length ? task.progress : ["생성 요청 준비 중"]).slice(-3);
  const explanation = task.judgeText ? [`판정 설명 (수신 중): ${task.judgeText}`] : [];
  const rows = [...progress, ...explanation, ...details].flatMap(text => wrapPreviewLines(safeText(text), inner));
  const available = Math.max(0, height - header.length - 4);
  const visible = rows.slice(0, available);
  if (rows.length > available && visible.length) visible[visible.length - 1] = "… 상세 일부 생략";
  const content = [...header, ...visible, "", "완료되면 목록으로 돌아갑니다."];
  const box = [`┌${"─".repeat(inner + 2)}┐`, ...content.map(text => `│ ${fit(text, inner)} │`), `└${"─".repeat(inner + 2)}┘`];
  const top = Math.max(0, Math.floor((height - box.length) / 2));
  const left = " ".repeat(Math.max(0, Math.floor((width - inner - 4) / 2)));
  while (lines.length < height) lines.push("");
  box.slice(0, height).forEach((line, index) => { lines[top + index] = `${left}${color(THEME.title, line)}`; });
  return lines;
}

function folderPickerModal(lines, picker, width, height) {
  const inner = Math.max(1, Math.min(68, width - 6));
  const visibleRows = Math.max(1, height - 7);
  const offset = Math.max(0, Math.min(picker.selected - Math.floor(visibleRows / 2), picker.entries.length - visibleRows));
  const entries = picker.entries.slice(offset, offset + visibleRows).map((entry, index) => {
    const label = entry.type === "select" ? "[현재 폴더 선택]" : entry.type === "parent" ? "../" : `${entry.name}/`;
    return `${offset + index === picker.selected ? "›" : " "} ${label}`;
  });
  const content = [
    `작업 폴더 · ${path.basename(picker.cwd) || picker.cwd}`,
    picker.cwd,
    picker.error ? `오류: ${picker.error}` : "↑↓ 이동  Enter 열기/선택  Backspace 상위",
    "e 경로 입력  Esc 취소",
    ...entries,
  ];
  const box = [`┌${"─".repeat(inner + 2)}┐`, ...content.map(value => `│ ${fit(value, inner)} │`), `└${"─".repeat(inner + 2)}┘`];
  const top = Math.max(0, Math.floor((height - box.length) / 2));
  const left = " ".repeat(Math.max(0, Math.floor((width - inner - 4) / 2)));
  while (lines.length < height) lines.push("");
  box.slice(0, height).forEach((line, index) => { lines[top + index] = `${left}${color(THEME.title, line)}`; });
}

function isFolderEntry(cwd, entry) {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try { return fs.statSync(path.join(cwd, entry.name)).isDirectory(); }
  catch { return false; }
}

function folderPicker(cwd) {
  const entries = [{ type: "select" }];
  if (path.dirname(cwd) !== cwd) entries.push({ type: "parent" });
  const directories = fs.readdirSync(cwd, { withFileTypes: true })
    .filter(entry => isFolderEntry(cwd, entry))
    .map(entry => ({ type: "directory", name: entry.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { cwd, entries: [...entries, ...directories], selected: 0, error: "" };
}

function cleanPastedPrompt(value) {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}

function cleanPastedSingleLine(value) {
  return cleanPastedPrompt(value).replace(/[\n\t]+/g, " ");
}

function sessionWorkspace(session) {
  return path.resolve(String(session.projectCwd || session.cwd || "/"));
}

export function reconcileOverviewOrder(orderByWorkspace, sessions, savedOrder = new Map()) {
  const reconciled = new Map([...orderByWorkspace].map(([workspace, ids]) => [workspace, [...ids]]));
  for (const [workspace, ids] of savedOrder) {
    reconciled.set(workspace, [...new Set([...ids, ...(reconciled.get(workspace) ?? [])])]);
  }
  for (const session of sessions) {
    const workspace = sessionWorkspace(session);
    if (!reconciled.has(workspace)) reconciled.set(workspace, []);
    const order = reconciled.get(workspace);
    if (!order.includes(session.id)) order.push(session.id);
  }
  return reconciled;
}

export function applyOverviewOrder(sessions, orderByWorkspace) {
  const grouped = new Map();
  for (const session of sessions) {
    const workspace = sessionWorkspace(session);
    if (!grouped.has(workspace)) grouped.set(workspace, []);
    grouped.get(workspace).push(session);
  }
  const workspaceOrder = [...orderByWorkspace.keys()].filter((workspace) => grouped.has(workspace));
  for (const workspace of grouped.keys()) if (!workspaceOrder.includes(workspace)) workspaceOrder.push(workspace);
  return workspaceOrder.flatMap((workspace) => {
    const rank = new Map((orderByWorkspace.get(workspace) ?? []).map((id, index) => [id, index]));
    return grouped.get(workspace).map((session, index) => ({ session, index })).sort((left, right) => {
      const leftRank = rank.get(left.session.id) ?? Number.MAX_SAFE_INTEGER;
      const rightRank = rank.get(right.session.id) ?? Number.MAX_SAFE_INTEGER;
      return leftRank - rightRank || left.index - right.index;
    }).map(({ session }) => session);
  });
}

export function reconcileDiscoveredSessions(previousSessions, discovered, missingCounts = new Map(), { removalConfirmations = SESSION_REMOVAL_CONFIRMATIONS } = {}) {
  const discoveredSessions = discovered.sessions ?? [];
  const seen = new Set(discoveredSessions.map((session) => session.id));
  const unavailableProviders = new Set((discovered.warnings ?? []).map((warning) => warning.provider));
  const availableProviders = Array.isArray(discovered.availableProviders) ? new Set(discovered.availableProviders) : null;
  const sessions = [...discoveredSessions];
  const nextMissingCounts = new Map();

  for (const session of previousSessions) {
    if (seen.has(session.id)) continue;
    const providerUnavailable = unavailableProviders.has(session.provider)
      || (availableProviders && !availableProviders.has(session.provider));
    if (providerUnavailable) {
      sessions.push(session);
      if (missingCounts.has(session.id)) nextMissingCounts.set(session.id, missingCounts.get(session.id));
      continue;
    }
    const misses = (missingCounts.get(session.id) ?? 0) + 1;
    if (misses < removalConfirmations) {
      nextMissingCounts.set(session.id, misses);
      sessions.push(session);
    }
  }

  return { sessions, missingCounts: nextMissingCounts };
}

export function moveOverviewSession(orderByWorkspace, workspace, sessionId, direction, visibleIds) {
  if (direction !== "up" && direction !== "down") throw new TypeError("Direction must be up or down");
  const visibleIndex = visibleIds.indexOf(sessionId);
  const targetVisibleIndex = direction === "up" ? visibleIndex - 1 : visibleIndex + 1;
  if (visibleIndex < 0 || targetVisibleIndex < 0 || targetVisibleIndex >= visibleIds.length) return null;
  const order = [...(orderByWorkspace.get(workspace) ?? [])];
  const targetId = visibleIds[targetVisibleIndex];
  const index = order.indexOf(sessionId);
  const targetIndex = order.indexOf(targetId);
  if (index < 0 || targetIndex < 0) return null;
  [order[index], order[targetIndex]] = [order[targetIndex], order[index]];
  const moved = new Map(orderByWorkspace);
  moved.set(workspace, order);
  return moved;
}

export function selectOverviewSessions(sessions, { query = "", provider = null, limit = Infinity } = {}) {
  const needle = query.trim().toLocaleLowerCase();
  return [...sessions]
    .filter((session) => !provider || session.provider === provider)
    .filter((session) => !needle || `${session.name} ${session.cwd} ${session.projectCwd ?? ""} ${session.id}`.toLocaleLowerCase().includes(needle))
    .slice(0, limit);
}

export function buildOverviewTree(sessions, { collapsed = new Set(), query = "" } = {}) {
  const workspaces = new Map();
  for (const session of sessions) {
    const cwd = String(session.projectCwd || session.cwd || "/");
    if (!workspaces.has(cwd)) workspaces.set(cwd, []);
    workspaces.get(cwd).push(session);
  }

  const nodes = [];
  for (const [cwd, workspaceSessions] of workspaces) {
    const workspaceKey = `workspace:${cwd}`;
    nodes.push({
      type: "workspace",
      key: workspaceKey,
      cwd,
      name: path.basename(cwd) || cwd,
      sessionCount: workspaceSessions.length,
    });
    if (collapsed.has(cwd) && !query) continue;
    for (const session of workspaceSessions) {
      nodes.push({ type: "session", key: session.id, workspaceKey, cwd, session });
    }
  }
  return nodes;
}

export function groupOverviewStatus(nodes) {
  const groups = [["needs-input", "입력 필요"], ["error", "오류"], ["working", "작업 중"],
    ["idle", "대기"], ["done", "완료"], ["unavailable", "확인 불가"]];
  const known = new Set(groups.map(([status]) => status));
  return groups.flatMap(([status, name]) => {
    const entries = nodes.filter(node => node.type === "session"
      && (known.has(node.session.status) ? node.session.status : "unavailable") === status);
    return entries.length ? [{ type: "status", key: `status:${status}`, status, name, sessionCount: entries.length }, ...entries] : [];
  });
}

function statusView(status) {
  if (status === "needs-input") return ["!", "needs input", THEME.needsInput];
  if (status === "working") return ["●", "working", THEME.working];
  if (status === "error") return ["!", "error", THEME.error];
  if (status === "idle") return ["○", "idle", THEME.idle];
  if (status === "done") return ["✓", "done", THEME.idle];
  return ["·", safeText(status || "unknown"), THEME.muted];
}

function counts(sessions) {
  const count = (status) => sessions.filter((session) => session.status === status).length;
  return `${count("needs-input")} need input   ${count("working")} working   ${count("idle")} idle   ${count("done")} done`;
}

function resetText(resetsAt) {
  if (!Number.isFinite(resetsAt)) return "";
  const date = new Date(resetsAt * 1_000);
  if (Number.isNaN(date.getTime())) return "";
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${date.getMonth() + 1}/${date.getDate()} ${hour}:${minute} 초기화`;
}

function resetLabel(resetsAt) {
  const text = resetText(resetsAt);
  return text ? ` · ${text}` : "";
}

function remaining(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function formatCodexUsage(usage) {
  if (!Number.isFinite(usage?.remainingPercent)) return null;
  const scope = usage.windowDurationMins === 7 * 24 * 60 ? "주간 " : "";
  return `Codex ${scope}${remaining(usage.remainingPercent)}% 남음${resetLabel(usage.resetsAt)}`;
}

export function formatClaudeUsage(usage) {
  const parts = [];
  for (const [label, window] of [["5시간", usage?.fiveHour], ["주간", usage?.weekly]]) {
    if (!Number.isFinite(window?.remainingPercent)) continue;
    const reset = resetText(window.resetsAt);
    parts.push(`${label} ${remaining(window.remainingPercent)}% 남음${reset ? ` (${reset})` : ""}`);
  }
  if (!parts.length) return null;
  return `Claude ${parts.join(" · ")}`;
}

function coloredUsageLine(segments, width) {
  let result = "";
  let used = 0;
  for (const segment of segments) {
    const separator = used ? "   " : "";
    const separatorWidth = widthOf(separator);
    if (used + separatorWidth >= width) break;
    result += separator;
    used += separatorWidth;
    const text = fit(segment.text, width - used).trimEnd();
    if (!text) break;
    result += color(segment.color, text);
    used += widthOf(text);
    if (text.endsWith("…")) break;
  }
  return `${result}${" ".repeat(Math.max(0, width - used))}`;
}

export function nativeReturnHint(mode) {
  return mode === "isolated"
    ? "네이티브 TUI: Alt+G → dock"
    : "네이티브 TUI: tmux prefix + 0 → dock";
}

function settingIndicator(row) {
  return row.kind === "radio" ? (row.selected ? "◉" : "○") : (row.selected ? "[x]" : "[ ]");
}

function settingsDisplayRows(provider, settings) {
  return providerExecutionSections(provider, settings).flatMap((section) => [
    { type: "heading", title: section.title },
    ...section.rows.map((row) => ({ type: "setting", ...row })),
  ]);
}

export function buildSettingsFrame({ settingsPanel, hostLabel = null, width = 100, height = 30, notice = "" }) {
  const usableWidth = Math.max(1, width - 4);
  const provider = settingsPanel?.provider === "codex" ? "codex" : "claude";
  const drafts = settingsPanel?.drafts ?? defaultProviderExecutionSettings();
  const settings = drafts[provider] ?? defaultProviderExecutionSettings()[provider];
  const displayRows = settingsDisplayRows(provider, settings);
  const selectableRows = displayRows.filter((row) => row.type === "setting");
  const selected = Math.max(0, Math.min(Number(settingsPanel?.selected ?? 0), Math.max(0, selectableRows.length - 1)));
  const selectedRow = selectableRows[selected];
  const selectedDisplayIndex = displayRows.findIndex((row) => row.type === "setting" && row.field === selectedRow?.field && row.key === selectedRow?.key && row.value === selectedRow?.value);
  const viewportHeight = Math.max(1, height - 9);
  const offset = Math.max(0, Math.min(selectedDisplayIndex < 0 ? 0 : selectedDisplayIndex - Math.floor(viewportHeight / 2), Math.max(0, displayRows.length - viewportHeight)));
  const lines = [];
  lines.push(`  ${color(THEME.title, fit(hostLabel ? `PC: ${hostLabel} · 실행 설정` : "WAGA · 실행 설정", usableWidth))}`);
  lines.push(`  ${color(THEME.muted, fit("새 세션 생성에 적용할 provider별 승인 권한과 실행 옵션을 선택합니다.", usableWidth))}`);
  const tabs = ["claude", "codex"].map((name) => name === provider
    ? color(name === "claude" ? THEME.claude : THEME.codex, `[ ${name.toUpperCase()} ]`)
    : color(THEME.muted, `  ${name.toUpperCase()}  `)).join("   ");
  lines.push(`  ${tabs}`);
  lines.push(`  ${color(THEME.divider, "─".repeat(Math.max(1, usableWidth)))}`);
  for (let index = offset; index < Math.min(displayRows.length, offset + viewportHeight); index += 1) {
    const row = displayRows[index];
    if (row.type === "heading") {
      lines.push(`  ${color(THEME.primary, fit(row.title, usableWidth))}`);
      continue;
    }
    const rowIndex = selectableRows.indexOf(row);
    const active = rowIndex === selected;
    const indicator = settingIndicator(row);
    const detail = row.description ? `  ${row.description}` : "";
    const text = `${indicator} ${row.label}${detail}`;
    const rowColor = row.disabled ? THEME.muted : row.danger && row.selected ? THEME.warning : THEME.primary;
    const rendered = `  ${color(rowColor, fit(text, usableWidth - 2))}`;
    lines.push(active ? `${ESC}${THEME.selected}m${rendered}${RESET}` : rendered);
  }
  while (lines.length < height - 4) lines.push("");
  const panelError = settingsPanel?.error ? `오류: ${settingsPanel.error}` : notice;
  lines.push(`  ${color(settingsPanel?.error ? THEME.error : THEME.muted, fit(panelError || "Space 선택  ↑↓ 이동  Tab provider 전환  Enter 저장  Esc 취소", usableWidth))}`);
  lines.push(`  ${color(THEME.muted, fit("Alt+S 닫기   라디오 그룹은 하나만 선택되고 체크박스는 여러 개 선택할 수 있습니다.", usableWidth))}`);
  return lines.slice(0, height).join("\n");
}

export function hasOverviewPreview(width, height) {
  return width >= 120 && height >= 20;
}

function wrapPreviewLines(text, width) {
  const result = [];
  const clean = previewText(text);
  for (const paragraph of clean.split("\n")) {
    let line = "";
    let used = 0;
    for (const grapheme of graphemes(paragraph)) {
      const size = widthOf(grapheme);
      if (used + size > width) {
        result.push(line); line = ""; used = 0;
      }
      line += grapheme; used += size;
    }
    result.push(line);
  }
  return result;
}

function wrapPreview(text, width, count) {
  const visibleCount = Math.max(0, count);
  if (!visibleCount) return [];
  const allLines = wrapPreviewLines(text, width);
  const result = allLines.slice(0, visibleCount);
  if (allLines.length > visibleCount) {
    result[visibleCount - 1] = `${fit(result[visibleCount - 1], width - 1)}…`;
  }
  return Array.from({ length: visibleCount }, (_, index) => fit(result[index] ?? "", width));
}

function previewWindow(text, width, count, offset = 0) {
  const visibleCount = Math.max(1, count);
  const allLines = wrapPreviewLines(text, width);
  const maxOffset = Math.max(0, allLines.length - visibleCount);
  const numericOffset = Number(offset);
  const safeOffset = Number.isFinite(numericOffset)
    ? Math.max(0, Math.min(Math.trunc(numericOffset), maxOffset))
    : 0;
  const result = allLines.slice(safeOffset, safeOffset + visibleCount);
  if (safeOffset > 0 && result.length) result[0] = fit(`↑ ${result[0]}`, width);
  if (safeOffset < maxOffset && result.length) result[result.length - 1] = `${fit(result[result.length - 1], width - 1)}…`;
  return {
    lines: Array.from({ length: visibleCount }, (_, index) => fit(result[index] ?? "", width)),
    offset: safeOffset,
    maxOffset,
    totalLines: allLines.length,
  };
}

export function buildGlobalDockFrame({ rows, selectedId, currentHost, query = "", searching = false, width = 100, height = 30, notice = "", connection = null }) {
  const usableWidth = Math.max(1, width - 4);
  const count = Math.max(1, Math.floor((height - (connection ? 13 : 10)) / 3));
  const selected = Math.max(0, rows.findIndex(row => row.id === selectedId));
  const start = Math.max(0, selected - count + 1);
  const labels = { local: "현재 PC", unknown: "미조회", available: "연결됨", partial: "일부 조회 실패", stale: "조회 실패 · 이전 자료", unavailable: "조회 실패", setup: '첫 연결 필요 · Enter', offline: 'Tailscale 연결 안 됨' };
  const types = { pc: { label: "PC", color: THEME.pc }, wsl: { label: "WSL", color: THEME.wsl }, vm: { label: "VM", color: THEME.vm } };
  const lines = [];
  const line = (text, style = THEME.muted) => lines.push(`  ${color(style, fit(text, usableWidth))}`);
  line("WAGA GLOBAL · PC 선택", THEME.pc);
  line(`현재 PC: ${currentHost}   ·   ${rows.length}대`);
  line("─".repeat(usableWidth), THEME.divider);
  for (const row of rows.slice(start, start + count)) {
    const active = row.id === selectedId;
    const type = types[row.type] ?? types.pc;
    const background = active ? `;${THEME.selected}` : "";
    const statusStyle = row.status === "available" ? THEME.working : row.status === "local" ? THEME.pc
      : row.status === "unavailable" ? THEME.error : ["partial", "stale", 'offline', 'setup'].includes(row.status) ? THEME.warning : THEME.muted;
    const marker = ["local", "available"].includes(row.status) ? "●" : ["partial", "stale", "unavailable", 'offline', 'setup'].includes(row.status) ? "!" : "○";
    const sessions = row.summary?.sessions;
    const projects = sessions ? new Set(sessions.map(s => s.projectCwd || s.cwd)).size : 0;
    const working = sessions?.filter(s => s.status === "working").length ?? 0;
    const summary = sessions ? `${projects}개 프로젝트 · ${row.status === "partial" ? "확인된 " : ""}${sessions.length}개 세션 · 작업 중 ${working}` : "세션 미확인";
    line(`${active ? "›" : " "} [${type.label}] ${row.name}${row.local ? "   [현재 PC]" : ""}`, `${active ? THEME.primary : type.color}${background}`);
    line(`    ${marker} ${labels[row.status]}${row.status === 'offline' && row.summary ? ' · 이전 자료' : ''}   ·   ${summary}`, `${statusStyle}${background}`);
    line("");
  }
  if (!rows.length) line("검색 결과가 없습니다.", THEME.warning);
  const row = rows[selected];
  if (row && height - lines.length >= (connection ? 10 : 7)) {
    const type = types[row.type] ?? types.pc;
    line(`${row.name} · ${type.label} · 등록 ID: ${row.id}`, type.color);
    if (row.update) line(`업데이트: ${{ updating: '설치 중', updated: '설치 완료 · 화면 확인 중', current: '이미 최신', failed: '실패' }[row.update.state]} ${row.update.revision.slice(0, 8)}${row.update.error ? ` · ${row.update.error}` : ''}`, row.update.state === 'failed' ? THEME.error : THEME.pc);
    if (row.release) {
      const installed = row.release.installedRevision;
      const pending = row.release.docks?.filter(dock => dock.revision !== installed).length ?? 0;
      line(`설치: ${installed?.slice(0, 8) || '개발/이전 설치'} · Dock: ${pending ? `${pending}개 적용 대기` : row.release.docks?.length ? '적용됨' : '다음 접속부터 적용'}`, pending ? THEME.warning : THEME.muted);
    }
    if (row.updatedAt) line(`마지막 확인 ${new Date(row.updatedAt).toLocaleTimeString()}`);
    if (row.error || row.summary?.warnings?.length) line(`! ${row.error || row.summary.warnings[0].message}`, THEME.warning);
    const projects = new Map();
    for (const session of row.summary?.sessions ?? []) {
      const folder = session.projectCwd || session.cwd;
      projects.set(folder, (projects.get(folder) ?? 0) + 1);
    }
    for (const [folder, total] of [...projects].slice(0, Math.max(0, height - lines.length - (connection ? 7 : 4)))) line(`  ${folder} · ${total}개 세션`);
  }
  line("─".repeat(usableWidth), THEME.divider);
  if (connection) {
    line(`${connection.name} · SSH 계정 (처음 한 번만 저장)`, THEME.primary);
    lines.push(`  ${editorLine(connection.value, connection.cursor, usableWidth)}`);
  }
  line(connection ? 'Enter 연결 · Esc 취소 · Ctrl+U 지우기' : "↑↓ 선택   Enter PC 열기   u 업데이트 · U 전체   / 검색   Esc 복귀   Alt+R 갱신", THEME.primary);
  line(searching || query ? `PC 검색: ${query}` : notice);
  return lines.slice(0, height).join("\n");
}

function previewLines(session, preview, width, height, outputOffset = 0) {
  const heading = session ? `${session.provider === "claude" ? "CLAUDE" : "CODEX"} · ${session.name}` : "세션 미리보기";
  const brand = session?.provider === "claude" ? THEME.claude : THEME.codex;
  const lines = [color(brand, fit(heading, width))];
  if (session?.hostId) return [...lines, '', ...wrapPreview(`${session.hostName}의 세션입니다. Enter로 연결해 대화를 확인합니다.`, width, height - 2)];
  if (!session || !preview || preview.state !== "ready") {
    const text = !session ? "세션을 선택하면 최근 대화가 표시됩니다."
      : preview?.state === "error" ? `미리보기를 읽지 못했습니다: ${preview.error || "조회 오류"}. 잠시 후 재시도합니다.` : "최근 대화를 읽는 중입니다…";
    return [...lines, "", ...wrapPreview(text, width, height - 2).map((line) => color(THEME.muted, line))];
  }
  const inputRows = Math.max(2, Math.floor((height - 6) * 0.4));
  const outputRows = Math.max(2, height - 6 - inputRows);
  lines.push(color(THEME.primary, "마지막 입력"));
  lines.push(...wrapPreview(preview.input || "최근 조회 범위에 입력이 없습니다.", width, inputRows));
  const output = previewWindow(preview.output || "최근 조회 범위에 응답이 없습니다.", width, outputRows, outputOffset);
  const outputHeading = output.maxOffset > 0
    ? `마지막 응답 (이전 작업 포함) · ${output.offset + 1}-${Math.min(output.offset + outputRows, output.totalLines)}/${output.totalLines}`
    : "마지막 응답 (이전 작업 포함)";
  lines.push("", color(THEME.primary, fit(outputHeading, width)));
  lines.push(...output.lines);
  const checked = new Date(preview.observedAt ?? preview.checkedAt).toLocaleTimeString();
  lines.push("", color(preview.error ? THEME.warning : THEME.muted,
    fit(preview.error ? `${preview.error} · 이전 조회 ${checked}` : `${preview.limited ? "최근 일부 · " : ""}조회 ${checked}`, width)));
  return lines;
}

export function buildOverviewFrame({ sessions, viewMode = "tree", hostLabel = null, pcTabs = null, collapsed = new Set(), query = "", nodes = viewMode === "status" ? groupOverviewStatus(buildOverviewTree(sessions)) : buildOverviewTree(sessions, { collapsed, query }), selected = 0, width = 100, height = 30, warnings = [], provider = null, providerUsage = {}, notice = "", newTask = null, renameTask = null, preview = null, previewOutputOffset = 0, nativeHint = nativeReturnHint(null), codexExecutionMode = CODEX_EXECUTION_MODES.DEFAULT, providerSettings = defaultProviderExecutionSettings(), settingsPanel = null }) {
  if (settingsPanel) return buildSettingsFrame({ settingsPanel, hostLabel, width, height, notice });
  const usableWidth = Math.max(1, width - 4);
  const split = hasOverviewPreview(width, height);
  const listWidth = split ? Math.floor(usableWidth * 0.6) : usableWidth;
  const usageLabels = [
    { text: formatClaudeUsage(providerUsage.claude), color: THEME.claude },
    { text: formatCodexUsage(providerUsage.codex), color: THEME.codex },
  ].filter(({ text }) => text);
  const editorHeight = newTask ? Math.min(5, String(newTask.prompt).split("\n").length) : 1;
  const safeSelected = Math.max(0, Math.min(selected, Math.max(0, nodes.length - 1)));
  const selectedSession = nodes[safeSelected]?.session;
  const context = (node, fullPath = false) => {
    const cwd = node?.cwd ?? sessionWorkspace(node?.session ?? {});
    return `${node?.host?.name ?? node?.session?.hostName ?? hostLabel ?? "현재 PC"} / ${fullPath ? cwd : path.basename(cwd) || cwd}`;
  };
  const identityLines = !newTask && !renameTask && selectedSession
    ? [...(viewMode === "status" && listWidth < 64 ? [fit(context(nodes[safeSelected], true), usableWidth)] : []), ...wrapPreviewLines(safeText(selectedSession.id), usableWidth)] : [];
  const visibleRows = Math.max(1, height - (usageLabels.length ? 10 : 9) - (pcTabs ? 1 : 0) - identityLines.length - (newTask ? editorHeight + 3 : 0));
  const offset = Math.max(0, Math.min(safeSelected - Math.floor(visibleRows / 2), Math.max(0, nodes.length - visibleRows)));
  const wide = listWidth >= 64;
  const contextWidth = viewMode === "status" && wide ? Math.min(32, Math.floor(listWidth * 0.32)) : 0;
  const nameWidth = viewMode === "status" ? Math.max(1, listWidth - 14 - (contextWidth ? contextWidth + 3 : 0))
    : wide ? Math.max(12, listWidth - 31) : Math.max(1, listWidth - 22);
  const lines = [];
  const title = wide ? "WATTARI GATTARI  Claude + Codex session dock" : "WAGA · session dock";
  const viewTabs = usableWidth < 32
    ? color(THEME.tabActive, fit(`${viewMode === "tree" ? "[폴더 트리]" : "[상태별]"} Alt+V`, usableWidth))
    : `${color(viewMode === "tree" ? THEME.tabActive : THEME.muted, viewMode === "tree" ? " [폴더 트리] " : " 폴더 트리 ")} ${color(viewMode === "status" ? THEME.tabActive : THEME.muted, viewMode === "status" ? " [상태별] " : " 상태별 ")} ${color(THEME.muted, "Alt+V")}`;
  const titleWidth = Math.max(0, usableWidth - widthOf(stripVTControlCharacters(viewTabs)) - 2);
  lines.push(`  ${color(THEME.title, fit(hostLabel ? `PC: ${hostLabel} · ${title}` : title, titleWidth))}${titleWidth ? "  " : ""}${viewTabs}`);
  if (pcTabs) {
    const labels = pcTabs.items.map(host => ({ id: host.id, text: host.id === pcTabs.selectedId ? `[${safeText(host.name)}]` : safeText(host.name) }));
    const current = labels.findIndex(host => host.id === pcTabs.selectedId);
    let start = 0;
    while (start < current && labels.slice(start, current + 1).reduce((total, host) => total + widthOf(host.text) + 3, 0) > usableWidth - 2) start++;
    let remaining = usableWidth - (start ? 2 : 0);
    let tabs = start ? color(THEME.muted, '… ') : '';
    for (const host of labels.slice(start)) {
      if (remaining < 3) break;
      const size = Math.min(widthOf(host.text) + 2, remaining);
      tabs += color(host.id === pcTabs.selectedId ? THEME.tabActive : THEME.muted, ` ${fit(host.text, size - 2)} `);
      remaining -= size + 1;
      tabs += ' ';
    }
    lines.push(`  ${tabs}`);
  }
  const executionStatusColor = codexExecutionMode === CODEX_EXECUTION_MODES.YOLO ? THEME.warning : THEME.muted;
  const filterLabel = ` 제공자: ${provider?.toUpperCase() ?? '전체'} `;
  const statusCounts = fit(counts(sessions), Math.min(widthOf(counts(sessions)), Math.max(0, usableWidth - widthOf(filterLabel) - 2)));
  const executionWidth = Math.max(0, usableWidth - widthOf(statusCounts) - widthOf(filterLabel) - 2);
  lines.push(`  ${color(THEME.muted, statusCounts)} ${color(THEME.filterActive, filterLabel)} ${color(executionStatusColor, fit(`${codexExecutionLabel(codexExecutionMode)}   Alt+S 설정   Alt+Y 빠른 전환`, executionWidth))}`);
  if (usageLabels.length) lines.push(`  ${coloredUsageLine(usageLabels, usableWidth)}`);
  lines.push(`  ${color(THEME.divider, "─".repeat(Math.max(1, usableWidth)))}`);
  const bodyStart = lines.length;

  if (!sessions.length) lines.push(color(THEME.muted, fit(query ? "검색 결과가 없습니다." : "발견된 세션이 없습니다. Alt+R을 눌러 새로고침하세요.", listWidth)));
  for (let index = offset; index < Math.min(nodes.length, offset + visibleRows); index += 1) {
    const node = nodes[index];
    const active = index === safeSelected;
    const marker = active ? color(THEME.cursor, "›") : " ";
    if (node.type === "status") {
      const [symbol, , ink] = statusView(node.status);
      const label = `${active ? "›" : " "} ━━ ${symbol} ${node.name} · ${node.sessionCount} `;
      const title = fit(label, Math.min(widthOf(label), listWidth));
      lines.push(color(`${active ? THEME.selected : '48;2;30;41;59'};${ink}`, `${title}${"─".repeat(Math.max(0, listWidth - widthOf(title)))}`));
      continue;
    }
    if (node.type === 'host') {
      const label = `${active ? '›' : ' '} ━━ ${safeText(node.name)} `;
      const title = fit(label, Math.min(widthOf(label), listWidth));
      const rule = '─'.repeat(Math.max(0, listWidth - widthOf(title)));
      const ink = THEME[node.host?.type] ?? THEME.pc;
      lines.push(color(`${active ? THEME.selected : '48;2;30;41;59'};${ink}`, `${title}${rule}`));
      continue;
    }
    if (node.type === "hosts") {
      const row = `${marker} ${color(THEME.primary, fit(node.name, listWidth - 2))}`;
      lines.push(active ? `${ESC}${THEME.selected}m${row}${RESET}` : row);
      continue;
    }
    if (node.type === "workspace") {
      const toggle = collapsed.has(node.collapseKey ?? node.cwd) && !query ? "▸" : "▾";
      const detail = wide ? `  ${node.cwd}  ·  ${node.sessionCount} session${node.sessionCount === 1 ? "" : "s"}` : `  ${node.sessionCount}`;
      const row = `${marker} ${color(THEME.muted, toggle)} ${color(THEME.primary, fit(`${node.name}${detail}`, listWidth - 4))}`;
      lines.push(active ? `${ESC}${THEME.selected}m${row}${RESET}` : row);
      continue;
    }
    const session = node.session;
    const [symbol, status, statusColor] = statusView(session.status);
    const providerName = session.provider === "claude" ? "CLAUDE" : "CODEX ";
    const providerColor = session.provider === "claude" ? THEME.claude : THEME.codex;
    const displayName = session.provider === "claude" && session.kind
      ? `${session.kind === "interactive" ? "CLI" : "BG"} · ${session.name}` : session.name;
    const nativeId = safeText(session.id).replace(`${session.provider}:`, "");
    let prefixLength = Math.min(8, nativeId.length);
    // Only visible rows need labels; compare canonical IDs within their provider.
    for (const other of nameWidth >= prefixLength + 15 ? sessions : []) {
      if (other.provider !== session.provider || other.id === session.id) continue;
      const otherId = safeText(other.id).replace(`${other.provider}:`, "");
      let common = 0;
      while (common < nativeId.length && common < otherId.length && nativeId[common] === otherId[common]) common++;
      prefixLength = Math.max(prefixLength, Math.min(nativeId.length, common + 1));
    }
    const label = `[${nativeId.slice(0, viewMode === "status" ? Math.min(prefixLength, Math.max(1, nameWidth - 3)) : prefixLength)}] `;
    const labelWidth = widthOf(label);
    const showLabel = viewMode === "status" || nameWidth - labelWidth >= 12;
    const idCell = showLabel ? color(THEME.muted, label) : "";
    const nameCell = fit(displayName, nameWidth - (showLabel ? labelWidth : 0));
    const rowStart = `${marker}   ${color(statusColor, symbol)} ${idCell}${color(providerColor, providerName)}${wide || viewMode === "status" ? "  " : " "}${nameCell}`;
    const row = viewMode === "status"
      ? `${rowStart}${contextWidth ? ` │ ${color(THEME.muted, fit(context(node), contextWidth))}` : ""}`
      : `${rowStart}${wide ? "  " : " "}${color(statusColor, fit(status, wide ? 11 : 8))}`;
    lines.push(active ? `${ESC}${THEME.selected}m${row}${RESET}` : row);
  }
  if (split) {
    const rightWidth = usableWidth - listWidth - 3;
    const right = previewLines(nodes[safeSelected]?.session, preview, rightWidth, visibleRows, previewOutputOffset);
    const left = lines.splice(bodyStart);
    for (let row = 0; row < visibleRows; row++) {
      const content = left[row] ?? "";
      const padding = " ".repeat(Math.max(0, listWidth - widthOf(stripVTControlCharacters(content))));
      lines.push(`  ${content}${padding}${color(THEME.divider, " │ ")}${right[row] ?? ""}`);
    }
  }
  const helpLines = wide
    // Alt+S stays visible in the status header, so the action line spends its
    // width on Alt+D next to Alt+N instead.
    ? ["Tab PC  Shift+Tab 제공자  Alt+P 연결  Enter 열기  F4 재접속  Shift+↑↓ 순서", "F2 이름 변경  Alt+N 새 세션  Alt+D 기본값  Alt+Y Codex 실행  Alt+R 갱신  Alt+X 보관  Alt+Q 나가기  PgUp/PgDn 응답"]
    : ["↑↓ 이동  Enter 열기  F4 재접속  Alt+Q 종료", "Tab PC  Shift+Tab 필터  Alt+P 연결", "Alt+D 기본값  Alt+S 설정  Alt+Y 실행  Alt+R 갱신  Alt+X 보관"];
  while (lines.length < height - helpLines.length - (newTask || renameTask ? 4 : 3 + identityLines.length) - (newTask ? editorHeight + 1 : 0)) lines.push("");
  if (newTask) {
    const providerName = newTask.provider === "claude" ? "CLAUDE" : "CODEX";
    const providerSymbol = newTask.provider === "claude" ? "◆" : "■";
    const providerColor = newTask.provider === "claude" ? THEME.claude : THEME.codex;
    const alternateProvider = newTask.provider === "claude" ? "CODEX" : "CLAUDE";
    const headingPrefix = "새 세션 생성   ";
    const providerBadge = `${providerSymbol}  ${providerName}  ${providerSymbol}`;
    const headingSuffix = `${newTask.cwd}${newTask.submitting ? " · 생성 중" : ""}`;
    const suffixWidth = Math.max(0, usableWidth - widthOf(headingPrefix) - widthOf(providerBadge) - 3);
    const heading = `${color(THEME.title, headingPrefix)}${color(providerColor, providerBadge)}${suffixWidth ? `   ${color(THEME.muted, fit(headingSuffix, suffixWidth))}` : ""}`;
    lines.push(`  ${heading}`);
    lines.push(`  ${color(newTask.routing?.tier === "promoted" ? THEME.warning : providerColor, fit(routingSummary(newTask.routing), usableWidth))}`);
    const executionSummary = providerSettings?.[newTask.provider]
      ? providerExecutionSummary(newTask.provider, providerSettings[newTask.provider])
      : newTask.provider === "codex" ? codexExecutionLabel(codexExecutionMode) : "Claude 실행 설정";
    const composerError = newTask.cwdEdit ? newTask.cwdEdit.error : newTask.error;
    const composerHint = composerError
      ? `오류: ${safeText(composerError)}`
      : newTask.cwdEdit
        ? "작업 폴더 경로 · Enter 적용 · Esc 취소 · Ctrl+U 지우기"
        : `Shift+Enter 개행 · Enter 생성 · Esc 취소   Tab → ${alternateProvider} 전환   Alt+P 폴더   Alt+D ${newTask.skipRouting ? "라우팅 사용" : "라우팅 생략"}   Alt+S 설정   ${executionSummary}`;
    lines.push(`  ${color(composerError ? THEME.error : providerColor, fit(composerHint, usableWidth))}`);
    if (newTask.cwdEdit) lines.push(`  ${editorLine(newTask.cwdEdit.value, newTask.cwdEdit.cursor, usableWidth)}`);
    else lines.push(...promptRows(newTask.prompt, newTask.cursor, usableWidth).map(row => `  ${row}`));
    lines.push("");
  } else if (renameTask) {
    const providerName = renameTask.session.provider === "claude" ? "CLAUDE" : "CODEX";
    const providerSymbol = renameTask.session.provider === "claude" ? "◆" : "■";
    const providerColor = renameTask.session.provider === "claude" ? THEME.claude : THEME.codex;
    lines.push(`  ${color(THEME.title, "세션 이름 변경   ")}${color(providerColor, `${providerSymbol}  ${providerName}  ${providerSymbol}`)}`);
    const renameHint = renameTask.error
      ? `오류: ${safeText(renameTask.error)}`
      : `현재: ${safeText(renameTask.session.name)}   Enter 저장   Esc 취소   Ctrl+U 지우기`;
    lines.push(`  ${color(renameTask.error ? THEME.error : THEME.muted, fit(renameHint, usableWidth))}`);
    lines.push(`  ${editorLine(renameTask.name, renameTask.cursor, usableWidth)}`);
    lines.push("");
  } else {
    for (const identity of identityLines) lines.push(`  ${color(THEME.muted, identity)}`);
    if (warnings.length) lines.push(`  ${color(THEME.warning, fit(`경고: ${safeText(warnings[0].provider)} · ${safeText(warnings[0].message)}`, usableWidth))}`);
    else lines.push(`  ${color(THEME.muted, fit(notice || "세션 상태는 자동으로 새로고침됩니다.", usableWidth))}`);
    for (const help of helpLines) lines.push(`  ${color(THEME.muted, fit(help, usableWidth))}`);
    lines.push(`  ${color(THEME.muted, fit(nativeHint, usableWidth))}`);
    if (query) lines.push(`  ${color(THEME.cursor, fit(`검색: ${query}`, usableWidth))}`);
    else lines.push("");
  }
  if (newTask?.submitting) creationModal(lines, newTask, width, height);
  else if (newTask?.cwdPicker) folderPickerModal(lines, newTask.cwdPicker, width, height);
  return lines.slice(0, height).join("\n");
}

export async function runOverview({
  filterCwd = null,
  defaultCwd = process.cwd(),
  bridge,
  workspace = new TmuxWorkspace(),
  commandFor = nativeSessionCommand,
  inputStream = process.stdin,
  outputStream = process.stdout,
  errorOutput = process.stderr,
  orderStore = null,
  settingsStore = null,
  hosts = null,
  hostsPath = null,
  globalDock = hosts ? new GlobalDock(hosts) : null,
  hostUpdater = updateHosts,
  readRelease = releaseInfo,
  remoteHost = process.env.WAGA_REMOTE_HOST || null,
  initialSessionId = process.env.WAGA_OPEN_SESSION || null,
  initialSessionForce = process.env.WAGA_OPEN_FORCE === '1',
  initialCreate = process.env.WAGA_CREATE_SESSION ? {
    provider: process.env.WAGA_CREATE_PROVIDER || 'claude', cwd: process.env.WAGA_CREATE_CWD || defaultCwd,
    skipRouting: process.env.WAGA_CREATE_SESSION === 'defaults',
  } : null,
  navigationStore = process.env.WAGA_REMOTE_HOST_ID ? new DockNavigationStore(process.env.WAGA_REMOTE_HOST_ID) : null,
  refreshMs = 3_000,
  previewDebounceMs = 150,
  previewCacheMs = 5_000,
  listenForSignals = true,
  nativeHint = nativeReturnHint(process.env.WAGA_TMUX_MODE),
} = {}) {
  if (!inputStream.isTTY || !outputStream.isTTY) {
    errorOutput.write("Interactive overview requires a TTY; use `waga list` for text output\n");
    return 2;
  }

  let allSessions = [];
  let localObserved = false;
  let globalVisible = false;
  const integrated = Boolean(globalDock && !remoteHost);
  let pcFilter = null;
  let viewMode = 'tree';
  const pcSelections = new Map();
  let globalQuery = "";
  let globalSearching = false;
  let updating = false, reloading = false;
  const runningRelease = readRelease();
  const hostRow = globalDock || remoteHost ? [{ type: "hosts", key: "global:hosts", name: remoteHost ? "← 전체 PC 통합 Dock · Tab / Alt+G" : integrated ? "PC 연결 설정" : "↑ PC 목록으로" }] : [];
  const sessionKey = session => session.hostId ? `remote:${session.hostId}:${session.id}` : session.id;
  const tree = sessions => {
    if (!integrated) {
      const entries = buildOverviewTree(sessions, { collapsed: viewMode === 'status' ? new Set() : collapsed, query });
      return viewMode === 'status' ? groupOverviewStatus(entries) : [...hostRow, ...entries];
    }
    const nodes = [...hostRow];
    for (const host of connectedHosts()) {
      if (pcFilter && host.id !== pcFilter) continue;
      const entries = sessions.filter(session => host.local ? !session.hostId : session.hostId === host.id);
      const status = host.status === 'partial' ? '일부 조회 실패' : '';
      const badge = { pc: 'PC', wsl: 'WSL', vm: 'VM' }[host.type] ?? 'PC';
      nodes.push({ type: 'host', key: `host:${host.id}`, host, name: `[${badge}] ${host.name}${host.local ? ' · 현재 PC' : ''}${status ? ` · ${status}` : ''}` });
      const projects = buildOverviewTree(entries, { query });
      for (const node of projects) {
        const collapseKey = host.local ? node.cwd : `remote:${host.id}:${node.cwd}`;
        if (viewMode !== 'status' && node.type === 'session' && collapsed.has(collapseKey) && !query) continue;
        nodes.push({ ...node, host, collapseKey,
          key: node.type === 'session' ? sessionKey(node.session) : host.local ? node.key : `remote:${host.id}:${node.key}`,
          ...(node.workspaceKey ? { workspaceKey: host.local ? node.workspaceKey : `remote:${host.id}:${node.workspaceKey}` } : {}) });
      }
    }
    return viewMode === 'status' ? groupOverviewStatus(nodes) : nodes;
  };
  let warnings = [];
  let missingSessionCounts = new Map();
  let providerUsage = {};
  let orderWarning = null;
  let orderReadWarning = null;
  let orderByWorkspace = new Map();
  const readSavedOrder = () => {
    if (!orderStore) return;
    try {
      orderByWorkspace = reconcileOverviewOrder(orderByWorkspace, [], orderStore.load());
      orderReadWarning = null;
    } catch (error) { orderReadWarning = { provider: "waga", message: error.message }; }
  };
  readSavedOrder();
  let providerSettings = defaultProviderExecutionSettings();
  let codexExecutionMode = CODEX_EXECUTION_MODES.DEFAULT;
  let settingsWarning = null;
  if (settingsStore) {
    try {
      const loaded = settingsStore.load();
      providerSettings = loaded?.providers
        ? normalizeAllProviderExecutionSettings(loaded.providers)
        : migrateLegacyProviderExecutionSettings(loaded?.codexExecutionMode ?? loaded);
      codexExecutionMode = codexExecutionModeForSettings(providerSettings.codex);
    } catch (error) {
      settingsWarning = { provider: "waga", message: `실행 설정을 읽지 못했습니다: ${error.message}` };
    }
  }
  let selected = 0;
  let selectedKey = null;
  const collapsed = new Set();
  let query = "";
  let searching = false;
  let newTask = initialCreate ? { ...initialCreate, prompt: '', cursor: 0, error: '', submitting: false, routing: null } : null;
  let renameTask = null;
  let hostConnection = null;
  let pasteBuffer = null;
  let provider = null;
  const refreshStates = new Map((bridge.providerNames?.() ?? [undefined]).map(name =>
    [name, { refreshing: false, queued: false, generation: 0, warnings: [] }]));
  let notice = "세션을 불러오는 중입니다.";
  let closed = false;
  let busy = false;
  let nativeOpen = false;
  let settingsPanel = null;
  let pendingArchiveId = null;
  let pendingCreated = null;
  let previewOutputOffset = 0;
  let previewOutputSessionKey = null;
  let lastContentKey = null;
  let lastContentOffset = 0;
  let restoringSelection = null;
  let restoredOffset = 0;
  if (navigationStore) {
    try {
      const saved = navigationStore.load();
      if (saved) {
        for (const folder of saved.collapsed) collapsed.add(folder);
        query = saved.query; provider = saved.provider;
        restoringSelection = saved.selectedKey; restoredOffset = saved.previewOutputOffset; lastContentOffset = saved.previewOutputOffset;
      }
    } catch (error) { notice = `이전 탐색 위치를 읽지 못했습니다: ${error.message}`; }
  }
  const saveNavigation = () => {
    if (!navigationStore) return;
    try { navigationStore.save({ selectedKey: lastContentKey, collapsed: [...collapsed].filter(folder => path.isAbsolute(folder)), query, provider, previewOutputOffset: lastContentOffset }); }
    catch (error) { errorOutput.write(`Dock 탐색 위치 저장 실패: ${error.message}\n`); }
  };
  const reloadIfReady = async () => {
    if (!runningRelease.root || !workspace.reloadOverview || reloading || closed || busy || nativeOpen || newTask || renameTask || settingsPanel || searching || globalSearching || updating) return;
    try {
      if (workspace.shouldRefreshOverview && !await workspace.shouldRefreshOverview()) return;
      if (closed || busy || nativeOpen || newTask || renameTask || settingsPanel || searching || globalSearching || updating) return;
      const installed = readRelease();
      if (!installed.installedRevision || installed.installedRevision === runningRelease.runningRevision) return;
      reloading = true;
      saveNavigation();
      const result = await workspace.reloadOverview(installed, { hostsPath, filterCwd });
      if (result?.deferred) reloading = false;
    } catch (error) { notice = `새 버전 화면 적용 실패: ${error.message}`; reloading = false; render(); }
  };
  const archivedSessionIds = new Set();
  const previewReader = new SessionPreview({
    read: (session, options) => bridge.preview(session, options),
    visible: async () => !closed && !busy && !nativeOpen && (!workspace.shouldRefreshOverview || await workspace.shouldRefreshOverview()),
    changed: () => render(),
    debounceMs: previewDebounceMs,
    cacheMs: previewCacheMs,
  });

  const connectedHosts = () => globalDock.rows(allSessions, warnings, localObserved).filter(host => host.local || ['available', 'partial'].includes(host.status));
  const visibleSessions = () => {
    if (!integrated) return selectOverviewSessions(allSessions, { query, provider });
    const sessions = connectedHosts()
      .filter(host => !pcFilter || host.id === pcFilter)
      .flatMap(host => (host.summary?.sessions ?? []).map(session => host.local ? session : { ...session, hostId: host.id, hostName: host.name }));
    return selectOverviewSessions(sessions, { query, provider });
  };
  const visibleHosts = () => globalDock.rows(allSessions, warnings, localObserved).filter(row => `${row.name} ${row.id}`.toLowerCase().includes(globalQuery.toLowerCase()));
  const refreshHosts = async ({ force = false } = {}) => {
    if (closed || busy || nativeOpen || (!globalVisible && !integrated)) return;
    try {
      if (workspace.shouldRefreshOverview && !await workspace.shouldRefreshOverview()) return;
      if (!closed && (globalVisible || integrated)) await globalDock.refresh(render, { force });
    } catch (error) { notice = `PC 목록 조회 실패: ${error.message}`; render(); }
  };
  const visibleNodes = () => tree(visibleSessions());
  const returnToLocal = () => {
    globalVisible = false;
    selectedKey = lastContentKey;
    restoredOffset = lastContentOffset;
    const nodes = visibleNodes();
    if (selectedKey && !nodes.some(node => node.key === selectedKey)) {
      const session = allSessions.find(session => session.id === selectedKey);
      selectedKey = nodes.find(node => node.type === "workspace" && node.cwd === sessionWorkspace(session ?? {}))?.key ?? null;
    }
  };
  const reconcileSelection = (nodes) => {
    if (restoringSelection && nodes.some(node => node.key === restoringSelection)) {
      selectedKey = restoringSelection;
      restoringSelection = null;
    }
    const keyedIndex = selectedKey === null ? -1 : nodes.findIndex((node) => node.key === selectedKey);
    selected = keyedIndex >= 0 ? keyedIndex : Math.max(0, Math.min(selected, Math.max(0, nodes.length - 1)));
    selectedKey = nodes[selected]?.key ?? null;
    if (nodes[selected]?.type === "session") lastContentKey = selectedKey;
  };
  const selectFirstSession = () => {
    const nodes = visibleNodes();
    const sessionIndex = nodes.findIndex((node) => node.type === "session");
    selected = sessionIndex >= 0 ? sessionIndex : Math.max(0, nodes.findIndex(node => node.type === 'host'));
    selectedKey = nodes[selected]?.key ?? null;
  };
  const render = () => {
    if (closed || nativeOpen) return;
    if (integrated && pcFilter && !connectedHosts().some(host => host.id === pcFilter)) {
      pcFilter = null; selectedKey = null;
    }
    if (globalVisible) {
      previewReader.select(null);
      const rows = visibleHosts();
      if (!rows.some(row => row.id === globalDock.selectedId) && rows.length) globalDock.selectedId = rows[0].id;
      outputStream.write(`${ESC}H${ESC}J${buildGlobalDockFrame({ rows, selectedId: globalDock.selectedId, currentHost: globalDock.config.local.name,
        query: globalQuery, searching: globalSearching, width: outputStream.columns || 100, height: outputStream.rows || 30, notice: notice || globalDock.discoveryError, connection: hostConnection })}`);
      return;
    }
    const sessions = visibleSessions();
    const nodes = tree(sessions);
    reconcileSelection(nodes);
    const previewSession = hasOverviewPreview(outputStream.columns || 100, outputStream.rows || 30) && !busy && !newTask && !renameTask
      ? nodes[selected]?.session : null;
    const nextPreviewSessionKey = previewSession ? `${previewSession.hostId ?? ''}\u0000${previewSession.id}\u0000${previewSession.cwd}` : null;
    if (nextPreviewSessionKey !== previewOutputSessionKey) {
      if (previewOutputSessionKey && !nextPreviewSessionKey) lastContentOffset = previewOutputOffset;
      previewOutputSessionKey = nextPreviewSessionKey;
      previewOutputOffset = restoredOffset;
      restoredOffset = 0;
      if (nextPreviewSessionKey) lastContentOffset = previewOutputOffset;
    }
    previewReader.select(typeof bridge.preview === "function" && !previewSession?.hostId ? previewSession : null);
    outputStream.write(`${ESC}H${ESC}J${buildOverviewFrame({
      sessions,
      viewMode,
      hostLabel: integrated ? pcFilter ? globalDock.rows().find(host => host.id === pcFilter)?.name : '전체 PC 통합 Dock' : remoteHost ? `${remoteHost} · 원격 관리` : hosts?.local.name,
      pcTabs: integrated ? { items: [{ id: null, name: '전체 PC' }, ...connectedHosts()], selectedId: pcFilter }
        : remoteHost ? { items: [{ id: null, name: '전체 PC' }, { id: remoteHost, name: remoteHost }], selectedId: remoteHost } : null,
      nodes,
      collapsed,
      selected,
      width: outputStream.columns || 100,
      height: outputStream.rows || 30,
      query,
      warnings: [
        ...(settingsWarning ? [settingsWarning] : []),
        ...(orderWarning ? [orderWarning] : []),
        ...(orderReadWarning ? [orderReadWarning] : []),
        ...warnings,
      ],
      provider,
      providerUsage: integrated && pcFilter && pcFilter !== globalDock.config.local.id ? {} : providerUsage,
      notice,
      newTask,
      renameTask,
      nativeHint,
      codexExecutionMode,
      providerSettings,
      settingsPanel,
      preview: previewReader.snapshot(previewSession),
      previewOutputOffset,
    })}`);
  };

  const scrollPreview = (direction) => {
    const width = outputStream.columns || 100;
    const height = outputStream.rows || 30;
    if (!hasOverviewPreview(width, height) || busy || nativeOpen || newTask || renameTask || searching) return false;
    const sessions = visibleSessions();
    const nodes = tree(sessions);
    reconcileSelection(nodes);
    const session = nodes[selected]?.session;
    const preview = previewReader.snapshot(session);
    if (!session || !preview || preview.state !== "ready") return false;
    const usableWidth = Math.max(1, width - 4);
    const listWidth = Math.floor(usableWidth * 0.6);
    const rightWidth = usableWidth - listWidth - 3;
    const usageLabels = [formatClaudeUsage(providerUsage.claude), formatCodexUsage(providerUsage.codex)].filter(Boolean);
    const visibleRows = Math.max(1, height - (usageLabels.length ? 10 : 9));
    const inputRows = Math.max(2, Math.floor((visibleRows - 6) * 0.4));
    const outputRows = Math.max(2, visibleRows - 6 - inputRows);
    const current = previewWindow(preview.output || "최근 조회 범위에 응답이 없습니다.", rightWidth, outputRows, previewOutputOffset);
    const step = outputRows;
    if (direction === "top") previewOutputOffset = 0;
    else if (direction === "bottom") previewOutputOffset = current.maxOffset;
    else previewOutputOffset = Math.max(0, Math.min(current.offset + direction * step, current.maxOffset));
    lastContentOffset = previewOutputOffset;
    render();
    return true;
  };

  const readProviderSettings = () => {
    if (!settingsStore) throw new Error("실행 설정 저장소가 연결되지 않았습니다.");
    const loaded = settingsStore.load();
    const next = loaded?.providers
      ? normalizeAllProviderExecutionSettings(loaded.providers)
      : migrateLegacyProviderExecutionSettings(loaded?.codexExecutionMode ?? loaded);
    providerSettings = next;
    codexExecutionMode = codexExecutionModeForSettings(next.codex);
    return next;
  };

  const openSettings = () => {
    if (settingsPanel) {
      settingsPanel = null;
      render();
      return;
    }
    try {
      const current = readProviderSettings();
      settingsPanel = { provider: "claude", drafts: structuredClone(current), selected: 0, error: "" };
      settingsWarning = null;
    } catch (error) {
      settingsPanel = { provider: "claude", drafts: structuredClone(providerSettings), selected: 0, error: `현재 설정을 읽지 못했습니다: ${error.message}` };
    }
    render();
  };

  const saveSettings = () => {
    if (!settingsPanel) return;
    if (!settingsStore || typeof settingsStore.saveProviderExecutionSettings !== "function") {
      settingsPanel = { ...settingsPanel, error: "설정 저장소가 전체 provider 설정 저장을 지원하지 않습니다." };
      render();
      return;
    }
    try {
      const saved = settingsStore.saveProviderExecutionSettings(settingsPanel.drafts);
      providerSettings = normalizeAllProviderExecutionSettings(saved);
      codexExecutionMode = codexExecutionModeForSettings(providerSettings.codex);
      settingsWarning = null;
      settingsPanel = null;
      notice = "Claude와 Codex 새 세션 실행 설정을 저장했습니다.";
    } catch (error) {
      settingsPanel = { ...settingsPanel, error: error.message };
    }
    render();
  };

  const handleSettingsKey = (text, key) => {
    if (!settingsPanel) return false;
    if (key.name === "escape" || (key.meta && key.name === "s")) {
      settingsPanel = null;
      render();
      return true;
    }
    if (key.name === "tab") {
      const providerName = settingsPanel.provider === "claude" ? "codex" : "claude";
      settingsPanel = { ...settingsPanel, provider: providerName, selected: 0, error: "" };
      render();
      return true;
    }
    const rows = providerExecutionRows(settingsPanel.provider, settingsPanel.drafts[settingsPanel.provider]);
    if (key.name === "up") {
      settingsPanel = { ...settingsPanel, selected: Math.max(0, settingsPanel.selected - 1), error: "" };
      render();
      return true;
    }
    if (key.name === "down") {
      settingsPanel = { ...settingsPanel, selected: Math.min(Math.max(0, rows.length - 1), settingsPanel.selected + 1), error: "" };
      render();
      return true;
    }
    if (key.name === "return") {
      saveSettings();
      return true;
    }
    if (key.name === "space" || text === " " || key.sequence === " ") {
      const row = rows[settingsPanel.selected];
      if (row) {
        const drafts = structuredClone(settingsPanel.drafts);
        drafts[settingsPanel.provider] = updateProviderExecutionSetting(settingsPanel.provider, drafts[settingsPanel.provider], row);
        settingsPanel = { ...settingsPanel, drafts, error: "" };
      }
      render();
      return true;
    }
    return true;
  };

  const routeNewTask = (draft) => {
    if (!draft) return null;
    // Alt+D creates with provider defaults and never consults local-llm-router.
    if (draft.skipRouting) return fallbackRouting({ provider: draft.provider, cwd: draft.cwd, skipped: true });
    const selected = typeof bridge.route === "function" ? bridge.route(draft.provider, draft.prompt, { cwd: draft.cwd }) : null;
    return selected ?? fallbackRouting({ provider: draft.provider, cwd: draft.cwd });
  };

  const refreshNewTaskRouting = () => {
    if (newTask) newTask = { ...newTask, routing: routeNewTask(newTask) };
  };

  const refreshProvider = async (providerName, { whileBusy = false, force = false } = {}) => {
    if (closed || (busy && !whileBusy)) return;
    const state = refreshStates.get(providerName);
    if (state.refreshing) {
      if (force) { state.queued = true; state.generation++; }
      return;
    }
    state.refreshing = true;
    const generation = ++state.generation;
    let renderAfter = false;
    try {
      if (!force && workspace.shouldRefreshOverview && !await workspace.shouldRefreshOverview()) return;
      renderAfter = true;
      const discovered = await bridge.discover({
        ...(providerName ? { provider: providerName } : {}),
        ...(filterCwd ? { cwd: path.resolve(filterCwd) } : {}), includeUsage: true,
      });
      if (closed || nativeOpen || generation !== state.generation) return;
      localObserved = true;
      const snapshot = reconcileDiscoveredSessions(
        allSessions.filter((session) => !archivedSessionIds.has(session.id)),
        { ...discovered, sessions: discovered.sessions.filter((session) => !archivedSessionIds.has(session.id)) },
        missingSessionCounts,
      );
      missingSessionCounts = snapshot.missingCounts;
      const activeSessions = snapshot.sessions;
      readSavedOrder();
      orderByWorkspace = reconcileOverviewOrder(orderByWorkspace, activeSessions);
      allSessions = applyOverviewOrder(activeSessions, orderByWorkspace);
      if (pendingCreated) {
        const created = allSessions.find((session) => session.provider === pendingCreated.provider && session.nativeId === pendingCreated.nativeId);
        if (created) { selectedKey = created.id; collapsed.delete(sessionWorkspace(created)); pendingCreated = null; }
      }
      if (discovered.providerUsage) providerUsage = { ...providerUsage, ...discovered.providerUsage };
      let reconcileWarning = null;
      if (workspace.reconcileSessionViews && Array.isArray(discovered.availableProviders)) {
        try {
          await workspace.reconcileSessionViews(activeSessions, { availableProviders: discovered.availableProviders });
        } catch (error) {
          reconcileWarning = { provider: "waga", message: `비활성 세션 창을 정리하지 못했습니다: ${error.message}` };
        }
      }
      state.warnings = reconcileWarning ? [reconcileWarning, ...discovered.warnings] : discovered.warnings;
      warnings = [...refreshStates.values()].flatMap(entry => entry.warnings);
      notice = `마지막 갱신 ${new Date().toLocaleTimeString()}`;
      if (initialSessionId) {
        const target = allSessions.find(session => session.id === initialSessionId);
        if (target) {
          initialSessionId = null; restoringSelection = null; query = ''; provider = null;
          collapsed.delete(sessionWorkspace(target)); selectedKey = target.id;
          openSession(target, { force: initialSessionForce });
        }
        else if (!providerName || initialSessionId.startsWith(`${providerName}:`)) {
          notice = `요청한 세션을 찾지 못했습니다: ${initialSessionId}`;
          initialSessionId = null;
        }
      }
    } catch (error) {
      state.warnings = [{ provider: providerName ?? "waga", message: error.message }];
      warnings = [...refreshStates.values()].flatMap(entry => entry.warnings);
    } finally {
      state.refreshing = false;
      if (!closed && renderAfter) render();
      if (state.queued && !closed) {
        state.queued = false;
        void refreshProvider(providerName, { force: true, whileBusy: true });
      }
    }
  };

  const refresh = (options) => Promise.all([...refreshStates.keys()].map(name => refreshProvider(name, options)));

  outputStream.write(`${ESC}?1049h${ESC}?25l${BRACKETED_PASTE_ON}${ESC}2J`);
  readline.emitKeypressEvents(inputStream, { escapeCodeTimeout: ESCAPE_CODE_TIMEOUT_MS });
  inputStream.setRawMode(true);
  inputStream.resume();

  const leave = () => {
    saveNavigation();
    busy = true;
    void workspace.leave()
      .then((result) => { if (result?.closeOverview) cleanup(); })
      .catch((error) => { warnings = [{ provider: "waga", message: error.message }]; render(); })
      .finally(() => { busy = false; });
  };

  const toggleCodexExecution = () => {
    if (!settingsStore) {
      notice = "Codex 실행 설정 저장소가 연결되지 않았습니다.";
      render();
      return;
    }
    try {
      const next = settingsStore.toggleCodexExecutionMode();
      if (![CODEX_EXECUTION_MODES.DEFAULT, CODEX_EXECUTION_MODES.YOLO].includes(next)) {
        throw new Error("Waga settings returned an invalid Codex execution mode");
      }
      if (typeof settingsStore.load === "function") {
        readProviderSettings();
      } else {
        providerSettings = { ...providerSettings, codex: codexSettingsForExecutionMode(next, providerSettings.codex) };
        codexExecutionMode = next;
      }
      settingsWarning = null;
      notice = next === CODEX_EXECUTION_MODES.YOLO
        ? "Codex 새 세션과 F4 재접속에 YOLO를 선택했습니다. 기존 세션은 F4에서 권한 적용을 확인합니다."
        : "Codex 새 세션과 F4 재접속에 기본 실행 모드를 선택했습니다.";
    } catch (error) {
      settingsWarning = { provider: "waga", message: `실행 설정을 저장하지 못했습니다: ${error.message}` };
      notice = "실행 설정을 바꾸지 못했습니다.";
    }
    render();
  };

  const submitNewTask = () => {
    const prompt = newTask.prompt.trim();
    if (!prompt) {
      newTask.error = "프롬프트를 입력하세요.";
      render();
      return;
    }
    const draft = { ...newTask, prompt, cursor: Math.min(newTask.cursor, graphemes(prompt).length), submitting: true, startedAt: Date.now(), progress: [], error: "", routing: routeNewTask({ ...newTask, prompt }) };
    newTask = draft;
    busy = true;
    render();
    void (async () => {
      let created;
      try {
        const createOptions = { cwd: draft.cwd, ...(draft.skipRouting ? { routing: draft.routing } : {}), onProgress: ({ message, routing, stage }) => {
          if (closed) return;
          if (routing) draft.routing = routing;
          if (stage === "judge-text") draft.judgeText = message;
          else draft.progress = [...(draft.progress ?? []), message].slice(-4);
          if (stage === "fallback" || routing) draft.judgeText = "";
          newTask = { ...draft };
          render();
        } };
        if (settingsStore) createOptions.executionSettings = structuredClone(providerSettings[draft.provider]);
        if (draft.provider === "codex") createOptions.executionMode = codexExecutionMode;
        created = await bridge.create(draft.provider, draft.prompt, createOptions);
        if (closed) return;
        initialCreate = null;
        newTask = null;
        notice = `${draft.provider === "claude" ? "Claude" : "Codex"} 새 세션을 생성했습니다. ${routingSummary(created.routing ?? draft.routing)}`;
        query = "";
        if (provider && provider !== created.provider) provider = null;
        pendingCreated = created;
        if (created.session) {
          allSessions = [...allSessions.filter((session) => session.id !== created.session.id), created.session];
          orderByWorkspace = reconcileOverviewOrder(orderByWorkspace, allSessions);
          allSessions = applyOverviewOrder(allSessions, orderByWorkspace);
          selectedKey = created.session.id;
          collapsed.delete(sessionWorkspace(created.session));
          missingSessionCounts.delete(created.session.id);
          pendingCreated = null;
        }
      } catch (error) {
        newTask = { ...draft, submitting: false, error: error.message };
      } finally {
        busy = false;
        if (!closed) render();
        if (created && !closed) void refresh({ force: true });
      }
    })();
  };

  const archiveSession = (target) => {
    const terminating = target.provider === "claude" && target.kind === "interactive";
    if (pendingArchiveId !== target.id) {
      pendingArchiveId = target.id;
      notice = terminating
        ? `${target.name}: CLI와 창을 종료합니다. Alt+X를 다시 누르면 실행합니다.`
        : target.provider === "claude"
        ? `${target.name}: Agent View 작업과 worktree를 정리하고 transcript는 보존합니다. Alt+X를 다시 누르면 실행합니다.`
        : `${target.name}: 로그를 archived_sessions로 옮겨 보존합니다. Alt+X를 다시 누르면 실행합니다.`;
      render();
      return;
    }

    pendingArchiveId = null;
    busy = true;
    notice = terminating ? `${target.name} Claude CLI를 종료하는 중입니다.` : `${target.name} 세션을 보관하는 중입니다.`;
    render();
    const scope = filterCwd ? { cwd: path.resolve(filterCwd) } : {};
    void (async () => {
      let archived = false;
      try {
        await bridge.archive(target.id, scope);
        if (closed) return;
        archived = true;
        archivedSessionIds.add(target.id);
        allSessions = allSessions.filter((session) => session.id !== target.id);
        selectedKey = null;
        notice = terminating ? `${target.name} Claude CLI를 종료했습니다. 대화 로그는 유지됩니다.` : `${target.name} 세션을 보관했습니다. 대화 로그는 유지됩니다.`;
      } catch (error) {
        warnings = [{ provider: target.provider, message: error.message }];
      } finally {
        busy = false;
        if (!closed) render();
      }

      // Native acknowledgement is the UI boundary; cleanup must not hold input or the row.
      if (!archived || closed) return;
      let closeWarning = null;
      try { await workspace.closeSessionView?.(target); }
      catch (error) { closeWarning = { provider: "waga", message: `보관된 세션 창을 닫지 못했습니다: ${error.message}` }; }
      if (closed) return;
      await refresh({ force: true });
      if (closeWarning && !closed) {
        warnings = [closeWarning, ...warnings];
        render();
      }
    })();
  };

  const submitRename = () => {
    const name = renameTask.name.trim();
    if (!name) {
      renameTask.error = "새 이름을 입력하세요.";
      render();
      return;
    }
    const draft = { ...renameTask, name, submitting: true, error: "" };
    renameTask = draft;
    busy = true;
    render();
    const scope = filterCwd ? { cwd: path.resolve(filterCwd) } : {};
    void (async () => {
      try {
        const result = await bridge.rename(draft.session.id, draft.name, scope);
        let viewRenameWarning = null;
        try {
          await workspace.renameSessionView?.({ ...draft.session, name: result.name ?? draft.name });
        } catch (error) {
          viewRenameWarning = { provider: "waga", message: `세션 창 제목을 갱신하지 못했습니다: ${error.message}` };
        }
        renameTask = null;
        selectedKey = draft.session.id;
        await refresh({ whileBusy: true, force: true });
        notice = `세션 이름을 '${draft.name}'(으)로 변경했습니다.`;
        if (result.nameSync === "pending") notice += " Claude에는 다음 프롬프트에서 반영 요청됩니다.";
        else if (result.nameSync === "local") notice += " Waga 로컬 이름만 변경했습니다.";
        if (viewRenameWarning) warnings = [viewRenameWarning, ...warnings];
      } catch (error) {
        renameTask = { ...draft, submitting: false, error: error.message };
      } finally {
        busy = false;
        if (!closed) render();
      }
    })();
  };

  const pasteTarget = () => newTask?.cwdEdit ? "cwdEdit" : newTask ? "newTask" : renameTask ? "renameTask" : searching ? "search" : null;

  const insertAtCursor = (value, cursor, inserted) => {
    if (!inserted) return { value, cursor };
    const cells = graphemes(value);
    const added = graphemes(inserted);
    cells.splice(cursor, 0, ...added);
    return { value: cells.join(""), cursor: cursor + added.length };
  };

  const startPaste = () => {
    const target = pasteTarget();
    if (!target) return false;
    pasteBuffer = { target, chunks: [] };
    return true;
  };

  const finishPaste = () => {
    if (!pasteBuffer) return false;
    const { target, chunks } = pasteBuffer;
    pasteBuffer = null;
    const raw = chunks.join("");
    if (target === "cwdEdit" && newTask?.cwdEdit) {
      const next = insertAtCursor(newTask.cwdEdit.value, newTask.cwdEdit.cursor, cleanPastedSingleLine(raw));
      newTask.cwdEdit = { ...next, error: "" };
    } else if (target === "newTask" && newTask) {
      const next = insertAtCursor(newTask.prompt, newTask.cursor, cleanPastedPrompt(raw));
      newTask = { ...newTask, prompt: next.value, cursor: next.cursor, error: "" };
      refreshNewTaskRouting();
    } else if (target === "renameTask" && renameTask) {
      const next = insertAtCursor(renameTask.name, renameTask.cursor, cleanPastedSingleLine(raw));
      renameTask = { ...renameTask, name: next.value, cursor: next.cursor, error: "" };
    } else if (target === "search" && searching) {
      const inserted = cleanPastedSingleLine(raw);
      if (inserted) query += inserted;
      selected = 0;
      selectedKey = null;
    }
    render();
    return true;
  };

  const openSession = (target, { force = false } = {}) => {
    if (target.hostId) {
      const host = globalDock.config.hosts.find(host => host.id === target.hostId);
      if (!host || host.discovered || host.online === false) { notice = '이 PC에 연결할 수 없습니다. PC 연결 설정을 확인해 주세요.'; render(); return; }
      if (!globalDock.states.get(host.id)?.summary?.openSession) { notice = `${host.name}의 Waga 업데이트가 필요합니다. PC 연결 설정에서 u로 업데이트해 주세요.`; render(); return; }
      void openHost(host, { sessionId: target.id, force });
      return;
    }
    busy = true;
    notice = force ? `${target.name} 세션에 다시 연결하는 중입니다.` : `${target.name} 세션을 여는 중입니다.`;
    render();
    nativeOpen = true;
    void Promise.resolve().then(() => commandFor(target, { codexExecutionMode }))
      .then((command) => {
        if (!closed) return workspace.focusOrOpen(target, command, {
          force, knownNativeIds: allSessions.filter((session) => session.provider === "codex").map((session) => session.nativeId),
        });
      })
      .then((result) => {
        if (closed) return;
        if (result?.signal && result.signal !== 'SIGINT' || result?.code && !result.signal) {
          throw Error(`네이티브 CLI 종료: ${result.signal ?? `exit ${result.code}`}`);
        }
        notice = result?.code !== undefined ? `${target.name} 세션 연결을 해제했습니다.` : '';
      })
      .catch((error) => {
        notice = `${target.name} F4 접속 실패: ${error.message}`;
        warnings = [{ provider: target.provider, message: `F4 접속 실패: ${error.message}` }];
      })
      .finally(() => { busy = false; nativeOpen = false; render(); });
  };

  const openHost = async (host, { sessionId, create, force = false } = {}) => {
    if (!workspace.openRemoteHost) { notice = '원격 PC 열기는 tmux backend가 필요합니다. waga --backend tmux를 사용하세요.'; render(); return; }
    busy = true;
    nativeOpen = true;
    try {
      const result = await workspace.openRemoteHost(host, { ...remoteCommand(host, { interactive: true, sessionId, create, force }), sessionId, force });
      if (result?.code) throw Error(`${host.name} SSH 연결 종료: exit ${result.code}`);
    } catch (error) { notice = error.message; }
    finally { busy = false; nativeOpen = false; render(); }
  };

  const onKeypress = (text, key = {}) => {
    if (busy || closed || reloading) return;
    restoringSelection = null;
    const koreanMetaKey = key.meta && key.sequence?.startsWith("\x1b") && KOREAN_META_KEYS.get(key.sequence.slice(1));
    if (koreanMetaKey) key = { ...key, name: koreanMetaKey };
    pendingCreated = null; // A later discovery must not steal selection after the user navigates.
    if (key.name === "paste-start") {
      if (startPaste()) return;
    }
    if (pasteBuffer) {
      if (key.name === "paste-end") {
        finishPaste();
        return;
      }
      const chunk = String(key.sequence ?? text ?? "");
      if (chunk) pasteBuffer.chunks.push(chunk);
      return;
    }
    if ((key.ctrl && key.name === "c") || (key.meta && key.name === "q")) {
      leave();
      return;
    }
    if (globalVisible) {
      if (hostConnection) {
        const edit = hostConnection;
        if (key.name === 'escape') { hostConnection = null; notice = ''; }
        else if (key.name === 'return') {
          busy = true; notice = 'SSH 접속과 Waga 설치를 확인하는 중입니다.'; render();
          void globalDock.connect(edit.id, edit.value)
            .then(async host => {
              hostConnection = null; notice = 'PC를 등록했습니다.';
              if (integrated) { pcFilter = host.id; globalVisible = false; selectedKey = null; selectFirstSession(); }
              else await openHost(host);
            })
            .catch(error => { notice = error.stderr?.trim() || error.message; })
            .finally(() => { busy = false; render(); });
          return;
        } else if (key.name === 'left') edit.cursor = Math.max(0, edit.cursor - 1);
        else if (key.name === 'right') edit.cursor = Math.min(edit.value.length, edit.cursor + 1);
        else if (key.name === 'home') edit.cursor = 0;
        else if (key.name === 'end') edit.cursor = edit.value.length;
        else if (key.ctrl && key.name === 'u') { edit.value = ''; edit.cursor = 0; }
        else if (key.name === 'backspace' && edit.cursor) { edit.value = edit.value.slice(0, edit.cursor - 1) + edit.value.slice(edit.cursor); edit.cursor--; }
        else if (key.name === 'delete') edit.value = edit.value.slice(0, edit.cursor) + edit.value.slice(edit.cursor + 1);
        else if (!key.ctrl && !key.meta && /^[a-zA-Z0-9_.-]+$/.test(text ?? '') && edit.value.length + text.length <= 64) {
          edit.value = edit.value.slice(0, edit.cursor) + text + edit.value.slice(edit.cursor); edit.cursor += text.length;
        }
        render(); return;
      }
      const rows = visibleHosts();
      let index = Math.max(0, rows.findIndex(row => row.id === globalDock.selectedId));
      if (key.name === "escape") {
        if (globalSearching || globalQuery) { globalSearching = false; globalQuery = ""; }
        else returnToLocal();
      }
      else if (key.sequence === "/" && !globalSearching) globalSearching = true;
      else if (globalSearching && key.name === "return") globalSearching = false;
      else if (globalSearching && key.name === "backspace") globalQuery = graphemes(globalQuery).slice(0, -1).join("");
      else if (globalSearching && !key.ctrl && !key.meta && text && !/[\x00-\x1f\x7f-\x9f]/.test(text)) globalQuery = (globalQuery + text).slice(0, 256);
      else if (key.name === "up" || key.name === "down") {
        index = Math.max(0, Math.min(rows.length - 1, index + (key.name === "up" ? -1 : 1)));
        if (rows[index]) globalDock.selectedId = rows[index].id;
      } else if (key.meta && key.name === "r") {
        void refreshHosts({ force: true });
      } else if (key.name === 'u' && !key.meta && !key.ctrl && !globalSearching) {
        const updateLocal = key.shift || text === 'U' || rows[index]?.local;
        const targets = (updateLocal ? globalDock.config.hosts : rows[index] ? globalDock.config.hosts.filter(host => host.id === rows[index].id) : []).filter(host => !host.discovered);
        if (updating) notice = 'PC 업데이트가 진행 중입니다.';
        else if (!targets.length && !updateLocal) notice = '업데이트할 원격 PC를 선택해 주세요.';
        else {
          updating = true;
          notice = '확정된 버전을 준비하고 있습니다.';
          void hostUpdater(targets, { local: Boolean(updateLocal), changed: (host, state) => { globalDock.updates.set(host.id, state); render(); } })
            .then(results => {
              saveUpdatedHosts(hostsPath, results);
              notice = `업데이트 결과: ${results.filter(row => row.state !== 'failed').length}개 성공 · ${results.filter(row => row.state === 'failed').length}개 실패`;
            })
            .catch(error => { notice = error.message; })
            .finally(() => { updating = false; render(); void refreshHosts(); });
        }
      } else if (key.name === "return") {
        const host = rows[index];
        if (!host) return;
        if (host.local) returnToLocal();
        else if (host.discovered) { hostConnection = { id: host.id, name: host.name, value: '', cursor: 0 }; notice = '접속할 PC의 계정명을 입력해 주세요.'; }
        else void openHost(host);
      }
      render();
      return;
    }
    if (!newTask && !renameTask && !settingsPanel && !searching && key.name === "return" && visibleNodes()[selected]?.type === "hosts") {
      if (remoteHost) leave();
      else { globalVisible = true; notice = ""; render(); void refreshHosts(); }
      return;
    }
    if (key.meta && key.name === "s" && !renameTask) {
      openSettings();
      return;
    }
    if (settingsPanel) {
      handleSettingsKey(text, key);
      return;
    }
    if (key.meta && key.name === "y") {
      toggleCodexExecution();
      return;
    }
    if (!newTask && !renameTask && !searching && (key.name === "pageup" || key.name === "pagedown")) {
      if (scrollPreview(key.name === "pageup" ? -1 : 1)) return;
    }
    if (!(key.meta && key.name === "x")) pendingArchiveId = null;
    if (renameTask) {
      const cells = graphemes(renameTask.name);
      if (key.name === "escape") renameTask = null;
      else if (key.name === "return") { submitRename(); return; }
      else if (key.name === "left") renameTask.cursor = Math.max(0, renameTask.cursor - 1);
      else if (key.name === "right") renameTask.cursor = Math.min(cells.length, renameTask.cursor + 1);
      else if (key.name === "home") renameTask.cursor = 0;
      else if (key.name === "end") renameTask.cursor = cells.length;
      else if (key.name === "backspace" && renameTask.cursor > 0) {
        cells.splice(renameTask.cursor - 1, 1);
        renameTask = { ...renameTask, name: cells.join(""), cursor: renameTask.cursor - 1, error: "" };
      } else if (key.name === "delete" && renameTask.cursor < cells.length) {
        cells.splice(renameTask.cursor, 1);
        renameTask = { ...renameTask, name: cells.join(""), error: "" };
      } else if (key.ctrl && key.name === "u") renameTask = { ...renameTask, name: "", cursor: 0, error: "" };
      else if (!key.ctrl && !key.meta) {
        const inserted = String(key.sequence ?? text ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
        if (inserted) {
          const added = graphemes(inserted);
          cells.splice(renameTask.cursor, 0, ...added);
          renameTask = { ...renameTask, name: cells.join(""), cursor: renameTask.cursor + added.length, error: "" };
        }
      }
      render();
      return;
    }
    if (newTask) {
      if (newTask.cwdPicker) {
        const picker = newTask.cwdPicker;
        const selected = picker.entries[picker.selected];
        if (key.name === "escape") newTask.cwdPicker = null;
        else if (key.name === "up") picker.selected = Math.max(0, picker.selected - 1);
        else if (key.name === "down") picker.selected = Math.min(picker.entries.length - 1, picker.selected + 1);
        else if (key.name === "home") picker.selected = 0;
        else if (key.name === "end") picker.selected = picker.entries.length - 1;
        else if (key.name === "backspace" || key.name === "left") {
          try { newTask.cwdPicker = folderPicker(path.dirname(picker.cwd)); }
          catch (error) { picker.error = error.message; }
        } else if (key.name === "return") {
          if (selected.type === "select") {
            try {
              if (!fs.statSync(picker.cwd).isDirectory()) throw new Error("존재하는 폴더를 선택하세요.");
              newTask = { ...newTask, cwd: picker.cwd, cwdPicker: null, error: "" };
              refreshNewTaskRouting();
            } catch (error) { picker.error = error.message; }
          } else {
            const next = selected.type === "parent" ? path.dirname(picker.cwd) : path.join(picker.cwd, selected.name);
            try { newTask.cwdPicker = folderPicker(next); }
            catch (error) { picker.error = error.message; }
          }
        } else if (!key.ctrl && !key.meta && String(key.sequence ?? text ?? "") === "e") {
          newTask = { ...newTask, cwdPicker: null, cwdEdit: { value: picker.cwd, cursor: graphemes(picker.cwd).length, error: "" } };
        }
        render();
        return;
      }
      if (newTask.cwdEdit) {
        const edit = newTask.cwdEdit;
        const cells = graphemes(edit.value);
        if (key.name === "escape") newTask.cwdEdit = null;
        else if (key.name === "return") {
          const entered = edit.value.trim();
          const cwd = entered ? path.resolve(newTask.cwd, entered) : "";
          try {
            if (!cwd || !fs.statSync(cwd).isDirectory()) throw new Error("존재하는 폴더를 입력하세요.");
            newTask = { ...newTask, cwd, cwdEdit: null, error: "" };
            refreshNewTaskRouting();
          } catch (error) {
            newTask.cwdEdit = { ...edit, error: error.code === "ENOENT" || error.code === "ENOTDIR" ? "존재하는 폴더를 입력하세요." : error.message };
          }
        }
        else if (key.name === "left") edit.cursor = Math.max(0, edit.cursor - 1);
        else if (key.name === "right") edit.cursor = Math.min(cells.length, edit.cursor + 1);
        else if (key.name === "home") edit.cursor = 0;
        else if (key.name === "end") edit.cursor = cells.length;
        else if (key.name === "backspace" && edit.cursor > 0) {
          cells.splice(edit.cursor - 1, 1);
          newTask.cwdEdit = { value: cells.join(""), cursor: edit.cursor - 1, error: "" };
        } else if (key.name === "delete" && edit.cursor < cells.length) {
          cells.splice(edit.cursor, 1);
          newTask.cwdEdit = { value: cells.join(""), cursor: edit.cursor, error: "" };
        } else if (key.ctrl && key.name === "u") newTask.cwdEdit = { value: "", cursor: 0, error: "" };
        else if (!key.ctrl && !key.meta) {
          const inserted = String(key.sequence ?? text ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
          if (inserted) {
            const added = graphemes(inserted);
            cells.splice(edit.cursor, 0, ...added);
            newTask.cwdEdit = { value: cells.join(""), cursor: edit.cursor + added.length, error: "" };
          }
        }
        render();
        return;
      }
      const cells = graphemes(newTask.prompt);
      if (key.name === "escape") {
        newTask = null;
        if (initialCreate) { initialCreate = null; leave(); return; }
      }
      else if (key.meta && key.name === "p") {
        try { newTask = { ...newTask, cwdPicker: folderPicker(newTask.cwd) }; }
        catch (error) { newTask.error = error.message; }
      }
      else if (key.name === "tab") newTask = { ...newTask, provider: newTask.provider === "claude" ? "codex" : "claude", error: "" };
      else if (key.meta && key.name === "d") newTask = { ...newTask, skipRouting: !newTask.skipRouting, error: "" };
      else if ((key.shift && key.name === "return") || key.name === "enter" || (key.ctrl && key.name === "j") || key.sequence === "\x1b[13;2u") {
        cells.splice(newTask.cursor, 0, "\n");
        newTask = { ...newTask, prompt: cells.join(""), cursor: newTask.cursor + 1, error: "" };
      }
      else if (key.name === "return") { submitNewTask(); return; }
      else if (key.name === "left") newTask.cursor = Math.max(0, newTask.cursor - 1);
      else if (key.name === "right") newTask.cursor = Math.min(cells.length, newTask.cursor + 1);
      else if (["up", "down", "home", "end"].includes(key.name)) newTask.cursor = movePromptCursor(newTask.prompt, newTask.cursor, key.name);
      else if (key.name === "backspace" && newTask.cursor > 0) {
        cells.splice(newTask.cursor - 1, 1);
        newTask = { ...newTask, prompt: cells.join(""), cursor: newTask.cursor - 1, error: "" };
      } else if (key.name === "delete" && newTask.cursor < cells.length) {
        cells.splice(newTask.cursor, 1);
        newTask = { ...newTask, prompt: cells.join(""), error: "" };
      } else if (key.ctrl && key.name === "u") newTask = { ...newTask, prompt: "", cursor: 0, error: "" };
      else if (!key.ctrl && !key.meta) {
        const inserted = String(key.sequence ?? text ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
        if (inserted) {
          const added = graphemes(inserted);
          cells.splice(newTask.cursor, 0, ...added);
          newTask = { ...newTask, prompt: cells.join(""), cursor: newTask.cursor + added.length, error: "" };
        }
      }
      if (!newTask?.cwdEdit && !newTask?.cwdPicker) refreshNewTaskRouting();
      render();
      return;
    }
    if (searching) {
      if (key.name === "escape") { searching = false; query = ""; }
      else if (key.name === "return") searching = false;
      else if (key.name === "backspace") query = [...query].slice(0, -1).join("");
      else if (key.ctrl && key.name === "u") query = "";
      else if (key.sequence && !key.ctrl && !key.meta && key.sequence >= " ") query += key.sequence;
      selected = 0;
      selectedKey = null;
      render();
      return;
    }
    const nodes = visibleNodes();
    reconcileSelection(nodes);
    const owner = nodes[selected]?.host ?? (pcFilter ? globalDock?.rows().find(host => host.id === pcFilter) : null);
    if (key.meta && key.name === 'v' && !nativeOpen) {
      const target = nodes[selected]?.session ? nodes[selected] : nodes.find(node => node.key === lastContentKey);
      viewMode = viewMode === 'tree' ? 'status' : 'tree';
      if (target) {
        selectedKey = target.key;
        if (viewMode === 'tree') collapsed.delete(target.collapseKey ?? target.cwd);
      }
      render(); return;
    }
    if (viewMode === 'status' && key.shift && ['up', 'down'].includes(key.name)) {
      notice = '순서 변경은 폴더 트리 보기에서 실행해 주세요.'; render(); return;
    }
    if (key.meta && key.name === 'p' && globalDock) {
      globalVisible = true; notice = ''; render(); void refreshHosts(); return;
    }
    if (owner && !owner.local && key.meta && ['n', 'd'].includes(key.name)) {
      if (!globalDock.states.get(owner.id)?.summary?.createSession) {
        notice = `${owner.name}의 Waga 업데이트가 필요합니다. Alt+P에서 업데이트해 주세요.`;
        render(); return;
      }
      void openHost(owner, { create: { provider: nodes[selected]?.session?.provider ?? provider ?? 'claude',
        cwd: nodes[selected]?.cwd, skipRouting: key.name === 'd' }, force: true });
      return;
    }
    const manageRemote = nodes[selected]?.type === 'session'
      && (key.name === 'f2' || key.meta && key.name === 'x' || key.shift && ['up', 'down'].includes(key.name));
    if (owner && !owner.local && manageRemote) {
      notice = '이 PC의 관리 화면에서 이름 변경·보관·순서 변경을 실행해 주세요.';
      if (!owner.discovered && owner.online !== false) void openHost(owner);
      else { globalVisible = true; globalDock.selectedId = owner.id; }
      render(); return;
    }
    if (key.meta && key.name === "x" && nodes[selected]?.type === "session") {
      archiveSession(nodes[selected].session);
      return;
    }
    if (key.name === "f4" && !key.meta && !key.ctrl && !key.shift && nodes[selected]?.type === "session") {
      openSession(nodes[selected].session, { force: true });
      return;
    }
    if (key.name === "f2" && nodes[selected]?.type === "session") {
      const session = nodes[selected].session;
      renameTask = { session, name: session.name, cursor: graphemes(session.name).length, error: "", submitting: false };
      render();
      return;
    }
    if (key.shift && (key.name === "up" || key.name === "down") && nodes[selected]?.type === "session") {
      const target = nodes[selected];
      const visibleIds = nodes.filter((node) => node.type === "session" && node.workspaceKey === target.workspaceKey).map((node) => node.session.id);
      const moved = moveOverviewSession(orderByWorkspace, target.cwd, target.session.id, key.name, visibleIds);
      if (moved) {
        orderByWorkspace = moved;
        allSessions = applyOverviewOrder(allSessions, orderByWorkspace);
        selectedKey = target.session.id;
        if (orderStore) {
          try { orderStore.saveWorkspace(target.cwd, moved.get(target.cwd)); orderWarning = null; }
          catch (error) { orderWarning = { provider: "waga", message: error.message }; }
        }
      }
      render();
      return;
    }
    if (key.name === "up") selected = Math.max(0, selected - 1);
    else if (key.name === "down") selected = Math.min(Math.max(0, nodes.length - 1), selected + 1);
    else if (key.name === "tab") {
      if (key.shift) {
        provider = provider === null ? 'codex' : provider === 'codex' ? 'claude' : null;
        selectFirstSession();
      } else if (integrated) {
        pcSelections.set(pcFilter, { key: selectedKey, offset: previewOutputOffset });
        const ids = [null, ...connectedHosts().map(host => host.id)];
        pcFilter = ids[(ids.indexOf(pcFilter) + 1) % ids.length];
        const saved = pcSelections.get(pcFilter);
        selectedKey = saved?.key ?? null; restoredOffset = saved?.offset ?? 0;
        if (!selectedKey) selectFirstSession();
      } else if (remoteHost) {
        leave(); return;
      }
    }
    else if (key.sequence === "/") searching = true;
    else if (key.meta && (key.name === "n" || key.name === "d")) {
      const node = nodes[selected];
      newTask = {
        provider: node?.type === "session" ? node.session.provider : provider ?? "claude",
        cwd: path.resolve(node?.cwd ?? filterCwd ?? defaultCwd),
        prompt: "",
        cursor: 0,
        error: "",
        submitting: false,
        routing: null,
        skipRouting: key.name === "d",
      };
      refreshNewTaskRouting();
    }
    else if (key.meta && key.name === "r") { notice = "새로고침 중입니다."; render(); void refresh({ force: true }); void refreshHosts({ force: true }); return; }
    else if (key.name === "left" && nodes[selected]?.type === "workspace") collapsed.add(nodes[selected].collapseKey ?? nodes[selected].cwd);
    else if (key.name === "left" && nodes[selected]?.type === "session") {
      const parentIndex = nodes.findIndex((node) => node.key === nodes[selected].workspaceKey);
      if (parentIndex >= 0) selected = parentIndex;
    }
    else if (key.name === "right" && nodes[selected]?.type === "workspace") collapsed.delete(nodes[selected].collapseKey ?? nodes[selected].cwd);
    else if (key.name === "return" && nodes[selected]?.type === "workspace") {
      const cwd = nodes[selected].collapseKey ?? nodes[selected].cwd;
      if (collapsed.has(cwd)) collapsed.delete(cwd);
      else collapsed.add(cwd);
    }
    else if (key.name === "return" && nodes[selected]?.type === "session") {
      openSession(nodes[selected].session);
      return;
    }
    else if (key.name === 'return' && nodes[selected]?.type === 'host') {
      const host = nodes[selected].host;
      if (!host.local) { globalVisible = true; globalDock.selectedId = host.id; void refreshHosts(); }
    }
    selectedKey = visibleNodes()[selected]?.key ?? null;
    render();
  };

  const onResize = () => render();
  inputStream.on("keypress", onKeypress);
  outputStream.on("resize", onResize);
  const timer = setInterval(() => {
    if (newTask?.submitting) render();
    else { void refresh(); if (globalVisible || integrated) void refreshHosts(); void reloadIfReady(); }
  }, refreshMs);
  let resolveRun;
  const completed = new Promise((resolve) => { resolveRun = resolve; });
  const cleanup = () => {
    if (closed) return;
    saveNavigation();
    closed = true;
    previewReader.close();
    clearInterval(timer);
    inputStream.off("keypress", onKeypress);
    inputStream.off("end", cleanup);
    inputStream.off("close", cleanup);
    outputStream.off("resize", onResize);
    if (listenForSignals) {
      process.off("SIGTERM", cleanup);
      process.off("SIGHUP", cleanup);
    }
    if (inputStream.isTTY) inputStream.setRawMode(false);
    pasteBuffer = null;
    outputStream.write(`${ESC}?25h${BRACKETED_PASTE_OFF}${ESC}?1049l`);
    resolveRun(0);
  };
  if (listenForSignals) {
    process.once("SIGTERM", cleanup);
    process.once("SIGHUP", cleanup);
  }
  inputStream.once("end", cleanup);
  inputStream.once("close", cleanup);
  if (runningRelease.root && workspace.prepareOverviewRelease) {
    try { await workspace.prepareOverviewRelease(runningRelease.runningRevision); }
    catch (error) { notice = `Dock 버전 표시 실패: ${error.message}`; }
  }
  void refresh({ force: true });
  if (newTask) refreshNewTaskRouting();
  if (integrated) void refreshHosts();
  return await completed;
}

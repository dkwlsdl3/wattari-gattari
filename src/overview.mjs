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

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
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
  cursor: "1;38;2;226;232;240",
  // Claude's brand coral and the native Codex TUI's terminal-defined cyan.
  claude: "1;38;2;217;119;87",
  codex: "1;36",
  working: "1;32",
  idle: "1;34",
  needsInput: "1;31",
  error: "1;38;2;224;154;164",
  warning: "1;38;2;224;190;132",
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
  return graphemes(value).reduce((sum, grapheme) => sum + [...grapheme].reduce((part, character) => part + cellWidth(character), 0), 0);
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
  const cells = graphemes(value);
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

function sessionWorkspace(session) {
  return path.resolve(String(session.projectCwd || session.cwd || "/"));
}

export function reconcileOverviewOrder(orderByWorkspace, sessions) {
  const reconciled = new Map([...orderByWorkspace].map(([workspace, ids]) => [workspace, [...ids]]));
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

export function buildOverviewTree(sessions, { collapsed = new Set(), query = "", rootCwd = null } = {}) {
  const workspaces = new Map();
  if (rootCwd && !query) workspaces.set(path.resolve(rootCwd), []);
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

function statusView(status) {
  if (status === "needs-input") return ["!", "needs input", THEME.needsInput];
  if (status === "working") return ["●", "working", THEME.working];
  if (status === "error") return ["!", "error", THEME.error];
  if (status === "idle") return ["○", "ready", THEME.idle];
  return ["·", safeText(status || "unknown"), THEME.muted];
}

function counts(sessions) {
  const count = (status) => sessions.filter((session) => session.status === status).length;
  return `${count("needs-input")} need input   ${count("working")} working   ${count("idle")} ready`;
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

export function buildSettingsFrame({ settingsPanel, width = 100, height = 30, notice = "" }) {
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
  lines.push(`  ${color(THEME.title, fit("WAGA · 실행 설정", usableWidth))}`);
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

function wrapPreview(text, width, count) {
  const result = [];
  for (const paragraph of previewText(text).split("\n")) {
    let line = "";
    let used = 0;
    for (const grapheme of graphemes(paragraph)) {
      const size = widthOf(grapheme);
      if (used + size > width) {
        result.push(line); line = ""; used = 0;
        if (result.length >= count) break;
      }
      line += grapheme; used += size;
    }
    if (result.length >= count) break;
    result.push(line);
  }
  if (result.length >= count && widthOf(result.join("")) < widthOf(previewText(text).replace(/\n/g, ""))) {
    result[count - 1] = `${fit(result[count - 1], width - 1)}…`;
  }
  return Array.from({ length: count }, (_, index) => fit(result[index] ?? "", width));
}

function previewLines(session, preview, width, height) {
  const heading = session ? `${session.provider === "claude" ? "CLAUDE" : "CODEX"} · ${session.name}` : "세션 미리보기";
  const brand = session?.provider === "claude" ? THEME.claude : THEME.codex;
  const lines = [color(brand, fit(heading, width))];
  if (!session || !preview || preview.state !== "ready") {
    const text = !session ? "세션을 선택하면 최근 대화가 표시됩니다."
      : preview?.state === "error" ? `미리보기를 읽지 못했습니다: ${preview.error || "조회 오류"}. 잠시 후 재시도합니다.` : "최근 대화를 읽는 중입니다…";
    return [...lines, "", ...wrapPreview(text, width, height - 2).map((line) => color(THEME.muted, line))];
  }
  const inputRows = Math.max(2, Math.floor((height - 6) * 0.4));
  const outputRows = Math.max(2, height - 6 - inputRows);
  lines.push(color(THEME.primary, "마지막 입력"));
  lines.push(...wrapPreview(preview.input || "최근 조회 범위에 입력이 없습니다.", width, inputRows));
  lines.push("", color(THEME.primary, fit("마지막 응답 (이전 작업 포함)", width)));
  lines.push(...wrapPreview(preview.output || "최근 조회 범위에 응답이 없습니다.", width, outputRows));
  const checked = new Date(preview.observedAt ?? preview.checkedAt).toLocaleTimeString();
  lines.push("", color(preview.error ? THEME.warning : THEME.muted,
    fit(preview.error ? `${preview.error} · 이전 조회 ${checked}` : `${preview.limited ? "최근 일부 · " : ""}조회 ${checked}`, width)));
  return lines;
}

export function buildOverviewFrame({ sessions, collapsed = new Set(), query = "", rootCwd = null, nodes = buildOverviewTree(sessions, { collapsed, query, rootCwd }), selected = 0, width = 100, height = 30, warnings = [], provider = null, providerUsage = {}, notice = "", newTask = null, renameTask = null, preview = null, nativeHint = nativeReturnHint(null), codexExecutionMode = CODEX_EXECUTION_MODES.DEFAULT, providerSettings = defaultProviderExecutionSettings(), settingsPanel = null }) {
  if (settingsPanel) return buildSettingsFrame({ settingsPanel, width, height, notice });
  const usableWidth = Math.max(1, width - 4);
  const split = hasOverviewPreview(width, height);
  const listWidth = split ? Math.floor(usableWidth * 0.6) : usableWidth;
  const usageLabels = [
    { text: formatClaudeUsage(providerUsage.claude), color: THEME.claude },
    { text: formatCodexUsage(providerUsage.codex), color: THEME.codex },
  ].filter(({ text }) => text);
  const visibleRows = Math.max(1, height - (usageLabels.length ? 10 : 9));
  const safeSelected = Math.max(0, Math.min(selected, Math.max(0, nodes.length - 1)));
  const offset = Math.max(0, Math.min(safeSelected - Math.floor(visibleRows / 2), Math.max(0, nodes.length - visibleRows)));
  const wide = listWidth >= 64;
  const nameWidth = wide ? Math.max(12, listWidth - 31) : Math.max(1, listWidth - 21);
  const lines = [];
  const title = wide ? "WATTARI GATTARI  Claude + Codex session dock" : "WAGA · session dock";
  lines.push(`  ${color(THEME.title, fit(title, usableWidth))}`);
  const executionStatusColor = codexExecutionMode === CODEX_EXECUTION_MODES.YOLO ? THEME.warning : THEME.muted;
  lines.push(`  ${color(executionStatusColor, fit(`${counts(sessions)}${provider ? `   filter: ${provider}` : ""}   ${codexExecutionLabel(codexExecutionMode)}   Alt+S 설정   Alt+Y 빠른 전환`, usableWidth))}`);
  if (usageLabels.length) lines.push(`  ${coloredUsageLine(usageLabels, usableWidth)}`);
  lines.push(`  ${color(THEME.divider, "─".repeat(Math.max(1, usableWidth)))}`);
  const bodyStart = lines.length;

  if (!sessions.length) lines.push(color(THEME.muted, fit(query ? "검색 결과가 없습니다." : "발견된 세션이 없습니다. Alt+R을 눌러 새로고침하세요.", listWidth)));
  for (let index = offset; index < Math.min(nodes.length, offset + visibleRows); index += 1) {
    const node = nodes[index];
    const active = index === safeSelected;
    const marker = active ? color(THEME.cursor, "›") : " ";
    if (node.type === "workspace") {
      const toggle = collapsed.has(node.cwd) && !query ? "▸" : "▾";
      const detail = wide ? `  ${node.cwd}  ·  ${node.sessionCount} session${node.sessionCount === 1 ? "" : "s"}` : `  ${node.sessionCount}`;
      const row = `${marker} ${color(THEME.muted, toggle)} ${color(THEME.primary, fit(`${node.name}${detail}`, listWidth - 4))}`;
      lines.push(active ? `${ESC}${THEME.selected}m${row}${RESET}` : row);
      continue;
    }
    const session = node.session;
    const [symbol, status, statusColor] = statusView(session.status);
    const providerName = wide ? (session.provider === "claude" ? "CLAUDE" : "CODEX ") : (session.provider === "claude" ? "CLAUDE" : "CODEX");
    const providerColor = session.provider === "claude" ? THEME.claude : THEME.codex;
    const row = wide
      ? `${marker}   ${color(statusColor, symbol)} ${color(providerColor, providerName)}  ${fit(session.name, nameWidth)}  ${color(statusColor, fit(status, 11))}`
      : `${marker}   ${color(statusColor, symbol)} ${color(providerColor, providerName)} ${fit(session.name, nameWidth)} ${color(statusColor, fit(status, 8))}`;
    lines.push(active ? `${ESC}${THEME.selected}m${row}${RESET}` : row);
  }
  if (split) {
    const rightWidth = usableWidth - listWidth - 3;
    const right = previewLines(nodes[safeSelected]?.session, preview, rightWidth, visibleRows);
    const left = lines.splice(bodyStart);
    for (let row = 0; row < visibleRows; row++) {
      const content = left[row] ?? "";
      const padding = " ".repeat(Math.max(0, listWidth - widthOf(stripVTControlCharacters(content))));
      lines.push(`  ${content}${padding}${color(THEME.divider, " │ ")}${right[row] ?? ""}`);
    }
  }
  const helpLines = wide
    ? ["↑↓ 선택  Shift+↑↓ 순서  ←→ 접기  Enter 열기  Alt+Enter 재접속  / 검색  Tab 필터", "F2 이름 변경  Alt+N 새 세션  Alt+S 설정  Alt+Y Codex 실행  Alt+R 갱신  Alt+X 보관  Alt+Q 나가기"]
    : ["↑↓ 이동  Shift+↑↓ 순서  Enter 열기  Alt+Q 나가기", "Alt+Enter 재접속  / 검색  Tab 필터  F2 이름  Alt+N 새 세션", "Alt+S 설정  Alt+Y Codex 실행  Alt+R 갱신  Alt+X 보관"];
  while (lines.length < height - helpLines.length - 4) lines.push("");
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
    const composerHint = newTask.error
      ? `오류: ${safeText(newTask.error)}`
      : `${executionSummary}   Alt+S 설정   Tab → ${alternateProvider} 전환   ←→ 커서   Enter 생성   Esc 취소   Ctrl+U 지우기`;
    lines.push(`  ${color(newTask.error ? THEME.error : providerColor, fit(composerHint, usableWidth))}`);
    lines.push(`  ${editorLine(newTask.prompt, newTask.cursor, usableWidth)}`);
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
    if (warnings.length) lines.push(`  ${color(THEME.warning, fit(`경고: ${safeText(warnings[0].provider)} · ${safeText(warnings[0].message)}`, usableWidth))}`);
    else lines.push(`  ${color(THEME.muted, fit(notice || "세션 상태는 자동으로 새로고침됩니다.", usableWidth))}`);
    for (const help of helpLines) lines.push(`  ${color(THEME.muted, fit(help, usableWidth))}`);
    lines.push(`  ${color(THEME.muted, fit(nativeHint, usableWidth))}`);
    if (query) lines.push(`  ${color(THEME.cursor, fit(`검색: ${query}`, usableWidth))}`);
    else lines.push("");
  }
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
  let warnings = [];
  let missingSessionCounts = new Map();
  let providerUsage = {};
  let orderWarning = null;
  let orderByWorkspace = new Map();
  if (orderStore) {
    try { orderByWorkspace = orderStore.load(); }
    catch (error) { orderWarning = { provider: "waga", message: error.message }; }
  }
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
  let newTask = null;
  let renameTask = null;
  let provider = null;
  let refreshing = false;
  let refreshQueued = false;
  let refreshGeneration = 0;
  let notice = "세션을 불러오는 중입니다.";
  let closed = false;
  let busy = false;
  let nativeOpen = false;
  let settingsPanel = null;
  let pendingArchiveId = null;
  let pendingCreated = null;
  const archivedSessionIds = new Set();
  const previewReader = new SessionPreview({
    read: (session, options) => bridge.preview(session, options),
    visible: async () => !closed && !busy && !nativeOpen && (!workspace.shouldRefreshOverview || await workspace.shouldRefreshOverview()),
    changed: () => render(),
    debounceMs: previewDebounceMs,
    cacheMs: previewCacheMs,
  });

  const visibleSessions = () => selectOverviewSessions(allSessions, { query, provider });
  const visibleNodes = () => buildOverviewTree(visibleSessions(), { collapsed, query, rootCwd: defaultCwd });
  const reconcileSelection = (nodes) => {
    const keyedIndex = selectedKey === null ? -1 : nodes.findIndex((node) => node.key === selectedKey);
    selected = keyedIndex >= 0 ? keyedIndex : Math.max(0, Math.min(selected, Math.max(0, nodes.length - 1)));
    selectedKey = nodes[selected]?.key ?? null;
  };
  const selectFirstSession = () => {
    const nodes = visibleNodes();
    const sessionIndex = nodes.findIndex((node) => node.type === "session");
    selected = sessionIndex >= 0 ? sessionIndex : 0;
    selectedKey = nodes[selected]?.key ?? null;
  };
  const render = () => {
    if (closed || nativeOpen) return;
    const sessions = visibleSessions();
    const nodes = buildOverviewTree(sessions, { collapsed, query, rootCwd: defaultCwd });
    reconcileSelection(nodes);
    const previewSession = hasOverviewPreview(outputStream.columns || 100, outputStream.rows || 30) && !busy && !newTask && !renameTask
      ? nodes[selected]?.session : null;
    previewReader.select(typeof bridge.preview === "function" ? previewSession : null);
    outputStream.write(`${ESC}H${ESC}J${buildOverviewFrame({
      sessions,
      nodes,
      collapsed,
      selected,
      width: outputStream.columns || 100,
      height: outputStream.rows || 30,
      query,
      warnings: [
        ...(settingsWarning ? [settingsWarning] : []),
        ...(orderWarning ? [orderWarning] : []),
        ...warnings,
      ],
      provider,
      providerUsage,
      notice,
      newTask,
      renameTask,
      rootCwd: defaultCwd,
      nativeHint,
      codexExecutionMode,
      providerSettings,
      settingsPanel,
      preview: previewReader.snapshot(previewSession),
    })}`);
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
    const selected = typeof bridge.route === "function" ? bridge.route(draft.provider, draft.prompt, { cwd: draft.cwd }) : null;
    return selected ?? fallbackRouting({ provider: draft.provider, cwd: draft.cwd });
  };

  const refreshNewTaskRouting = () => {
    if (newTask) newTask = { ...newTask, routing: routeNewTask(newTask) };
  };

  const refresh = async ({ whileBusy = false, force = false } = {}) => {
    if (closed || (busy && !whileBusy)) return;
    if (refreshing) {
      if (force) { refreshQueued = true; refreshGeneration++; }
      return;
    }
    refreshing = true;
    const generation = ++refreshGeneration;
    let renderAfter = false;
    try {
      if (!force && workspace.shouldRefreshOverview && !await workspace.shouldRefreshOverview()) return;
      renderAfter = true;
      const discovered = await bridge.discover(filterCwd ? { cwd: path.resolve(filterCwd), includeUsage: true } : { includeUsage: true });
      if (closed || nativeOpen || generation !== refreshGeneration) return;
      const snapshot = reconcileDiscoveredSessions(
        allSessions.filter((session) => !archivedSessionIds.has(session.id)),
        { ...discovered, sessions: discovered.sessions.filter((session) => !archivedSessionIds.has(session.id)) },
        missingSessionCounts,
      );
      missingSessionCounts = snapshot.missingCounts;
      const activeSessions = snapshot.sessions;
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
      warnings = reconcileWarning ? [reconcileWarning, ...discovered.warnings] : discovered.warnings;
      notice = `마지막 갱신 ${new Date().toLocaleTimeString()}`;
    } catch (error) {
      warnings = [{ provider: "waga", message: error.message }];
    } finally {
      refreshing = false;
      if (!closed && renderAfter) render();
      if (refreshQueued && !closed) {
        refreshQueued = false;
        void refresh({ force: true, whileBusy: true });
      }
    }
  };

  outputStream.write(`${ESC}?1049h${ESC}?25l${ESC}2J`);
  readline.emitKeypressEvents(inputStream, { escapeCodeTimeout: ESCAPE_CODE_TIMEOUT_MS });
  inputStream.setRawMode(true);
  inputStream.resume();

  const leave = () => {
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
        ? "Codex 새 세션을 YOLO로 켰습니다. 승인과 샌드박스 제한이 해제됩니다. Alt+Y로 끌 수 있습니다."
        : "Codex 새 세션을 기본 실행 모드로 되돌렸습니다.";
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
    const draft = { ...newTask, prompt, cursor: Math.min(newTask.cursor, graphemes(prompt).length), submitting: true, error: "", routing: routeNewTask({ ...newTask, prompt }) };
    newTask = draft;
    busy = true;
    render();
    void (async () => {
      let created;
      try {
        const createOptions = { cwd: draft.cwd };
        if (settingsStore) createOptions.executionSettings = structuredClone(providerSettings[draft.provider]);
        if (draft.provider === "codex") createOptions.executionMode = codexExecutionMode;
        created = await bridge.create(draft.provider, draft.prompt, createOptions);
        if (closed) return;
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
    if (pendingArchiveId !== target.id) {
      pendingArchiveId = target.id;
      notice = target.provider === "claude"
        ? `${target.name}: Agent View 작업과 worktree를 정리하고 transcript는 보존합니다. Alt+X를 다시 누르면 실행합니다.`
        : `${target.name}: 로그를 archived_sessions로 옮겨 보존합니다. Alt+X를 다시 누르면 실행합니다.`;
      render();
      return;
    }

    pendingArchiveId = null;
    busy = true;
    notice = `${target.name} 세션을 보관하는 중입니다.`;
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
        notice = `${target.name} 세션을 보관했습니다. 대화 로그는 유지됩니다.`;
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
        renameTask = null;
        selectedKey = draft.session.id;
        await refresh({ whileBusy: true, force: true });
        notice = `세션 이름을 '${draft.name}'(으)로 변경했습니다.`;
        if (result.nameSync === "pending") notice += " Claude에는 다음 프롬프트에서 반영 요청됩니다.";
        else if (result.nameSync === "local") notice += " Waga 로컬 이름만 변경했습니다.";
      } catch (error) {
        renameTask = { ...draft, submitting: false, error: error.message };
      } finally {
        busy = false;
        if (!closed) render();
      }
    })();
  };

  const openSession = (target, { force = false } = {}) => {
    busy = true;
    notice = force ? `${target.name} 세션에 다시 연결하는 중입니다.` : `${target.name} 세션을 여는 중입니다.`;
    render();
    nativeOpen = true;
    void Promise.resolve().then(() => commandFor(target))
      .then((command) => {
        if (!closed) return workspace.focusOrOpen(target, command, {
          force, knownNativeIds: allSessions.filter((session) => session.provider === "codex").map((session) => session.nativeId),
        });
      })
      .catch((error) => { warnings = [{ provider: target.provider, message: error.message }]; })
      .finally(() => { busy = false; nativeOpen = false; render(); });
  };

  const onKeypress = (text, key = {}) => {
    if (busy || closed) return;
    pendingCreated = null; // A later discovery must not steal selection after the user navigates.
    if ((key.ctrl && key.name === "c") || (key.meta && key.name === "q")) {
      leave();
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
      const cells = graphemes(newTask.prompt);
      if (key.name === "escape") newTask = null;
      else if (key.name === "tab") newTask = { ...newTask, provider: newTask.provider === "claude" ? "codex" : "claude", error: "" };
      else if (key.name === "return") { submitNewTask(); return; }
      else if (key.name === "left") newTask.cursor = Math.max(0, newTask.cursor - 1);
      else if (key.name === "right") newTask.cursor = Math.min(cells.length, newTask.cursor + 1);
      else if (key.name === "home") newTask.cursor = 0;
      else if (key.name === "end") newTask.cursor = cells.length;
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
      refreshNewTaskRouting();
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
    if (key.meta && key.name === "x" && nodes[selected]?.type === "session") {
      archiveSession(nodes[selected].session);
      return;
    }
    if (key.meta && key.name === "return" && nodes[selected]?.type === "session") {
      openSession(nodes[selected].session, { force: true });
      return;
    }
    if (key.name === "f2" && nodes[selected]?.type === "session") {
      renameTask = { session: nodes[selected].session, name: "", cursor: 0, error: "", submitting: false };
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
          const liveIds = allSessions.filter((session) => sessionWorkspace(session) === target.cwd).map((session) => session.id);
          try { orderStore.saveWorkspace(target.cwd, liveIds); orderWarning = null; }
          catch (error) { orderWarning = { provider: "waga", message: error.message }; }
        }
      }
      render();
      return;
    }
    if (key.name === "up") selected = Math.max(0, selected - 1);
    else if (key.name === "down") selected = Math.min(Math.max(0, nodes.length - 1), selected + 1);
    else if (key.name === "tab") {
      provider = provider === null ? "claude" : provider === "claude" ? "codex" : null;
      selected = 0;
      selectedKey = null;
      selectFirstSession();
    }
    else if (key.sequence === "/") searching = true;
    else if (key.meta && key.name === "n") {
      const node = nodes[selected];
      newTask = {
        provider: node?.type === "session" ? node.session.provider : provider ?? "claude",
        cwd: path.resolve(node?.cwd ?? filterCwd ?? defaultCwd),
        prompt: "",
        cursor: 0,
        error: "",
        submitting: false,
        routing: null,
      };
      refreshNewTaskRouting();
    }
    else if (key.meta && key.name === "r") { notice = "새로고침 중입니다."; render(); void refresh({ force: true }); return; }
    else if (key.name === "left" && nodes[selected]?.type === "workspace") collapsed.add(nodes[selected].cwd);
    else if (key.name === "left" && nodes[selected]?.type === "session") {
      const parentIndex = nodes.findIndex((node) => node.key === nodes[selected].workspaceKey);
      if (parentIndex >= 0) selected = parentIndex;
    }
    else if (key.name === "right" && nodes[selected]?.type === "workspace") collapsed.delete(nodes[selected].cwd);
    else if (key.name === "return" && nodes[selected]?.type === "workspace") {
      const cwd = nodes[selected].cwd;
      if (collapsed.has(cwd)) collapsed.delete(cwd);
      else collapsed.add(cwd);
    }
    else if (key.name === "return" && nodes[selected]?.type === "session") {
      openSession(nodes[selected].session);
      return;
    }
    selectedKey = visibleNodes()[selected]?.key ?? null;
    render();
  };

  const onResize = () => render();
  inputStream.on("keypress", onKeypress);
  outputStream.on("resize", onResize);
  const timer = setInterval(() => void refresh(), refreshMs);
  let resolveRun;
  const completed = new Promise((resolve) => { resolveRun = resolve; });
  const cleanup = () => {
    if (closed) return;
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
    outputStream.write(`${ESC}?25h${ESC}?1049l`);
    resolveRun(0);
  };
  if (listenForSignals) {
    process.once("SIGTERM", cleanup);
    process.once("SIGHUP", cleanup);
  }
  inputStream.once("end", cleanup);
  inputStream.once("close", cleanup);
  void refresh({ force: true });
  return await completed;
}

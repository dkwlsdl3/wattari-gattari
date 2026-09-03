import path from "node:path";
import readline from "node:readline";

import { nativeSessionCommand } from "./native-launcher.mjs";
import { TmuxWorkspace } from "./tmux-workspace.mjs";

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const color = (code, text) => `${ESC}${code}m${text}${RESET}`;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const DUBEOLSIK_COMMAND_KEYS = new Map([
  ["ㅗ", "h"],
  ["ㅓ", "j"],
  ["ㅏ", "k"],
  ["ㅣ", "l"],
  ["ㄱ", "r"],
  ["ㅂ", "q"],
]);

function dockCommandName(text, key) {
  return key.name ?? DUBEOLSIK_COMMAND_KEYS.get(text) ?? DUBEOLSIK_COMMAND_KEYS.get(key.sequence);
}

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

function statusPriority(status) {
  if (status === "needs-input" || status === "error") return 0;
  if (status === "working") return 1;
  if (status === "idle") return 2;
  return 3;
}

function compareOverviewSessions(left, right) {
  return statusPriority(left.status) - statusPriority(right.status)
    || Number(right.updatedAt ?? 0) - Number(left.updatedAt ?? 0)
    || left.id.localeCompare(right.id);
}

export function selectOverviewSessions(sessions, { query = "", provider = null, limit = 40 } = {}) {
  const needle = query.trim().toLocaleLowerCase();
  return [...sessions]
    .filter((session) => !provider || session.provider === provider)
    .filter((session) => !needle || `${session.name} ${session.cwd} ${session.projectCwd ?? ""} ${session.id}`.toLocaleLowerCase().includes(needle))
    .sort(compareOverviewSessions)
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
    for (const session of [...workspaceSessions].sort(compareOverviewSessions)) {
      nodes.push({ type: "session", key: session.id, workspaceKey, cwd, session });
    }
  }
  return nodes;
}

function statusView(status) {
  if (status === "needs-input") return ["!", "needs input", "38;5;203"];
  if (status === "working") return ["●", "working", "38;5;114"];
  if (status === "error") return ["!", "error", "38;5;203"];
  if (status === "idle") return ["○", "ready", "38;5;117"];
  return ["·", safeText(status || "unknown"), "38;5;245"];
}

function counts(sessions) {
  const count = (status) => sessions.filter((session) => session.status === status).length;
  return `${count("needs-input")} need input   ${count("working")} working   ${count("idle")} ready`;
}

export function buildOverviewFrame({ sessions, collapsed = new Set(), query = "", nodes = buildOverviewTree(sessions, { collapsed, query }), selected = 0, width = 100, height = 30, warnings = [], provider = null, notice = "", nativeHint = "네이티브 TUI: tmux prefix + 0 → overview" }) {
  const usableWidth = Math.max(1, width - 4);
  const visibleRows = Math.max(1, height - 9);
  const safeSelected = Math.max(0, Math.min(selected, Math.max(0, nodes.length - 1)));
  const offset = Math.max(0, Math.min(safeSelected - Math.floor(visibleRows / 2), Math.max(0, nodes.length - visibleRows)));
  const wide = usableWidth >= 64;
  const nameWidth = wide ? Math.max(12, usableWidth - 31) : Math.max(1, usableWidth - 21);
  const lines = [];
  const title = wide ? "WATTARI GATTARI  Claude + Codex session dock" : "WAGA · session dock";
  lines.push(`  ${color("1;38;5;117", fit(title, usableWidth))}`);
  lines.push(`  ${color("38;5;245", fit(`${counts(sessions)}${provider ? `   filter: ${provider}` : ""}`, usableWidth))}`);
  lines.push(`  ${color("38;5;238", "─".repeat(Math.max(1, usableWidth)))}`);

  if (!sessions.length) lines.push(`  ${color("38;5;245", query ? "검색 결과가 없습니다." : "발견된 세션이 없습니다. r을 눌러 새로고침하세요.")}`);
  for (let index = offset; index < Math.min(nodes.length, offset + visibleRows); index += 1) {
    const node = nodes[index];
    const active = index === safeSelected;
    const marker = active ? color("1;38;5;229", "›") : " ";
    if (node.type === "workspace") {
      const toggle = collapsed.has(node.cwd) && !query ? "▸" : "▾";
      const detail = wide ? `  ${node.cwd}  ·  ${node.sessionCount} session${node.sessionCount === 1 ? "" : "s"}` : `  ${node.sessionCount}`;
      const row = `${marker} ${color("38;5;245", toggle)} ${color("1;38;5;252", fit(`${node.name}${detail}`, usableWidth - 4))}`;
      lines.push(active ? `${ESC}48;5;236m${row}${RESET}` : row);
      continue;
    }
    const session = node.session;
    const [symbol, status, statusColor] = statusView(session.status);
    const providerName = wide ? (session.provider === "claude" ? "CLAUDE" : "CODEX ") : (session.provider === "claude" ? "CLAUDE" : "CODEX");
    const providerColor = session.provider === "claude" ? "38;5;183" : "38;5;117";
    const row = wide
      ? `${marker}   ${color(statusColor, symbol)} ${color(providerColor, providerName)}  ${fit(session.name, nameWidth)}  ${color(statusColor, fit(status, 11))}`
      : `${marker}   ${color(statusColor, symbol)} ${color(providerColor, providerName)} ${fit(session.name, nameWidth)} ${color(statusColor, fit(status, 8))}`;
    lines.push(active ? `${ESC}48;5;236m${row}${RESET}` : row);
  }
  while (lines.length < height - 5) lines.push("");
  if (warnings.length) lines.push(`  ${color("38;5;214", fit(`경고: ${safeText(warnings[0].provider)} · ${safeText(warnings[0].message)}`, usableWidth))}`);
  else lines.push(`  ${color("38;5;245", fit(notice || "세션 상태는 자동으로 새로고침됩니다.", usableWidth))}`);
  lines.push(`  ${color("38;5;245", fit(wide ? "↑↓ 이동   ←→ 접기/펼치기   Enter 열기/접기   / 검색   Tab 제공자   r/ㄱ 새로고침   q/ㅂ 돌아가기" : "↑↓ 이동  Enter 열기/접기  / 검색  q/ㅂ 복귀", usableWidth))}`);
  lines.push(`  ${color("38;5;114", fit(nativeHint, usableWidth))}`);
  if (query) lines.push(`  ${color("38;5;229", fit(`검색: ${query}`, usableWidth))}`);
  else lines.push("");
  return lines.slice(0, height).join("\n");
}

export async function runOverview({
  filterCwd = null,
  bridge,
  workspace = new TmuxWorkspace(),
  commandFor = nativeSessionCommand,
  inputStream = process.stdin,
  outputStream = process.stdout,
  errorOutput = process.stderr,
  refreshMs = 3_000,
  listenForSignals = true,
  nativeHint = "네이티브 TUI: tmux prefix + 0 → overview",
} = {}) {
  if (!inputStream.isTTY || !outputStream.isTTY) {
    errorOutput.write("Interactive overview requires a TTY; use `waga list` for text output\n");
    return 2;
  }

  let allSessions = [];
  let warnings = [];
  let selected = 0;
  let selectedKey = null;
  const collapsed = new Set();
  let query = "";
  let searching = false;
  let provider = null;
  let refreshing = false;
  let notice = "세션을 불러오는 중입니다.";
  let closed = false;
  let busy = false;

  const visibleSessions = () => selectOverviewSessions(allSessions, { query, provider });
  const visibleNodes = () => buildOverviewTree(visibleSessions(), { collapsed, query });
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
    const sessions = visibleSessions();
    const nodes = buildOverviewTree(sessions, { collapsed, query });
    reconcileSelection(nodes);
    outputStream.write(`${ESC}H${ESC}J${buildOverviewFrame({
      sessions,
      nodes,
      collapsed,
      selected,
      width: outputStream.columns || 100,
      height: outputStream.rows || 30,
      query,
      warnings,
      provider,
      notice,
      nativeHint,
    })}`);
  };

  const refresh = async () => {
    if (refreshing || closed || busy) return;
    refreshing = true;
    try {
      const discovered = await bridge.discover(filterCwd ? { cwd: path.resolve(filterCwd) } : {});
      allSessions = discovered.sessions;
      warnings = discovered.warnings;
      notice = `마지막 갱신 ${new Date().toLocaleTimeString()}`;
    } catch (error) {
      warnings = [{ provider: "waga", message: error.message }];
    } finally {
      refreshing = false;
      if (!closed) render();
    }
  };

  outputStream.write(`${ESC}?1049h${ESC}?25l${ESC}2J`);
  readline.emitKeypressEvents(inputStream);
  inputStream.setRawMode(true);
  inputStream.resume();

  const onKeypress = (text, key = {}) => {
    if (busy || closed) return;
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
    const commandName = dockCommandName(text, key);
    if (commandName === "up" || commandName === "k") selected = Math.max(0, selected - 1);
    else if (commandName === "down" || commandName === "j") selected = Math.min(Math.max(0, nodes.length - 1), selected + 1);
    else if (commandName === "tab") {
      provider = provider === null ? "claude" : provider === "claude" ? "codex" : null;
      selected = 0;
      selectedKey = null;
      selectFirstSession();
    }
    else if (key.sequence === "/") searching = true;
    else if (commandName === "r") { notice = "새로고침 중입니다."; render(); void refresh(); return; }
    else if (commandName === "q" || (key.ctrl && commandName === "c")) {
      busy = true;
      void workspace.leave()
        .then((result) => { if (result?.closeOverview) cleanup(); })
        .catch((error) => { warnings = [{ provider: "waga", message: error.message }]; render(); })
        .finally(() => { busy = false; });
      return;
    }
    else if ((commandName === "left" || commandName === "h") && nodes[selected]?.type === "workspace") collapsed.add(nodes[selected].cwd);
    else if ((commandName === "left" || commandName === "h") && nodes[selected]?.type === "session") {
      const parentIndex = nodes.findIndex((node) => node.key === nodes[selected].workspaceKey);
      if (parentIndex >= 0) selected = parentIndex;
    }
    else if ((commandName === "right" || commandName === "l") && nodes[selected]?.type === "workspace") collapsed.delete(nodes[selected].cwd);
    else if (commandName === "return" && nodes[selected]?.type === "workspace") {
      const cwd = nodes[selected].cwd;
      if (collapsed.has(cwd)) collapsed.delete(cwd);
      else collapsed.add(cwd);
    }
    else if (commandName === "return" && nodes[selected]?.type === "session") {
      busy = true;
      const target = nodes[selected].session;
      notice = `${target.name} 세션을 여는 중입니다.`;
      render();
      void commandFor(target)
        .then((command) => workspace.focusOrOpen(target, command))
        .catch((error) => { warnings = [{ provider: target.provider, message: error.message }]; })
        .finally(() => { busy = false; render(); });
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
    clearInterval(timer);
    inputStream.off("keypress", onKeypress);
    outputStream.off("resize", onResize);
    if (inputStream.isTTY) inputStream.setRawMode(false);
    outputStream.write(`${ESC}?25h${ESC}?1049l`);
    resolveRun(0);
  };
  if (listenForSignals) {
    process.once("SIGTERM", cleanup);
    process.once("SIGHUP", cleanup);
  }
  inputStream.once("end", cleanup);
  await refresh();
  inputStream.once("close", cleanup);
  return await completed;
}

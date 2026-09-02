import path from "node:path";
import readline from "node:readline";

import { nativeSessionCommand } from "./native-launcher.mjs";
import { TmuxWorkspace } from "./tmux-workspace.mjs";

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const color = (code, text) => `${ESC}${code}m${text}${RESET}`;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

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

export function selectOverviewSessions(sessions, { query = "", provider = null, limit = 40 } = {}) {
  const needle = query.trim().toLocaleLowerCase();
  return [...sessions]
    .filter((session) => !provider || session.provider === provider)
    .filter((session) => !needle || `${session.name} ${session.cwd} ${session.id}`.toLocaleLowerCase().includes(needle))
    .sort((left, right) => statusPriority(left.status) - statusPriority(right.status) || Number(right.updatedAt ?? 0) - Number(left.updatedAt ?? 0) || left.id.localeCompare(right.id))
    .slice(0, limit);
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

export function buildOverviewFrame({ sessions, selected = 0, width = 100, height = 30, query = "", warnings = [], provider = null, notice = "" }) {
  const usableWidth = Math.max(1, width - 4);
  const visibleRows = Math.max(1, height - 9);
  const safeSelected = Math.max(0, Math.min(selected, Math.max(0, sessions.length - 1)));
  const offset = Math.max(0, Math.min(safeSelected - Math.floor(visibleRows / 2), Math.max(0, sessions.length - visibleRows)));
  const wide = usableWidth >= 64;
  const nameWidth = wide ? Math.max(12, Math.floor(usableWidth * 0.42)) : Math.max(1, usableWidth - 19);
  const cwdWidth = wide ? Math.max(8, usableWidth - nameWidth - 29) : 0;
  const lines = [];
  const title = wide ? "WATTARI GATTARI  Claude + Codex session dock" : "WAGA · session dock";
  lines.push(`  ${color("1;38;5;117", fit(title, usableWidth))}`);
  lines.push(`  ${color("38;5;245", fit(`${counts(sessions)}${provider ? `   filter: ${provider}` : ""}`, usableWidth))}`);
  lines.push(`  ${color("38;5;238", "─".repeat(Math.max(1, usableWidth)))}`);

  if (!sessions.length) lines.push(`  ${color("38;5;245", query ? "검색 결과가 없습니다." : "발견된 세션이 없습니다. r을 눌러 새로고침하세요.")}`);
  for (let index = offset; index < Math.min(sessions.length, offset + visibleRows); index += 1) {
    const session = sessions[index];
    const active = index === safeSelected;
    const [symbol, status, statusColor] = statusView(session.status);
    const providerName = wide ? (session.provider === "claude" ? "CLAUDE" : "CODEX ") : (session.provider === "claude" ? "CLAUDE" : "CODEX");
    const marker = active ? color("1;38;5;229", "›") : " ";
    const providerColor = session.provider === "claude" ? "38;5;183" : "38;5;117";
    const row = wide
      ? `${marker} ${color(statusColor, symbol)} ${color(providerColor, providerName)}  ${fit(session.name, nameWidth)}  ${fit(path.basename(session.cwd || "/"), cwdWidth)}  ${color(statusColor, fit(status, 11))}`
      : `${marker} ${color(statusColor, symbol)} ${color(providerColor, providerName)} ${fit(session.name, nameWidth)} ${color(statusColor, fit(status, 8))}`;
    lines.push(active ? `${ESC}48;5;236m${row}${RESET}` : row);
  }
  while (lines.length < height - 5) lines.push("");
  if (warnings.length) lines.push(`  ${color("38;5;214", fit(`경고: ${safeText(warnings[0].provider)} · ${safeText(warnings[0].message)}`, usableWidth))}`);
  else lines.push(`  ${color("38;5;245", fit(notice || "세션 상태는 자동으로 새로고침됩니다.", usableWidth))}`);
  lines.push(`  ${color("38;5;245", fit(wide ? "↑↓ 이동   Enter 열기   / 검색   Tab 제공자   r 새로고침   q 돌아가기" : "↑↓ 이동  Enter 열기  / 검색  q 복귀", usableWidth))}`);
  lines.push(`  ${color("38;5;114", fit("네이티브 TUI: tmux prefix + 0 → overview", usableWidth))}`);
  if (query) lines.push(`  ${color("38;5;229", fit(`검색: ${query}`, usableWidth))}`);
  else lines.push("");
  return lines.slice(0, height).join("\n");
}

export async function runOverview({
  cwd = process.cwd(),
  bridge,
  workspace = new TmuxWorkspace(),
  commandFor = nativeSessionCommand,
  inputStream = process.stdin,
  outputStream = process.stdout,
  errorOutput = process.stderr,
  refreshMs = 3_000,
  listenForSignals = true,
} = {}) {
  if (!inputStream.isTTY || !outputStream.isTTY) {
    errorOutput.write("Interactive overview requires a TTY; use `waga list` for text output\n");
    return 2;
  }

  let allSessions = [];
  let warnings = [];
  let selected = 0;
  let selectedId = null;
  let query = "";
  let searching = false;
  let provider = null;
  let refreshing = false;
  let notice = "세션을 불러오는 중입니다.";
  let closed = false;

  const visible = () => selectOverviewSessions(allSessions, { query, provider });
  const render = () => {
    const sessions = visible();
    selected = Math.max(0, Math.min(selected, Math.max(0, sessions.length - 1)));
    outputStream.write(`${ESC}H${buildOverviewFrame({
      sessions,
      selected,
      width: outputStream.columns || 100,
      height: outputStream.rows || 30,
      query,
      warnings,
      provider,
      notice,
    })}${ESC}J`);
  };

  const refresh = async () => {
    if (refreshing || closed) return;
    refreshing = true;
    const before = visible()[selected]?.id ?? selectedId;
    try {
      const discovered = await bridge.discover({ cwd: path.resolve(cwd) });
      allSessions = discovered.sessions;
      warnings = discovered.warnings;
      const sessions = visible();
      selected = Math.max(0, sessions.findIndex((session) => session.id === before));
      selectedId = sessions[selected]?.id ?? null;
      notice = `마지막 갱신 ${new Date().toLocaleTimeString()}`;
    } catch (error) {
      warnings = [{ provider: "waga", message: error.message }];
    } finally {
      refreshing = false;
      render();
    }
  };

  outputStream.write(`${ESC}?1049h${ESC}?25l${ESC}2J`);
  readline.emitKeypressEvents(inputStream);
  inputStream.setRawMode(true);
  inputStream.resume();

  let busy = false;
  const onKeypress = (_text, key = {}) => {
    if (busy || closed) return;
    if (searching) {
      if (key.name === "escape") { searching = false; query = ""; }
      else if (key.name === "return") searching = false;
      else if (key.name === "backspace") query = [...query].slice(0, -1).join("");
      else if (key.ctrl && key.name === "u") query = "";
      else if (key.sequence && !key.ctrl && !key.meta && key.sequence >= " ") query += key.sequence;
      selected = 0;
      render();
      return;
    }
    const sessions = visible();
    if (key.name === "up" || key.name === "k") selected = sessions.length ? (selected - 1 + sessions.length) % sessions.length : 0;
    else if (key.name === "down" || key.name === "j") selected = sessions.length ? (selected + 1) % sessions.length : 0;
    else if (key.name === "tab") { provider = provider === null ? "claude" : provider === "claude" ? "codex" : null; selected = 0; }
    else if (key.sequence === "/") searching = true;
    else if (key.name === "r") { notice = "새로고침 중입니다."; render(); void refresh(); return; }
    else if (key.name === "q" || (key.ctrl && key.name === "c")) {
      busy = true;
      void workspace.leave()
        .catch((error) => { warnings = [{ provider: "tmux", message: error.message }]; render(); })
        .finally(() => { busy = false; });
      return;
    }
    else if (key.name === "return" && sessions[selected]) {
      busy = true;
      const target = sessions[selected];
      notice = `${target.name} 세션을 여는 중입니다.`;
      render();
      void commandFor(target)
        .then((command) => workspace.focusOrOpen(target, command))
        .catch((error) => { warnings = [{ provider: target.provider, message: error.message }]; })
        .finally(() => { busy = false; render(); });
      return;
    }
    selectedId = visible()[selected]?.id ?? null;
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

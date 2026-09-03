import path from "node:path";
import readline from "node:readline";

import { nativeSessionCommand } from "./native-launcher.mjs";
import { TmuxWorkspace } from "./tmux-workspace.mjs";

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const ESCAPE_CODE_TIMEOUT_MS = 25;
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

export function buildOverviewFrame({ sessions, collapsed = new Set(), query = "", rootCwd = null, nodes = buildOverviewTree(sessions, { collapsed, query, rootCwd }), selected = 0, width = 100, height = 30, warnings = [], provider = null, notice = "", newTask = null, nativeHint = "네이티브 TUI: tmux prefix + 0 → overview" }) {
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

  if (!sessions.length) lines.push(`  ${color("38;5;245", query ? "검색 결과가 없습니다." : "발견된 세션이 없습니다. Ctrl+R을 눌러 새로고침하세요.")}`);
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
  if (newTask) {
    const providerName = newTask.provider === "claude" ? "CLAUDE" : "CODEX";
    const heading = newTask.error
      ? color("38;5;203", fit(`오류: ${safeText(newTask.error)}`, usableWidth))
      : color("1;38;5;117", fit(`새 세션 · ${providerName} · ${newTask.cwd}${newTask.submitting ? " · 생성 중" : ""}`, usableWidth));
    lines.push(`  ${heading}`);
    lines.push(`  ${color("38;5;245", fit("Tab 제공자 전환   ←→ 커서   Enter 생성   Esc 취소   Ctrl+U 지우기", usableWidth))}`);
    lines.push(`  ${editorLine(newTask.prompt, newTask.cursor, usableWidth)}`);
    lines.push("");
  } else {
    if (warnings.length) lines.push(`  ${color("38;5;214", fit(`경고: ${safeText(warnings[0].provider)} · ${safeText(warnings[0].message)}`, usableWidth))}`);
    else lines.push(`  ${color("38;5;245", fit(notice || "세션 상태는 자동으로 새로고침됩니다.", usableWidth))}`);
    lines.push(`  ${color("38;5;245", fit(wide ? "↑↓ 이동  ←→ 접기  Enter 열기  / 검색  Tab 필터  Ctrl+N 새 세션  Ctrl+R 갱신  Ctrl+Q 나가기" : "Ctrl+N 새 세션  Ctrl+Q 나가기", usableWidth))}`);
    lines.push(`  ${color("38;5;114", fit(nativeHint, usableWidth))}`);
    if (query) lines.push(`  ${color("38;5;229", fit(`검색: ${query}`, usableWidth))}`);
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
  let newTask = null;
  let provider = null;
  let refreshing = false;
  let notice = "세션을 불러오는 중입니다.";
  let closed = false;
  let busy = false;

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
    const sessions = visibleSessions();
    const nodes = buildOverviewTree(sessions, { collapsed, query, rootCwd: defaultCwd });
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
      newTask,
      rootCwd: defaultCwd,
      nativeHint,
    })}`);
  };

  const refresh = async ({ whileBusy = false } = {}) => {
    if (refreshing || closed || (busy && !whileBusy)) return;
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

  const submitNewTask = () => {
    const prompt = newTask.prompt.trim();
    if (!prompt) {
      newTask.error = "프롬프트를 입력하세요.";
      render();
      return;
    }
    const draft = { ...newTask, prompt, cursor: Math.min(newTask.cursor, graphemes(prompt).length), submitting: true, error: "" };
    newTask = draft;
    busy = true;
    render();
    void (async () => {
      try {
        const created = await bridge.create(draft.provider, draft.prompt, { cwd: draft.cwd });
        newTask = null;
        notice = `${draft.provider === "claude" ? "Claude" : "Codex"} 새 세션을 생성했습니다.`;
        await refresh({ whileBusy: true });
        const session = allSessions.find((candidate) => candidate.provider === created.provider && candidate.nativeId === created.nativeId);
        if (session) selectedKey = session.id;
      } catch (error) {
        newTask = { ...draft, submitting: false, error: error.message };
      } finally {
        busy = false;
        if (!closed) render();
      }
    })();
  };

  const onKeypress = (text, key = {}) => {
    if (busy || closed) return;
    if (key.ctrl && (key.name === "q" || key.name === "c")) {
      leave();
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
    if (key.name === "up") selected = Math.max(0, selected - 1);
    else if (key.name === "down") selected = Math.min(Math.max(0, nodes.length - 1), selected + 1);
    else if (key.name === "tab") {
      provider = provider === null ? "claude" : provider === "claude" ? "codex" : null;
      selected = 0;
      selectedKey = null;
      selectFirstSession();
    }
    else if (key.sequence === "/") searching = true;
    else if (key.ctrl && key.name === "n") {
      const node = nodes[selected];
      newTask = {
        provider: node?.type === "session" ? node.session.provider : provider ?? "claude",
        cwd: path.resolve(node?.cwd ?? filterCwd ?? defaultCwd),
        prompt: "",
        cursor: 0,
        error: "",
        submitting: false,
      };
    }
    else if (key.ctrl && key.name === "r") { notice = "새로고침 중입니다."; render(); void refresh(); return; }
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

#!/usr/bin/env node

import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { appPaths } from "./app-paths.mjs";
import { ensureWagaDaemon } from "./waga-background.mjs";
import { ControlClient } from "./control-client.mjs";
import { NativeSessionLauncher } from "./native-session-launcher.mjs";
import { DISPLAY_NAME } from "./product.mjs";
import { sessionTree, preserveCursor } from "./session-tree.mjs";
import { shutdownDialogDecision, stopDialogDecision } from "./session-console-keys.mjs";

const CSI = "\x1b[";
const reset = `${CSI}0m`;
const clear = `${CSI}2J${CSI}H`;
const cursorShow = `${CSI}?25h`;
const cursorHide = `${CSI}?25l`;
const blue = (text) => `${CSI}38;2;130;170;255m${text}${reset}`;
const yellow = (text) => `${CSI}38;2;255;203;107m${text}${reset}`;
const red = (text) => `${CSI}38;2;255;83;112m${text}${reset}`;
const dim = (text) => `${CSI}38;2;139;148;176m${text}${reset}`;
const bold = (text) => `${CSI}1m${text}${reset}`;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function safeText(value, limit = 400) {
  return String(value ?? "").replaceAll(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").slice(0, limit);
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

function graphemes(value) {
  return [...graphemeSegmenter.segment(value)].map(({ segment }) => segment);
}

function graphemeWidth(value) {
  if (/\p{Extended_Pictographic}/u.test(value) || /^\p{Regional_Indicator}{2}$/u.test(value)) return 2;
  return [...value].reduce((width, character) => width + cellWidth(character), 0);
}

function fit(value, width) {
  const text = safeText(value);
  let rendered = "";
  let used = 0;
  for (const grapheme of graphemes(text)) {
    const size = graphemeWidth(grapheme);
    if (used + size > width) break;
    rendered += grapheme;
    used += size;
  }
  if (rendered !== text && width > 0) {
    while (used > width - 1 && rendered) {
      const parts = graphemes(rendered);
      used -= graphemeWidth(parts.pop());
      rendered = parts.join("");
    }
    rendered += "…";
    used += 1;
  }
  return `${rendered}${" ".repeat(Math.max(0, width - used))}`;
}

function statusColor(status, width) {
  const padded = fit(status, width);
  if (status === "Working") return blue(padded);
  if (status === "Needs input" || status === "Error") return red(padded);
  if (status === "Completed") return yellow(padded);
  return padded;
}

function workspaceFor(node, fallback) {
  return node?.workspacePath ?? fallback;
}

export async function runSessionConsole({
  paths = appPaths(),
  ensureDaemon = ensureWagaDaemon,
  createClient = (socketPath) => new ControlClient(socketPath),
  launchNative = null,
  inputStream = process.stdin,
  outputStream = process.stdout,
  workspacePath = process.cwd(),
  listenForSignals = true,
} = {}) {
  const launcher = launchNative ? null : new NativeSessionLauncher({ codexSocketPath: paths.socketPath });
  const nativeLauncher = launchNative ?? launcher.launch.bind(launcher);
  const client = createClient(paths.controlSocketPath);
  let state = { revision: 0, workspaces: [] };
  let cursor = 0;
  let collapsed = new Set();
  let provider = "codex";
  let dialog = null;
  let renameInput = "";
  let notice = "세션 허브에 연결 중";
  let launching = false;
  let closed = false;
  let resolveRun;

  const nodes = () => sessionTree(state, collapsed);
  const focusedNode = () => nodes()[cursor] ?? null;

  function helpLine() {
    if (dialog?.kind === "rename") return "Enter rename · Esc cancel";
    if (dialog?.kind === "stop") return "Ctrl+X confirm · any other key cancel";
    if (dialog?.kind === "shutdown") return "Ctrl+Q confirm · any other key cancel";
    const focused = focusedNode();
    if (focused?.type === "session") {
      return "Enter open native TUI · N new · Tab provider · F2 rename · F3 complete · Shift+↑/↓ reorder · Ctrl+X stop · Ctrl+C detach";
    }
    return "Enter collapse/expand · N new native TUI · Tab provider · Ctrl+X stop all · Ctrl+C detach · Ctrl+Q stop service";
  }

  function renderDialog(lines) {
    if (dialog?.kind === "rename") {
      lines.push("", yellow(`새 이름: ${renameInput || "_"}`), dim("Enter rename · Esc cancel"));
    } else if (dialog?.kind === "stop") {
      lines.push("", red(dialog.message), dim("Ctrl+X confirm · any other key cancel"));
    } else if (dialog?.kind === "shutdown") {
      lines.push("", red("Waga 서비스와 관리 App Server를 종료합니다."), dim("Ctrl+Q confirm · any other key cancel"));
    }
  }

  function render() {
    if (launching || closed) return;
    const width = Math.max(40, outputStream.columns ?? 100);
    const allSessions = state.workspaces.flatMap((workspace) => workspace.sessions);
    const counts = new Map();
    for (const session of allSessions) counts.set(session.status, (counts.get(session.status) ?? 0) + 1);
    const summary = allSessions.length
      ? [...counts].map(([status, count]) => `${count} ${status.toLowerCase()}`).join(" · ")
      : "0 sessions";
    const lines = [
      `${bold(DISPLAY_NAME)}  ${blue("codex")} + ${yellow("claude")}  ${dim(`session wrapper · revision ${state.revision}`)}`,
      dim(`${state.workspaces.length} projects · ${summary}`),
      "",
    ];
    const focusedKey = focusedNode()?.key;
    for (const workspace of state.workspaces) {
      const folded = collapsed.has(workspace.path);
      lines.push(`${focusedKey === `workspace:${workspace.path}` ? "›" : " "} ${folded ? "▸" : "▾"} ${bold(workspace.name)} ${dim(`${workspace.sessions.length} sessions · ${workspace.path}`)}`);
      if (folded) continue;
      if (!workspace.sessions.length) lines.push(dim("      아직 세션이 없습니다."));
      for (const session of workspace.sessions) {
        const marker = focusedKey === session.id ? "›" : " ";
        const accent = session.provider === "claude" ? yellow("C") : blue("X");
        const nameWidth = Math.min(46, Math.max(18, Math.floor(width * 0.38)));
        lines.push(`${marker}  ${accent} ${fit(session.name, nameWidth)} ${statusColor(session.status, 24)} ${dim(safeText(session.lastActivity, 120))}`);
      }
      lines.push("");
    }
    lines.push(dim(`new session: ${provider === "codex" ? "Codex" : "Claude"} native TUI (Tab to switch)`));
    lines.push(dim(helpLine()));
    if (notice) lines.push("", yellow(notice));
    renderDialog(lines);
    outputStream.write(`${clear}${lines.join("\n")}${cursorHide}`);
  }

  function applyState(nextState) {
    const previousKey = focusedNode()?.key;
    state = nextState ?? state;
    cursor = preserveCursor(nodes(), previousKey, cursor);
    render();
  }

  async function refresh() {
    applyState(await client.request("workspace/register", { path: workspacePath }));
  }

  function suspendTerminal() {
    inputStream.off("keypress", onKeypress);
    inputStream.setRawMode?.(false);
    inputStream.pause?.();
    outputStream.write(`${reset}${cursorShow}\n`);
  }

  function resumeTerminal() {
    if (closed) return;
    inputStream.on("keypress", onKeypress);
    inputStream.setRawMode?.(true);
    inputStream.resume?.();
  }

  async function handoff(target) {
    if (launching) return;
    launching = true;
    notice = "";
    suspendTerminal();
    try {
      const result = await nativeLauncher(target);
      if (result.exitCode && result.exitCode !== 0) {
        notice = `native TUI가 종료 코드 ${result.exitCode}로 끝났습니다`;
      } else if (result.signal) {
        notice = `native TUI가 ${result.signal} 신호로 끝났습니다`;
      }
    } catch (error) {
      notice = error.message;
    } finally {
      launching = false;
      resumeTerminal();
      try {
        await refresh();
      } catch (error) {
        notice = `세션 목록 갱신 실패: ${error.message}`;
        render();
      }
    }
  }

  async function openFocused() {
    const focused = focusedNode();
    if (focused?.type === "workspace") {
      const next = new Set(collapsed);
      if (next.has(focused.workspacePath)) next.delete(focused.workspacePath);
      else next.add(focused.workspacePath);
      collapsed = next;
      cursor = preserveCursor(nodes(), focused.key, cursor);
      render();
      return;
    }
    if (focused?.type === "session") await handoff({ action: "open", session: focused.session });
  }

  async function createNativeSession() {
    const cwd = workspaceFor(focusedNode(), workspacePath);
    await handoff({ action: "new", provider, cwd });
  }

  async function toggleCompleted() {
    const focused = focusedNode();
    if (focused?.type !== "session") return;
    try {
      await client.request("session/setCompleted", {
        workspacePath: focused.workspacePath,
        sessionId: focused.session.id,
        completed: focused.session.status !== "Completed",
      });
    } catch (error) {
      notice = error.message;
      render();
    }
  }

  async function reorder(direction) {
    const focused = focusedNode();
    if (focused?.type !== "session") return;
    try {
      await client.request("session/reorder", {
        workspacePath: focused.workspacePath,
        sessionId: focused.session.id,
        direction,
      });
    } catch (error) {
      notice = error.message;
      render();
    }
  }

  async function saveRename() {
    const target = dialog?.node;
    const name = renameInput.trim();
    dialog = null;
    renameInput = "";
    if (!target || !name) { render(); return; }
    try {
      await client.request("session/rename", {
        workspacePath: target.workspacePath,
        threadId: target.session.threadId,
        name,
      });
      notice = `세션 이름을 '${name}'(으)로 변경했습니다`;
    } catch (error) {
      notice = error.message;
    }
    render();
  }

  async function confirmStop() {
    const target = dialog?.node;
    dialog = null;
    try {
      if (target?.type === "session") {
        await client.request("session/stop", { workspacePath: target.workspacePath, threadId: target.session.threadId });
        notice = "세션을 종료했습니다";
      } else if (target?.type === "workspace") {
        const result = await client.request("workspace/stopAll", { path: target.workspacePath });
        notice = `${result.stopped?.length ?? 0}개 세션을 종료했습니다`;
      }
    } catch (error) {
      notice = error.message;
    }
    render();
  }

  function cleanup(exitCode = 0) {
    if (closed) return;
    closed = true;
    inputStream.off("keypress", onKeypress);
    client.off?.("state", applyState);
    outputStream.off?.("resize", onResize);
    inputStream.setRawMode?.(false);
    inputStream.pause?.();
    outputStream.write(`${reset}${cursorShow}\n`);
    client.close();
    if (listenForSignals) process.off("SIGTERM", onSigterm);
    resolveRun?.({ exitCode });
  }

  function onResize() { render(); }
  function onSigterm() { cleanup(143); }

  const onKeypress = (text, key = {}) => {
    if (dialog?.kind === "rename") {
      if (key.name === "escape") { dialog = null; renameInput = ""; render(); }
      else if (key.name === "return") void saveRename();
      else if (key.name === "backspace") { renameInput = renameInput.slice(0, -1); render(); }
      else if (!key.ctrl && !key.meta && text) { renameInput = `${renameInput}${safeText(text, 80)}`.slice(0, 80); render(); }
      return;
    }
    if (dialog?.kind === "stop") {
      if (stopDialogDecision(key) === "confirm") void confirmStop();
      else { dialog = null; render(); }
      return;
    }
    if (dialog?.kind === "shutdown") {
      if (shutdownDialogDecision(key) === "confirm") {
        void client.request("daemon/shutdown").finally(() => cleanup(0));
      } else { dialog = null; render(); }
      return;
    }
    if (key.ctrl && key.name === "c") { cleanup(0); return; }
    if (key.ctrl && key.name === "q") {
      dialog = { kind: "shutdown" };
      render();
      return;
    }
    if (key.ctrl && key.name === "x") {
      const focused = focusedNode();
      if (!focused) return;
      const count = focused.type === "workspace" ? focused.workspace.sessions.length : 1;
      dialog = {
        kind: "stop",
        node: focused,
        message: focused.type === "workspace"
          ? `${focused.workspace.name}의 ${count}개 세션을 종료합니다.`
          : `'${focused.session.name}' 세션을 종료합니다.`,
      };
      render();
      return;
    }
    if (key.name === "up" && key.shift) { void reorder(-1); return; }
    if (key.name === "down" && key.shift) { void reorder(1); return; }
    if (key.name === "up") { cursor = Math.max(0, cursor - 1); render(); return; }
    if (key.name === "down") { cursor = Math.min(Math.max(0, nodes().length - 1), cursor + 1); render(); return; }
    if (key.name === "return" || key.name === "right") { void openFocused(); return; }
    if (key.name === "tab") { provider = provider === "codex" ? "claude" : "codex"; render(); return; }
    if (key.name === "n") { void createNativeSession(); return; }
    if (key.name === "f2" && focusedNode()?.type === "session") {
      dialog = { kind: "rename", node: focusedNode() };
      renameInput = "";
      render();
      return;
    }
    if (key.name === "f3") void toggleCompleted();
  };

  await ensureDaemon({ paths });
  await client.connect();
  client.on("state", applyState);
  client.on("disconnected", () => {
    notice = "백그라운드 서비스 연결이 종료됐습니다";
    render();
  });
  state = await client.request("workspace/register", { path: workspacePath });
  notice = "";
  readline.emitKeypressEvents(inputStream);
  inputStream.on("keypress", onKeypress);
  inputStream.setRawMode?.(true);
  inputStream.resume?.();
  outputStream.on?.("resize", onResize);
  if (listenForSignals) process.on("SIGTERM", onSigterm);
  render();

  return new Promise((resolve) => { resolveRun = resolve; });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { exitCode } = await runSessionConsole();
  process.exitCode = exitCode;
}

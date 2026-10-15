import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { retainedSessionName, shellCommand } from "./tmux-workspace.mjs";
import { retainedClaudeViewMatches } from "./providers/claude-view.mjs";
import { nativeQuestion } from "./web/native-question.mjs";
import { retainedCodexViewState } from "./providers/codex-view.mjs";

const exec = promisify(execFile);
const host = fileURLToPath(new URL("./native-session-host.mjs", import.meta.url));
const defaultSocket = `waga-${typeof process.getuid === "function" ? process.getuid() : "user"}`;

// Observe the dock's single frontend without attaching a tmux client. In particular,
// no browser viewport or resize can affect the provider's terminal dimensions.
export async function sharedNativeTerminal(spec, { target, observe = false, socketName,
  interval = 200, matchesClaude = retainedClaudeViewMatches } = {}) {
  const provider = target.split(":", 1)[0], nativeId = target.slice(provider.length + 1);
  if (!["claude", "codex"].includes(provider) || !nativeId) throw new Error("올바른 세션을 선택해 주세요.");
  const retained = retainedSessionName(target);
  // A dock launched inside tmux uses that server; an outside dock uses Waga's
  // named socket. Ask tmux itself rather than parsing its environment format.
  let prefix = socketName ? ["-L", socketName] : process.env.TMUX ? [] : ["-L", defaultSocket];
  if (!socketName && process.env.TMUX) {
    const exists = args => exec("tmux", [...args, "has-session", "-t", retained], { timeout: 2000 }).then(() => true, () => false);
    if (!await exists([]) && await exists(["-L", defaultSocket])) prefix = ["-L", defaultSocket];
  }
  const call = async (...args) => (await exec("tmux", [...prefix, ...args], {
    encoding: "utf8", timeout: 2000, maxBuffer: 1024 * 1024,
  })).stdout;
  async function locate() {
    try {
      const value = await call("list-panes", "-t", retained, "-F", "#{pane_id}\t#{pane_pid}\t#{pane_dead}\t#{@waga_session_id}");
      const rows = value.trimEnd().split("\n");
      if (rows.length !== 1) throw new Error("세션의 입력 화면을 확인할 수 없습니다.");
      const [pane, pid, dead, id] = rows[0].split("\t");
      if (!/^%\d+$/.test(pane) || !/^\d+$/.test(pid) || dead !== "0" || id !== target) throw new Error("세션의 입력 화면이 변경됐습니다. dock에서 연결을 확인해 주세요.");
      return { pane, pid };
    } catch (error) {
      // Only a missing retained session permits creation. Never replace a live,
      // dead, navigated, or incompletely initialized frontend on a failed check.
      const exists = await call("has-session", "-t", retained).then(() => true, () => false);
      if (exists) throw error;
      return null;
    }
  }
  let binding = await locate();
  if (!binding && observe) return null;
  if (!binding) {
    const command = shellCommand("env", ["WAGA_WAIT_FOR_VISIBLE=0", "CLAUDE_CODE_TMUX_TRUECOLOR=1",
      process.execPath, host, provider, target, "--", spec.command, ...spec.args]);
    // A unique retained name is also the dock's atomic admission point. Set the
    // identity in the same tmux queue, before another opener can use the pane.
    try {
      await call("new-session", "-d", "-s", retained, "-x", "120", "-y", "40", "-c", spec.cwd, command,
        ";", "set-window-option", "-t", retained, "@waga_session_id", target,
        ";", "set-window-option", "-t", retained, "@waga_provider", provider,
        ";", "set-window-option", "-t", retained, "@waga_project_cwd", spec.cwd,
        ";", "set-window-option", "-t", retained, "automatic-rename", "off");
    } catch (error) {
      // A concurrent dock/web opener may have won; use only its verified pane.
      if (!await locate()) throw error;
    }
    binding = await locate();
    if (!binding) throw new Error("세션 입력 화면을 열지 못했습니다.");
  }
  let stopped = false, timer, previous = "", onData = () => {}, onExit = () => {}, onSize = () => {};
  let writes = Promise.resolve();
  async function verify() {
    const current = await locate();
    if (!current || current.pane !== binding.pane || current.pid !== binding.pid) throw new Error("세션의 입력 화면이 변경됐습니다. 다시 선택해 주세요.");
    if (provider === "claude" && !await matchesClaude(binding.pid, spec)) throw new Error("Claude 입력 대상이 변경됐습니다. dock에서 세션을 다시 연결해 주세요.");
    if (provider === "codex") {
      const title = await call("display-message", "-p", "-t", binding.pane, "#{pane_title}");
      const frame = await call("capture-pane", "-p", "-t", binding.pane);
      if (retainedCodexViewState(nativeId, title, frame) !== "same") throw new Error("Codex 입력 대상을 확인할 수 없습니다. dock에서 세션을 다시 연결해 주세요.");
    }
  }
  async function poll() {
    try {
      const state = await call("display-message", "-p", "-t", binding.pane, "#{pane_pid}\t#{pane_dead}\t#{pane_width}\t#{pane_height}");
      const [pid, dead, width, height] = state.trim().split("\t");
      if (pid !== binding.pid || dead !== "0") throw new Error("세션 입력 화면이 종료됐습니다.");
      const cols = Number(width), rows = Number(height);
      const frame = await call("capture-pane", "-e", "-p", "-t", binding.pane);
      const key = `${cols}x${rows}\n${frame}`;
      if (!stopped && key !== previous) {
        previous = key; onSize({ cols, rows });
        // tmux supplies a complete ANSI screen, not a stream of model messages.
        onData(`\x1b[?2004h\x1b[0m\x1b[H\x1b[2J${frame.replace(/\n$/, "").replaceAll("\n", "\r\n")}`);
      }
    } catch (error) { if (!stopped) { stopped = true; onExit({ exitCode: 1, message: error.message }); } }
    if (!stopped) timer = setTimeout(poll, interval);
  }
  // Callback registration finishes before the first snapshot.
  timer = setTimeout(poll, 0);
  return {
    onData(callback) { onData = callback; }, onExit(callback) { onExit = callback; }, onSize(callback) { onSize = callback; },
    resize() {}, // Browser sizes are deliberately never forwarded to tmux.
    write(data, { question } = {}) {
      const operation = writes.then(async () => {
        if (stopped) throw new Error("세션 연결이 종료됐습니다.");
        await verify();
        if (question) {
          const frame = await call("capture-pane", "-p", "-t", binding.pane);
          if (nativeQuestion(frame.split("\n"), provider)?.signature !== question) throw new Error("승인 질문이 변경됐습니다. 현재 질문을 확인해 주세요.");
        }
        await call("send-keys", "-t", binding.pane, "-l", "--", data);
      });
      writes = operation.catch(() => {});
      return operation;
    },
    kill() { stopped = true; clearTimeout(timer); }, // Stop observation only; retain frontend and agent.
  };
}

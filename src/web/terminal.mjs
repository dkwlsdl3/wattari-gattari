import { Terminal } from "/xterm.mjs";
import { FitAddon } from "/xterm-fit.mjs";
import { nativeQuestion } from "./native-question.mjs";

// The native frontend is a transport, not a second chat screen.
export function initTerminal({ api, selected, onChange = () => {}, onActivity = () => {} }) {
  const host = document.querySelector("#terminal-screen"), fallback = document.querySelector("#native-fallback");
  const panel = document.querySelector("#session-question"), text = document.querySelector("#question-text"), choices = document.querySelector("#question-choices");
  const status = document.querySelector("#input-status");
  const live = document.querySelector("#live-output"), liveText = document.querySelector("#live-output-text");
  function update() {
    live.hidden = !terminal || (selected()?.status !== "working" && !/esc to interrupt/i.test(liveText.textContent)) || Boolean(question) || !liveText.textContent;
  }
  let socket, terminal, observer, generation = 0, target = "", connecting, resolveReady, rejectReady, readyTimer, screenTimer;
  let question = null, answered = "", connected = false;
  const notify = message => { status.textContent = message; onChange(); };
  const lines = () => Array.from({ length: terminal.rows }, (_, i) => terminal.buffer.active.getLine(terminal.buffer.active.viewportY + i)?.translateToString(true) ?? "");
  function release(error) {
    generation++; clearTimeout(readyTimer); clearTimeout(screenTimer); screenTimer = readyTimer = null;
    if (error) rejectReady?.(error);
    else resolveReady?.(false);
    rejectReady = resolveReady = null; connecting = null; connected = false;
    socket?.close(); socket = null; observer?.disconnect(); terminal?.dispose(); terminal = null;
    live.hidden = true; liveText.textContent = "";
    host.replaceChildren(); panel.hidden = true; fallback.hidden = true; question = null; answered = "";
  }
  function inspect(current, session, ws) {
    if (current !== generation || !terminal || ws.readyState !== WebSocket.OPEN) return;
    const screen = lines();
    // xterm supplies the rendered text; do not decode ANSI or infer task state.
    // Stop at the native composer so its prompt and footer do not become a second input UI.
    const prompt = screen.findLastIndex(line => /^[\s]*[›❯]/u.test(line));
    const output = (prompt < 0 ? screen : screen.slice(0, prompt)).join("\n").trim();
    const changed = liveText.textContent !== output;
    const atEnd = liveText.scrollHeight - liveText.scrollTop - liveText.clientHeight < 30;
    if (changed) liveText.textContent = output;
    const next = nativeQuestion(screen, session.provider);
    if (next?.signature !== question?.signature) {
      question = next; if (next) answered = ""; panel.hidden = !next;
      choices.replaceChildren();
      if (next) {
        text.textContent = next.text;
        const more = document.createElement("details"), summary = document.createElement("summary");
        summary.textContent = "다른 선택지"; more.append(summary);
        for (const choice of next.choices) {
          const button = document.createElement("button"); button.type = "button"; button.textContent = choice.label;
          button.addEventListener("click", () => {
            if (current !== generation || ws.readyState !== WebSocket.OPEN || answered === next.signature
              || nativeQuestion(lines(), session.provider)?.signature !== next.signature) return;
            answered = next.signature;
            for (const item of choices.querySelectorAll("button")) item.disabled = true;
            ws.send(JSON.stringify({ type: "input", data: `${choice.key}\r` }));
            notify("응답을 전달했습니다.");
          });
          if (choice === next.choices[0] || /^No\b/.test(choice.label)) choices.append(button);
          else more.append(button);
        }
        if (more.children.length > 1) choices.append(more);
      }
      notify(next ? "승인 요청에 응답해 주세요." : "");
    }
    // Unknown native questions remain operable inline, never guessed as Yes/No.
    fallback.hidden = Boolean(next) || Boolean(answered) || selected()?.status !== "needs-input";
    if (!connected && screen.some(line => /[›❯]/.test(line)) && !screen.some(line => line.includes("Resuming session…"))) {
      connected = true; clearTimeout(readyTimer); resolveReady?.(true); resolveReady = rejectReady = null;
      notify(next ? "승인 요청에 응답해 주세요." : "");
    }
    update();
    if (changed && atEnd) liveText.scrollTop = liveText.scrollHeight;
    onActivity();
  }
  async function open() {
    const session = selected(); if (!session) throw new Error("세션을 선택해 주세요.");
    if (target === session.id && connecting) return connecting;
    release(); target = session.id; const current = generation;
    connecting = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    // A selection may connect without an immediate send; retain handled rejection.
    connecting.catch(() => {});
    notify("세션 연결 중…");
    readyTimer = setTimeout(() => { if (current === generation) { const error = new Error("세션 연결 시간이 지났습니다. 메시지는 전송하지 않았습니다."); release(error); notify(error.message); } }, 20_000);
    void (async () => {
      try {
        const { ticket } = await api(`sessions/${encodeURIComponent(session.id)}/terminal`, {});
        if (current !== generation) return;
        terminal = new Terminal({ fontSize: 14, scrollback: 1000, screenReaderMode: true,
          theme: { background: "#11181d", foreground: "#e1e8ed" } });
        const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(host);
        const ws = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/terminal?ticket=${encodeURIComponent(ticket)}`);
        socket = ws;
        const send = value => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value)); };
        const resize = () => { if (current === generation && terminal) { fit.fit(); send({ type: "resize", cols: Math.max(20, Math.min(300, terminal.cols)), rows: Math.max(5, Math.min(120, terminal.rows)) }); } };
        terminal.onData(data => send({ type: "input", data }));
        ws.addEventListener("message", event => {
          if (current !== generation) return;
          const message = JSON.parse(event.data);
          if (message.type === "output") terminal.write(message.data, () => {
            if (current !== generation) return;
            if (!screenTimer) screenTimer = setTimeout(() => { screenTimer = null; inspect(current, session, ws); }, 60);
          });
          if (message.type === "ready") resize();
          if (message.type === "error") { release(new Error(message.message)); notify(message.message); }
        });
        ws.addEventListener("close", () => { if (current === generation) { const error = new Error("연결이 끊겼습니다. 다음 전송 때 다시 연결합니다."); release(error); notify(error.message); } });
        ws.addEventListener("error", () => { if (current === generation) notify("세션에 연결하지 못했습니다."); });
        observer = new ResizeObserver(resize); observer.observe(host);
      } catch (error) { if (current === generation) { release(error); notify(error.message); } }
    })();
    return connecting;
  }
  return { open, update, sync(id) { if (target && target !== id) { release(); target = ""; notify(""); } }, async sendText(value) {
    const id = selected()?.id;
    const ready = await open();
    if (!ready || id !== selected()?.id || !connected || socket?.readyState !== WebSocket.OPEN) throw new Error("세션 연결을 확인해 주세요. 메시지는 전송하지 않았습니다.");
    if (nativeQuestion(lines(), selected().provider)) throw new Error("대기 중인 질문에 먼저 응답해 주세요. 작성한 메시지는 보관했습니다.");
    terminal.paste(value); socket.send(JSON.stringify({ type: "input", data: "\r" }));
    notify(""); return true;
  } };
}

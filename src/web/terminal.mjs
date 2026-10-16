import { Terminal } from "/xterm.mjs";
import { nativeQuestion } from "./native-question.mjs";

// The native frontend is a transport, not a second chat screen.
export function initTerminal({ api, selected, onChange = () => {}, onActivity = () => {}, onProgress = () => {} }) {
  const host = document.querySelector("#terminal-screen"), fallback = document.querySelector("#native-fallback");
  const panel = document.querySelector("#session-question"), text = document.querySelector("#question-text"), choices = document.querySelector("#question-choices");
  const status = document.querySelector("#input-status");
  let socket, terminal, generation = 0, target = "", connecting, resolveReady, rejectReady, readyTimer, screenTimer;
  let observing = false, inputId = 0, lastInput = Promise.resolve(), pending = new Map();
  let question = null, answered = "", connected = false, progress = "";
  const setProgress = value => { if (value !== progress) { progress = value; onProgress(); } };
  const notify = message => { status.textContent = message; onChange(); };
  const lines = () => Array.from({ length: terminal.rows }, (_, i) => terminal.buffer.active.getLine(terminal.buffer.active.viewportY + i)?.translateToString(true) ?? "");
  function release(error) {
    generation++; clearTimeout(readyTimer); clearTimeout(screenTimer); screenTimer = readyTimer = null;
    if (error) rejectReady?.(error);
    else resolveReady?.(false);
    rejectReady = resolveReady = null; connecting = null; connected = false;
    socket?.close(); socket = null; terminal?.dispose(); terminal = null;
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(error ?? new Error("입력 연결이 종료됐습니다. 전송 여부를 확인해 주세요.")); }
    pending.clear(); lastInput = Promise.resolve();
    setProgress("");
    host.replaceChildren(); panel.hidden = true; fallback.hidden = true; question = null; answered = "";
  }
  function input(data, question, ws = socket, workId) {
    if (!ws || ws !== socket || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("세션 연결을 확인해 주세요."));
    const id = ++inputId;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("입력 전달 확인 시간이 지났습니다. 전송 여부를 확인해 주세요.")); }, 5000);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ type: "input", data, id, question, workId }));
    });
    result.catch(() => {});
    return result;
  }
  function inspect(current, session, ws) {
    if (current !== generation || !terminal || ws.readyState !== WebSocket.OPEN) return;
    const screen = lines();
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
            void input(`${choice.key}\r`, next.signature, ws).then(
              () => { if (current === generation) notify("응답을 전달했습니다."); },
              error => { if (current === generation) notify(error.message); });
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
    setProgress(next ? "" : nativeProgress(screen));
    onActivity();
  }
  async function open({ observe = false } = {}) {
    const session = selected(); if (!session) throw new Error("세션을 선택해 주세요.");
    if (target === session.id && connecting && (!observing || observe)) return connecting;
    release(); observing = observe; target = session.id; const current = generation;
    connecting = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    // A selection may connect without an immediate send; retain handled rejection.
    connecting.catch(() => {});
    if (!observe) notify("세션 연결 중…");
    readyTimer = setTimeout(() => { if (current === generation) { if (observe) { release(); return; } const error = new Error("세션 연결 시간이 지났습니다. 메시지는 전송하지 않았습니다."); release(error); notify(error.message); } }, 20_000);
    void (async () => {
      try {
        const { ticket } = await api(`sessions/${encodeURIComponent(session.id)}/terminal`, { observe });
        if (current !== generation) return;
        terminal = new Terminal({ fontSize: 14, scrollback: 1000, screenReaderMode: true,
          theme: { background: "#11181d", foreground: "#e1e8ed" } });
        terminal.open(host);
        const ws = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/terminal?ticket=${encodeURIComponent(ticket)}`);
        socket = ws;
        terminal.onData(data => { lastInput = lastInput.then(async () => {
          for (let start = 0; start < data.length; start += 8192) await input(data.slice(start, start + 8192), undefined, ws);
        }); void lastInput.catch(error => { if (current === generation) notify(error.message); }); });
        ws.addEventListener("message", event => {
          if (current !== generation) return;
          const message = JSON.parse(event.data);
          if (message.type === "output") terminal.write(message.data, () => {
            if (current !== generation) return;
            if (!screenTimer) screenTimer = setTimeout(() => { screenTimer = null; inspect(current, session, ws); }, 60);
          });
          if (message.type === "size") terminal.resize(message.cols, message.rows);
          if (message.type === "unavailable") { release(); return; }
          if (message.type === "input-result") {
            const request = pending.get(message.id);
            if (request) { clearTimeout(request.timer); pending.delete(message.id); request.resolve(); }
          }
          if (message.type === "error") { const silent = observing && pending.size === 0; release(silent ? undefined : new Error(message.message)); if (!silent) notify(message.message); }
        });
        ws.addEventListener("close", () => { if (current === generation) { const error = new Error("연결이 끊겼습니다. 다음 전송 때 다시 연결합니다."); const silent = observing && pending.size === 0; release(silent ? undefined : error); if (!silent) notify(error.message); } });
        ws.addEventListener("error", () => { if (current === generation && !observing) notify("세션에 연결하지 못했습니다."); });
      } catch (error) { if (current === generation) { const silent = observing; release(silent ? undefined : error); if (!silent) notify(error.message); } }
    })();
    return connecting;
  }
  return { open, disconnect: () => { release(); target = ""; }, observe: () => open({ observe: true }), progress: () => progress, sync(id) { if (target && target !== id) { release(); target = ""; notify(""); } }, async sendText(value, record) {
    const id = selected()?.id;
    const ready = await open();
    if (!ready || id !== selected()?.id || !connected || socket?.readyState !== WebSocket.OPEN) throw new Error("세션 연결을 확인해 주세요. 메시지는 전송하지 않았습니다.");
    if (nativeQuestion(lines(), selected().provider)) throw new Error("대기 중인 질문에 먼저 응답해 주세요. 작성한 메시지는 보관했습니다.");
    const ws = socket, current = generation;
    const work = record ? await record() : null;
    if (current !== generation || id !== selected()?.id) throw new Error("입력 대상이 변경됐습니다. 메시지는 전송하지 않았습니다.");
    if (nativeQuestion(lines(), selected().provider)) throw new Error("대기 중인 질문에 먼저 응답해 주세요. 작성한 메시지는 보관했습니다.");
    terminal.paste(work?.deliveryText ?? value); await lastInput;
    if (current !== generation || id !== selected()?.id) throw new Error("입력 대상이 변경됐습니다. 작성한 메시지와 이전 세션의 입력창을 확인해 주세요.");
    await input("\r", undefined, ws, work?.id);
    notify(""); return true;
  } };
}

// Extract only the native status row confirmed by the Codex screen fixture.
// Terminal content remains transport data, never an assistant message.
export function nativeProgress(screen) {
  const line = screen.findLast(line => /^\s*Working \(/.test(line) && line.includes("esc to interrupt"));
  if (!line) return "";
  return line.trim().replace(" • esc to interrupt", "").split(" · ").filter(part => !part.startsWith("/")).join(" · ").slice(0, 240);
}

import { Terminal } from "/xterm.mjs";
import { FitAddon } from "/xterm-fit.mjs";

export function initTerminal({ api, selected, onClose, onReady = () => {} }) {
  const dialog = document.querySelector("#terminal-dialog"), host = document.querySelector("#terminal-screen");
  const status = document.querySelector("#terminal-status"), keys = document.querySelector("#terminal-keys");
  let socket, terminal, observer, generation = 0, target = "", accepting = false;
  const ready = value => { if (accepting !== value) { accepting = value; onReady(value); } };
  function release() {
    generation++;
    ready(false);
    const previous = socket; socket = null;
    previous?.close(); observer?.disconnect(); terminal?.dispose(); terminal = null;
    host.replaceChildren(); keys.hidden = true;
  }
  async function open() {
    const session = selected(); if (!session) return;
    release(); const current = generation;
    target = session.id;
    document.querySelector("#terminal-title").textContent = session.name;
    status.textContent = "세션 연결 중…"; dialog.showModal();
    try {
      const { ticket } = await api(`sessions/${encodeURIComponent(session.id)}/terminal`, {});
      if (current !== generation) return;
      terminal = new Terminal({ cursorBlink: true, fontSize: 14, scrollback: 5000, screenReaderMode: true,
        theme: { background: "#11181d", foreground: "#e1e8ed", cursor: "#a9d6bf" } });
      const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(host);
      const ws = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/terminal?ticket=${encodeURIComponent(ticket)}`);
      socket = ws;
      const send = value => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value)); };
      const resize = () => {
        if (current !== generation || !terminal) return;
        fit.fit(); send({ type: "resize", cols: Math.max(20, Math.min(300, terminal.cols)), rows: Math.max(5, Math.min(120, terminal.rows)) });
      };
      terminal.onData(data => send({ type: "input", data }));
      ws.addEventListener("message", event => {
        if (current !== generation) return;
        const message = JSON.parse(event.data);
        if (message.type === "output") terminal.write(message.data, () => { if (current === generation && ws.readyState === WebSocket.OPEN) ready(true); });
        if (message.type === "ready") { status.textContent = "연결됨"; keys.hidden = false; resize(); terminal.focus(); }
        if (message.type === "error") status.textContent = message.message;
        if (message.type === "exit") status.textContent = `화면 연결 종료 (${message.exitCode})`;
      });
      ws.addEventListener("error", () => { if (current === generation) status.textContent = "연결하지 못했습니다. 다시 연결해 주세요."; });
      ws.addEventListener("close", () => { if (current === generation) { ready(false); keys.hidden = true; status.textContent = "연결 종료 · 다시 연결할 수 있습니다."; } });
      observer = new ResizeObserver(resize); observer.observe(host);
    } catch (error) { if (current === generation) status.textContent = error.message; }
  }
  keys.addEventListener("click", event => {
    const key = event.target.closest("button")?.dataset.key;
    if (key && socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "input", data: key })); terminal.focus();
    }
  });
  document.querySelector("#terminal-reconnect").addEventListener("click", open);
  document.querySelector("#terminal-close").addEventListener("click", () => dialog.close());
  // Escape belongs to the native prompt. Closing is always an explicit button.
  dialog.addEventListener("cancel", event => event.preventDefault());
  dialog.addEventListener("close", () => { release(); onClose(); });
  return { open, sync(id) { if (dialog.open && target !== id) dialog.close(); }, sendText(text) {
    if (!accepting || target !== selected()?.id || !terminal || socket?.readyState !== WebSocket.OPEN) return false;
    terminal.paste(text);
    socket.send(JSON.stringify({ type: "input", data: "\r" }));
    return true;
  } };
}

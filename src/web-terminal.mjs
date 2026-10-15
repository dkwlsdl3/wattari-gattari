import crypto from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { sharedNativeTerminal } from "./web-native-terminal.mjs";

// Share the retained native frontend without creating a second provider attachment.
// Input is deliberately opaque: native UI owns prompts, keys and decisions.
export function installWebTerminal(server, { authorize, connection, terminalFactory = sharedNativeTerminal, now = Date.now }) {
  const tickets = new Map(), sessions = new Map();
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024, perMessageDeflate: false });
  let closed = false;
  function ticket(target, { observe = false } = {}) {
    for (const [key, entry] of tickets) if (entry.expires <= now()) tickets.delete(key);
    if (closed || tickets.size >= 20) throw new Error("잠시 후 다시 연결해 주세요.");
    const key = crypto.randomBytes(32).toString("hex");
    tickets.set(key, { target, observe, expires: now() + 10_000 });
    return { ticket: key };
  }
  const upgrade = async (request, socket, head) => {
    let reserved;
    try {
      if (closed || !authorize(request)) throw new Error("인증한 웹 화면에서 연결해 주세요.");
      const url = new URL(request.url, "http://localhost");
      if (url.pathname !== "/api/terminal") throw new Error("없는 연결입니다.");
      const key = url.searchParams.get("ticket"), entry = tickets.get(key);
      tickets.delete(key);
      if (!entry || entry.expires <= now()) throw new Error("연결 시간이 지났습니다. 다시 열어 주세요.");
      if (sessions.has(entry.target) || sessions.size >= 2) throw new Error("이미 열린 조작 화면을 닫은 뒤 연결해 주세요.");
      // Reserve before discovery/daemon calls so parallel upgrades cannot race.
      sessions.set(entry.target, null);
      reserved = entry.target;
      let spec;
      try { spec = await connection(entry.target); }
      catch (error) { sessions.delete(entry.target); throw error; }
      if (closed || socket.destroyed) { sessions.delete(entry.target); socket.destroy(); return; }
      sockets.handleUpgrade(request, socket, head, async ws => {
        let terminal, ended = false;
        const cleanup = () => {
          if (ended) return;
          ended = true;
          sessions.delete(entry.target);
          try { terminal?.kill(); } catch { /* frontend already exited */ }
        };
        sessions.set(entry.target, () => { cleanup(); ws.close(1001, "웹 연결 종료"); });
        ws.on("error", cleanup);
        ws.on("close", cleanup);
        const send = value => {
          if (ws.readyState !== WebSocket.OPEN) return;
          if (ws.bufferedAmount > 1024 * 1024) { ws.close(1009, "화면 수신이 지연되어 연결을 닫았습니다."); cleanup(); return; }
          ws.send(JSON.stringify(value));
        };
        ws.on("message", async (raw, binary) => {
          try {
            if (binary) throw new Error("문자 입력만 지원합니다.");
            const value = JSON.parse(raw.toString("utf8"));
            if (value.type === "resize" && Number.isInteger(value.cols) && Number.isInteger(value.rows)
              && value.cols >= 20 && value.cols <= 300 && value.rows >= 5 && value.rows <= 120) terminal?.resize(value.cols, value.rows);
            else if (value.type === "input" && typeof value.data === "string" && value.data.length <= 16_384) {
              if (!terminal) throw new Error("입력 화면을 준비 중입니다.");
              await terminal.write(value.data, { question: value.question });
              send({ type: "input-result", id: value.id });
            }
            else throw new Error("잘못된 입력입니다.");
          } catch (error) { send({ type: "error", message: error.message }); ws.close(1008, "입력을 전달하지 못했습니다."); cleanup(); }
        });
        try {
          terminal = await terminalFactory(spec, { target: entry.target, observe: entry.observe });
          if (ended) { terminal?.kill(); return; }
          if (!terminal) { send({ type: "unavailable" }); cleanup(); ws.close(1000, "입력 화면 없음"); return; }
          terminal.onSize?.(size => send({ type: "size", ...size }));
          terminal.onData(data => send({ type: "output", data }));
          terminal.onExit(({ exitCode }) => { send({ type: "exit", exitCode }); cleanup(); ws.close(1000, "세션 화면 연결 종료"); });
          send({ type: "ready" });
        } catch (error) { send({ type: "error", message: error.message }); cleanup(); ws.close(1011, "연결 실패"); }
      });
    } catch (error) {
      if (reserved && sessions.get(reserved) === null) sessions.delete(reserved);
      if (!socket.destroyed) {
        const message = Buffer.from(error.message);
        socket.end(`HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: ${message.length}\r\n\r\n${message}`);
      }
    }
  };
  server.on("upgrade", upgrade);
  return { ticket, close() {
    closed = true; tickets.clear();
    for (const close of [...sessions.values()]) close?.();
    for (const ws of sockets.clients) ws.terminate();
    server.off("upgrade", upgrade); sockets.close();
  } };
}

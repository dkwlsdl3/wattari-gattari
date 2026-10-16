import fs from "node:fs";
import path from "node:path";

// Watch the directory so replacing/compacting the transcript doesn't lose updates.
export function watchHistoryFile(filename, { onChange, onError }) {
  if (!path.isAbsolute(filename ?? "")) throw new Error("실행 기록의 경로를 확인할 수 없습니다.");
  const watcher = fs.watch(path.dirname(filename), (event, name) => {
    if (!name || String(name) === path.basename(filename)) onChange();
  });
  watcher.on("error", onError);
  return () => watcher.close();
}

// Shared, bounded subscriptions: no per-browser transcript polling or extra model processes.
export function historyStreams(bridge, { onPage = () => {} } = {}) {
  const entries = new Map();
  return {
    async open(session, response) {
      const key = `${session.id}:${session.cwd}`;
      let entry = entries.get(key);
      if (!entry && entries.size >= 2) throw Object.assign(new Error("다른 대화의 실시간 연결을 닫아 주세요."), { status: 429 });
      if (entry && entry.responses.size + entry.waiters >= 10) throw Object.assign(new Error("실시간 연결이 너무 많습니다."), { status: 429 });
      if (!entry) {
        entry = { responses: new Set(), waiters: 0, stopped: false, timer: null, reading: false, dirty: false, value: null, stop: null };
        entries.set(key, entry);
        entry.close = () => {
          if (entry.stopped) return;
          entry.stopped = true; clearTimeout(entry.timer); clearInterval(entry.heartbeat);
          entry.stop?.(); entries.delete(key);
          for (const client of entry.responses) client.end();
          entry.responses.clear();
        };
        const send = (client, value) => {
          if (client.destroyed || client.writableLength > 1024 * 1024) { client.destroy(); return; }
          client.write(`data: ${JSON.stringify(value)}\n\n`);
        };
        entry.send = send;
        const changed = () => {
          entry.dirty = true;
          if (entry.stopped || entry.reading || entry.timer) return;
          entry.timer = setTimeout(async () => {
            entry.timer = null; entry.reading = true; entry.dirty = false;
            try {
              const value = await bridge.history(session, { activities: true });
              if (entry.stopped) return;
              onPage(session, value);
              entry.value = value;
              for (const client of entry.responses) send(client, value);
            } catch (error) {
              for (const client of entry.responses) send(client, { error: error.message });
              entry.close();
            } finally { entry.reading = false; if (entry.dirty) changed(); }
          }, 60);
        };
        entry.start = Promise.resolve().then(() => bridge.watchHistory(session, { onChange: changed, onError: () => entry.close() }))
          .then(stop => { entry.stop = stop; if (entry.stopped) stop(); })
          .catch(error => { entry.close(); throw error; });
        entry.heartbeat = setInterval(() => {
          for (const client of entry.responses) client.write(": keepalive\n\n");
        }, 15_000); entry.heartbeat.unref();
        entry.changed = changed;
      }
      entry.waiters++;
      try { await entry.start; } finally { entry.waiters--; }
      if (entry.stopped || response.destroyed) { if (!entry.responses.size) entry.close(); if (!response.destroyed) response.end(); return; }
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
      entry.responses.add(response);
      response.on("close", () => { entry.responses.delete(response); if (!entry.responses.size) entry.close(); });
      if (entry.value) entry.send(response, entry.value);
      else entry.changed();
    },
    close() { for (const entry of [...entries.values()]) entry.close(); },
  };
}

export function initHistoryStream({ onPage, onError, EventSourceClass = EventSource }) {
  let source, identity = "", live = false;
  const close = () => { source?.close(); source = null; identity = ""; live = false; };
  return {
    sync(session) {
      const next = session ? `${session.id}:${session.cwd}` : "";
      if (next === identity) return;
      close(); if (!session) return;
      identity = next;
      const current = new EventSourceClass(`/api/sessions/${encodeURIComponent(session.id)}/events`);
      source = current;
      current.onmessage = event => {
        if (source !== current) return;
        try {
          const page = JSON.parse(event.data);
          if (page.error) { live = false; onError(page.error); return; }
          if (!Array.isArray(page.messages)) return;
          live = true; onPage(next, page);
        } catch { live = false; onError("실시간 기록을 읽지 못했습니다."); }
      };
      current.onerror = () => { if (source === current) { live = false; onError("실시간 연결 재시도 중 · 대화 기록을 주기적으로 확인합니다."); } };
    },
    live: () => live,
    close,
  };
}

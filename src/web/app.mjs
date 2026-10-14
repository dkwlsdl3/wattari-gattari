const $ = selector => document.querySelector(selector);
const stateNames = { idle: "대기 중", working: "작업 중", "needs-input": "입력 대기", done: "완료", error: "오류",
  unavailable: "연결 불가", starting: "접수 중", "not-sent": "미전송", "waiting-local": "앞선 요청 대기", waiting: "전송 대기",
  submitting: "전송 중", submitted: "전송됨", accepted: "접수됨", "reply-received": "답변 수신", replied: "답변 완료",
  "result-unknown": "결과 미확정", created: "세션 생성됨", held: "보류", refused: "거부" };
let sessions = [], selected = null, provider = "all", refreshing = false, sending = false, ready = false;
let previewKey = "", refreshedAt = 0;
const openAnswers = new Set();
const label = value => stateNames[value] ?? value ?? "알 수 없음";
const name = id => sessions.find(row => row.id === id)?.name ?? id ?? "—";
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function notice(message = "") { $("#notice").textContent = message; $("#notice").hidden = !message; }
async function api(route, value) {
  const response = await fetch(`/api/${route}`, value === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message ?? `요청 실패 (${response.status})`);
  return result;
}
function select(id) {
  if (selected !== id) { previewKey = ""; $("#message").value = ""; $("#messages").replaceChildren(element("p", "대화를 불러오는 중입니다.", "empty")); }
  selected = id; renderSessions(); renderSelection(); void loadPreview();
}
function renderSessions() {
  const list = $("#sessions"), graph = $("#graph"); list.replaceChildren(); graph.replaceChildren();
  const search = $("#search").value.toLowerCase();
  const visible = sessions.filter(row => (provider === "all" || row.provider === provider)
    && `${row.name} ${row.cwd} ${row.id}`.toLowerCase().includes(search));
  for (const row of visible) {
    const button = element("button", undefined, `session${row.id === selected ? " selected" : ""}`);
    button.setAttribute("aria-pressed", String(row.id === selected));
    button.append(element("strong", row.name), element("small", row.cwd));
    const meta = element("div", undefined, "session-meta");
    meta.append(element("span", row.provider === "claude" ? "Claude" : "Codex", `provider-${row.provider}`), element("span", label(row.status)));
    button.append(meta); button.addEventListener("click", () => select(row.id)); list.append(button);
  }
  for (const groupProvider of ["claude", "codex"]) {
    const rows = visible.filter(row => row.provider === groupProvider);
    if (!rows.length) continue;
    const group = element("div", undefined, "graph-group");
    group.append(element("span", groupProvider === "claude" ? "Claude" : "Codex", `graph-provider provider-${groupProvider}`));
    const nodes = element("div", undefined, "graph-nodes");
    for (const row of rows) {
      const node = element("button", undefined, `node${row.id === selected ? " selected" : ""}`);
      node.setAttribute("aria-label", `${row.name} · ${label(row.status)}`); node.setAttribute("aria-pressed", String(row.id === selected));
      node.append(element("strong", row.name), element("small", label(row.status)));
      node.addEventListener("click", () => select(row.id)); nodes.append(node);
    }
    group.append(nodes); graph.append(group);
  }
  if (!visible.length) {
    list.append(element("p", "표시할 세션이 없습니다.", "empty")); graph.append(element("p", "연결된 세션이 없습니다.", "empty"));
  } else graph.append(element("p", "제공자별 세션 묶음입니다. 실제 요청 관계는 아래 타임라인에 표시합니다.", "graph-note"));
  $("#session-count").textContent = sessions.length; $("#total").textContent = sessions.length;
  $("#working").textContent = sessions.filter(row => row.status === "working").length;
  $("#waiting").textContent = sessions.filter(row => row.status === "needs-input").length;
}
function renderSelection() {
  const row = sessions.find(item => item.id === selected);
  $("#selected-name").textContent = row?.name ?? "세션을 선택해 주세요";
  $("#selected-provider").textContent = row?.provider === "claude" ? "Claude" : row ? "Codex" : "";
  $("#selected-path").textContent = row?.cwd ?? ""; $("#selected-status").textContent = row ? label(row.status) : "";
  $("#message").disabled = !row || sending; $("#send").disabled = !row || sending;
  if (!row) { previewKey = ""; $("#messages").replaceChildren(element("p", "목록이나 맵에서 세션을 선택해 주세요.", "empty")); }
}
async function loadPreview() {
  const id = selected;
  if (!id || !sessions.some(row => row.id === id)) return;
  try {
    const value = await api(`sessions/${encodeURIComponent(id)}/preview`);
    if (selected !== id) return;
    $("#preview-error")?.remove();
    const key = JSON.stringify([id, value.input, value.output, value.limited]);
    if (key === previewKey) return;
    previewKey = key;
    const messages = $("#messages"); messages.replaceChildren();
    for (const [title, text] of [["최근 입력", value.input], ["최근 응답", value.output]]) {
      if (!text) continue;
      const bubble = element("div", undefined, "bubble"); bubble.append(element("div", title, "bubble-label"), element("p", text)); messages.append(bubble);
    }
    if (!value.input && !value.output) messages.append(element("p", "아직 표시할 대화가 없습니다.", "empty"));
    messages.append(element("p", `최근 입력·응답 미리보기${value.limited ? " · 조회 범위 제한 있음" : ""}`, "preview-note"));
  } catch (error) {
    if (selected === id) {
      let errorNode = $("#preview-error");
      if (!errorNode) { errorNode = element("p", undefined, "preview-note"); errorNode.id = "preview-error"; $("#messages").append(errorNode); }
      errorNode.textContent = `대화 조회 실패: ${error.message}`;
    }
  }
}
function renderRequests({ records, jobs, limited }) {
  const timeline = $("#timeline"); timeline.replaceChildren();
  const relations = $("#relations"); relations.replaceChildren();
  for (const request of jobs.filter(row => row.kind === "query").slice(-8)) {
    const relation = element("div", undefined, "relation");
    relation.append(element("span", "브라우저", "relation-source"), element("span", "→", "relation-arrow"));
    const target = element("button", name(request.target), "relation-target");
    target.addEventListener("click", () => select(request.target));
    relation.append(target, element("span", label(request.state), "state")); relations.append(relation);
  }
  const covered = new Set(jobs.map(row => row.requestId).filter(Boolean));
  const rows = [...jobs.map(row => ({ ...row, browser: true, reply: row.result?.reply })),
    ...records.filter(row => !covered.has(row.requestId))].sort((a, b) => b.createdAt - a.createdAt);
  $("#request-count").textContent = `${rows.length}건${limited ? " · 최근 일부" : ""}`;
  for (const item of rows) {
    const row = element("div", undefined, "timeline-row");
    row.append(element("time", new Date(item.createdAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false }), "timeline-time"));
    const content = element("div", undefined, "timeline-content");
    content.append(element("strong", item.kind === "create" ? `브라우저 → ${item.provider} 새 세션` : `${item.browser ? "브라우저" : "출처 미기록"} → ${name(item.target)}`));
    const details = [label(item.state), item.error?.message, item.requestId ? `요청 ${item.requestId}` : null].filter(Boolean);
    content.append(element("p", details.join(" · ")));
    if (item.events?.length) content.append(element("p", item.events.map(event => event.message ?? label(event.state)).join(" → ")));
    if (item.reply !== undefined) {
      const key = item.operationId ?? item.requestId;
      const answer = element("details"); answer.open = openAnswers.has(key);
      answer.addEventListener("toggle", () => {
        if (!answer.isConnected) return;
        if (answer.open) openAnswers.add(key); else openAnswers.delete(key);
      });
      answer.append(element("summary", "답변 보기"), element("pre", item.reply)); content.append(answer);
    }
    row.append(content);
    if (item.kind === "create" && item.result?.session?.id) {
      const open = element("button", "세션 보기");
      open.addEventListener("click", () => select(item.result.session.id)); row.append(open);
    } else if (item.requestId && item.state !== "replied" && (!item.browser || item.finished)) {
      const recover = element("button", "결과 회수"); recover.addEventListener("click", async () => {
        recover.disabled = true;
        try { await api("recover", { operationId: crypto.randomUUID(), requestId: item.requestId }); await refresh(); }
        catch (error) { notice(error.message); recover.disabled = false; }
      }); row.append(recover);
    } else row.append(element("span", label(item.state), "state"));
    timeline.append(row);
  }
  if (!rows.length) timeline.append(element("p", "아직 요청이 없습니다. 선택한 세션에 첫 질의를 보내보세요.", "empty"));
}
async function refresh() {
  if (!ready || refreshing) return;
  refreshing = true;
  try {
    const value = await api("sessions"); sessions = value.sessions;
    $("#workspace-path").textContent = value.cwd; $("#create-cwd").textContent = `작업 폴더: ${value.cwd}`;
    if (selected && !sessions.some(row => row.id === selected)) selected = null;
    renderSessions(); renderSelection();
    renderRequests(await api("requests")); await loadPreview();
    refreshedAt = Date.now(); $("#connection").textContent = "로컬 연결됨";
    notice(value.warnings.map(row => `${row.provider}: ${row.message}`).join(" · "));
  } catch (error) {
    $("#connection").textContent = refreshedAt ? "갱신 실패 · 이전 상태 표시" : "연결 실패"; notice(error.message);
  } finally { refreshing = false; }
}
$("#search").addEventListener("input", renderSessions);
document.querySelectorAll("[data-provider]").forEach(button => button.addEventListener("click", () => {
  provider = button.dataset.provider;
  document.querySelectorAll("[data-provider]").forEach(item => { item.classList.toggle("active", item === button); item.setAttribute("aria-pressed", String(item === button)); });
  renderSessions();
}));
$("#refresh").addEventListener("click", refresh);
$("#query-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (sending || !selected || !$("#message").value.trim()) return;
  const target = selected, message = $("#message").value;
  sending = true; renderSelection();
  try {
    await api("query", { operationId: crypto.randomUUID(), target, message });
    if (selected === target) $("#message").value = "";
    await refresh();
  } catch (error) { notice(`${error.message} · 자동 재전송하지 않았습니다. 요청 타임라인을 확인해 주세요.`); }
  finally { sending = false; renderSelection(); }
});
$("#new-session").addEventListener("click", () => $("#create-dialog").showModal());
$("#close-dialog").addEventListener("click", () => $("#create-dialog").close());
$("#create-form").addEventListener("submit", async event => {
  event.preventDefault();
  const button = $("#create-submit"); if (button.disabled) return; button.disabled = true;
  try {
    await api("create", { operationId: crypto.randomUUID(), provider: $("#create-provider").value, message: $("#create-message").value });
    $("#create-message").value = ""; $("#create-dialog").close(); await refresh();
  } catch (error) { notice(`${error.message} · 자동 재전송하지 않았습니다. 타임라인을 확인해 주세요.`); }
  finally { button.disabled = false; }
});
async function start() {
  try {
    const token = location.hash.slice(1);
    history.replaceState(null, "", location.pathname);
    if (token) await api("auth", { token });
    ready = true; await refresh();
  } catch (error) { notice(error.message); $("#connection").textContent = "접속 링크 필요"; }
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) void refresh(); });
setInterval(() => { if (!document.hidden) void refresh(); }, 5_000);
void start();

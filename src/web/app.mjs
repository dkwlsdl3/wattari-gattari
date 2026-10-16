import Sortable from "/sortable.mjs";
import { initTerminal } from "./terminal.mjs";
import { DraftStore } from "./drafts.mjs";
import { initExecutions } from "./executions.mjs";
import { conversationItems, mergeMessages } from "./conversation.mjs";
import { initHistoryStream } from "./history-stream.mjs";
import { initWorks } from "./works.mjs";
const $ = selector => document.querySelector(selector);
const nativeStates = { idle: "대기 중", working: "작업 중", "needs-input": "입력 대기", done: "완료", error: "오류", unavailable: "연결 불가" };
const transport = { starting: "접수 중", "waiting-local": "앞선 요청 대기", waiting: "전송 대기", submitting: "전송 중", submitted: "답변 대기", accepted: "답변 대기", "reply-received": "답변 수신", replied: "답변 수신", error: "질의 실패", created: "세션 생성됨", "not-sent": "미전송", "result-unknown": "결과 미확정" };
let sessions = [], refreshing = false, ready = false;
let sending = false, activityTimer, streamWarning = "";
let directSessionId = "", composerRecipient = "", previewKey = "", previewIdentity = "", warning = "";
let browserStorage; try { browserStorage = localStorage; } catch { browserStorage = { getItem() {}, setItem() {} }; }
const histories = new Map(), sentMessages = new Map(), drafts = new DraftStore(browserStorage);
const operations = new Map(), directRequests = new Map();
let refreshExecutions = async () => {};
let followUpWork = null;
const works = initWorks({ api, selected: () => session(), changed: renderConversation, notice, followUp: row => {
  if (row.session.id !== session()?.id) return;
  followUpWork = row;
  $("#follow-up-instruction").hidden = false; $("#follow-up-title").textContent = `변경 지시: ${row.instruction.slice(0, 60)}`;
  $("#message").focus();
} });
let orderVersion = 0, dragging = false;
let sortables = [];
let filter = "all", moving = false, actionTarget = "", sidebarKey = "";
const collapsed = new Set(), scrollPositions = new Map();
try { directSessionId = browserStorage.getItem("waga:selected-session") || ""; } catch {}
function openControls() {
  const id = session()?.id;
  historyStream.sync(document.hidden ? null : session());
  void controls.observe().catch(error => { if (session()?.id === id) notice(error.message); });
}
function visibleSessions() {
  const needle = $("#session-search").value.trim().toLocaleLowerCase();
  return sessions.filter(row => (filter === "all" || row.status === filter) && `${row.name} ${row.workspace} ${row.provider}`.toLocaleLowerCase().includes(needle));
}
async function selectSession(id) {
  if (directSessionId === id) return;
  scrollPositions.set(previewIdentity, $("#messages").scrollTop);
  directSessionId = id;
  try { browserStorage.setItem("waga:selected-session", id); } catch {}
  document.body.classList.remove("sessions-open"); $("#toggle-sessions").setAttribute("aria-expanded", "false");
  notice(); render();
  openControls();
  await Promise.all([loadHistory(), works.refresh(), refreshExecutions().catch(error => notice(error.message))]);
}
async function moveSession(id, direction) {
  const selected = sessions.find(row => row.id === id); if (!selected) return;
  const visible = visibleSessions().filter(row => row.workspace === selected.workspace);
  const index = visible.findIndex(row => row.id === id), target = visible[index + (direction === "up" ? -1 : 1)];
  if (target) await placeSession(id, target.id, direction === "up" ? "before" : "after");
}
async function placeSession(id, targetId, position) {
  if (moving || dragging) return;
  const selected = sessions.find(row => row.id === id); if (!selected) return;
  const visibleIds = visibleSessions().filter(row => row.workspace === selected.workspace).map(row => row.id);
  if (!visibleIds.includes(targetId) || targetId === id) return;
  const previous = sessions;
  sessions = sessions.filter(row => row.id !== id);
  sessions.splice(sessions.findIndex(row => row.id === targetId) + (position === "after" ? 1 : 0), 0, selected);
  moving = true; orderVersion++; renderSidebar();
  try { const result = await api(`sessions/${encodeURIComponent(id)}/order`, { targetId, position, visibleIds }); sessions = result.sessions; }
  catch (error) { sessions = previous; notice(`순서 저장 실패: ${error.message}`); }
  finally { moving = false; renderSidebar(); }
}
function renderSidebar() {
  if (dragging) return;
  const rows = visibleSessions(), key = JSON.stringify([rows, directSessionId, moving, [...collapsed]]);
  if (key === sidebarKey) return; sidebarKey = key;
  const nav = $("#session-list"), groups = new Map();
  for (const row of rows) { if (!groups.has(row.workspace)) groups.set(row.workspace, []); groups.get(row.workspace).push(row); }
  const focused = document.activeElement?.dataset, focusId = focused?.sessionId, focusAction = focused?.action;
  const top = nav.scrollTop;
  for (const sortable of sortables) sortable.destroy(); sortables = [];
  nav.replaceChildren();
  for (const [workspace, items] of groups) {
    const group = el("section", undefined, "session-group"), heading = el("button", undefined, "project-heading");
    const closed = collapsed.has(workspace); heading.setAttribute("aria-expanded", String(!closed)); heading.title = workspace;
    heading.append(el("span", `${closed ? "▸" : "▾"} ${workspace.split("/").filter(Boolean).at(-1) || "/"}`), el("small", String(items.length)));
    heading.addEventListener("click", () => { if (closed) collapsed.delete(workspace); else collapsed.add(workspace); renderSidebar(); }); group.append(heading);
    const list = el("div", undefined, "session-rows"); group.append(list);
    if (!closed) items.forEach(row => {
      const line = el("div", undefined, `session-row${row.id === directSessionId ? " selected" : ""}`);
      line.dataset.id = row.id;
      const button = el("button", undefined, "session-choice"); button.dataset.sessionId = row.id; button.dataset.action = "select"; button.setAttribute("aria-current", String(row.id === directSessionId));
      button.title = `${row.name}
${row.cwd}`; button.append(el("span", row.name, "session-name"), el("small", `${row.provider === "claude" ? "Claude" : "Codex"} · ${nativeStates[row.status] ?? "상태 미확인"}`, `session-state state-${row.status}`));
      button.addEventListener("click", () => { void selectSession(row.id); }); line.append(button);
      list.append(line);
    });
    if (!closed) sortables.push(new Sortable(list, {
      group: { name: workspace, pull: false, put: false }, draggable: ".session-row", disabled: moving,
      animation: matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 150,
      delay: 200, delayOnTouchOnly: true, touchStartThreshold: 5,
      ghostClass: "session-placeholder", chosenClass: "session-chosen", dragClass: "session-dragging",
      onStart() { dragging = true; },
      onEnd(event) {
        dragging = false; sidebarKey = "";
        const point = event.originalEvent?.changedTouches?.[0] ?? event.originalEvent;
        const outside = point && Number.isFinite(point.clientX) && Number.isFinite(point.clientY)
          && document.elementFromPoint(point.clientX, point.clientY)?.closest(".session-group") !== group;
        const id = event.item.dataset.id;
        const next = event.item.nextElementSibling?.dataset.id, previous = event.item.previousElementSibling?.dataset.id;
        queueMicrotask(() => {
          if (outside || event.oldDraggableIndex === event.newDraggableIndex || (!next && !previous)) { renderSidebar(); return; }
          void placeSession(id, next || previous, next ? "before" : "after");
        });
      },
    }));
    nav.append(group);
  }
  if (!rows.length) nav.append(el("p", "조건에 맞는 세션이 없습니다.", "conversation-empty"));
  nav.scrollTop = top;
  if (focusId) [...nav.querySelectorAll("button[data-session-id]")].find(button => button.dataset.sessionId === focusId && button.dataset.action === focusAction)?.focus({ preventScroll: true });
}
const session = () => sessions.find(row => row.id === directSessionId);
const activeKey = () => `direct:${directSessionId}`;
const recipientKey = () => `${activeKey()}:${directSessionId || "unassigned"}`;
function resizeComposer() { const input = $("#message"); input.style.height = "auto"; input.style.height = `${Math.min(120, Math.max(50, input.scrollHeight))}px`; }
const pendingForSession = () => [...operations.values()].find(row => row.target && row.target === directSessionId) ?? operations.get(activeKey());
function el(tag, text, className) {
  const item = document.createElement(tag); if (text !== undefined) item.textContent = text; if (className) item.className = className; return item;
}
function notice(message = "") { $("#notice").textContent = message; $("#notice").hidden = !message; }
async function api(route, value) {
  const response = await fetch(`/api/${route}`, value === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
  const result = await response.json(); if (!response.ok) throw Object.assign(new Error(result.error?.message ?? `요청 실패 (${response.status})`), { status: response.status }); return result;
}
function render() { renderSidebar(); renderDetail(); }
function renderSessionStatus() {
  const selected = session(), status = $("#session-status");
  status.textContent = selected ? `${controls.progress() || nativeStates[selected.status] || "상태 미확인"} · ${selected.cwd}` : "";
  status.title = selected?.cwd ?? "";
}
function renderDetail() {
  controls.sync(directSessionId);
  historyStream.sync(ready && !document.hidden ? session() : null);
  if (composerRecipient !== recipientKey()) {
    followUpWork = null; $("#follow-up-instruction").hidden = true;
    if (composerRecipient) drafts.set(composerRecipient, $("#message").value);
    composerRecipient = recipientKey(); $("#message").value = drafts.get(composerRecipient) ?? "";
  }
  $("#message").disabled = !session();
  $("#send").disabled = !session() || sending || !$("#message").value.trim();
  resizeComposer();
  $("#detail").hidden = false; $("#node-title").textContent = session()?.name ?? "세션 대화";
  const selected = session();
  renderSessionStatus();
  const pending = pendingForSession();
  $("#connect-session").disabled = !selected; $("#rename-session").disabled = !selected; $("#archive-session").disabled = !selected || Boolean(pending) || selected.status === "working";
  renderConversation();
  const record = directRequests.get(directSessionId)?.at(-1), status = $("#operation-status"); status.replaceChildren();
  status.hidden = !pending && (!record || record.reply !== undefined || record.state === "created");
  if (pending) status.append(el("span", pending.kind === "create" ? "세션 생성 중…" : transport[pending.state] ?? "답변 대기 중…"));
  else if (!status.hidden) {
    status.append(el("span", record.error ?? "아직 답변을 확인하지 못했습니다."));
    if (record.requestId) {
      const recover = el("button", "답변 다시 확인"); recover.addEventListener("click", () => { void submitOperation("recover", { requestId: record.requestId, target: directSessionId }); }); status.append(recover);
    }
  }
}
function renderConversation() {
  if ($("#conversation-workspace").hidden) return;
  const selected = session(), messages = $("#messages");
  const identity = selected ? `${selected.id}:${selected.cwd}` : activeKey();
  const records = directRequests.get(directSessionId) ?? [];
  const history = histories.get(identity);
  const items = [...conversationItems({ history: history?.messages ?? [], records, inputs: sentMessages, pending: pendingForSession() }), ...works.items()];
  const key = JSON.stringify([identity, history?.nextCursor, history?.loading, items, works.rows()]); if (key === previewKey) return;
  const scrollTop = messages.scrollTop;
  const changed = identity !== previewIdentity;
  const follow = changed || messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80;
  previewIdentity = identity; previewKey = key;
  if (changed) messages.replaceChildren();
  const existing = new Map([...messages.children].map(node => [node.dataset.messageId, node]));
  const ordered = [];
  if (history?.nextCursor) {
    const older = existing.get("older") || el("button", undefined, "older-messages");
    older.dataset.messageId = "older"; older.textContent = history.loading ? "이전 대화 불러오는 중…" : "이전 대화 불러오기";
    older.disabled = history.loading; older.onclick = () => { void loadHistory(true); }; ordered.push(older);
  }
  for (const [index, item] of items.entries()) {
    const id = item.id || `${item.role}:${index}`;
    let bubble = existing.get(id);
    if (!bubble) {
      bubble = el("article", undefined, `bubble ${item.role}`); bubble.dataset.messageId = id;
      if (item.role === "activity") {
        const details = el("details"), summary = el("summary"), output = el("pre");
        details.append(summary, output); bubble.append(details);
      } else bubble.append(el("small", item.label), el("p", ""));
    }
    if (item.role === "activity") {
      const label = `${item.state === "running" ? "실행 중" : item.state === "error" ? "오류" : "완료"} · ${item.label} · ${item.text.slice(0, 160)}`;
      const summary = bubble.querySelector("summary"), output = bubble.querySelector("pre");
      if (summary.textContent !== label) summary.textContent = label;
      const body = `${item.text}${item.output ? `\n\n${item.output}` : ""}`;
      if (output.textContent !== body) output.textContent = body;
      bubble.dataset.state = item.state;
    } else if (bubble.querySelector("p").textContent !== item.text) bubble.querySelector("p").textContent = item.text;
    works.decorate(bubble, item); ordered.push(bubble);
  }
  if (!items.length) ordered.push(el("p", selected ? (history?.loading ? "대화 불러오는 중…" : "대화 기록이 없습니다.") : "세션을 선택하거나 새 세션을 만드세요.", "conversation-empty"));
  const retained = new Set(ordered);
  for (const child of [...messages.children]) if (!retained.has(child)) child.remove();
  for (const [index, node] of ordered.entries()) if (messages.children[index] !== node) messages.insertBefore(node, messages.children[index] || null);
  messages.scrollTop = changed && scrollPositions.has(identity) ? scrollPositions.get(identity) : follow ? messages.scrollHeight : scrollTop;
}
async function loadHistory(older = false) {
  const selected = session(), identity = selected ? `${selected.id}:${selected.cwd}` : "";
  if (!selected) return;
  const current = histories.get(identity) ?? { messages: [], nextCursor: null, loading: false };
  if (current.loading || (older && !current.nextCursor) || (!older && Date.now() - (current.lastReadAt ?? 0) < 750)) return;
  current.lastReadAt = Date.now();
  current.loading = true; histories.set(identity, current); if (!current.loaded || older) renderConversation();
  const revision = current.revision ?? 0;
  const container = $("#messages"), oldHeight = container.scrollHeight, oldTop = container.scrollTop;
  try {
    const page = await api(`sessions/${encodeURIComponent(selected.id)}/messages${older ? `?cursor=${encodeURIComponent(current.nextCursor)}` : ""}`);
    const latest = histories.get(identity) ?? current;
    const messages = older ? mergeMessages(page.messages, latest.messages) : latest.revision !== undefined && latest.revision !== revision ? latest.messages : mergeMessages(latest.messages, page.messages);
    histories.set(identity, { ...latest, messages, nextCursor: older || !latest.loaded ? page.nextCursor : latest.nextCursor, loaded: true, loading: false, lastReadAt: current.lastReadAt });
    if (histories.size > 20) histories.delete(histories.keys().next().value);
    if (session()?.id !== selected.id || session()?.cwd !== selected.cwd) return;
    renderConversation();
    if (older) container.scrollTop = oldTop + container.scrollHeight - oldHeight;
    if (page.skipped) notice("일부 로그 항목을 읽지 못했습니다.");
  } catch (error) { const latest = histories.get(identity); if (latest) latest.loading = false; if (session()?.id === selected.id) { notice(`대화 조회 실패: ${error.message}`); renderConversation(); } }
}

async function refresh() {
  if (!ready || refreshing) return; refreshing = true;
  try {
    const version = orderVersion, discovery = await api("sessions");
    if (version === orderVersion && !moving) sessions = discovery.sessions;
    const usage = $("#provider-usage"); usage.replaceChildren();
    for (const row of discovery.usage ?? []) {
      const item = el("span", row.label || `${row.provider === "claude" ? "Claude" : "Codex"} 사용량 미확인`);
      item.dataset.provider = row.provider;
      item.title = row.observedAt ? `마지막 조회: ${new Date(row.observedAt).toLocaleString()}` : "아직 사용량을 받지 못했습니다.";
      usage.append(item);
    }
    warning = discovery.warnings.map(row => `${row.provider}: ${row.message}`).join(" · ");
    for (const [key, operation] of operations) {
      let job;
      try { job = await api(`operations/${operation.operationId}`); }
      catch (error) { if (error.status !== 404) throw error; operations.delete(key); notice(error.message); continue; }
      if (job.storageError) notice(job.storageError);
      if (!job.workflowId) {
        const target = job.target ?? operation.target;
        if (job.kind === "create" && job.finished && job.target && key === activeKey()) directSessionId = job.target;
        if (target) {
          const records = directRequests.get(target) ?? [];
          directRequests.set(target, [...records.filter(row => row.operationId !== job.operationId), { operationId: job.operationId, requestId: job.requestId, sessionId: target, state: job.state, reply: job.result?.reply, turnId: job.result?.turnId, error: job.error?.message, at: job.createdAt }].slice(-100));
        }
      }
      if (job.finished) { operations.delete(key); if (job.error) notice(job.error.message); }
      else operations.set(key, job);
    }
    $("#create-cwd").textContent = "";
    const projectPicker = $("#create-workspace"), previousWorkspace = projectPicker.value;
    projectPicker.replaceChildren();
    for (const workspace of new Set([discovery.cwd, ...sessions.map(row => row.workspace)])) { const option = el("option", workspace); option.value = workspace; projectPicker.append(option); }
    projectPicker.value = [...projectPicker.options].some(option => option.value === previousWorkspace) ? previousWorkspace : discovery.cwd;
    if (!directSessionId && sessions.length) {
      directSessionId = sessions[0].id;
      try { browserStorage.setItem("waga:selected-session", directSessionId); } catch {}
    }
    render(); await loadHistory(); await works.refresh(); $("#connection").textContent = "연결됨";
    if (!document.hidden && session()) openControls();
    if (warning) notice(warning);
  } catch (error) { $("#connection").textContent = "갱신 실패"; notice(error.message); }
  finally { refreshing = false; }
}
async function submitOperation(kind, input) {
  const key = activeKey();
  if (pendingForSession()) return;
  const operationId = crypto.randomUUID(); operations.set(key, { operationId, kind, target: input.target, state: "starting" });
  if (kind === "instruct") sentMessages.set(operationId, input.message);
  while (sentMessages.size > 100) sentMessages.delete(sentMessages.keys().next().value);
  renderDetail();
  try {
    await api(kind, { ...input, operationId });
    await refresh();
  } catch (error) { operations.delete(key); notice(`${error.message} · 자동 재전송하지 않았습니다.`); renderDetail(); }
}
document.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", () => $(`#${button.dataset.close}`).close()));
$("#session-search").addEventListener("input", renderSidebar);
$("#session-filters").addEventListener("click", event => {
  const value = event.target.dataset.filter; if (!value) return; filter = value;
  for (const button of $("#session-filters").children) button.setAttribute("aria-pressed", String(button.dataset.filter === filter)); renderSidebar();
});
$("#session-list").addEventListener("keydown", event => {
  if (event.shiftKey && ["ArrowUp", "ArrowDown"].includes(event.key)) { const id = event.target.dataset.sessionId; if (id) { event.preventDefault(); void moveSession(id, event.key === "ArrowUp" ? "up" : "down"); } }
});
$("#toggle-sessions").addEventListener("click", () => { const open = document.body.classList.toggle("sessions-open"); $("#toggle-sessions").setAttribute("aria-expanded", String(open)); });
const historyStream = initHistoryStream({ onPage(identity, page) {
  if (streamWarning && $("#notice").textContent === streamWarning) notice();
  streamWarning = "";
  const current = histories.get(identity) ?? { messages: [], loaded: false };
  histories.set(identity, { ...current, messages: mergeMessages(current.messages, page.messages), nextCursor: current.loaded ? current.nextCursor : page.nextCursor,
    loaded: true, revision: (current.revision ?? 0) + 1 });
  if (histories.size > 20) histories.delete(histories.keys().next().value);
  if (`${session()?.id}:${session()?.cwd}` === identity) renderConversation();
}, onError: message => { streamWarning = message; notice(message); } });
const controls = initTerminal({ api, selected: session, onChange: renderDetail, onProgress: renderSessionStatus, onActivity: () => {
  if (!document.hidden && !historyStream.live() && !activityTimer) activityTimer = setTimeout(() => { activityTimer = null; if (!document.hidden && !historyStream.live()) void loadHistory(); }, 250);
} });
$("#connect-session").addEventListener("click", async () => {
  try {
    const spec = await api(`sessions/${encodeURIComponent(directSessionId)}/connection`, {});
    // POSIX single-quote serialization; this string is copied, never executed by the web server.
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    $("#connect-command").value = `cd ${quote(spec.cwd)} && ${[spec.command, ...spec.args].map(quote).join(" ")}`;
    $("#copy-command").textContent = "명령 복사"; $("#connect-dialog").showModal();
  } catch (error) { notice(error.message); }
});
$("#copy-command").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("#connect-command").value); $("#copy-command").textContent = "복사됨"; }
  catch { $("#connect-command").select(); notice("선택한 명령을 복사해 주세요."); }
});
$("#rename-session").addEventListener("click", () => { actionTarget = directSessionId; $("#session-name").value = session().name; $("#rename-dialog").showModal(); });
$("#archive-session").addEventListener("click", () => { actionTarget = directSessionId; $("#archive-name").textContent = session().name; $("#archive-dialog").showModal(); });
for (const action of ["rename", "archive"]) $(`#${action}-form`).addEventListener("submit", async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  try { const response = await api(`sessions/${encodeURIComponent(actionTarget)}/${action}`, action === "rename" ? { name: $("#session-name").value } : {});
    if (response.result?.nameSync === "pending") notice("이름 변경을 접수했습니다. 네이티브 세션과 동기화 중입니다.");
    $(`#${action}-dialog`).close();
    if (action === "archive" && directSessionId === actionTarget) { directSessionId = ""; previewKey = ""; }
    await refresh();
  } catch (error) { notice(error.message); } finally { button.disabled = false; }
});
$("#messages").addEventListener("scroll", () => {
  if ($("#conversation-workspace").hidden) return;
  scrollPositions.set(previewIdentity, $("#messages").scrollTop);
  while (scrollPositions.size > 20) scrollPositions.delete(scrollPositions.keys().next().value);
  if ($("#messages").scrollTop < 80) void loadHistory(true);
});
$("#show-conversation").addEventListener("click", () => { requestAnimationFrame(() => { renderConversation(); if (scrollPositions.has(previewIdentity)) $("#messages").scrollTop = scrollPositions.get(previewIdentity); }); });
$("#message").addEventListener("input", () => { resizeComposer(); drafts.set(recipientKey(), $("#message").value); $("#send").disabled = !session() || sending || !$("#message").value.trim(); });
$("#message").addEventListener("keydown", event => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!$("#send").disabled) $("#query-form").requestSubmit(); }
});
$("#query-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (!session() || sending || !$("#message").value.trim()) return;
  const text = $("#message").value, recipient = recipientKey();
  sending = true; renderDetail();
  try {
    await controls.sendText(text, () => works.create(text, directSessionId, followUpWork?.id));
    if (recipient === recipientKey()) { followUpWork = null; $("#follow-up-instruction").hidden = true; }
    if (recipient === recipientKey() && $("#message").value === text) { $("#message").value = ""; drafts.delete(recipient); }
    void works.refresh().catch(error => notice(`지시는 전달됐지만 작업 조회에 실패했습니다: ${error.message}`));
  } catch (error) { notice(error.message); }
  finally { sending = false; renderDetail(); }
});
$("#cancel-follow-up").addEventListener("click", () => { followUpWork = null; $("#follow-up-instruction").hidden = true; });
$("#new-session").addEventListener("click", () => $("#create-dialog").showModal());
$("#create-form").addEventListener("submit", async event => {
  event.preventDefault(); const input = { provider: $("#create-provider").value, workspace: $("#create-workspace").value, message: $("#create-message").value };
  $("#create-dialog").close(); await submitOperation("create", input);
});
$("#refresh").addEventListener("click", () => { void refresh(); void refreshExecutions().catch(error => notice(error.message)); });
async function start() {
  try { const token = location.hash.slice(1); history.replaceState(null, "", location.pathname); if (token) await api("auth", { token }); ready = true; refreshExecutions = await initExecutions({ api, notice, selectedSession: session }); await refresh(); if (session()) openControls(); }
  catch (error) { notice(error.message); $("#connection").textContent = "접속 링크 필요"; }
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) void refresh(); });
setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
setInterval(() => { if (ready && !document.hidden && !historyStream.live()) void loadHistory(); }, 1000);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { historyStream.sync(null); controls.disconnect(); }
  else if (session()) openControls();
});
window.addEventListener("pagehide", () => historyStream.close());
void start();

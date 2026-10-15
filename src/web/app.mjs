import { DraftStore } from "./drafts.mjs";
import { initExecutions } from "./executions.mjs";
import { conversationItems } from "./conversation.mjs";
const $ = selector => document.querySelector(selector);
const nativeStates = { idle: "대기 중", working: "작업 중", "needs-input": "입력 대기", done: "완료", error: "오류", unavailable: "연결 불가" };
const transport = { starting: "접수 중", "waiting-local": "앞선 요청 대기", waiting: "전송 대기", submitting: "전송 중", submitted: "답변 대기", accepted: "답변 대기", "reply-received": "답변 수신", replied: "답변 수신", error: "질의 실패", created: "세션 생성됨", "not-sent": "미전송", "result-unknown": "결과 미확정" };
let sessions = [], refreshing = false, ready = false;
let directSessionId = "", composerRecipient = "", previewKey = "", previewIdentity = "", warning = "";
let browserStorage; try { browserStorage = localStorage; } catch { browserStorage = { getItem() {}, setItem() {} }; }
const histories = new Map(), sentMessages = new Map(), drafts = new DraftStore(browserStorage);
const operations = new Map(), directRequests = new Map();
let refreshExecutions = async () => {};
const session = () => sessions.find(row => row.id === directSessionId);
const activeKey = () => `direct:${directSessionId}`;
const recipientKey = () => `${activeKey()}:${directSessionId || "unassigned"}`;
const pendingForSession = () => [...operations.values()].find(row => row.target && row.target === directSessionId) ?? operations.get(activeKey());
function resizeComposer() {
  const input = $("#message"); input.style.height = "auto"; input.style.height = `${Math.min(160, Math.max(58, input.scrollHeight))}px`;
}
function el(tag, text, className) {
  const item = document.createElement(tag); if (text !== undefined) item.textContent = text; if (className) item.className = className; return item;
}
function notice(message = "") { $("#notice").textContent = message; $("#notice").hidden = !message; }
async function api(route, value) {
  const response = await fetch(`/api/${route}`, value === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
  const result = await response.json(); if (!response.ok) throw Object.assign(new Error(result.error?.message ?? `요청 실패 (${response.status})`), { status: response.status }); return result;
}
function render() { renderDetail(); }
function renderDetail() {
  if (composerRecipient !== recipientKey()) {
    if (composerRecipient) drafts.set(composerRecipient, $("#message").value);
    composerRecipient = recipientKey(); $("#message").value = drafts.get(composerRecipient) ?? "";
  }
  $("#detail").hidden = false; $("#node-title").textContent = session()?.name ?? "세션 대화";
  const picker = $("#session"); picker.replaceChildren(el("option", "세션 선택")); picker.firstChild.value = "";
  for (const item of sessions) {
    const option = el("option", `${item.provider === "claude" ? "Claude" : "Codex"} · ${item.name}`); option.value = item.id; picker.append(option);
  }
  if (directSessionId && !session()) { const option = el("option", "연결된 세션 조회 불가"); option.value = directSessionId; picker.append(option); }
  picker.value = directSessionId;
  const selected = session();
  const canInstruct = Boolean(selected?.canInstruct);
  $("#message-help").hidden = !selected || canInstruct;
  $("#message-help").textContent = "이 세션은 웹 작업 지시를 지원하지 않습니다. Codex 세션을 선택해 주세요.";
  $("#session-status").textContent = selected ? `${nativeStates[selected.status] ?? "상태 미확인"} · ${selected.cwd}` : "";
  const pending = pendingForSession();
  $("#message").disabled = !canInstruct; $("#send").disabled = !canInstruct || Boolean(pending) || !$("#message").value.trim();
  $("#session").disabled = Boolean(pending); $("#new-session").disabled = Boolean(pending);
  resizeComposer(); renderConversation();
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
  const selected = session(), messages = $("#messages");
  const identity = selected ? `${selected.id}:${selected.cwd}` : activeKey();
  const records = directRequests.get(directSessionId) ?? [];
  const history = histories.get(identity);
  const items = conversationItems({ history: history?.messages ?? [], records, inputs: sentMessages, pending: pendingForSession() });
  const key = JSON.stringify([identity, history?.nextCursor, history?.loading, items]); if (key === previewKey) return;
  const scrollTop = messages.scrollTop;
  const follow = identity !== previewIdentity || messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80;
  previewIdentity = identity; previewKey = key; messages.replaceChildren();
  if (history?.nextCursor) { const older = el("button", history.loading ? "이전 대화 불러오는 중…" : "이전 대화 불러오기", "older-messages"); older.disabled = history.loading; older.addEventListener("click", () => { void loadHistory(true); }); messages.append(older); }
  for (const item of items) {
    const bubble = el("article", undefined, `bubble ${item.role}`);
    bubble.append(el("small", item.label), el("p", item.text));
    if (item.limited) bubble.append(el("small", "일부만 표시 · 전체 내용은 네이티브 세션에서 확인할 수 있습니다."));
    messages.append(bubble);
  }
  if (!items.length) messages.append(el("p", selected ? (history?.loading ? "대화 불러오는 중…" : "대화 기록이 없습니다.") : "세션을 선택하거나 새 세션을 만드세요.", "conversation-empty"));
  messages.scrollTop = follow ? messages.scrollHeight : scrollTop;
}
async function loadHistory(older = false) {
  const selected = session(), identity = selected ? `${selected.id}:${selected.cwd}` : "";
  if (!selected) return;
  const current = histories.get(identity) ?? { messages: [], nextCursor: null, loading: false };
  if (current.loading || (older && !current.nextCursor)) return;
  current.loading = true; histories.set(identity, current); if (!current.loaded || older) renderConversation();
  const container = $("#messages"), oldHeight = container.scrollHeight, oldTop = container.scrollTop;
  try {
    const page = await api(`sessions/${encodeURIComponent(selected.id)}/messages${older ? `?cursor=${encodeURIComponent(current.nextCursor)}` : ""}`);
    const rows = older ? [...page.messages, ...current.messages] : [...current.messages, ...page.messages];
    const messages = [...new Map(rows.map(row => [row.id, row])).values()];
    histories.set(identity, { messages, nextCursor: older || !current.loaded ? page.nextCursor : current.nextCursor, loaded: true, loading: false });
    if (histories.size > 20) histories.delete(histories.keys().next().value);
    if (session()?.id !== selected.id || session()?.cwd !== selected.cwd) return;
    renderConversation();
    if (older) container.scrollTop = oldTop + container.scrollHeight - oldHeight;
    if (page.skipped) notice("일부 로그 항목을 읽지 못했습니다.");
  } catch (error) { current.loading = false; if (session()?.id === selected.id) { notice(`대화 조회 실패: ${error.message}`); renderConversation(); } }
}

async function refresh() {
  if (!ready || refreshing) return; refreshing = true;
  try {
    const discovery = await api("sessions"); sessions = discovery.sessions;
    warning = discovery.warnings.map(row => `${row.provider}: ${row.message}`).join(" · ");
    for (const [key, operation] of operations) {
      let job;
      try { job = await api(`operations/${operation.operationId}`); }
      catch (error) { if (error.status !== 404) throw error; operations.delete(key); notice(error.message); continue; }
      if (job.storageError) notice(job.storageError);
      if (!job.workflowId) {
        const target = job.target ?? operation.target;
        if (job.kind === "create" && job.finished && job.target) directSessionId = job.target;
        if (target) {
          const records = directRequests.get(target) ?? [];
          directRequests.set(target, [...records.filter(row => row.operationId !== job.operationId), { operationId: job.operationId, requestId: job.requestId, sessionId: target, state: job.state, reply: job.result?.reply, turnId: job.result?.turnId, error: job.error?.message, at: job.createdAt }].slice(-100));
        }
      }
      if (job.finished) { operations.delete(key); if (job.error) notice(job.error.message); }
      else operations.set(key, job);
    }
    $("#create-cwd").textContent = discovery.cwd;
    render(); await loadHistory(); $("#connection").textContent = "연결됨";
    if (warning) notice(warning);
  } catch (error) { $("#connection").textContent = "갱신 실패"; notice(error.message); }
  finally { refreshing = false; }
}
async function submitOperation(kind, input) {
  const key = activeKey(), draftRecipient = recipientKey();
  if (pendingForSession()) return;
  const operationId = crypto.randomUUID(); operations.set(key, { operationId, kind, target: input.target, state: "starting" });
  if (kind === "instruct") sentMessages.set(operationId, input.message);
  while (sentMessages.size > 100) sentMessages.delete(sentMessages.keys().next().value);
  renderDetail();
  try {
    await api(kind, { ...input, operationId });
    if (draftRecipient === recipientKey() && kind === "instruct" && $("#message").value === input.message) { $("#message").value = ""; drafts.delete(draftRecipient); }
    await refresh();
  } catch (error) { operations.delete(key); notice(`${error.message} · 자동 재전송하지 않았습니다.`); renderDetail(); }
}
document.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", () => $(`#${button.dataset.close}`).close()));
$("#session").addEventListener("change", async event => { directSessionId = event.target.value; render(); await loadHistory(); });
$("#messages").addEventListener("scroll", () => { if ($("#messages").scrollTop < 80) void loadHistory(true); });
$("#message").addEventListener("input", () => { resizeComposer(); drafts.set(recipientKey(), $("#message").value); $("#send").disabled = !session()?.canInstruct || Boolean(pendingForSession()) || !$("#message").value.trim(); });
$("#message").addEventListener("keydown", event => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!$("#send").disabled) $("#query-form").requestSubmit(); }
});
$("#query-form").addEventListener("submit", event => { event.preventDefault(); if (session()?.canInstruct && $("#message").value.trim()) void submitOperation("instruct", { target: directSessionId, message: $("#message").value }); });
$("#new-session").addEventListener("click", () => $("#create-dialog").showModal());
$("#create-form").addEventListener("submit", async event => {
  event.preventDefault(); const input = { provider: $("#create-provider").value, message: $("#create-message").value };
  $("#create-dialog").close(); await submitOperation("create", input);
});
$("#refresh").addEventListener("click", () => { void refresh(); void refreshExecutions().catch(error => notice(error.message)); });
async function start() {
  try { const token = location.hash.slice(1); history.replaceState(null, "", location.pathname); if (token) await api("auth", { token }); ready = true; refreshExecutions = await initExecutions({ api, notice }); await refresh(); }
  catch (error) { notice(error.message); $("#connection").textContent = "접속 링크 필요"; }
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) void refresh(); });
setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
void start();

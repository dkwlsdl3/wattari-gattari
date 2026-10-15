import { initExecutions } from "./executions.mjs";
import { conversationItems } from "./conversation.mjs";
const $ = selector => document.querySelector(selector);
const phases = { pending: "대기", active: "진행", blocked: "막힘", passed: "통과" };
const nativeStates = { idle: "대기 중", working: "작업 중", "needs-input": "입력 대기", done: "완료", error: "오류", unavailable: "연결 불가" };
const transport = { starting: "접수 중", "waiting-local": "앞선 요청 대기", waiting: "전송 대기", submitting: "전송 중", submitted: "답변 대기", accepted: "답변 대기", "reply-received": "답변 수신", replied: "답변 수신", error: "질의 실패", created: "세션 생성됨", "not-sent": "미전송", "result-unknown": "결과 미확정" };
let sessions = [], workflows = [], currentId = "", nodeId = "", refreshing = false, ready = false, saving = false;
let draftKey = "", previewKey = "", previewIdentity = "", warning = "";
const previews = new Map(), sentMessages = new Map(), drafts = new Map();
const operations = new Map();
let refreshExecutions = async () => {};
const flow = () => workflows.find(row => row.id === currentId);
const node = () => flow()?.nodes.find(row => row.id === nodeId);
const session = () => sessions.find(row => row.id === node()?.sessionId);
const activeKey = () => `${currentId}:${nodeId}`;
const pendingForSession = () => [...operations.values()].find(row => row.target && row.target === node()?.sessionId) ?? operations.get(activeKey());
function chooseNode(id) {
  drafts.set(activeKey(), $("#message").value); nodeId = id; draftKey = "";
  $("#message").value = drafts.get(activeKey()) ?? ""; render(); void loadPreview();
}
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
function updateFlow(value) {
  workflows = [value, ...workflows.filter(row => row.id !== value.id)]; render();
}
function render() {
  const picker = $("#workflow"); picker.replaceChildren(el("option", "작업 선택")); picker.firstChild.value = "";
  for (const row of workflows) { const option = el("option", row.title); option.value = row.id; picker.append(option); }
  picker.value = currentId;
  const value = flow(), graph = $("#graph"); graph.replaceChildren(); graph.hidden = !value; $("#empty").hidden = Boolean(value);
  if (value) {
    graph.append(el("h2", value.title, "graph-heading"));
    const stages = el("div", undefined, "stages");
    for (const step of value.nodes) {
      const holder = el("div", undefined, "stage"), button = el("button", undefined, `node ${step.state}`);
      button.setAttribute("aria-pressed", String(step.id === nodeId)); button.setAttribute("aria-label", `${step.title} · ${phases[step.state]}`);
      button.append(el("strong", step.title), el("span", phases[step.state], "phase"));
      const assigned = sessions.find(row => row.id === step.sessionId);
      button.append(el("small", assigned?.name ?? (step.sessionId ? "연결된 세션 조회 불가" : "담당 세션 미연결")));
      if (assigned) button.append(el("span", `${assigned.provider === "claude" ? "Claude" : "Codex"} · ${nativeStates[assigned.status] ?? "상태 미확인"}`, "native"));
      if (step.state === "blocked" && step.note) button.append(el("small", step.note));
      button.addEventListener("click", () => chooseNode(step.id));
      holder.append(button); stages.append(holder);
    }
    graph.append(stages);
    const returned = value.returns.at(-1);
    if (returned) graph.append(el("p", `↶ ${value.nodes.find(row => row.id === returned.from).title} → ${value.nodes.find(row => row.id === returned.to).title} · ${returned.reason}`, "return-edge"));
    if (value.commit) graph.append(el("p", `검증 대상 ${value.commit.slice(0, 12)}`, "commit-note"));
  }
  renderDetail();
}
function renderDetail() {
  const value = flow(), step = node(); $("#detail").hidden = !step;
  if (!step) return;
  $("#flow-title").textContent = value.title; $("#node-title").textContent = step.title;
  const picker = $("#session"); picker.replaceChildren(el("option", "세션 연결")); picker.firstChild.value = "";
  for (const item of sessions) {
    const option = el("option", `${item.provider === "claude" ? "Claude" : "Codex"} · ${item.name}`); option.value = item.id; picker.append(option);
  }
  if (step.sessionId && !session()) { const option = el("option", "연결된 세션 조회 불가"); option.value = step.sessionId; picker.append(option); }
  picker.value = step.sessionId;
  const selected = session(); $("#session-status").textContent = selected ? `${nativeStates[selected.status] ?? "상태 미확인"} · ${selected.cwd}` : "";
  const pending = pendingForSession();
  $("#message").disabled = !selected; $("#send").disabled = !selected || Boolean(pending) || !$("#message").value.trim();
  $("#session").disabled = Boolean(pending) || saving; $("#new-session").disabled = Boolean(pending);
  if (draftKey !== activeKey()) {
    draftKey = activeKey(); $("#phase-state").value = step.state; $("#phase-note").value = step.note;
    $("#phase-evidence").value = step.evidence; $("#commit").value = value.commit;
    const target = $("#return-to"); target.replaceChildren();
    for (const previous of value.nodes.slice(0, value.nodes.indexOf(step))) { const option = el("option", previous.title); option.value = previous.id; target.append(option); }
    $("#rework-form").hidden = !target.children.length; $("#return-reason").value = "";
  }
  $("#evidence-commit").textContent = step.evidence ? `직접 기록한 완료 근거${step.evidenceCommit ? ` · ${step.evidenceCommit.slice(0, 12)}` : ""}` : "";
  resizeComposer(); renderConversation();
  const record = step.requests.at(-1), status = $("#operation-status"); status.replaceChildren();
  status.hidden = !pending && (!record || record.reply !== undefined || record.state === "created");
  if (pending) status.append(el("span", pending.kind === "create" ? "세션 생성 중…" : transport[pending.state] ?? "답변 대기 중…"));
  else if (!status.hidden) {
    status.append(el("span", record.error ?? "아직 답변을 확인하지 못했습니다."));
    if (record.requestId) {
      const recover = el("button", "답변 다시 확인"); recover.addEventListener("click", () => { void submitOperation("recover", { requestId: record.requestId }); }); status.append(recover);
    }
  }
}
function renderConversation() {
  const step = node(), selected = session(), messages = $("#messages");
  if (!step) return;
  const identity = selected ? `${selected.id}:${selected.cwd}` : activeKey();
  const records = selected ? flow().nodes.flatMap(row => row.requests.filter(record => record.sessionId === selected.id || (!record.sessionId && row.id === step.id))) : [];
  const items = conversationItems({ preview: previews.get(identity), records, inputs: sentMessages, pending: pendingForSession() });
  const key = JSON.stringify([identity, items]); if (key === previewKey) return;
  const scrollTop = messages.scrollTop;
  const follow = identity !== previewIdentity || messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80;
  previewIdentity = identity; previewKey = key; messages.replaceChildren();
  for (const item of items) {
    const bubble = el("article", undefined, `bubble ${item.role}`);
    bubble.append(el("small", item.label), el("p", item.text));
    if (item.limited) bubble.append(el("small", "일부만 표시 · 전체 내용은 네이티브 세션에서 확인할 수 있습니다."));
    messages.append(bubble);
  }
  if (!items.length) messages.append(el("p", selected ? "이 세션에 메시지를 보내세요." : "담당 세션을 연결하면 대화가 표시됩니다.", "conversation-empty"));
  messages.scrollTop = follow ? messages.scrollHeight : scrollTop;
}
async function loadPreview() {
  const selected = session(), identity = selected ? `${selected.id}:${selected.cwd}` : "";
  if (!selected) return;
  try {
    const value = await api(`sessions/${encodeURIComponent(selected.id)}/preview`);
    if (session()?.id !== selected.id || session()?.cwd !== selected.cwd) return;
    previews.set(identity, value); if (previews.size > 20) previews.delete(previews.keys().next().value);
    renderConversation();
  } catch (error) { if (session()?.id === selected.id) notice(`대화 조회 실패: ${error.message}`); }
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
      if (job.finished) { operations.delete(key); if (job.error) notice(job.error.message); }
      else operations.set(key, job);
    }
    workflows = (await api("workflows")).workflows;
    if (!flow()) { currentId = workflows[0]?.id ?? ""; nodeId = ""; }
    if (!node() && flow()) { nodeId = flow().nodes.find(row => row.state === "active")?.id ?? flow().nodes.find(row => row.sessionId)?.id ?? flow().nodes[0].id; draftKey = ""; $("#message").value = drafts.get(activeKey()) ?? ""; }
    $("#create-cwd").textContent = discovery.cwd;
    render(); await loadPreview(); $("#connection").textContent = "연결됨";
    if (warning) notice(warning);
  } catch (error) { $("#connection").textContent = "갱신 실패"; notice(error.message); }
  finally { refreshing = false; }
}
async function submitOperation(kind, input) {
  const key = activeKey(), workflowId = currentId, stepId = nodeId;
  if (!node() || pendingForSession()) return;
  const operationId = crypto.randomUUID(); operations.set(key, { operationId, kind, target: input.target, state: "starting" });
  if (kind === "query") sentMessages.set(operationId, input.message);
  while (sentMessages.size > 100) sentMessages.delete(sentMessages.keys().next().value);
  renderDetail();
  try {
    await api(kind, { ...input, operationId, workflowId, nodeId: stepId });
    if (key === activeKey() && kind === "query" && $("#message").value === input.message) { $("#message").value = ""; drafts.delete(key); }
    await refresh();
  } catch (error) { operations.delete(key); notice(`${error.message} · 자동 재전송하지 않았습니다.`); renderDetail(); }
}
async function mutate(value) {
  if (saving || !flow()) return; saving = true;
  try { const updated = await api(`workflows/${currentId}`, { ...value, revision: flow().revision }); draftKey = ""; updateFlow(updated); notice(warning); }
  catch (error) { notice(error.message); throw error; }
  finally { saving = false; renderDetail(); }
}
$("#workflow").addEventListener("change", event => { drafts.set(activeKey(), $("#message").value); currentId = event.target.value; nodeId = ""; $("#message").value = ""; chooseNode(flow()?.nodes.find(row => row.sessionId)?.id ?? flow()?.nodes[0]?.id ?? ""); });
$("#edit-evidence").addEventListener("click", () => $("#evidence-dialog").showModal());
for (const id of ["#new-workflow", "#first-workflow"]) $(id).addEventListener("click", () => $("#workflow-dialog").showModal());
document.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", () => $(`#${button.dataset.close}`).close()));
$("#workflow-form").addEventListener("submit", async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  try { const value = await api("workflows", { title: $("#workflow-title").value }); drafts.set(activeKey(), $("#message").value); $("#message").value = ""; currentId = value.id; nodeId = value.nodes[0].id; draftKey = ""; updateFlow(value); $("#workflow-dialog").close(); $("#workflow-title").value = ""; }
  catch (error) { notice(error.message); } finally { button.disabled = false; }
});
$("#session").addEventListener("change", async event => { try { await mutate({ action: "assign", nodeId, sessionId: event.target.value }); await loadPreview(); } catch { /* Error is shown by mutate. */ } });
$("#state-form").addEventListener("submit", async event => {
  event.preventDefault();
  const context = activeKey();
  const state = $("#phase-state").value, note = $("#phase-note").value, evidence = $("#phase-evidence").value, commit = $("#commit").value.trim();
  const button = event.submitter; button.disabled = true;
  try {
    if (commit && commit !== flow().commit) await mutate({ action: "commit", commit });
    if (context !== activeKey()) return;
    await mutate({ action: "state", nodeId, state, note, evidence });
  } catch { /* Error is shown by mutate. */ } finally { button.disabled = false; }
});
$("#rework-form").addEventListener("submit", async event => {
  event.preventDefault(); try { await mutate({ action: "rework", nodeId, targetId: $("#return-to").value, note: $("#return-reason").value }); } catch { /* Error is shown by mutate. */ }
});
$("#message").addEventListener("input", () => { resizeComposer(); drafts.set(activeKey(), $("#message").value); $("#send").disabled = !session() || Boolean(pendingForSession()) || !$("#message").value.trim(); });
$("#message").addEventListener("keydown", event => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!$("#send").disabled) $("#query-form").requestSubmit(); }
});
$("#query-form").addEventListener("submit", event => { event.preventDefault(); if ($("#message").value.trim()) void submitOperation("query", { target: node()?.sessionId, message: $("#message").value }); });
$("#new-session").addEventListener("click", () => $("#create-dialog").showModal());
$("#create-form").addEventListener("submit", async event => {
  event.preventDefault(); const input = { provider: $("#create-provider").value, message: $("#create-message").value };
  $("#create-dialog").close(); await submitOperation("create", input);
});
$("#refresh").addEventListener("click", () => { void refresh(); void refreshExecutions().catch(error => notice(error.message)); });
async function start() {
  try { const token = location.hash.slice(1); history.replaceState(null, "", location.pathname); if (token) await api("auth", { token }); ready = true; await refresh(); refreshExecutions = await initExecutions({ api, notice }); }
  catch (error) { notice(error.message); $("#connection").textContent = "접속 링크 필요"; }
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) void refresh(); });
setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
void start();

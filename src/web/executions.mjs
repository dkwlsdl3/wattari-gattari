import { taskGraph } from "./task-graph.mjs";
import { chooseSelection, currentTarget, keepsInspector, linkedRun, historyGroups } from "./execution-selection.mjs";
const tool = span => {
  const name = span.attributes["tool_name"] || span.attributes["gen_ai.tool.name"];
  return ({ commandExecution: "명령 실행", fileChange: "파일 변경", webSearch: "웹 검색", imageView: "이미지 확인", collabAgentToolCall: "에이전트 호출" })[name] || name;
};
const owner = span => `${span.attributes["session.id"] || span.traceId}:${span.attributes.agent_id || span.attributes["gen_ai.conversation.id"] || span.attributes["session.id"] || "main"}`;
export function executionGraph(spans) {
  const byId = new Map(spans.map(span => [span.id, span])), groups = new Map(), edges = new Map();
  for (const span of spans) {
    if (!tool(span) && !span.name.endsWith("llm_request") && span.name !== "native.agent") continue;
    const id = owner(span);
    if (!groups.has(id)) groups.set(id, { id, agentId: span.attributes.agent_id || "", spans: [], callers: [] });
    groups.get(id).spans.push(span);
  }
  for (const span of spans) {
    if (!groups.has(owner(span))) continue;
    let parentId = span.parentSpanId, visited = new Set([span.spanId]);
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      const parent = byId.get(`${span.traceId}:${parentId}`);
      if (!parent) break;
      const from = owner(parent), to = owner(span);
      if (from !== to && groups.has(from)) { edges.set(`${from}\n${to}`, { from, to }); break; }
      parentId = parent.parentSpanId;
    }
  }
  const nodes = [...groups.values()];
  for (const [index, group] of nodes.entries()) {
    group.label = group.agentId ? `에이전트 ${nodes.slice(0, index + 1).filter(row => row.agentId).length}` : `메인 세션${nodes.filter(row => !row.agentId).length > 1 ? ` ${index + 1}` : ""}`;
  }
  // Resolve labels after every node has been named (parents can arrive after children).
  for (const group of nodes) group.callers = [...edges.values()].filter(edge => edge.to === group.id).map(edge => groups.get(edge.from).label);
  return { nodes, edges: [...edges.values()] };
}
export function eventContent(key, value) {
  if (key !== "diff") return value;
  try {
    const hunks = JSON.parse(value);
    if (!Array.isArray(hunks) || !hunks.every(hunk => hunk && [hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines].every(Number.isInteger) && Array.isArray(hunk.lines) && hunk.lines.every(line => typeof line === "string"))) return value;
    return hunks.map(hunk => `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.join("\n")}`).join("\n");
  } catch { return value; }
}
// Read recorded provider fields; never derive patches from shell command text.
export function spanChanges(span) {
  const events = span.events ?? [], name = tool(span), result = [];
  const explicit = events.filter(event => typeof event.content?.diff === "string");
  if (explicit.length) return explicit.map(event => ({ path: event.content.file_path || span.file || "경로 미기록", diff: eventContent("diff", event.content.diff) }));
  const before = events.find(event => typeof event.content?.before === "string")?.content.before;
  const after = events.find(event => typeof event.content?.after === "string")?.content.after;
  if (after !== undefined) return [{ path: span.file || "경로 미기록", before, after, requested: true }];
  // Existing stored records remain usable without recollecting older history.
  for (const event of events) {
    try {
      const input = JSON.parse(event.content?.content);
      if (name === "파일 변경" && Array.isArray(input)) for (const change of input) {
        if (typeof change.path === "string" && typeof change.diff === "string") result.push({ path: change.path, diff: eventContent("diff", change.diff) });
      }
      if (name === "Edit" && typeof input?.old_string === "string" && typeof input?.new_string === "string") result.push({ path: input.file_path || span.file, before: input.old_string, after: input.new_string, requested: true });
      if (name === "Write" && typeof input?.content === "string") result.push({ path: input.file_path || span.file, after: input.content, requested: true });
    } catch { /* A clipped input remains available as raw evidence. */ }
  }
  if (!result.length && ["Edit", "Write", "파일 변경"].includes(name)) result.push({ path: span.file || "경로 미기록", unavailable: true });
  return result;
}
export function executionTimeline(spans) {
  const graph = executionGraph(spans), labels = new Map(graph.nodes.map(node => [node.id, node.label]));
  const rows = spans.filter(span => tool(span)).map(span => ({ span, agent: labels.get(owner(span)) || "메인 세션", owner: owner(span), changes: spanChanges(span) }));
  rows.sort((a, b) => a.span.start.length - b.span.start.length || a.span.start.localeCompare(b.span.start));
  return { ...graph, rows };
}
function diffBlock(change) {
  const box = el("div", undefined, "file-diff"); box.append(el("h3", change.path));
  if (change.unavailable) { box.append(el("p", "변경 본문이 이 기록에 없습니다.", "muted")); return box; }
  if (change.requested) box.append(el("p", change.before === undefined ? "작성 요청 내용 · 이전 파일 내용은 미기록" : "도구에 전달된 교체 전·후 내용", "muted"));
  const pre = el("pre", undefined, "diff-code");
  const lines = change.diff !== undefined ? change.diff.split("\n") : [...(change.before === undefined ? [] : change.before.split("\n").map(line => `-${line}`)), ...(change.after ?? "").split("\n").map(line => `+${line}`)];
  for (const line of lines) pre.append(el("span", line, line.startsWith("+") && !line.startsWith("+++") ? "diff-add" : line.startsWith("-") && !line.startsWith("---") ? "diff-remove" : line.startsWith("@@") ? "diff-hunk" : ""));
  box.append(pre); return box;
}
const taskStates = { skipped: '조건 제외', "waiting-user": "사용자 판단 대기", "permission-wait": "권한 판단 대기", stale: "검증 무효·재계획", pending: "대기", working: "작업 중", checking: "검사 중", verifying: "독립 검증 중", passed: "통과", failed: "수정 대기", "needs-replan": "재계획 필요", "waiting-resource": "자원 대기", paused: "일시정지", interrupted: "실행 중단", planned: "실행 준비", running: "실행 중", review_required: "최종 검토 대기", approved: "검토 완료", stopped: "중단" };
const states = { error: "오류 기록", returned: "호출 종료", unknown: "종료 미확인" };
const $ = selector => document.querySelector(selector);
function el(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }

export async function initExecutions({ api, notice, selectedSession = () => null }) {
  let loadVersion = 0, listVersion = 0, selectedAttempt = -1, scope = "", pinned = null;
  const scoped = route => `${route}?session=${encodeURIComponent(scope)}`;
  const inspector = $(".execution-inspector");
  $("#close-inspector").addEventListener("click", () => { inspector.hidden = true; $("#execution-panel").classList.remove("with-inspector"); for (const card of cards.values()) card.setAttribute("aria-pressed", "false"); });
  let flowFilter = "all", flowSearch = "", flowAgent = "", visibleCount = 80;
  let flowComposing = false, searchFrame = 0, timelineExecution, timelineModel;
  let currentRun, workView = true, selectedTask = "", execution, selectedSpan = "", drawnEdges = [], cards = new Map();
  let selectedId = '', groups = [], imported = [], nativeId = '', historySignature = '', historyLimit = 8, historyComposing = false;
  const historyDialog = $('#execution-history-dialog'), historySearch = $('#execution-history-search');
  const dateLabel = value => value ? new Date(value).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short' }) : '날짜 미기록';
  function selectRecord(id) {
    historyDialog.close(); pinned = id; workView = true;
    void listing().catch(error => notice(error.message));
  }
  function historyEntry(entry) {
    const row = el('div', undefined, 'history-attempt');
    row.append(el('span', `${dateLabel(entry.updatedAt)} · ${entry.state === 'declaration' ? '등록한 계획' : taskStates[entry.state] || '호출 기록'}`, 'muted'));
    if (entry.id === selectedId) row.append(el('span', '현재 표시 중', 'history-selected'));
    else { const open = el('button', '열기'); open.setAttribute('aria-label', `${entry.title} · ${dateLabel(entry.updatedAt)} 열기`); open.onclick = () => selectRecord(entry.id); row.append(open); }
    return row;
  }
  function renderHistory() {
    const list = $('#execution-history-list'), scroll = historyDialog.scrollTop;
    const expanded = new Set([...list.querySelectorAll('details[open]')].map(node => node.dataset.work));
    list.replaceChildren();
    const query = historySearch.value.trim().normalize('NFC').toLocaleLowerCase('ko-KR');
    const matches = groups.filter(group => group.title.normalize('NFC').toLocaleLowerCase('ko-KR').includes(query));
    $('#execution-history-count').textContent = `작업 ${matches.length}건${query ? ' 검색됨' : ''}`;
    for (const group of matches.slice(0, historyLimit)) {
      const card = el('article', undefined, 'history-work'); card.append(el('h3', group.title), historyEntry(group.entries[0]));
      if (group.entries.length > 1) {
        const attempts = el('details'); attempts.dataset.work = group.id; attempts.open = expanded.has(group.id);
        attempts.append(el('summary', `이전 실행 ${group.entries.length - 1}회`));
        for (const entry of group.entries.slice(1)) attempts.append(historyEntry(entry));
        card.append(attempts);
      }
      list.append(card);
    }
    if (!matches.length) list.append(el('p', query ? '일치하는 작업이 없습니다.' : '등록된 작업 기록이 없습니다.', 'muted'));
    if (imported.length && !query) {
      const section = el('details'); section.dataset.work = 'imported'; section.open = expanded.has('imported'); section.append(el('summary', `가져온 호출 기록 ${imported.length}건`));
      for (const entry of imported) { const card = el('article', undefined, 'history-work'); card.append(el('h3', entry.title), historyEntry(entry)); section.append(card); }
      list.append(section);
    }
    $('#execution-history-more').hidden = matches.length <= historyLimit;
    historyDialog.scrollTop = scroll;
  }
  $('#execution-history').onclick = () => { renderHistory(); historyDialog.showModal(); historySearch.focus(); };
  $('#execution-history-close').onclick = () => historyDialog.close();
  historySearch.addEventListener('compositionstart', () => { historyComposing = true; });
  historySearch.addEventListener('compositionend', () => { historyComposing = false; historyLimit = 8; renderHistory(); });
  historySearch.addEventListener('input', event => { if (historyComposing || event.isComposing) return; historyLimit = 8; renderHistory(); });
  $('#execution-history-more').onclick = () => { historyLimit += 8; renderHistory(); };
  $('#execution-native').onclick = () => selectRecord(nativeId);
  $('#execution-current').onclick = () => { pinned = null; workView = true; void listing().catch(error => notice(error.message)); };
  let fitToView = true;
  $('#graph-size').onclick = () => { fitToView = !fitToView; $('#graph-size').textContent = fitToView ? '크게 보기' : '화면에 맞춤'; fitGraph(); drawEdges(); };
  function fitGraph() {
    const graph = $("#execution-graph"), stage = graph.querySelector('.graph-stage');
    if (!stage || !graph.clientWidth || !graph.clientHeight) return;
    stage.style.width = `${Math.max(graph.clientWidth - 20, Number(stage.dataset.columns) * 230 + (Number(stage.dataset.columns) - 1) * 72)}px`;
    const scale = innerWidth <= 650 || !fitToView ? 1 : Math.min(1, (graph.clientWidth - 20) / stage.offsetWidth, (graph.clientHeight - 30) / stage.offsetHeight);
    stage.dataset.scale = String(Math.max(.55, scale));
    stage.style.transform = `scale(${stage.dataset.scale})`;
    const extent = graph.querySelector('.graph-extent');
    extent.style.width = `${stage.offsetWidth * Number(stage.dataset.scale)}px`;
    extent.style.height = `${stage.offsetHeight * Number(stage.dataset.scale)}px`;
  }
  function drawEdges() {
    const viewport = $("#execution-graph"), graph = viewport.querySelector('.graph-stage') ?? viewport;
    graph.querySelector("svg")?.remove();
    if (!graph.clientWidth || !drawnEdges.length) return;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"), bounds = graph.getBoundingClientRect();
    const scale = Number(graph.dataset.scale) || 1;
    const rect = card => {
      const r = card?.getBoundingClientRect(); if (!r) return null;
      return { left: (r.left - bounds.left) / scale, right: (r.right - bounds.left) / scale,
        top: (r.top - bounds.top) / scale, bottom: (r.bottom - bounds.top) / scale, width: r.width / scale, height: r.height / scale };
    };
    svg.setAttribute("width", graph.scrollWidth); svg.setAttribute("height", graph.scrollHeight); svg.setAttribute("aria-hidden", "true");
    const defs = document.createElementNS(svg.namespaceURI, 'defs'), marker = document.createElementNS(svg.namespaceURI, 'marker'), arrow = document.createElementNS(svg.namespaceURI, 'path');
    marker.id = 'flow-arrow'; marker.setAttribute('viewBox', '0 0 10 10'); marker.setAttribute('refX','9'); marker.setAttribute('refY','5'); marker.setAttribute('markerWidth','6'); marker.setAttribute('markerHeight','6'); marker.setAttribute('orient','auto'); arrow.setAttribute('d','M 0 0 L 10 5 L 0 10 z'); marker.append(arrow); defs.append(marker); svg.append(defs);
    for (const edge of drawnEdges) {
      const from = rect(cards.get(edge.from)), to = rect(cards.get(edge.to)); if (!from || !to) continue;
      const x1 = from.right + graph.scrollLeft, y1 = from.top + from.height / 2 + graph.scrollTop;
      const x2 = to.left + graph.scrollLeft, y2 = to.top + to.height / 2 + graph.scrollTop;
      const path = document.createElementNS(svg.namespaceURI, "path");
      const bottom = from.bottom + graph.scrollTop;
      path.setAttribute("d", edge.kind === 'retry' ? `M ${x1 - 25} ${bottom} C ${x1 - 25} ${bottom + 28}, ${from.left + graph.scrollLeft + 25} ${bottom + 28}, ${from.left + graph.scrollLeft + 25} ${bottom}` : `M ${x1} ${y1} C ${x1 + 20} ${y1}, ${x2 - 20} ${y2}, ${x2} ${y2}`);
      path.setAttribute('marker-end','url(#flow-arrow)'); if (edge.inactive) path.classList.add('inactive-edge');
      if (edge.label) { const title = document.createElementNS(svg.namespaceURI, 'title'); title.textContent = edge.label; path.append(title); path.setAttribute('data-relation', edge.kind); }
      svg.append(path);
      if (edge.label) {
        const label = document.createElementNS(svg.namespaceURI, 'text');
        label.setAttribute('x', edge.kind === 'retry' ? from.left + graph.scrollLeft + from.width / 2 : (x1 + x2) / 2);
        label.setAttribute('y', edge.kind === 'retry' ? bottom + 23 : (y1 + y2) / 2 - 8);
        label.setAttribute('text-anchor', 'middle');
        label.textContent = edge.kind === 'condition' ? '조건' : edge.kind === 'retry' ? '실패 → 수정' : edge.kind === 'artifact' ? '파일 전달' : '선행 결과';
        const title = document.createElementNS(svg.namespaceURI, 'title'); title.textContent = edge.label; label.append(title); svg.append(label);
      }
    }
    graph.prepend(svg);
  }
  function flowToolbarHeight() {
    const graph = $("#execution-graph");
    graph.style.setProperty("--flow-toolbar-height", `${graph.querySelector(".flow-filters")?.offsetHeight || 0}px`);
  }
  new ResizeObserver(() => { fitGraph(); drawEdges(); flowToolbarHeight(); }).observe($("#execution-graph"));
  function mode(graph) {
    $("#execution-panel").hidden = !graph; $("#conversation-workspace").hidden = graph;
    $("#show-executions").setAttribute("aria-pressed", String(graph)); $("#show-conversation").setAttribute("aria-pressed", String(!graph));
  }
  $("#show-executions").addEventListener("click", () => { mode(true); void listing().catch(error => notice(error.message)); });
  $("#show-conversation").addEventListener("click", () => mode(false));
  const displayPath = path => execution?.cwd && path?.startsWith(`${execution.cwd}/`) ? path.slice(execution.cwd.length + 1) : path;
  function evidence(span) {
    selectedSpan = span.id;
    const panel = $("#execution-evidence"); panel.replaceChildren(el("h2", tool(span) || (execution.source === "native" ? "모델 응답" : "모델 요청")));
    panel.append(el("p", `${states[span.state]}${span.durationMs === null ? "" : ` · ${(span.durationMs / 1000).toFixed(2)}초`}`, span.state === "error" ? "trace-error" : "muted"));
    const model = span.attributes.model || span.attributes["gen_ai.request.model"];
    if (model) panel.append(el("p", model, "muted"));
    const tokenKeys = ["input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens"];
    if (tokenKeys.some(key => span.attributes[key] !== undefined)) panel.append(el("p", tokenKeys.filter(key => span.attributes[key] !== undefined).map(key => `${({ input_tokens: "입력", output_tokens: "출력", cache_read_tokens: "캐시 읽기", cache_creation_tokens: "캐시 생성" })[key]} ${span.attributes[key]}`).join(" · "), "muted"));
    const changes = spanChanges(span);
    for (const change of changes) panel.append(diffBlock({ ...change, path: displayPath(change.path) }));
    if (span.command) panel.append(el("pre", span.command));
    if (span.file && !changes.length) panel.append(el("p", displayPath(span.file), "muted"));
    for (const event of span.events ?? []) for (const [key, value] of Object.entries(event.content)) {
      if (changes.some(change => !change.unavailable) && ["diff", "before", "after", "file_path", "content"].includes(key)) continue;
      if ((key === "bash_command" && value === span.command) || (key === "file_path" && value === span.file)) continue;
      panel.append(el("h3", ({ output: "출력", content: "내용", diff: "변경", file_path: "파일", bash_command: "명령" })[key]), el("pre", eventContent(key, value)));
    }
    if (span.contentLimited) panel.append(el("p", execution.source === "native" ? "긴 입력·출력은 각각 4,000자까지 표시합니다." : "입력·출력 일부만 표시합니다. 내용당 16,000자·이벤트 20개 제한입니다.", "muted"));
    if (!execution.includesContent) panel.append(el("p", "입력·출력은 가져오지 않았습니다.", "muted"));

    const identity = el("details"); identity.append(el("summary", "추적 식별자"), el("pre", `trace ${span.traceId}\nspan ${span.spanId}\nsession ${span.attributes["session.id"] || "미기록"}\nworkflow ${span.attributes["workflow.run_id"] || "미기록"}`)); panel.append(identity);
    for (const button of document.querySelectorAll("[data-span]")) button.setAttribute("aria-pressed", String(button.dataset.span === selectedSpan));
    inspector.hidden = false; $("#execution-panel").classList.add("with-inspector");
    panel.scrollTop = 0;
  }
  function layoutGraph(nodes, edges) {
    drawnEdges = edges; cards = new Map();
    const levels = new Map(), outgoing = new Map();
    const forward = edges.filter(edge => edge.kind !== 'retry');
    for (const edge of forward) { if (!outgoing.has(edge.from)) outgoing.set(edge.from, []); outgoing.get(edge.from).push(edge.to); }
    const queue = nodes.filter(node => !forward.some(edge => edge.to === node.id)).map(node => node.id);
    for (const id of queue) levels.set(id, 0);
    for (let index = 0; index < queue.length; index++) for (const child of outgoing.get(queue[index]) ?? []) {
      const depth = levels.get(queue[index]) + 1;
      if (!levels.has(child) || levels.get(child) < depth) { levels.set(child, depth); queue.push(child); }
    }
    return levels;
  }
  function attemptEvidence(node, attempt) {
    const panel = $("#execution-evidence"); panel.replaceChildren(el("h2", node.title));
    if (currentRun?.declaration) {
      panel.append(el('p', `${currentRun.skill} · 에이전트가 등록한 계획·진행 보고`, 'muted'));
      if (node.blockedReason) panel.append(el('p', node.blockedReason, 'task-blocked'));
      for (const reference of node.evidence) {
        panel.append(el('h3', reference));
        const source = currentRun.observations.sources.find(source => source.id === reference);
        if (source) panel.append(el('pre', source.text));
        else panel.append(el('p', '에이전트가 연결한 참조 위치입니다. 이 표시만으로 내용·검사 결과가 검증된 것은 아닙니다.', 'muted'));
      }
      if (!node.evidence.length) panel.append(el('p', '아직 연결한 실행 근거가 없습니다.', 'muted'));
      panel.append(el('p', '단계 종료 보고는 동작 검사 통과 판정과 구분합니다.', 'muted'));
      return;
    }
    if (currentRun?.proposal) {
      panel.append(el('p', node.prompt), el('p', 'LLM이 원문에서 제안한 작업입니다. 실행·완료·검사 통과를 뜻하지 않습니다.', 'muted'));
      for (const id of node.evidenceIds) {
        const source = currentRun.observations.sources.find(source => source.id === id);
        if (!source) continue;
        if (source.role === 'project' || source.role === 'context' || id === 'instruction') { panel.append(el('h3', id === 'instruction' ? '원래 지시' : source.role === 'context' ? '정정한 인계' : id.slice(5)), el('pre', source.text)); continue; }
        const show = el('button', `${source.role === 'tool' ? '실제 호출 근거' : '원문 대화'} 보기`, 'trace-call');
        show.onclick = async () => {
          if (source.role === 'tool') { const executionId = currentRun.observations.executionId; await load(executionId); const span = execution?.spans.find(span => span.id === id); if (span) { inspector.hidden = false; evidence(span); } }
          else { mode(false); const messageId = id.slice('message:'.length); const bubble = [...document.querySelectorAll('[data-message-id]')].find(node => node.dataset.messageId === messageId); bubble?.scrollIntoView({ block: 'center' }); }
        };
        panel.append(show, el('pre', source.text));
      }
      return;
    }
    if (node.decision) panel.append(el('h3', '분기 판단 근거'), el('pre', JSON.stringify(node.decision, null, 2)));
    if (!attempt) { panel.append(el("p", node.blockedReason || "아직 실행 근거가 없습니다.", "muted")); return; }
    panel.append(el("p", `${attempt.passed ? "검사·독립 검증 통과" : "통과하지 못함"} · 작업 모델 ${attempt.worker.model} · 검증 모델 ${attempt.review.model || "미실행"}`, "muted"));
    if (node.state === 'stale') panel.append(el('p', '검증 후 파일이 변경됐습니다. 아래는 당시 검사 기록입니다.', 'task-blocked'));
    if (attempt.evidence) panel.append(el('p', `검사 대상 커밋 ${attempt.evidence.revision} · ${attempt.evidence.fingerprint}`, 'muted'));
    if (attempt.failure) panel.append(el('p', `다음 조치: ${{ repair: '검사 근거로 수정', recover: '원래 실행 회수', wait: '사용자 판단 대기' }[attempt.failure.action]} · ${attempt.failure.reason}`, 'task-blocked'));
    panel.append(el("h3", "검사"), el("pre", `${JSON.stringify(node.check)}\n종료 코드: ${attempt.check.exitCode ?? "미확인"}${attempt.check.signal ? ` · ${attempt.check.signal}` : ""}\n${attempt.check.stdout}\n${attempt.check.stderr}`));
    panel.append(el("h3", "독립 검증"), el("p", `${attempt.review.verdict || "미확인"} · ${attempt.review.reason || attempt.review.summary || "미실행"}`));
    if (attempt.diff) panel.append(diffBlock({ path: "변경", diff: attempt.diff }));
    const more = el("details"); more.append(el("summary", "세션·산출물 근거"), el("pre", JSON.stringify({ worker: attempt.worker.sessionId, verifier: attempt.review.sessionId, artifacts: attempt.artifacts, workspace: node.workspace, usage: { worker: attempt.worker.usage, reviewer: attempt.review.usage }, reportedCostUsd: { worker: attempt.worker.costUsd ?? "미제공", reviewer: attempt.review.costUsd ?? "미제공" } }, null, 2))); panel.append(more);
  }
  function renderRun() {
    const graph = $("#execution-graph"), calls = $("#execution-tools"), detail = $("#execution-evidence"); graph.classList.remove("execution-timeline"); graph.replaceChildren(); calls.replaceChildren(); detail.replaceChildren();
    const { nodes, edges } = taskGraph(currentRun);
    const levels = layoutGraph(currentRun.nodes, edges);
    graph.classList.add('task-layout');
    const columns = Math.max(0, ...levels.values()) + 1;
    const extent = el('div', undefined, 'graph-extent'), stage = el('div', undefined, 'graph-stage');
    stage.dataset.columns = String(columns); stage.style.setProperty('--plan-columns', String(columns)); extent.append(stage); graph.append(extent);
    const groups = new Map();
    for (const node of nodes) { const level = levels.get(node.id) ?? 0; if (!groups.has(level)) groups.set(level, []); groups.get(level).push(node.id); }
    const rows = Math.max(...[...groups.values()].map(group => group.length));
    const selected = nodes.find(node => node.id === selectedTask) || nodes.find(node => !['passed', 'skipped', 'reported'].includes(node.state)) || nodes[0];
    if (!selected) return;
    selectedTask = selected.id;
    $("#execution-note").textContent = `${currentRun.title} · ${currentRun.declaration ? `${currentRun.skill} · 작업 계획 · 에이전트 진행 보고` : currentRun.proposal ? 'LLM 제안 관계 · 실행 전' : `${currentRun.superseded ? '이전 실행 · 재계획으로 대체됨' : taskStates[currentRun.state]} · 명세에 선언된 작업 의존성`}${currentRun.blockedReason ? ` · ${currentRun.blockedReason}` : ""}`;
    const summary = el('div', undefined, 'graph-summary');
    summary.style.gridColumn = '1 / -1'; summary.style.gridRow = '1';
    const counts = new Map();
    for (const node of nodes) {
      const state = currentRun.declaration ? ({ pending: '대기', working: '진행 중', failed: '막힘', reported: '종료 보고' })[node.state] : taskStates[node.state];
      counts.set(state, (counts.get(state) ?? 0) + 1);
    }
    for (const [state, count] of counts) summary.append(el('span', `${state} ${count}`));
    stage.append(summary);
    for (const node of nodes) {
      const card = el("button", undefined, `agent-card task-${node.state}`); card.style.gridColumn = String((levels.get(node.id) ?? 0) + 1); card.setAttribute("aria-pressed", String(!inspector.hidden && node.id === selected.id));
      const group = groups.get(levels.get(node.id) ?? 0); card.style.gridRow = group.length === 1 ? `2 / span ${rows}` : String(group.indexOf(node.id) + 2);
      const role = ({ plan: "계획", scan: "조사", edit: "수정", verify: "검증" })[node.role];
      card.append(el("small", currentRun.declaration ? currentRun.skill : currentRun.proposal ? `${role} · LLM 제안` : `${currentRun.providers?.[node.role] ?? "claude"} · ${role} · ${currentRun.models[node.role]}`, "muted"), el("strong", node.title), el("span", currentRun.declaration ? ({ pending: '대기', working: '진행 중', failed: '막힘', reported: '단계 종료 보고' })[node.state] : currentRun.proposal ? '제안 · 실행 전' : taskStates[node.state]), el("small", currentRun.declaration ? `연결한 근거 ${node.evidence.length}개` : currentRun.proposal ? `원문 근거 ${node.evidenceIds.length}개` : `${node.attempts.length}회 실행${node.stalls ? ` · 무진전 ${node.stalls}회` : ""}`, "muted"));
      if (node.blockedReason && node.state !== 'skipped') card.append(el('small', node.blockedReason.slice(0, 180), 'task-blocked'));
      if (node.when) card.append(el('small', `${node.when.field} = ${JSON.stringify(node.when.equals)}${node.decision ? node.decision.selected ? ' · 선택' : ' · 제외' : ' · 판단 대기'}`, 'muted'));
      if (node.dependsOn.length) card.append(el('small', `← ${node.dependsOn.map(id => nodes.find(other => other.id === id)?.title ?? id).join(' · ')}`, 'task-predecessors'));
      if (node.dependsOn.length > 1 && node.join !== 'selected') card.append(el('small', '모든 선행 작업 합류', 'muted'));
      if (node.join === 'selected') card.append(el('small', '선택된 경로 합류', 'muted'));
      if (node.attempts.length > 1) card.append(el('small', `실패 근거로 수정 ${node.attempts.length - 1}회`, 'task-blocked'));
      if (node.inputs.length) card.append(el('small', `받는 파일: ${node.inputs.map(input => input.path).join(', ')}`, 'muted'));
      if (node.state === 'passed') card.append(el('small', '동작 검사 → 독립 검토 통과', 'muted'));
      cards.set(node.id, card); card.addEventListener("click", () => { selectedTask = node.id; selectedAttempt = -1; inspector.hidden = false; renderRun(); }); stage.append(card);
    }
    fitGraph(); drawEdges(); calls.append(el("h2", "실행 근거"));
    selected.attempts.forEach((attempt, index) => { const button = el("button", `시도 ${index + 1} · ${attempt.passed ? "통과" : "실패"}`, "trace-call"); button.addEventListener("click", () => { selectedAttempt = index; attemptEvidence(selected, attempt); }); calls.append(button); });
    for (const edge of edges.filter(edge => edge.to === selected.id || edge.from === selected.id)) {
      const target = edge.to === selected.id ? edge.from : edge.to, other = currentRun.nodes.find(node => node.id === target);
      const relation = el('button', `${other.title} · ${edge.label}`, 'trace-call'); relation.onclick = () => { selectedTask = target; selectedAttempt = -1; renderRun(); }; calls.append(relation);
    }
    if (currentRun.context) { const context = el('details'); context.append(el('summary', '전달한 컨텍스트·출처'), el('pre', currentRun.context.text)); calls.append(context); }
    if (currentRun.metrics) calls.append(el('p', `관측 자원: 여유 메모리 최소 ${currentRun.metrics.minAvailableGiB.toFixed(1)}GiB · PC CPU 최대 ${currentRun.metrics.maxCpuPercent.toFixed(0)}% · ${currentRun.metrics.samples}회`, 'muted'));
    const task = el("details"); task.append(el("summary", "작업 지시"), el("pre", selected.prompt)); calls.append(task);
    attemptEvidence(selected, selectedAttempt >= 0 ? selected.attempts[selectedAttempt] : selected.attempts.at(-1));
  }
  function runControls() {
    $("#graph-size").hidden = !currentRun || !workView;
    const managed = currentRun && !currentRun.proposal && !currentRun.declaration;
    $("#run-work-view").hidden = !managed; $("#run-call-view").hidden = !managed;
    $('#run-work-view').setAttribute('aria-pressed', String(workView)); $('#run-call-view').setAttribute('aria-pressed', String(!workView));
    $('#run-management').hidden = true; $('#run-approve').hidden = true; $('#run-controls').hidden = true;
    if (!managed || currentRun.superseded) return;
    const ended = ["review_required", "approved"].includes(currentRun.state);
    $('#run-controls').hidden = currentRun.state === 'approved';
    $('#run-management').hidden = ended;
    if (ended) $('#run-management').open = false;
    const resumable = currentRun.control !== 'run' || ['interrupted', 'needs-replan', 'waiting-user'].includes(currentRun.state);
    $('#run-pause').hidden = resumable; $('#run-resume').hidden = !resumable;
    $("#run-stop").disabled = currentRun.control === "stop";
    $("#run-approve").hidden = currentRun.state !== "review_required";
    const resource = currentRun.resource;
    $("#run-resource").textContent = resource ? `여유 ${resource.availableGiB.toFixed(1)}GiB · CPU ${resource.cpuPercent === null ? "측정 중" : `${resource.cpuPercent.toFixed(0)}%`}${currentRun.control === "pause" ? " · 다음 단계 대기" : ""}` : "";
  }
  function render({ keepPosition = false } = {}) {
    $("#execution-panel").classList.toggle("native-flow", !(currentRun && workView));
    if (currentRun && workView) { renderRun(); return; }
    const graph = $("#execution-graph"), calls = $("#execution-tools"), detail = $("#execution-evidence");
    graph.classList.remove('task-layout');
    const graphTop = graph.scrollTop;
    const followLatest = !keepPosition || graph.scrollHeight - graph.clientHeight - graphTop <= 32;
    const viewportTop = graph.getBoundingClientRect().top;
    const anchor = keepPosition && !followLatest && [...graph.querySelectorAll(".flow-event")].find(node => node.getBoundingClientRect().bottom > viewportTop);
    const anchorOffset = anchor ? anchor.getBoundingClientRect().top - viewportTop : 0;
    let toolbar = graph.querySelector(":scope > .flow-filters");
    for (const child of [...graph.children]) if (child !== toolbar) child.remove();
    calls.replaceChildren(); detail.replaceChildren();
    if (!execution) { toolbar?.remove(); flowComposing = false; $("#execution-note").textContent = "세션 실행 기록을 자동으로 확인하고 있습니다."; return; }
    graph.classList.add("execution-timeline");
    if (timelineExecution !== execution) {
      timelineExecution = execution;
      timelineModel = executionTimeline(execution.spans);
      for (const row of timelineModel.rows) row.searchText = `${row.span.command || ""} ${row.span.file || ""} ${row.changes.map(change => change.path).join(" ")} ${tool(row.span)} ${row.agent} ${(row.span.events || []).flatMap(event => Object.values(event.content || {})).join(" ")}`.normalize("NFC").toLowerCase();
    }
    const { nodes, edges, rows } = timelineModel;
    if (currentRun) for (const node of nodes) {
      const nativeId = node.spans[0]?.attributes["session.id"];
      const task = currentRun.nodes.find(task => task.sessions?.some(session => session.id === nativeId) || task.attempts.some(attempt => attempt.worker.sessionId === nativeId || attempt.review.sessionId === nativeId));
      if (!task) continue;
      const review = task.sessions?.some(session => session.id === nativeId && session.role === "review") || task.attempts.some(attempt => attempt.review.sessionId === nativeId);
      node.label = `${task.title} · ${review ? "독립 검증" : "작업"}`;
      for (const row of rows) if (row.owner === node.id) row.agent = node.label;
    }
    const changes = rows.filter(row => row.changes.length), files = new Map();
    for (const row of changes) for (const change of row.changes) { files.delete(change.path); files.set(change.path, row); }
    const errors = rows.filter(row => row.span.state === "error");
    $("#execution-note").textContent = `${execution.title} · 파일 ${files.size}개 · 호출 ${rows.length}회 · 오류 ${errors.length}회${execution.collection?.skipped ? " · 일부 기록 읽기 제외" : ""}${execution.collection?.collectingHistory ? " · 이전 기록 수집 중" : ""}${execution.collection?.limited ? " · 최근 기록만 표시" : ""}${execution.collection?.error ? ` · 갱신 실패: ${execution.collection.error}` : ""}`;
    if (!toolbar) {
      toolbar = el("div", undefined, "flow-filters");
      for (const value of ["all", "changes", "commands", "errors"]) {
        const button = el("button"); button.dataset.filter = value;
        button.addEventListener("click", () => { flowFilter = value; visibleCount = 80; render(); }); toolbar.append(button);
      }
      const search = el("input"); search.type = "search"; search.placeholder = "파일·명령·내용 검색"; search.setAttribute("aria-label", "실행 기록 검색"); search.value = flowSearch;
      const update = () => {
        flowSearch = search.value; visibleCount = 80;
        if (!searchFrame) searchFrame = requestAnimationFrame(() => { searchFrame = 0; if (search.isConnected) render(); });
      };
      search.addEventListener("compositionstart", () => { flowComposing = true; cancelAnimationFrame(searchFrame); searchFrame = 0; });
      search.addEventListener("compositionend", () => { flowComposing = false; update(); });
      search.addEventListener("input", event => { if (!flowComposing && !event.isComposing) update(); });
      toolbar.append(search);
      const status = el("span", undefined, "flow-search-status muted"); status.setAttribute("role", "status"); toolbar.append(status);
      graph.append(toolbar);
    }
    for (const [value, label] of [["all", "전체"], ["changes", `파일 변경 ${changes.length}`], ["commands", "명령"], ["errors", `오류 ${errors.length}`]]) {
      const button = toolbar.querySelector(`[data-filter="${value}"]`); button.textContent = label; button.setAttribute("aria-pressed", String(flowFilter === value));
    }
    const search = toolbar.querySelector("input");
    if (!flowComposing && search.value !== flowSearch) search.value = flowSearch;
    if (nodes.length > 1) {
      const agents = el("div", undefined, "flow-agents");
      for (const node of [{ id: "", label: "모든 에이전트" }, ...nodes]) {
        const button = el("button", node.label); button.setAttribute("aria-pressed", String(flowAgent === node.id));
        const caller = edges.filter(edge => edge.to === node.id).map(edge => nodes.find(parent => parent.id === edge.from)?.label).join(", ");
        if (caller) button.append(el("small", ` ← ${caller} 호출`));
        button.addEventListener("click", () => { flowAgent = node.id; visibleCount = 80; render(); }); agents.append(button);
      }
      graph.append(agents);
    }
    const query = flowSearch.normalize("NFC").toLowerCase();
    const filtered = rows.filter(row => (!flowAgent || row.owner === flowAgent) && (flowFilter === "all" || flowFilter === "changes" && row.changes.length || flowFilter === "errors" && row.span.state === "error" || flowFilter === "commands" && row.span.command) && row.searchText.includes(query));
    const searchStatus = toolbar.querySelector(".flow-search-status"); searchStatus.hidden = !query; searchStatus.textContent = query ? `검색 결과 ${filtered.length}개` : "";
    graph.append(el("p", rows.some(row => !row.span.start) ? "시각 미기록 항목은 제공자 기록 순서로 표시합니다." : "시간순 기록 · 호출 관계는 실제 연결된 기록만 표시합니다.", "flow-caption muted"));
    if (filtered.length > visibleCount) {
      const more = el("button", `이전 ${Math.min(80, filtered.length - visibleCount)}개 보기 · 총 ${filtered.length}개`);
      more.addEventListener("click", () => { visibleCount += 80; render({ keepPosition: true }); }); graph.append(more);
    }
    const timeline = el("div", undefined, "flow-events");
    let dayKey, dayGroup;
    for (const row of filtered.slice(-visibleCount)) {
      const span = row.span, button = el("button", undefined, `flow-event${row.changes.length ? " flow-change" : ""}${span.state === "error" ? " flow-error" : ""}`);
      button.dataset.span = span.id; button.setAttribute("aria-pressed", String(selectedSpan === span.id));
      const ms = span.start ? Number(BigInt(span.start) / 1000000n) : NaN;
      const date = Number.isFinite(ms) ? new Date(ms) : null;
      const key = date ? date.toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' }) : "unknown";
      if (key !== dayKey) {
        dayKey = key;
        dayGroup = el("section", undefined, "flow-day");
        dayGroup.append(el("h3", date ? date.toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "long", day: "numeric", weekday: "short" }) : "날짜 미기록", "flow-day-label"));
        timeline.append(dayGroup);
      }
      const time = el("time", Number.isFinite(ms) ? new Date(ms).toLocaleTimeString("ko-KR", { timeZone: "Asia/Seoul", hour12: false }) : "시각 미기록");
      if (Number.isFinite(ms)) { time.dateTime = new Date(ms).toISOString(); time.title = new Date(ms).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }); }
      const body = el("span", undefined, "flow-body");
      body.append(el("small", `${row.agent} · ${row.changes.length ? "파일 변경" : tool(span)} · ${states[span.state]}`), el("strong", (row.changes.length ? row.changes.map(change => displayPath(change.path)).join(" · ") : span.command || span.file || tool(span))));
      button.append(time, body); button.addEventListener("click", () => { evidence(span); }); dayGroup.append(button);
    }
    if (!filtered.length) timeline.append(el("p", "조건에 맞는 실행 기록이 없습니다.", "muted"));
    graph.append(timeline);
    calls.append(el("h2", `변경 파일 ${files.size}`));
    const fileList = el("div", undefined, "changed-files");
    for (const [path, row] of [...files].reverse()) {
      const button = el("button", displayPath(path), "changed-file"); button.title = path; button.dataset.span = row.span.id;
      button.addEventListener("click", () => evidence(row.span)); fileList.append(button);
    }
    if (!files.size) fileList.append(el("p", "기록된 파일 변경이 없습니다.", "muted")); calls.append(fileList);
    const selected = rows.find(row => row.span.id === selectedSpan) || changes.at(-1) || rows.at(-1);
    if (selected && !inspector.hidden) evidence(selected.span);
    flowToolbarHeight();
    if (followLatest) graph.scrollTop = graph.scrollHeight;
    else {
      const nextAnchor = anchor && [...timeline.querySelectorAll(".flow-event")].find(node => node.dataset.span === anchor.dataset.span);
      graph.scrollTop = nextAnchor ? graph.scrollTop + nextAnchor.getBoundingClientRect().top - graph.getBoundingClientRect().top - anchorOffset : graphTop;
    }
  }

  async function load(id, preserve = false) {
    const version = ++loadVersion;
    if (!preserve) { $("#run-controls").hidden = true; $('#run-management').open = false; }
    if (id?.startsWith('plan:')) {
      const row = await api(scoped(`works/${id.slice(5)}`)); if (version !== loadVersion) return;
      if (!row.plan) throw Error('등록한 작업 계획이 없습니다.');
      if (preserve && currentRun?.id === id && currentRun.revision === row.plan.revision) return;
      currentRun = { ...row.plan, id, declaration: true, observations: row.observations, nodes: row.plan.nodes.map(node => ({ ...node, role: 'plan', prompt: node.title, state: ({ active: 'working', blocked: 'failed' })[node.state] ?? node.state, blockedReason: node.reason, attempts: [], inputs: [], outputs: [] })) };
      execution = null;
    } else if (id?.startsWith('proposal:')) {
      const row = await api(scoped(`works/${id.slice(9)}`)); if (version !== loadVersion) return;
      if (!row.analysis?.nodes) throw Error('작업 관계 정리가 아직 없습니다.');
      currentRun = { ...row.analysis.manifest, id, title: row.analysis.summary, proposal: true, state: 'planned', models: row.analysis.manifest?.models ?? { plan: row.analysis.provider, scan: row.analysis.provider, edit: row.analysis.provider, verify: row.analysis.provider }, nodes: row.analysis.nodes.map(node => ({ ...node, state: 'pending', attempts: [] })), observations: row.observations };
      execution = null;
    } else if (id?.startsWith("run:")) {
      const row = await api(scoped(`runs/${id.slice(4)}`));
      if (version !== loadVersion) return;
      if (preserve && currentRun?.id === row.id && currentRun.revision === row.revision && currentRun.superseded === row.superseded) return;
      currentRun = row; execution = { spans: row.traceSpans || [], title: row.title, includesContent: row.includeContent };
    } else {
      const row = id ? await api(scoped(`executions/${id}`)) : null;
      if (version !== loadVersion) return;
      if (preserve && row?.id === execution?.id && row?.importedAt === execution?.importedAt) return;
      currentRun = null; execution = row;
    }
    if (!preserve) { flowFilter = "all"; flowSearch = ""; flowAgent = ""; visibleCount = 80; $("#execution-panel").classList.remove("with-inspector"); inspector.hidden = true; selectedSpan = ""; selectedTask = ""; selectedAttempt = -1; }
    const detailTop = $("#execution-evidence").scrollTop, filesTop = $(".changed-files")?.scrollTop || 0;
    const top = inspector.scrollTop, expanded = $("#execution-tools details")?.open;
    const outputPositions = [...$("#execution-evidence").querySelectorAll("pre")].map(node => node.scrollTop);
    runControls(); render({ keepPosition: preserve });
    if (preserve) {
      const more = $("#execution-tools details"); if (more) more.open = Boolean(expanded);
      [...$("#execution-evidence").querySelectorAll("pre")].forEach((node, index) => { node.scrollTop = outputPositions[index] ?? 0; });
      inspector.scrollTop = top; $("#execution-evidence").scrollTop = detailTop;
      if ($(".changed-files")) $(".changed-files").scrollTop = filesTop;
    }
  }
  const shownId = () => currentRun ? (currentRun.declaration || currentRun.proposal ? currentRun.id : `run:${currentRun.id}`) : execution?.id;
  async function listing(preserve = false) {
    const version = ++listVersion;
    const nextScope = selectedSession()?.id || "";
    if (scope !== nextScope) { scope = nextScope; pinned = null; selectedId = ''; preserve = false; loadVersion++; currentRun = null; execution = null; groups = []; imported = []; nativeId = ''; historySignature = ''; historySearch.value = ''; historyLimit = 8; historyDialog.close(); $('#execution-history-list').replaceChildren(); $('#execution-history').hidden = true; $('#execution-native').hidden = true; $('#execution-current').hidden = true; inspector.hidden = true; runControls(); render(); }
    if (!scope) { $("#execution-note").textContent = "왼쪽 목록에서 세션을 선택하세요."; return; }
    const startedWith = selectedId;
    const [{ executions }, { runs }, { works }] = await Promise.all([api(scoped("executions")), api(scoped("runs")), api(scoped('works'))]);
    if (version !== listVersion || (preserve && selectedId !== startedWith)) return;
    let selected = pinned;
    executions.sort((a, b) => Number(b.source === "native") - Number(a.source === "native") || b.importedAt - a.importedAt);
    const ids = runs.map(run => `run:${run.id}`);
    const proposals = works.filter(work => work.analysis?.nodes && selected === `proposal:${work.id}`);
    const plans = works.filter(work => work.plan).sort((a, b) => b.plan.updatedAt - a.plan.updatedAt);
    for (const work of plans) {
      const linked = linkedRun(work, runs);
      if (linked) { if (selected === `plan:${work.id}`) selected = pinned = `run:${linked.id}`; continue; }
      ids.push(`plan:${work.id}`);
    }
    ids.push(...proposals.map(work => `proposal:${work.id}`), ...executions.map(run => run.id));
    const choice = chooseSelection({ pinned: selected, ids, current: currentTarget(works, runs) });
    pinned = choice.pinned; selectedId = choice.value;
    groups = historyGroups(works, runs);
    imported = executions.filter(row => row.source !== 'native').map(row => ({ ...row, updatedAt: row.importedAt }));
    nativeId = executions.find(row => row.source === 'native')?.id || '';
    $('#execution-history').hidden = !groups.length && !imported.length;
    $('#execution-native').hidden = !nativeId || selectedId === nativeId;
    $('#execution-current').hidden = !pinned;
    const signature = JSON.stringify({ groups, imported, selectedId });
    if (signature !== historySignature && !historyComposing) { historySignature = signature; if (historyDialog.open) renderHistory(); }
    await load(selectedId, keepsInspector(preserve, shownId(), selectedId));
  }
  async function control(action, extra = {}) {
    if (!currentRun || currentRun.proposal || currentRun.superseded || selectedId !== `run:${currentRun.id}`) return;
    const requestedScope = scope, runId = currentRun.id;
    try { const row = await api(scoped(`runs/${runId}/control`), { action, ...extra });
      if (scope !== requestedScope || currentRun?.id !== runId) return;
      currentRun = row; runControls(); render(); }
    catch (error) { notice(error.message); }
  }
  for (const action of ["pause", "resume", "stop", "approve"]) $(`#run-${action}`).addEventListener("click", () => { void control(action); });
  $("#run-work-view").addEventListener("click", () => { workView = true; runControls(); render(); });
  $("#run-call-view").addEventListener("click", () => { workView = false; runControls(); render(); });
  $("#run-resource-settings").addEventListener("click", () => { $("#reserve-memory").value = currentRun.resources.reserveGiB; $("#max-cpu").value = currentRun.resources.maxCpuPercent; $("#resource-dialog").showModal(); });
  $("#resource-form").addEventListener("submit", async event => { event.preventDefault(); await control("resources", { resources: { reserveGiB: Number($("#reserve-memory").value), maxCpuPercent: Number($("#max-cpu").value) } }); $("#resource-dialog").close(); });
  let polling = false;
  setInterval(async () => {
    if (document.hidden || $("#execution-panel").hidden || polling) return;
    polling = true; try { await listing(true); } catch (error) { notice(error.message); } finally { polling = false; }
  }, 2000);
  mode(false);
  const refresh = () => listing(true);
  refresh.openWork = async (row, runId) => { mode(true); workView = true; pinned = runId ? `run:${runId}` : row.plan ? `plan:${row.id}` : row.analysis?.nodes ? `proposal:${row.id}` : null; await listing(); };
  return refresh;
}

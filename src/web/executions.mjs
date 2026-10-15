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
const taskStates = { pending: "대기", working: "작업 중", checking: "검사 중", verifying: "독립 검증 중", passed: "통과", failed: "수정 대기", "needs-replan": "재계획 필요", "waiting-resource": "자원 대기", paused: "일시정지", interrupted: "실행 중단", planned: "실행 준비", running: "실행 중", review_required: "최종 검토 대기", approved: "검토 완료", stopped: "중단" };
const states = { error: "오류 기록", returned: "호출 종료", unknown: "종료 미확인" };
const $ = selector => document.querySelector(selector);
function el(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }

export async function initExecutions({ api, notice, selectedSession = () => null }) {
  let loadVersion = 0, listVersion = 0, selectedAttempt = -1, scope = "";
  const scoped = route => `${route}?session=${encodeURIComponent(scope)}`;
  const inspector = $(".execution-inspector");
  $("#close-inspector").addEventListener("click", () => { inspector.hidden = true; $("#execution-panel").classList.remove("with-inspector"); });
  let flowFilter = "all", flowSearch = "", flowAgent = "", visibleCount = 80;
  let currentRun, workView = true, selectedTask = "", execution, selectedSpan = "", drawnEdges = [], cards = new Map();
  function drawEdges() {
    const graph = $("#execution-graph"); graph.querySelector("svg")?.remove();
    if (!graph.clientWidth || !drawnEdges.length) return;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"), bounds = graph.getBoundingClientRect();
    svg.setAttribute("width", graph.scrollWidth); svg.setAttribute("height", graph.scrollHeight); svg.setAttribute("aria-hidden", "true");
    for (const edge of drawnEdges) {
      const from = cards.get(edge.from)?.getBoundingClientRect(), to = cards.get(edge.to)?.getBoundingClientRect(); if (!from || !to) continue;
      const x1 = from.right - bounds.left + graph.scrollLeft, y1 = from.top + from.height / 2 - bounds.top;
      const x2 = to.left - bounds.left + graph.scrollLeft, y2 = to.top + to.height / 2 - bounds.top;
      const path = document.createElementNS(svg.namespaceURI, "path");
      path.setAttribute("d", `M ${x1} ${y1} C ${x1 + 20} ${y1}, ${x2 - 20} ${y2}, ${x2} ${y2}`); svg.append(path);
    }
    graph.prepend(svg);
  }
  new ResizeObserver(drawEdges).observe($("#execution-graph"));
  function mode(graph) {
    $("#execution-panel").hidden = !graph; $("#conversation-workspace").hidden = graph;
    $("#show-executions").setAttribute("aria-pressed", String(graph)); $("#show-conversation").setAttribute("aria-pressed", String(!graph));
  }
  $("#show-executions").addEventListener("click", () => { mode(true); void listing(execution?.id).catch(error => notice(error.message)); });
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
    for (const edge of edges) { if (!outgoing.has(edge.from)) outgoing.set(edge.from, []); outgoing.get(edge.from).push(edge.to); }
    const queue = nodes.filter(node => !edges.some(edge => edge.to === node.id)).map(node => node.id);
    for (const id of queue) levels.set(id, 0);
    for (let index = 0; index < queue.length; index++) for (const child of outgoing.get(queue[index]) ?? []) {
      if (!levels.has(child)) { levels.set(child, Math.min(3, levels.get(queue[index]) + 1)); queue.push(child); }
    }
    return levels;
  }
  function attemptEvidence(node, attempt) {
    const panel = $("#execution-evidence"); panel.replaceChildren(el("h2", node.title));
    if (!attempt) { panel.append(el("p", "아직 실행 근거가 없습니다.", "muted")); return; }
    panel.append(el("p", `${attempt.passed ? "검사·독립 검증 통과" : "통과하지 못함"} · 작업 모델 ${attempt.worker.model} · 검증 모델 ${attempt.review.model || "미실행"}`, "muted"));
    panel.append(el("h3", "검사"), el("pre", `${JSON.stringify(node.check)}\n종료 코드: ${attempt.check.exitCode ?? "미확인"}${attempt.check.signal ? ` · ${attempt.check.signal}` : ""}\n${attempt.check.stdout}\n${attempt.check.stderr}`));
    panel.append(el("h3", "독립 검증"), el("p", `${attempt.review.verdict || "미확인"} · ${attempt.review.reason || attempt.review.summary || "미실행"}`));
    if (attempt.diff) panel.append(diffBlock({ path: "변경", diff: attempt.diff }));
    const more = el("details"); more.append(el("summary", "세션·산출물 근거"), el("pre", JSON.stringify({ worker: attempt.worker.sessionId, verifier: attempt.review.sessionId, artifacts: attempt.artifacts, workspace: node.workspace, costUsd: attempt.costUsd }, null, 2))); panel.append(more);
  }
  function renderRun() {
    const graph = $("#execution-graph"), calls = $("#execution-tools"), detail = $("#execution-evidence"); graph.classList.remove("execution-timeline"); graph.replaceChildren(); calls.replaceChildren(); detail.replaceChildren();
    const edges = currentRun.nodes.flatMap(node => node.dependsOn.map(id => ({ from: id, to: node.id })));
    const levels = layoutGraph(currentRun.nodes, edges);
    const selected = currentRun.nodes.find(node => node.id === selectedTask) || currentRun.nodes.find(node => node.state !== "passed") || currentRun.nodes[0]; selectedTask = selected.id;
    $("#execution-note").textContent = `${currentRun.title} · ${taskStates[currentRun.state]} · 명세에 선언된 작업 의존성`;
    for (const node of currentRun.nodes) {
      const card = el("button", undefined, `agent-card task-${node.state}`); card.style.gridColumn = String((levels.get(node.id) ?? 0) + 1); card.setAttribute("aria-pressed", String(node === selected));
      card.append(el("small", `${({ plan: "계획", scan: "조사", edit: "수정", verify: "검증" })[node.role]} · ${currentRun.models[node.role]}`, "muted"), el("strong", node.title), el("span", taskStates[node.state]), el("small", `${node.attempts.length}회 실행${node.stalls ? ` · 무진전 ${node.stalls}회` : ""}`, "muted"));
      cards.set(node.id, card); card.addEventListener("click", () => { selectedTask = node.id; selectedAttempt = -1; inspector.hidden = false; renderRun(); }); graph.append(card);
    }
    drawEdges(); calls.append(el("h2", "실행 근거"));
    selected.attempts.forEach((attempt, index) => { const button = el("button", `시도 ${index + 1} · ${attempt.passed ? "통과" : "실패"}`, "trace-call"); button.addEventListener("click", () => { selectedAttempt = index; attemptEvidence(selected, attempt); }); calls.append(button); });
    const task = el("details"); task.append(el("summary", "작업 지시"), el("pre", selected.prompt)); calls.append(task);
    attemptEvidence(selected, selectedAttempt >= 0 ? selected.attempts[selectedAttempt] : selected.attempts.at(-1));
  }
  function runControls() {
    $("#run-controls").hidden = !currentRun; $("#run-work-view").hidden = !currentRun; $("#run-call-view").hidden = !currentRun;
    if (!currentRun) return;
    const ended = ["review_required", "approved"].includes(currentRun.state);
    $("#run-pause").disabled = ended || currentRun.control === "pause";
    $("#run-resume").disabled = ended || currentRun.control === "run";
    $("#run-stop").disabled = ended || currentRun.control === "stop";
    $("#run-approve").hidden = currentRun.state !== "review_required";
    const resource = currentRun.resource;
    $("#run-resource").textContent = resource ? `여유 ${resource.availableGiB.toFixed(1)}GiB · CPU ${resource.cpuPercent === null ? "측정 중" : `${resource.cpuPercent.toFixed(0)}%`}${currentRun.control === "pause" ? " · 다음 단계 대기" : ""}` : "";
  }
  function render({ keepPosition = false } = {}) {
    $("#execution-panel").classList.toggle("native-flow", !(currentRun && workView));
    if (currentRun && workView) { renderRun(); return; }
    const graph = $("#execution-graph"), calls = $("#execution-tools"), detail = $("#execution-evidence");
    const graphTop = graph.scrollTop;
    const followLatest = !keepPosition || graph.scrollHeight - graph.clientHeight - graphTop <= 32;
    const viewportTop = graph.getBoundingClientRect().top;
    const anchor = keepPosition && !followLatest && [...graph.querySelectorAll(".flow-event")].find(node => node.getBoundingClientRect().bottom > viewportTop);
    const anchorOffset = anchor ? anchor.getBoundingClientRect().top - viewportTop : 0;
    graph.replaceChildren(); calls.replaceChildren(); detail.replaceChildren();
    if (!execution) { $("#execution-note").textContent = "세션 실행 기록을 자동으로 확인하고 있습니다."; return; }
    graph.classList.add("execution-timeline");
    const { nodes, edges, rows } = executionTimeline(execution.spans);
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
    const toolbar = el("div", undefined, "flow-filters");
    for (const [value, label] of [["all", "전체"], ["changes", `파일 변경 ${changes.length}`], ["commands", "명령"], ["errors", `오류 ${errors.length}`]]) {
      const button = el("button", label); button.setAttribute("aria-pressed", String(flowFilter === value));
      button.addEventListener("click", () => { flowFilter = value; visibleCount = 80; render(); }); toolbar.append(button);
    }
    const search = el("input"); search.type = "search"; search.placeholder = "파일·명령 검색"; search.setAttribute("aria-label", "실행 기록 검색"); search.value = flowSearch;
    search.addEventListener("input", () => { const position = search.selectionStart; flowSearch = search.value; visibleCount = 80; render(); const next = graph.querySelector("input"); next.focus(); if (position !== null) next.setSelectionRange(position, position); }); toolbar.append(search); graph.append(toolbar);
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
    const filtered = rows.filter(row => (!flowAgent || row.owner === flowAgent) && (flowFilter === "all" || flowFilter === "changes" && row.changes.length || flowFilter === "errors" && row.span.state === "error" || flowFilter === "commands" && row.span.command) && `${row.span.command || ""} ${row.span.file || ""} ${row.changes.map(change => change.path).join(" ")} ${tool(row.span)}`.toLowerCase().includes(flowSearch.toLowerCase()));
    graph.append(el("p", rows.some(row => !row.span.start) ? "시각 미기록 항목은 제공자 기록 순서로 표시합니다." : "시간순 기록 · 호출 관계는 실제 연결된 기록만 표시합니다.", "flow-caption muted"));
    if (filtered.length > visibleCount) {
      const more = el("button", `이전 ${Math.min(80, filtered.length - visibleCount)}개 보기 · 총 ${filtered.length}개`);
      more.addEventListener("click", () => { visibleCount += 80; render({ keepPosition: true }); }); graph.append(more);
    }
    const timeline = el("div", undefined, "flow-events");
    for (const row of filtered.slice(-visibleCount)) {
      const span = row.span, button = el("button", undefined, `flow-event${row.changes.length ? " flow-change" : ""}${span.state === "error" ? " flow-error" : ""}`);
      button.dataset.span = span.id; button.setAttribute("aria-pressed", String(selectedSpan === span.id));
      const ms = span.start ? Number(BigInt(span.start) / 1000000n) : NaN;
      const time = el("time", Number.isFinite(ms) ? new Date(ms).toLocaleTimeString("ko-KR", { hour12: false }) : "시각 미기록");
      if (Number.isFinite(ms)) { time.dateTime = new Date(ms).toISOString(); time.title = new Date(ms).toLocaleString("ko-KR"); }
      const body = el("span", undefined, "flow-body");
      body.append(el("small", `${row.agent} · ${row.changes.length ? "파일 변경" : tool(span)} · ${states[span.state]}`), el("strong", (row.changes.length ? row.changes.map(change => displayPath(change.path)).join(" · ") : span.command || span.file || tool(span))));
      button.append(time, body); button.addEventListener("click", () => { evidence(span); }); timeline.append(button);
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
    if (selected) evidence(selected.span);
    if (followLatest) graph.scrollTop = graph.scrollHeight;
    else {
      const nextAnchor = anchor && [...timeline.children].find(node => node.dataset.span === anchor.dataset.span);
      graph.scrollTop = nextAnchor ? graph.scrollTop + nextAnchor.getBoundingClientRect().top - graph.getBoundingClientRect().top - anchorOffset : graphTop;
    }
  }

  async function load(id, preserve = false) {
    const version = ++loadVersion;
    if (id?.startsWith("run:")) {
      const row = await api(scoped(`runs/${id.slice(4)}`));
      if (version !== loadVersion) return;
      if (preserve && currentRun?.id === row.id && currentRun.revision === row.revision) return;
      currentRun = row; execution = { spans: row.traceSpans || [], title: row.title, includesContent: row.includeContent };
    } else {
      const row = id ? await api(scoped(`executions/${id}`)) : null;
      if (version !== loadVersion) return;
      if (preserve && row?.id === execution?.id && row?.importedAt === execution?.importedAt) return;
      currentRun = null; execution = row;
    }
    if (!preserve) { flowFilter = "all"; flowSearch = ""; flowAgent = ""; visibleCount = 80; $("#execution-panel").classList.remove("with-inspector"); inspector.hidden = true; selectedSpan = ""; selectedTask = ""; selectedAttempt = -1; }
    const searchInput = $(".flow-filters input"), searchFocused = document.activeElement === searchInput, searchPosition = searchInput?.selectionStart;
    const detailTop = $("#execution-evidence").scrollTop, filesTop = $(".changed-files")?.scrollTop || 0;
    const top = inspector.scrollTop, expanded = $("#execution-tools details")?.open;
    const outputPositions = [...$("#execution-evidence").querySelectorAll("pre")].map(node => node.scrollTop);
    runControls(); render({ keepPosition: preserve });
    if (preserve) {
      const more = $("#execution-tools details"); if (more) more.open = Boolean(expanded);
      [...$("#execution-evidence").querySelectorAll("pre")].forEach((node, index) => { node.scrollTop = outputPositions[index] ?? 0; });
      inspector.scrollTop = top; $("#execution-evidence").scrollTop = detailTop;
      if ($(".changed-files")) $(".changed-files").scrollTop = filesTop;
      if (searchFocused && $(".flow-filters input")) { const input = $(".flow-filters input"); input.focus({ preventScroll: true }); if (searchPosition !== null) input.setSelectionRange(searchPosition, searchPosition); }
    }
  }
  async function listing(preferred, preserve = false) {
    const version = ++listVersion;
    const nextScope = selectedSession()?.id || "";
    if (scope !== nextScope) { scope = nextScope; preferred = ""; preserve = false; loadVersion++; currentRun = null; execution = null; $("#execution-select").replaceChildren(); inspector.hidden = true; runControls(); render(); }
    if (!scope) { $("#execution-note").textContent = "왼쪽 목록에서 세션을 선택하세요."; return; }
    const picker = $("#execution-select"), startedWith = picker.value;
    const [{ executions }, { runs }] = await Promise.all([api(scoped("executions")), api(scoped("runs"))]);
    if (version !== listVersion || (preserve && picker.value !== startedWith)) return;
    const selected = preferred || picker.value;
    executions.sort((a, b) => Number(b.source === "native") - Number(a.source === "native")); picker.replaceChildren();
    for (const run of runs) { const option = el("option", `${run.title} · ${taskStates[run.state]}`); option.value = `run:${run.id}`; picker.append(option); }
    for (const run of executions) { const option = el("option", run.source === "native" ? "세션 실행 기록 · 자동 수집" : `${run.title} · ${new Date(run.importedAt).toLocaleString("ko-KR")}`); option.value = run.id; picker.append(option); }
    const ids = [...executions.filter(row => row.source === "native").map(row => row.id), ...runs.map(row => `run:${row.id}`), ...executions.filter(row => row.source !== "native").map(row => row.id)]; picker.value = ids.includes(selected) ? selected : ids[0] || "";
    picker.disabled = !ids.length; picker.hidden = ids.length < 2;
    await load(picker.value, preserve);
  }
  async function control(action, extra = {}) {
    if (!currentRun) return;
    const requestedScope = scope, runId = currentRun.id;
    try { const row = await api(scoped(`runs/${runId}/control`), { action, ...extra });
      if (scope !== requestedScope || currentRun?.id !== runId) return;
      currentRun = row; runControls(); render(); }
    catch (error) { notice(error.message); }
  }
  for (const action of ["pause", "resume", "stop", "approve"]) $(`#run-${action}`).addEventListener("click", () => { void control(action); });
  $("#run-work-view").addEventListener("click", () => { workView = true; render(); });
  $("#run-call-view").addEventListener("click", () => { workView = false; render(); });
  $("#run-resource-settings").addEventListener("click", () => { $("#reserve-memory").value = currentRun.resources.reserveGiB; $("#max-cpu").value = currentRun.resources.maxCpuPercent; $("#resource-dialog").showModal(); });
  $("#resource-form").addEventListener("submit", async event => { event.preventDefault(); await control("resources", { resources: { reserveGiB: Number($("#reserve-memory").value), maxCpuPercent: Number($("#max-cpu").value) } }); $("#resource-dialog").close(); });
  let polling = false;
  setInterval(async () => {
    if (document.hidden || $("#execution-panel").hidden || polling) return;
    polling = true; try { await listing($("#execution-select").value, true); } catch (error) { notice(error.message); } finally { polling = false; }
  }, 2000);
  $("#execution-select").addEventListener("change", () => { void load($("#execution-select").value).catch(error => notice(error.message)); });
  mode(false);
  return () => listing(currentRun ? `run:${currentRun.id}` : execution?.id);
}

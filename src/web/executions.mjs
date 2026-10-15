const tool = span => span.attributes["tool_name"] || span.attributes["gen_ai.tool.name"];
const owner = span => `${span.attributes["session.id"] || span.traceId}:${span.attributes.agent_id || span.attributes["gen_ai.conversation.id"] || span.attributes["session.id"] || "main"}`;
export function executionGraph(spans) {
  const byId = new Map(spans.map(span => [span.id, span])), groups = new Map(), edges = new Map();
  for (const span of spans) {
    if (!tool(span) && !span.name.endsWith("llm_request")) continue;
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
const states = { error: "오류 기록", returned: "호출 종료", unknown: "종료 미확인" };
const $ = selector => document.querySelector(selector);
function el(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }

export async function initExecutions({ api, notice }) {
  let execution, selectedGroup = "", selectedSpan = "", drawnEdges = [], cards = new Map();
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
    $("#workflow").hidden = graph; $("#new-workflow").hidden = graph;
    $("#show-executions").setAttribute("aria-pressed", String(graph)); $("#show-conversation").setAttribute("aria-pressed", String(!graph));
  }
  $("#show-executions").addEventListener("click", () => mode(true));
  $("#show-conversation").addEventListener("click", () => mode(false));
  function evidence(span) {
    selectedSpan = span.id;
    const panel = $("#execution-evidence"); panel.replaceChildren(el("h2", tool(span) || "모델 요청"));
    panel.append(el("p", `${states[span.state]} · ${span.durationMs === null ? "소요 시간 미확인" : `${(span.durationMs / 1000).toFixed(2)}초`}`, span.state === "error" ? "trace-error" : "muted"));
    const model = span.attributes.model || span.attributes["gen_ai.request.model"];
    if (model) panel.append(el("p", model, "muted"));
    const tokenKeys = ["input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens"];
    if (tokenKeys.some(key => span.attributes[key] !== undefined)) panel.append(el("p", tokenKeys.filter(key => span.attributes[key] !== undefined).map(key => `${({ input_tokens: "입력", output_tokens: "출력", cache_read_tokens: "캐시 읽기", cache_creation_tokens: "캐시 생성" })[key]} ${span.attributes[key]}`).join(" · "), "muted"));
    if (span.command) panel.append(el("pre", span.command));
    if (span.file) panel.append(el("p", span.file, "muted"));
    for (const event of span.events ?? []) for (const [key, value] of Object.entries(event.content)) {
      if ((key === "bash_command" && value === span.command) || (key === "file_path" && value === span.file)) continue;
      panel.append(el("h3", ({ output: "출력", content: "내용", diff: "변경", file_path: "파일", bash_command: "명령" })[key]), el("pre", eventContent(key, value)));
    }
    if (span.contentLimited) panel.append(el("p", "입력·출력 일부만 표시합니다. 내용당 16,000자·이벤트 20개 제한입니다.", "muted"));
    if (!execution.includesContent) panel.append(el("p", "입력·출력은 가져오지 않았습니다.", "muted"));
    panel.append(el("p", "호출 종료는 테스트 통과를 뜻하지 않습니다.", "muted"));
    const identity = el("details"); identity.append(el("summary", "추적 식별자"), el("pre", `trace ${span.traceId}\nspan ${span.spanId}\nsession ${span.attributes["session.id"] || "미기록"}\nworkflow ${span.attributes["workflow.run_id"] || "미기록"}`)); panel.append(identity);
    for (const button of $("#execution-tools").querySelectorAll("button")) button.setAttribute("aria-pressed", String(button.dataset.span === selectedSpan));
  }
  function render() {
    const graph = $("#execution-graph"), calls = $("#execution-tools"), detail = $("#execution-evidence"); graph.replaceChildren(); calls.replaceChildren(); detail.replaceChildren();
    if (!execution) { $("#execution-note").textContent = "실행 기록이 없습니다. Claude Code의 OTLP JSON 기록을 가져오세요."; return; }
    const { nodes, edges } = executionGraph(execution.spans);
    drawnEdges = edges; cards = new Map();
    const levels = new Map(), outgoing = new Map();
    for (const edge of edges) { if (!outgoing.has(edge.from)) outgoing.set(edge.from, []); outgoing.get(edge.from).push(edge.to); }
    const queue = nodes.filter(node => !edges.some(edge => edge.to === node.id)).map(node => node.id);
    for (const id of queue) levels.set(id, 0);
    for (let index = 0; index < queue.length; index++) for (const child of outgoing.get(queue[index]) ?? []) {
      if (!levels.has(child)) { levels.set(child, Math.min(3, levels.get(queue[index]) + 1)); queue.push(child); }
    }
    const group = nodes.find(row => row.id === selectedGroup) || nodes[0]; selectedGroup = group?.id || "";
    $("#execution-note").textContent = `${execution.title} · 가져온 기록 · 호출 관계 ${edges.length}개 · 작업 의존성·검증 판정은 미수집`;
    for (const node of nodes) {
      const card = el("button", undefined, `agent-card${node.callers.length ? " called-agent" : ""}`); card.setAttribute("aria-pressed", String(node === group));
      card.style.gridColumn = String((levels.get(node.id) ?? 0) + 1); cards.set(node.id, card);
      const tools = node.spans.filter(span => tool(span));
      card.append(el("small", node.callers.length ? `${node.callers.join(", ")} → 호출` : "호출자 미기록", "muted"), el("strong", node.label), el("span", [...new Set(tools.map(tool))].join(" · ") || "모델 요청"), el("small", `${tools.length}회 도구 호출${node.spans.some(span => span.state === "error") ? " · 오류 있음" : ""}`, "muted"));
      card.addEventListener("click", () => { selectedGroup = node.id; selectedSpan = ""; render(); }); graph.append(card);
    }
    drawEdges();
    if (!group) { calls.append(el("p", "표시할 도구·모델 요청이 없습니다.")); return; }
    calls.append(el("h2", group.label));
    const tools = group.spans.filter(span => tool(span)), llms = group.spans.filter(span => !tool(span));
    function callButton(span) {
      const button = el("button", undefined, "trace-call"); button.dataset.span = span.id;
      button.append(el("strong", tool(span) || span.attributes.model || "모델 요청"), el("small", states[span.state], span.state === "error" ? "trace-error" : "muted"));
      button.addEventListener("click", () => evidence(span)); return button;
    }
    for (const span of tools) calls.append(callButton(span));
    if (llms.length) { const more = el("details"); more.append(el("summary", `모델 요청 ${llms.length}회`)); for (const span of llms) more.append(callButton(span)); calls.append(more); }
    const selected = group.spans.find(span => span.id === selectedSpan) || tools.find(span => tool(span) === "Edit") || tools.at(-1) || llms[0]; if (selected) evidence(selected);
  }
  async function load(id) { execution = id ? await api(`executions/${id}`) : null; selectedGroup = ""; selectedSpan = ""; render(); }
  async function listing(preferred) {
    const { executions } = await api("executions"), picker = $("#execution-select"); picker.replaceChildren();
    for (const run of executions) { const option = el("option", `${run.title} · ${new Date(run.importedAt).toLocaleString("ko-KR")}`); option.value = run.id; picker.append(option); }
    picker.value = executions.some(row => row.id === preferred) ? preferred : executions[0]?.id || "";
    picker.disabled = !executions.length; await load(picker.value);
  }
  $("#execution-select").addEventListener("change", () => { void load($("#execution-select").value).catch(error => notice(error.message)); });
  $("#import-execution").addEventListener("click", () => $("#import-dialog").showModal());
  $("#import-form").addEventListener("submit", async event => {
    event.preventDefault(); const button = $("#import-submit"); button.disabled = true;
    try {
      const file = $("#trace-file").files[0]; if (!file || file.size > 4 * 1024 * 1024) throw new Error("4MiB 이하 JSON 파일을 선택해 주세요.");
      const document = JSON.parse(await file.text());
      const run = await api("executions", { document, includeContent: $("#trace-content").checked });
      await listing(run.id); $("#import-dialog").close(); $("#import-form").reset(); notice();
    } catch (error) { notice(error.message); } finally { button.disabled = false; }
  });
  mode(true); await listing();
  return () => listing(execution?.id);
}

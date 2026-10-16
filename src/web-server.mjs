import path from "node:path";
import { DockOrderStore } from "./dock-order.mjs";
import { applyOverviewOrder, reconcileOverviewOrder, moveOverviewSession, formatClaudeUsage, formatCodexUsage } from "./overview.mjs";
import crypto from "node:crypto";
import { NativeExecutionCollector } from "./native-execution.mjs";
import http from "node:http";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RunStore } from "./run-store.mjs";
import { WorkStore } from "./work-store.mjs";
import { sampleResources } from "./resource-gate.mjs";
import { ExecutionStore } from "./execution-store.mjs";
import { WorkflowStore } from "./workflow-store.mjs";
import { installWebTerminal } from "./web-terminal.mjs";
import { historyStreams } from "./history-stream.mjs";

const ASSETS = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/drafts.mjs", ["drafts.mjs", "text/javascript; charset=utf-8"]],
  ["/conversation.mjs", ["conversation.mjs", "text/javascript; charset=utf-8"]],
  ["/works.mjs", ["works.mjs", "text/javascript; charset=utf-8"]],
  ["/history-stream.mjs", ["history-stream.mjs", "text/javascript; charset=utf-8"]],
  ["/executions.mjs", ["executions.mjs", "text/javascript; charset=utf-8"]],
  ["/sortable.mjs", [new URL(import.meta.resolve("sortablejs/modular/sortable.esm.js")), "text/javascript; charset=utf-8"]],
  ["/app.mjs", ["app.mjs", "text/javascript; charset=utf-8"]],
  ["/native-question.mjs", ["native-question.mjs", "text/javascript; charset=utf-8"]],
  ["/terminal.mjs", ["terminal.mjs", "text/javascript; charset=utf-8"]],
  ["/xterm.mjs", [new URL(import.meta.resolve("@xterm/xterm/lib/xterm.mjs")), "text/javascript; charset=utf-8"]],
  ["/xterm-fit.mjs", [new URL(import.meta.resolve("@xterm/addon-fit/lib/addon-fit.mjs")), "text/javascript; charset=utf-8"]],
  ["/xterm.css", [new URL(import.meta.resolve("@xterm/xterm/css/xterm.css")), "text/css; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
]);
const COOKIE = "waga_web";
const fail = (status, message) => Object.assign(new Error(message), { status });
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function sameSecret(left, right) {
  return typeof left === "string" && Buffer.byteLength(left) === Buffer.byteLength(right)
    && crypto.timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

async function body(request, limit = 64 * 1024) {
  if (request.headers["content-type"]?.split(";", 1)[0] !== "application/json") throw fail(415, "JSON 요청이 필요합니다.");
  const pieces = [];
  let size = 0;
  for await (const piece of request) {
    size += piece.length;
    if (size > limit) throw fail(413, "입력이 너무 큽니다.");
    pieces.push(piece);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(pieces).toString("utf8")); }
  catch { throw fail(400, "JSON을 읽을 수 없습니다."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail(400, "잘못된 요청입니다.");
  return value;
}

const workspaceOf = session => path.resolve(session.projectCwd || session.cwd);

function publicSession(session) {
  const { id, provider, name, cwd, status, updatedAt } = session;
  return { id, provider, name, cwd, workspace: workspaceOf(session), status, updatedAt, canControl: true };
}

// Native providers own sessions and decisions; the web attaches their frontend.
export async function startWebServer({ bridge, cwd = process.cwd(), filterCwd, port = 4317,
  token = crypto.randomBytes(32).toString("hex"), now = Date.now, workflowStore = new WorkflowStore(), executionStore = new ExecutionStore(), runStore = new RunStore(), workStore = new WorkStore(), orderStore = new DockOrderStore(), terminalFactory } = {}) {
  if (!bridge) throw new TypeError("A session bridge is required");
  const assets = new Map(await Promise.all([...ASSETS].map(async ([route, [file, type]]) =>
    [route, { type, data: await fs.readFile(file instanceof URL ? file : new URL(`./web/${file}`, import.meta.url)) }])));
  const jobs = new Map(), previews = new Map();
  let viewOrder = new Map();
  const orderedSessions = sessions => {
    for (const [workspace, ids] of orderStore.load()) viewOrder.set(workspace, ids);
    viewOrder = reconcileOverviewOrder(viewOrder, [...sessions].sort((a, b) => workspaceOf(a).localeCompare(workspaceOf(b))));
    return applyOverviewOrder(sessions, viewOrder);
  };
  let snapshot = null, discovering = null, readingRequests = null, requestsSnapshot = null;
  let active = 0, closing = false, closed = null;
  const collector = new NativeExecutionCollector({ bridge, store: executionStore });
  const streams = historyStreams(bridge);
  const discover = async () => {
    if (snapshot && now() - snapshot.at < 5_000) return snapshot.value;
    if (!discovering) discovering = Promise.resolve().then(() => bridge.discover({ cwd: filterCwd, includeUsage: true }))
      .then(value => { snapshot = { at: now(), value }; return value; }).finally(() => { discovering = null; });
    return discovering;
  };
  const recent = async () => {
    if (requestsSnapshot && now() - requestsSnapshot.at < 2_000) return requestsSnapshot.value;
    if (!readingRequests) readingRequests = Promise.resolve().then(() => bridge.recentRequests())
      .then(value => { requestsSnapshot = { at: now(), value }; return value; }).finally(() => { readingRequests = null; });
    return readingRequests;
  };
  const preview = async session => {
    const key = `${session.id}\n${session.cwd}`;
    const existing = previews.get(key);
    if (existing && (existing.pending || now() - existing.at < 5_000)) return existing.pending ?? existing.value;
    const entry = { at: now() };
    entry.pending = Promise.resolve().then(() => bridge.preview(session)).then(value => {
      entry.value = { input: value.input, output: value.output, limited: Boolean(value.limited), observedAt: now() };
      return entry.value;
    }).catch(error => { previews.delete(key); throw error; }).finally(() => { entry.pending = null; });
    previews.set(key, entry);
    if (previews.size > 20) previews.delete(previews.keys().next().value);
    return entry.pending;
  };
  const json = (response, status, value) => {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(value));
  };
  let origin;
  const server = http.createServer({ maxHeaderSize: 8192, requestTimeout: 15_000 }, async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      if (request.headers.host !== new URL(origin).host) throw fail(403, "로컬 주소로 접속해 주세요.");
      if (request.headers.origin && request.headers.origin !== origin) throw fail(403, "다른 웹사이트의 요청은 허용하지 않습니다.");
      const url = new URL(request.url, origin);
      if (request.method === "GET" && assets.has(url.pathname)) {
        const asset = assets.get(url.pathname);
        response.writeHead(200, { "Content-Type": asset.type }); response.end(asset.data); return;
      }
      const runMatch = /^\/api\/runs\/([^/]+)(?:\/(events|traces|control))?$/.exec(url.pathname);
      const bearer = request.headers.authorization?.startsWith("Bearer ") ? request.headers.authorization.slice(7) : "";
      const nativeRun = !request.headers.origin && ((url.pathname === "/api/runs" && sameSecret(bearer, token))
        || (runMatch && runMatch[2] !== "control" && runStore.authenticates(runMatch[1], bearer)));
      if (request.method === "POST" && !nativeRun && request.headers.origin !== origin) throw fail(403, "동일한 웹 화면에서 요청해 주세요.");
      if (request.method === "POST" && url.pathname === "/api/auth") {
        if (!sameSecret((await body(request)).token, token)) throw fail(401, "실행 시 표시된 접속 링크를 열어 주세요.");
        response.setHeader("Set-Cookie", `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`);
        json(response, 200, { authenticated: true }); return;
      }
      const cookie = request.headers.cookie?.split(/;\s*/).find(value => value.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
      if (!nativeRun && !sameSecret(cookie, token)) throw fail(401, "실행 시 표시된 접속 링크를 열어 주세요.");
      if (closing) throw fail(503, "웹 서버가 종료 중입니다.");
      const scopeId = url.searchParams.get("session");
      const scopeSession = scopeId ? (await discover()).sessions.find(row => row.id === scopeId) : null;
      if (scopeId && !scopeSession) throw fail(404, "세션을 찾을 수 없습니다.");
      const scopeCwd = scopeSession ? workspaceOf(scopeSession) : cwd;
      const scopeFolders = scopeSession ? [...new Set([scopeCwd, scopeSession.cwd])] : [cwd];
      const belongs = row => {
        if (!scopeSession) return true;
        if (row.workId && workStore.read(row.workId).session.id === scopeSession.id) return true;
        const ids = new Set([scopeSession.id, scopeSession.nativeId, scopeSession.sessionId].filter(Boolean));
        const spans = row.spans ?? row.traceSpans ?? [];
        return ids.has(row.sessionId) || spans.some(span => [span.attributes?.["session.id"], span.attributes?.["gen_ai.conversation.id"]].some(id => ids.has(id)))
          || row.nodes?.some(node => node.sessions?.some(session => ids.has(session.id)) || node.attempts.some(attempt => ids.has(attempt.worker?.sessionId) || ids.has(attempt.review?.sessionId)));
      };
      const runInScope = row => belongs(row) && (scopeFolders.includes(row.cwd)
        || Boolean(scopeSession && row.workId && workStore.read(row.workId).session.id === scopeSession.id));
      if (request.method === "GET" && url.pathname === "/api/resources") { json(response, 200, sampleResources()); return; }
      if (url.pathname === "/api/works") {
        if (!scopeSession) throw fail(400, "작업의 담당 세션이 필요합니다.");
        if (request.method === "POST") {
          const input = await body(request);
          const history = await bridge.history(scopeSession, { activities: false });
          json(response, 201, workStore.create(input, scopeSession, history.messages)); return;
        }
        if (request.method === "GET") {
          const history = workStore.list(scopeSession.id).some(row => !row.messageId && row.submitAttemptedAt) ? await bridge.history(scopeSession, { activities: false }) : null;
          json(response, 200, { works: history ? workStore.reconcile(scopeSession.id, history.messages) : workStore.list(scopeSession.id) }); return;
        }
      }
      const workMatch = /^\/api\/works\/([^/]+)$/.exec(url.pathname);
      if (workMatch) {
        const work = workStore.read(workMatch[1]);
        if (!scopeSession || work.session.id !== scopeSession.id) throw fail(404, "현재 세션의 작업이 아닙니다.");
        if (request.method === "POST") { json(response, 200, workStore.references(work.id, (await body(request)).references)); return; }
        if (request.method === "GET") {
          const instructions = workStore.list(work.session.id).filter(row => (row.rootId ?? row.id) === (work.rootId ?? work.id));
          const ids = new Set(instructions.map(row => row.id));
          const runs = runStore.list(cwd).map(row => runStore.read(row.id)).filter(row => ids.has(row.workId));
          json(response, 200, { ...work, instructions: instructions.map(({ id, instruction, createdAt, parentId }) => ({ id, instruction, createdAt, parentId })), runs }); return;
        }
      }
      if (request.method === "GET" && url.pathname === "/api/runs") { json(response, 200, { runs: [...new Set([...scopeFolders, cwd])].flatMap(folder => runStore.list(folder)).filter(row => runInScope(runStore.read(row.id))) }); return; }
      if (request.method === "POST" && url.pathname === "/api/runs") {
        const input = await body(request);
        if (input.workId) {
          const work = workStore.read(input.workId);
          if (![work.session.cwd, work.session.workspace].includes(input.sourceCwd ?? cwd)) throw fail(409, "지시를 받은 작업 폴더를 sourceCwd에 지정해 주세요.");
        }
        json(response, 201, runStore.create(input, cwd)); return;
      }
      if (runMatch) {
        const row = runStore.read(runMatch[1]);
        if (!runInScope(row)) throw fail(404, "현재 세션의 실행이 아닙니다.");
        if (request.method === "GET" && !runMatch[2]) { json(response, 200, row); return; }
        if (request.method === "POST") {
          if (runMatch[2] === "traces") { runStore.trace(row.id, await body(request, 4 * 1024 * 1024)); json(response, 200, {}); return; }
          if (runMatch[2] === "events") { json(response, 200, runStore.event(row.id, await body(request))); return; }
          if (runMatch[2] === "control" && !nativeRun) { json(response, 200, runStore.control(row.id, await body(request))); return; }
        }
      }
      if (request.method === "GET" && url.pathname === "/api/executions") {
        json(response, 200, { executions: scopeFolders.flatMap(folder => executionStore.list(folder)).filter(row => belongs(executionStore.read(row.id))) }); return;
      }
      if (request.method === "POST" && url.pathname === "/api/executions") {
        json(response, 201, executionStore.import(await body(request, 4 * 1024 * 1024), scopeCwd)); return;
      }
      const executionMatch = /^\/api\/executions\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && executionMatch) {
        const row = executionStore.read(executionMatch[1]);
        if (!scopeFolders.includes(row.cwd) || !belongs(row)) throw fail(404, "현재 세션의 기록이 아닙니다.");
        json(response, 200, row); return;
      }
      if (request.method === "GET" && url.pathname === "/api/workflows") {
        json(response, 200, { workflows: workflowStore.list(cwd) }); return;
      }
      if (request.method === "POST" && url.pathname === "/api/workflows") {
        json(response, 201, workflowStore.create({ title: (await body(request)).title, cwd })); return;
      }
      const workflowMatch = /^\/api\/workflows\/([^/]+)$/.exec(url.pathname);
      if (request.method === "POST" && workflowMatch) {
        const input = await body(request), id = workflowMatch[1];
        if (workflowStore.read(id).cwd !== cwd) throw fail(404, "현재 작업 폴더의 기록이 아닙니다.");
        if (input.action === "assign" && input.sessionId && !(await discover()).sessions.some(row => row.id === input.sessionId)) throw fail(404, "연결할 세션을 찾을 수 없습니다.");
        if (input.action === "commit") {
          if (!/^[0-9a-f]{40}$/i.test(input.commit ?? "")) throw fail(400, "전체 Git SHA가 필요합니다.");
          try { await promisify(execFile)("git", ["-C", cwd, "cat-file", "-e", `${input.commit}^{commit}`], { timeout: 2000, maxBuffer: 4096 }); }
          catch { throw fail(400, "현재 저장소에 존재하는 커밋을 지정해 주세요."); }
        }
        json(response, 200, workflowStore.update(id, input)); return;
      }
      const operationMatch = /^\/api\/operations\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && operationMatch) {
        const job = jobs.get(operationMatch[1]);
        if (!job) throw fail(404, "웹 실행 기록이 없습니다. 연결한 작업 단계에서 답변을 확인해 주세요.");
        json(response, 200, job); return;
      }
      if (request.method === "GET" && url.pathname === "/api/sessions") {
        const { sessions, warnings, providerUsage = {} } = await discover();
        const usage = [["claude", formatClaudeUsage], ["codex", formatCodexUsage]].map(([provider, format]) => ({
          provider, label: format(providerUsage[provider]), observedAt: providerUsage[provider]?.observedAt ?? null,
        }));
        json(response, 200, { sessions: orderedSessions(sessions).map(publicSession), warnings, cwd, usage }); return;
      }
      const actionMatch = /^\/api\/sessions\/([^/]+)\/(order|rename|archive|connection|terminal)$/.exec(url.pathname);
      if (request.method === "POST" && actionMatch) {
        const input = await body(request), { sessions } = await discover();
        const selected = sessions.find(row => row.id === decodeURIComponent(actionMatch[1]));
        if (!selected) throw fail(404, "세션을 찾을 수 없습니다.");
        const action = actionMatch[2];
        if (action === "terminal") { json(response, 200, terminals.ticket(selected.id, { observe: input.observe === true })); return; }
        if (action === "order") {
          if (input.targetId === undefined && !["up", "down"].includes(input.direction)) throw fail(400, "이동할 위치를 지정해 주세요.");
          orderedSessions(sessions);
          const workspace = workspaceOf(selected), order = viewOrder;
          const peers = applyOverviewOrder(sessions, order).filter(row => workspaceOf(row) === workspace).map(row => row.id);
          const visible = input.visibleIds ?? peers;
          if (!Array.isArray(visible) || !visible.includes(selected.id) || new Set(visible).size !== visible.length || visible.some(id => !peers.includes(id))) throw fail(400, "같은 폴더의 세션만 이동할 수 있습니다.");
          // The server's current saved order is authoritative, including during concurrent browser requests.
          let moved;
          if (input.targetId !== undefined) {
            if (input.targetId === selected.id || !visible.includes(input.targetId) || !["before", "after"].includes(input.position)) throw fail(400, "같은 폴더 안의 놓을 위치를 지정해 주세요.");
            const previous = order.get(workspace), ids = previous.filter(id => id !== selected.id);
            const destination = ids.indexOf(input.targetId) + (input.position === "after" ? 1 : 0);
            ids.splice(destination, 0, selected.id);
            moved = ids.some((id, index) => id !== previous[index]) ? new Map(order).set(workspace, ids) : null;
          } else moved = moveOverviewSession(order, workspace, selected.id, input.direction, peers.filter(id => visible.includes(id)));
          if (moved) orderStore.saveWorkspace(workspace, moved.get(workspace));
          json(response, 200, { moved: Boolean(moved), sessions: orderedSessions(sessions).map(publicSession) }); return;
        }
        if (action === "connection") { json(response, 200, await bridge.connection(selected.id, { cwd: filterCwd })); return; }
        if (action === "rename") {
          if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 200 || /[\x00-\x1f]/.test(input.name)) throw fail(400, "이름은 줄바꿈 없이 1~200자로 입력해 주세요.");
          const result = await bridge.rename(selected.id, input.name.trim(), { cwd: filterCwd });
          snapshot = null; json(response, 200, { result }); return;
        }
        if (selected.status === "working" || [...jobs.values()].some(job => !job.finished && job.target === selected.id)) throw fail(409, "작업 중인 세션은 보관할 수 없습니다.");
        const result = await bridge.archive(selected.id, { cwd: filterCwd });
        snapshot = null; json(response, 200, { result }); return;
      }
      const match = /^\/api\/sessions\/([^/]+)\/preview$/.exec(url.pathname);
      if (request.method === "GET" && match) {
        const session = (await discover()).sessions.find(row => row.id === decodeURIComponent(match[1]));
        if (!session) throw fail(404, "세션을 찾을 수 없습니다.");
        json(response, 200, await preview(session)); return;
      }
      const eventsMatch = /^\/api\/sessions\/([^/]+)\/events$/.exec(url.pathname);
      if (request.method === "GET" && eventsMatch) {
        const session = (await discover()).sessions.find(row => row.id === decodeURIComponent(eventsMatch[1]));
        if (!session) throw fail(404, "세션을 찾을 수 없습니다.");
        await streams.open(session, response); return;
      }
      const historyMatch = /^\/api\/sessions\/([^/]+)\/messages$/.exec(url.pathname);
      if (request.method === "GET" && historyMatch) {
        const session = (await discover()).sessions.find(row => row.id === decodeURIComponent(historyMatch[1]));
        if (!session) throw fail(404, "세션을 찾을 수 없습니다.");
        const cursor = url.searchParams.get("cursor");
        if (cursor !== null && (!cursor || cursor.length > 4096)) throw fail(400, "잘못된 대화 페이지입니다.");
        json(response, 200, await bridge.history(session, { cursor, activities: true })); return;
      }
      if (request.method === "GET" && url.pathname === "/api/requests") {
        const listing = await recent();
        json(response, 200, { ...listing, jobs: [...jobs.values()] }); return;
      }
      if (request.method !== "POST" || !["/api/instruct", "/api/query", "/api/create", "/api/recover"].includes(url.pathname)) throw fail(404, "없는 경로입니다.");
      const input = await body(request);
      if (!UUID.test(input.operationId ?? "")) throw fail(400, "요청 식별자가 필요합니다.");
      const previous = jobs.get(input.operationId);
      if (previous) {
        json(response, 202, { operationId: previous.operationId }); return;
      }
      if (active >= 2) throw fail(429, "진행 중인 요청이 끝난 뒤 보내 주세요.");
      const kind = url.pathname.slice(5);
      if (kind !== "recover" && (typeof input.message !== "string" || !input.message.trim() || input.message.length > 16_000)) throw fail(400, "1~16,000자의 내용을 입력해 주세요.");
      if (["query", "instruct"].includes(kind) && !/^(claude|codex):[^\s]{1,200}$/.test(input.target ?? "")) throw fail(400, "세션 ID가 필요합니다.");
      if (kind === "create" && !["claude", "codex"].includes(input.provider)) throw fail(400, "Claude 또는 Codex를 선택해 주세요.");
      if (kind === "recover" && !UUID.test(input.requestId ?? "")) throw fail(400, "요청 ID가 필요합니다.");
      if (input.workflowId !== undefined) {
        const flow = workflowStore.read(input.workflowId), node = flow.nodes.find(row => row.id === input.nodeId);
        if (flow.cwd !== cwd || !node) throw fail(404, "작업 단계를 찾을 수 없습니다.");
        if (["query", "instruct"].includes(kind) && node.sessionId !== input.target) throw fail(409, "단계에 연결된 세션과 질의 대상이 다릅니다.");
        if (kind === "recover" && !node.requests.some(row => row.requestId === input.requestId)) throw fail(409, "이 단계의 요청만 조회할 수 있습니다.");
        if (kind === "recover") input.target = node.requests.find(row => row.requestId === input.requestId).sessionId ?? node.sessionId;
        input.commit = flow.commit;
      }
      let createCwd = cwd;
      if (kind === "create" && input.workspace !== undefined) {
        if (input.workspace !== cwd && !(await discover()).sessions.some(row => workspaceOf(row) === input.workspace)) throw fail(400, "목록에 있는 프로젝트 폴더를 선택해 주세요.");
        createCwd = input.workspace;
      }
      const job = { operationId: input.operationId, kind, target: input.target, provider: input.provider,
        workflowId: input.workflowId, nodeId: input.nodeId,
        requestId: input.requestId, state: "starting", createdAt: now(), updatedAt: now(), events: [] };
      while (jobs.size >= 100) {
        const removable = [...jobs.values()].find(row => row.finished);
        if (!removable) break;
        jobs.delete(removable.operationId);
      }
      jobs.set(job.operationId, job); active++;
      const attach = () => {
        if (job.workflowId) workflowStore.attach(job.workflowId, job.nodeId, {
          operationId: job.operationId, requestId: job.requestId, state: job.state, reply: job.result?.reply, error: job.error?.message, commit: input.commit, sessionId: job.target,
        });
      };
      const progress = event => {
        // Persisted RequestStore metadata remains the recovery authority after restart.
        const previousRequestId = job.requestId;
        job.state = event.state ?? job.state; job.requestId = event.requestId ?? job.requestId;
        job.updatedAt = now();
        job.events.push({ state: event.state, message: event.message, at: job.updatedAt });
        if (job.events.length > 40) job.events.shift();
        if (job.requestId && job.requestId !== previousRequestId) {
          try { attach(); } catch (error) { job.storageError = error.message; }
        }
      };
      const operation = async () => {
        try {
          attach();
          if (["query", "instruct"].includes(kind)) job.result = await bridge[kind === "instruct" ? "instruct" : "ask"](input.target, input.message, {
            cwd: filterCwd, waitTimeoutMs: 30_000, replyTimeoutMs: kind === "instruct" ? 30 * 60_000 : 180_000, onProgress: progress,
          });
          else if (kind === "create") {
            const created = await bridge.create(input.provider, input.message, { cwd: createCwd, routing: {}, onProgress: progress });
            job.result = { provider: created.provider, nativeId: created.nativeId, turnId: created.turnId,
              session: created.session ? publicSession(created.session) : undefined };
            job.target = created.session?.id ?? `${created.provider}:${created.nativeId}`;
            snapshot = null;
            if (job.workflowId) {
              const flow = workflowStore.read(job.workflowId);
              workflowStore.update(job.workflowId, { revision: flow.revision, action: "assign", nodeId: job.nodeId,
                sessionId: created.session?.id ?? `${created.provider}:${created.nativeId}` });
            }
          } else job.result = await bridge.result(input.requestId);
          job.requestId = job.result.requestId ?? job.requestId;
          job.state = job.result.state ?? (kind === "create" ? "created" : "replied");
        } catch (error) {
          job.state = "error"; job.requestId = error.requestId ?? job.requestId;
          job.error = { code: error.code ?? "REQUEST_FAILED", message: (error.stderr?.trim() || error.message).slice(0, 1_000), delivery: error.delivery };
        } finally {
          job.finished = true; job.updatedAt = now(); requestsSnapshot = null; active--;
          try { attach(); } catch (error) { job.storageError = `단계 기록 저장 실패: ${error.message}`; }
        }
      };
      // The response does not own the exchange: browser disconnection never resends or cancels it.
      void operation();
      json(response, 202, { operationId: job.operationId });
    } catch (error) {
      if (!response.headersSent) json(response, error.status ?? 502, { error: { message: error.message, code: error.code } });
      else response.end();
    }
  });
  const terminals = installWebTerminal(server, {
    now, terminalFactory,
    beforeSubmit: (id, target) => workStore.submitted(id, target),
    afterSubmit: id => workStore.delivered(id),
    authorize: request => request.headers.host === new URL(origin).host && request.headers.origin === origin
      && sameSecret(request.headers.cookie?.split(/;\s*/).find(value => value.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1), token),
    connection: target => bridge.connection(target, { cwd: filterCwd }),
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  const collect = async () => { try { if (!closing && typeof bridge.execution === "function") await collector.sweep((await discover()).sessions); } catch { /* Discovery errors remain visible through the sessions API. */ } };
  const collectionTimer = setInterval(() => { void collect(); }, 5_000); collectionTimer.unref();
  void collect();
  return { server, origin, url: `${origin}/#${token}`, close() {
    closing = true;
    clearInterval(collectionTimer); collector.close();
    streams.close(); terminals.close();
    closed ??= new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    return closed;
  } };
}

export async function serveWeb(options) {
  const web = await startWebServer(options);
  await new Promise(resolve => {
    const stop = () => { void web.close().then(resolve); };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    web.server.once("close", () => {
      process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); resolve();
    });
    options.output?.write(`Waga web: ${options.showToken === false ? `${web.origin}/` : web.url}\n`);
  });
  return 0;
}

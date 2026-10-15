import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ExecutionStore } from "./execution-store.mjs";
import { WorkflowStore } from "./workflow-store.mjs";

const ASSETS = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/conversation.mjs", ["conversation.mjs", "text/javascript; charset=utf-8"]],
  ["/executions.mjs", ["executions.mjs", "text/javascript; charset=utf-8"]],
  ["/app.mjs", ["app.mjs", "text/javascript; charset=utf-8"]],
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

function publicSession(session) {
  const { id, provider, name, cwd, status, updatedAt } = session;
  return { id, provider, name, cwd, status, updatedAt };
}

// HTTP is a view/controller only. Native providers keep owning sessions and approval UI.
export async function startWebServer({ bridge, cwd = process.cwd(), filterCwd, port = 4317,
  token = crypto.randomBytes(32).toString("hex"), now = Date.now, workflowStore = new WorkflowStore(), executionStore = new ExecutionStore() } = {}) {
  if (!bridge) throw new TypeError("A session bridge is required");
  const assets = new Map(await Promise.all([...ASSETS].map(async ([route, [file, type]]) =>
    [route, { type, data: await fs.readFile(new URL(`./web/${file}`, import.meta.url)) }])));
  const jobs = new Map(), previews = new Map();
  let snapshot = null, discovering = null, readingRequests = null, requestsSnapshot = null;
  let active = 0, closing = false, closed = null;
  const discover = async () => {
    if (snapshot && now() - snapshot.at < 5_000) return snapshot.value;
    if (!discovering) discovering = Promise.resolve().then(() => bridge.discover({ cwd: filterCwd }))
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
      if (request.method === "POST" && request.headers.origin !== origin) throw fail(403, "동일한 웹 화면에서 요청해 주세요.");
      if (request.method === "POST" && url.pathname === "/api/auth") {
        if (!sameSecret((await body(request)).token, token)) throw fail(401, "실행 시 표시된 접속 링크를 열어 주세요.");
        response.setHeader("Set-Cookie", `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`);
        json(response, 200, { authenticated: true }); return;
      }
      const cookie = request.headers.cookie?.split(/;\s*/).find(value => value.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
      if (!sameSecret(cookie, token)) throw fail(401, "실행 시 표시된 접속 링크를 열어 주세요.");
      if (closing) throw fail(503, "웹 서버가 종료 중입니다.");
      if (request.method === "GET" && url.pathname === "/api/executions") {
        json(response, 200, { executions: executionStore.list(cwd) }); return;
      }
      if (request.method === "POST" && url.pathname === "/api/executions") {
        json(response, 201, executionStore.import(await body(request, 4 * 1024 * 1024), cwd)); return;
      }
      const executionMatch = /^\/api\/executions\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && executionMatch) {
        const row = executionStore.read(executionMatch[1]);
        if (row.cwd !== cwd) throw fail(404, "현재 작업 폴더의 기록이 아닙니다.");
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
        const { sessions, warnings } = await discover();
        json(response, 200, { sessions: sessions.map(publicSession), warnings, cwd }); return;
      }
      const match = /^\/api\/sessions\/([^/]+)\/preview$/.exec(url.pathname);
      if (request.method === "GET" && match) {
        const session = (await discover()).sessions.find(row => row.id === decodeURIComponent(match[1]));
        if (!session) throw fail(404, "세션을 찾을 수 없습니다.");
        json(response, 200, await preview(session)); return;
      }
      if (request.method === "GET" && url.pathname === "/api/requests") {
        const listing = await recent();
        json(response, 200, { ...listing, jobs: [...jobs.values()] }); return;
      }
      if (request.method !== "POST" || !["/api/query", "/api/create", "/api/recover"].includes(url.pathname)) throw fail(404, "없는 경로입니다.");
      const input = await body(request);
      if (!UUID.test(input.operationId ?? "")) throw fail(400, "요청 식별자가 필요합니다.");
      const previous = jobs.get(input.operationId);
      if (previous) {
        json(response, 202, { operationId: previous.operationId }); return;
      }
      if (active >= 2) throw fail(429, "진행 중인 요청이 끝난 뒤 보내 주세요.");
      const kind = url.pathname.slice(5);
      if (kind !== "recover" && (typeof input.message !== "string" || !input.message.trim() || input.message.length > 16_000)) throw fail(400, "1~16,000자의 내용을 입력해 주세요.");
      if (kind === "query" && !/^(claude|codex):[^\s]{1,200}$/.test(input.target ?? "")) throw fail(400, "세션 ID가 필요합니다.");
      if (kind === "create" && !["claude", "codex"].includes(input.provider)) throw fail(400, "Claude 또는 Codex를 선택해 주세요.");
      if (kind === "recover" && !UUID.test(input.requestId ?? "")) throw fail(400, "요청 ID가 필요합니다.");
      if (input.workflowId !== undefined) {
        const flow = workflowStore.read(input.workflowId), node = flow.nodes.find(row => row.id === input.nodeId);
        if (flow.cwd !== cwd || !node) throw fail(404, "작업 단계를 찾을 수 없습니다.");
        if (kind === "query" && node.sessionId !== input.target) throw fail(409, "단계에 연결된 세션과 질의 대상이 다릅니다.");
        if (kind === "recover" && !node.requests.some(row => row.requestId === input.requestId)) throw fail(409, "이 단계의 요청만 조회할 수 있습니다.");
        if (kind === "recover") input.target = node.requests.find(row => row.requestId === input.requestId).sessionId ?? node.sessionId;
        input.commit = flow.commit;
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
          if (kind === "query") job.result = await bridge.ask(input.target, input.message, {
            cwd: filterCwd, waitTimeoutMs: 30_000, replyTimeoutMs: 180_000, onProgress: progress,
          });
          else if (kind === "create") {
            const created = await bridge.create(input.provider, input.message, { cwd, routing: {}, onProgress: progress });
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
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { server, origin, url: `${origin}/#${token}`, close() {
    closing = true;
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
    options.output?.write(`Waga web: ${web.url}\n`);
  });
  return 0;
}

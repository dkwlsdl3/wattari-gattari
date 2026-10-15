import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeExecution } from "./execution-store.mjs";
import { APP_ID } from "./product.mjs";

const fail = (status, message) => Object.assign(new Error(message), { status });
const validId = value => typeof value === "string" && /^[0-9a-f-]{36}$/.test(value);
const text = (value, max = 160) => {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw fail(400, "실행 명세의 문자열을 확인해 주세요.");
  return value.trim();
};
export function artifactPath(value) {
  if (typeof value !== "string" || value.length > 500 || value.includes("\\") || value.split("/").some(part => !part || part === "." || part === "..") || value.startsWith(".git/" ) || value === ".git") throw fail(400, "산출물에는 저장소 안의 상대 파일 경로가 필요합니다.");
  return value;
}
export function validateRun(input) {
  if (!input || !Array.isArray(input.nodes) || !input.nodes.length || input.nodes.length > 50) throw fail(400, "작업은 1~50개가 필요합니다.");
  if (input.models !== undefined && (!input.models || typeof input.models !== "object" || Array.isArray(input.models) || Object.keys(input.models).some(key => !["plan", "scan", "edit", "verify"].includes(key)))) throw fail(400, "모델 역할을 확인해 주세요.");
  const roles = { plan: "opus", scan: "haiku", edit: "sonnet", verify: "sonnet", ...(input.models ?? {}) };
  for (const model of Object.values(roles)) if (!/^[\w.-]{1,100}$/.test(model)) throw fail(400, "모델 이름을 확인해 주세요.");
  const nodes = input.nodes.map(node => {
    if (!node || typeof node !== "object" || ["outputs", "inputs", "dependsOn"].some(key => node[key] !== undefined && !Array.isArray(node[key])) || node.inputs?.some(item => !item || typeof item !== "object")) throw fail(400, "작업과 입출력 배열을 확인해 주세요.");
    const id = text(node.id, 64);
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || !["scan", "edit", "plan", "verify"].includes(node.role)) throw fail(400, "작업 ID와 역할을 확인해 주세요.");
    if (!Array.isArray(node.check) || !node.check.length || node.check.length > 30 || node.check.some(arg => typeof arg !== "string" || arg.length > 2000 || arg.includes("\0"))) throw fail(400, "검사 명령은 실행 파일과 인자 배열이 필요합니다.");
    const outputs = (node.outputs ?? []).map(artifactPath), inputs = (node.inputs ?? []).map(item => ({ from: text(item.from, 64), path: artifactPath(item.path) }));
    if (outputs.length > 30 || inputs.length > 60 || (node.role !== "edit" && outputs.length)) throw fail(400, "읽기 역할에는 변경 산출물을 지정할 수 없습니다.");
    return { id, title: text(node.title), role: node.role, prompt: text(node.prompt, 12000), check: node.check,
      dependsOn: [...new Set([...(node.dependsOn ?? []).map(value => text(value, 64)), ...inputs.map(item => item.from)])], inputs, outputs };
  });
  const byId = new Map(nodes.map(node => [node.id, node]));
  if (byId.size !== nodes.length) throw fail(400, "작업 ID가 중복됐습니다.");
  const visited = new Set(), visiting = new Set();
  function visit(node) {
    if (visiting.has(node.id)) throw fail(400, "작업 의존성이 순환합니다.");
    if (visited.has(node.id)) return;
    visiting.add(node.id);
    for (const id of node.dependsOn) { if (!byId.has(id)) throw fail(400, "선행 작업이 없습니다."); visit(byId.get(id)); }
    for (const item of node.inputs) if (!byId.get(item.from).outputs.includes(item.path)) throw fail(400, "선행 작업이 선언한 산출물만 입력할 수 있습니다.");
    visiting.delete(node.id); visited.add(node.id);
  }
  nodes.forEach(visit);
  const reserveGiB = Number(input.resources?.reserveGiB ?? 6), maxCpuPercent = Number(input.resources?.maxCpuPercent ?? 80);
  if (!Number.isFinite(reserveGiB) || reserveGiB < 4.5 || reserveGiB > 128 || !Number.isFinite(maxCpuPercent) || maxCpuPercent < 10 || maxCpuPercent > 90) throw fail(400, "여유 메모리는 4.5~128GiB, CPU 사용률 상한은 10~90%입니다.");
  const maxAttempts = input.maxAttempts ?? 5;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) throw fail(400, "최대 시도는 1~5회입니다.");
  if (input.sourceCwd !== undefined && (typeof input.sourceCwd !== "string" || !path.isAbsolute(input.sourceCwd) || input.sourceCwd.length > 2000)) throw fail(400, "sourceCwd는 절대 경로여야 합니다.");
  return { ...(input.sourceCwd ? { sourceCwd: input.sourceCwd } : {}), title: text(input.title), nodes, models: roles, includeContent: input.includeContent === true, resources: { reserveGiB, maxCpuPercent }, maxAttempts };
}
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
export class RunStore {
  constructor(directory = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), APP_ID, "runs")) { this.directory = directory; }
  #file(id) { if (!validId(id)) throw fail(400, "잘못된 실행 ID입니다."); return path.join(this.directory, `${id}.json`); }
  read(id, privateFields = false) {
    let fd;
    try { fd = fs.openSync(this.#file(id), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
    catch (error) { if (error.code === "ENOENT") throw fail(404, "실행이 없습니다."); throw error; }
    try {
      const stat = fs.fstatSync(fd); if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw fail(500, "실행 기록을 읽을 수 없습니다.");
      const row = JSON.parse(fs.readFileSync(fd, "utf8"));
      if (row.id !== id || row.version !== 1) throw fail(500, "실행 기록 형식이 잘못됐습니다.");
      if (!privateFields) delete row.secretHash;
      return row;
    } finally { fs.closeSync(fd); }
  }
  #write(row) {
    const data = JSON.stringify(row); if (Buffer.byteLength(data) > 8 * 1024 * 1024) throw fail(413, "실행 기록 용량 한도입니다.");
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 }); const stat = fs.lstatSync(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw fail(500, "실행 경로는 본인 소유 비공개 디렉터리여야 합니다.");
    const file = this.#file(row.id), tmp = `${file}.${crypto.randomUUID()}.tmp`;
    try { fs.writeFileSync(tmp, data, { mode: 0o600, flag: "wx" }); fs.renameSync(tmp, file); }
    finally { fs.rmSync(tmp, { force: true }); }
    return this.read(row.id);
  }
  list(cwd) {
    let files; try { files = fs.readdirSync(this.directory); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
    return files.filter(file => /^[0-9a-f-]{36}\.json$/.test(file)).map(file => this.read(file.slice(0, -5))).filter(row => row.cwd === cwd)
      .sort((a, b) => b.updatedAt - a.updatedAt).map(({ id, title, state, revision, updatedAt, nodes }) => ({ id, title, state, revision, updatedAt, passed: nodes.filter(node => node.state === "passed").length, total: nodes.length }));
  }
  create(input, cwd) {
    if (this.list(cwd).length >= 100) throw fail(409, "실행은 100개까지 보관합니다.");
    const manifest = validateRun(input), secret = crypto.randomBytes(32).toString("hex"), now = Date.now();
    const run = this.#write({ version: 1, id: crypto.randomUUID(), ...manifest, definition: manifest, sourceCwd: manifest.sourceCwd ?? cwd, cwd, state: "planned", control: "run", createdAt: now, updatedAt: now,
      secretHash: digest(secret), revision: 1, processed: [], traces: [], nodes: manifest.nodes.map(node => ({ ...node, state: "pending", attempts: [], stalls: 0 })) });
    return { ...run, secret };
  }
  authenticates(id, secret) {
    const stored = this.read(id, true).secretHash, supplied = digest(typeof secret === "string" ? secret : "");
    return crypto.timingSafeEqual(Buffer.from(stored), Buffer.from(supplied));
  }
  control(id, input) {
    const row = this.read(id, true);
    if (input.action === "approve") {
      if (row.state !== "review_required") throw fail(409, "모든 작업의 검사·독립 검증이 통과해야 최종 확인할 수 있습니다.");
      row.state = "approved"; row.approvedAt = Date.now();
    } else if (["pause", "resume", "stop"].includes(input.action)) {
      if (["approved", "review_required"].includes(row.state)) throw fail(409, "종료된 실행입니다.");
      row.control = ({ pause: "pause", resume: "run", stop: "stop" })[input.action];
    } else if (input.action === "resources") {
      row.resources = validateRun({ title: row.title, nodes: row.nodes, resources: input.resources }).resources;
    } else throw fail(400, "지원하지 않는 실행 제어입니다.");
    row.updatedAt = Date.now(); row.revision++; return this.#write(row);
  }
  event(id, input) {
    const row = this.read(id, true);
    if (!validId(input.eventId)) throw fail(400, "이벤트 ID가 필요합니다.");
    if (row.processed.includes(input.eventId)) return this.read(id);
    if (row.processed.length >= 2000) throw fail(409, "실행 이벤트 한도입니다.");
    if (["approved", "review_required"].includes(row.state)) throw fail(409, "종료된 실행입니다.");
    const node = row.nodes.find(node => node.id === input.nodeId);
    if (input.type === "resource") {
      if (!input.sample || !Number.isFinite(input.sample.availableGiB) || input.sample.availableGiB < 0 || (input.sample.cpuPercent !== null && (!Number.isFinite(input.sample.cpuPercent) || input.sample.cpuPercent < 0 || input.sample.cpuPercent > 100))) throw fail(400, "자원 측정값을 확인해 주세요.");
      row.resource = input.sample; row.state = input.waiting ? "waiting-resource" : "running"; }
    else if (input.type === "start") { row.state = "running"; row.sourceCommit = text(input.sourceCommit, 40); }
    else if (input.type === "phase") {
      if (!node || node.state === "passed" || !["waiting-resource", "paused", "working", "checking", "verifying", "interrupted"].includes(input.state)) throw fail(409, "작업 상태를 바꿀 수 없습니다.");
      node.state = input.state; if (input.workspace) node.workspace = text(input.workspace, 2000);
    } else if (input.type === "session") {
      if (!node || node.state === "passed" || !validId(input.sessionId) || !["worker", "review"].includes(input.role)) throw fail(400, "native 세션 연결을 확인해 주세요.");
      node.sessions ??= []; node.sessions.push({ id: input.sessionId, role: input.role, attempt: node.attempts.length + 1 });
      if (node.sessions.length > row.maxAttempts * 4) throw fail(409, "세션 연결 한도입니다.");
    } else if (input.type === "attempt") {
      if (!node || node.state === "passed" || node.dependsOn.some(id => row.nodes.find(other => other.id === id).state !== "passed")) throw fail(409, "선행 작업이 통과해야 실행할 수 있습니다.");
      if (node.attempts.length >= row.maxAttempts || node.stalls >= 2) throw fail(409, "수정 한도에 도달했습니다. 재계획이 필요합니다.");
      const result = input.result;
      if (!result || !/^[a-f0-9]{64}$/.test(result.fingerprint ?? "") || !result.check || !Number.isInteger(result.check.exitCode) && result.check.exitCode !== null) throw fail(400, "구조화된 검사 결과와 산출물 지문이 필요합니다.");
      const review = result.review;
      const passed = result.worker?.exitCode === 0 && result.check.exitCode === 0 && !result.check.signal && review?.exitCode === 0 && review.verdict === "pass"
        && Boolean(review.sessionId) && Boolean(result.worker.sessionId) && review.sessionId !== result.worker.sessionId && review.unchanged === true;
      if (!passed && node.attempts.at(-1)?.fingerprint === result.fingerprint) node.stalls++; else node.stalls = 0;
      node.attempts.push({ ...result, passed, at: Date.now() }); node.state = passed ? "passed" : node.stalls >= 2 || node.attempts.length >= row.maxAttempts ? "needs-replan" : "failed";
    } else if (input.type === "end") {
      row.state = row.control === "stop" ? "stopped" : row.nodes.every(node => node.state === "passed") ? "review_required" : "needs-replan";
    } else throw fail(400, "지원하지 않는 실행 이벤트입니다.");
    row.processed.push(input.eventId); row.updatedAt = Date.now(); row.revision++; return this.#write(row);
  }
  trace(id, document) {
    const row = this.read(id, true), normalized = normalizeExecution(document, row.includeContent ?? false);
    const spans = new Map([...(row.traceSpans ?? []), ...normalized.spans].map(span => [span.id, span]));
    if (spans.size > 5000) throw fail(413, "실시간 span 한도입니다.");
    row.traceSpans = [...spans.values()]; row.updatedAt = Date.now(); row.revision++; return this.#write(row);
  }
}

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { APP_ID } from "./product.mjs";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const states = new Set(["pending", "active", "blocked", "passed"]);
const fail = (status, message) => Object.assign(new Error(message), { status });
const text = (value, max, required = false) => {
  if (typeof value !== "string" || value.length > max || (required && !value.trim())) throw fail(400, "입력 길이와 내용을 확인해 주세요.");
  return value.trim();
};
const stages = [["plan", "요구 확인"], ["implement", "구현"], ["verify", "검증"], ["review", "독립 리뷰"], ["integrate", "통합"]];

// Explicit work metadata only; never derive phase or success from a model reply.
export class WorkflowStore {
  constructor(directory = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), APP_ID, "workflows")) {
    this.directory = directory;
  }

  #file(id) {
    if (!UUID.test(id ?? "")) throw fail(400, "잘못된 작업 ID입니다.");
    return path.join(this.directory, `${id}.json`);
  }

  read(id) {
    let fd;
    try { fd = fs.openSync(this.#file(id), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
    catch (error) { if (error.code === "ENOENT") throw fail(404, "작업이 없습니다."); throw error; }
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 1024 * 1024) throw fail(500, "작업 기록을 읽을 수 없습니다.");
      const row = JSON.parse(fs.readFileSync(fd, "utf8"));
      if (row.version !== 1 || row.id !== id || !Array.isArray(row.nodes) || row.nodes.length !== stages.length) throw fail(500, "작업 기록 형식이 잘못됐습니다.");
      return row;
    } finally { fs.closeSync(fd); }
  }

  list(cwd) {
    let files;
    try { files = fs.readdirSync(this.directory, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
    return files.filter(file => file.isFile() && UUID.test(file.name.slice(0, -5)) && file.name.endsWith(".json"))
      .map(file => this.read(file.name.slice(0, -5))).filter(row => !cwd || row.cwd === cwd)
      .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 100);
  }

  #write(row) {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const directory = fs.lstatSync(this.directory);
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid() || (directory.mode & 0o077)) throw fail(500, "작업 디렉터리는 본인 소유의 비공개 경로여야 합니다.");
    const file = this.#file(row.id), temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(row)}\n`, { flag: "wx", mode: 0o600 });
      fs.renameSync(temporary, file);
    } finally { fs.rmSync(temporary, { force: true }); }
    return row;
  }

  create({ title, cwd }) {
    if (this.list().length >= 100) throw fail(409, "보관 가능한 작업은 100개입니다.");
    const now = Date.now();
    return this.#write({ version: 1, id: crypto.randomUUID(), title: text(title, 160, true), cwd,
      revision: 1, commit: "", createdAt: now, updatedAt: now,
      nodes: stages.map(([id, title], index) => ({ id, title, dependsOn: index ? [stages[index - 1][0]] : [],
        sessionId: "", state: "pending", note: "", evidence: "", evidenceCommit: "", requests: [] })),
      returns: [] });
  }

  update(id, input) {
    const row = this.read(id);
    if (input.revision !== row.revision) throw fail(409, "다른 화면에서 작업이 변경됐습니다. 새로고침 후 다시 저장해 주세요.");
    if (input.action === "commit") {
      const commit = text(input.commit, 40, true);
      if (!/^[0-9a-f]{40}$/i.test(commit)) throw fail(400, "전체 Git SHA 40자리가 필요합니다.");
      if (row.commit !== commit) {
        row.commit = commit;
        for (const node of row.nodes.slice(2)) { node.state = "pending"; node.evidence = ""; node.evidenceCommit = ""; }
      }
    } else {
      const node = row.nodes.find(node => node.id === input.nodeId);
      if (!node) throw fail(400, "작업 단계가 없습니다.");
      if (input.action === "assign") {
        const sessionId = text(input.sessionId, 220);
        if (sessionId && !/^(claude|codex):[^\s]+$/.test(sessionId)) throw fail(400, "세션 ID를 확인해 주세요.");
        if (node.sessionId !== sessionId && node.state === "passed") {
          this.#invalidateAfter(row, node.id);
          Object.assign(node, { state: "pending", evidence: "", evidenceCommit: "" });
        }
        node.sessionId = sessionId;
      } else if (input.action === "state") {
        if (!states.has(input.state)) throw fail(400, "단계 상태를 확인해 주세요.");
        if (["active", "passed"].includes(input.state) && node.dependsOn.some(id => row.nodes.find(other => other.id === id).state !== "passed")) throw fail(409, "앞선 단계가 통과해야 진행할 수 있습니다.");
        const note = text(input.note ?? "", 2000), evidence = text(input.evidence ?? "", 4000);
        if (input.state === "blocked" && !note) throw fail(400, "막힌 이유를 입력해 주세요.");
        if (input.state === "passed" && !evidence) throw fail(400, "완료 근거를 입력해 주세요.");
        if (input.state === "passed" && ["verify", "review", "integrate"].includes(node.id) && !row.commit) throw fail(400, "검증 대상 Git SHA를 먼저 지정해 주세요.");
        if (input.state === "passed" && node.id === "review" && node.sessionId && node.sessionId === row.nodes.find(other => other.id === "implement").sessionId) throw fail(409, "독립 리뷰는 구현과 다른 세션에 연결해 주세요.");
        if (node.state === "passed" && input.state !== "passed") this.#invalidateAfter(row, node.id);
        Object.assign(node, { state: input.state, note, evidence: input.state === "passed" ? evidence : "", evidenceCommit: input.state === "passed" ? row.commit : "" });
      } else if (input.action === "rework") {
        const target = row.nodes.find(other => other.id === input.targetId);
        if (!target || row.nodes.indexOf(target) >= row.nodes.indexOf(node)) throw fail(400, "앞선 단계로만 되돌릴 수 있습니다.");
        if (target.dependsOn.some(id => row.nodes.find(other => other.id === id).state !== "passed")) throw fail(409, "돌아갈 단계의 선행 조건을 먼저 충족해 주세요.");
        const reason = text(input.note, 2000, true);
        this.#invalidateAfter(row, target.id);
        Object.assign(target, { state: "active", note: reason, evidence: "", evidenceCommit: "" });
        row.returns.push({ from: node.id, to: target.id, reason, at: Date.now() });
        row.returns = row.returns.slice(-20);
      } else throw fail(400, "지원하지 않는 작업 변경입니다.");
    }
    row.revision++; row.updatedAt = Date.now();
    return this.#write(row);
  }

  #invalidateAfter(row, id) {
    for (const node of row.nodes.slice(row.nodes.findIndex(node => node.id === id) + 1)) {
      Object.assign(node, { state: "pending", note: "", evidence: "", evidenceCommit: "" });
    }
  }

  // A transport answer is evidence to inspect, never a phase transition.
  attach(id, nodeId, { operationId, requestId, state, reply, error, commit, sessionId }) {
    const row = this.read(id), node = row.nodes.find(node => node.id === nodeId);
    if (!node) throw fail(400, "작업 단계가 없습니다.");
    const entry = { operationId, requestId, state, commit, sessionId, reply: reply?.slice(0, 4000), replyLimited: (reply?.length ?? 0) > 4000, error: error?.slice(0, 1000), at: Date.now() };
    node.requests = [...node.requests.filter(item => item.operationId !== operationId), entry].slice(-5);
    row.revision++; row.updatedAt = Date.now();
    return this.#write(row);
  }
}

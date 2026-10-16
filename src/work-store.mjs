import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeContext, handoffText } from "./work-context.mjs";
import { APP_ID } from "./product.mjs";
import { validateWorkPlan } from './work-plan.mjs';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const fail = (status, message) => Object.assign(new Error(message), { status });

// Instructions are work metadata. Native transcripts and run evidence keep their owners.
export class WorkStore {
  constructor(directory = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), APP_ID, "works")) { this.directory = directory; }
  #file(id) {
    if (!UUID.test(id ?? "")) throw fail(400, "잘못된 작업 ID입니다.");
    return path.join(this.directory, `${id}.json`);
  }
  read(id) {
    let fd;
    try { fd = fs.openSync(this.#file(id), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
    catch (error) { if (error.code === "ENOENT") throw fail(404, "작업 기록이 없습니다."); throw error; }
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 256 * 1024) throw fail(500, "작업 기록을 읽을 수 없습니다.");
      const row = JSON.parse(fs.readFileSync(fd, "utf8"));
      if (row.version !== 1 || row.id !== id) throw fail(500, "작업 기록 형식이 잘못됐습니다.");
      return row;
    } finally { fs.closeSync(fd); }
  }
  #write(row) {
    if (Buffer.byteLength(JSON.stringify(row)) > 256 * 1024) throw fail(413, "작업 기록 용량 한도입니다.");
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw fail(500, "작업 경로는 본인 소유 비공개 디렉터리여야 합니다.");
    const file = this.#file(row.id), temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try { fs.writeFileSync(temporary, JSON.stringify(row), { flag: "wx", mode: 0o600 }); fs.renameSync(temporary, file); }
    finally { fs.rmSync(temporary, { force: true }); }
    return row;
  }
  list(sessionId) {
    let files;
    try { files = fs.readdirSync(this.directory, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
    return files.filter(file => file.isFile() && file.name.endsWith(".json") && UUID.test(file.name.slice(0, -5)))
      .map(file => this.read(file.name.slice(0, -5))).filter(row => row.session.id === sessionId).sort((a, b) => a.createdAt - b.createdAt);
  }
  create({ id, instruction, parentId, contextFrom }, session, baseline = []) {
    this.#file(id);
    if (typeof instruction !== "string" || !instruction.trim() || instruction.length > 16000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(instruction)) throw fail(400, "지시는 제어문자 없이 1~16,000자로 입력해 주세요.");
    try {
      const previous = this.read(id);
      if (previous.session.id !== session.id || previous.instruction !== instruction || previous.parentId !== parentId || previous.contextFrom !== contextFrom) throw fail(409, "이미 다른 지시에 사용한 작업 ID입니다.");
      return previous;
    } catch (error) { if (error.status !== 404) throw error; }
    if (this.list(session.id).length >= 500) throw fail(409, "세션별 작업 기록 한도입니다.");
    const parent = parentId ? this.read(parentId) : null;
    if (parent && parent.session.id !== session.id) throw fail(409, "같은 세션의 작업에만 변경 지시를 연결할 수 있습니다.");
    const inherited = contextFrom ? this.read(contextFrom) : parent;
    return this.#write({ ...(inherited?.context ? { deliveryText: `${instruction}\n\n[Waga 선택한 인계 자료 — 원래 지시와 구분]\n${handoffText(inherited)}` } : {}), ...(contextFrom ? { contextFrom } : {}), ...(inherited?.context ? { context: structuredClone(inherited.context), contextSource: { workId: inherited.id, revision: inherited.context.revision, capturedAt: Date.now() } } : {}), version: 1, id, rootId: parent?.rootId ?? parent?.id ?? id, instruction, ...(parentId ? { parentId } : {}), session: { id: session.id, provider: session.provider, name: session.name, cwd: session.cwd, workspace: path.resolve(session.projectCwd || session.cwd) },
      createdAt: Date.now(), delivery: "unconfirmed", references: [], baseline: baseline.filter(row => row.role === "user").map(row => row.id).slice(-500) });
  }
  submitted(id, sessionId) {
    const row = this.read(id);
    if (row.session.id !== sessionId) throw fail(409, "지시 대상 세션이 다릅니다.");
    // Persist before Enter: an interrupted acknowledgement must never trigger automatic resend.
    if (row.submitAttemptedAt) throw fail(409, "이미 전송을 시도한 지시입니다. 원래 세션에서 전달 여부를 확인해 주세요.");
    row.submitAttemptedAt = Date.now(); return this.#write(row);
  }
  delivered(id) { const row = this.read(id); row.delivery = "submitted"; return this.#write(row); }
  observe(message, session) {
    const previous = this.list(session.id).find(row => row.messageId === message.id);
    if (previous) return previous;
    if (!message.id || message.role !== 'user') throw fail(400, '원문 지시를 찾을 수 없습니다.');
    const row = this.create({ id: crypto.randomUUID(), instruction: message.text }, session);
    return this.#write({ ...row, origin: 'native', messageId: message.id, delivery: 'observed' });
  }
  analysis(id, value) { const row = this.read(id); row.analysis = value; return this.#write(row); }
  plan(id, input) {
    const row = this.read(id), value = validateWorkPlan(input);
    if (row.plan && JSON.stringify(value) === JSON.stringify({ title: row.plan.title, skill: row.plan.skill, nodes: row.plan.nodes, ...(row.plan.execution ? { execution: row.plan.execution } : {}) })) return row;
    if (row.plan && row.launches?.some(launch => launch.planRevision === row.plan.revision)) throw fail(409, '실행으로 넘긴 계획은 실행 기록으로 관리합니다. 변경 지시는 후속 작업에 연결해 주세요.');
    if (input.revision !== (row.plan?.revision ?? 0)) throw fail(409, '계획이 변경됐습니다. 현재 revision을 읽은 뒤 갱신해 주세요.');
    row.plan = { ...value, revision: input.revision + 1, updatedAt: Date.now(), basis: 'agent-declared' };
    return this.#write(row);
  }
  progress(id, value) { const row = this.read(id); row.progress = value; delete row.trackingError; return this.#write(row); }
  trackingError(id, value) { const row = this.read(id); row.trackingError = value; return this.#write(row); }
  generatedContext(id, input, analysisId) {
    const row = this.read(id);
    // A manually corrected context is never overwritten by background interpretation.
    if (row.context && row.context.origin !== 'llm') return row;
    row.context = { ...normalizeContext(input, row.context), origin: 'llm', analysisId };
    return this.#write(row);
  }
  launched(id, launchId, runId, analysisId, planRevision) {
    this.#file(launchId); const row = this.read(id); row.launches ??= [];
    const previous = row.launches.find(item => item.id === launchId);
    if (previous) return previous;
    if (row.launches.length >= 30) throw fail(409, '작업별 실행 한도입니다.');
    const launch = { id: launchId, runId, ...(analysisId ? { analysisId } : {}), ...(planRevision ? { planRevision } : {}), state: "prepared", at: Date.now() }; row.launches.push(launch); this.#write(row); return launch;
  }
  launchState(id, launchId, state, reason) { const row = this.read(id), entry = row.launches?.find(item => item.id === launchId); if (!entry) throw fail(404, '실행 요청이 없습니다.'); entry.state = state; if (reason) entry.reason = String(reason).slice(0, 2000); return this.#write(row); }
  context(id, input) { const row = this.read(id); row.context = normalizeContext(input, row.context); return this.#write(row); }
  references(id, values) {
    if (!Array.isArray(values) || values.length > 30 || values.some(value => typeof value !== "string" || !value.trim() || value.length > 2000)) throw fail(400, "참고 자료는 2,000자 이하 출처를 최대 30개 연결할 수 있습니다.");
    const row = this.read(id); row.references = values.map(source => ({ source, addedAt: Date.now(), origin: "user" })); return this.#write(row);
  }
  reconcile(sessionId, messages) {
    const rows = this.list(sessionId), claimed = new Set(rows.map(row => row.messageId).filter(Boolean));
    return rows.map(row => {
      if (row.messageId || !row.submitAttemptedAt) return row;
      const matches = messages.filter(message => message.role === "user" && !row.baseline.includes(message.id) && message.text === (row.deliveryText ?? row.instruction));
      // Content matching is a navigation aid, never a claimed native transport acknowledgement.
      if (matches.length === 1 && matches[0].id && !claimed.has(matches[0].id)) {
        claimed.add(matches[0].id);
        row.messageId = matches[0].id; row.messageRelation = "content-match"; return this.#write(row);
      }
      return row;
    });
  }
}

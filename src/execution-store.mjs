import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { APP_ID } from "./product.mjs";

const fail = (status, message) => Object.assign(new Error(message), { status });
const hex = (value, length) => typeof value === "string" && new RegExp(`^[0-9a-f]{${length}}$`, "i").test(value) && !/^0+$/.test(value);
const scalar = value => value?.stringValue ?? value?.boolValue ?? value?.intValue;
const attributes = rows => Object.fromEntries((Array.isArray(rows) ? rows : []).filter(row => row && typeof row.key === "string").map(row => [row.key, scalar(row.value)]));
const bounded = (value, max = 300) => typeof value === "string" ? value.slice(0, max) : "";
const stamp = value => typeof value === "string" && /^\d{1,20}$/.test(value) ? value : "";
const metadata = ["session.id", "gen_ai.conversation.id", "agent_id", "parent_agent_id", "workflow.run_id", "workflow.name", "tool_name", "gen_ai.tool.name", "model", "gen_ai.request.model"];
const counts = ["input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens"];
const contentKeys = ["output", "content", "diff", "file_path", "bash_command"];

// OTLP's documented JSON mapping only. Call ancestry is not a task dependency or a check verdict.
export function normalizeExecution(document, includeContent = false) {
  if (!Array.isArray(document?.resourceSpans)) throw fail(400, "OTLP JSON의 resourceSpans 배열이 필요합니다.");
  const unique = new Map(); let total = 0;
  if (document.resourceSpans.some(resource => !resource || !Array.isArray(resource.scopeSpans) || resource.scopeSpans.some(scope => !scope || !Array.isArray(scope.spans) || scope.spans.some(span => !span || typeof span !== "object")))) throw fail(400, "OTLP JSON의 scopeSpans·spans 배열을 확인해 주세요.");
  for (const resource of document.resourceSpans) for (const scope of resource.scopeSpans) for (const span of scope.spans) {
    if (++total > 5000) throw fail(413, "한 기록에는 span을 5,000개까지 가져올 수 있습니다.");
    if (!hex(span.traceId, 32) || !hex(span.spanId, 16) || (span.parentSpanId && !hex(span.parentSpanId, 16))) throw fail(400, "잘못된 OpenTelemetry span ID입니다.");
    const traceId = span.traceId.toLowerCase(), spanId = span.spanId.toLowerCase();
    const attrs = attributes(span.attributes), values = {};
    for (const key of metadata) if (typeof attrs[key] === "string") values[key] = bounded(attrs[key]);
    for (const key of counts) if (/^\d{1,12}$/.test(String(attrs[key]))) values[key] = Number(attrs[key]);
    const start = stamp(span.startTimeUnixNano), end = stamp(span.endTimeUnixNano);
    if (!start || (end && BigInt(end) < BigInt(start))) throw fail(400, "span 시작·종료 시각을 확인해 주세요.");
    const item = { id: `${traceId}:${spanId}`, traceId, spanId, parentSpanId: span.parentSpanId?.toLowerCase() ?? "",
      name: bounded(span.name), start, end, durationMs: end ? Number(BigInt(end) - BigInt(start)) / 1e6 : null,
      state: span.status?.code === 2 ? "error" : end ? "returned" : "unknown", attributes: values };
    if (includeContent) {
      if (span.events !== undefined && !Array.isArray(span.events)) throw fail(400, "span events 배열을 확인해 주세요.");
      const events = span.events ?? [];
      item.contentLimited = events.length > 20 || (typeof attrs.full_command === "string" && attrs.full_command.length > 16000) || (typeof attrs.file_path === "string" && attrs.file_path.length > 2000)
        || events.some(event => Object.values(attributes(event?.attributes)).some(value => typeof value === "string" && value.length > 16000));
      item.command = bounded(attrs.full_command, 16000);
      item.file = bounded(attrs.file_path, 2000);
      item.events = events.slice(0, 20).map(event => {
        const values = attributes(event?.attributes), content = {};
        for (const key of contentKeys) if (typeof values[key] === "string") content[key] = bounded(values[key], 16000);
        return { name: bounded(event?.name), content };
      }).filter(event => Object.keys(event.content).length);
    }
    unique.set(item.id, item);
  }
  if (!unique.size) throw fail(400, "실행 span이 없습니다.");
  const spans = [...unique.values()].sort((a, b) => a.start.length - b.start.length || a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
  return { spans, includesContent: includeContent };
}

export class ExecutionStore {
  constructor(directory = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), APP_ID, "executions")) { this.directory = directory; }
  #file(id) {
    if (!hex(id, 64)) throw fail(400, "잘못된 실행 ID입니다.");
    return path.join(this.directory, `${id}.json`);
  }
  read(id) {
    let fd;
    try { fd = fs.openSync(this.#file(id), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
    catch (error) { if (error.code === "ENOENT") throw fail(404, "실행 기록이 없습니다."); throw error; }
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw fail(500, "실행 기록을 읽을 수 없습니다.");
      const row = JSON.parse(fs.readFileSync(fd, "utf8"));
      if (row.version !== 1 || row.id !== id || !Array.isArray(row.spans)) throw fail(500, "실행 기록 형식이 잘못됐습니다.");
      return row;
    } finally { fs.closeSync(fd); }
  }
  list(cwd) {
    let files;
    try { files = fs.readdirSync(this.directory); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
    return files.filter(name => /^[0-9a-f]{64}\.json$/.test(name)).map(name => this.read(name.slice(0, -5)))
      .filter(row => !cwd || row.cwd === cwd).sort((a, b) => b.importedAt - a.importedAt)
      .map(({ id, title, importedAt, spans, includesContent, source, sessionId }) => ({ id, title, importedAt, spanCount: spans.length, includesContent, ...(source ? { source, sessionId } : {}) }));
  }
  #nativeId(session) { return crypto.createHash("sha256").update(`native:${session.id}:${session.cwd}`).digest("hex"); }
  native(session) {
    try { return this.read(this.#nativeId(session)); } catch (error) { if (error.status === 404) return null; throw error; }
  }
  saveNative(session, spans, collection) {
    const id = this.#nativeId(session), previous = this.native(session);
    const retained = spans.slice(-2000);
    let size = retained.reduce((sum, span) => sum + Buffer.byteLength(JSON.stringify(span)) + 1, 0), limited = Boolean(previous?.collection?.limited || spans.length >= 2000);
    while (size > 3 * 1024 * 1024 && retained.length) { size -= Buffer.byteLength(JSON.stringify(retained.shift())) + 1; limited = true; }
    const value = { source: "native", sessionId: session.id, title: session.name, cwd: session.projectCwd || session.cwd,
      spans: retained, includesContent: true, collection: { ...collection, limited } };
    if (previous && JSON.stringify(value) === JSON.stringify(Object.fromEntries(Object.keys(value).map(key => [key, previous[key]])))) return previous;
    const row = { version: 1, id, importedAt: Date.now(), ...value };
    this.#write(id, JSON.stringify(row));
    return row;
  }
  import(input, cwd) {
    const normalized = normalizeExecution(input.document, input.includeContent === true);
    const id = crypto.createHash("sha256").update(JSON.stringify({ cwd, ...normalized })).digest("hex");
    try { return this.read(id); } catch (error) { if (error.status !== 404) throw error; }
    if (this.list().length >= 100) throw fail(409, "보관 가능한 실행은 100개입니다.");
    const title = normalized.spans.find(span => span.attributes["workflow.name"])?.attributes["workflow.name"] ?? "실행 기록";
    const row = { version: 1, id, title, cwd, importedAt: Date.now(), ...normalized };
    const data = JSON.stringify(row);
    if (Buffer.byteLength(data) > 4 * 1024 * 1024) throw fail(413, "정규화된 기록이 너무 큽니다.");
    this.#write(id, data);
    return row;
  }
  #write(id, data) {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const directory = fs.lstatSync(this.directory);
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid() || (directory.mode & 0o077)) throw fail(500, "실행 기록 경로는 본인 소유의 비공개 디렉터리여야 합니다.");
    const file = this.#file(id), temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try { fs.writeFileSync(temporary, data, { flag: "wx", mode: 0o600 }); fs.renameSync(temporary, file); }
    finally { fs.rmSync(temporary, { force: true }); }
  }
}

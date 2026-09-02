import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const CATALOG_VERSION = 1;
const THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function catalogError(message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = "MANAGED_THREAD_CATALOG_INVALID";
  return error;
}

function validateThreadIds(value) {
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || !THREAD_ID_PATTERN.test(id))) {
    throw catalogError("관리 세션 카탈로그의 threadIds가 올바르지 않습니다");
  }
  return new Set(value);
}

export class ManagedThreadCatalog {
  constructor(filePath) {
    if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
      throw new TypeError("Managed thread catalog path must be absolute");
    }
    this.filePath = filePath;
  }

  read() {
    if (!fs.existsSync(this.filePath)) return new Set();
    let document;
    try {
      document = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    } catch (error) {
      throw catalogError(`관리 세션 카탈로그를 읽을 수 없습니다: ${this.filePath}`, error);
    }
    if (document?.version !== CATALOG_VERSION) {
      throw catalogError(`지원하지 않는 관리 세션 카탈로그 버전입니다: ${document?.version}`);
    }
    return validateThreadIds(document.threadIds);
  }

  record(threadId) {
    if (typeof threadId !== "string" || !THREAD_ID_PATTERN.test(threadId)) {
      throw catalogError(`올바르지 않은 Codex thread id입니다: ${threadId}`);
    }
    const ids = this.read();
    if (ids.has(threadId)) return;
    ids.add(threadId);
    this.#write(ids);
  }

  remove(threadId) {
    if (typeof threadId !== "string" || !THREAD_ID_PATTERN.test(threadId)) {
      throw catalogError(`올바르지 않은 Codex thread id입니다: ${threadId}`);
    }
    const ids = this.read();
    if (!ids.delete(threadId)) return;
    this.#write(ids);
  }

  #write(ids) {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    const document = `${JSON.stringify({ version: CATALOG_VERSION, threadIds: [...ids] }, null, 2)}\n`;
    try {
      fs.writeFileSync(temporaryPath, document, { mode: 0o600, flag: "wx" });
      fs.renameSync(temporaryPath, this.filePath);
    } finally {
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    }
  }
}

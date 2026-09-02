import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const VERSION = 1;

function catalogError(message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), {
    code: "SESSION_ALIAS_CATALOG_INVALID",
  });
}

function validate(document) {
  if (document?.version !== VERSION || !document.aliases || typeof document.aliases !== "object" || Array.isArray(document.aliases)) {
    throw catalogError(`지원하지 않는 session alias catalog 버전입니다: ${document?.version}`);
  }
  for (const [sessionId, alias] of Object.entries(document.aliases)) {
    if (!sessionId || typeof alias !== "string" || !alias.trim()) {
      throw catalogError("session alias catalog 항목이 올바르지 않습니다");
    }
  }
  if (document.hidden !== undefined && (!Array.isArray(document.hidden) || document.hidden.some((id) => typeof id !== "string" || !id))) {
    throw catalogError("session alias catalog hidden 목록이 올바르지 않습니다");
  }
  document.hidden ??= [];
  return document;
}

export class SessionAliasCatalog {
  constructor(filePath) {
    if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
      throw new TypeError("Session alias catalog path must be absolute");
    }
    this.filePath = filePath;
  }

  get(sessionId) {
    return this.#read().aliases[sessionId] ?? null;
  }

  set(sessionId, alias) {
    if (typeof sessionId !== "string" || !sessionId) throw new TypeError("Session id is required");
    if (typeof alias !== "string" || !alias.trim()) throw new TypeError("Session alias is required");
    const document = this.#read();
    document.aliases[sessionId] = alias.trim();
    this.#write(document);
  }

  remove(sessionId) {
    const document = this.#read();
    if (!Object.hasOwn(document.aliases, sessionId)) return false;
    delete document.aliases[sessionId];
    this.#write(document);
    return true;
  }

  isHidden(sessionId) {
    return this.#read().hidden.includes(sessionId);
  }

  hide(sessionId) {
    const document = this.#read();
    if (document.hidden.includes(sessionId)) return false;
    document.hidden.push(sessionId);
    this.#write(document);
    return true;
  }

  unhide(sessionId) {
    const document = this.#read();
    const index = document.hidden.indexOf(sessionId);
    if (index < 0) return false;
    document.hidden.splice(index, 1);
    this.#write(document);
    return true;
  }

  #read() {
    if (!fs.existsSync(this.filePath)) return { version: VERSION, aliases: {}, hidden: [] };
    try {
      return validate(JSON.parse(fs.readFileSync(this.filePath, "utf8")));
    } catch (error) {
      if (error.code === "SESSION_ALIAS_CATALOG_INVALID") throw error;
      throw catalogError(`session alias catalog를 읽을 수 없습니다: ${this.filePath}`, error);
    }
  }

  #write(document) {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      fs.renameSync(temporaryPath, this.filePath);
    } finally {
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    }
  }
}

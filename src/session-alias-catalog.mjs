import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { APP_ID } from "./product.mjs";

const VERSION = 1;

function invalid(message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code: "SESSION_ALIAS_CATALOG_INVALID" });
}

function validate(document) {
  if (document?.version !== VERSION || !document.aliases || typeof document.aliases !== "object" || Array.isArray(document.aliases)) {
    throw invalid("Session alias file has an unsupported shape");
  }
  if (Object.entries(document.aliases).some(([id, alias]) => !id || typeof alias !== "string" || !alias.trim())) {
    throw invalid("Session alias file contains an invalid entry");
  }
  return document;
}

export function defaultClaudeAliasPath(env = process.env, homeDirectory = os.homedir()) {
  const stateDirectory = env.XDG_STATE_HOME || path.join(homeDirectory, ".local", "state");
  return path.join(stateDirectory, APP_ID, "claude-aliases.json");
}

export class SessionAliasCatalog {
  constructor(filePath = defaultClaudeAliasPath()) {
    if (typeof filePath !== "string" || !path.isAbsolute(filePath)) throw new TypeError("Session alias path must be absolute");
    this.filePath = filePath;
  }

  load() {
    return new Map(Object.entries(this.#read().aliases));
  }

  set(sessionId, alias) {
    if (typeof sessionId !== "string" || !sessionId) throw new TypeError("Session id is required");
    if (typeof alias !== "string" || !alias.trim()) throw new TypeError("Session alias is required");
    const document = this.#read();
    document.aliases[sessionId] = alias.trim();
    this.#write(document);
  }

  #read() {
    if (!fs.existsSync(this.filePath)) return { version: VERSION, aliases: {} };
    try {
      return validate(JSON.parse(fs.readFileSync(this.filePath, "utf8")));
    } catch (error) {
      if (error.code === "SESSION_ALIAS_CATALOG_INVALID") throw error;
      throw invalid(`Session alias file could not be read: ${this.filePath}`, error);
    }
  }

  #write(document) {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      fs.renameSync(temporary, this.filePath);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
}

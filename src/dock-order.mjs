import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { APP_ID } from "./product.mjs";

const VERSION = 1;

function invalid(message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code: "DOCK_ORDER_INVALID" });
}

function canonicalWorkspace(workspacePath) {
  if (typeof workspacePath !== "string" || !path.isAbsolute(workspacePath)) {
    throw new TypeError("Dock order workspace must be an absolute path");
  }
  return path.resolve(workspacePath);
}

function validate(document) {
  if (document?.version !== VERSION || !Array.isArray(document.workspaces)) {
    throw invalid("Dock order file has an unsupported shape");
  }
  const seen = new Set();
  for (const workspace of document.workspaces) {
    if (
      !workspace
      || typeof workspace.path !== "string"
      || !path.isAbsolute(workspace.path)
      || seen.has(workspace.path)
      || !Array.isArray(workspace.sessionOrder)
      || workspace.sessionOrder.some((id) => typeof id !== "string" || !id)
      || new Set(workspace.sessionOrder).size !== workspace.sessionOrder.length
    ) throw invalid("Dock order file contains an invalid workspace entry");
    seen.add(workspace.path);
  }
  return document;
}

export function defaultDockOrderPath(env = process.env, homeDirectory = os.homedir()) {
  const stateDirectory = env.XDG_STATE_HOME || path.join(homeDirectory, ".local", "state");
  return path.join(stateDirectory, APP_ID, "dock-order.json");
}

export class DockOrderStore {
  constructor(filePath = defaultDockOrderPath()) {
    if (typeof filePath !== "string" || !path.isAbsolute(filePath)) throw new TypeError("Dock order path must be absolute");
    this.filePath = filePath;
  }

  load() {
    const document = this.#read();
    return new Map(document.workspaces.map((workspace) => [workspace.path, [...workspace.sessionOrder]]));
  }

  saveWorkspace(workspacePath, sessionOrder) {
    const canonicalPath = canonicalWorkspace(workspacePath);
    if (
      !Array.isArray(sessionOrder)
      || sessionOrder.some((id) => typeof id !== "string" || !id)
      || new Set(sessionOrder).size !== sessionOrder.length
    ) throw new TypeError("Dock session order must contain unique session ids");

    const document = this.#read();
    const workspace = document.workspaces.find((entry) => entry.path === canonicalPath);
    if (workspace) workspace.sessionOrder = [...sessionOrder];
    else document.workspaces.push({ path: canonicalPath, sessionOrder: [...sessionOrder] });
    this.#write(document);
  }

  #read() {
    if (!fs.existsSync(this.filePath)) return { version: VERSION, workspaces: [] };
    try {
      return validate(JSON.parse(fs.readFileSync(this.filePath, "utf8")));
    } catch (error) {
      if (error.code === "DOCK_ORDER_INVALID") throw error;
      throw invalid(`Dock order file could not be read: ${this.filePath}`, error);
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

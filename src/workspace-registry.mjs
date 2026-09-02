import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const REGISTRY_VERSION = 1;

function registryError(message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = "WORKSPACE_REGISTRY_INVALID";
  return error;
}

function canonicalWorkspace(workspacePath) {
  if (typeof workspacePath !== "string" || !path.isAbsolute(workspacePath)) {
    throw new TypeError("Workspace path must be absolute");
  }
  const resolved = path.resolve(workspacePath);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function clone(value) {
  return structuredClone(value);
}

function validateDocument(document) {
  if (document?.version !== REGISTRY_VERSION || !Number.isInteger(document.revision) || document.revision < 0) {
    throw registryError(`지원하지 않는 workspace registry 버전입니다: ${document?.version}`);
  }
  if (!Array.isArray(document.workspaces)) throw registryError("workspace 목록이 올바르지 않습니다");
  const paths = new Set();
  for (const workspace of document.workspaces) {
    if (
      !workspace
      || typeof workspace.path !== "string"
      || !path.isAbsolute(workspace.path)
      || typeof workspace.name !== "string"
      || !Array.isArray(workspace.sessionOrder)
      || workspace.sessionOrder.some((key) => typeof key !== "string" || key.length === 0)
      || new Set(workspace.sessionOrder).size !== workspace.sessionOrder.length
      || (workspace.completedSessions !== undefined && !Array.isArray(workspace.completedSessions))
      || paths.has(workspace.path)
    ) {
      throw registryError("workspace 항목이 올바르지 않습니다");
    }
    workspace.completedSessions ??= [];
    if (
      workspace.completedSessions.some((key) => typeof key !== "string" || !workspace.sessionOrder.includes(key))
      || new Set(workspace.completedSessions).size !== workspace.completedSessions.length
    ) {
      throw registryError("완료 세션 목록이 올바르지 않습니다");
    }
    paths.add(workspace.path);
  }
  return document;
}

export class WorkspaceRegistry extends EventEmitter {
  constructor(filePath) {
    super();
    if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
      throw new TypeError("Workspace registry path must be absolute");
    }
    this.filePath = filePath;
  }

  snapshot() {
    return clone(this.#read());
  }

  register(workspacePath) {
    const canonicalPath = canonicalWorkspace(workspacePath);
    const document = this.#read();
    const existing = document.workspaces.find((workspace) => workspace.path === canonicalPath);
    if (existing) return clone(existing);
    const workspace = {
      path: canonicalPath,
      name: path.basename(canonicalPath) || canonicalPath,
      sessionOrder: [],
      completedSessions: [],
    };
    document.workspaces.push(workspace);
    this.#commit(document, { type: "workspace/registered", workspacePath: canonicalPath });
    return clone(workspace);
  }

  unregister(workspacePath) {
    const canonicalPath = canonicalWorkspace(workspacePath);
    const document = this.#read();
    const index = document.workspaces.findIndex((workspace) => workspace.path === canonicalPath);
    if (index < 0) return false;
    if (document.workspaces[index].sessionOrder.length > 0) {
      const error = new Error("세션이 남아 있는 workspace는 등록 해제할 수 없습니다");
      error.code = "WORKSPACE_NOT_EMPTY";
      throw error;
    }
    document.workspaces.splice(index, 1);
    this.#commit(document, { type: "workspace/unregistered", workspacePath: canonicalPath });
    return true;
  }

  recordSession(workspacePath, sessionKey) {
    if (typeof sessionKey !== "string" || sessionKey.length === 0) throw new TypeError("Session key is required");
    const canonicalPath = canonicalWorkspace(workspacePath);
    const document = this.#read();
    let workspace = document.workspaces.find((entry) => entry.path === canonicalPath);
    if (!workspace) {
      workspace = {
        path: canonicalPath,
        name: path.basename(canonicalPath) || canonicalPath,
        sessionOrder: [],
        completedSessions: [],
      };
      document.workspaces.push(workspace);
    }
    if (workspace.sessionOrder.includes(sessionKey)) return false;
    workspace.sessionOrder.push(sessionKey);
    this.#commit(document, { type: "session/recorded", workspacePath: canonicalPath, sessionKey });
    return true;
  }

  removeSession(workspacePath, sessionKey) {
    const canonicalPath = canonicalWorkspace(workspacePath);
    const document = this.#read();
    const workspace = document.workspaces.find((entry) => entry.path === canonicalPath);
    if (!workspace) return false;
    const index = workspace.sessionOrder.indexOf(sessionKey);
    if (index < 0) return false;
    workspace.sessionOrder.splice(index, 1);
    workspace.completedSessions = workspace.completedSessions.filter((key) => key !== sessionKey);
    this.#commit(document, { type: "session/removed", workspacePath: canonicalPath, sessionKey });
    return true;
  }

  setSessionCompleted(workspacePath, sessionKey, completed) {
    if (typeof completed !== "boolean") throw new TypeError("Completed must be a boolean");
    const canonicalPath = canonicalWorkspace(workspacePath);
    const document = this.#read();
    const workspace = document.workspaces.find((entry) => entry.path === canonicalPath);
    if (!workspace?.sessionOrder.includes(sessionKey)) return false;
    const existing = workspace.completedSessions.includes(sessionKey);
    if (existing === completed) return false;
    if (completed) workspace.completedSessions.push(sessionKey);
    else workspace.completedSessions = workspace.completedSessions.filter((key) => key !== sessionKey);
    this.#commit(document, {
      type: completed ? "session/completed" : "session/reopened",
      workspacePath: canonicalPath,
      sessionKey,
    });
    return true;
  }

  moveSession(workspacePath, sessionKey, direction) {
    if (direction !== "up" && direction !== "down") throw new TypeError("Direction must be up or down");
    const canonicalPath = canonicalWorkspace(workspacePath);
    const document = this.#read();
    const workspace = document.workspaces.find((entry) => entry.path === canonicalPath);
    if (!workspace) return false;
    const index = workspace.sessionOrder.indexOf(sessionKey);
    const target = direction === "up" ? index - 1 : index + 1;
    if (index < 0 || target < 0 || target >= workspace.sessionOrder.length) return false;
    [workspace.sessionOrder[index], workspace.sessionOrder[target]] = [workspace.sessionOrder[target], workspace.sessionOrder[index]];
    this.#commit(document, { type: "session/reordered", workspacePath: canonicalPath, sessionKey, direction });
    return true;
  }

  #read() {
    if (!fs.existsSync(this.filePath)) return { version: REGISTRY_VERSION, revision: 0, workspaces: [] };
    try {
      return validateDocument(JSON.parse(fs.readFileSync(this.filePath, "utf8")));
    } catch (error) {
      if (error.code === "WORKSPACE_REGISTRY_INVALID") throw error;
      throw registryError(`workspace registry를 읽을 수 없습니다: ${this.filePath}`, error);
    }
  }

  #commit(document, change) {
    document.revision += 1;
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      fs.renameSync(temporaryPath, this.filePath);
    } finally {
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    }
    this.emit("changed", { revision: document.revision, ...change });
  }
}

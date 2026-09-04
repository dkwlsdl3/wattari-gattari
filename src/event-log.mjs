import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { APP_ID } from "./product.mjs";

export function defaultEventLogPath(env = process.env, homeDirectory = os.homedir()) {
  const stateDirectory = env.XDG_STATE_HOME || path.join(homeDirectory, ".local", "state");
  return path.join(stateDirectory, APP_ID, "events.jsonl");
}

export class EventLog {
  #filePath;
  #now;
  #processId;

  constructor(filePath = defaultEventLogPath(), { now = () => new Date(), processId = process.pid } = {}) {
    this.#filePath = filePath;
    this.#now = now;
    this.#processId = processId;
  }

  get filePath() { return this.#filePath; }

  record(event, details = {}) {
    try {
      fs.mkdirSync(path.dirname(this.#filePath), { recursive: true, mode: 0o700 });
      const observedAt = this.#now();
      const timestamp = observedAt instanceof Date ? observedAt.toISOString() : new Date(observedAt).toISOString();
      const line = `${JSON.stringify({ timestamp, pid: this.#processId, event, ...details })}\n`;
      const descriptor = fs.openSync(this.#filePath, "a", 0o600);
      try {
        fs.fchmodSync(descriptor, 0o600);
        fs.writeFileSync(descriptor, line);
      } finally {
        fs.closeSync(descriptor);
      }
      return true;
    } catch {
      return false;
    }
  }
}

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

function read(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

// Separate writer request and hook receipt files prevent a hook handling A from
// deleting/overwriting a newer F2 request B. No provider transcripts are touched.
export class ClaudeTitleSync {
  constructor(directory) {
    if (!path.isAbsolute(directory)) throw new TypeError("Title sync directory must be absolute");
    this.directory = directory;
  }

  settings() {
    const command = [process.execPath, fileURLToPath(new URL("./claude-title-hook.mjs", import.meta.url)), this.directory].map(quote).join(" ");
    const hooks = [{ type: "command", command, timeout: 2 }];
    return JSON.stringify({ hooks: {
      SessionStart: [{ matcher: "startup|resume", hooks }],
      UserPromptSubmit: [{ hooks }],
    } });
  }

  #file(id, suffix) {
    if (!UUID.test(id)) return null;
    return path.join(this.directory, `${id}.${suffix}.json`);
  }

  available(id) {
    const file = this.#file(id, "ready");
    return file !== null && read(file)?.version === 1;
  }

  queue(id, name) {
    if (!this.available(id)) return false;
    if (typeof name !== "string" || !name.trim() || /[\u0000-\u001f\u007f]/u.test(name)) throw new TypeError("Invalid session title");
    write(this.#file(id, "request"), { id: crypto.randomUUID(), name: name.trim() });
    return true;
  }

  display(id, nativeName) {
    try {
      if (!this.available(id)) return null;
      const request = read(this.#file(id, "request"));
      if (request && read(this.#file(id, "receipt"))?.id !== request.id) {
        return { name: request.name, nameSync: "pending" };
      }
      // Emission is not an application acknowledgement. Follow native truth,
      // including later /rename, instead of leaving a permanent local alias.
      return { name: nativeName, nameSync: "native" };
    } catch {
      // Optional sync state must never hide an otherwise valid live session.
      return null;
    }
  }

  hook(input) {
    const id = input?.session_id;
    if (typeof id !== "string" || !UUID.test(id) || input.agent_id) return null;
    if (input.hook_event_name === "SessionStart") {
      write(this.#file(id, "ready"), { version: 1 });
      return null; // Startup title changes can race native background registration.
    }
    if (input.hook_event_name !== "UserPromptSubmit" || !this.available(id)) return null;
    const request = read(this.#file(id, "request"));
    if (!request || read(this.#file(id, "receipt"))?.id === request.id) return null;
    if (!UUID.test(request.id) || typeof request.name !== "string" || !request.name.trim() || /[\u0000-\u001f\u007f]/u.test(request.name)) throw new TypeError("Invalid pending session title");
    // At-most-once delivery: a failed/terminated hook may require another F2.
    write(this.#file(id, "receipt"), { id: request.id });
    return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", sessionTitle: request.name } };
  }
}

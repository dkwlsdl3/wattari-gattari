import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { APP_ID } from "./product.mjs";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const fail = (code, message) => Object.assign(new Error(message), { code });

// Linux /proc stat field 22; comm (in parentheses) may itself contain spaces.
function processIdentity(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return ["Z", "X"].includes(fields[0]) ? null : fields[19];
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ESRCH") return null;
    throw error;
  }
}

export class RequestStore {
  constructor(directory = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), APP_ID, "requests")) {
    this.directory = directory;
  }

  file(id) {
    if (!UUID.test(id)) throw fail("REQUEST_ID_INVALID", "Expected a full Waga request UUID");
    return path.join(this.directory, `${id}.json`);
  }

  create(session, { untilIdle = false, kind = "ask" } = {}) {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.uid !== process.getuid()) {
      throw fail("REQUEST_STORE_UNSAFE", "Request directory must be private and owned by the current user");
    }
    const record = {
      version: 1, requestId: crypto.randomUUID(), session, target: session.id, kind, untilIdle,
      state: "not-sent", delivery: "not-sent", createdAt: Date.now(),
      owner: { pid: process.pid, start: processIdentity(process.pid) }, finished: false,
    };
    fs.writeFileSync(this.file(record.requestId), JSON.stringify(record), { flag: "wx", mode: 0o600 });
    return record;
  }

  read(id) {
    const file = this.file(id);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw fail("REQUEST_RECORD_INVALID", "Invalid request record");
      const record = JSON.parse(fs.readFileSync(fd, "utf8"));
      if (record.version !== 1 || record.requestId !== id || record.target !== record.session?.id) throw fail("REQUEST_RECORD_INVALID", "Request identity mismatch");
      return record;
    } finally { fs.closeSync(fd); }
  }

  update(record, fields) {
    Object.assign(record, fields, { updatedAt: Date.now() });
    const file = this.file(record.requestId);
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(record), { flag: "wx", mode: 0o600 });
      fs.renameSync(temporary, file);
    } finally { fs.rmSync(temporary, { force: true }); }
    return record;
  }

  reply(id, value) {
    const file = `${this.file(id)}.reply`;
    if (value !== undefined) {
      // Publish a complete immutable reply with an atomic no-replace link.
      const temporary = `${file}.${crypto.randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
        try { fs.linkSync(temporary, file); } catch (error) { if (error.code !== "EEXIST") throw error; }
      } finally { fs.rmSync(temporary, { force: true }); }
    }
    let fd;
    try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
    try {
      if (!fs.fstatSync(fd).isFile()) throw fail("REQUEST_RECORD_INVALID", "Invalid reply record");
      return JSON.parse(fs.readFileSync(fd, "utf8"));
    } finally { fs.closeSync(fd); }
  }

  active(record) {
    return !record.finished && record.owner?.start != null && processIdentity(record.owner.pid) === record.owner.start;
  }

  async acquire(record, { timeoutMs, onProgress = () => {}, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
    // A single O_APPEND write is the admission order, shared by CLI processes.
    // No payload is queued, and a dead caller is never submitted by another process.
    const queue = path.join(this.directory, `${crypto.createHash("sha256").update(record.target).digest("hex")}.queue`);
    const fd = fs.openSync(queue, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
    try {
      const ticket = `${record.requestId}\n`;
      if (fs.writeSync(fd, ticket) !== Buffer.byteLength(ticket)) throw fail("REQUEST_QUEUE_INVALID", "Incomplete request ticket write");
    } finally { fs.closeSync(fd); }
    const deadline = Date.now() + timeoutMs;
    let reported = false;
    while (true) {
      const ids = fs.readFileSync(queue, "utf8").split("\n").filter(Boolean);
      const index = ids.indexOf(record.requestId);
      if (index < 0) throw fail("REQUEST_QUEUE_INVALID", "Request ticket is missing");
      const ahead = ids.slice(0, index).some(id => this.active(this.read(id)));
      if (!ahead) {
        if (Date.now() >= deadline) throw fail("TARGET_BUSY_TIMEOUT", "Local request queue timed out; message was not sent");
        return deadline - Date.now();
      }
      if (!reported) { onProgress({ state: "waiting-local", delivery: "not-sent" }); reported = true; }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw fail("TARGET_BUSY_TIMEOUT", "Local request queue timed out; message was not sent");
      await wait(Math.min(100, remaining));
    }
  }
}

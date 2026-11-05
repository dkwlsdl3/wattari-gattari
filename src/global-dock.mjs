import { queryHost } from "./global-hosts.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

// Navigation lives on the PC that owns the Dock, separately from native sessions.
export class DockNavigationStore {
  constructor(hostId, directory = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local/state"), "wattari-gattari", "remote-docks")) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(hostId)) throw Error("Invalid navigation host ID");
    this.file = path.join(directory, `${hostId}.json`);
  }

  load() {
    let fd;
    try {
      fd = fs.openSync(this.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 128 * 1024) throw Error("Invalid Dock navigation file");
      const value = JSON.parse(fs.readFileSync(fd, "utf8"));
      if (value.version !== 1 || !Array.isArray(value.collapsed) || value.collapsed.some(p => typeof p !== "string" || !path.isAbsolute(p))
          || typeof value.query !== "string" || value.query.length > 256 || ![null, "claude", "codex"].includes(value.provider)
          || (value.selectedKey !== null && typeof value.selectedKey !== "string")
          || !Number.isSafeInteger(value.previewOutputOffset) || value.previewOutputOffset < 0) throw Error("Invalid Dock navigation state");
      return value;
    } catch (error) { if (error.code === "ENOENT") return null; throw error; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }

  save(value) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${crypto.randomUUID()}.tmp`;
    try {
      const body = JSON.stringify({ ...value, version: 1 });
      if (Buffer.byteLength(body) > 128 * 1024) throw Error("Dock navigation exceeds 128KiB");
      fs.writeFileSync(temporary, body, { flag: "wx", mode: 0o600 });
      fs.renameSync(temporary, this.file);
    } finally { fs.rmSync(temporary, { force: true }); }
  }
}

export class GlobalDock {
  constructor(config, { query = queryHost, discover = null, connect = null } = {}) {
    this.config = config;
    this.query = query;
    this.selectedId = config.local.id;
    this.states = new Map(config.hosts.map(host => [host.id, { status: "unknown", summary: null }]));
    this.pending = null;
    this.updates = new Map();
    this.discover = discover;
    this.connector = connect;
    this.nextDiscovery = 0;
    this.discoveryError = '';
  }

  async connect(id, username) {
    const host = this.config.hosts.find(row => row.id === id);
    if (!host?.discovered || !this.connector) throw Error('연결 설정이 필요한 PC를 선택해 주세요.');
    const { host: ready, summary } = await this.connector(host, username, this.config);
    this.config.hosts = this.config.hosts.map(row => row.id === id ? ready : row);
    this.states.set(id, { status: summary.warnings?.length ? 'partial' : 'available', summary, release: summary.release, updatedAt: Date.now() });
    return ready;
  }

  refresh(changed = () => {}, { force = false } = {}) {
    if (this.pending) return this.pending;
    this.pending = (async () => {
      if (this.discover && (force || Date.now() >= this.nextDiscovery)) {
        this.nextDiscovery = Date.now() + 30_000;
        try { this.config = await this.discover(this.config); this.discoveryError = ''; }
        catch (error) { this.discoveryError = `PC 자동 탐색: ${error.message}`; }
        changed();
      }
      if (force) for (const state of this.states.values()) if (state.status === 'setup') state.attempted = false;
      await Promise.all(this.config.hosts.map(async host => {
        if (!this.states.has(host.id)) this.states.set(host.id, { status: 'unknown', summary: null });
        const previous = this.states.get(host.id);
        if (host.online === false) { this.states.set(host.id, { ...previous, status: 'offline' }); changed(); return; }
        if (host.discovered) {
          if (!previous.attempted && this.connector) {
            this.states.set(host.id, { ...previous, status: 'connecting', attempted: true }); changed();
            try { await this.connect(host.id); }
            catch (error) { this.states.set(host.id, { ...previous, status: 'setup', attempted: true, error: error.stderr?.trim() || error.message }); }
            changed();
          }
          return;
        }
        try {
          const summary = await this.query(host);
          this.states.set(host.id, { status: summary.warnings?.length ? "partial" : "available", summary, release: summary.release, updatedAt: Date.now() });
        } catch (error) {
          this.states.set(host.id, { ...previous, release: error.release ?? previous.release, status: previous.summary ? "stale" : "unavailable", error: error.stderr?.trim() || error.message });
        }
        changed();
      }));
    })().finally(() => { this.pending = null; });
    return this.pending;
  }

  rows(localSessions = [], localWarnings = [], localKnown = true) {
    return [{ ...this.config.local, local: true, status: localWarnings.length ? "partial" : "local", summary: localKnown ? { sessions: localSessions, warnings: localWarnings } : null },
      ...this.config.hosts.map(host => ({ ...host, ...this.states.get(host.id), update: this.updates.get(host.id) }))];
  }
}

// Scope drafts to both the work step and the exact native recipient.
export class DraftStore {
  constructor(storage, key = "waga.drafts.v1") { this.storage = storage; this.key = key; this.rows = new Map(); try { const rows = JSON.parse(storage.getItem(key) || "[]"); if (Array.isArray(rows)) this.rows = new Map(rows.filter(row => Array.isArray(row) && typeof row[0] === "string" && typeof row[1] === "string" && row[1].length <= 16000).slice(-100)); } catch { /* Storage may be unavailable. In-memory drafts still work. */ } }
  get(key) { return this.rows.get(key); }
  set(key, value) { if (value) { this.rows.delete(key); this.rows.set(key, value.slice(0, 16000)); } else this.rows.delete(key); while (this.rows.size > 100) this.rows.delete(this.rows.keys().next().value); this.#save(); }
  delete(key) { this.rows.delete(key); this.#save(); }
  #save() { try { this.storage.setItem(this.key, JSON.stringify([...this.rows])); } catch { /* Keep the current page usable if storage is full or disabled. */ } }
}

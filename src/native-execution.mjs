import crypto from "node:crypto";

const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const clip = (value, max = 4000) => (typeof value === "string" ? value : JSON.stringify(value ?? "")).slice(0, max);
const nanos = ms => Number.isFinite(ms) && ms > 0 ? String(BigInt(Math.trunc(ms)) * 1_000_000n) : "";
const content = (name, value) => ({ name, content: { [name]: clip(value) }, limited: (typeof value === "string" ? value : JSON.stringify(value ?? "")).length > 4000 });

// These are native observations, not invented OTLP requests or test verdicts.
// Stable native IDs correlate tool results across page boundaries and restarts.
export function nativeExecution(session, records, previous = [], agentId = "") {
  const traceId = hash(session.id).slice(0, 32), spans = new Map(previous.map(span => [span.id, span]));
  const identity = key => { const spanId = hash(key).slice(0, 16); return { id: `${traceId}:${spanId}`, traceId, spanId }; };
  function put(key, update) {
    const ids = identity(key), old = spans.get(ids.id);
    const events = new Map([...(old?.events ?? []), ...(update.events ?? [])].map(event => [event.name, event]));
    spans.set(ids.id, { ...ids, name: "", parentSpanId: "", start: "", end: "", state: "unknown", durationMs: null,
      ...old, ...update, contentLimited: Boolean(old?.contentLimited || [...events.values()].some(event => event.limited)), events: [...events.values()], attributes: { "session.id": session.id, ...(agentId ? { agent_id: agentId } : {}), ...old?.attributes, ...update.attributes } });
  }
  for (const row of records) {
    if (session.provider === "claude") {
      if (row?.sessionId !== session.sessionId || (agentId ? row.agentId !== agentId : row.isSidechain) || row.isMeta) continue;
      const start = nanos(Date.parse(row.timestamp)), message = row.message;
      if (row.type === "assistant" && message?.id) {
        const attrs = { model: clip(message.model, 200) };
        for (const key of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]) {
          const name = key.replace("_input", "");
          if (Number.isFinite(message.usage?.[key])) attrs[name] = message.usage[key];
        }
        put(`message:${message.id}`, { name: "native.llm_request", ...(agentId ? { parentSpanId: identity(`agent:${agentId}`).spanId } : {}), ...(start ? { start } : {}), attributes: attrs });
      }
      for (const block of Array.isArray(message?.content) ? message.content : []) {
        if (row.type === "assistant" && block.type === "tool_use" && block.id) {
          const input = block.input ?? {};
          put(`tool:${block.id}`, { name: clip(block.name, 200), parentSpanId: message.id ? identity(`message:${message.id}`).spanId : "",
            ...(start ? { start } : {}), attributes: { tool_name: clip(block.name, 200) }, command: clip(input.command ?? ""), file: clip(input.file_path ?? "", 2000), events: [content("content", input)] });
        }
        if (row.type === "user" && block.type === "tool_result" && block.tool_use_id) {
          put(`tool:${block.tool_use_id}`, { ...(start ? { end: start } : {}), state: block.is_error ? "error" : "returned", events: [content("output", block.content)] });
          const child = row.toolUseResult?.agentId;
          if (typeof child === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(child)) put(`agent:${child}`, {
            name: "native.agent", parentSpanId: identity(`tool:${block.tool_use_id}`).spanId,
            ...(start ? { start } : {}), attributes: { agent_id: child, "native.child_id": child } });
        }
      }
      continue;
    }
    const item = row.item;
    if (!item?.id || ["userMessage", "reasoning"].includes(item.type)) continue;
    const model = item.type === "agentMessage";
    const known = ["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "collabAgentToolCall", "webSearch", "imageView"];
    if (!model && !known.includes(item.type)) continue;
    const name = model ? "native.llm_request" : item.tool || item.type;
    const start = nanos(row.startedAtMs), end = nanos(row.completedAtMs);
    const failed = ["failed", "declined", "error"].includes(item.status) || (Number.isInteger(item.exitCode) && item.exitCode !== 0);
    const state = failed ? "error" : end || item.status === "completed" ? "returned" : "unknown";
    const events = model ? [] : item.changes?.length === 1 ? [content("diff", item.changes[0].diff)] : [content("content", item.arguments ?? item.changes ?? item.action ?? item.prompt ?? "")];
    if (item.aggregatedOutput != null || item.result != null || item.error != null) events.push(content("output", item.aggregatedOutput ?? item.result ?? item.error));
    put(item.id, { name, ...(agentId && model ? { parentSpanId: identity(`agent:${agentId}`).spanId } : {}), start, end, state, durationMs: Number.isFinite(item.durationMs) ? item.durationMs : null,
      attributes: model ? {} : { tool_name: name }, command: clip(item.command ?? ""), file: clip(item.path ?? item.changes?.[0]?.path ?? "", 2000), events });
    // The provider explicitly records receivers; chronology alone never creates an edge.
    if (item.type === "collabAgentToolCall") for (const child of item.receiverThreadIds ?? []) {
      put(`agent:${child}`, { name: "native.agent", parentSpanId: identity(item.id).spanId, start,
        attributes: { agent_id: child, "native.child_id": child, model: clip(item.model ?? "", 200) },
        events: [content("content", item.agentsStates?.[child] ?? "상태 미기록")] });
    }
  }
  // Missing timestamps retain provider order; result-only fragments await their call page.
  return [...spans.values()].sort((a, b) => a.start.length - b.start.length || a.start.localeCompare(b.start)).slice(-2000);
}

export class NativeExecutionCollector {
  #bridge; #store; #states = new Map(); #pending; #stop = new AbortController();
  constructor({ bridge, store }) { this.#bridge = bridge; this.#store = store; }
  close() { this.#stop.abort(); }
  sweep(sessions) {
    if (this.#pending) return this.#pending;
    this.#pending = this.#sweep(sessions).finally(() => { this.#pending = null; });
    return this.#pending;
  }
  async #sweep(sessions) {
    const active = new Set(sessions.map(session => session.id));
    for (const id of this.#states.keys()) if (!active.has(id)) this.#states.delete(id);
    for (const session of sessions) {
      if (this.#stop.signal.aborted) return;
      let state = this.#states.get(session.id) ?? {};
      try {
        const options = { signal: this.#stop.signal };
        const latest = await this.#bridge.execution(session, options);
        let row = this.#store.native(session), spans = nativeExecution(session, latest.records, row?.spans);
        const recordId = record => record.uuid || record.item?.id;
        const ids = latest.records.map(recordId).filter(Boolean);
        state.gaps ??= [];
        if (state.head && ids.length && !ids.includes(state.head) && latest.nextCursor) state.gaps.push({ cursor: latest.nextCursor, until: state.head });
        if (ids.length) state.head = ids.at(-1);
        if (state.gaps.length) {
          const gap = state.gaps[0], page = await this.#bridge.execution(session, { ...options, cursor: gap.cursor });
          spans = nativeExecution(session, page.records, spans);
          if (!page.nextCursor || page.nextCursor === gap.cursor || page.records.some(record => recordId(record) === gap.until)) state.gaps.shift();
          else gap.cursor = page.nextCursor;
        }
        const cursor = row?.collection?.limited ? null : state.cursor === undefined ? latest.nextCursor : state.cursor;
        let nextCursor = cursor;
        if (cursor) {
          const older = await this.#bridge.execution(session, { ...options, cursor });
          spans = nativeExecution(session, older.records, spans);
          nextCursor = older.nextCursor === cursor ? null : older.nextCursor;
          state.skipped ||= older.skipped;
        }
        state = { ...state, cursor: nextCursor, skipped: Boolean(state.skipped || latest.skipped) };
        const children = [...new Set(spans.map(span => span.attributes["native.child_id"]).filter(Boolean))];
        if (children.length) {
          state.childIndex = ((state.childIndex ?? -1) + 1) % children.length;
          const child = children[state.childIndex]; state.children ??= new Map();
          try {
            const childSession = session.provider === "codex" ? { ...session, nativeId: child } : session;
            const childOptions = { ...options, ...(session.provider === "claude" ? { agentId: child } : {}) };
            const page = await this.#bridge.execution(childSession, childOptions);
            spans = nativeExecution(session, page.records, spans, child);
            const childCursor = state.children.has(child) ? state.children.get(child) : page.nextCursor;
            if (childCursor) {
              const older = await this.#bridge.execution(childSession, { ...childOptions, cursor: childCursor });
              spans = nativeExecution(session, older.records, spans, child);
              state.children.set(child, older.nextCursor === childCursor ? null : older.nextCursor);
            } else state.children.set(child, null);
            state.childError = "";
          } catch (error) { state.childError = clip(error.message, 300); state.children.delete(child); }
        }
        if (this.#stop.signal.aborted) return;
        this.#store.saveNative(session, spans, { collectingHistory: Boolean(nextCursor) || Boolean(state.gaps.length) || [...(state.children?.values() ?? [])].some(Boolean), skipped: state.skipped, error: state.childError || "" });
      } catch (error) {
        if (this.#stop.signal.aborted) return;
        if (error.code === "EXECUTION_UNAVAILABLE") continue;
        // Retain last good data and retry an invalidated history cursor from the head.
        state = { cursor: undefined };
        try { this.#store.saveNative(session, this.#store.native(session)?.spans ?? [], { error: clip(error.message, 300) }); } catch { /* Other sessions must still collect. */ }
      }
      this.#states.set(session.id, state);
    }
  }
}

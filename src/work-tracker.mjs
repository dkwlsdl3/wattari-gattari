import { nativeSpanIdentity } from './native-execution.mjs';
import crypto from 'node:crypto';
import { mergeHistoryMessages } from './session-history.mjs';

// Observe explicitly registered instructions without creating tasks or model jobs from chat.
export class WorkTracker {
  constructor({ bridge, store, executions, assistant, now = Date.now }) {
    Object.assign(this, { bridge, store, executions, assistant, now });
    this.sessions = new Map(); this.pending = null; this.closed = false;
  }
  watch(session) {
    this.sessions.set(session.id, { ...this.sessions.get(session.id), ...session });
    if (this.sessions.size > 20) this.sessions.delete(this.sessions.keys().next().value);
  }
  observe(session, page) {
    if (this.closed) return;
    this.watch(session);
    const messages = page.messages ?? [];
    this.store.reconcile(session.id, messages);
    const original = messages.findLast(message => message.role === 'user');
    if (!original?.id || !original.text?.trim() || original.text.length > 16000) return;
    const work = this.store.list(session.id).find(row => row.messageId === original.id);
    if (!work) return;
    for (const previous of this.store.list(session.id)) {
      if (previous.id !== work.id && ['working', 'waiting', 'needs-input'].includes(previous.progress?.state)
        && messages.some(message => message.id === previous.messageId)) {
        this.store.progress(previous.id, { ...previous.progress, state: 'continued', current: '' });
      }
    }
    const index = messages.findIndex(message => message.id === original.id);
    const window = messages.slice(index + 1), calls = window.filter(message => message.role === 'activity');
    const signature = crypto.createHash('sha256').update(JSON.stringify(window)).digest('hex');
    const changedAt = work.progress?.signature === signature ? work.progress.changedAt : this.now();
    const spans = this.executions.native(session)?.spans ?? [];
    const error = calls.findLast(call => call.state === 'error');
    const running = calls.findLast(call => call.state === 'running');
    const response = window.findLast(message => message.role === 'assistant');
    const state = session.status === 'needs-input' ? 'needs-input' : session.status === 'working' || running ? 'working'
      : session.status === 'error' ? 'error' : response ? 'responded' : 'waiting';
    const progress = { state, signature, changedAt, calls: calls.length, errors: calls.filter(call => call.state === 'error').length,
      current: (running?.text ?? (state === 'needs-input' ? '네이티브 세션의 승인·추가 입력을 기다립니다.' : '')).slice(0, 240),
      lastError: error ? `${error.tool ?? '도구'} · ${error.text ?? ''}`.replace(/\s+/g, ' ').slice(0, 180) : '',
      // Counts stay scoped to the instruction's exact tool item IDs.
      files: [...new Set(calls.flatMap(call => spans.filter(span => span.id === nativeSpanIdentity(session, call.id).id).map(span => span.file).filter(Boolean)))],
      response: response?.id };
    if (JSON.stringify(progress) !== JSON.stringify(work.progress)) this.store.progress(work.id, progress);
    return this.store.read(work.id);
  }
  tick() {
    if (this.closed) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = this.sweep().finally(() => { this.pending = null; });
    return this.pending;
  }
  async sweep() {
    if (!this.sessions.size) return;
    let sessions;
    try { sessions = (await this.bridge.discover()).sessions; } catch { return; }
    for (const [id, saved] of this.sessions) {
      if (this.closed) return;
      const session = sessions.find(item => item.id === id);
      if (!session || session.cwd !== saved.cwd) { this.sessions.delete(id); continue; }
      try {
        let page = await this.bridge.history(session, { activities: true });
        // Long-running turns can fill the latest page with tools alone. Read back to
        // the actual user ID; do not attach those calls to an arbitrary old work.
        for (let count = 1; count < 8 && !page.messages.some(row => row.role === 'user') && page.nextCursor; count++) {
          const older = await this.bridge.history(session, { activities: true, cursor: page.nextCursor });
          const nextCursor = older.nextCursor === page.nextCursor ? null : older.nextCursor;
          page = { ...older, messages: mergeHistoryMessages(older.messages, page.messages), nextCursor };
        }
        this.observe(session, page);
      } catch (error) {
        // Tracking must never hide native conversation or trigger another native instruction.
        const work = this.store.list(id).at(-1);
        if (work) this.store.trackingError(work.id, error.message.slice(0, 500));
      }
    }
  }
  close() { this.closed = true; }
}

import { workAnalysis } from "./work-analysis.mjs";
import { contextEditor } from "./work-context.mjs";
const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };

export function initWorks({ api, selected, changed, notice, followUp, handoff, graph }) {
  const cache = new Map();
  const route = (tail, sessionId) => `${tail}?session=${encodeURIComponent(sessionId)}`;
  function rows() { return cache.get(selected()?.id) ?? []; }
  function accept(work) {
    if (!work) return;
    const id = work.session.id, existing = cache.get(id) ?? [];
    if (JSON.stringify(existing.find(row => row.id === work.id)) === JSON.stringify(work)) return;
    cache.set(id, [...existing.filter(row => row.id !== work.id), work]);
    if (selected()?.id === id) changed();
  }
  async function refresh() {
    const id = selected()?.id; if (!id) return;
    const result = await api(route("works", id));
    if (JSON.stringify(cache.get(id)) !== JSON.stringify(result.works)) { cache.set(id, result.works); if (id === selected()?.id) changed(); }
  }
  async function create(instruction, sessionId, parentId, contextFrom) {
    const work = await api(route("works", sessionId), { id: crypto.randomUUID(), instruction, ...(parentId ? { parentId } : {}), ...(contextFrom ? { contextFrom } : {}) });
    cache.set(sessionId, [...(cache.get(sessionId) ?? []), work]); changed(); return work;
  }
  function display(item) { const work = rows().find(row => row.messageId === item.id); return work?.deliveryText ? { ...item, text: work.instruction } : item; }
  function items() {
    return rows().filter(row => !row.messageId).map(row => ({ id: `work:${row.id}`, role: "user", label: "나", text: row.instruction, workId: row.id, timestamp: row.createdAt }));
  }
  async function openContext(work) {
    const sessionId = selected()?.id;
    try {
      let row = await api(route(`works/${work.id}`, sessionId));
      if (selected()?.id !== sessionId) return;
      const dialog = el('dialog', undefined, 'work-context-dialog'), heading = el('div', undefined, 'history-heading');
      const close = el('button', '닫기'); close.onclick = () => dialog.close();
      heading.append(el('h2', '작업 지시·컨텍스트'), close); dialog.append(heading, el('p', row.plan?.title ?? row.instruction));
      const actions = el('div', undefined, 'work-actions');
      const follow = el('button', '이어서 지시'), attach = el('button', '다른 세션에 인계');
      follow.onclick = () => { if (selected()?.id !== sessionId) return; dialog.close(); followUp(row); };
      attach.onclick = () => { if (selected()?.id !== sessionId) return; dialog.close(); handoff(row); };
      attach.disabled = !row.context; attach.title = row.context ? '' : '아래 컨텍스트를 저장한 뒤 인계할 수 있습니다.';
      actions.append(follow, attach); dialog.append(actions);
      const edit = contextEditor(row, { notice, save: async context => {
        await api(route(`works/${row.id}`, sessionId), { context });
        row = await api(route(`works/${row.id}`, sessionId)); accept(row); attach.disabled = false; attach.title = ''; return row;
      } }); dialog.append(edit);
      const original = el('details'); original.append(el('summary', '원래 지시·전달 원문'), el('pre', row.deliveryText ?? row.instruction)); dialog.append(original);
      if (row.analysis) { const legacy = el('details'); legacy.append(el('summary', '이전에 요청한 모델 정리'), workAnalysis(row, { api, notice, handoff, graph, active: () => dialog.open && legacy.open })); dialog.append(legacy); }
      dialog.addEventListener('close', () => dialog.remove(), { once: true }); document.body.append(dialog); dialog.showModal();
    } catch (error) { notice(error.message); }
  }
  function decorate(bubble, item) {
    // A delivery receipt or ordinary tool call is not a task plan.
    const work = rows().find(row => item.workId === row.id || item.id === row.messageId);
    const old = bubble.querySelector('.work-record');
    bubble.querySelector('.work-progress')?.remove();
    if (!work?.plan && !work?.launches?.length) { old?.remove(); return; }
    const signature = JSON.stringify([work.id, work.plan?.revision, work.launches]);
    if (old?.dataset.signature === signature) return;
    let bar = old;
    if (!bar || bar.tagName !== 'DIV') { old?.remove(); bar = el('div', undefined, 'work-record'); bubble.append(bar); }
    bar.dataset.signature = signature; bar.replaceChildren();
    const open = el('button', undefined, 'work-link'); open.type = 'button';
    open.append(el('span', '◇', 'work-link-icon'), el('span', work.plan?.title ?? '등록된 작업'), el('span', '그래프 →', 'muted'));
    open.onclick = () => graph(work);
    const context = el('button', '지시·컨텍스트'); context.type = 'button'; context.onclick = () => { void openContext(work); };
    bar.append(open, context);
  }
  return { rows, items, display, create, refresh, decorate, accept };
}

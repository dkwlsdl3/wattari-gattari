import { contextEditor } from './work-context.mjs';
const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
export function workAnalysis(initial, { api, notice, handoff, graph, active }) {
  const panel = el('section', undefined, 'work-analysis'); let row = initial, timer, busy = false;
  const route = `works/${row.id}?session=${encodeURIComponent(row.session.id)}`;
  async function reload() { row = await api(route); render(); }
  async function analyze(refresh = false) {
    if (busy) return; busy = true;
    try { await api(route, { analyze: true, refresh }); await reload(); }
    catch (error) { panel.replaceChildren(el('p', error.message, 'task-blocked')); const retry = el('button', '작업 정리 다시 시도'); retry.onclick = () => { void analyze(true); }; panel.append(retry); }
    finally { busy = false; }
  }
  function render() {
    clearTimeout(timer); panel.replaceChildren();
    const analysis = row.analysis;
    if (!analysis || analysis.state === 'running') {
      panel.append(el('p', '대화·실행 기록에서 작업과 인계를 정리하고 있습니다. 기존 세션에는 지시를 보내지 않습니다.', 'muted'));
      if (analysis) timer = setTimeout(async () => { if (!panel.isConnected || !active()) return; try { await reload(); } catch (error) { notice(error.message); } }, 1000);
      return;
    }
    if (analysis.state === 'failed') panel.append(el('p', analysis.reason, 'task-blocked'));
    else {
      panel.append(el('p', analysis.summary), el('small', `모델이 제안한 정리 · ${new Date(analysis.completedAt).toLocaleString('ko-KR')} · 검사 통과 판정이 아닙니다.`, 'muted'));
      if (analysis.limited) panel.append(el('p', '긴 자료·기록의 일부만 사용했습니다. 원문에서 빠진 내용도 확인해 주세요.', 'muted'));
      if (analysis.state === 'stale') panel.append(el('p', '정리 도중 코드가 변경됐습니다. 실행 전에 갱신해야 합니다.', 'task-blocked'));
      const showGraph = el('button', '작업 관계·근거 보기'); showGraph.onclick = () => graph(row); panel.append(showGraph);
      const context = el('details'); context.append(el('summary', '다음 세션에 전달할 인계'));
      const selected = row.context ?? analysis.context;
      context.append(el('p', selected.goal));
      for (const [key, title] of Object.entries({ decisions: '결정', facts: '자료에서 정리한 내용', unknowns: '미확인 사항', next: '다음 작업' })) {
        if (!selected[key]?.length) continue;
        context.append(el('h4', title));
        for (const item of selected[key]) context.append(el('p', item.text), el('small', item.source ?? item.sourceId ?? '', 'muted'));
      }
      const attach = el('button', '이 인계로 다른 세션에 지시'); attach.onclick = () => handoff(row); context.append(attach);
      const edit = contextEditor(row, { notice, save: async value => { await api(route, { context: value }); await reload(); return row; } }); edit.querySelector('summary').textContent = '인계 내용 정정'; context.append(edit); panel.append(context);
      if (analysis.manifest) {
        const execution = el('details'); execution.append(el('summary', '이 계획으로 별도 격리 작업 시작'));
        execution.append(el('p', '아래 파일 수정과 검사 명령을 별도 작업 공간에서 실행합니다. 기존 세션의 작업을 이어 실행하는 기능과는 다릅니다.'));
        for (const node of analysis.manifest.nodes) execution.append(el('p', `${node.title}${node.outputs.length ? ` · 수정: ${node.outputs.join(', ')}` : ''}`), el('pre', JSON.stringify(node.check)));
        const start = el('button', '표시된 계획으로 격리 실행'); let launchId = crypto.randomUUID();
        const previous = row.launches?.find(launch => launch.analysisId === analysis.id);
        if (previous) start.textContent = '이미 시작한 실행 보기';
        start.disabled = analysis.state !== 'ready';
        start.onclick = async () => { start.disabled = true; try { if (previous) { graph(row, previous.runId); return; } const result = await api(route, { analysisId: analysis.id, launchId }); if (result.state !== 'started') throw Error('실행 여부가 미확정입니다. 원래 실행 기록을 확인해 주세요.'); await reload(); graph(row, result.runId); } catch (error) { notice(error.message); } finally { start.disabled = analysis.state !== 'ready'; } };
        execution.append(start); panel.append(execution);
      } else panel.append(el('p', '실행에 필요한 검사 명령·범위가 충분하지 않아 작업 관계만 정리했습니다.', 'muted'));
    }
    const update = el('button', '현재 대화로 정리 갱신'); update.onclick = () => { void analyze(true); }; panel.append(update);
  }
  render(); if (!row.analysis || row.analysis.state === 'running') void analyze();
  return panel;
}

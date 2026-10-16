import { workAnalysis } from "./work-analysis.mjs";
const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
const dates = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "medium", timeStyle: "medium", hour12: false });
const date = value => value ? `${dates.format(new Date(value))} (한국 시간)` : "시각 미기록";

export function initWorks({ api, selected, changed, notice, followUp, handoff, graph }) {
  const cache = new Map();
  const route = (tail, sessionId) => `${tail}?session=${encodeURIComponent(sessionId)}`;
  function rows() { return cache.get(selected()?.id) ?? []; }
  function accept(work) {
    if (!work) return;
    const id = work.session.id;
    const existing = cache.get(id) ?? [];
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
  function decorate(bubble, item) {
    const work = rows().find(row => item.workId === row.id || item.id === row.messageId);
    const old = bubble.querySelector(".work-record");
    const previous = bubble.querySelector('.work-progress');
    if (!work) { old?.remove(); previous?.remove(); return; }
    const progress = work.progress, analysis = work.analysis;
    const state = { working: '진행 중', 'needs-input': '승인·입력 대기', error: '세션 오류', responded: '응답 수신', waiting: '응답 대기', continued: '다음 지시 수신' }[progress?.state]
      ?? (work.delivery === 'unconfirmed' ? '전달 확인 중' : '전달됨 · 응답 대기');
    const keyStatus = JSON.stringify([progress, analysis?.state, analysis?.id, work.context?.revision, work.trackingError, work.launches]);
    if (previous?.dataset.version !== keyStatus) {
      const status = el('section', undefined, 'work-progress'); status.dataset.version = keyStatus;
      status.append(el('strong', state));
      if (progress?.current) status.append(el('p', progress.current));
      if (progress?.calls) status.append(el('small', `도구 ${progress.calls}회${progress.files.length ? ` · 관련 파일 ${progress.files.length}개` : ''}${progress.errors ? ` · 오류 ${progress.errors}회` : ''}`));
      if (progress?.lastError) status.append(el('p', `최근 오류: ${progress.lastError}`, 'task-blocked'));
      if (analysis?.state === 'running') status.append(el('small', '작업 관계·인계 정리 중'));
      else if (analysis?.state === 'ready') status.append(el('p', (work.context?.goal ?? analysis.context?.goal ?? analysis.summary).slice(0, 200)));
      else if (analysis?.state === 'failed') status.append(el('small', `자동 정리 실패: ${analysis.reason}`));
      else if (work.trackingError) status.append(el('small', `추적 갱신 실패: ${work.trackingError}`));
      if (analysis?.nodes?.length || progress?.calls || work.launches?.length) {
        const flow = el('button', '작업 흐름'); flow.type = 'button'; flow.onclick = () => graph(work, work.launches?.at(-1)?.runId); status.append(flow);
      }
      if (previous) previous.replaceWith(status); else bubble.append(status);
    }
    const key = item.id ?? work.id;
    const caption = '근거·인계';
    if (old?.dataset.key === key) { old.querySelector(":scope > summary").textContent = caption; return; }
    old?.remove();
    const details = el("details", undefined, "work-record"), summary = el("summary", caption), body = el("div");
    details.dataset.key = key; details.append(summary, body); bubble.append(details);
    let loading = false;
    details.addEventListener("toggle", async event => {
      if (event.target !== details || !details.open || loading) return; loading = true; body.textContent = "작업 기록 불러오는 중…";
      try {
        const sessionId = selected()?.id; if (!sessionId) return;
        const target = work;
        const row = await api(route(`works/${target.id}`, sessionId));
        if (!details.isConnected || selected()?.id !== sessionId) return;
        body.replaceChildren();
        const follow = el("button", "이 작업에 이어서 지시"); follow.type = "button"; follow.onclick = () => followUp(row); body.append(follow);
        body.append(el("p", `${row.session.name} · ${row.session.provider}\n${row.session.cwd}`, "muted"));
        body.append(el("p", row.delivery === "observed" ? "기존 세션의 원문 지시에서 연결했습니다. 작업 완료를 뜻하지 않습니다." : row.delivery === "submitted" ? "지시 입력 전달 · 완료 여부는 아래 검사 근거로 확인합니다." : "전달 미확정 · 원래 세션을 확인해 주세요. 자동 재전송하지 않습니다.", "muted"));
        if (row.deliveryText) { const delivered = el('details'); delivered.append(el('summary', '실제로 전달한 지시·인계 원문'), el('pre', row.deliveryText)); body.append(delivered); }
        if (row.messageRelation) body.append(el("p", "원문 내용이 일치하는 대화에 연결했습니다.", "muted"));
        if (row.instructions.length > 1) {
          const changes = el("details"), title = el("summary", `원래 지시·변경 지시 ${row.instructions.length}건`); changes.append(title);
          for (const instruction of row.instructions) changes.append(el("p", `${instruction.parentId ? "변경 지시" : "원래 지시"} · ${date(instruction.createdAt)}\n${instruction.instruction}`));
          body.append(changes);
        }
        if (row.parentId) {
          const parent = el("button", "이전 지시 보기"); parent.type = "button";
          parent.onclick = async () => {
            try { const previous = await api(route(`works/${row.parentId}`, row.session.id)); parent.replaceWith(el("blockquote", previous.instruction)); }
            catch (error) { notice(error.message); }
          }; body.append(parent);
        }
        body.append(workAnalysis(row, { api, notice, handoff, graph, active: () => details.open }));
        for (const run of row.runs) {
          const section = el("section", undefined, "work-evidence"); section.append(el("h3", run.title));
          if (run.blockedReason) section.append(el("p", run.blockedReason, "task-blocked"));
          section.append(el("p", `검사 대상 지시: ${row.instructions.find(instruction => instruction.id === run.workId)?.instruction ?? "미기록"}`, "muted"));
          const metrics = el('details'); metrics.append(el('summary', '실행 시간·사용량·PC 부하'));
          metrics.append(el('p', `경과 ${((run.elapsedMs ?? 0) / 1000).toFixed(1)}초 · 웹 제어 ${run.interventions ?? 0}회`));
          if (run.metrics) metrics.append(el('p', `PC 여유 메모리 최소 ${run.metrics.minAvailableGiB.toFixed(1)}GiB · PC CPU 최대 ${run.metrics.maxCpuPercent.toFixed(0)}% · ${run.metrics.samples}회 측정`));
          metrics.append(el('pre', JSON.stringify(run.nodes.flatMap(node => node.attempts.map(attempt => ({ task: node.title, worker: { provider: attempt.worker.provider, model: attempt.worker.model, usage: attempt.worker.usage ?? '미제공', costUsd: attempt.worker.costUsd ?? '미제공' }, review: { provider: attempt.review.provider, model: attempt.review.model, usage: attempt.review.usage ?? '미제공', costUsd: attempt.review.costUsd ?? '미제공' } }))), null, 2))); section.append(metrics);
          section.append(el("p", `기준 커밋 ${run.sourceCommit ?? "미기록"} · ${run.sourceCwd}`, "muted"));
          for (const node of run.nodes) {
            section.append(el("h4", node.title));
            const context = el("details"), contextTitle = el("summary", "전달한 지시·입력 자료");
            context.append(contextTitle, el("p", node.prompt));
            for (const input of node.inputs) context.append(el("p", `${input.from} → ${input.path}`));
            section.append(context);
            if (!node.attempts.length) section.append(el("p", "검사 결과가 아직 없습니다."));
            for (const [index, attempt] of node.attempts.entries()) {
              const evidence = el("details"), heading = el("summary", `시도 ${index + 1} · ${attempt.passed ? "검사·독립 검토 통과" : "통과하지 못함"} · ${date(attempt.at)}`);
              const check = attempt.check;
              evidence.append(heading, el("p", "검사 당시 결과입니다. 이후 변경의 유효성은 재검사가 필요합니다.", "muted"));
              evidence.append(el("p", `${node.workspace ?? "작업 폴더 미기록"}\n산출물 지문 ${attempt.fingerprint}`, "muted"));
              evidence.append(el("pre", JSON.stringify(check.argv ?? node.check)), el("p", `검사 종료 코드: ${check.exitCode ?? "미실행/중단"} · ${date(check.observedAt)}`));
              evidence.append(el("pre", [check.stdout, check.stderr].filter(Boolean).join("\n")));
              if (check.environment) evidence.append(el("p", `${check.environment.platform}/${check.environment.arch} · Node ${check.environment.node}`, "muted"));
              evidence.append(el("p", `독립 검토: ${attempt.review?.reason ?? attempt.review?.verdict ?? "미실행"}`));
              for (const artifact of attempt.artifacts ?? []) evidence.append(el("p", `${artifact.path} · ${artifact.missing ? "파일 없음" : artifact.sha256}`, "muted"));
              if (attempt.diff) { const diff = el("pre", undefined, "diff-code"); for (const line of attempt.diff.split("\n")) diff.append(el("span", line, line.startsWith("+") ? "diff-add" : line.startsWith("-") ? "diff-remove" : "")); evidence.append(diff); }
              if (attempt.worker?.summary) evidence.append(el("p", `작업자 보고: ${attempt.worker.summary}`));
              section.append(evidence);
            }
          }
          body.append(section);
        }
        if (!row.runs.length) body.append(el("p", "Waga가 별도로 실행한 검사 기록은 없습니다.", "muted"));
      } catch (error) { body.textContent = error.message; } finally { loading = false; }
    });
  }
  return { rows, items, display, create, refresh, decorate, accept };
}

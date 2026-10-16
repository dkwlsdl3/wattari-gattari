import { contextEditor } from "./work-context.mjs";
const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
const dates = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "medium", timeStyle: "medium", hour12: false });
const date = value => value ? `${dates.format(new Date(value))} (한국 시간)` : "시각 미기록";

export function initWorks({ api, selected, changed, notice, followUp, handoff }) {
  const cache = new Map();
  const route = (tail, sessionId) => `${tail}?session=${encodeURIComponent(sessionId)}`;
  function rows() { return cache.get(selected()?.id) ?? []; }
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
    if (!work) { old?.remove(); return; }
    const caption = work.delivery === "submitted" ? "작업 기록" : "작업 기록 · 전달 미확정";
    if (old?.dataset.workId === work.id) { old.querySelector(":scope > summary").textContent = caption; return; }
    old?.remove();
    const details = el("details", undefined, "work-record"), summary = el("summary", caption), body = el("div");
    details.dataset.workId = work.id; details.append(summary, body); bubble.append(details);
    let loading = false;
    details.addEventListener("toggle", async event => {
      if (event.target !== details || !details.open || loading) return; loading = true; body.textContent = "작업 기록 불러오는 중…";
      try {
        const row = await api(route(`works/${work.id}`, work.session.id)); body.replaceChildren();
        const follow = el("button", "이 작업에 이어서 지시"); follow.type = "button"; follow.onclick = () => followUp(row); body.append(follow);
        body.append(el("p", `${row.session.name} · ${row.session.provider}\n${row.session.cwd}`, "muted"));
        body.append(el("p", row.delivery === "submitted" ? "지시 입력 전달 · 완료 여부는 아래 검사 근거로 확인합니다." : "전달 미확정 · 원래 세션을 확인해 주세요. 자동 재전송하지 않습니다.", "muted"));
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
        const attach = el('button', '이 인계를 다음 지시에 첨부'); attach.type = 'button'; attach.disabled = !row.context; attach.onclick = async () => { try { handoff?.(await api(route(`works/${row.id}`, row.session.id))); } catch (error) { notice(error.message); } }; if (handoff) body.append(attach);
        body.append(contextEditor(row, { notice, save: async context => {
          await api(route(`works/${row.id}`, row.session.id), { context }); attach.disabled = false;
          return api(route(`works/${row.id}`, row.session.id));
        } }));
        const refs = el("details"), refTitle = el("summary", `참고 자료 ${row.references.length}개`), form = el("form"), label = el("label", "출처 (한 줄에 하나)"), input = el("textarea"), save = el("button", "자료 저장");
        input.value = row.references.map(ref => ref.source).join("\n"); input.rows = 3; input.maxLength = 60000; label.append(input); form.append(label, save); refs.append(refTitle, form); body.append(refs);
        form.onsubmit = async event => { event.preventDefault(); save.disabled = true;
          try { const saved = await api(route(`works/${row.id}`, row.session.id), { references: input.value.split("\n").filter(value => value.trim()) }); refTitle.textContent = `참고 자료 ${saved.references.length}개`; }
          catch (error) { notice(error.message); } finally { save.disabled = false; }
        };
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
        if (!row.runs.length) body.append(el("p", "연결된 실행·검사 근거가 없습니다. 응답만으로 완료 처리하지 않습니다.", "muted"));
        const launchForm = el('details'), launchTitle = el('summary', '작업 실행'), launchInput = el('textarea'), launchButton = el('button', '명세대로 격리 실행'), launchStatus = el('p');
        launchInput.rows = 6; launchInput.maxLength = 60000; launchInput.setAttribute('aria-label', '실행 명세 JSON'); launchInput.placeholder = '검사 명령과 수정 파일이 명시된 JSON 실행 명세'; launchButton.type = 'button';
        launchForm.append(launchTitle, el('p', '실제 검사 명령이 실행됩니다. 수정은 별도 worktree에 보관하고 원본에 자동 적용하지 않습니다.'), launchInput, launchButton, launchStatus); body.append(launchForm);
        let launchId = crypto.randomUUID();
        launchInput.oninput = () => { launchId = crypto.randomUUID(); };
        launchButton.onclick = async () => { launchButton.disabled = true;
          try { const launch = JSON.parse(launchInput.value); const result = await api(route(`works/${row.id}`, row.session.id), { launch, launchId }); if (result.state === 'uncertain') throw Error('실행 시작 여부가 미확정입니다. 기존 실행 기록을 먼저 확인해 주세요.'); launchStatus.textContent = '실행을 시작했습니다. 실행 흐름에서 진행·검사 근거를 확인할 수 있습니다.'; launchStatus.dataset.runId = result.runId; }
          catch (error) { notice(error.message); } finally { launchButton.disabled = false; }
        };
        const more = el("details"), title = el("summary", "실행 명세 연결"), id = el("code", `"workId": "${row.id}"`);
        more.append(title, el("p", "waga run 실행 명세의 최상위에 이 값을 넣으면 변경·검사·결과가 이 지시에 연결됩니다."), id); body.append(more);
      } catch (error) { body.textContent = error.message; } finally { loading = false; }
    });
  }
  return { rows, items, display, create, refresh, decorate };
}

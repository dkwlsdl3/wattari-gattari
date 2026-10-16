const el = (tag, text) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node; };
export function contextEditor(row, { save, notice }) {
  const details = el('details'), summary = el('summary', '컨텍스트·인계'), form = el('form'); details.append(summary, form);
  const goalLabel = el('label', '현재 목표'), goal = el('textarea'); goal.rows = 2; goal.maxLength = 4000; goal.value = row.context?.goal ?? row.instruction; goalLabel.append(goal); form.append(goalLabel);
  const groups = {};
  for (const [key, title] of Object.entries({ decisions: '지켜야 할 결정', facts: '출처가 있는 확인 사실', unknowns: '미확인 사항', next: '다음 작업' })) {
    const group = el('details'), heading = el('summary', title), list = el('div'), add = el('button', '항목 추가'); add.type = 'button'; group.append(heading, list, add); form.append(group); groups[key] = [];
    function entry(value = {}) {
      const box = el('fieldset'), text = el('textarea'), source = el('input'), version = el('input'), kind = el('select'), remove = el('button', '항목 삭제');
      const field = (title, control) => { const label = el('label', title); label.append(control); box.append(label); };
      text.value = value.text ?? ''; text.rows = 2; text.maxLength = 4000; source.value = value.source ?? ''; source.maxLength = 2000; version.value = value.version ?? ''; version.maxLength = 200;
      for (const [id, label] of Object.entries({ user: '사용자 결정·선호', project: '프로젝트 규칙·자료', inference: '임시 판단' })) { const option = el('option', label); option.value = id; kind.append(option); } kind.value = value.kind ?? 'user';
      field('내용', text); field(key === 'facts' ? '원문 출처 (필수)' : '원문 출처', source); field('자료 버전·커밋 (알고 있는 경우)', version); field('구분', kind);
      if (value.observedAt) box.append(el('small', `관측: ${new Date(value.observedAt).toLocaleString('ko-KR')}`));
      remove.type = 'button'; box.append(remove); list.append(box);
      const item = { box, read: () => ({ text: text.value, source: source.value, version: version.value, kind: kind.value, ...(value.observedAt ? { observedAt: value.observedAt } : {}) }) }; groups[key].push(item);
      remove.onclick = () => { box.remove(); groups[key] = groups[key].filter(other => other !== item); };
    }
    for (const value of row.context?.[key] ?? []) entry(value);
    add.onclick = () => { if (groups[key].length < 30) entry(); };
  }
  const submit = el('button', '인계 저장'), copy = el('button', '인계문 복사'), status = el('p'); copy.type = 'button'; form.append(submit, copy, status);
  form.onsubmit = async event => { event.preventDefault(); submit.disabled = true;
    try { row = await save({ goal: goal.value, ...Object.fromEntries(Object.entries(groups).map(([key, items]) => [key, items.map(item => item.read())])) }); status.textContent = '저장했습니다. 출처의 관측 시각은 임의로 갱신하지 않습니다.'; }
    catch (error) { notice(error.message); } finally { submit.disabled = false; }
  };
  copy.onclick = async () => { try { if (!row.handoff) throw Error('인계 정보를 저장한 뒤 다시 열어 주세요.'); await navigator.clipboard.writeText(row.handoff); status.textContent = '인계문을 복사했습니다. 다른 세션의 지시에 첨부할 수 있습니다.'; } catch (error) { notice(error.message); } };
  details.append(el('p', '선택한 인계 정보만 실행에 첨부합니다. 세션 내부 컨텍스트 전체를 수집하지 않습니다.')); return details;
}

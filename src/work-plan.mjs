const fail = (status, message) => Object.assign(new Error(message), { status });
const text = (value, max) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw fail(400, '계획의 문자열 길이·내용을 확인해 주세요.');
  return value.trim();
};

// A skill's declared plan is observation metadata, never an executable manifest or test verdict.
export function validateWorkPlan(input) {
  if (!input || !Number.isInteger(input.revision) || input.revision < 0 || !Array.isArray(input.nodes) || !input.nodes.length || input.nodes.length > 50) throw fail(400, '계획에는 현재 revision과 1~50개 단계가 필요합니다.');
  const nodes = input.nodes.map(node => {
    if (!node || !Array.isArray(node.dependsOn) || node.dependsOn.length > 50 || !Array.isArray(node.evidence) || node.evidence.length > 20) throw fail(400, '선행 단계·근거 배열이 필요합니다.');
    const id = text(node.id, 64);
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || !['pending', 'active', 'blocked', 'reported'].includes(node.state)) throw fail(400, '계획 단계 ID·상태를 확인해 주세요.');
    const reason = node.reason === undefined || node.reason === '' ? '' : text(node.reason, 1000);
    if (node.state === 'blocked' && !reason) throw fail(400, '막힌 단계에는 이유가 필요합니다.');
    return { id, title: text(node.title, 160), dependsOn: [...new Set(node.dependsOn.map(id => text(id, 64)))], state: node.state, reason, evidence: node.evidence.map(source => text(source, 2000)) };
  });
  const byId = new Map(nodes.map(node => [node.id, node]));
  if (byId.size !== nodes.length) throw fail(400, '계획 단계 ID가 중복됐습니다.');
  const visiting = new Set(), visited = new Set();
  function visit(node) {
    if (visiting.has(node.id)) throw fail(400, '계획의 선행 관계가 순환합니다.');
    if (visited.has(node.id)) return;
    visiting.add(node.id);
    for (const id of node.dependsOn) { if (!byId.has(id)) throw fail(400, '존재하지 않는 선행 단계입니다.'); visit(byId.get(id)); }
    visiting.delete(node.id); visited.add(node.id);
  }
  nodes.forEach(visit);
  return { title: text(input.title, 160), skill: text(input.skill, 160), nodes };
}

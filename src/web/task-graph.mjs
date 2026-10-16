export function taskGraph(run) {
  const names = new Map(run.nodes.map(node => [node.id, node.title]));
  const nodes = run.nodes.map(node => {
    const waiting = run.proposal || run.declaration ? [] : node.dependsOn.filter(id => run.nodes.find(other => other.id === id)?.state !== 'passed');
    const failure = node.attempts.at(-1)?.failure;
    const blockedReason = node.blockedReason || (waiting.length ? `선행 결과 대기: ${waiting.map(id => names.get(id)).join(', ')}` : node.state === 'waiting-resource' ? 'PC 자원 여유 대기' : node.state === 'paused' ? '사용자가 일시정지함' : node.state === 'interrupted' ? `기존 실행 회수 필요: ${failure?.reason ?? '소유 프로세스·저장된 결과 확인'}` : failure?.reason ?? '');
    return { ...node, blockedReason };
  });
  const edges = run.nodes.flatMap(node => node.dependsOn.map(from => {
    const files = node.inputs.filter(input => input.from === from).map(input => input.path);
    return { from, to: node.id, kind: files.length ? 'artifact' : 'dependency', basis: run.proposal ? 'llm-proposal' : 'declared', label: run.declaration ? '계획한 선행 관계' : files.length ? `${run.proposal ? '제안한 전달 파일' : '전달할 산출물'}: ${files.join(', ')}` : run.proposal ? 'LLM이 제안한 선행 관계' : '선행 검사·독립 검토 통과 필요', files };
  }));
  return { nodes, edges };
}

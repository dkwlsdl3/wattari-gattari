export const reviewSchema = { type: 'object', properties: { verdict: { type: 'string', enum: ['pass', 'fail'] }, reason: { type: 'string' } }, required: ['verdict', 'reason'], additionalProperties: false };
export function codexArguments({ prompt, model, role, review, schemaFile }) {
  return ['exec', '--ignore-user-config', '--sandbox', review || role !== 'edit' ? 'read-only' : 'workspace-write', '-c', 'approval_policy="never"', '--json', '--model', model, ...(review ? ['--output-schema', schemaFile] : []), '--', prompt];
}
export function codexResult(result, model, review) {
  const events = result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const sessionId = events.find(event => event.type === 'thread.started')?.thread_id ?? '';
  const completed = events.findLast(event => event.type === 'turn.completed');
  const failed = events.find(event => ['turn.failed', 'error'].includes(event.type));
  const summary = events.filter(event => event.type === 'item.completed' && event.item?.type === 'agent_message').at(-1)?.item.text ?? failed?.message ?? result.failure ?? result.stderr;
  let verdict;
  if (review) { try { verdict = JSON.parse(summary); if (typeof verdict === 'string') verdict = JSON.parse(verdict); } catch { /* A malformed verdict never passes. */ } if (verdict?.verdict === 'pass' && !(typeof verdict.reason === 'string' && verdict.reason.trim())) verdict = undefined; }
  return { provider: 'codex', model, sessionId, exitCode: result.failure || failed || !completed || !sessionId ? null : result.exitCode, failureKind: ['approval_required', 'permission_denied'].includes(failed?.error?.code ?? failed?.code) ? 'permission' : undefined, signal: result.signal, summary: summary.slice(0, 8000), usage: completed?.usage ?? null, costUsd: null, verdict: verdict?.verdict, reason: typeof verdict?.reason === 'string' ? verdict.reason.slice(0, 2000) : undefined, durationMs: result.durationMs };
}

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile), hash = text => crypto.createHash('sha256').update(text).digest('hex');
export async function workspaceEvidence(node) {
  const options = { cwd: node.workspace, maxBuffer: 8 * 1024 * 1024, timeout: 10000 };
  const revision = (await exec('git', ['rev-parse', 'HEAD'], options)).stdout.trim();
  const diff = (await exec('git', ['diff', '--binary', 'HEAD'], options)).stdout;
  const files = [];
  for (const relative of [...new Set([...node.outputs, ...node.inputs.map(input => input.path)])].sort()) {
    const file = `${node.workspace}/${relative}`;
    // git diff covers tracked checker/source changes; hashes also cover new declared artifacts.
    try { const stat = await fs.lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw Error('검증 파일 형식 변경'); files.push([relative, hash(await fs.readFile(file))]); }
    catch (error) { if (error.code !== 'ENOENT') throw error; files.push([relative, null]); }
  }
  return { revision, fingerprint: hash(JSON.stringify({ revision, diff, files, check: node.check })), observedAt: Date.now() };
}
export async function staleNodes(run) {
  const stale = [];
  for (const node of run.nodes.filter(node => node.state === 'passed')) {
    const previous = node.attempts.at(-1)?.evidence;
    if (!previous) continue; // Older records remain historical, without a new validity claim.
    try { if ((await workspaceEvidence(node)).fingerprint !== previous.fingerprint) stale.push(node.id); }
    catch { stale.push(node.id); }
  }
  return stale;
}
export function failureOf(result) {
  if (result.check?.failureKind === 'environment' || result.review?.failureKind === 'environment') return { kind: 'environment', action: 'recover', reason: result.check.failureKind === 'environment' ? result.check.stderr : result.review.reason };
  if (result.worker?.exitCode !== 0) return { kind: result.worker?.failureKind ?? 'uncertain', action: result.worker?.failureKind === 'permission' ? 'wait' : 'recover', reason: result.worker?.summary ?? '작업 응답 미확인' };
  if (result.check.exitCode !== 0 || result.check.signal) return { kind: result.check.signal || result.check.exitCode === null ? 'interrupted' : 'code', action: result.check.signal || result.check.exitCode === null ? 'recover' : 'repair', reason: result.check.stderr || result.check.stdout || '동작 검사 실패' };
  if (result.review?.verdict !== 'pass' || !result.review?.unchanged) return { kind: result.review?.exitCode === 0 ? 'code' : 'uncertain', action: result.review?.exitCode === 0 ? 'repair' : 'recover', reason: result.review?.reason || result.review?.summary || '독립 검토 미확인' };
  return null;
}
export function progressSignature(result) {
  // A different patch alone is not progress when the observed failure is identical.
  return hash(JSON.stringify({ check: { exitCode: result.check.exitCode, signal: result.check.signal ?? null, stdout: result.check.stdout, stderr: result.check.stderr }, verdict: result.review?.verdict, reason: result.review?.reason, failure: failureOf(result)?.kind }));
}

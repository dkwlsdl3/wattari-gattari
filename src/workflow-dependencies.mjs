import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

const fail = message => Object.assign(Error(`실행 환경 준비 필요: ${message}`), { kind: 'environment' });
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const optional = async file => { try { return await fs.readFile(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
async function fingerprint(root) {
  const digest = crypto.createHash('sha256'); let entries = 0, bytes = 0;
  async function visit(relative = '') {
    const file = path.join(root, relative), stat = await fs.lstat(file);
    if (++entries > 100000 || (bytes += stat.isFile() ? stat.size : 0) > 256 * 1024 * 1024) throw fail('의존성 검사 한도를 초과했습니다.');
    digest.update(JSON.stringify([relative, stat.mode & 0o777, stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'directory' : 'file']));
    if (stat.isSymbolicLink()) digest.update(await fs.readlink(file));
    else if (stat.isDirectory()) { for (const name of (await fs.readdir(file)).sort()) if (relative || name !== '.waga-snapshot.json') await visit(path.join(relative, name)); }
    else if (stat.isFile()) digest.update(await fs.readFile(file));
    else throw fail('지원하지 않는 의존성 파일 형식입니다.');
  }
  await visit(); return digest.digest('hex');
}

// Reuse installed dependencies as a separate copy, never a writable link to the source.
// Installation scripts/network access belong to explicit project setup, not model retries.
export async function prepareDependencies(source, workspace) {
  const manifest = await optional(path.join(source, 'package.json'));
  if (!manifest) return;
  const pkg = JSON.parse(manifest);
  const lock = await optional(path.join(source, 'package-lock.json'));
  const basis = hash(Buffer.concat([manifest, Buffer.from('\0'), lock ?? Buffer.alloc(0)]));
  const localManifest = await optional(path.join(workspace, 'package.json'));
  const localLock = await optional(path.join(workspace, 'package-lock.json'));
  if (!localManifest || hash(Buffer.concat([localManifest, Buffer.from('\0'), localLock ?? Buffer.alloc(0)])) !== basis) throw fail('의존성 명세가 달라 별도 설치·검증이 필요합니다.');
  if (!Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies }).length) return;
  const from = path.join(source, 'node_modules'), target = path.join(workspace, 'node_modules');
  const marker = path.join(target, '.waga-snapshot.json');
  try {
    const stat = await fs.lstat(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('격리 의존성 경로가 디렉터리가 아닙니다.');
    const previous = await optional(marker);
    if (!previous || JSON.parse(previous).basis !== basis) throw fail('기존 의존성 사본을 확인할 수 없습니다.');
    if (await fingerprint(from) !== await fingerprint(target)) throw fail('격리 의존성 내용이 원본과 달라졌습니다.');
    return;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let stat; try { stat = await fs.lstat(from); } catch (error) { if (error.code === 'ENOENT') throw fail('원본 프로젝트에 설치된 node_modules가 없습니다.'); throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('원본 node_modules가 독립 디렉터리가 아닙니다.');
  try { await exec('git', ['check-ignore', '--quiet', 'node_modules/'], { cwd: workspace, timeout: 10000 }); }
  catch { throw fail('node_modules를 프로젝트 git 제외 목록에 먼저 등록해 주세요.'); }
  let bytes = 0, entries = 0;
  try {
    await fs.cp(from, target, { recursive: true, verbatimSymlinks: true, force: false, errorOnExist: true, filter: async file => {
      const info = await fs.lstat(file); entries++; bytes += info.isFile() ? info.size : 0;
      if (entries > 100000 || bytes > 256 * 1024 * 1024) throw fail('의존성 사본 한도 256MiB를 초과했습니다.');
      if (info.isSymbolicLink()) {
        const link = await fs.readlink(file), resolved = path.resolve(path.dirname(file), link);
        if (path.isAbsolute(link) || !resolved.startsWith(`${from}${path.sep}`)) throw fail('의존성이 원본 외부 경로를 참조합니다.');
      }
      return true;
    } });
    await fs.writeFile(marker, JSON.stringify({ basis, bytes, entries, copiedAt: Date.now() }), { mode: 0o600, flag: 'wx' });
  } catch (error) { await fs.rm(target, { recursive: true, force: true }); throw error; }
}

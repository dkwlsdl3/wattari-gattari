import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// Same local authentication boundary as the browser; never create tokens or start services.
export async function planRequest(route, value, url = process.env.WAGA_WEB_URL) {
  const endpoint = new URL(url || 'http://127.0.0.1:4317');
  if (endpoint.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(endpoint.hostname) || endpoint.username || endpoint.password) throw Error('계획 실행에는 로컬 Waga 웹 주소가 필요합니다.');
  let token = endpoint.hash.slice(1);
  if (!token) {
    const file = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local/state'), 'wattari-gattari/web-token');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try { const stat = fs.fstatSync(fd); if (!stat.isFile() || stat.size > 256 || stat.uid !== process.getuid() || stat.mode & 0o077) throw Error('웹 접속 키의 파일 권한을 확인해 주세요.'); token = fs.readFileSync(fd, 'utf8').trim(); }
    finally { fs.closeSync(fd); }
  }
  if (!/^[a-f0-9]{64}$/.test(token)) throw Error('웹 접속 키 형식을 확인해 주세요.');
  const response = await fetch(`${endpoint.origin}/api/${route}`, { redirect: 'error', signal: AbortSignal.timeout(10000), headers: { Cookie: `waga_web=${token}`, Origin: endpoint.origin, 'Content-Type': 'application/json' }, ...(value ? { method: 'POST', body: JSON.stringify(value) } : {}) });
  const data = await response.json();
  if (!response.ok) throw Error(data.error?.message || `Waga HTTP ${response.status}`);
  return data;
}
export async function executePlan(work, url) {
  if (!work.plan.execution) throw Error('실행할 단계별 지시·산출물·검사 명세가 필요합니다.');
  return planRequest(`works/${work.id}?session=${encodeURIComponent(work.session.id)}`, { executePlan: work.plan.revision, launchId: crypto.randomUUID() }, url);
}

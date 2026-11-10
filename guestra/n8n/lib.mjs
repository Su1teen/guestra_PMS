import { join } from 'node:path';
import { readFileSync } from 'node:fs';
const dir = join(process.env.GUESTRA_N8N_DIR ?? process.cwd(), '/');
export const env = Object.fromEntries(readFileSync(dir + 'n8n.env', 'utf8').split('\n').filter(Boolean).map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
export const base = env.N8N_URL.replace(/\/$/, '') + '/api/v1';
export async function api(method, path, body, query) {
  const url = new URL(base + path);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
  let r; for (let attempt = 1; attempt <= 4; attempt++) { try { r = await fetch(url, { method, headers: { 'X-N8N-API-KEY': env.N8N_API_KEY, 'content-type': 'application/json', accept: 'application/json' }, body: body ? JSON.stringify(body) : undefined }); break; } catch (e) { if (attempt === 4) throw e; await new Promise(res => setTimeout(res, 1500 * attempt)); } }
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t.slice(0, 300); }
  return { status: r.status, body: j };
}
export const dirPath = dir;

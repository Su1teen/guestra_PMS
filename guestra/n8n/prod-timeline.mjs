import { readFileSync } from 'node:fs';
const d = process.env.GUESTRA_N8N_DIR + '/';
const env = Object.fromEntries(readFileSync(d + 'studio.env', 'utf8').split('\n').filter(Boolean).map(l => { const i = l.indexOf('='); let v = l.slice(i + 1); if (v.startsWith('"')) v = JSON.parse(v); return [l.slice(0, i), v]; }));
const base = process.env.STUDIO_URL; const st = JSON.parse(readFileSync(d + 'e2e-state.json', 'utf8'));
const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD }) });
const cookie = (login.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).join('; ');
const tl = await (await fetch(base + `/api/conversations/${st.conversationId}/timeline`, { headers: { cookie } })).json();
console.log(JSON.stringify({ runs: tl.runs?.map(r => ({ status: r.status, errorCode: r.errorCode, error: r.error, lastError: r.lastError, executionId: r.executionId })), attempts: tl.attempts?.map(a => ({ status: a.status, code: a.errorCode ?? a.code, message: a.message ?? a.error })) }, null, 1).slice(0, 1800));

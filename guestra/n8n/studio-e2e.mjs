import { join } from 'node:path';
// Drives the real AI Studio (sandbox) API like a tester: creates a virtual guest, sends messages, waits for the agent's replies.
// Usage: node studio-e2e.mjs "message 1" "message 2" ...   (env NEW=1 creates a fresh guest; otherwise reuses the last one)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const d = join(process.env.GUESTRA_N8N_DIR ?? process.cwd(), '/');
const env = Object.fromEntries(readFileSync(d + 'studio.env', 'utf8').split('\n').filter(Boolean).map(l => { const i = l.indexOf('='); let v = l.slice(i + 1); if (v.startsWith('"')) v = JSON.parse(v); return [l.slice(0, i), v]; }));
const base = process.env.STUDIO_URL;
const stateFile = d + 'e2e-state.json';
let st = existsSync(stateFile) && !process.env.NEW ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};
const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD }) });
const cookie = (login.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).join('; ');
const call = async (method, path, body) => { const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j }; };
const mode = await call('PUT', '/api/integrations/mode', { mode: 'sandbox' }); console.log('mode sandbox ->', mode.status, mode.status !== 200 ? JSON.stringify(mode.body).slice(0, 300) : '');
if (!st.conversationId) {
  const tag = Date.now().toString().slice(-5);
  const client = await call('POST', '/api/clients', { firstName: 'Айдана', lastName: 'Тестова', displayName: 'Айдана Тестова ' + tag, phone: '+7 701 000 ' + tag, telegram: '', channel: 'whatsapp', language: 'ru', property: 'LES Боровое', parameters: {} });
  const conv = await call('POST', '/api/conversations', { clientId: client.body.id, title: 'E2E n8n Даян ' + tag, channel: 'whatsapp', stage: 'new_contact' });
  console.log('client', client.status, 'conversation', conv.status, conv.body.mode, conv.body.setupStatus ?? '');
  st = { clientId: client.body.id, conversationId: conv.body.id }; writeFileSync(stateFile, JSON.stringify(st));
}
const show = async () => {
  const t = await call('GET', `/api/conversations/${st.conversationId}/timeline`);
  return t.body;
};
const texts = process.argv.slice(2);
for (const text of texts) {
  const before = (await show()).messages?.length ?? 0;
  const sent = await call('POST', `/api/conversations/${st.conversationId}/messages`, { externalMessageId: randomUUID(), text });
  console.log(`\n>>> ГОСТЬ: ${text}\n    enqueue ${sent.status}`, sent.status >= 300 ? JSON.stringify(sent.body).slice(0, 300) : '');
  const t0 = Date.now(); let tl;
  while (Date.now() - t0 < 150000) {
    await new Promise(r => setTimeout(r, 3000));
    tl = await show();
    const runs = tl.runs ?? []; const last = runs.at(-1);
    const out = (tl.messages ?? []).filter(m => m.direction === 'outbound');
    if (last && ['completed', 'failed', 'human_owned', 'completion_unknown'].includes(last.status)) break;
  }
  const runs = tl.runs ?? []; const last = runs.at(-1);
  const msgs = (tl.messages ?? []).slice(-3);
  console.log('    run status:', last?.status, '| executionId', last?.executionId, '| deliveries:', msgs.map(m => `${m.direction ?? m.senderType}:${m.deliveryStatus ?? ''}`).join(' '));
  const reply = [...(tl.messages ?? [])].reverse().find(m => m.direction === 'outbound'); console.log('    tools:', (last?.tools ?? []).map(t => t.name + ':' + t.status).reverse().join(', '));
  console.log('<<< АЙДАНА:', reply?.text ?? '(нет ответа)');
}
const tl = await show();
console.log('\ntimeline keys:', Object.keys(tl).join(','), '| runs:', (tl.runs ?? []).map(r => r.status).join(','));

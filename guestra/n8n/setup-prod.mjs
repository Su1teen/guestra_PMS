// Prepares the live (prod) chain for the Aidana agent. Secrets are read/generated locally and never printed.
// Run with GUESTRA_TARGET=prod GUESTRA_N8N_DIR=<private work dir containing n8n.env>.
// Usage: node setup-prod.mjs [--crm-principal] [--n8n] [--studio]
import { api, env, dirPath } from './lib.mjs';
import { T, TARGET } from './target.mjs';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
if (TARGET !== 'prod') throw new Error('GUESTRA_TARGET=prod required');
const args = new Set(process.argv.slice(2));
const RAILWAY_CWD = process.env.RAILWAY_CWD ?? process.cwd();
const rw = (a, input) => spawnSync('railway', a, { input, cwd: RAILWAY_CWD, shell: true, encoding: 'utf8' });
const getVars = svc => JSON.parse(rw(['variables', '-s', svc, '-e', 'production', '--json']).stdout);
const setVar = (svc, key, value) => { const r = rw(['variable', 'set', key, '--stdin', '--skip-deploys', '-s', svc, '-e', 'production'], value); console.log(svc, key, r.status === 0 ? 'set' : 'FAILED'); if (r.status !== 0) process.exit(1); };
const secretsFile = dirPath + 'prod-secrets.json';
const secrets = existsSync(secretsFile) ? JSON.parse(readFileSync(secretsFile, 'utf8')) : { crmKey: 'n8n_prod_' + randomBytes(32).toString('hex') };
writeFileSync(secretsFile, JSON.stringify(secrets));
const idsFile = dirPath + 'ids.json';
const ids = existsSync(idsFile) ? JSON.parse(readFileSync(idsFile, 'utf8')) : { webhookPath: 'guestra-studio-aidana-' + randomBytes(9).toString('hex'), capabilitiesPath: 'guestra-studio-capabilities-' + randomBytes(9).toString('hex') };
writeFileSync(idsFile, JSON.stringify(ids, null, 1));
const studio = getVars('guestra_ai_studio');

if (args.has('--crm-principal')) {
  const crm = getVars('guestra_crm');
  const principals = JSON.parse(crm.CRM_INTEGRATION_PRINCIPALS);
  if (principals.some(p => p.id === 'n8n-service')) console.log('n8n principal already registered');
  else {
    // Same scope/tool set as the verified sandbox principal; only environment, property and hash differ.
    const scopes = JSON.parse(readFileSync(dirPath + 'principal-scopes.json', 'utf8'));
    principals.push({ id: 'n8n-service', keyHash: createHash('sha256').update(secrets.crmKey).digest('hex'), environment: 'production',
      propertyIds: [T.prop.crmPropertyId], workspaceIds: [T.workspaceId], scopes });
    setVar('guestra_crm', 'CRM_INTEGRATION_PRINCIPALS', JSON.stringify(principals));
  }
}
if (args.has('--n8n')) {
  const existing = (await api('GET', '/credentials', null, { limit: 100 })).body.data;
  const stateFile = dirPath + 'created.json';
  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};
  const llm = existing.find(c => c.name === 'GUESTRA-STUDIO');
  if (!llm) throw new Error('OpenAI credential GUESTRA-STUDIO not found');
  state.llmCred = llm.id; state.llmCredName = 'GUESTRA-STUDIO'; state.llmModel = 'gpt-4.1';
  const cred = async (key, name, data) => { const f = existing.find(c => c.name === name); if (f) { state[key] = f.id; return console.log('credential exists', name); }
    const r = await api('POST', '/credentials', { name, type: 'httpHeaderAuth', data }); console.log('credential', name, r.status); if (r.status === 200) state[key] = r.body.id; };
  await cred('crmCred', T.cred.crm, { name: 'x-crm-api-key', value: secrets.crmKey });
  await cred('studioBearerCred', T.cred.bearer, { name: 'Authorization', value: 'Bearer ' + studio.N8N_TOKEN });
  const tables = (await api('GET', '/data-tables', null, { limit: 100 })).body.data ?? [];
  let table = tables.find(t => t.name === T.tables.secrets);
  if (!table) table = (await api('POST', '/data-tables', { name: T.tables.secrets, columns: [{ name: 'key', type: 'string' }, { name: 'value', type: 'string' }] })).body;
  state.secretsTableId = table.id;
  const rows = (await api('GET', `/data-tables/${table.id}/rows`, null, { limit: 50 })).body?.data ?? [];
  if (!rows.some(x => x.key === 'studio_callback_secret')) console.log('secret row', (await api('POST', `/data-tables/${table.id}/rows`, { data: [{ key: 'studio_callback_secret', value: studio.N8N_CALLBACK_SECRET }], returnType: 'count' })).status);
  writeFileSync(stateFile, JSON.stringify(state, null, 1));
  console.log('state keys', Object.keys(state).join(','));
}
if (args.has('--studio')) {
  const n8nHost = new URL(env.N8N_URL).host;
  setVar('guestra_ai_studio', 'N8N_WEBHOOK_URL', `https://${n8nHost}/webhook/${ids.webhookPath}`);
  setVar('guestra_ai_studio', 'N8N_CAPABILITIES_URL', `https://${n8nHost}/webhook/${ids.capabilitiesPath}`);
  setVar('guestra_ai_studio', 'STUDIO_LIVE_ORCHESTRATION', 'true');
}

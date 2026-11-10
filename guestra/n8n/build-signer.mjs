import { api, dirPath } from './lib.mjs';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { T } from './target.mjs';
const created = JSON.parse(readFileSync(dirPath + 'created.json', 'utf8'));
const STUDIO = T.studioUrl;
export const NAMES = { signer: T.signer };

const buildBody = `
// Deterministic event id: retries of the same logical event reuse it (Studio treats event ids as immutable).
const inp = $input.first().json;
function hash128(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57, h3 = 0x9e3779b9, h4 = 0x85ebca6b;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ k, 2654435761); h2 = Math.imul(h2 ^ k, 1597334677); h3 = Math.imul(h3 ^ k, 2246822519); h4 = Math.imul(h4 ^ k, 3266489917);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h3 ^ (h3 >>> 13), 3266489909);
  h3 = Math.imul(h3 ^ (h3 >>> 16), 2246822507) ^ Math.imul(h4 ^ (h4 >>> 13), 3266489909);
  h4 = Math.imul(h4 ^ (h4 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return [h1, h2, h3, h4].map(n => (n >>> 0).toString(16).padStart(8, '0')).join('');
}
const hex = hash128(inp.runId + ':' + inp.state + ':' + inp.sequence);
const eventId = hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-4' + hex.slice(13, 16) + '-a' + hex.slice(17, 20) + '-' + hex.slice(20, 32);
const body = { eventId, workspaceId: inp.workspaceId, runId: inp.runId, correlationId: inp.correlationId };
for (const k of ['crmConversationId', 'crmCustomerId']) if (inp[k]) body[k] = inp[k];
body.state = inp.state; body.sequence = Number(inp.sequence); body.executionId = String(inp.executionId);
for (const k of ['workflowVersion', 'deploymentId', 'contextVersion', 'businessOperationId', 'errorCode']) if (inp[k]) body[k] = inp[k];
return [{ json: { rawBody: JSON.stringify(body), timestamp: String(Math.floor(Date.now() / 1000)), eventId } }];`;

const result = `
const j = $input.first().json;
const text = typeof j === 'string' ? j : (typeof j.data === 'string' ? j.data : JSON.stringify(j.data ?? j));
const ok = /"accepted"\s*:\s*true/.test(text);
return [{ json: { ok, eventId: $('Build body').first().json.eventId, studio: String(text).slice(0, 300) } }];`;

export const signerWorkflow = {
  name: NAMES.signer,
  nodes: [
    { id: 's1', name: 'Execute Workflow Trigger', type: 'n8n-nodes-base.executeWorkflowTrigger', typeVersion: 1.1, position: [0, 0], parameters: { inputSource: 'passthrough' } },
    { id: 's2', name: 'Build body', type: 'n8n-nodes-base.code', typeVersion: 2, position: [220, 0], parameters: { jsCode: buildBody } },
    { id: 's3', name: 'Read callback secret', type: 'n8n-nodes-base.dataTable', typeVersion: 1, position: [440, 0], parameters: {
      resource: 'row', operation: 'get', dataTableId: { __rl: true, mode: 'id', value: created.secretsTableId },
      matchType: 'allConditions', filters: { conditions: [{ keyName: 'key', condition: 'eq', keyValue: 'studio_callback_secret' }] }, returnAll: false, limit: 1 } },
    { id: 's4', name: 'Sign', type: 'n8n-nodes-base.crypto', typeVersion: 1, position: [660, 0], parameters: {
      action: 'hmac', type: 'SHA256', value: "={{ $('Build body').item.json.timestamp + '.' + $('Build body').item.json.rawBody }}",
      dataPropertyName: 'signature', secret: '={{ $json.value }}', encoding: 'hex' } },
    { id: 's5', name: 'POST Studio event', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.5, position: [880, 0], retryOnFail: true, maxTries: 3, waitBetweenTries: 1500,
      parameters: { method: 'POST', url: STUDIO + '/api/integrations/n8n/events', sendHeaders: true, headerParameters: { parameters: [
        { name: 'x-studio-timestamp', value: "={{ $('Build body').item.json.timestamp }}" }, { name: 'x-studio-signature', value: '={{ $json.signature }}' }] },
        sendBody: true, contentType: 'raw', rawContentType: 'application/json', body: "={{ $('Build body').item.json.rawBody }}",
        options: { response: { response: { neverError: true, responseFormat: 'text' } }, timeout: 10000 } } },
    { id: 's6', name: 'Result', type: 'n8n-nodes-base.code', typeVersion: 2, position: [1100, 0], parameters: { jsCode: result } },
  ],
  connections: {
    'Execute Workflow Trigger': { main: [[{ node: 'Build body', type: 'main', index: 0 }]] },
    'Build body': { main: [[{ node: 'Read callback secret', type: 'main', index: 0 }]] },
    'Read callback secret': { main: [[{ node: 'Sign', type: 'main', index: 0 }]] },
    Sign: { main: [[{ node: 'POST Studio event', type: 'main', index: 0 }]] },
    'POST Studio event': { main: [[{ node: 'Result', type: 'main', index: 0 }]] },
  },
  // The signer reads a secret: never keep its execution data.
  settings: { executionOrder: 'v1', saveDataSuccessExecution: 'none', saveDataErrorExecution: 'none', saveManualExecutions: false },
};

export async function upsert(wf) {
  const list = (await api('GET', '/workflows', null, { limit: 250 })).body.data;
  const found = list.find(w => w.name === wf.name);
  if (found) {
    const r = await api('PUT', '/workflows/' + found.id, { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings });
    // n8n keeps the previously published version live until it is published again.
    if (r.status === 200 && found.active) await api('POST', '/workflows/' + found.id + '/activate', {});
    return { id: found.id, status: r.status, body: r.body };
  }
  const r = await api('POST', '/workflows', wf);
  return { id: r.body?.id, status: r.status, body: r.body };
}
if (import.meta.url === new URL(process.argv[1], 'file:///').href || process.argv[1]?.endsWith('build-signer.mjs')) {
  const r = await upsert(signerWorkflow);
  console.log('signer workflow', r.status, r.id, r.status !== 200 ? JSON.stringify(r.body).slice(0, 500) : '');
  const state = JSON.parse(readFileSync(dirPath + 'created.json', 'utf8')); state.signerId = r.id; writeFileSync(dirPath + 'created.json', JSON.stringify(state, null, 1));
}

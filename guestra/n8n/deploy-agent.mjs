// Creates/updates workflows C, A and B in n8n (names are unique to this project), then publishes what is publishable.
import { api, dirPath } from './lib.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { T } from './target.mjs';
const save = s => writeFileSync(dirPath + 'created.json', JSON.stringify(s, null, 1));
let state = JSON.parse(readFileSync(dirPath + 'created.json', 'utf8'));
if (!state.runsTableId) {
  const r = await api('POST', '/data-tables', { name: T.tables.runs, columns: ['executionId', 'runId', 'correlationId', 'workspaceId'].map(name => ({ name, type: 'string' })) });
  state.runsTableId = r.body?.id ?? (await api('GET', '/data-tables', null, { limit: 100 })).body.data.find(t => t.name === T.tables.runs)?.id; save(state);
  console.log('runs table', r.status, state.runsTableId);
}
const { upsert } = await import('./build-signer.mjs');
const m = await import('./build-agent.mjs');
const { N, nodesA, connections, nodesB, connectionsB, nodesC, connectionsC, fill, WORKFLOW_VERSION } = m;
const settingsBase = { executionOrder: 'v1', saveDataSuccessExecution: 'all', saveDataErrorExecution: 'all', saveManualExecutions: true, executionTimeout: 300 };

// Fingerprint of the agent definition (placeholders unresolved) = verifiable deployment id.
const fingerprint = createHash('sha256').update(JSON.stringify({ nodesA: nodesA.map(({ id, webhookId, ...n }) => n), connections })).digest('hex').slice(0, 12);
const deploymentId = `${WORKFLOW_VERSION}+${fingerprint}`;

// Rename the previous Dayan-named workflow in place so no orphan remains.
if (T.suffix === 'sandbox') { const list = (await api('GET', '/workflows', null, { limit: 250 })).body.data; const old = list.find(w => w.name === 'GUESTRA-STUDIO · Dayan Agent (sandbox)');
  if (old) { const full = (await api('GET', '/workflows/' + old.id)).body; const r = await api('PUT', '/workflows/' + old.id, { name: N.A, nodes: full.nodes, connections: full.connections, settings: full.settings }); console.log('renamed old A', r.status); } }
// C first (A references it as errorWorkflow). It needs a real id for placeholder substitution of workflow ids only for A/B.
let c = await upsert({ name: N.C, nodes: fill(nodesC, 'n/a', deploymentId), connections: connectionsC, settings: { executionOrder: 'v1' } });
console.log('C', c.status, c.id, c.status !== 200 ? JSON.stringify(c.body).slice(0, 400) : ''); state.errorWorkflowId = c.id; save(state);

// A: create shell to learn its id, then write final definition with that id.
let a = await upsert({ name: N.A, nodes: fill(nodesA, 'PENDING', deploymentId), connections, settings: { ...settingsBase, errorWorkflow: c.id } });
console.log('A (shell)', a.status, a.id, a.status !== 200 ? JSON.stringify(a.body).slice(0, 600) : '');
if (a.status !== 200) process.exit(1);
state.agentWorkflowId = a.id; save(state);
a = await upsert({ name: N.A, nodes: fill(nodesA, a.id, deploymentId), connections, settings: { ...settingsBase, errorWorkflow: c.id } });
console.log('A (final)', a.status, a.id);
const b = await upsert({ name: N.B, nodes: fill(nodesB, a.id, deploymentId), connections: connectionsB, settings: { executionOrder: 'v1' } });
console.log('B', b.status, b.id, b.status !== 200 ? JSON.stringify(b.body).slice(0, 400) : ''); state.capabilitiesWorkflowId = b.id; state.deploymentId = deploymentId; save(state);

for (const [label, id] of [['C', c.id], ['B', b.id], ['A', a.id]]) {
  const p = await api('POST', `/workflows/${id}/activate`, {});
  console.log('publish', label, p.status, p.status !== 200 ? JSON.stringify(p.body).slice(0, 400) : 'active=' + p.body?.active);
}
console.log(JSON.stringify({ A: a.id, B: b.id, C: c.id, signer: state.signerId, gateway: state.gatewayId, deploymentId }));

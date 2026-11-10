// Exports the Guestra workflows (definition only: node credentials appear as references, never as values).
import { api, dirPath } from './lib.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
const ids = JSON.parse(readFileSync(dirPath + 'created.json', 'utf8'));
const want = { 'A-aidana-agent': ids.agentWorkflowId, 'B-capabilities': ids.capabilitiesWorkflowId, 'C-error-recovery': ids.errorWorkflowId, 'signer': ids.signerId, 'crm-tool-gateway': ids.gatewayId };
for (const [name, id] of Object.entries(want)) {
  const w = (await api('GET', '/workflows/' + id)).body;
  const clean = { id: w.id, name: w.name, active: w.active, nodes: w.nodes, connections: w.connections, settings: w.settings };
  writeFileSync(dirPath + 'workflows/' + name + '.json', JSON.stringify(clean, null, 1));
  console.log(name, id, w.nodes.length + ' nodes');
}

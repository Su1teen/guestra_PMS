// Deploys and publishes the signed-callback sub-workflow for the current target, recording its id in created.json.
import { signerWorkflow, upsert } from './build-signer.mjs';
import { api, dirPath } from './lib.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
const r = await upsert(signerWorkflow);
console.log('signer', r.status, r.id, r.status !== 200 ? JSON.stringify(r.body).slice(0, 400) : '');
if (r.status !== 200) process.exit(1);
const p = await api('POST', `/workflows/${r.id}/activate`, {}); console.log('publish', p.status);
const state = JSON.parse(readFileSync(dirPath + 'created.json', 'utf8')); state.signerId = r.id; writeFileSync(dirPath + 'created.json', JSON.stringify(state, null, 1));

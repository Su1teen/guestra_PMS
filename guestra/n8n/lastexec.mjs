import { api } from './lib.mjs';
const wf = process.argv[2];
const r = await api('GET', '/executions', null, { workflowId: wf, limit: 3, includeData: 'false' });
for (const e of r.body.data ?? []) console.log(e.id, e.status, e.startedAt, e.mode);
const id = (r.body.data ?? [])[0]?.id; if (!id) process.exit(0);
const d = (await api('GET', '/executions/' + id, null, { includeData: 'true' })).body.data.resultData;
console.log('lastNode', d.lastNodeExecuted, '| error', JSON.stringify(d.error ?? null).slice(0, 400));
for (const [n, runs] of Object.entries(d.runData)) console.log(' -', n, runs[0].executionStatus, JSON.stringify(runs[0].data?.main?.[0]?.[0]?.json ?? runs[0].error ?? '').slice(0, 220));

import { api } from './lib.mjs';
const r = await api('GET', '/executions/' + process.argv[2], null, { includeData: 'true' });
const rd = r.body.data.resultData.runData;
const out = rd['Aidana Agent']?.[0]?.data?.main?.[0]?.[0]?.json;
for (const s of out?.intermediateSteps ?? []) console.log(s.action.tool, JSON.stringify(s.action.toolInput).slice(0, 500), '\n  =>', String(typeof s.observation === 'string' ? s.observation : JSON.stringify(s.observation)).slice(0, 700));

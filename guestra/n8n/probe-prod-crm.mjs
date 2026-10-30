// Read-only check that the prod n8n principal is accepted by the live CRM (capabilities only; creates nothing).
import { readFileSync } from 'node:fs';
import { dirPath } from './lib.mjs';
import { T } from './target.mjs';
const key = JSON.parse(readFileSync(dirPath + 'prod-secrets.json', 'utf8')).crmKey;
const url = new URL(T.crmUrl + '/v2/capabilities'); url.searchParams.set('propertyId', T.prop.crmPropertyId);
const r = await fetch(url, { headers: { 'x-crm-api-key': key } });
const t = await r.text(); console.log(r.status, t.slice(0, 700));

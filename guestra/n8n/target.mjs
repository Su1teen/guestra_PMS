// Deployment target. `sandbox` (default) is the isolated lab; `prod` is the live LES Боровое chain.
// Everything that differs between them lives here so workflows, credentials and tables never share names.
const TARGETS = {
  sandbox: {
    suffix: 'sandbox', environment: 'sandbox', workspaceId: 'les-sandbox',
    studioUrl: 'https://sandbox-studio-sandbox.up.railway.app',
    crmUrl: 'https://sandbox-crm-sandbox.up.railway.app/api/integrations/agent',
    prop: { crmPropertyId: 'sandbox_les', crmTenantId: 'org_les_live', pmsPropertyId: 'b4d34b21-e0fb-47b4-9b53-72f4e2ba7d2a', pmsTenantId: 'b4d34b21-e0fb-47b4-9b53-72f4e2ba7d2a' },
    cred: { crm: 'GUESTRA-STUDIO · CRM sandbox principal', bearer: 'GUESTRA-STUDIO · Studio sandbox bearer' },
    tables: { secrets: 'guestra_studio_secrets', runs: 'guestra_studio_runs' },
    signer: 'GUESTRA-STUDIO · Signed callback (sub-workflow)', gateway: 'GUESTRA-STUDIO · CRM tool gateway (sub-workflow)',
  },
  prod: {
    suffix: 'prod', environment: 'production', workspaceId: 'les-sandbox',
    studioUrl: 'https://aistudio.guestra.org',
    crmUrl: 'https://crm.guestra.org/api/integrations/agent',
    prop: { crmPropertyId: 'les_borovoe', crmTenantId: 'org_les_live', pmsPropertyId: 'a0000001-0000-4000-a000-000000000001', pmsTenantId: 'a0000001-0000-4000-a000-000000000001' },
    cred: { crm: 'GUESTRA-STUDIO · CRM prod principal', bearer: 'GUESTRA-STUDIO · Studio prod bearer' },
    tables: { secrets: 'guestra_studio_prod_secrets', runs: 'guestra_studio_prod_runs' },
    signer: 'GUESTRA-STUDIO · Signed callback (prod, sub-workflow)', gateway: 'GUESTRA-STUDIO · CRM tool gateway (prod, sub-workflow)',
  },
};
export const TARGET = process.env.GUESTRA_TARGET ?? 'sandbox';
if (!TARGETS[TARGET]) throw new Error('GUESTRA_TARGET must be sandbox or prod');
export const T = TARGETS[TARGET];

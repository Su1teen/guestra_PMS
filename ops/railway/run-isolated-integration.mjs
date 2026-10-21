import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { mkdir as mkdirAsync } from 'node:fs/promises';

for (const key of ['DATABASE_URL','CRM_TEST_DATABASE_URL']) {
  if (!process.env[key]) throw new Error(key + ' is required');
  const url=new URL(process.env[key]);
  if(!['127.0.0.1','localhost'].includes(url.hostname)||!url.pathname.endsWith('_integration_test'))
    throw new Error('Only explicit loopback integration_test databases are allowed');
}
if(process.env.DATABASE_URL===process.env.CRM_TEST_DATABASE_URL)throw new Error('Separate PMS and CRM databases required');
for(const key of ['CRM_TEST_ROOT','STUDIO_TEST_ROOT'])if(!process.env[key]||!existsSync(resolve(process.env[key],'package.json')))throw new Error(key+' must identify the matching checked-out repository');
const directory=resolve('.tmp/isolated-orchestrator-tls');await mkdirAsync(directory,{recursive:true,mode:0o700});
const cert=resolve(directory,'certificate.pem'),key=resolve(directory,'private-key.pem');
const openssl=process.env.OPENSSL_BINARY??(process.platform==='win32'?'C:/Program Files/Git/usr/bin/openssl.exe':'openssl');
function run(command,args,env=process.env,cwd=process.cwd()) {
  const result=spawnSync(command,args,{env,cwd,stdio:'inherit',windowsHide:true});
  if(result.error||result.status!==0)throw new Error('Isolated integration command failed');
}
run(openssl,['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1']);
const env={...process.env,INTEGRATION_ENVIRONMENT:'test',PMS_LIVE_PG:'1',GUESTRA_CROSS_REPO:'1',
  NODE_EXTRA_CA_CERTS:cert,INTEGRATION_TEST_TLS_KEY:key,INTEGRATION_TEST_TLS_CERT:cert};
run(process.execPath,['packages/database/dist/run-migrations.js'],env);
run(process.execPath,['scripts/setup-integration-test.mjs'],env);
const require=createRequire(new URL('../../apps/api/package.json',import.meta.url));
const vitest=resolve(dirname(require.resolve('vitest/package.json')),'vitest.mjs');
run(process.execPath,[vitest,'run','src/modules/connect/connect-v2.postgres.spec.ts','--maxWorkers=1','--minWorkers=1'],env,resolve('apps/api'));
console.log('Isolated supported-HTTP orchestrator harness passed. This is not a real n8n E2E.');

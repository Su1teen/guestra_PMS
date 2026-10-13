import {describe,it,expect,vi,afterEach} from 'vitest';
import {ConfigService} from '@nestjs/config';
import {ConnectInboxService} from './connect-inbox.service';
const propertyId='10000000-0000-4000-8000-000000000001';
function fixture(grants=['communications.manage']) {
 const queue:any[][]=[[{id:propertyId,organizationId:'tenant-pms'}],[{localEntityId:'guest-pms'}]];
 const builder:any={from:()=>builder,where:()=>builder,limit:async()=>queue.shift()??[],then:(resolve:(value:any[])=>unknown)=>Promise.resolve(queue.shift()??[]).then(resolve)};
 const db={select:vi.fn(()=>builder)};
 const permissions={findLocalUser:vi.fn(async()=>({id:'local-staff'})),getEffectivePermissions:vi.fn(async()=>grants)};
 const operational={snapshot:vi.fn(async()=>({balance:'999.00'}))};
 const config=new ConfigService({GUESTRA_INBOX_ENABLED:'true',INTEGRATION_ENVIRONMENT:'test',CRM_AGENT_URL:'https://crm.test/agent',CRM_AGENT_KEY:'secret',
  CRM_PROPERTY_MAPPINGS:JSON.stringify([{pmsPropertyId:propertyId,pmsTenantId:'tenant-pms',crmPropertyId:'crm-property',crmTenantId:'tenant-crm',environment:'test'}])});
 return {service:new ConnectInboxService(db,config,permissions as any,operational as any),db,permissions,operational};
}
const user={sub:'signed-user',email:'staff@test.invalid',role:'staff'} as any;
afterEach(()=>vi.unstubAllGlobals());
describe('PMS Inbox boundary',()=>{
 it('denies anonymous and unauthorized staff before spending the CRM credential',async()=>{
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
  await expect(fixture().service.list(propertyId,undefined)).rejects.toThrow('AUTHENTICATED_STAFF_REQUIRED');
  await expect(fixture([]).service.list(propertyId,user)).rejects.toThrow('INBOX_SCOPE_DENIED');
  expect(fetch).not.toHaveBeenCalled();
 });
 it('omits ledger and operations without their separate permissions',async()=>{
  const {service,db,operational}=fixture();
  const fetch=vi.fn(async(url:URL)=>Response.json(url.pathname.endsWith('capabilities')?{
   contractVersion:'guestra-crm-integration-v2',environment:'test',propertyId:'crm-property',tenantId:'tenant-crm',pmsPropertyId:propertyId,pmsTenantId:'tenant-pms'
  }:{id:'conversation',customerId:'crm-customer',propertyId:'crm-property',messages:[{text:'Guest message'}]}));
  vi.stubGlobal('fetch',fetch);
  const result=await service.detail(propertyId,'conversation',user);
  expect(result.operationalContext).toEqual({verifiedGuest:true,guestId:'guest-pms'});
  expect(operational.snapshot).not.toHaveBeenCalled();expect(db.select).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(result)).not.toContain('999');
 });
 it('fails closed when the remote property or environment attestation changes',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>Response.json({contractVersion:'guestra-crm-integration-v2',environment:'production'})));
  await expect(fixture().service.list(propertyId,user)).rejects.toThrow('CRM_ATTESTATION_FAILED');
 });
 it('reports a temporary CRM outage without inventing cached guest messages',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>{throw new Error('offline');}));
  await expect(fixture().service.list(propertyId,user)).rejects.toThrow('CRM_UNAVAILABLE');
 });
});

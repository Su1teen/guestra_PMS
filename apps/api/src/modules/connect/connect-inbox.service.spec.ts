import {describe,it,expect,vi,afterEach} from 'vitest';
import {ConfigService} from '@nestjs/config';
import {ConnectInboxService} from './connect-inbox.service';
import {CrmInboxClient} from '../guest-inbox/crm-inbox.client';
const propertyId='10000000-0000-4000-8000-000000000001';
const capabilities={contractVersion:'guestra-crm-integration-v2',environment:'test',propertyId:'crm-property',tenantId:'tenant-crm',pmsPropertyId:propertyId,pmsTenantId:'tenant-pms'};
function fixture(grants=['communications.manage'],extra:Record<string,string>={},rows:any[][]=[]) {
 const queue:any[][]=rows.length?rows:[[{id:propertyId,organizationId:'tenant-pms'}],[{localEntityId:'guest-pms'}]];
 const builder:any={from:()=>builder,where:()=>builder,innerJoin:()=>builder,limit:async()=>queue.shift()??[],then:(resolve:(value:any[])=>unknown)=>Promise.resolve(queue.shift()??[]).then(resolve)};
 const db={select:vi.fn(()=>builder)};
 const permissions={findLocalUser:vi.fn(async()=>({id:'local-staff',name:'Дана'})),getEffectivePermissions:vi.fn(async()=>grants)};
 const operational={snapshot:vi.fn(async()=>({balance:'999.00'}))};
 const email={send:vi.fn(async()=>({sent:true,status:'sent'}))};
 const notifications={sendSms:vi.fn(async()=>({sent:false}))};
 const config=new ConfigService({GUESTRA_INBOX_ENABLED:'true',INTEGRATION_ENVIRONMENT:'test',CRM_AGENT_URL:'https://crm.test/agent',CRM_AGENT_KEY:'secret',
  CRM_PROPERTY_MAPPINGS:JSON.stringify([{pmsPropertyId:propertyId,pmsTenantId:'tenant-pms',crmPropertyId:'crm-property',crmTenantId:'tenant-crm',environment:'test'}]),...extra});
 const crm=new CrmInboxClient(db,config);
 return {service:new ConnectInboxService(db,config,permissions as any,operational as any,crm,email as any,notifications as any),db,permissions,operational,email};
}
/** CRM stand-in: capabilities attestation plus a scripted answer per path; records every call. */
function crmStub(answer:(path:string,init:RequestInit)=>unknown) {
 const calls:Array<{path:string;method:string;body:any;search:string}>=[];
 vi.stubGlobal('fetch',vi.fn(async(url:URL,init:RequestInit)=>{
  calls.push({path:url.pathname,method:init?.method??'GET',body:init?.body?JSON.parse(String(init.body)):null,search:url.search});
  return Response.json(url.pathname.endsWith('capabilities')?capabilities:answer(url.pathname,init));
 }));
 return calls;
}
const user={sub:'signed-user',email:'staff@test.invalid',role:'staff'} as any;
afterEach(()=>vi.unstubAllGlobals());
describe('PMS Inbox boundary',()=>{
 it('denies anonymous and unauthorized staff before spending the CRM credential',async()=>{
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
  await expect(fixture().service.list(propertyId,undefined)).rejects.toThrow('AUTHENTICATED_STAFF_REQUIRED');
  await expect(fixture([]).service.list(propertyId,user)).rejects.toThrow('INBOX_SCOPE_DENIED');
  // The sandbox staff identity needs the explicit opt-in, auth switched off and a non-production environment.
  await expect(fixture(['communications.manage'],{GUESTRA_INBOX_SANDBOX_STAFF:'true',AUTH_ENABLED:'false',INTEGRATION_ENVIRONMENT:'production'})
   .service.list(propertyId,undefined)).rejects.toThrow('AUTHENTICATED_STAFF_REQUIRED');
  expect(fetch).not.toHaveBeenCalled();
 });
 it('lets an opted-in sandbox act as shared sandbox staff',async()=>{
  const calls=crmStub(()=>({conversations:[]}));
  const {service}=fixture(['communications.manage'],{GUESTRA_INBOX_SANDBOX_STAFF:'true',AUTH_ENABLED:'false'});
  await service.list(propertyId,undefined,{queue:'focus',channel:'email',search:'Иванов'});
  const list=calls.find(c=>c.path.endsWith('/v2/inbox'))!;
  expect(list.search).toContain('queue=focus');expect(list.search).toContain('channel=email');expect(list.search).toContain('propertyId=crm-property');
 });
 it('omits ledger and operations without their separate permissions',async()=>{
  const {service,db,operational}=fixture();
  crmStub(()=>({id:'conversation',customerId:'crm-customer',propertyId:'crm-property',messages:[{text:'Guest message'}]}));
  const result=await service.detail(propertyId,'conversation',user);
  expect(result.operationalContext).toEqual({verifiedGuest:true,guestId:'guest-pms'});
  expect(operational.snapshot).not.toHaveBeenCalled();expect(db.select).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(result)).not.toContain('999');
 });
 it('delivers an email reply through PMS first and records the outcome in the CRM chat',async()=>{
  const {service,email}=fixture();
  const calls=crmStub((path)=>path.endsWith('/messages')?{message:{id:'m1'},delivered:true}:{id:'c1',channel:'email',email:'guest@example.test',propertyId:'crm-property'});
  await service.reply(propertyId,'c1',{text:'Добрый день!',idempotencyKey:'reply-key-1'},user);
  expect(email.send).toHaveBeenCalledWith(expect.objectContaining({to:'guest@example.test',text:'Добрый день!'}));
  const post=calls.find(c=>c.path.endsWith('/v2/inbox/c1/messages'))!;
  expect(post.body).toMatchObject({propertyId:'crm-property',text:'Добрый день!',asNote:false,staffReference:'pms:local-staff',staffName:'Дана',
   delivery:{sent:true}});
 });
 it('starts a chat only for a guest with a stay at this property',async()=>{
  const {service}=fixture(['communications.manage'],{},[[]]);
  const calls=crmStub(()=>({}));
  await expect(service.start(propertyId,{guestId:'20000000-0000-4000-8000-000000000002',channel:'simulator',text:'Здравствуйте'},user))
   .rejects.toThrow('Guest has no reservation at this property');
  expect(calls).toHaveLength(0);
 });
 it('fails closed when the remote property or environment attestation changes',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>Response.json({contractVersion:'guestra-crm-integration-v2',environment:'production'})));
  await expect(fixture().service.list(propertyId,user)).rejects.toThrow('CRM_ATTESTATION_FAILED');
 });
 it('reports a temporary CRM outage without inventing cached guest messages',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>{throw new Error('offline');}));
  await expect(fixture().service.list(propertyId,user)).rejects.toThrow('CRM_UNAVAILABLE');
 });
 it('passes actionable CRM refusals to staff',async()=>{
  vi.stubGlobal('fetch',vi.fn(async(url:URL)=>url.pathname.endsWith('capabilities')?Response.json(capabilities)
   :Response.json({code:'CONVERSATION_NOT_HUMAN_OWNED'},{status:409})));
  await expect(fixture().service.reply(propertyId,'c1',{text:'x',asNote:true},user)).rejects.toThrow('CONVERSATION_NOT_HUMAN_OWNED');
 });
});

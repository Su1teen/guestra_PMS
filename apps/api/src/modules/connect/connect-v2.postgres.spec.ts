import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { randomUUID,createHash,createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'node:https';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { ConfigService } from '@nestjs/config';
import {Test} from '@nestjs/testing';
import {ValidationPipe} from '@nestjs/common';
import request from 'supertest';
import { properties, roomTypes, rooms, ratePlans, taxProfiles, taxRules, reservations, reservationGuests,
  bookings, guests, guestPropertyLinks, integrationLinks, domainEventOutbox, auditLogs, charges, folios, payments,
  services,serviceResources,serviceBookings,serviceResourceAllocations,serviceRequests,serviceOperations,connectCredentials } from '@telivityhaip/database';
import { ConnectBookingService } from './connect-booking.service';
import { ConnectV2Service } from './connect-v2.service';
import { connectOperations,integrationDeployment,sandboxProperties,sandboxFixtures } from './connect-operation-schema';
import {ConnectSandboxService,fixtureStages} from './connect-sandbox.service';
import { AvailabilityService } from '../reservation/availability.service';
import { ReservationService } from '../reservation/reservation.service';
import { RoomStatusService } from '../room/room-status.service';
import { RatePlanService } from '../rate-plan/rate-plan.service';
import { TaxService } from '../tax/tax.service';
import { PolicyService } from '../policy/policy.service';
import { FolioService } from '../folio/folio.service';
import { DepositSettlementService } from '../accounting/deposit-settlement.service';
import { DomainEventOutboxService } from '../webhook/domain-event-outbox.service';
import {ConnectServiceBookingService} from './connect-service-booking.service';
import {ServiceRequestsService} from '../service-requests/service-requests.service';
import {ConnectV2Controller} from './connect-v2.controller';
import {ConnectV2Guard} from './connect-v2.guard';
import {ApiKeyGuard} from '../auth/api-key.guard';
import {ConnectScopeGuard} from '../auth/connect-scope.guard';
import {DRIZZLE} from '../../database/database.module';

describe.runIf(process.env.PMS_LIVE_PG === '1')('Connect v2 on isolated PostgreSQL', () => {
  const url = process.env.DATABASE_URL ?? 'postgresql://integration_test@127.0.0.1:55432/guestra_pms_integration_test';
  const parsed = new URL(url);
  if (process.env.PMS_LIVE_PG==='1' && (!['localhost','127.0.0.1'].includes(parsed.hostname) || !parsed.pathname.endsWith('_integration_test')))
    throw new Error('This suite requires a loopback isolated integration_test database');
  const client = postgres(url, {max: 8}), db = drizzle(client);
  const ids = {property: randomUUID(), type: randomUUID(), rate: randomUUID(), tax: randomUUID(),service:randomUUID()};
  const delivery = {emit: vi.fn(), dispatchPersisted: vi.fn()};
  const taxes = new TaxService(db), rates = new RatePlanService(db), policy = new PolicyService(db);
  const folio = new FolioService(db, delivery as any, taxes);
  const outbox = new DomainEventOutboxService(db, delivery as any);
  const availability = new AvailabilityService(db);
  const roomStatus = new RoomStatusService(db, delivery as any, outbox);
  const settlement = new DepositSettlementService(db, {} as any, folio, outbox);
  // The methods under test use genuine inventory, room and accepted-price domain services.
  const reservation = Object.assign(Object.create(ReservationService.prototype), {
    db, availabilityService: availability, roomStatusService: roomStatus,
  }) as ReservationService;
  const booking = new ConnectBookingService(db, availability, reservation, delivery as any, rates, policy, taxes, outbox);
  const config = new ConfigService({INTEGRATION_ENVIRONMENT:'test', CONNECT_QUOTE_SIGNING_SECRET:'isolated-test-signing-secret-32-characters'});
  const service = new ConnectServiceBookingService(db,folio,taxes,outbox);
  const requests = new ServiceRequestsService(db,{} as any,delivery as any,{} as any,outbox);
  const v2 = new ConnectV2Service(db, config, rates, taxes, booking, reservation, availability, folio, policy, settlement, service, requests, {} as any);
  const sandbox=new ConnectSandboxService(db,config,v2);
  const input = {propertyId: ids.property, roomTypeId: ids.type, ratePlanId: ids.rate,
    checkIn:'2027-03-01', checkOut:'2027-03-03', adults:1, children:0, customerId:'crm-customer-A'};
  async function purchase(extra = {}) {
    const quote = await v2.quote(input);
    return v2.book({...input, guestFirstName:'Virtual', guestPhone:'+77000000000', idempotencyKey:randomUUID(),
      acceptedQuote:quote.acceptedQuote, integrationContext:{sourceSystem:'guestra_crm',customerId:input.customerId}, ...extra});
  }
  async function clear() {
    const links = await db.select().from(guestPropertyLinks).where(eq(guestPropertyLinks.propertyId,ids.property));
    for(const table of [sandboxFixtures,connectOperations,serviceOperations,serviceResourceAllocations,serviceBookings,serviceRequests,charges,folios,reservationGuests,reservations,bookings,integrationLinks,
      guestPropertyLinks,domainEventOutbox,auditLogs]) await db.delete(table as any).where(eq((table as any).propertyId,ids.property));
    for(const link of links)await db.delete(guests).where(eq(guests.id,link.guestId));
  }
  beforeAll(async () => {
    const migration=await readFile(resolve(process.cwd(),'../../integration-migrations/0001_domain_event_capture_v2.sql'),'utf8');
    await client.unsafe(migration); await client.unsafe(migration);
    await db.insert(integrationDeployment).values({id:true,environment:'test',deploymentId:randomUUID()}).onConflictDoNothing();
    await db.insert(properties).values({id:ids.property,name:'Isolated Connect test',code:'V2-'+ids.property.slice(0,8),countryCode:'KZ',timezone:'Asia/Almaty',currencyCode:'KZT',totalRooms:2});
    await db.insert(roomTypes).values({id:ids.type,propertyId:ids.property,name:'Standard',code:'STD',maxOccupancy:2,defaultOccupancy:1});
    await db.insert(rooms).values(['101','102'].map(number=>({propertyId:ids.property,roomTypeId:ids.type,number,status:'vacant_clean' as const})));
    await db.insert(ratePlans).values({id:ids.rate,propertyId:ids.property,roomTypeId:ids.type,name:'Canonical',code:'BAR',type:'bar',baseAmount:'100.00',currencyCode:'KZT',isTaxInclusive:false});
    await db.insert(taxProfiles).values({id:ids.tax,propertyId:ids.property,name:'Test',jurisdictionCode:'TEST',effectiveFrom:'2026-01-01'});
    await db.insert(taxRules).values({taxProfileId:ids.tax,name:'10 percent',code:'TAX',type:'percentage',rate:'10.00',appliesToChargeTypes:['room'],effectiveFrom:'2026-01-01'});
    await db.insert(services).values({id:ids.service,propertyId:ids.property,name:'Fixture massage',code:'MASSAGE',chargeType:'spa',price:'50.00',
      currencyCode:'KZT',agentBookingMode:'live_booking',durationMinutes:60,taxMode:'none'});
    await db.insert(serviceResources).values({propertyId:ids.property,serviceId:ids.service,code:'R1',name:'Fixture room',capacity:1});
    await db.insert(sandboxProperties).values({propertyId:ids.property,tenantId:ids.property,roomTypeId:ids.type,ratePlanId:ids.rate,serviceId:ids.service});
  });
  beforeEach(async()=>{await clear();vi.restoreAllMocks();await db.update(ratePlans).set({baseAmount:'100.00'}).where(eq(ratePlans.id,ids.rate));});
  afterAll(async()=>{
    await db.delete(sandboxProperties).where(eq(sandboxProperties.propertyId,ids.property));
    await clear(); await db.delete(taxRules).where(eq(taxRules.taxProfileId,ids.tax));
    await db.delete(taxProfiles).where(eq(taxProfiles.id,ids.tax));
    await db.delete(serviceResources).where(eq(serviceResources.propertyId,ids.property));
    await db.delete(services).where(eq(services.propertyId,ids.property));
    await db.delete(rooms).where(eq(rooms.propertyId,ids.property));
    await db.delete(ratePlans).where(eq(ratePlans.propertyId,ids.property));
    await db.delete(roomTypes).where(eq(roomTypes.propertyId,ids.property));
    await client`delete from integration_event_heads where property_id=${ids.property}`;
    await db.delete(properties).where(eq(properties.id,ids.property)); await client.end();
  });
  it('creates one verified first guest and one reservation for simultaneous retries',async()=>{
    const quote=await v2.quote(input),key=randomUUID();
    const dto={...input,guestFirstName:'First',idempotencyKey:key,acceptedQuote:quote.acceptedQuote,
      integrationContext:{sourceSystem:'guestra_crm',customerId:input.customerId}};
    const results=await Promise.all([v2.book(dto),v2.book(dto)]);
    expect(results[0].reservationId).toBe(results[1].reservationId);
    expect(results[0].guestId).toBe(results[1].guestId);
    for(const result of results) {
      expect(JSON.stringify(result)).not.toContain('acceptedQuoteHash');
      expect(JSON.stringify(result)).not.toContain('idempotencyFingerprint');
      expect(result).not.toHaveProperty('roomNumber');
    }
    expect(await db.select().from(reservations).where(eq(reservations.propertyId,ids.property))).toHaveLength(1);
    expect(await db.select().from(guestPropertyLinks).where(eq(guestPropertyLinks.propertyId,ids.property))).toHaveLength(1);
    const read=await v2.snapshot(ids.property,'reservation',results[0].reservationId,input.customerId);
    expect(read.totalAmount).toBe('220.00'); expect(read.revision).toBeGreaterThan(0);
    expect(JSON.stringify(read)).not.toContain('acceptedQuoteHash');
    const events=await v2.events(ids.property,0,100);
    expect(events.events.some((event:any)=>event.entityId===read.id)).toBe(true);
  });
  it('keeps returning identity and does not merge another external customer with the same phone',async()=>{
    const first=await purchase(),second=await purchase({checkIn:'2027-04-01',checkOut:'2027-04-03',
      acceptedQuote:(await v2.quote({...input,checkIn:'2027-04-01',checkOut:'2027-04-03'})).acceptedQuote});
    expect(second.guestId).toBe(first.guestId);
    const otherInput={...input,customerId:'crm-customer-B'};
    const other=await purchase({integrationContext:{sourceSystem:'guestra_crm',customerId:otherInput.customerId},
      acceptedQuote:(await v2.quote(otherInput)).acceptedQuote});
    expect(other.guestId).not.toBe(first.guestId);
    await expect(v2.snapshot(ids.property,'reservation',first.reservationId,otherInput.customerId)).rejects.toThrow('RESERVATION_NOT_FOUND');
  });
  it('rejects repricing and changed replay input without any extra reservation',async()=>{
    const quote=await v2.quote(input);
    await db.update(ratePlans).set({baseAmount:'150.00'}).where(eq(ratePlans.id,ids.rate));
    await expect(purchase({acceptedQuote:quote.acceptedQuote})).rejects.toThrow('PRICE_CHANGED');
    expect(await db.select().from(reservations).where(eq(reservations.propertyId,ids.property))).toHaveLength(0);
    const key=randomUUID(),first=await purchase({idempotencyKey:key});
    await expect(purchase({idempotencyKey:key,guestFirstName:'Changed'})).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    expect((await v2.operation(ids.property,key,input.customerId)).snapshot.id).toBe(first.reservationId);
  });
  it('rolls back cancellation when settlement fails and recovers exactly once',async()=>{
    const first=await purchase(),read=await v2.snapshot(ids.property,'reservation',first.reservationId,input.customerId);
    const dto={propertyId:ids.property,customerId:input.customerId,idempotencyKey:randomUUID(),expectedUpdatedAt:read.updatedAt!};
    const fail=vi.spyOn(settlement,'settleFromEvaluation').mockRejectedValueOnce(new Error('Temporary ledger failure'));
    await expect(v2.mutateReservation(first.reservationId,dto as any,'cancel')).rejects.toThrow('Temporary ledger failure');
    expect((await v2.snapshot(ids.property,'reservation',first.reservationId,input.customerId)).status).toBe('assigned');
    fail.mockRestore();
    const results=await Promise.all([v2.mutateReservation(first.reservationId,dto as any,'cancel'),v2.mutateReservation(first.reservationId,dto as any,'cancel')]);
    expect(results.map(r=>r.snapshot.status)).toEqual(['cancelled','cancelled']);
    expect(await db.select().from(connectOperations).where(eq(connectOperations.propertyId,ids.property))).toHaveLength(1);
  });
  it('amends accepted dates atomically and rejects a stale independent command',async()=>{
    const first=await purchase(),read=await v2.snapshot(ids.property,'reservation',first.reservationId,input.customerId);
    const quote=await v2.quote({...input,checkOut:'2027-03-04'});
    const dto={propertyId:ids.property,customerId:input.customerId,idempotencyKey:randomUUID(),expectedUpdatedAt:read.updatedAt!,acceptedQuote:quote.acceptedQuote};
    const result=await v2.mutateReservation(first.reservationId,dto as any,'amend');
    expect(result.snapshot.totalAmount).toBe('330.00');expect(result.snapshot.checkOut).toBe('2027-03-04');
    expect((await v2.mutateReservation(first.reservationId,dto as any,'amend')).snapshot.id).toBe(first.reservationId);
    await expect(v2.mutateReservation(first.reservationId,{...dto,idempotencyKey:randomUUID()} as any,'amend')).rejects.toThrow('REVISION_CONFLICT');
  });
  it.runIf(process.env.GUESTRA_CROSS_REPO==='1')('uses real HTTP contracts and two independent PostgreSQL databases',async()=>{
    const crmRoot=process.env.CRM_TEST_ROOT!.replace(/\\/g,'/');
    const crmUrl=new URL(process.env.CRM_TEST_DATABASE_URL!);
    if(!['localhost','127.0.0.1'].includes(crmUrl.hostname)||!crmUrl.pathname.endsWith('_integration_test')||crmUrl.pathname===parsed.pathname)
      throw new Error('A separate CRM integration_test database is required');
    const {createApp}=await import(crmRoot+'/server/app.ts');
    const {createDatabase}=await import(crmRoot+'/server/db/client.ts');
    const {bootstrapDatabase}=await import(crmRoot+'/server/db/bootstrap.ts');
    const {pool,db:crmDb}=createDatabase(crmUrl.toString());
    const pmsKey='local-http-pms-test-key',crmKey='local-http-crm-test-key',eventSecret='local-http-domain-event-signing-secret';
    let api:any, studioCrmServer:ReturnType<typeof createServer>|undefined;
    try {
      const exists=await pool.query("select to_regclass('public.organizations') as name");
      if(!exists.rows[0].name) {
        const journal=JSON.parse(await readFile(crmRoot+'/drizzle/meta/_journal.json','utf8'));
        for(const entry of journal.entries)await pool.query((await readFile(crmRoot+'/drizzle/'+entry.tag+'.sql','utf8')).replaceAll('--> statement-breakpoint',''));
      }
      await pool.query(await readFile(crmRoot+'/integration-migrations/0001_cross_database_v2.sql','utf8'));
      await pool.query("insert into guestra_integration_deployment(id,environment,deployment_id) values(true,'test',$1) on conflict(id) do nothing",[randomUUID()]);
      await db.insert(connectCredentials).values({propertyId:ids.property,label:'Isolated HTTP contract',keyHash:createHash('sha256').update(pmsKey).digest('hex'),
        scopes:['integration.read','integration.write','events.read','sandbox.setup','environment:test']});
      config.set('GUESTRA_INTEGRATION_V2_ENABLED','true');config.set('AUTH_ENABLED','true');config.set('PMS_COMMAND_SECRET',eventSecret);
      const module=await Test.createTestingModule({controllers:[ConnectV2Controller],providers:[
        {provide:DRIZZLE,useValue:db},{provide:ConfigService,useValue:config},{provide:ConnectV2Service,useValue:v2},{provide:ConnectSandboxService,useValue:sandbox},
        ApiKeyGuard,ConnectScopeGuard,ConnectV2Guard]}).compile();
      api=module.createNestApplication({logger:false});api.setGlobalPrefix('api/v1');
      api.useGlobalPipes(new ValidationPipe({whitelist:true,forbidNonWhitelisted:true,transform:true}));
      await api.listen(0,'127.0.0.1');
      const pmsUrl=await api.getUrl();
      const crmConfig={DATABASE_URL:crmUrl.toString(),SESSION_SECRET:'isolated-http-session-secret-32-characters',
        CRM_INTEGRATION_API_KEY:'isolated-legacy-key',SALES_BOOTSTRAP_EMAIL:'sales@guestra.com',SALES_BOOTSTRAP_PASSWORD:'sales123',
        ADMIN_BOOTSTRAP_EMAIL:'admin@guestra.com',ADMIN_BOOTSTRAP_PASSWORD:'admin_123',NODE_ENV:'test',PORT:3000,
        CRM_PMS_INTEGRATION_ENABLED:'true',GUESTRA_SANDBOX_SETUP_ENABLED:'true',INTEGRATION_ENVIRONMENT:'test',PMS_CONNECT_URL:pmsUrl+'/api/v1/connect',PMS_CONNECT_KEY:pmsKey,
        PMS_EVENT_SECRET:eventSecret,PMS_COMMAND_SECRET:eventSecret,PMS_PROPERTY_MAPPINGS:JSON.stringify([{crmPropertyId:'les_borovoe',crmTenantId:'org_les_live',
          pmsPropertyId:ids.property,pmsTenantId:ids.property,environment:'test'}]),
        CRM_INTEGRATION_PRINCIPALS:JSON.stringify([{id:'http-orchestrator',keyHash:createHash('sha256').update(crmKey).digest('hex'),
          environment:'test',propertyIds:['les_borovoe'],scopes:['agent.read','agent.write','integration.read','integration.write','events.consume',
            'sandbox.setup','inbox.handoff','tool:create_or_update_request','tool:create_offer','tool:book_accommodation','tool:book_service','tool:create_guest_request','tool:cancel_accommodation']}])};
      await bootstrapDatabase(crmDb,crmConfig);
      const crm=createApp(crmDb,crmConfig),agent=request(crm);
      await pool.query("insert into guestra_sandbox_properties(property_id,tenant_id) values('les_borovoe','org_les_live') on conflict do nothing");
      const send=(path:string,body:any)=>agent.post('/api/integrations/agent'+path).set('x-crm-api-key',crmKey).send(body);
      const origin={propertyId:'les_borovoe',channel:'simulator',externalUserId:'http-'+randomUUID(),externalChatId:'http-chat-'+randomUUID()};
      let inbound:any;
      if(process.env.STUDIO_TEST_ROOT) {
        const studioRoot=process.env.STUDIO_TEST_ROOT.replace(/\\/g,'/');
        const {Integrations}=await import(studioRoot+'/server/integrations.ts');
        studioCrmServer=createServer({key:await readFile(process.env.INTEGRATION_TEST_TLS_KEY!),cert:await readFile(process.env.INTEGRATION_TEST_TLS_CERT!)},crm);
        await new Promise<void>(resolve=>studioCrmServer!.listen(0,'127.0.0.1',resolve));
        const port=(studioCrmServer.address() as any).port;
        const studio=new Integrations({environment:'test',sandbox:true,local:false,crmVersion:'v2',allowedHosts:['127.0.0.1'],integrationHosts:['127.0.0.1'],
          crmUrl:`https://127.0.0.1:${port}/api/integrations/agent`,crmKey,crmProperty:'les_borovoe',crmTenant:'org_les_live',pmsProperty:ids.property,pmsTenant:ids.property});
        const conv={externalChatId:origin.externalChatId},guest={externalUserId:origin.externalUserId},attempt={externalMessageId:randomUUID(),correlationId:randomUUID(),text:'Хочу забронировать',attachments:[]};
        const client={firstName:'Integration',lastName:'Test',displayName:'Integration Test',language:'ru'};
        inbound={body:await studio.inbound(conv,guest,attempt,client)};
        const duplicate=await studio.inbound(conv,guest,attempt,client);
        expect(duplicate.duplicate).toBe(true);
        expect(duplicate.context.customer.id).toBe(inbound.body.context.customer.id);
        const returning=await studio.inbound(conv,guest,{...attempt,externalMessageId:randomUUID(),correlationId:randomUUID(),text:'Я уже писал'},client);
        expect(returning.context.customer.id).toBe(inbound.body.context.customer.id);
        expect(returning.context.conversation.id).toBe(inbound.body.context.conversation.id);
      } else inbound=await send('/messages/inbound',{...origin,externalMessageId:randomUUID(),text:'Хочу забронировать'}).expect(201);
      const identity={...origin,conversationId:inbound.body.context.conversation.id};
      const before=await pool.query('select (select count(*) from reservations)::int as reservations,(select count(*) from folios)::int as folios');
      const lead=await send('/requests/upsert',{...identity,idempotencyKey:randomUUID(),direction:'accommodation',checkIn:'2027-03-01T00:00:00Z',
        checkOut:'2027-03-03T00:00:00Z',adults:1,children:0,category:'Standard'}).expect(201);
      const offer=await send('/v2/offers',{...identity,requestId:lead.body.requestId??lead.body.request?.id,
        roomTypeId:ids.type,ratePlanId:ids.rate,idempotencyKey:randomUUID()});
      expect(offer.status,offer.text).toBe(201);
      expect(offer.body.offer.total).toBe(220);
      expect((await pool.query('select total_amount,room_amount from leads where id=$1',[offer.body.offer.leadId])).rows[0])
        .toEqual({total_amount:220,room_amount:220});
      async function approve(actionType:string,payload:any) {
        const key=randomUUID();
        const proposed=await send('/v2/messages/outbound/prepare',{...identity,text:'Подтвердите действие',idempotencyKey:key,proposedAction:{actionType,payload}}).expect(201);
        expect(proposed.body.deliveryStatus).toBe('pending');
        await send('/messages/outbound/result',{...identity,messageId:proposed.body.messageId,idempotencyKey:key,success:true,
          externalMessageId:'simulator:'+proposed.body.messageId}).expect(200);
        const confirmed=await send('/messages/inbound',{...origin,externalMessageId:randomUUID(),text:'Подтверждаю'}).expect(201);
        return {proposalMessageId:proposed.body.messageId,confirmationMessageId:confirmed.body.messageId,idempotencyKey:randomUUID()};
      }
      const approval=await approve('book_accommodation',{offerId:offer.body.offer.id});
      const dto={...identity,...approval,offerId:offer.body.offer.id};
      const outcomes=await Promise.all([send('/v2/accommodations/book',dto),send('/v2/accommodations/book',dto)]);
      expect(outcomes.map(response=>response.status)).toEqual([200,200]);
      expect(outcomes[0].body.snapshot.id).toBe(outcomes[1].body.snapshot.id);
      const booked=outcomes[0].body.snapshot;
      expect(booked.guestId).not.toBe(inbound.body.context.customer.id);
      expect(await db.select().from(reservations).where(eq(reservations.propertyId,ids.property))).toHaveLength(1);
      const repeatedOffer=await send('/v2/offers',{...identity,requestId:offer.body.offer.leadId,
        roomTypeId:ids.type,ratePlanId:ids.rate,idempotencyKey:randomUUID()});
      expect(repeatedOffer.status,repeatedOffer.text).toBe(409);
      expect(repeatedOffer.body.error).toBe('REQUEST_ALREADY_BOOKED');
      expect(await db.select().from(reservations).where(eq(reservations.propertyId,ids.property))).toHaveLength(1);
      expect((await pool.query('select (select count(*) from reservations)::int as reservations,(select count(*) from folios)::int as folios')).rows).toEqual(before.rows);
      const payload={serviceId:ids.service,startAt:'2027-03-01T09:00:00Z',endAt:'2027-03-01T10:00:00Z',participants:1,quantity:1,expectedTotal:'50.00'};
      const serviceApproval=await approve('book_service',payload);
      const serviceResult=await send('/v2/actions',{...identity,...serviceApproval,actionType:'book_service',payload}).expect(200);
      expect(serviceResult.body.snapshot.totalAmount).toBe('50.00');
      expect(await db.select().from(charges).where(eq(charges.propertyId,ids.property))).toHaveLength(1);
      const guestMessage=await send('/messages/inbound',{...origin,externalMessageId:randomUUID(),text:'Нужны полотенца'}).expect(201);
      await send('/v2/guest-requests',{...identity,sourceMessageId:guestMessage.body.messageId,title:'Дополнительные полотенца',
        department:'housekeeping',priority:'medium',idempotencyKey:randomUUID()}).expect(200);
      expect(await db.select().from(serviceRequests).where(eq(serviceRequests.propertyId,ids.property))).toHaveLength(1);
      const cancelPayload={entityId:booked.id,expectedUpdatedAt:booked.updatedAt};
      const cancelApproval=await approve('cancel_accommodation',cancelPayload);
      const cancelled=await send('/v2/actions',{...identity,...cancelApproval,actionType:'cancel_accommodation',payload:cancelPayload}).expect(200);
      expect(cancelled.body.snapshot.status).toBe('cancelled');
      const oldEvents=await request(api.getHttpServer()).get('/api/v1/connect/v2/events').set('x-api-key',pmsKey).query({propertyId:ids.property,after:0}).expect(200);
      const old=oldEvents.body.events.find((e:any)=>e.entityId===booked.id&&e.eventType==='reservation.created');
      const body=JSON.stringify({data:{integrationEnvelope:old}}),time=String(Math.floor(Date.now()/1000));
      await agent.post('/api/integrations/pms/v1/events/les_borovoe').set('Content-Type','application/json').set('x-guestra-timestamp',time)
        .set('x-guestra-signature',createHmac('sha256',eventSecret).update(time+'.'+body).digest('hex')).send(body).expect(200);
      const projected=await pool.query("select snapshot->>'status' as status from integration_projections where entity_id=$1",[booked.id]);
      expect(projected.rows[0].status).toBe('cancelled');
      await send('/v2/inbox/'+identity.conversationId+'/takeover',{propertyId:identity.propertyId,staffReference:'pms:test-staff'}).expect(200);
      await send('/v2/messages/outbound/prepare',{...identity,text:'Поздний ответ AI',idempotencyKey:randomUUID()}).expect(409);
      const quote=await v2.quote(input);
      await request(api.getHttpServer()).post('/api/v1/connect/v2/book').set('x-api-key',pmsKey)
        .send({...input,guestFirstName:'Unauthorized',acceptedQuote:quote.acceptedQuote,idempotencyKey:randomUUID(),integrationContext:{sourceSystem:'guestra_crm',customerId:input.customerId}}).expect(403);
      config.set('GUESTRA_SANDBOX_SETUP_ENABLED','true');
      for(const stage of fixtureStages) {
        const fixtureId=randomUUID(),payload={propertyId:'les_borovoe',fixtureId,stage};
        const fixture=await send('/v2/sandbox/fixtures',payload).expect(200);
        expect((await send('/v2/sandbox/fixtures',payload).expect(200)).body.refs).toEqual(fixture.body.refs);
        expect(fixture.body.customerId).not.toBe(fixture.body.refs.guestId);
        if(['in_house','due_out','post_stay','service_only','pending_payment'].includes(stage))expect(fixture.body.context.lifecycle).toBe(stage);
        if(stage==='human_handoff')expect(fixture.body.context.aiReplyAllowed).toBe(false);
        await send('/v2/sandbox/fixtures/'+fixtureId+'/retire',{propertyId:'les_borovoe'}).expect(200);
        await send('/v2/sandbox/fixtures',payload).expect(409);
      }
    } finally {
      if(studioCrmServer)await new Promise<void>((resolve,reject)=>studioCrmServer!.close(error=>error?reject(error):resolve()));
      await api?.close();await db.delete(connectCredentials).where(eq(connectCredentials.propertyId,ids.property));await pool.end();
    }
  },60000);
  it('constructs all fourteen real isolated journey states, rejects production and retires inventory',async()=>{
    config.set('GUESTRA_SANDBOX_SETUP_ENABLED','true');
    for(const stage of fixtureStages) {
      const input={propertyId:ids.property,fixtureId:randomUUID(),customerId:'fixture-'+stage,conversationId:'conversation-'+stage,stage};
      const result=await sandbox.setup(input);
      expect((await sandbox.setup(input)).refs).toEqual(result.refs);
      if(['in_house','due_out'].includes(stage))expect(result.snapshots.find(s=>s.entityType==='reservation')?.status).toBe('checked_in');
      if(stage==='pending_payment') {
        expect(result.simulatedPayment).toMatchObject({source:'simulated',status:'pending',ledgerEffect:false});
        const before=await db.select().from(payments).where(eq(payments.propertyId,ids.property));
        expect((await sandbox.simulatePayment(ids.property,input.fixtureId,input.customerId)).simulatedPayment)
          .toMatchObject({source:'simulated',status:'confirmed',ledgerEffect:false,providerVerified:false});
        expect(await db.select().from(payments).where(eq(payments.propertyId,ids.property))).toEqual(before);
      }
      if(stage==='service_only')expect(result.snapshots.find(s=>s.entityType==='service_booking')?.totalAmount).toBe('50.00');
      if(stage==='cancelled')expect(result.snapshots.find(s=>s.entityType==='reservation')?.status).toBe('cancelled');
      await expect(sandbox.setup({...input,stage:stage==='new_contact'?'enquire':'new_contact'})).rejects.toThrow('IDEMPOTENCY_CONFLICT');
      await sandbox.retire(ids.property,input.fixtureId,input.customerId);
      await expect(sandbox.read(ids.property,input.fixtureId,input.customerId)).rejects.toThrow('FIXTURE_EXPIRED');
    }
    config.set('INTEGRATION_ENVIRONMENT','production');
    await expect(sandbox.setup({propertyId:ids.property,fixtureId:randomUUID(),customerId:'deny',conversationId:'deny',stage:'new_contact'})).rejects.toThrow('SANDBOX_ISOLATION_REQUIRED');
    config.set('INTEGRATION_ENVIRONMENT','test');
  });
});

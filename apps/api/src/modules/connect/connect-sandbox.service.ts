import {Inject,Injectable,ForbiddenException,ConflictException,NotFoundException} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {and,eq,lte,isNull} from 'drizzle-orm';
import {randomUUID} from 'node:crypto';
import {properties,guests,guestPropertyLinks,integrationLinks,rooms,bookings,reservations,folios,charges,serviceBookings,services} from '@telivityhaip/database';
import {DRIZZLE} from '../../database/database.module';
import {integrationDeployment,sandboxProperties,sandboxFixtures} from './connect-operation-schema';
import {ConnectV2Service} from './connect-v2.service';
import {fingerprint} from './connect-quote';
export const fixtureStages=['new_contact','returning_customer','enquire','tentative','definite','pending_payment',
 'confirmed_reservation','pre_arrival','in_house','service_only','due_out','post_stay','cancelled','human_handoff'] as const;
export interface FixtureInput {propertyId:string;fixtureId:string;customerId:string;conversationId:string;requestId?:string;stage:typeof fixtureStages[number]}
/** Privileged test data construction. It cannot operate on an unregistered property or production database. */
@Injectable()
export class ConnectSandboxService {
 private timer?:ReturnType<typeof setInterval>;
 private sweeping=false;
 constructor(@Inject(DRIZZLE) private readonly db:any,private readonly config:ConfigService,private readonly operational:ConnectV2Service){}
 onModuleInit() {
  if(this.config.get('GUESTRA_SANDBOX_SETUP_ENABLED')!=='true'||!['test','sandbox'].includes(this.config.get('INTEGRATION_ENVIRONMENT','production')))return;
  this.timer=setInterval(()=>{void this.expire().catch(()=>{/* Retained receipts permit explicit retry. */});},60000);this.timer.unref();
 }
 onModuleDestroy(){if(this.timer)clearInterval(this.timer);}
 async expire() {
  if(this.sweeping)return;this.sweeping=true;
  try {
   const rows=await this.db.select().from(sandboxFixtures).where(and(lte(sandboxFixtures.expiresAt,new Date()),isNull(sandboxFixtures.retiredAt))).limit(20);
   for(const row of rows)await this.retire(row.propertyId,row.key,row.customerId);
  }finally{this.sweeping=false;}
 }
 async simulatePayment(propertyId:string,key:string,customerId:string) {
  const current=await this.read(propertyId,key,customerId);
  if(!current.simulatedPayment)throw new ConflictException('FIXTURE_HAS_NO_PAYMENT_SCENARIO');
  const simulatedPayment={source:'simulated',status:'confirmed',ledgerEffect:false,providerVerified:false};
  await this.db.update(sandboxFixtures).set({simulatedPayment}).where(and(eq(sandboxFixtures.propertyId,propertyId),eq(sandboxFixtures.key,key),eq(sandboxFixtures.customerId,customerId)));
  return {fixtureId:key,simulatedPayment};
 }
 private async allowed(propertyId:string) {
  const environment=this.config.get('INTEGRATION_ENVIRONMENT','production');
  const [deployment]=await this.db.select().from(integrationDeployment).limit(1);
  const [registered]=await this.db.select().from(sandboxProperties).where(eq(sandboxProperties.propertyId,propertyId));
  const [property]=await this.db.select().from(properties).where(eq(properties.id,propertyId));
  if(this.config.get('GUESTRA_SANDBOX_SETUP_ENABLED')!=='true'||!['test','sandbox'].includes(environment)||deployment?.environment!==environment||
    !registered||!property||registered.tenantId!==(property.organizationId??property.id))throw new ForbiddenException('SANDBOX_ISOLATION_REQUIRED');
  return {registered,property};
 }
 async setup(input:FixtureInput) {
  const {registered,property}=await this.allowed(input.propertyId);
  const digest=fingerprint(input),where=and(eq(sandboxFixtures.propertyId,input.propertyId),eq(sandboxFixtures.key,input.fixtureId));
  const current=await this.db.select().from(sandboxFixtures).where(where);
  if(current[0]) {if(current[0].fingerprint!==digest)throw new ConflictException('IDEMPOTENCY_CONFLICT');
   if(input.stage!=='service_only'||current[0].refs.serviceBookingId)return this.read(input.propertyId,input.fixtureId,input.customerId);
   if(current[0].retiredAt||current[0].expiresAt<=new Date())throw new ConflictException('FIXTURE_EXPIRED');}
  const stay=!['new_contact','enquire','tentative','definite','human_handoff','service_only'].includes(input.stage);
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:property.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  const today=['year','month','day'].map(type=>parts.find(part=>part.type===type)!.value).join('-');
  const date=(offset:number)=>new Date(Date.parse(today+'T12:00:00Z')+offset*86400000).toISOString().slice(0,10);
  const historical=['returning_customer','post_stay'].includes(input.stage),inside=['in_house','due_out'].includes(input.stage);
  const arrival=date(historical?-7:inside?-1:7),departure=date(historical?-5:input.stage==='due_out'?0:inside?1:9);
  const pricing=stay?await this.operational.quote({propertyId:input.propertyId,customerId:input.customerId,roomTypeId:registered.roomTypeId,
    ratePlanId:registered.ratePlanId,checkIn:arrival,checkOut:departure,adults:1,children:0}):null;
  await this.db.transaction(async(tx:any)=>{
   await tx.select().from(properties).where(eq(properties.id,input.propertyId)).for('no key update');
   const [prior]=await tx.select().from(sandboxFixtures).where(where);
   if(prior){if(prior.fingerprint!==digest)throw new ConflictException('IDEMPOTENCY_CONFLICT');return;}
   const refs:Record<string,string>={guestId:randomUUID()};
   const [existing]=await tx.select().from(integrationLinks).where(and(eq(integrationLinks.propertyId,input.propertyId),eq(integrationLinks.sourceSystem,'guestra_crm'),
    eq(integrationLinks.externalEntityType,'customer'),eq(integrationLinks.externalEntityId,input.customerId)));
   if(existing)throw new ConflictException('FIXTURE_REQUIRES_ISOLATED_CUSTOMER');
   await tx.insert(guests).values({id:refs['guestId'],firstName:'Sandbox',lastName:input.fixtureId.slice(0,80),preferences:{fixtureSource:'simulated'}});
   await tx.insert(guestPropertyLinks).values({propertyId:input.propertyId,guestId:refs['guestId']});
   await tx.insert(integrationLinks).values({propertyId:input.propertyId,sourceSystem:'guestra_crm',externalEntityType:'customer',externalEntityId:input.customerId,
    localEntityType:'guest',localEntityId:refs['guestId'],metadata:{verifiedBy:'isolated_fixture',fixtureId:input.fixtureId}});
   if(stay&&pricing) {
    refs['bookingId']=randomUUID();refs['reservationId']=randomUUID();refs['roomId']=randomUUID();refs['folioId']=randomUUID();
    const status=historical?'checked_out':input.stage==='cancelled'?'cancelled':input.stage==='pending_payment'?'pending':inside?'checked_in':'confirmed';
    await tx.insert(rooms).values({id:refs['roomId'],propertyId:input.propertyId,roomTypeId:registered.roomTypeId,number:'FX-'+refs['roomId'].slice(0,8),status:inside?'occupied':'vacant_clean'});
    await tx.insert(bookings).values({id:refs['bookingId'],propertyId:input.propertyId,guestId:refs['guestId'],confirmationNumber:'FIX-'+refs['bookingId'],source:'agent',
     integrationContext:{sourceSystem:'guestra_crm',customerId:input.customerId,conversationId:input.conversationId,requestId:input.requestId,fixtureId:input.fixtureId}});
    await tx.insert(reservations).values({id:refs['reservationId'],propertyId:input.propertyId,bookingId:refs['bookingId'],guestId:refs['guestId'],roomId:refs['roomId'],
     roomTypeId:registered.roomTypeId,ratePlanId:registered.ratePlanId,arrivalDate:arrival,departureDate:departure,nights:pricing.nights,status,
     totalAmount:pricing.totalAmount,currencyCode:pricing.currency,adults:1,children:0,checkedInAt:inside?new Date():null,
     checkedOutAt:historical?new Date():null,cancelledAt:status==='cancelled'?new Date():null});
    await tx.insert(folios).values({id:refs['folioId'],propertyId:input.propertyId,guestId:refs['guestId'],reservationId:refs['reservationId'],
     folioNumber:'FIX-'+refs['folioId'],currencyCode:property.currencyCode,totalCharges:pricing.totalAmount,balance:pricing.totalAmount});
    await tx.insert(charges).values({propertyId:input.propertyId,folioId:refs['folioId'],type:'room',description:'Simulated sandbox accommodation',
     amount:pricing.totalAmount,currencyCode:pricing.currency,serviceDate:new Date(arrival),sourceKey:'fixture:'+input.fixtureId});
   }
   await tx.insert(sandboxFixtures).values({propertyId:input.propertyId,key:input.fixtureId,fingerprint:digest,customerId:input.customerId,stage:input.stage,refs,
    expiresAt:new Date(Date.now()+86400000),simulatedPayment:stay?{source:'simulated',status:input.stage==='pending_payment'?'pending':'not_paid',ledgerEffect:false}:null});
  });
  if(input.stage==='service_only') {
   if(!registered.serviceId)throw new ConflictException('SANDBOX_SERVICE_NOT_CONFIGURED');
   const startAt=date(1)+'T09:00:00Z',endAt=date(1)+'T10:00:00Z';
   const [service]=await this.db.select().from(services).where(and(eq(services.propertyId,input.propertyId),eq(services.id,registered.serviceId)));
   if(!service)throw new ConflictException('SANDBOX_SERVICE_NOT_CONFIGURED');
   const booked=await this.operational.serviceBook({propertyId:input.propertyId,serviceId:service.id,startAt,endAt,quantity:1,participants:1,
    expectedTotal:service.price,idempotencyKey:'fixture:'+input.fixtureId,guestFirstName:'Sandbox',guestLastName:'Fixture',
    integrationContext:{sourceSystem:'guestra_crm',customerId:input.customerId,conversationId:input.conversationId}});
   await this.db.transaction(async(tx:any)=>{
    const [row]=await tx.select().from(sandboxFixtures).where(where).for('update');
    await tx.update(sandboxFixtures).set({refs:{...row.refs,serviceBookingId:booked.serviceBookingId}}).where(where);
   });
  }
  return this.read(input.propertyId,input.fixtureId,input.customerId);
 }
 async read(propertyId:string,key:string,customerId:string) {
  await this.allowed(propertyId);
  const [row]=await this.db.select().from(sandboxFixtures).where(and(eq(sandboxFixtures.propertyId,propertyId),eq(sandboxFixtures.key,key),eq(sandboxFixtures.customerId,customerId)));
  if(!row)throw new NotFoundException('FIXTURE_NOT_FOUND');
  if(row.retiredAt||row.expiresAt<=new Date())throw new ConflictException('FIXTURE_EXPIRED');
  const snapshots=[];
  for(const [ref,type] of [['reservationId','reservation'],['folioId','folio'],['serviceBookingId','service_booking']])
   if(row.refs[ref!])snapshots.push(await this.operational.snapshot(propertyId,type!,row.refs[ref!],customerId));
  return {contractVersion:'guestra-fixtures-v1',propertyId,fixtureId:key,stage:row.stage,customerId,refs:row.refs,expiresAt:row.expiresAt,snapshots,simulatedPayment:row.simulatedPayment};
 }
 async retire(propertyId:string,key:string,customerId:string) {
  await this.allowed(propertyId);
  return this.db.transaction(async(tx:any)=>{
   const [row]=await tx.select().from(sandboxFixtures).where(and(eq(sandboxFixtures.propertyId,propertyId),eq(sandboxFixtures.key,key),eq(sandboxFixtures.customerId,customerId))).for('update');
   if(!row)throw new NotFoundException('FIXTURE_NOT_FOUND');
   if(!row.retiredAt) {
    if(row.refs.reservationId)await tx.update(reservations).set({status:'cancelled',updatedAt:new Date(),cancellationReason:'Sandbox fixture retired'})
     .where(and(eq(reservations.propertyId,propertyId),eq(reservations.id,row.refs.reservationId),eq(reservations.guestId,row.refs.guestId)));
    if(row.refs.serviceBookingId)await tx.update(serviceBookings).set({status:'cancelled',updatedAt:new Date()}).where(and(eq(serviceBookings.propertyId,propertyId),eq(serviceBookings.id,row.refs.serviceBookingId)));
    if(row.refs.roomId)await tx.update(rooms).set({status:'out_of_service',isActive:false,updatedAt:new Date()}).where(and(eq(rooms.propertyId,propertyId),eq(rooms.id,row.refs.roomId)));
    await tx.update(sandboxFixtures).set({retiredAt:new Date()}).where(and(eq(sandboxFixtures.propertyId,propertyId),eq(sandboxFixtures.key,key)));
   }
   return {fixtureId:key,retired:true,retainedForAudit:true};
  });
 }
}

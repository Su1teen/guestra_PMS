import { Injectable, Inject, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, asc, gt, sql } from 'drizzle-orm';
import Decimal from 'decimal.js';
import { properties,roomTypes,ratePlans,reservations,bookings,guests,integrationLinks,folios,payments,domainEventOutbox,serviceOperations,serviceBookings,serviceRequests } from '@telivityhaip/database';
import { DRIZZLE } from '../../database/database.module';
import { RatePlanService } from '../rate-plan/rate-plan.service';
import { TaxService } from '../tax/tax.service';
import { calculateCanonicalRoomPricing } from '../rate-plan/canonical-room-pricing';
import { ConnectBookingService } from './connect-booking.service';
import { ConnectSearchService } from './connect-search.service';
import type {AgentSearchDto} from './dto/agent-search.dto';
import { ReservationService } from '../reservation/reservation.service';
import { AvailabilityService } from '../reservation/availability.service';
import { FolioService } from '../folio/folio.service';
import { PolicyService } from '../policy/policy.service';
import { DepositSettlementService } from '../accounting/deposit-settlement.service';
import { ConnectServiceBookingService } from './connect-service-booking.service';
import { connectOperations,integrationDeployment } from './connect-operation-schema';
import { ServiceRequestsService } from '../service-requests/service-requests.service';
import type {AgentServiceAvailabilityDto,AgentServiceBookDto} from './dto/agent-service.dto';
import type {ConnectServiceChangeV2Dto,ConnectServiceStatusV2Dto,ConnectRequestV2Dto} from './dto/connect-v2.dto';
import { signQuote,readQuote,fingerprint } from './connect-quote';
import {folioPaymentSumWhere} from '../payment/payment-ledger';
import type { ConnectBookV2Dto,ConnectQuoteDto,ConnectMutationV2Dto,ConnectAmendV2Dto } from './dto/connect-v2.dto';
@Injectable()
export class ConnectV2Service {
  constructor(@Inject(DRIZZLE) private readonly db:any, private readonly config:ConfigService,
    private readonly rates:RatePlanService,private readonly taxes:TaxService,private readonly booking:ConnectBookingService,
    private readonly reservationService:ReservationService,private readonly availability:AvailabilityService,
    private readonly folioService:FolioService,private readonly policy:PolicyService,
    private readonly settlement:DepositSettlementService,private readonly serviceBookings:ConnectServiceBookingService,
    private readonly requests:ServiceRequestsService,private readonly searchService:ConnectSearchService) {}
  async capabilities(propertyId:string,credentialId?:string) {
    const [property]=await this.db.select().from(properties).where(eq(properties.id,propertyId));
    if(!property) throw new NotFoundException('PROPERTY_NOT_FOUND');
    const [deployment]=await this.db.select().from(integrationDeployment).limit(1);
    if(!deployment||deployment.environment!==this.config.get('INTEGRATION_ENVIRONMENT','production'))throw new ConflictException('INTEGRATION_DATABASE_NOT_ATTESTED');
    return { contractVersion:'guestra-connect-v2',environment:this.config.get('INTEGRATION_ENVIRONMENT','production'),
      sourceSystem:'guestra_pms',propertyId,tenantId:property.organizationId ?? property.id,credentialId,deploymentId:deployment.deploymentId,
      ownership:['guests','inventory','reservations','stays','services','folios','payments'],
      features:{acceptedQuote:true,operationReceipts:true,durableEvents:true,authoritativeReadBack:true,paymentLinks:false} };
  }
  async quote(dto:ConnectQuoteDto) {
    const nights=(Date.parse(dto.checkOut)-Date.parse(dto.checkIn))/86400000;
    if(!Number.isInteger(nights) || nights<=0 || nights>365) throw new BadRequestException('INVALID_STAY_WINDOW');
    const [type]=await this.db.select().from(roomTypes).where(and(eq(roomTypes.propertyId,dto.propertyId),eq(roomTypes.id,dto.roomTypeId),eq(roomTypes.isActive,true)));
    const [plan]=await this.db.select().from(ratePlans).where(and(eq(ratePlans.propertyId,dto.propertyId),eq(ratePlans.id,dto.ratePlanId),eq(ratePlans.roomTypeId,dto.roomTypeId),eq(ratePlans.isActive,true)));
    if(!type || !plan || dto.adults+(dto.children??0)>type.maxOccupancy) throw new BadRequestException('INVALID_ROOM_RATE_OR_OCCUPANCY');
    await this.rates.assertSellable(dto.propertyId,dto.ratePlanId,dto.checkIn,dto.checkOut);
    const price=await calculateCanonicalRoomPricing({propertyId:dto.propertyId,ratePlanId:dto.ratePlanId,checkIn:dto.checkIn,checkOut:dto.checkOut,nights,
      isTaxInclusive:plan.isTaxInclusive,ratePlanService:this.rates,taxService:this.taxes});
    const expiresAt=new Date(Date.now()+Math.min(900,Math.max(30,Number(this.config.get('CONNECT_QUOTE_TTL_SECONDS','300'))))*1000).toISOString();
    const quote={version:'connect-quote-v2' as const,...dto,children:dto.children??0,...price,expiresAt};
    return { ...price,nights,propertyId:dto.propertyId,roomTypeId:dto.roomTypeId,ratePlanId:dto.ratePlanId,roomTypeName:type.name,expiresAt,
      acceptedQuote:signQuote(quote,this.config.get('CONNECT_QUOTE_SIGNING_SECRET','')) };
  }
  async book(dto:ConnectBookV2Dto) {
    if(!dto.idempotencyKey || dto.integrationContext?.sourceSystem!=='guestra_crm' || !dto.integrationContext?.customerId)
      throw new BadRequestException('INTEGRATION_CONTEXT_REQUIRED');
    const {acceptedQuote,...input}=dto;
    // Persist the signed quote in the fingerprint; replay may outlive its expiry.
    const [existing]=await this.db.select().from(bookings).where(and(eq(bookings.propertyId,dto.propertyId),eq(bookings.idempotencyKey,dto.idempotencyKey)));
    if(existing) {
      if(existing.integrationContext?.acceptedQuoteHash!==fingerprint(acceptedQuote)) throw new ConflictException('IDEMPOTENCY_CONFLICT');
      return this.booking.book({...input,integrationContext:{...input.integrationContext,acceptedQuoteHash:fingerprint(acceptedQuote)}});
    }
    const quote=readQuote(acceptedQuote,this.config.get('CONNECT_QUOTE_SIGNING_SECRET',''));
    return this.booking.book({...input,integrationContext:{...input.integrationContext,acceptedQuoteHash:fingerprint(acceptedQuote)}},quote);
  }
  private async identity(propertyId:string,customerId:string,db=this.db) {
    const [link]=await db.select().from(integrationLinks).where(and(eq(integrationLinks.propertyId,propertyId),eq(integrationLinks.sourceSystem,'guestra_crm'),
      eq(integrationLinks.externalEntityType,'customer'),eq(integrationLinks.externalEntityId,customerId),eq(integrationLinks.localEntityType,'guest')));
    if(!link) throw new NotFoundException('VERIFIED_IDENTITY_REQUIRED');
    return link.localEntityId as string;
  }
  private async revision(propertyId:string,type:string,id:string,db=this.db) {
    const [head]=await db.select().from(domainEventOutbox).where(and(eq(domainEventOutbox.propertyId,propertyId),
      sql`${domainEventOutbox.payload}->'integrationEnvelope'->>'entityId' = ${id}`,
      sql`${domainEventOutbox.payload}->'integrationEnvelope'->>'entityType' = ${type}`))
      .orderBy(sql`(${domainEventOutbox.payload}->'integrationEnvelope'->>'revision')::bigint desc`).limit(1);
    return Number(head?.payload?.integrationEnvelope?.revision ?? 0);
  }
  private context(input:any) {
    if(input?.sourceSystem!=='guestra_crm')return undefined;
    return Object.fromEntries(['sourceSystem','customerId','requestId','offerId','conversationId','operationId']
      .filter(key=>typeof input[key]==='string').map(key=>[key,input[key]]));
  }
  async snapshot(propertyId:string,type:string,id:string,customerId:string) {
    return this.db.transaction((tx:any)=>this.snapshotAt(tx,propertyId,type,id,customerId),{isolationLevel:'repeatable read',readOnly:true});
  }
  private async snapshotAt(db:any,propertyId:string,type:string,id:string,customerId:string) {
    const guestId=await this.identity(propertyId,customerId,db);
    if(type==='reservation') {
      const [row]=await db.select().from(reservations).where(and(eq(reservations.propertyId,propertyId),eq(reservations.id,id),eq(reservations.guestId,guestId)));
      if(!row) throw new NotFoundException('RESERVATION_NOT_FOUND');
      const [booking]=await db.select().from(bookings).where(and(eq(bookings.propertyId,propertyId),eq(bookings.id,row.bookingId)));
      const [property]=await db.select().from(properties).where(eq(properties.id,propertyId));
      const [head]=await db.select().from(domainEventOutbox).where(and(eq(domainEventOutbox.propertyId,propertyId),
        sql`${domainEventOutbox.payload}->'integrationEnvelope'->>'entityId' = ${id}`)).orderBy(sql`(${domainEventOutbox.payload}->'integrationEnvelope'->>'revision')::bigint desc`).limit(1);
      return {sourceSystem:'guestra_pms',propertyId,tenantId:property?.organizationId ?? propertyId,entityType:type,id,guestId,
        bookingId:row.bookingId,confirmationNumber:booking?.confirmationNumber,status:row.status,checkIn:row.arrivalDate,checkOut:row.departureDate,
        roomTypeId:row.roomTypeId,ratePlanId:row.ratePlanId,adults:row.adults,children:row.children,totalAmount:row.totalAmount,currencyCode:row.currencyCode,updatedAt:row.updatedAt.toISOString(),
        revision:Number(head?.payload?.integrationEnvelope?.revision ?? 0),integrationContext:this.context(booking?.integrationContext)};
    }
    if(type==='service_booking') {
      const [row]=await db.select().from(serviceBookings).where(and(eq(serviceBookings.propertyId,propertyId),eq(serviceBookings.id,id),eq(serviceBookings.guestId,guestId)));
      if(!row) throw new NotFoundException('SERVICE_BOOKING_NOT_FOUND');
      const detail=await this.serviceBookings.get(id,propertyId,db);
      return {propertyId,entityType:type,id,guestId,status:row.status,startAt:row.startAt,endAt:row.endAt,financial:detail.financial,
        revision:await this.revision(propertyId,type,id,db),entityRevision:row.revision,
        totalAmount:row.totalAmount,currencyCode:row.currencyCode,reservationId:row.reservationId,folioId:row.folioId,
        integrationContext:this.context(row.integrationContext)};
    }
    if(type==='folio') {
      const [row]=await db.select().from(folios).where(and(eq(folios.propertyId,propertyId),eq(folios.id,id),eq(folios.guestId,guestId)));
      if(!row) throw new NotFoundException('FOLIO_NOT_FOUND');
      const facts=await db.select({id:payments.id,status:payments.status,amount:payments.amount,currencyCode:payments.currencyCode,originalPaymentId:payments.originalPaymentId})
        .from(payments).where(and(eq(payments.propertyId,propertyId),eq(payments.folioId,id)));
      const [net]=await db.select({total:sql<string>`coalesce(sum(${payments.amount}), 0)`}).from(payments).where(folioPaymentSumWhere(id,propertyId));
      const received=new Decimal(net?.total ?? 0);
      return {propertyId,entityType:type,id,guestId,reservationId:row.reservationId,balance:row.balance,currencyCode:row.currencyCode,
        financialSource:'pms_ledger',receivedAmount:received.toFixed(2),payments:facts,revision:await this.revision(propertyId,type,id,db)};
    }
    if(type==='service_request') {
      const [row]=await db.select().from(serviceRequests).where(and(eq(serviceRequests.propertyId,propertyId),eq(serviceRequests.id,id),eq(serviceRequests.guestId,guestId)));
      if(!row)throw new NotFoundException('SERVICE_REQUEST_NOT_FOUND');
      return {propertyId,entityType:type,id,guestId,status:row.status,type:row.type,title:row.title,
        reservationId:row.reservationId,revision:await this.revision(propertyId,type,id,db),integrationContext:this.context(row.integrationContext)};
    }
    if(type==='payment') {
      const [row]=await db.select({id:payments.id,status:payments.status,amount:payments.amount,currencyCode:payments.currencyCode,
        originalPaymentId:payments.originalPaymentId,folioId:payments.folioId,reservationId:folios.reservationId}).from(payments)
        .innerJoin(folios,and(eq(folios.id,payments.folioId),eq(folios.propertyId,propertyId),eq(folios.guestId,guestId)))
        .where(and(eq(payments.propertyId,propertyId),eq(payments.id,id)));
      if(!row)throw new NotFoundException('PAYMENT_NOT_FOUND');
      return {...row,propertyId,entityType:type,guestId,financialSource:'pms_ledger',revision:await this.revision(propertyId,type,id,db)};
    }
    throw new BadRequestException('UNSUPPORTED_ENTITY');
  }
  async events(propertyId:string,after:number,limit:number) {
    if(!Number.isSafeInteger(after)||after<0) throw new BadRequestException('INVALID_CURSOR');
    const rows=await this.db.select().from(domainEventOutbox).where(and(eq(domainEventOutbox.propertyId,propertyId),
      sql`${domainEventOutbox.payload} ? 'integrationEnvelope'`,
      sql`(${domainEventOutbox.payload}->'integrationEnvelope'->>'revision')::bigint > ${after}`))
      .orderBy(sql`(${domainEventOutbox.payload}->'integrationEnvelope'->>'revision')::bigint`).limit(limit+1);
    const page=rows.slice(0,limit).map((r:any)=>r.payload.integrationEnvelope);
    return {events:page,nextCursor:page.at(-1)?.revision ?? after,hasMore:rows.length>limit};
  }
  async operation(propertyId:string,key:string,customerId:string) {
    const [receipt]=await this.db.select().from(connectOperations).where(and(eq(connectOperations.propertyId,propertyId),eq(connectOperations.key,key),
      eq(connectOperations.customerId,customerId)));
    if(receipt)return {operationKey:key,status:'completed',snapshot:await this.snapshot(propertyId,receipt.entityType,receipt.entityId,customerId),result:receipt.result};
    const [serviceBooking]=await this.db.select().from(serviceBookings).where(and(eq(serviceBookings.propertyId,propertyId),eq(serviceBookings.idempotencyKey,key)));
    if(serviceBooking?.integrationContext?.customerId===customerId)
      return {operationKey:key,status:'completed',snapshot:await this.snapshot(propertyId,'service_booking',serviceBooking.id,customerId)};
    const [request]=await this.db.select().from(serviceRequests).where(and(eq(serviceRequests.propertyId,propertyId),eq(serviceRequests.idempotencyKey,key)));
    if(request?.integrationContext?.customerId===customerId)
      return {operationKey:key,status:'completed',snapshot:await this.snapshot(propertyId,'service_request',request.id,customerId)};
    const [serviceReceipt]=await this.db.select().from(serviceOperations).where(and(eq(serviceOperations.propertyId,propertyId),eq(serviceOperations.idempotencyKey,key)));
    if(serviceReceipt && typeof serviceReceipt.response?.id==='string') {
      const snapshot=await this.snapshot(propertyId,'service_booking',serviceReceipt.response.id,customerId);
      return {operationKey:key,status:'completed',snapshot};
    }
    const [booking]=await this.db.select().from(bookings).where(and(eq(bookings.propertyId,propertyId),eq(bookings.idempotencyKey,key)));
    if(booking && booking.integrationContext?.customerId===customerId) {
      const [r]=await this.db.select({id:reservations.id}).from(reservations).where(and(eq(reservations.propertyId,propertyId),eq(reservations.bookingId,booking.id)));
      return {operationKey:key,status:'completed',snapshot:await this.snapshot(propertyId,'reservation',r.id,customerId)};
    }
    throw new NotFoundException('OPERATION_NOT_FOUND');
  }
  async mutateReservation(id:string,dto:ConnectMutationV2Dto|ConnectAmendV2Dto,kind:'cancel'|'amend') {
    const guestId=await this.identity(dto.propertyId,dto.customerId);
    const hash=fingerprint({kind,id,...dto});
    await this.db.transaction(async(tx:any)=>{
      // Same lock order as new bookings prevents races between first contact and amendments.
      await tx.select({id:properties.id}).from(properties).where(eq(properties.id,dto.propertyId)).for('no key update');
      const [receipt]=await tx.select().from(connectOperations).where(and(eq(connectOperations.propertyId,dto.propertyId),eq(connectOperations.key,dto.idempotencyKey)));
      if(receipt) {
        if(receipt.customerId!==dto.customerId||receipt.fingerprint!==hash)throw new ConflictException('IDEMPOTENCY_CONFLICT');
        return;
      }
      const [row]=await tx.select().from(reservations).where(and(eq(reservations.id,id),eq(reservations.propertyId,dto.propertyId),eq(reservations.guestId,guestId))).for('update');
      if(!row)throw new NotFoundException('RESERVATION_NOT_FOUND');
      if(row.updatedAt.toISOString()!==dto.expectedUpdatedAt)throw new ConflictException('REVISION_CONFLICT');
      if(!['confirmed','assigned','checked_in','stayover'].includes(row.status))throw new ConflictException('TERMINAL_RESERVATION');
      let result:Record<string,unknown>;
      if(kind==='cancel') {
        if(!['confirmed','assigned'].includes(row.status))throw new ConflictException('CANCELLATION_REQUIRES_STAFF');
        const evaluation=await this.policy.evaluateCancellation({propertyId:dto.propertyId,ratePlanId:row.ratePlanId,
          arrivalDate:row.arrivalDate,totalAmount:row.totalAmount,nights:row.nights});
        await tx.update(reservations).set({status:'cancelled',cancellationReason:dto.reason??'Guest confirmed cancellation',
          cancelledAt:new Date(),updatedAt:new Date()}).where(and(eq(reservations.id,id),eq(reservations.propertyId,dto.propertyId)));
        const settlement=await this.settlement.settleFromEvaluation({propertyId:dto.propertyId,reservationId:id,
          currencyCode:row.currencyCode,evaluation},tx);
        result={status:'cancelled',settlement};
      } else {
        const quote=readQuote((dto as ConnectAmendV2Dto).acceptedQuote,this.config.get('CONNECT_QUOTE_SIGNING_SECRET',''));
        if(quote.propertyId!==dto.propertyId||quote.customerId!==dto.customerId||quote.roomTypeId!==row.roomTypeId||
          quote.ratePlanId!==row.ratePlanId||quote.adults!==row.adults||quote.children!==row.children)
          throw new ConflictException('QUOTE_SCOPE_MISMATCH');
        if(!row.acceptedPricingSnapshot||row.acceptedPricingSnapshot.services.length)throw new ConflictException('AMENDMENT_REQUIRES_STAFF');
        if(['checked_in','stayover'].includes(row.status)&&quote.checkIn!==row.arrivalDate)throw new ConflictException('ARRIVAL_ALREADY_STARTED');
        await this.reservationService.lockInventory(dto.propertyId,row.roomTypeId,tx);
        await this.rates.assertSellable(dto.propertyId,row.ratePlanId,quote.checkIn,quote.checkOut,tx);
        const nights=(Date.parse(quote.checkOut)-Date.parse(quote.checkIn))/86400000;
        const [plan]=await tx.select().from(ratePlans).where(and(eq(ratePlans.id,row.ratePlanId),eq(ratePlans.propertyId,dto.propertyId))).for('update');
        const price=await calculateCanonicalRoomPricing({propertyId:dto.propertyId,ratePlanId:row.ratePlanId,checkIn:quote.checkIn,checkOut:quote.checkOut,
          nights,isTaxInclusive:plan.isTaxInclusive,ratePlanService:this.rates,taxService:this.taxes,db:tx,lockForUpdate:true});
        if(fingerprint(price.lineItems)!==fingerprint(quote.lineItems)||price.totalAmount!==quote.totalAmount||price.currency!==quote.currency)
          throw new ConflictException('PRICE_CHANGED');
        const inventory=await this.availability.searchAvailability(dto.propertyId,quote.checkIn,quote.checkOut,row.roomTypeId,tx);
        if(inventory.length!==nights||inventory.some((night:any)=>night.available+(night.date>=row.arrivalDate&&night.date<row.departureDate?1:0)<1))
          throw new ConflictException('NO_AVAILABILITY');
        const accepted={...row.acceptedPricingSnapshot,source:'current' as const,currencyCode:price.currency,grandTotal:price.totalAmount,
          roomTotal:price.roomTotal,taxTotal:price.taxTotal,nights:price.lineItems.map(n=>({date:n.date,roomAmount:n.rate,taxAmount:n.tax})),
          adjustment:null,customReason:null};
        const linkedFolios=await tx.select().from(folios).where(and(eq(folios.propertyId,dto.propertyId),eq(folios.reservationId,id)));
        for(const folio of linkedFolios)await this.folioService.reconcileAcceptedStayAmendment({tx,propertyId:dto.propertyId,folioId:folio.id,
          reservationId:id,amendmentId:dto.idempotencyKey,previousPricing:row.acceptedPricingSnapshot,newPricing:accepted});
        await this.reservationService.modifyAcceptedStay(row,dto.propertyId,{arrivalDate:quote.checkIn,departureDate:quote.checkOut,totalAmount:price.totalAmount},accepted,tx);
        result={status:row.status,previousAmount:row.totalAmount,totalAmount:price.totalAmount,priceDelta:new Decimal(price.totalAmount).minus(row.totalAmount).toFixed(2)};
      }
      await tx.insert(connectOperations).values({propertyId:dto.propertyId,key:dto.idempotencyKey,customerId:dto.customerId,
        fingerprint:hash,entityType:'reservation',entityId:id,result});
    });
    return {reservationId:id,operationKey:dto.idempotencyKey,snapshot:await this.snapshot(dto.propertyId,'reservation',id,dto.customerId)};
  }
  serviceOptions(propertyId:string) {return this.serviceBookings.options(propertyId);}
  search(dto:AgentSearchDto) {
    if(!dto.propertyId)throw new BadRequestException('PROPERTY_REQUIRED');
    return this.searchService.search(dto);
  }
  serviceAvailability(dto:AgentServiceAvailabilityDto) {return this.serviceBookings.availability(dto);}
  async serviceBook(dto:AgentServiceBookDto) {
    if(dto.integrationContext?.sourceSystem!=='guestra_crm'||!dto.integrationContext.customerId||dto.expectedTotal==null)
      throw new BadRequestException('ACCEPTED_SERVICE_PRICE_AND_ORIGIN_REQUIRED');
    return this.serviceBookings.book(dto,'guestra_crm');
  }
  async serviceChange(id:string,dto:ConnectServiceChangeV2Dto) {
    await this.snapshot(dto.propertyId,'service_booking',id,dto.customerId);
    return this.serviceBookings.change(id,dto);
  }
  async serviceCancel(id:string,dto:ConnectServiceStatusV2Dto) {
    await this.snapshot(dto.propertyId,'service_booking',id,dto.customerId);
    return this.serviceBookings.transition(id,dto,'cancelled');
  }
  async guestRequest(dto:ConnectRequestV2Dto) {
    if(dto.integrationContext?.sourceSystem!=='guestra_crm'||!dto.integrationContext.customerId)throw new BadRequestException('INTEGRATION_CONTEXT_REQUIRED');
    const guestId=await this.identity(dto.propertyId,dto.integrationContext.customerId);
    if(dto.guestId&&dto.guestId!==guestId)throw new ConflictException('IDENTITY_CONFLICT');
    return this.requests.createFromAgent({...dto,guestId,integrationContext:{...dto.integrationContext}});
  }
}

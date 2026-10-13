import { Injectable, Inject, ForbiddenException, ServiceUnavailableException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and,eq } from 'drizzle-orm';
import { properties,integrationLinks,reservations,serviceBookings,serviceRequests,folios } from '@telivityhaip/database';
import { DRIZZLE } from '../../database/database.module';
import { PermissionsService } from '../auth/permissions.service';
import type { AuthUser } from '../auth/current-user.decorator';
import { ConnectV2Service } from './connect-v2.service';
type CrmReply = Record<string,unknown> & {contractVersion?:string;environment?:string;propertyId?:string;tenantId?:string;
  pmsPropertyId?:string;pmsTenantId?:string;customerId?:string};

@Injectable()
export class ConnectInboxService {
  constructor(@Inject(DRIZZLE) private readonly db:any,private readonly config:ConfigService,
    private readonly permissions:PermissionsService,private readonly operational:ConnectV2Service) {}
  private async authorize(propertyId:string,user:AuthUser|undefined) {
    if(this.config.get('GUESTRA_INBOX_ENABLED')!=='true')throw new ServiceUnavailableException('INBOX_DISABLED');
    // A demo or anonymous session can never spend a server's integration credential.
    if(!user?.sub)throw new ForbiddenException('AUTHENTICATED_STAFF_REQUIRED');
    const local=await this.permissions.findLocalUser(user.sub,user.email);
    const grants=local?await this.permissions.getEffectivePermissions(local.id,propertyId):[];
    if(!grants.includes('communications.manage'))throw new ForbiddenException('INBOX_SCOPE_DENIED');
    return {local,grants};
  }
  private async mapping(propertyId:string) {
    let configured:any;
    try {configured=JSON.parse(this.config.get('CRM_PROPERTY_MAPPINGS','[]')).find((m:any)=>m.pmsPropertyId===propertyId);}
    catch {throw new ServiceUnavailableException('INVALID_CRM_MAPPING_CONFIGURATION');}
    const [property]=await this.db.select().from(properties).where(eq(properties.id,propertyId));
    const environment=this.config.get('INTEGRATION_ENVIRONMENT','production');
    if(!property||!configured||configured.environment!==environment||
      configured.pmsTenantId!==(property.organizationId??property.id)||!configured.crmPropertyId||!configured.crmTenantId)
      throw new ForbiddenException('VERIFIED_PROPERTY_MAPPING_REQUIRED');
    return configured;
  }
  private async call(mapping:any,path:string,method='GET',body?:Record<string,unknown>) {
    const base=this.config.get<string>('CRM_AGENT_URL'),key=this.config.get<string>('CRM_AGENT_KEY');
    if(!base||!key)throw new ServiceUnavailableException('CRM_NOT_CONFIGURED');
    const url=new URL(base.replace(/\/$/,'')+'/'+path);
    if(url.username||url.password||(url.protocol!=='https:'&&!(mapping.environment==='test'&&
      url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname))))
      throw new ServiceUnavailableException('UNSAFE_CRM_URL');
    if(method==='GET')url.searchParams.set('propertyId',mapping.crmPropertyId);
    let response:Response;
    try {response=await fetch(url,{method,headers:{'Content-Type':'application/json','x-crm-api-key':key},
      ...(body?{body:JSON.stringify({...body,propertyId:mapping.crmPropertyId})}:{}),redirect:'error',signal:AbortSignal.timeout(10000)});}
    catch {throw new ServiceUnavailableException('CRM_UNAVAILABLE');}
    if(response.status===404)throw new NotFoundException('CONVERSATION_NOT_FOUND');
    if(!response.ok)throw new ServiceUnavailableException('CRM_READ_OR_ACTION_REJECTED');
    return await response.json() as CrmReply;
  }
  private async attest(mapping:any) {
    const capability=await this.call(mapping,'v2/capabilities');
    if(capability.contractVersion!=='guestra-crm-integration-v2'||capability.environment!==mapping.environment||capability.propertyId!==mapping.crmPropertyId||
      capability.tenantId!==mapping.crmTenantId||capability.pmsPropertyId!==mapping.pmsPropertyId||
      capability.pmsTenantId!==mapping.pmsTenantId)throw new ForbiddenException('CRM_ATTESTATION_FAILED');
  }
  async list(propertyId:string,user:AuthUser|undefined) {
    await this.authorize(propertyId,user);const mapping=await this.mapping(propertyId);await this.attest(mapping);
    return this.call(mapping,'v2/inbox');
  }
  async detail(propertyId:string,id:string,user:AuthUser|undefined) {
    const {grants}=await this.authorize(propertyId,user),mapping=await this.mapping(propertyId);await this.attest(mapping);
    const conversation=await this.call(mapping,'v2/inbox/'+encodeURIComponent(id));
    if(conversation.propertyId!==mapping.crmPropertyId||typeof conversation.customerId!=='string')throw new ForbiddenException('CONVERSATION_SCOPE_MISMATCH');
    const [link]=await this.db.select().from(integrationLinks).where(and(eq(integrationLinks.propertyId,propertyId),
      eq(integrationLinks.sourceSystem,'guestra_crm'),eq(integrationLinks.externalEntityType,'customer'),
      eq(integrationLinks.externalEntityId,conversation.customerId),eq(integrationLinks.localEntityType,'guest')));
    const context:Record<string,unknown>={verifiedGuest:false};
    if(link) {
      context['verifiedGuest']=true;context['guestId']=link.localEntityId;
      if(grants.includes('reservations.read'))context['reservations']=await this.db.select({id:reservations.id,status:reservations.status,
        arrivalDate:reservations.arrivalDate,departureDate:reservations.departureDate}).from(reservations)
        .where(and(eq(reservations.propertyId,propertyId),eq(reservations.guestId,link.localEntityId))).limit(50);
      if(grants.includes('services.read'))context['services']=await this.db.select({id:serviceBookings.id,status:serviceBookings.status,startAt:serviceBookings.startAt,endAt:serviceBookings.endAt})
        .from(serviceBookings).where(and(eq(serviceBookings.propertyId,propertyId),eq(serviceBookings.guestId,link.localEntityId))).limit(50);
      if(grants.includes('ops.read'))context['requests']=await this.db.select({id:serviceRequests.id,status:serviceRequests.status,title:serviceRequests.title})
        .from(serviceRequests).where(and(eq(serviceRequests.propertyId,propertyId),eq(serviceRequests.guestId,link.localEntityId))).limit(50);
      if(grants.includes('folios.read')) {
        const rows=await this.db.select({id:folios.id}).from(folios).where(and(eq(folios.propertyId,propertyId),eq(folios.guestId,link.localEntityId))).limit(20);
        context['folios']=[];
        for(const row of rows)(context['folios'] as unknown[]).push(await this.operational.snapshot(propertyId,'folio',row.id,conversation.customerId));
      }
    }
    return {...conversation,operationalContext:context};
  }
  async takeover(propertyId:string,id:string,user:AuthUser|undefined) {
    const {local}=await this.authorize(propertyId,user),mapping=await this.mapping(propertyId);await this.attest(mapping);
    return this.call(mapping,'v2/inbox/'+encodeURIComponent(id)+'/takeover','POST',{staffReference:'pms:'+local.id});
  }
}

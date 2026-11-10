import { ForbiddenException, Inject, Injectable, NotFoundException, ServiceUnavailableException, ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq } from 'drizzle-orm';
import { integrationLinks, properties } from '@telivityhaip/database';
import { DRIZZLE } from '../../database/database.module';

export interface CrmMapping {
  crmPropertyId: string; crmTenantId: string; pmsPropertyId: string; pmsTenantId: string; environment: string;
}
type CrmReply = Record<string, unknown>;

/** CRM error codes PMS staff can act on; anything else is reported as unavailable. */
const ACTIONABLE = new Set(['CONVERSATION_NOT_HUMAN_OWNED', 'DELIVERED_BY_PMS_REQUIRED', 'GUEST_HAS_NO_CHAT_ON_CHANNEL', 'GUEST_HAS_NO_EMAIL',
  'GUEST_HAS_NO_PHONE', 'GUEST_HAS_NO_AI_CHAT', 'AI_NOT_AVAILABLE_ON_CHANNEL', 'SIMULATOR_ONLY_IN_SANDBOX', 'CHANNEL_NOT_SUPPORTED',
  'CHANNEL_REQUIRED', 'DOCUMENT_CONFIRMATION_NOT_OPEN', 'IDEMPOTENCY_CONFLICT', 'DOCUMENT_URL_MUST_BE_HTTPS', 'VALIDATION_ERROR']);

/**
 * Server-side client of the CRM integration inbox (v2). The CRM is the single store of guest conversations;
 * PMS reads and writes them with its own scoped credential. The property mapping is verified on every call
 * (registry or static mapping, environment and tenant) and the CRM attests the same mapping back.
 */
@Injectable()
export class CrmInboxClient {
  constructor(@Inject(DRIZZLE) private readonly db: any, private readonly config: ConfigService) {}

  configured() {
    return this.config.get('GUESTRA_INBOX_ENABLED') === 'true' && !!this.config.get('CRM_AGENT_URL') && !!this.config.get('CRM_AGENT_KEY');
  }

  async mapping(propertyId: string): Promise<CrmMapping> {
    let configured: any;
    try {
      if (this.config.get('GUESTRA_REGISTRY_ENABLED') === 'true') {
        const [binding] = await this.db.select().from(integrationLinks).where(and(eq(integrationLinks.propertyId, propertyId),
          eq(integrationLinks.sourceSystem, 'guestra_crm'), eq(integrationLinks.localEntityType, 'property'), eq(integrationLinks.localEntityId, propertyId)));
        configured = binding?.metadata;
      }
      // The static mapping stays valid when the registry has no binding for this property yet.
      if (!configured) configured = JSON.parse(this.config.get('CRM_PROPERTY_MAPPINGS', '[]')).find((m: any) => m.pmsPropertyId === propertyId);
    } catch { throw new ServiceUnavailableException('INVALID_CRM_MAPPING_CONFIGURATION'); }
    const [property] = await this.db.select().from(properties).where(eq(properties.id, propertyId));
    const environment = this.config.get('INTEGRATION_ENVIRONMENT', 'production');
    if (!property || !configured || configured.environment !== environment ||
      configured.pmsTenantId !== (property.organizationId ?? property.id) || !configured.crmPropertyId || !configured.crmTenantId)
      throw new ForbiddenException('VERIFIED_PROPERTY_MAPPING_REQUIRED');
    return configured;
  }

  async call(mapping: CrmMapping, path: string, method = 'GET', body?: Record<string, unknown>, query: Record<string, string | undefined> = {}) {
    const base = this.config.get<string>('CRM_AGENT_URL'), key = this.config.get<string>('CRM_AGENT_KEY');
    if (!base || !key) throw new ServiceUnavailableException('CRM_NOT_CONFIGURED');
    const url = new URL(base.replace(/\/$/, '') + '/' + path);
    if (url.username || url.password || (url.protocol !== 'https:' && !(mapping.environment === 'test' &&
      url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))))
      throw new ServiceUnavailableException('UNSAFE_CRM_URL');
    if (method === 'GET') {
      url.searchParams.set('propertyId', mapping.crmPropertyId);
      for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') url.searchParams.set(k, v);
    }
    let response: Response;
    try {
      response = await fetch(url, { method, headers: { 'Content-Type': 'application/json', 'x-crm-api-key': key },
        ...(body ? { body: JSON.stringify({ ...body, propertyId: mapping.crmPropertyId }) } : {}), redirect: 'error', signal: AbortSignal.timeout(15000) });
    } catch { throw new ServiceUnavailableException('CRM_UNAVAILABLE'); }
    if (response.status === 404) throw new NotFoundException('CONVERSATION_NOT_FOUND');
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { code?: string };
      if (payload.code && ACTIONABLE.has(payload.code)) throw new ConflictException({ code: payload.code, message: payload.code });
      if (response.status === 403) throw new ForbiddenException(payload.code === 'SCOPE_DENIED' ? 'CRM_SCOPE_DENIED' : 'CRM_FORBIDDEN');
      throw new ServiceUnavailableException('CRM_READ_OR_ACTION_REJECTED');
    }
    return await response.json() as CrmReply;
  }

  async attest(mapping: CrmMapping) {
    const capability = await this.call(mapping, 'v2/capabilities');
    if (capability['contractVersion'] !== 'guestra-crm-integration-v2' || capability['environment'] !== mapping.environment ||
      capability['propertyId'] !== mapping.crmPropertyId || capability['tenantId'] !== mapping.crmTenantId ||
      capability['pmsPropertyId'] !== mapping.pmsPropertyId || capability['pmsTenantId'] !== mapping.pmsTenantId)
      throw new ForbiddenException('CRM_ATTESTATION_FAILED');
  }

  /** Mapping + attestation, then the call: the usual sequence for a staff action. */
  async verified(propertyId: string) {
    const mapping = await this.mapping(propertyId);
    await this.attest(mapping);
    return mapping;
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  ChannelAdapter,
  AvailabilityPushParams,
  RatePushParams,
  RestrictionPushParams,
  ContentPushParams,
  ReservationPullParams,
  ConfirmReservationParams,
  CancelReservationParams,
  ChannelSyncResult,
  ChannelReservationResult,
} from '../../channel-adapter.interface';
import { channelJsonRequest, type ChannelFetchFn } from '../channel-http.util';
import { CHANNEX_STAGING_BASE_URL, DEFAULT_CHANNEX_CONFIG, type ChannexConfig } from './channex.config';
import {
  extractChannexTaskIds,
  mapAvailabilityToChannex,
  mapChannexRevisionToHaip,
  mapRatesToChannex,
  mapRestrictionsToChannex,
} from './channex.mapper';

const unavailable = 'Channex configuration is missing or outside the permitted environment';

/**
 * Channex channel manager — ARI push via /availability and /restrictions,
 * booking pull via booking_revisions/feed, ACK via booking_revisions/{id}/ack.
 *
 * Env: CHANNEX_API_KEY, CHANNEX_PROPERTY_ID, optional CHANNEX_BASE_URL
 * (staging: https://staging.channex.io/api/v1).
 * Connection config may override apiKey, propertyId, hotelId, baseUrl.
 *
 * Certification hardening: 429/5xx retry+backoff, ~20 ARI req/min pacing,
 * task id capture, date-range collapse in mappers.
 */
@Injectable()
export class ChannexAdapter implements ChannelAdapter {
  readonly adapterType = 'channex';
  private readonly logger = new Logger(ChannexAdapter.name);
  private readonly fetchFn: ChannelFetchFn = fetch;
  /** Sliding window of outbound ARI request timestamps (rate limit ≈ 20/min). */
  private readonly ariRequestTimes: number[] = [];

  constructor(private readonly configService: ConfigService) {}

  private resolveConfig(connectionConfig?: Record<string, unknown>): ChannexConfig | null {
    const value = (key: string) => {
      const entry = connectionConfig?.[key];
      return typeof entry === 'string' ? entry.trim() : undefined;
    };
    const stagingOnly = this.configService.get<string>('CHANNEX_STAGING_ONLY') === 'true' ||
      this.configService.get<string>('NODE_ENV') === 'staging';
    const allowedProperty = this.configService.get<string>('CHANNEX_PROPERTY_ID')?.trim();
    const envKey = this.configService.get<string>('CHANNEX_API_KEY')?.trim();
    const apiKey = stagingOnly ? envKey : value('apiKey') || envKey;
    const propertyId = value('propertyId') || value('hotelId') || allowedProperty;
    if (!apiKey || !propertyId) return null;

    const baseUrl = (
      value('baseUrl') ||
      this.configService.get<string>('CHANNEX_BASE_URL')?.trim() ||
      (stagingOnly ? CHANNEX_STAGING_BASE_URL : DEFAULT_CHANNEX_CONFIG.baseUrl)
    ).replace(/\/$/, '');
    if (stagingOnly && (baseUrl !== CHANNEX_STAGING_BASE_URL || propertyId !== allowedProperty)) return null;

    return {
      apiKey,
      propertyId,
      baseUrl,
      timeoutMs: DEFAULT_CHANNEX_CONFIG.timeoutMs,
      maxRetries: DEFAULT_CHANNEX_CONFIG.maxRetries,
      ariRateLimitPerMinute: DEFAULT_CHANNEX_CONFIG.ariRateLimitPerMinute,
    };
  }

  private failed(item: string, message = unavailable): ChannelSyncResult {
    return { success: false, itemsSynced: 0, errors: [{ item, message }] };
  }

  private headers(apiKey: string): Record<string, string> {
    return {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'user-api-key': apiKey,
    };
  }

  private async paceAriRequest(config: ChannexConfig): Promise<void> {
    const limit = config.ariRateLimitPerMinute ?? 20;
    const now = Date.now();
    while (this.ariRequestTimes.length > 0 && now - this.ariRequestTimes[0]! >= 60_000) {
      this.ariRequestTimes.shift();
    }
    if (this.ariRequestTimes.length >= limit) {
      const waitMs = 60_000 - (now - this.ariRequestTimes[0]!) + 25;
      this.logger.warn(`Channex ARI rate limit — waiting ${waitMs}ms`);
      await new Promise((r) => setTimeout(r, Math.max(waitMs, 50)));
    }
    this.ariRequestTimes.push(Date.now());
  }

  private async postValues(
    config: ChannexConfig,
    path: string,
    values: Array<Record<string, unknown>>,
    itemLabel: string,
  ): Promise<ChannelSyncResult> {
    if (values.length === 0) {
      return { success: true, itemsSynced: 0, errors: [], taskIds: [] };
    }

    await this.paceAriRequest(config);

    const url = `${config.baseUrl}/${path}`;
    const maxRetries = config.maxRetries ?? 3;
    let lastError = 'Request failed';

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const res = await channelJsonRequest<{ data?: unknown; meta?: { warnings?: unknown[] } }>(
        url,
        {
          method: 'POST',
          headers: this.headers(config.apiKey),
          body: JSON.stringify({ values }),
          signal: AbortSignal.timeout(config.timeoutMs ?? 30_000),
        },
        this.fetchFn,
      );

      if (res.ok) {
        const taskIds = extractChannexTaskIds(res.data);
        const warnings = res.data?.meta?.warnings;
        if (Array.isArray(warnings) && warnings.length > 0) {
          this.logger.warn(`Channex ${path}: ${warnings.length} warning(s)`);
          return { ...this.failed(itemLabel, 'Channex returned ARI warnings'), taskIds };
        }
        this.logger.log(`Channex ${path}: ${values.length} value(s), taskIds=${taskIds.join(',') || 'none'}`);
        return { success: true, itemsSynced: values.length, errors: [], taskIds };
      }

      lastError = res.status ? `Channex HTTP ${res.status}` : 'Channex transport failure';
      const retryable = res.status === 429 || res.status >= 500 || res.status === 0;
      if (!retryable || attempt === maxRetries || (res.retryAfterMs ?? 0) > 30_000) {
        return {
          success: false,
          itemsSynced: 0,
          errors: [{ item: itemLabel, message: lastError }],
          taskIds: [],
          retryAfterMs: res.retryAfterMs,
        };
      }

      const retryDelay =
        res.status === 429
          ? Math.min(2_000 * attempt, 15_000)
          : Math.min(500 * 2 ** (attempt - 1), 8_000);
      const backoffMs = Math.max(retryDelay, res.retryAfterMs ?? 0);
      this.logger.warn(
        `Channex ${path} failed (${lastError}) attempt ${attempt}/${maxRetries}; retry in ${backoffMs}ms`,
      );
      await new Promise((r) => setTimeout(r, backoffMs));
    }

    return {
      success: false,
      itemsSynced: 0,
      errors: [{ item: itemLabel, message: lastError }],
      taskIds: [],
    };
  }

  async pushAvailability(params: AvailabilityPushParams): Promise<ChannelSyncResult> {
    const config = this.resolveConfig(params.connectionConfig);
    if (!config) return this.failed('availability');
    const values = mapAvailabilityToChannex(config.propertyId, params.items);
    return this.postValues(config, 'availability', values, 'availability');
  }

  async pushRates(params: RatePushParams): Promise<ChannelSyncResult> {
    const config = this.resolveConfig(params.connectionConfig);
    if (!config) return this.failed('rate');
    const values = mapRatesToChannex(config.propertyId, params.items);
    return this.postValues(config, 'restrictions', values, 'rate');
  }

  async pushRestrictions(params: RestrictionPushParams): Promise<ChannelSyncResult> {
    const config = this.resolveConfig(params.connectionConfig);
    if (!config) return this.failed('restrictions');
    const values = mapRestrictionsToChannex(config.propertyId, params.items);
    return this.postValues(config, 'restrictions', values, 'restrictions');
  }

  /** Channex property/room content is managed in Channex UI. */
  async pushContent(params: ContentPushParams): Promise<ChannelSyncResult> {
    const config = this.resolveConfig(params.connectionConfig);
    if (!config) return this.failed('content');
    return this.failed('content', 'Manage property and room content in Channex');
  }

  async pullReservations(params: ReservationPullParams): Promise<ChannelReservationResult> {
    const config = this.resolveConfig(params.connectionConfig);
    if (!config) {
      return { success: false, reservations: [], errors: [{ externalId: '', message: unavailable }] };
    }

    if (params.externalRevisionId) {
      const revisionId = params.externalRevisionId;
      const res = await channelJsonRequest<{ data?: Record<string, unknown> }>(
        `${config.baseUrl}/booking_revisions/${encodeURIComponent(revisionId)}`,
        {
          method: 'GET',
          headers: this.headers(config.apiKey),
          signal: AbortSignal.timeout(config.timeoutMs ?? 30_000),
        },
        this.fetchFn,
      );
      const revision = res.ok && res.data?.data ? mapChannexRevisionToHaip(res.data.data, config.propertyId) : null;
      if (revision?.externalRevisionId === revisionId) return { success: true, reservations: [revision], errors: [] };
      return {
        success: false, reservations: [],
        errors: [{ externalId: revisionId, message: `Channex revision verification failed (HTTP ${res.status})` }],
      };
    }

    const query = new URLSearchParams({
      'filter[property_id]': config.propertyId,
      'order[inserted_at]': 'asc',
    });
    const result: ChannelReservationResult = { success: true, reservations: [], errors: [] };
    query.set('pagination[limit]', '100');
    for (let page = 1; page <= 20; page++) {
      query.set('pagination[page]', String(page));
      const res = await channelJsonRequest<{
        data?: Array<Record<string, unknown>>;
        meta?: { total?: number; limit?: number };
      }>(
        `${config.baseUrl}/booking_revisions/feed?${query}`,
        {
          method: 'GET',
          headers: this.headers(config.apiKey),
          signal: AbortSignal.timeout(config.timeoutMs ?? 30_000),
        },
        this.fetchFn,
      );
      const rows = res.data?.data;
      if (!res.ok || !Array.isArray(rows)) {
        result.errors.push({ externalId: '', message: `Channex feed failed (HTTP ${res.status})` });
        break;
      }
      for (const row of rows) {
        const reservation = mapChannexRevisionToHaip(row, config.propertyId);
        if (reservation) result.reservations.push(reservation);
        else result.errors.push({ externalId: '', message: 'Channex feed contains an invalid or unsupported revision' });
      }
      const limit = res.data?.meta?.limit ?? 100;
      const total = res.data?.meta?.total;
      if (rows.length === 0 || (total !== undefined ? page * limit >= total : rows.length < limit)) break;
      if (page === 20) result.errors.push({ externalId: '', message: 'Channex feed page limit reached' });
    }
    result.success = result.errors.length === 0;
    return result;
  }

  async confirmReservation(params: ConfirmReservationParams): Promise<ChannelSyncResult> {
    const config = this.resolveConfig(params.connectionConfig);
    if (!config) return this.failed('ack');

    // ACK the revision id (not the stable booking id).
    const revisionId = params.externalRevisionId;
    if (!revisionId) return this.failed('ack', 'Channex revision ID is required');
    const url = `${config.baseUrl}/booking_revisions/${encodeURIComponent(revisionId)}/ack`;
    const res = await channelJsonRequest(
      url,
      {
        method: 'POST',
        headers: this.headers(config.apiKey),
        body: '{}',
        signal: AbortSignal.timeout(config.timeoutMs ?? 30_000),
      },
      this.fetchFn,
    );

    if (!res.ok) {
      return {
        success: false,
        itemsSynced: 0,
        errors: [{ item: 'ack', message: `Channex ACK failed (HTTP ${res.status})` }],
        retryAfterMs: res.retryAfterMs,
      };
    }
    return { success: true, itemsSynced: 1, errors: [] };
  }

  async cancelReservation(params: CancelReservationParams): Promise<ChannelSyncResult> {
    const config = this.resolveConfig(params.connectionConfig);
    if (!config) return this.failed('cancel');
    return this.failed('cancel', 'Cancel on the OTA and receive its Channex revision');
  }

  async testConnection(config: Record<string, unknown>): Promise<{ connected: boolean; message: string }> {
    const resolved = this.resolveConfig(config);
    if (!resolved) return { connected: false, message: unavailable };

    const url = `${resolved.baseUrl}/properties/${encodeURIComponent(resolved.propertyId)}`;
    const res = await channelJsonRequest<{ data?: { id?: string } }>(
      url,
      {
        method: 'GET',
        headers: this.headers(resolved.apiKey),
        signal: AbortSignal.timeout(resolved.timeoutMs ?? 30_000),
      },
      this.fetchFn,
    );

    if (!res.ok || res.data?.data?.id !== resolved.propertyId) {
      return { connected: false, message: `Channex property verification failed (HTTP ${res.status})` };
    }
    return { connected: true, message: `Channex property reachable (${resolved.baseUrl})` };
  }
}

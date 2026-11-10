import { Injectable, Inject, Optional, NotFoundException, BadRequestException } from '@nestjs/common';
import { eq, inArray, sql } from 'drizzle-orm';
import { properties, media } from '@telivityhaip/database';
import { DRIZZLE } from '../../database/database.module';
import { WebhookService } from '../webhook/webhook.service';
import { CreatePropertyDto } from './dto/create-property.dto';
import { UpdatePropertyDto } from './dto/update-property.dto';
import type { BookingPolicyDto } from './dto/booking-policy.dto';
import { normaliseBands } from '../rate-plan/child-pricing';
import { BOOKING_POLICY_DEFAULTS } from '../reservation/guarantee';

type PropertyRow = Record<string, unknown> & {
  id: string;
  staffLogoMediaId?: string | null;
};

@Injectable()
export class PropertyService {
  constructor(
    @Inject(DRIZZLE) private readonly db: any,
    @Optional() private readonly webhookService?: WebhookService,
  ) {}

  async create(dto: CreatePropertyDto) {
    const [property] = await this.db
      .insert(properties)
      .values(dto)
      .returning();
    return this.withLogoUrl(property as PropertyRow);
  }

  async findAll(): Promise<(PropertyRow & { staffLogoUrl: string | null })[]> {
    const rows = (await this.db
      .select()
      .from(properties)
      .where(eq(properties.isActive, true))) as PropertyRow[];
    return this.attachLogoUrls(rows);
  }

  async findById(id: string) {
    const [property] = await this.db
      .select()
      .from(properties)
      .where(eq(properties.id, id));
    if (!property) {
      throw new NotFoundException(`Property ${id} not found`);
    }
    return this.withLogoUrl(property as PropertyRow);
  }

  async update(id: string, dto: UpdatePropertyDto) {
    const [property] = await this.db
      .update(properties)
      .set({ ...dto, updatedAt: new Date() })
      .where(eq(properties.id, id))
      .returning();
    if (!property) {
      throw new NotFoundException(`Property ${id} not found`);
    }
    await this.webhookService?.emit(
      'property.content_updated',
      'property',
      id,
      { propertyId: id },
      id,
    );
    return this.withLogoUrl(property as PropertyRow);
  }

  /** Booking policy with effective defaults (bands fall back to the defaults when not configured). */
  async bookingPolicy(id: string) {
    const [row] = await this.db.select({ settings: properties.settings }).from(properties).where(eq(properties.id, id));
    if (!row) throw new NotFoundException(`Property ${id} not found`);
    const settings = row.settings ?? {};
    return {
      childAgeBands: normaliseBands(settings.childAgeBands),
      childAgeBandsConfigured: Array.isArray(settings.childAgeBands) && settings.childAgeBands.length > 0,
      optionHoldHours: settings.optionHoldHours ?? null,
      // Effective values: the hotel's own choice, else the platform defaults (50% prepayment, remind on expiry).
      optionExpiryAction: settings.optionExpiryAction ?? BOOKING_POLICY_DEFAULTS.optionExpiryAction,
      depositPercentage: settings.depositPercentage ?? BOOKING_POLICY_DEFAULTS.depositPercentage,
      defaults: BOOKING_POLICY_DEFAULTS,
      autoSendConfirmation: settings.autoSendConfirmation ?? true,
    };
  }

  /** Validates and merges the booking policy into settings in one statement, keeping every other setting. */
  async updateBookingPolicy(id: string, dto: BookingPolicyDto) {
    if (dto.childAgeBands) {
      const bands = [...dto.childAgeBands].sort((a, b) => a.minAge - b.minAge);
      if (new Set(bands.map((b) => b.code)).size !== bands.length) throw new BadRequestException('Age band codes must be unique');
      for (const [i, band] of bands.entries()) {
        if (band.maxAge < band.minAge) throw new BadRequestException(`Age band ${band.code}: maxAge must not be below minAge`);
        if (i > 0 && band.minAge <= bands[i - 1]!.maxAge) throw new BadRequestException('Age bands must not overlap');
      }
    }
    const patch: Record<string, unknown> = {};
    const remove: string[] = [];
    for (const key of ['childAgeBands', 'optionHoldHours', 'optionExpiryAction', 'depositPercentage', 'autoSendConfirmation'] as const) {
      if (dto[key] === undefined) continue;
      if (dto[key] === null) remove.push(key);
      else patch[key] = key === 'childAgeBands' ? [...dto.childAgeBands!].sort((a, b) => a.minAge - b.minAge) : dto[key];
    }
    // Single-statement merge so a concurrent settings change elsewhere is not overwritten.
    let merged = sql`coalesce(${properties.settings}, '{}'::jsonb)`;
    for (const key of remove) merged = sql`(${merged} - ${key}::text)`;
    const [updated] = await this.db.update(properties)
      .set({ settings: sql`${merged} || ${JSON.stringify(patch)}::jsonb`, updatedAt: new Date() })
      .where(eq(properties.id, id)).returning({ id: properties.id });
    if (!updated) throw new NotFoundException(`Property ${id} not found`);
    return this.bookingPolicy(id);
  }

  private async withLogoUrl(property: PropertyRow) {
    const [enriched] = await this.attachLogoUrls([property]);
    return enriched!;
  }

  private async attachLogoUrls(rows: PropertyRow[]) {
    const logoIds = rows
      .map((r) => r['staffLogoMediaId'] as string | null | undefined)
      .filter((id): id is string => !!id);
    if (!logoIds.length) {
      return rows.map((r) => ({ ...r, staffLogoUrl: null as string | null }));
    }
    const mediaRows = await this.db
      .select({ id: media.id, url: media.url })
      .from(media)
      .where(inArray(media.id, logoIds));
    const urlById = new Map<string, string>(
      mediaRows.map((m: { id: string; url: string }) => [m.id, m.url]),
    );
    return rows.map((r) => {
      const logoId = r['staffLogoMediaId'] as string | null | undefined;
      const url: string | null = logoId ? (urlById.get(logoId) ?? null) : null;
      return {
        ...r,
        staffLogoUrl: url,
      };
    });
  }
}

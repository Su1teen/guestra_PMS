import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import Decimal from 'decimal.js';
import { auditLogs, reservations } from '@telivityhaip/database';
import { DRIZZLE } from '../../database/database.module';
import { actorFields, type AuditActor } from '../../common/audit/audit-actor';
import { RevenueAllocationService } from './revenue-allocation.service';

export const PRICE_TYPES = ['standard', 'complimentary', 'barter', 'chef', 'marketing'] as const;
export type PriceType = (typeof PRICE_TYPES)[number];
/** Price types that never earn a manager commission (R7). */
export const NO_COMMISSION_PRICE_TYPES: readonly string[] = ['complimentary', 'barter', 'chef'];
/** Price types whose revenue is zero by definition; nights and cost still count. */
export const ZERO_REVENUE_PRICE_TYPES: readonly string[] = ['complimentary', 'barter'];
export const CLOSED_STATUSES = ['checked_out', 'cancelled', 'no_show'];

const PRICE_TYPE_LABEL: Record<PriceType, string> = { standard: 'Стандартная цена', complimentary: 'Комплиментарное', barter: 'Бартер', chef: 'Для шефа', marketing: 'Маркетинг' };

export interface PriceTypeInput { priceType: string; reason: string; counterparty?: string | null }
export interface ClosedCorrectionInput { reason: string; totalAmount?: string; adults?: number; children?: number; specialRequests?: string | null }

/**
 * Decisions only a person with a dedicated right takes: the price type of a stay (complimentary, barter, chef,
 * marketing) and corrections of a closed stay. Each one keeps the reason, who decided and the before / after values.
 */
@Injectable()
export class ReservationAdjustmentsService {
  constructor(@Inject(DRIZZLE) private readonly db: any, private readonly allocations: RevenueAllocationService) {}

  private async stay(tx: any, id: string, propertyId: string) {
    const [row] = await tx.select().from(reservations).where(and(eq(reservations.id, id), eq(reservations.propertyId, propertyId))).for('update');
    if (!row) throw new NotFoundException('Reservation not found');
    return row;
  }

  async setPriceType(id: string, propertyId: string, input: PriceTypeInput, actor?: AuditActor) {
    if (!PRICE_TYPES.includes(input.priceType as PriceType)) throw new BadRequestException('Unknown price type');
    const reason = String(input.reason ?? '').trim();
    if (reason.length < 3) throw new BadRequestException('A reason is required');
    const counterparty = input.counterparty?.trim() || null;
    if (input.priceType === 'barter' && !counterparty) throw new BadRequestException('A barter needs the counterparty');
    return this.db.transaction(async (tx: any) => {
      const before = await this.stay(tx, id, propertyId);
      const standard = input.priceType === 'standard';
      const [row] = await tx.update(reservations).set({ priceType: input.priceType, priceTypeReason: standard ? null : reason, priceTypeCounterparty: standard ? null : counterparty,
        priceTypeApprovedBy: standard ? null : actor?.userId ?? null, priceTypeSetAt: new Date(), updatedAt: new Date() })
        .where(and(eq(reservations.id, id), eq(reservations.propertyId, propertyId))).returning();
      await tx.insert(auditLogs).values({ propertyId, entityType: 'reservation', entityId: id, action: 'price_type_set', ...actorFields(actor),
        previousValue: { priceType: before.priceType, reason: before.priceTypeReason, counterparty: before.priceTypeCounterparty },
        newValue: { priceType: row.priceType, reason, counterparty }, description: `${PRICE_TYPE_LABEL[input.priceType as PriceType]}: ${reason}` });
      return row;
    });
  }

  /** A checked-out, cancelled or no-show stay is changed only here: limited fields, a reason and an audit row. */
  async correctClosed(id: string, propertyId: string, input: ClosedCorrectionInput, actor?: AuditActor) {
    const reason = String(input.reason ?? '').trim();
    if (reason.length < 3) throw new BadRequestException('A reason is required');
    const patch: Record<string, unknown> = {};
    if (input.totalAmount !== undefined) {
      if (!/^\d+(\.\d{1,2})?$/.test(String(input.totalAmount))) throw new BadRequestException('Invalid total amount');
      patch['totalAmount'] = new Decimal(input.totalAmount).toFixed(2);
    }
    if (input.adults !== undefined) { if (!Number.isInteger(input.adults) || input.adults < 1) throw new BadRequestException('Invalid adults'); patch['adults'] = input.adults; }
    if (input.children !== undefined) { if (!Number.isInteger(input.children) || input.children < 0) throw new BadRequestException('Invalid children'); patch['children'] = input.children; }
    if (input.specialRequests !== undefined) patch['specialRequests'] = input.specialRequests;
    if (!Object.keys(patch).length) throw new BadRequestException('Nothing to correct');
    const row = await this.db.transaction(async (tx: any) => {
      const before = await this.stay(tx, id, propertyId);
      if (!CLOSED_STATUSES.includes(before.status)) throw new BadRequestException('Only a checked-out, cancelled or no-show reservation is corrected here; use the normal change');
      const [updated] = await tx.update(reservations).set({ ...patch, updatedAt: new Date() })
        .where(and(eq(reservations.id, id), eq(reservations.propertyId, propertyId))).returning();
      await tx.insert(auditLogs).values({ propertyId, entityType: 'reservation', entityId: id, action: 'closed_corrected', ...actorFields(actor),
        previousValue: Object.fromEntries(Object.keys(patch).map((k) => [k, before[k]])), newValue: patch, description: `Исправление закрытой брони: ${reason}` });
      return updated;
    });
    // A split already recorded gets correcting rows; past rows are never rewritten.
    await this.allocations.onModified({ propertyId, entityId: id, entityType: 'reservation' } as any);
    return row;
  }
}

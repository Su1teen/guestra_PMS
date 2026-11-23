import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { and, eq, inArray } from 'drizzle-orm';
import Decimal from 'decimal.js';
import { properties, ratePlanComponents, reservationRevenueAllocations, reservations, services } from '@telivityhaip/database';
import { DRIZZLE } from '../../database/database.module';
import type { WebhookPayload } from '../webhook/webhook.service';

export type AllocationBasis = 'per_guest_per_night' | 'per_guest_per_stay' | 'per_stay' | 'per_night';
export type RevenueCategory = 'accommodation' | 'fnb' | 'bath' | 'spa' | 'other';

export interface AllocationLine {
  category: RevenueCategory;
  componentId: string | null;
  description: string;
  quantity: number;
  amount: string;
  cost: string;
}

interface StayFacts { totalAmount: string; nights: number; adults: number; children: number; childAges: number[] | null }
interface ComponentFacts {
  id: string; quantity: number; includedInRate: boolean; basis: AllocationBasis | null; allocationAmount: string | null;
  amountOverride: string | null; unitCost: string | null; revenueCategory: Exclude<RevenueCategory, 'accommodation'> | null;
  service: { name: string; price: string; chargeType: string };
}

const CATEGORY_BY_CHARGE: Record<string, Exclude<RevenueCategory, 'accommodation'>> = { food_beverage: 'fnb', minibar: 'fnb', spa: 'spa' };
/** Categories the split is made of; penalty and refund rows are money events, not part of the price. */
const PRICE_CATEGORIES = ['accommodation', 'fnb', 'bath', 'spa', 'other'];

/**
 * Splits a package price into accommodation, food and other included components for reports, with the
 * hotel's cost of each. Accommodation is the package price minus the included components, so the split
 * always adds up to the price. The split is saved when the booking is confirmed; later changes to guests
 * or dates add correcting rows and never rewrite the saved ones.
 */
@Injectable()
export class RevenueAllocationService {
  private readonly logger = new Logger(RevenueAllocationService.name);

  constructor(@Inject(DRIZZLE) private readonly db: any) {}

  /** Guests a per-guest component is counted for: adults plus children from the property's age (unknown age counts). */
  static countedGuests(stay: Pick<StayFacts, 'adults' | 'children' | 'childAges'>, childFromAge: number | null | undefined) {
    if (childFromAge == null) return stay.adults + stay.children;
    const ages = stay.childAges ?? [];
    const free = ages.filter((age) => age < childFromAge).length;
    return stay.adults + Math.max(0, stay.children - free);
  }

  /** Pure split of one stay. Returns null when the included components cost more than the stay itself. */
  static compute(stay: StayFacts, components: ComponentFacts[], childFromAge: number | null | undefined): AllocationLine[] | null {
    const guests = RevenueAllocationService.countedGuests(stay, childFromAge);
    const nights = Math.max(1, stay.nights);
    const lines: AllocationLine[] = [];
    for (const component of components.filter((c) => c.includedInRate)) {
      const per = component.basis === 'per_guest_per_night' ? guests * nights : component.basis === 'per_guest_per_stay' ? guests
        : component.basis === 'per_night' ? nights : 1;
      const quantity = per * Math.max(1, component.quantity ?? 1);
      const unit = new Decimal(component.allocationAmount ?? component.amountOverride ?? component.service.price ?? 0);
      if (quantity <= 0 || unit.isZero()) continue;
      lines.push({ category: component.revenueCategory ?? CATEGORY_BY_CHARGE[component.service.chargeType] ?? 'other', componentId: component.id,
        description: component.service.name, quantity, amount: unit.times(quantity).toFixed(2),
        cost: new Decimal(component.unitCost ?? 0).times(quantity).toFixed(2) });
    }
    const included = lines.reduce((sum, line) => sum.plus(line.amount), new Decimal(0));
    const accommodation = new Decimal(stay.totalAmount).minus(included);
    if (accommodation.isNegative()) return null;
    return [{ category: 'accommodation', componentId: null, description: 'Проживание', quantity: nights, amount: accommodation.toFixed(2), cost: '0.00' }, ...lines];
  }

  private async facts(reservationId: string, propertyId: string) {
    const [row] = await this.db.select().from(reservations)
      .where(and(eq(reservations.id, reservationId), eq(reservations.propertyId, propertyId)));
    if (!row) throw new NotFoundException(`Reservation ${reservationId} not found`);
    const [property] = await this.db.select({ settings: properties.settings }).from(properties).where(eq(properties.id, propertyId));
    const componentRows = await this.db.select({ component: ratePlanComponents, service: services }).from(ratePlanComponents)
      .innerJoin(services, and(eq(services.id, ratePlanComponents.serviceId), eq(services.propertyId, propertyId)))
      .where(and(eq(ratePlanComponents.propertyId, propertyId), eq(ratePlanComponents.ratePlanId, row.ratePlanId)));
    const components: ComponentFacts[] = componentRows.map(({ component, service }: any) => ({ ...component, service }));
    return { row, components, childFromAge: property?.settings?.packageChildFromAge ?? null };
  }

  /** Split the stay would have now, without saving it. */
  async preview(reservationId: string, propertyId: string) {
    const { row, components, childFromAge } = await this.facts(reservationId, propertyId);
    return { reservationId, currencyCode: row.currencyCode, lines: RevenueAllocationService.compute(row, components, childFromAge) };
  }

  /** Saved rows and the net split per category (snapshot plus corrections), with penalties and refunds. */
  async current(reservationId: string, propertyId: string) {
    const rows = await this.db.select().from(reservationRevenueAllocations)
      .where(and(eq(reservationRevenueAllocations.propertyId, propertyId), eq(reservationRevenueAllocations.reservationId, reservationId)))
      .orderBy(reservationRevenueAllocations.createdAt);
    const totals: Record<string, { amount: string; cost: string }> = {};
    for (const row of rows) {
      const t = totals[row.category] ?? { amount: '0.00', cost: '0.00' };
      totals[row.category] = { amount: new Decimal(t.amount).plus(row.amount).toFixed(2), cost: new Decimal(t.cost).plus(row.cost).toFixed(2) };
    }
    return { reservationId, rows, totals };
  }

  /**
   * Saves the split, or the correction to bring the saved split to the current one. Idempotent: running it
   * again without a change adds nothing.
   */
  async sync(reservationId: string, propertyId: string, reason: string, actorId?: string | null) {
    const { row, components, childFromAge } = await this.facts(reservationId, propertyId);
    const lines = RevenueAllocationService.compute(row, components, childFromAge);
    if (!lines) {
      this.logger.warn(`Package components of ${reservationId} exceed the stay total; split not saved`);
      return { saved: 0, error: 'COMPONENTS_EXCEED_TOTAL' as const };
    }
    return this.db.transaction(async (tx: any) => {
      await tx.select({ id: reservations.id }).from(reservations)
        .where(and(eq(reservations.id, reservationId), eq(reservations.propertyId, propertyId))).for('update');
      const existing = await tx.select().from(reservationRevenueAllocations)
        .where(and(eq(reservationRevenueAllocations.propertyId, propertyId), eq(reservationRevenueAllocations.reservationId, reservationId),
          inArray(reservationRevenueAllocations.category, PRICE_CATEGORIES)));
      const key = (category: string, componentId: string | null) => `${category}:${componentId ?? ''}`;
      const saved = new Map<string, { amount: Decimal; cost: Decimal; quantity: number; description: string; category: string; componentId: string | null }>();
      for (const r of existing) {
        const k = key(r.category, r.componentId);
        const s = saved.get(k) ?? { amount: new Decimal(0), cost: new Decimal(0), quantity: 0, description: r.description, category: r.category, componentId: r.componentId };
        s.amount = s.amount.plus(r.amount); s.cost = s.cost.plus(r.cost); s.quantity += r.quantity;
        saved.set(k, s);
      }
      const kind = existing.length ? 'adjustment' : 'snapshot';
      const inserts: any[] = [];
      const seen = new Set<string>();
      for (const line of lines) {
        const k = key(line.category, line.componentId); seen.add(k);
        const before = saved.get(k);
        const amount = new Decimal(line.amount).minus(before?.amount ?? 0);
        const cost = new Decimal(line.cost).minus(before?.cost ?? 0);
        const quantity = line.quantity - (before?.quantity ?? 0);
        if (amount.isZero() && cost.isZero() && quantity === 0) continue;
        inserts.push({ ...line, amount: amount.toFixed(2), cost: cost.toFixed(2), quantity });
      }
      for (const [k, before] of saved) {
        if (seen.has(k) || (before.amount.isZero() && before.cost.isZero() && before.quantity === 0)) continue;
        inserts.push({ category: before.category, componentId: before.componentId, description: before.description,
          quantity: -before.quantity, amount: before.amount.negated().toFixed(2), cost: before.cost.negated().toFixed(2) });
      }
      if (!inserts.length) return { saved: 0 };
      await tx.insert(reservationRevenueAllocations).values(inserts.map((line) => ({ ...line, propertyId, reservationId, kind,
        currencyCode: row.currencyCode, reason: kind === 'snapshot' ? null : reason, actorId: actorId ?? null })));
      return { saved: inserts.length, kind };
    });
  }

  @OnEvent('reservation.confirmed')
  @OnEvent('reservation.created')
  async onConfirmed(payload: WebhookPayload) {
    if (!payload?.propertyId || !payload.entityId || payload.entityType !== 'reservation') return;
    await this.safely(async () => {
      const [row] = await this.db.select({ status: reservations.status }).from(reservations)
        .where(and(eq(reservations.id, payload.entityId), eq(reservations.propertyId, payload.propertyId!)));
      if (row && ['confirmed', 'assigned', 'checked_in', 'stayover', 'due_out'].includes(row.status)) {
        await this.sync(payload.entityId, payload.propertyId!, 'Бронь подтверждена');
      }
    });
  }

  @OnEvent('reservation.modified')
  async onModified(payload: WebhookPayload) {
    if (!payload?.propertyId || !payload.entityId) return;
    await this.safely(async () => {
      const [saved] = await this.db.select({ id: reservationRevenueAllocations.id }).from(reservationRevenueAllocations)
        .where(and(eq(reservationRevenueAllocations.propertyId, payload.propertyId!), eq(reservationRevenueAllocations.reservationId, payload.entityId))).limit(1);
      // Only a confirmed (already split) stay is corrected; a tentative one is split when it is confirmed.
      if (saved) await this.sync(payload.entityId, payload.propertyId!, 'Изменены гости или даты');
    });
  }

  private async safely(work: () => Promise<void>) {
    try { await work(); } catch (error) {
      this.logger.error(`Revenue split failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

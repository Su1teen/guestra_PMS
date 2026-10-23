import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, forwardRef } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import Decimal from 'decimal.js';
import { auditLogs, folios, properties, ratePlans, reservations, roomTypes, rooms, type AcceptedPricingSnapshot } from '@telivityhaip/database';
import { actorFields, type AuditActor } from '@telivityhaip/shared';
import { DRIZZLE } from '../../database/database.module';
import { RatePlanService } from '../rate-plan/rate-plan.service';
import { TaxService } from '../tax/tax.service';
import { FolioService } from '../folio/folio.service';
import { WebhookService } from '../webhook/webhook.service';
import { calculateCanonicalRoomPricing } from '../rate-plan/canonical-room-pricing';
import { withAcceptedPricingLock } from '../../common/database/accepted-pricing-lock';
import { AvailabilityService, stayDates } from './availability.service';
import { ReservationService } from './reservation.service';
import type { ReservationPriceDto } from './dto/reservation-price.dto';
import type { UpgradeReservationDto } from './dto/upgrade-reservation.dto';

/** Pricing can only be changed while the stay is open; closed stays keep their final folio. */
const PRICE_EDITABLE = ['pending', 'confirmed', 'assigned', 'checked_in', 'stayover', 'due_out'];
/** Automatic occupancy repricing is a pre-arrival convenience only. */
const AUTO_REPRICE = ['pending', 'confirmed', 'assigned'];

type Canonical = Awaited<ReturnType<typeof calculateCanonicalRoomPricing>>;

/**
 * Staff price changes for an existing reservation. Every change replaces the accepted pricing
 * snapshot (the source night audit posts from), reconciles open linked folios and is audited.
 */
@Injectable()
export class ReservationPricingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: any,
    private readonly rates: RatePlanService,
    private readonly taxes: TaxService,
    @Inject(forwardRef(() => FolioService)) private readonly folioService: FolioService,
    private readonly webhookService: WebhookService,
    private readonly availability: AvailabilityService,
    @Inject(forwardRef(() => ReservationService)) private readonly reservationService: ReservationService,
  ) {}

  /** Reprice after the party changed. Manual prices are never overwritten. */
  async repriceForOccupancy(reservationId: string, propertyId: string, actor?: AuditActor) {
    const outcome = await withAcceptedPricingLock(this.db, propertyId, reservationId, async (tx) => {
      const row = await this.load(tx, reservationId, propertyId);
      const previous = row.acceptedPricingSnapshot as AcceptedPricingSnapshot | null;
      if (!AUTO_REPRICE.includes(row.status)) return { repriced: false, reason: 'STAY_STARTED' as const };
      if (!previous) return { repriced: false, reason: 'NO_ACCEPTED_PRICE' as const };
      if (previous.source === 'custom' || previous.adjustment) return { repriced: false, reason: 'MANUAL_PRICE' as const };
      const price = await this.canonical(tx, row, row.ratePlanId, { adults: row.adults ?? 1, children: row.children ?? 0 });
      const next = this.snapshot(previous, price, null);
      if (next.grandTotal === previous.grandTotal) return { repriced: false, reason: 'UNCHANGED' as const };
      await this.apply(tx, row, previous, next, {}, actor, 'reprice_occupancy',
        `Пересчёт стоимости по составу гостей: ${row.adults} взр., ${row.children ?? 0} дет.`);
      return { repriced: true, previousTotal: previous.grandTotal, totalAmount: next.grandTotal };
    });
    if (outcome.repriced) await this.emit(reservationId, propertyId);
    return outcome;
  }

  /** Change the head count (named guests are not required for children) and reprice when allowed. */
  async setOccupancy(reservationId: string, propertyId: string, adults: number, children: number, actor?: AuditActor) {
    await withAcceptedPricingLock(this.db, propertyId, reservationId, async (tx) => {
      const row = await this.load(tx, reservationId, propertyId);
      this.assertEditable(row);
      const [type] = await tx.select({ maxOccupancy: roomTypes.maxOccupancy }).from(roomTypes)
        .where(and(eq(roomTypes.id, row.roomTypeId), eq(roomTypes.propertyId, propertyId)));
      if (type && adults + children > type.maxOccupancy) throw new BadRequestException(`Room type max occupancy is ${type.maxOccupancy}`);
      await tx.update(reservations).set({ adults, children, updatedAt: new Date() })
        .where(and(eq(reservations.id, reservationId), eq(reservations.propertyId, propertyId)));
      await tx.insert(auditLogs).values({ propertyId, entityType: 'reservation', entityId: reservationId, action: 'occupancy_change',
        ...actorFields(actor), description: `Состав: ${adults} взр., ${children} дет.`,
        previousValue: { adults: row.adults, children: row.children }, newValue: { adults, children } });
    });
    const pricing = await this.repriceForOccupancy(reservationId, propertyId, actor);
    if (!pricing.repriced) await this.emit(reservationId, propertyId);
    return { adults, children, pricing };
  }

  /** Manual total, percentage or amount discount on the canonical tariff, with a mandatory reason. */
  async setPrice(reservationId: string, propertyId: string, dto: ReservationPriceDto, actor?: AuditActor) {
    const reason = dto.reason?.trim();
    if (!reason) throw new BadRequestException('A reason is required to change the price');
    const result = await withAcceptedPricingLock(this.db, propertyId, reservationId, async (tx) => {
      const row = await this.load(tx, reservationId, propertyId);
      this.assertEditable(row);
      const previous = this.requireSnapshot(row);
      const base = this.snapshot(previous, await this.canonical(tx, row, row.ratePlanId,
        { adults: row.adults ?? 1, children: row.children ?? 0 }), null);
      const target = this.targetTotal(base.grandTotal, dto);
      const next = dto.mode === 'reset' ? base : this.snapshot(previous, null, { total: target, reason }, base, await this.today(tx, propertyId));
      await this.apply(tx, row, previous, next, {}, actor, dto.mode === 'reset' ? 'price_reset' : 'price_override', reason);
      return { previousTotal: previous.grandTotal, totalAmount: next.grandTotal, baseTotal: base.grandTotal };
    });
    await this.emit(reservationId, propertyId);
    return result;
  }

  /** Change room type (and optionally rate plan): complimentary, repriced or custom priced. */
  async upgrade(reservationId: string, propertyId: string, dto: UpgradeReservationDto, actor?: AuditActor) {
    const reason = dto.reason?.trim();
    if (!reason) throw new BadRequestException('A reason is required for a room upgrade');
    const result = await withAcceptedPricingLock(this.db, propertyId, reservationId, async (tx) => {
      const row = await this.load(tx, reservationId, propertyId);
      this.assertEditable(row);
      const previous = this.requireSnapshot(row);
      if (dto.roomTypeId === row.roomTypeId && (!dto.ratePlanId || dto.ratePlanId === row.ratePlanId))
        throw new BadRequestException('Choose a different room type or rate plan');
      const [type] = await tx.select().from(roomTypes)
        .where(and(eq(roomTypes.id, dto.roomTypeId), eq(roomTypes.propertyId, propertyId)));
      if (!type?.isActive) throw new BadRequestException('Room type not found in this property');
      if ((row.adults ?? 1) + (row.children ?? 0) > type.maxOccupancy)
        throw new BadRequestException('Selected room type cannot accommodate this party');
      const ratePlanId = dto.ratePlanId ?? await this.defaultRatePlan(tx, propertyId, dto.roomTypeId, row.ratePlanId);
      const plan = await this.rates.findById(ratePlanId, propertyId, tx, true);
      if (plan.roomTypeId !== dto.roomTypeId) throw new BadRequestException('Rate plan does not apply to the selected room type');

      // Same inventory mutex and night-by-night check as creation; the stay keeps its dates.
      await this.reservationService.lockInventory(propertyId, dto.roomTypeId, tx);
      const nights = await this.availability.searchAvailability(propertyId, row.arrivalDate, row.departureDate, dto.roomTypeId, tx,
        { excludeReservationId: row.id });
      const missing = stayDates(row.arrivalDate, row.departureDate)
        .find(date => !nights.some((night: any) => night.date === date && night.available > 0));
      if (missing) throw new ConflictException(`No availability for the new room type on ${missing}`);

      let roomId: string | null = row.roomId;
      if (dto.roomId) {
        const [room] = await tx.select().from(rooms).where(and(eq(rooms.id, dto.roomId), eq(rooms.propertyId, propertyId)));
        if (!room || room.roomTypeId !== dto.roomTypeId) throw new BadRequestException('Room does not belong to the new room type');
        roomId = room.id;
      } else if (row.roomId) {
        const [room] = await tx.select({ roomTypeId: rooms.roomTypeId }).from(rooms).where(and(eq(rooms.id, row.roomId), eq(rooms.propertyId, propertyId)));
        if (room?.roomTypeId !== dto.roomTypeId) roomId = null; // Old room no longer matches; front desk reassigns.
      }
      if (['checked_in', 'stayover', 'due_out'].includes(row.status) && roomId !== row.roomId)
        throw new ConflictException('An in-house guest must be moved with "Move room" before changing room type');

      const base = this.snapshot(previous, await this.canonical(tx, { ...row, roomTypeId: dto.roomTypeId }, ratePlanId,
        { adults: row.adults ?? 1, children: row.children ?? 0 }), null);
      const today = await this.today(tx, propertyId);
      const next = dto.pricing === 'reprice' ? base
        : this.snapshot(previous, null, { total: dto.pricing === 'custom' ? this.money(dto.customTotal) : previous.grandTotal, reason }, base, today);
      const status = row.status === 'assigned' && !roomId ? 'confirmed' : row.status;
      await this.apply(tx, row, previous, next, { roomTypeId: dto.roomTypeId, ratePlanId, roomId, status }, actor, 'room_upgrade',
        `Апгрейд: ${type.name}. ${reason}`);
      return { roomTypeId: dto.roomTypeId, ratePlanId, roomId, previousTotal: previous.grandTotal, totalAmount: next.grandTotal,
        pricing: dto.pricing };
    });
    await this.emit(reservationId, propertyId);
    return result;
  }

  private async apply(tx: any, row: any, previous: AcceptedPricingSnapshot, next: AcceptedPricingSnapshot,
    changes: Record<string, unknown>, actor: AuditActor | undefined, action: string, description: string) {
    const linked = await tx.select().from(folios)
      .where(and(eq(folios.propertyId, row.propertyId), eq(folios.reservationId, row.id), eq(folios.status, 'open' as any)));
    for (const folio of linked) {
      await this.folioService.reconcileAcceptedStayAmendment({ tx, propertyId: row.propertyId, folioId: folio.id,
        reservationId: row.id, amendmentId: `${action}:${row.id}:${Date.now()}`, previousPricing: previous, newPricing: next,
        postedBy: actor?.userId ?? null });
    }
    const [updated] = await tx.update(reservations).set({ ...changes, totalAmount: next.grandTotal,
      acceptedPricingSnapshot: next, updatedAt: new Date() })
      .where(and(eq(reservations.id, row.id), eq(reservations.propertyId, row.propertyId))).returning();
    if (!updated) throw new ConflictException('Reservation changed while updating the price');
    await tx.insert(auditLogs).values({ propertyId: row.propertyId, entityType: 'reservation', entityId: row.id, action,
      ...actorFields(actor), description,
      previousValue: { totalAmount: previous.grandTotal, source: previous.source, roomTypeId: row.roomTypeId, ratePlanId: row.ratePlanId },
      newValue: { totalAmount: next.grandTotal, source: next.source, ...changes } });
    return updated;
  }

  private snapshot(previous: AcceptedPricingSnapshot, price: Canonical | null,
    custom: { total: string; reason: string } | null, base?: AcceptedPricingSnapshot, today?: string): AcceptedPricingSnapshot {
    if (price) {
      const services = new Decimal(previous.servicesTotal ?? 0).plus(previous.servicesTaxTotal ?? 0);
      return { ...previous, source: 'current', currencyCode: price.currency, roomTotal: price.roomTotal, taxTotal: price.taxTotal,
        grandTotal: new Decimal(price.totalAmount).plus(services).toFixed(2),
        nights: price.lineItems.map(n => ({ date: n.date, roomAmount: n.rate, taxAmount: n.tax })),
        customReason: null, adjustment: null };
    }
    const tariff = base!;
    const total = new Decimal(custom!.total);
    if (!total.isFinite() || total.lessThan(0)) throw new BadRequestException('Price must not be negative');
    const delta = total.minus(tariff.grandTotal).toDecimalPlaces(2);
    // The difference posts once on the first night that has not been audited yet.
    const serviceDate = tariff.nights.find(night => night.date >= today!)?.date;
    if (!delta.isZero() && !serviceDate) throw new ConflictException('No remaining night to apply the price change');
    return { ...tariff, source: 'custom', grandTotal: total.toFixed(2), customReason: custom!.reason,
      adjustment: delta.isZero() ? null : { amount: delta.toFixed(2), reason: custom!.reason, serviceDate: serviceDate! } };
  }

  private targetTotal(baseTotal: string, dto: ReservationPriceDto): string {
    const base = new Decimal(baseTotal);
    switch (dto.mode) {
      case 'reset': return base.toFixed(2);
      case 'total': return this.money(dto.value);
      case 'discount_percent': {
        const pct = new Decimal(dto.value ?? NaN);
        if (!pct.isFinite() || pct.lessThan(0) || pct.greaterThan(100)) throw new BadRequestException('Discount must be between 0 and 100%');
        return base.times(new Decimal(100).minus(pct)).dividedBy(100).toDecimalPlaces(2).toFixed(2);
      }
      case 'discount_amount': {
        const amount = new Decimal(this.money(dto.value));
        if (amount.greaterThan(base)) throw new BadRequestException('Discount exceeds the stay price');
        return base.minus(amount).toFixed(2);
      }
      default: throw new BadRequestException('Unknown price mode');
    }
  }

  private money(value?: string) {
    let parsed: Decimal;
    try { parsed = new Decimal(value ?? ''); } catch { throw new BadRequestException('Enter a valid amount'); }
    if (!parsed.isFinite() || parsed.lessThan(0) || parsed.decimalPlaces() > 2) throw new BadRequestException('Enter a valid amount');
    return parsed.toFixed(2);
  }

  private async canonical(tx: any, row: any, ratePlanId: string, occupancy: { adults: number; children: number }) {
    const plan = await this.rates.findById(ratePlanId, row.propertyId, tx);
    const nights = stayDates(row.arrivalDate, row.departureDate).length;
    const price = await calculateCanonicalRoomPricing({ propertyId: row.propertyId, ratePlanId, checkIn: row.arrivalDate,
      checkOut: row.departureDate, nights, isTaxInclusive: plan.isTaxInclusive, ratePlanService: this.rates, taxService: this.taxes,
      db: tx, guestId: row.guestId, occupancy });
    if (price.currency !== row.currencyCode) throw new ConflictException('Rate plan currency differs from the reservation currency');
    return price;
  }

  private async defaultRatePlan(tx: any, propertyId: string, roomTypeId: string, currentPlanId: string) {
    const plans = await tx.select().from(ratePlans).where(and(eq(ratePlans.propertyId, propertyId),
      eq(ratePlans.roomTypeId, roomTypeId), eq(ratePlans.isActive, true)));
    const [current] = await tx.select({ code: ratePlans.code }).from(ratePlans).where(and(eq(ratePlans.id, currentPlanId), eq(ratePlans.propertyId, propertyId)));
    const chosen = plans.find((plan: any) => plan.code === current?.code) ?? plans[0];
    if (!chosen) throw new BadRequestException('The selected room type has no active rate plan');
    return chosen.id as string;
  }

  private async today(tx: any, propertyId: string) {
    const [property] = await tx.select({ timezone: properties.timezone }).from(properties).where(eq(properties.id, propertyId));
    return new Intl.DateTimeFormat('sv-SE', { timeZone: property?.timezone ?? 'UTC' }).format(new Date());
  }

  private async load(tx: any, id: string, propertyId: string) {
    const [row] = await tx.select().from(reservations).where(and(eq(reservations.id, id), eq(reservations.propertyId, propertyId)));
    if (!row) throw new NotFoundException(`Reservation ${id} not found`);
    return row;
  }

  private assertEditable(row: any) {
    if (!PRICE_EDITABLE.includes(row.status)) throw new BadRequestException(`Cannot change the price of a reservation in '${row.status}' status`);
  }

  private requireSnapshot(row: any): AcceptedPricingSnapshot {
    if (!row.acceptedPricingSnapshot)
      throw new ConflictException({ code: 'PRICING_SNAPSHOT_REQUIRED', message: 'This reservation was imported without an accepted tariff; change it through the channel or re-create it' });
    return row.acceptedPricingSnapshot;
  }

  private async emit(reservationId: string, propertyId: string) {
    const [row] = await this.db.select().from(reservations).where(and(eq(reservations.id, reservationId), eq(reservations.propertyId, propertyId)));
    if (!row) return;
    await this.webhookService.emit('reservation.modified', 'reservation', row.id, { reservationId: row.id, arrivalDate: row.arrivalDate,
      departureDate: row.departureDate, roomTypeId: row.roomTypeId, totalAmount: row.totalAmount }, propertyId);
  }
}

import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, or } from 'drizzle-orm';
import Decimal from 'decimal.js';
import { auditLogs, priceRules, ratePlans, roomTypes } from '@telivityhaip/database';
import { DRIZZLE } from '../../database/database.module';
import { actorFields, type AuditActor } from '../../common/audit/audit-actor';
import { reportDates } from '../reports/reporting-policy';
import { RatePlanService } from './rate-plan.service';
import { overlappingRule, PRICE_ADJUSTMENT_TYPES, PRICE_RULE_KINDS, type PriceBounds, type PriceRuleLike } from './price-rules';

export interface PriceRuleInput {
  kind: string; name: string; startDate: string; endDate: string; roomTypeIds?: string[];
  adjustmentType: string; value: number | string; isActive?: boolean; reason: string;
}

const MAX_DAYS = 62;
const KIND_LABEL: Record<string, string> = { season: 'Сезон', holiday: 'Праздник', promo: 'Акция' };

/**
 * Simplified price calendar on top of rate plans: seasons, holidays, promos and min / max per room type.
 * The price itself is always computed by RatePlanService, so bookings, quotes, CRM and the agent see the same number.
 * Saved bookings keep their stored totals: nothing here reprices a confirmed reservation.
 */
@Injectable()
export class PriceCalendarService {
  constructor(@Inject(DRIZZLE) private readonly db: any, private readonly rates: RatePlanService) {}

  private range(from: string, to: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from) throw new BadRequestException('Invalid date range');
    const dates = reportDates(from, to);
    if (dates.length > MAX_DAYS) throw new BadRequestException(`Price calendar shows at most ${MAX_DAYS} days`);
    return dates;
  }

  private async types(propertyId: string, db = this.db) {
    return db.select({ id: roomTypes.id, name: roomTypes.name, code: roomTypes.code, minPrice: roomTypes.minPrice, maxPrice: roomTypes.maxPrice })
      .from(roomTypes).where(and(eq(roomTypes.propertyId, propertyId), eq(roomTypes.isActive, true))).orderBy(asc(roomTypes.sortOrder), asc(roomTypes.name));
  }

  /** Base (non-derived) active plans: the plan a room type is sold at before packages and derivations. */
  private async basePlans(propertyId: string, roomTypeId?: string, db = this.db) {
    const rows = await db.select({ id: ratePlans.id, name: ratePlans.name, code: ratePlans.code, roomTypeId: ratePlans.roomTypeId, type: ratePlans.type,
      parentRatePlanId: ratePlans.parentRatePlanId, currencyCode: ratePlans.currencyCode, baseAmount: ratePlans.baseAmount })
      .from(ratePlans).where(and(eq(ratePlans.propertyId, propertyId), eq(ratePlans.isActive, true), roomTypeId ? eq(ratePlans.roomTypeId, roomTypeId) : undefined));
    return rows.filter((plan: any) => plan.type !== 'derived' || !plan.parentRatePlanId);
  }

  async rules(propertyId: string) {
    return this.db.select().from(priceRules).where(eq(priceRules.propertyId, propertyId)).orderBy(asc(priceRules.startDate), asc(priceRules.kind));
  }

  /** Final price of every night per base plan, with the steps that produced it. */
  async calendar(propertyId: string, from: string, to: string, roomTypeId?: string, service: RatePlanService = this.rates) {
    const dates = this.range(from, to);
    const [types, plans] = await Promise.all([this.types(propertyId), this.basePlans(propertyId, roomTypeId)]);
    const days = [];
    for (const plan of plans) for (const date of dates) {
      const next = new Date(date + 'T00:00:00Z'); next.setUTCDate(next.getUTCDate() + 1);
      const price = await service.calculateDerivedRate(plan.id, propertyId, { stayDate: date, checkIn: date, checkOut: next.toISOString().slice(0, 10), nights: 1 } as any);
      days.push({ date, ratePlanId: plan.id, roomTypeId: plan.roomTypeId, price: price.effectiveRate, currencyCode: price.currency,
        steps: price.priceSteps ?? [{ step: 'base', label: 'Базовая цена тарифа', amount: price.effectiveRate }] });
    }
    return { propertyId, from, to, roomTypes: types, ratePlans: plans, days, rules: await this.rules(propertyId) };
  }

  private validate(input: PriceRuleInput, types: Array<{ id: string }>): PriceRuleLike & { reason: string } {
    if (!PRICE_RULE_KINDS.includes(input.kind as never)) throw new BadRequestException('Unknown rule kind');
    if (!PRICE_ADJUSTMENT_TYPES.includes(input.adjustmentType as never)) throw new BadRequestException('Unknown adjustment type');
    const name = String(input.name ?? '').trim(); const reason = String(input.reason ?? '').trim();
    if (name.length < 2) throw new BadRequestException('A rule name is required');
    if (reason.length < 3) throw new BadRequestException('A reason is required');
    this.range(input.startDate, input.startDate);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.endDate) || input.endDate < input.startDate) throw new BadRequestException('End date must not be before start date');
    if (!/^-?\d+(\.\d{1,2})?$/.test(String(input.value))) throw new BadRequestException('Invalid value');
    const value = new Decimal(input.value);
    if (input.adjustmentType === 'fixed_price' && value.lte(0)) throw new BadRequestException('A fixed price must be above zero');
    if (input.adjustmentType === 'percent' && (value.lte(-100) || value.gt(500))) throw new BadRequestException('Percent must be above -100 and at most 500');
    const known = new Set(types.map((t) => t.id));
    const roomTypeIds = [...new Set(input.roomTypeIds ?? [])];
    if (roomTypeIds.some((id) => !known.has(id))) throw new BadRequestException('Room type not found at this property');
    return { id: 'draft', kind: input.kind, name, startDate: input.startDate, endDate: input.endDate, roomTypeIds, adjustmentType: input.adjustmentType,
      value: value.toFixed(2), isActive: input.isActive ?? true, reason };
  }

  private assertUnambiguous(existing: PriceRuleLike[], candidate: PriceRuleLike) {
    const clash = overlappingRule(existing, candidate);
    if (clash) throw new ConflictException(`${KIND_LABEL[candidate.kind]} пересекается с «${clash.name}» (${clash.startDate} – ${clash.endDate}) для того же типа номера`);
  }

  /** Before / after prices for the nights a rule (new or changed) touches; nothing is saved. */
  async preview(propertyId: string, input: PriceRuleInput, ruleId?: string) {
    const types = await this.types(propertyId);
    const candidate = this.validate(input, types);
    const existing = await this.rules(propertyId);
    if (ruleId && !existing.some((rule: any) => rule.id === ruleId)) throw new NotFoundException('Price rule not found');
    candidate.id = ruleId ?? 'draft';
    this.assertUnambiguous(existing, candidate);
    const draft = this.rates.withPriceRulesDraft({ propertyId, rules: [...existing.filter((rule: any) => rule.id !== candidate.id && rule.isActive), ...(candidate.isActive ? [candidate] : [])] });
    const end = reportDates(candidate.startDate, candidate.endDate).slice(0, MAX_DAYS).at(-1)!;
    const roomTypeId = candidate.roomTypeIds?.length === 1 ? candidate.roomTypeIds[0] : undefined;
    const [before, after] = await Promise.all([this.calendar(propertyId, candidate.startDate, end, roomTypeId), this.calendar(propertyId, candidate.startDate, end, roomTypeId, draft)]);
    const inScope = (typeId: string | null) => !candidate.roomTypeIds?.length || (typeId != null && candidate.roomTypeIds.includes(typeId));
    const days = after.days.filter((day) => inScope(day.roomTypeId)).map((day) => {
      const was = before.days.find((row) => row.date === day.date && row.ratePlanId === day.ratePlanId);
      return { date: day.date, ratePlanId: day.ratePlanId, roomTypeId: day.roomTypeId, before: was?.price ?? null, after: day.price, steps: day.steps };
    });
    return { rule: candidate, days, truncated: reportDates(candidate.startDate, candidate.endDate).length > MAX_DAYS };
  }

  private async audit(tx: any, propertyId: string, entityType: string, entityId: string, action: string, before: unknown, after: unknown, description: string, actor?: AuditActor) {
    await tx.insert(auditLogs).values({ propertyId, entityType, entityId, action, ...actorFields(actor), previousValue: before ?? null, newValue: after ?? null, description });
  }

  async create(propertyId: string, input: PriceRuleInput, actor?: AuditActor) {
    return this.db.transaction(async (tx: any) => {
      const candidate = this.validate(input, await this.types(propertyId, tx));
      const existing = await tx.select().from(priceRules).where(eq(priceRules.propertyId, propertyId)).for('update');
      this.assertUnambiguous(existing, candidate);
      const { id: _draft, ...values } = candidate;
      const [row] = await tx.insert(priceRules).values({ ...values, propertyId, createdBy: actor?.userId ?? null }).returning();
      await this.audit(tx, propertyId, 'price_rule', row.id, 'create', null, row, `${KIND_LABEL[row.kind]} «${row.name}»: ${candidate.reason}`, actor);
      return row;
    });
  }

  async update(propertyId: string, id: string, input: PriceRuleInput & { expectedRevision?: number }, actor?: AuditActor) {
    return this.db.transaction(async (tx: any) => {
      const existing = await tx.select().from(priceRules).where(eq(priceRules.propertyId, propertyId)).for('update');
      const before = existing.find((rule: any) => rule.id === id);
      if (!before) throw new NotFoundException('Price rule not found');
      if (input.expectedRevision != null && input.expectedRevision !== before.revision) throw new ConflictException('The rule was changed by someone else; reload it');
      const merged = { ...before, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) } as PriceRuleInput;
      const candidate = this.validate(merged, await this.types(propertyId, tx));
      candidate.id = id;
      this.assertUnambiguous(existing, candidate);
      const { id: _id, ...values } = candidate;
      const [row] = await tx.update(priceRules).set({ ...values, revision: before.revision + 1, updatedAt: new Date() })
        .where(and(eq(priceRules.id, id), eq(priceRules.propertyId, propertyId))).returning();
      await this.audit(tx, propertyId, 'price_rule', id, row.isActive ? 'update' : 'deactivate', before, row, `${KIND_LABEL[row.kind]} «${row.name}»: ${candidate.reason}`, actor);
      return row;
    });
  }

  async setBounds(propertyId: string, roomTypeId: string, input: { minPrice?: number | string | null; maxPrice?: number | string | null; reason: string }, actor?: AuditActor) {
    const reason = String(input.reason ?? '').trim();
    if (reason.length < 3) throw new BadRequestException('A reason is required');
    const parse = (v: unknown) => v === null || v === undefined || v === '' ? null : /^\d+(\.\d{1,2})?$/.test(String(v)) ? new Decimal(String(v)).toFixed(2) : (() => { throw new BadRequestException('Invalid price'); })();
    const next: PriceBounds = { minPrice: parse(input.minPrice), maxPrice: parse(input.maxPrice) };
    if (next.minPrice != null && next.maxPrice != null && new Decimal(next.minPrice).gt(next.maxPrice)) throw new BadRequestException('Minimum price is above maximum price');
    return this.db.transaction(async (tx: any) => {
      const [before] = await tx.select({ id: roomTypes.id, name: roomTypes.name, minPrice: roomTypes.minPrice, maxPrice: roomTypes.maxPrice }).from(roomTypes)
        .where(and(eq(roomTypes.id, roomTypeId), eq(roomTypes.propertyId, propertyId))).for('update');
      if (!before) throw new NotFoundException('Room type not found');
      const [row] = await tx.update(roomTypes).set({ minPrice: next.minPrice, maxPrice: next.maxPrice, updatedAt: new Date() })
        .where(and(eq(roomTypes.id, roomTypeId), eq(roomTypes.propertyId, propertyId)))
        .returning({ id: roomTypes.id, name: roomTypes.name, minPrice: roomTypes.minPrice, maxPrice: roomTypes.maxPrice });
      await this.audit(tx, propertyId, 'room_type_price_bounds', roomTypeId, 'update', before, row, `Мин./макс. цена «${row.name}»: ${reason}`, actor);
      return row;
    });
  }

  /** Change log of the price calendar: rules and min / max, newest first. */
  async history(propertyId: string, limit = 100) {
    return this.db.select({ id: auditLogs.id, entityType: auditLogs.entityType, entityId: auditLogs.entityId, action: auditLogs.action,
      userEmail: auditLogs.userEmail, description: auditLogs.description, previousValue: auditLogs.previousValue, newValue: auditLogs.newValue, occurredAt: auditLogs.occurredAt })
      .from(auditLogs).where(and(eq(auditLogs.propertyId, propertyId), or(eq(auditLogs.entityType, 'price_rule'), eq(auditLogs.entityType, 'room_type_price_bounds'))))
      .orderBy(desc(auditLogs.occurredAt)).limit(Math.min(Math.max(limit, 1), 200));
  }

  /** Read model for CRM and the guest agent: final nightly price per room type and the reasons, no rule internals. */
  async publicCalendar(propertyId: string, from: string, to: string, roomTypeId?: string) {
    const data = await this.calendar(propertyId, from, to, roomTypeId);
    const typeName = new Map(data.roomTypes.map((t: any) => [t.id, t.name]));
    const planName = new Map(data.ratePlans.map((p: any) => [p.id, p.name]));
    return { propertyId, from, to, days: data.days.map((day) => ({ date: day.date, roomTypeId: day.roomTypeId, roomType: typeName.get(day.roomTypeId) ?? null,
      ratePlanId: day.ratePlanId, ratePlan: planName.get(day.ratePlanId) ?? null, price: day.price, currencyCode: day.currencyCode,
      why: day.steps.map((step) => step.label) })) };
  }
}

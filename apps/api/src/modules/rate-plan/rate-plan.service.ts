import {
  Injectable,
  Inject,
  Optional,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { eq, and, lte, gte, sql, desc, or } from 'drizzle-orm';
import { ratePlans, rateRestrictions, roomTypes, cancellationPolicies, groupProfiles, properties, auditLogs, rateChangeRequests, rateMutationFences } from '@telivityhaip/database';
import { DRIZZLE } from '../../database/database.module';
import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import { DomainEventOutboxService } from '../webhook/domain-event-outbox.service';
import { ReportsService } from '../reports/reports.service';
import { reportDate, reportDates } from '../reports/reporting-policy';
import type { PricingMutationDto } from './dto/pricing-mutation.dto';
import type { LiveRateChangeDto, LiveCalendarQueryDto } from './dto/live-rate.dto';
import type { WebhookEvent } from '@telivityhaip/shared';
import { TaxService } from '../tax/tax.service';
import { calculateCanonicalRoomPricing, occupancySupplementAmount } from './canonical-room-pricing';
import { CreateRatePlanDto } from './dto/create-rate-plan.dto';
import { UpdateRatePlanDto } from './dto/update-rate-plan.dto';
import { CreateRateRestrictionDto } from './dto/create-rate-restriction.dto';
import { UpdateRateRestrictionDto } from './dto/update-rate-restriction.dto';
import { EffectiveRateQueryDto } from './dto/effective-rate-query.dto';
import { actorFields, type AuditActor } from '../../common/audit/audit-actor';
import {
  applyRateAdjustment,
  nightsBetween,
  selectLosAdjustment,
  selectOccupancyBand,
  type LosAdjustment,
  type OccupancyBand,
} from './rate-pricing.util';

export interface EffectiveRateResult {
  effectiveRate: number;
  currency: string;
  baseRate: number;
  nights?: number;
  occupancyPct?: number;
  losAdjustment?: LosAdjustment | null;
  occupancyAdjustment?: OccupancyBand | null;
  override?: { restrictionId: string; amount: number | null; reason: string | null } | null;
  isTaxInclusive?: boolean;
}

@Injectable()
export class RatePlanService {
  constructor(
    @Inject(DRIZZLE) private readonly db: any,
    @Optional() private readonly outbox?: DomainEventOutboxService,
    @Optional() private readonly reports?: ReportsService,
    @Optional() private readonly taxes?: TaxService,
  ) {}

  /**
   * Enforce rate-plan sellability for a stay [checkIn, checkOut). Throws 400 if
   * the plan is inactive, the stay is outside validFrom/validTo, or a restriction
   * blocks it: stop-sell (closed), closed-to-arrival on the check-in date,
   * closed-to-departure on the check-out date, or a min/max length-of-stay
   * violation.
   *
   * validTo is the inclusive last consumed night. Checkout is exclusive, so a
   * stay departing the day after validTo is still sellable; a stay that consumes
   * any night after validTo is not.
   *
   * The BOOK path MUST call this. SEARCH only *surfaces* restrictions (it doesn't
   * hard-block CTA/CTD), so without this guard a direct create-reservation call —
   * including one driven by an LLM — could book a date the hotel marked unbookable.
   */
  async assertSellable(
    propertyId: string,
    ratePlanId: string,
    checkIn: string,
    checkOut: string,
    db?: any,
  ): Promise<void> {
    const conn = db ?? this.db;
    const nights = Math.ceil(
      (new Date(checkOut).getTime() - new Date(checkIn).getTime()) / 86_400_000,
    );
    if (!(nights > 0)) {
      throw new BadRequestException('Check-out must be after check-in');
    }

    // Plan lookup is scoped by both ids — never infer propertyId from the row.
    const plan = await this.findById(ratePlanId, propertyId, conn);
    if (plan.isActive === false) {
      throw new BadRequestException('Rate plan is inactive');
    }

    const lastConsumedNight = this.addDaysIso(checkOut, -1);
    if (
      (plan.validFrom && checkIn < plan.validFrom) ||
      (plan.validTo && lastConsumedNight > plan.validTo)
    ) {
      throw new BadRequestException('Rate plan is not valid for the complete stay');
    }

    // Sold nights plus checkout-only departure controls, scoped by property.
    const restrictions = this.pricingDraft?.plan.id === ratePlanId && this.pricingDraft.plan.propertyId === propertyId
      ? this.pricingDraft.restrictions.filter((r: any) => r.endDate >= checkIn && (r.startDate <= lastConsumedNight || (r.closedToDeparture && r.startDate <= checkOut)))
      : await conn
      .select()
      .from(rateRestrictions)
      .where(
        and(
          eq(rateRestrictions.propertyId, propertyId),
          eq(rateRestrictions.ratePlanId, ratePlanId),
          or(lte(rateRestrictions.startDate, lastConsumedNight), and(eq(rateRestrictions.closedToDeparture, true), lte(rateRestrictions.startDate, checkOut))),
          gte(rateRestrictions.endDate, checkIn),
        ),
      );

    // A restriction row "covers" a date when its range includes it (ISO dates compare lexically).
    const covers = (r: any, date: string) => r.startDate <= date && r.endDate >= date;

    const soldNightRestrictions = restrictions.filter((r: any) => r.startDate <= lastConsumedNight && r.endDate >= checkIn);
    if (soldNightRestrictions.some((r: any) => r.isClosed)) {
      throw new BadRequestException('Rate plan is closed (stop-sell) for the selected dates');
    }
    if (restrictions.some((r: any) => r.closedToArrival && covers(r, checkIn))) {
      throw new BadRequestException('Rate plan is closed to arrival on the check-in date');
    }
    if (restrictions.some((r: any) => r.closedToDeparture && covers(r, checkOut))) {
      throw new BadRequestException('Rate plan is closed to departure on the check-out date');
    }

    const minLos = soldNightRestrictions.reduce(
      (m: number | undefined, r: any) => (r.minLos ? Math.max(m ?? 0, r.minLos) : m),
      undefined,
    );
    const maxLos = soldNightRestrictions.reduce(
      (m: number | undefined, r: any) => (r.maxLos ? Math.min(m ?? Infinity, r.maxLos) : m),
      undefined,
    );
    if (minLos && nights < minLos) {
      throw new BadRequestException(`Minimum length of stay is ${minLos} night(s)`);
    }
    if (maxLos && maxLos !== Infinity && nights > maxLos) {
      throw new BadRequestException(`Maximum length of stay is ${maxLos} night(s)`);
    }
  }

  // --- Rate Plans ---

  async create(dto: CreateRatePlanDto & { propertyId: string }, actor?: AuditActor) {
    return this.mutate(dto.propertyId, dto, 'plan.create', actor, async tx => {
      if (dto.expectedRevision !== 0) this.stale();
      await this.directAllowed(dto.propertyId, tx);
      const values = this.clean(dto);
      await this.validatePlan(values, dto.propertyId, tx);
      const [plan] = await tx.insert(ratePlans).values({ ...values, propertyId: dto.propertyId }).returning();
      await this.record(tx, dto.propertyId, 'rate_plan', plan.id, 'create', null, plan, dto.reason, actor, 'rate_plan.created', dto.requestId);
      return plan;
    });
  }

  async findAll(propertyId: string) {
    return this.db
      .select()
      .from(ratePlans)
      .where(
        and(eq(ratePlans.propertyId, propertyId), eq(ratePlans.isActive, true)),
      );
  }

  async findById(id: string, propertyId: string, db?: any, lockForUpdate = false) {
    if (this.pricingDraft?.plan.id === id && this.pricingDraft.plan.propertyId === propertyId) return this.pricingDraft.plan;
    const conn = db ?? this.db;
    const query = conn
      .select()
      .from(ratePlans)
      .where(and(eq(ratePlans.id, id), eq(ratePlans.propertyId, propertyId)));
    const [ratePlan] = lockForUpdate ? await query.for('update') : await query;
    if (!ratePlan) {
      throw new NotFoundException(`Rate plan ${id} not found`);
    }
    return this.pricingDraft?.plan.id === id && this.pricingDraft.plan.propertyId === propertyId ? this.pricingDraft.plan : ratePlan;
  }

  /** Per-night occupancy supplement for a party on this rate plan ('0.00' when the plan prices per room only). */
  async occupancySupplement(ratePlanId: string, propertyId: string, adults: number, children: number, db?: any): Promise<string> {
    const plan = await this.findById(ratePlanId, propertyId, db);
    if (plan.extraAdultAmount == null && plan.extraChildAmount == null) return '0.00';
    const [type] = await (db ?? this.db).select({ defaultOccupancy: roomTypes.defaultOccupancy }).from(roomTypes)
      .where(and(eq(roomTypes.id, plan.roomTypeId), eq(roomTypes.propertyId, propertyId)));
    return occupancySupplementAmount(plan, type?.defaultOccupancy ?? 1, adults, children);
  }

  async update(id: string, propertyId: string, dto: UpdateRatePlanDto & Partial<PricingMutationDto>, actor?: AuditActor) {
    return this.mutate(propertyId, dto, 'plan.update:' + id, actor, async tx => {
      const before = await this.findById(id, propertyId, tx, true);
      this.expectRevision(before, dto.expectedRevision);
      await this.directAllowed(propertyId, tx);
      const values = this.clean(dto);
      await this.validatePlan({ ...before, ...values }, propertyId, tx, id);
      const [plan] = await tx.update(ratePlans).set({ ...values, revision: before.revision + 1, updatedAt: new Date() })
        .where(and(eq(ratePlans.id, id), eq(ratePlans.propertyId, propertyId))).returning();
      await this.record(tx, propertyId, 'rate_plan', id, 'update', before, plan, dto.reason!, actor, 'rate_plan.updated', dto.requestId!);
      return plan;
    });
  }

  /**
   * Calculate the effective rate for a rate plan.
   * Resolves derived chains, then applies LOS and occupancy-based adjustments
   * when stay context (nights / dates) is provided.
   */
  async calculateDerivedRate(
    id: string,
    propertyId: string,
    context?: EffectiveRateQueryDto,
    db?: any,
    lockForUpdate = false,
    seen = new Set<string>(),
  ): Promise<EffectiveRateResult> {
    if (seen.has(id)) throw new BadRequestException('Circular derived rate chain');
    seen.add(id);
    const ratePlan = await this.findById(id, propertyId, db, lockForUpdate);

    let baseRate: number;
    if (ratePlan.type !== 'derived' || !ratePlan.parentRatePlanId) {
      baseRate = Number(ratePlan.baseAmount);
    } else {
      const parent = await this.calculateDerivedRate(
        ratePlan.parentRatePlanId,
        propertyId,
        context?.stayDate ? { stayDate: context.stayDate } : undefined,
        db,
        lockForUpdate,
        seen,
      );
      if (parent.currency !== ratePlan.currencyCode) throw new BadRequestException('Parent currency mismatch');
      const parentAmount = parent.effectiveRate;
      const adjustmentValue = Number(ratePlan.derivedAdjustmentValue);

      if (ratePlan.derivedAdjustmentType === 'percentage') {
        baseRate = parentAmount * (1 + adjustmentValue / 100);
      } else {
        baseRate = parentAmount + adjustmentValue;
      }
    }

    let effectiveRate = baseRate;
    let nights = context?.nights;
    if (!nights && context?.checkIn && context?.checkOut) {
      nights = nightsBetween(context.checkIn, context.checkOut);
    }

    const losAdjustment = selectLosAdjustment(
      ratePlan.losAdjustments as LosAdjustment[] | null,
      nights ?? 0,
    );
    if (losAdjustment) {
      effectiveRate = applyRateAdjustment(effectiveRate, losAdjustment);
    }

    const stayDate = context?.stayDate ?? context?.checkIn;
    let occupancyPct: number | undefined;
    let occupancyAdjustment: OccupancyBand | null = null;
    if (stayDate && ratePlan.occupancyBands?.length) {
      occupancyPct = await this.getStayOccupancyPct(propertyId, stayDate, db);
      occupancyAdjustment = occupancyPct == null ? null : selectOccupancyBand(
        ratePlan.occupancyBands as OccupancyBand[], occupancyPct,
      );
      if (occupancyAdjustment) {
        effectiveRate = applyRateAdjustment(effectiveRate, occupancyAdjustment);
      }
    }

    let override: EffectiveRateResult['override'] = null;
    if (stayDate) {
      reportDate(stayDate);
      const restrictions = await this.findRestrictions(id, propertyId, db);
      const covered = restrictions.filter((row: any) => row.startDate <= stayDate && row.endDate >= stayDate);
      const monetary = covered.find((row: any) => row.rateOverride != null || Object.keys(row.dayOfWeekOverrides ?? {}).length);
      if (monetary) {
        if (monetary.rateOverride != null) effectiveRate = Number(monetary.rateOverride);
        const day = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'][new Date(stayDate + 'T00:00:00Z').getUTCDay()]!;
        effectiveRate += monetary.dayOfWeekOverrides?.[day] ?? 0;
        override = { restrictionId: monetary.id, amount: monetary.rateOverride == null ? null : Number(monetary.rateOverride), reason: monetary.overrideReason ?? null };
      }
    }

    return {
      effectiveRate: Math.max(0, Number(effectiveRate.toFixed(2))),
      currency: ratePlan.currencyCode,
      baseRate: Math.max(0, Number(baseRate.toFixed(2))),
      ...(nights ? { nights } : {}),
      ...(occupancyPct != null ? { occupancyPct: Math.round(occupancyPct * 100) / 100 } : {}),
      losAdjustment: losAdjustment ?? null,
      occupancyAdjustment: occupancyAdjustment ?? null,
      override,
      isTaxInclusive: ratePlan.isTaxInclusive,
    };
  }

  async getStayOccupancyPct(propertyId: string, stayDate: string, db?: any): Promise<number | undefined> {
    const stock = await this.reportService().getOnBooksOccupancy(propertyId, stayDate, db);
    return stock.occ == null ? undefined : stock.occ * 100;
  }

  // --- Guarded live rate mutations ---

  async createRestriction(ratePlanId: string, propertyId: string, dto: CreateRateRestrictionDto, actor?: AuditActor) {
    return this.mutate(propertyId, dto, 'restriction.create:' + ratePlanId, actor, async tx => {
      const plan = await this.findById(ratePlanId, propertyId, tx, true);
      this.expectRevision(plan, dto.expectedRevision);
      await this.directAllowed(propertyId, tx);
      return this.applyRestriction(tx, plan, 'restriction_create', undefined, this.clean(dto), dto.reason, actor, dto.requestId);
    });
  }

  async findRestrictions(ratePlanId: string, propertyId: string, db?: any) {
    const conn = db ?? this.db;
    await this.findById(ratePlanId, propertyId, conn);
    if (this.pricingDraft?.plan.id === ratePlanId && this.pricingDraft.plan.propertyId === propertyId) return this.pricingDraft.restrictions;
    return conn.select().from(rateRestrictions).where(and(eq(rateRestrictions.ratePlanId, ratePlanId), eq(rateRestrictions.propertyId, propertyId)))
      .orderBy(desc(rateRestrictions.updatedAt), desc(rateRestrictions.id));
  }

  async updateRestriction(id: string, propertyId: string, dto: UpdateRateRestrictionDto & Partial<PricingMutationDto>, actor?: AuditActor, ratePlanId?: string) {
    return this.mutate(propertyId, dto, 'restriction.update:' + id, actor, async tx => {
      const before = await this.restriction(id, propertyId, tx, ratePlanId);
      const plan = await this.findById(before.ratePlanId, propertyId, tx, true);
      this.expectRevision(plan, dto.expectedRevision);
      await this.directAllowed(propertyId, tx);
      return this.applyRestriction(tx, plan, 'restriction_update', id, this.clean(dto), dto.reason!, actor, dto.requestId!);
    });
  }

  async deleteRestriction(id: string, propertyId: string, guard?: Partial<PricingMutationDto>, actor?: AuditActor, ratePlanId?: string) {
    return this.mutate(propertyId, guard ?? {}, 'restriction.delete:' + id, actor, async tx => {
      const before = await this.restriction(id, propertyId, tx, ratePlanId);
      const plan = await this.findById(before.ratePlanId, propertyId, tx, true);
      this.expectRevision(plan, guard?.expectedRevision);
      await this.directAllowed(propertyId, tx);
      return this.applyRestriction(tx, plan, 'restriction_delete', id, {}, guard!.reason!, actor, guard!.requestId!);
    });
  }

  async pricingHistory(propertyId: string) {
    await this.property(propertyId, this.db);
    const history = await this.db.select().from(auditLogs).where(and(eq(auditLogs.propertyId, propertyId),
      or(eq(auditLogs.entityType, 'rate_plan'), eq(auditLogs.entityType, 'rate_restriction'), eq(auditLogs.entityType, 'rate_change')),
      sql`${auditLogs.description} not like 'Webhook event:%'`)).orderBy(desc(auditLogs.occurredAt)).limit(200);
    return history.map((row: typeof auditLogs.$inferSelect) => ({ ...row, timelineSequence: row.timelineSequence.toString() }));
  }

  async liveCalendar(query: LiveCalendarQueryDto) {
    const dates = reportDates(query.startDate, query.endDate);
    if (dates.length > 93 || (query.nights ?? 1) > 366) throw new BadRequestException('Calendar max 93 days, stay max 366 nights');
    return this.db.transaction(async (tx: any) => {
      const property = await this.property(query.propertyId, tx);
      const plans = await tx.select().from(ratePlans).where(and(eq(ratePlans.propertyId, query.propertyId), eq(ratePlans.isActive, true),
        query.roomTypeId ? eq(ratePlans.roomTypeId, query.roomTypeId) : undefined, query.ratePlanId ? eq(ratePlans.id, query.ratePlanId) : undefined));
      if (query.ratePlanId && !plans.length) throw new NotFoundException('Active rate plan not found in selected category/property');
      const signals = await this.reportService().getRevenueSignals(query.propertyId, query.startDate, query.endDate, query.roomTypeId, tx);
      const rates = [];
      for (const plan of plans) {
        if (plan.currencyCode !== property.currencyCode) throw new BadRequestException('CURRENCY_MISMATCH');
        const restrictions = await this.findRestrictions(plan.id, query.propertyId, tx);
        for (const date of dates) {
          const nights = query.nights ?? 1, checkOut = this.addDaysIso(date, nights);
          const price = await this.calculateDerivedRate(plan.id, query.propertyId, { stayDate: date, checkIn: date, checkOut, nights }, tx);
          let sellable = true, restrictionReason: string | null = null;
          try { await this.assertSellable(query.propertyId, plan.id, date, checkOut, tx); }
          catch (error) { if (!(error instanceof BadRequestException)) throw error; sellable = false; restrictionReason = error.message; }
          const quote = await this.roomQuote(tx, plan, date, nights, this);
          rates.push({ date, ratePlanId: plan.id, roomTypeId: plan.roomTypeId, name: plan.name, code: plan.code, planRevision: plan.revision,
            currencyCode: plan.currencyCode, price, quote, isEarnedRevenue: false, sellable, restrictionReason,
            restrictions: restrictions.filter((row: any) => row.startDate <= checkOut && row.endDate >= date),
            recommendation: { status: 'RULE_BASED', value: price.effectiveRate, source: 'RatePlanService',
              reason: 'Configured canonical rate, LOS/occupancy rules and date overrides only; no predicted demand', requiresHumanReview: true },
            forecast: signals.forecast });
        }
      }
      return this.json({ mode: 'LIVE', propertyId: query.propertyId, signals, rates });
    }, { isolationLevel: 'repeatable read', readOnly: true });
  }

  async previewLiveChange(dto: LiveRateChangeDto) {
    return this.db.transaction((tx: any) => this.previewIn(tx, dto, false), { isolationLevel: 'repeatable read', readOnly: true });
  }

  private async roomQuote(tx: any, plan: any, date: string, nights: number, rates: RatePlanService) {
    if (!this.taxes) throw new Error('Canonical tax service is required for live pricing');
    return calculateCanonicalRoomPricing({ propertyId: plan.propertyId, ratePlanId: plan.id, checkIn: date,
      checkOut: this.addDaysIso(date, nights), nights, isTaxInclusive: plan.isTaxInclusive, ratePlanService: rates, taxService: this.taxes, db: tx });
  }

  private async previewIn(tx: any, dto: LiveRateChangeDto, lock: boolean) {
    const dates = reportDates(dto.startDate, dto.endDate);
    if (dates.length > 93) throw new BadRequestException('Preview supports at most 93 days');
    const property = await this.property(dto.propertyId, tx);
    const creating = dto.kind === 'plan_create';
    if (creating && (dto.expectedRevision !== 0 || dto.ratePlanId || dto.plan || dto.restriction || dto.restrictionId || !dto.createPlan)) throw new BadRequestException('Creation requires createPlan, revision 0 and no existing target');
    if (!creating && dto.createPlan) throw new BadRequestException('Existing target cannot contain createPlan');
    const plan = creating ? { isTaxInclusive: false, isActive: true, sortOrder: 0, ...this.clean(dto.createPlan), id: dto.requestId, propertyId: dto.propertyId, revision: 0 }
      : await this.findById(dto.ratePlanId, dto.propertyId, tx, lock);
    if (!creating) this.expectRevision(plan, dto.expectedRevision);
    const restrictions = creating ? [] : await this.findRestrictions(plan.id, dto.propertyId, tx);
    let nextPlan = plan, nextRestrictions = restrictions;
    if (creating) {
      if (!plan.roomTypeId || !plan.name?.trim() || !plan.code?.trim() || !['bar', 'derived', 'negotiated', 'package', 'promotional'].includes(plan.type)) throw new BadRequestException('Invalid new plan');
      await this.validatePlan(plan, dto.propertyId, tx, plan.id);
      const [existing] = await tx.select().from(ratePlans).where(and(eq(ratePlans.propertyId, dto.propertyId),
        or(eq(ratePlans.id, plan.id), and(eq(ratePlans.roomTypeId, plan.roomTypeId), eq(ratePlans.code, plan.code)))));
      if (existing) throw new ConflictException({ code: 'STALE_PRICING_STATE', message: 'Creation target/code already exists; preview again' });
    } else if (dto.kind === 'plan') {
      if (!dto.plan || dto.restriction || dto.restrictionId) throw new BadRequestException('Plan change requires only a plan patch');
      const values = this.clean(dto.plan);
      nextPlan = { ...plan, ...values };
      await this.validatePlan(nextPlan, dto.propertyId, tx, plan.id);
    } else if (['restriction_create','restriction_update','restriction_delete'].includes(dto.kind)) {
      if (dto.plan) throw new BadRequestException('Restriction change must not contain a plan patch');
      const before = dto.kind === 'restriction_create' ? null : await this.restriction(dto.restrictionId!, dto.propertyId, tx, plan.id);
      if (dto.kind === 'restriction_create' && dto.restrictionId) throw new BadRequestException('New restriction cannot have an existing ID');
      if (dto.kind === 'restriction_delete') {
        if (dto.restriction) throw new BadRequestException('Delete must not contain a restriction patch');
        nextRestrictions = restrictions.filter((row: any) => row.id !== before.id);
      } else {
        if (!dto.restriction) throw new BadRequestException('Restriction patch is required');
        const values = this.clean(dto.restriction);
        const next = { ...before, ...values, id: before?.id ?? 'preview', propertyId: dto.propertyId, ratePlanId: plan.id };
        if (values.rateOverride !== undefined) next.overrideReason = values.rateOverride == null ? null : (values.overrideReason ?? dto.reason).trim();
        this.validateRestriction(next);
        this.rejectAmbiguousOverrides(restrictions, next, before?.id);
        nextRestrictions = [next, ...restrictions.filter((row: any) => row.id !== before?.id)];
      }
    } else throw new BadRequestException('Invalid live change kind');
    const draft = new RatePlanService(tx, this.outbox, this.reports, this.taxes);
    draft.pricingDraft = { plan: nextPlan, restrictions: nextRestrictions };
    const days = [];
    for (const date of dates) {
      const context = { stayDate: date, checkIn: date, checkOut: this.addDaysIso(date, 1), nights: 1 };
      const before = creating ? null : await this.calculateDerivedRate(plan.id, dto.propertyId, context, tx, lock);
      const after = await draft.calculateDerivedRate(plan.id, dto.propertyId, context, tx, lock);
      const beforeQuote = creating ? null : await this.roomQuote(tx, plan, date, 1, this), afterQuote = await this.roomQuote(tx, nextPlan, date, 1, draft);
      const sellability = async (rates: RatePlanService) => {
        try { await rates.assertSellable(dto.propertyId, plan.id, date, context.checkOut, tx); return { sellable: true, reason: null }; }
        catch (error) { if (!(error instanceof BadRequestException)) throw error; return { sellable: false, reason: error.message }; }
      };
      days.push({ date, before, after, beforeQuote, afterQuote, beforeSales: creating ? { sellable: false, reason: 'NOT_CREATED' } : await sellability(this), afterSales: await sellability(draft),
        beforeRestrictions: restrictions.filter((row: any) => row.startDate <= date && row.endDate >= date),
        afterRestrictions: nextRestrictions.filter((row: any) => row.startDate <= date && row.endDate >= date) });
    }
    const dependencies: any[] = [];
    let parentId = nextPlan.parentRatePlanId;
    const seen = new Set([plan.id]);
    while (parentId) {
      if (seen.has(parentId)) throw new BadRequestException('Circular derived rate chain');
      seen.add(parentId);
      const parent = await this.findById(parentId, dto.propertyId, tx, lock);
      dependencies.push({ parent, restrictions: await this.findRestrictions(parent.id, dto.propertyId, tx) });
      parentId = parent.parentRatePlanId;
    }
    return this.json({ mode: 'LIVE_PREVIEW', propertyId: dto.propertyId, ratePlanId: plan.id, planRevision: plan.revision,
      stateToken: this.hash({ plan, restrictions, nextPlan, nextRestrictions, dependencies, days, approvalRequired: !!property.settings?.pricingApprovalRequired }),
      currencyCode: plan.currencyCode, approvalRequired: !!property.settings?.pricingApprovalRequired, days, acceptedPricesChanged: false, isEarnedRevenue: false });
  }

  async submitLiveChange(dto: LiveRateChangeDto, actor?: AuditActor) {
    return this.mutate(dto.propertyId, dto, 'rate_change.submit', actor, async tx => {
      const preview = await this.previewIn(tx, dto, true);
      if (!dto.stateToken || dto.stateToken !== preview.stateToken) this.stale();
      const [proposal] = await tx.insert(rateChangeRequests).values({ propertyId: dto.propertyId, ratePlanId: dto.kind === 'plan_create' ? null : dto.ratePlanId,
        expectedPlanRevision: dto.expectedRevision, stateToken: preview.stateToken, reason: dto.reason.trim(),
        change: this.json(dto), preview, requestedBy: this.actorKey(actor) }).returning();
      await this.record(tx, dto.propertyId, 'rate_change', proposal.id, 'submit', null, proposal, dto.reason, actor, 'rate_change.submitted', dto.requestId);
      return proposal;
    });
  }

  async approvalQueue(propertyId: string) {
    await this.property(propertyId, this.db);
    return this.db.select().from(rateChangeRequests).where(and(eq(rateChangeRequests.propertyId, propertyId),
      or(eq(rateChangeRequests.status, 'pending'), eq(rateChangeRequests.status, 'approved')))).orderBy(desc(rateChangeRequests.createdAt)).limit(200);
  }

  async changeHistory(propertyId: string) {
    await this.property(propertyId, this.db);
    return this.db.select().from(rateChangeRequests).where(eq(rateChangeRequests.propertyId, propertyId)).orderBy(desc(rateChangeRequests.createdAt)).limit(200);
  }

  async decideLiveChange(id: string, propertyId: string, action: 'approve' | 'apply' | 'reject', guard: PricingMutationDto, actor?: AuditActor) {
    return this.mutate(propertyId, guard, 'rate_change.' + action + ':' + id, actor, async tx => {
      const [proposal] = await tx.select().from(rateChangeRequests).where(and(eq(rateChangeRequests.id, id), eq(rateChangeRequests.propertyId, propertyId))).for('update');
      if (!proposal) throw new NotFoundException('Rate change not found in this property');
      this.expectRevision(proposal, guard.expectedRevision);
      const property = await this.property(propertyId, tx);
      const required = !!property.settings?.pricingApprovalRequired || !!proposal.preview.approvalRequired;
      let appliedPlanId: string | undefined;
      if (action === 'approve') {
        if (proposal.status !== 'pending') throw new ConflictException('Only pending changes can be approved');
        if (required && (this.actorKey(actor) === 'auth-off' || proposal.requestedBy === this.actorKey(actor))) throw new ForbiddenException('Independent identified approver required');
      } else if (action === 'reject') {
        if (!['pending','approved'].includes(proposal.status)) throw new ConflictException('Terminal change cannot be rejected');
      } else {
        if (!['pending','approved'].includes(proposal.status) || (required && proposal.status !== 'approved')) throw new ConflictException({ code: 'APPROVAL_REQUIRED', message: 'Change is not eligible for application' });
      }
      if (action !== 'reject') {
        const dto = proposal.change as unknown as LiveRateChangeDto;
        const preview = await this.previewIn(tx, dto, true);
        if (preview.stateToken !== proposal.stateToken) this.stale();
        if (action === 'apply') {
          if (dto.kind === 'plan_create') {
            const [created] = await tx.insert(ratePlans).values({ ...this.clean(dto.createPlan), id: dto.requestId, propertyId }).returning();
            appliedPlanId = created.id;
            await this.record(tx, propertyId, 'rate_plan', created.id, 'create', null, created, proposal.reason, actor, 'rate_plan.created', guard.requestId);
          } else {
            const plan = await this.findById(proposal.ratePlanId, propertyId, tx, true);
            if (dto.kind === 'plan') {
              const [next] = await tx.update(ratePlans).set({ ...this.clean(dto.plan), revision: plan.revision + 1, updatedAt: new Date() })
                .where(and(eq(ratePlans.id, plan.id), eq(ratePlans.propertyId, propertyId))).returning();
              await this.record(tx, propertyId, 'rate_plan', plan.id, 'update', plan, next, proposal.reason, actor, 'rate_plan.updated', guard.requestId);
            } else await this.applyRestriction(tx, plan, dto.kind, dto.restrictionId, this.clean(dto.restriction ?? {}), proposal.reason, actor, guard.requestId);
          }
        }
      }
      const status = action === 'approve' ? 'approved' : action === 'apply' ? 'applied' : 'rejected';
      const [next] = await tx.update(rateChangeRequests).set({ status, revision: proposal.revision + 1, updatedAt: new Date(), decisionReason: guard.reason.trim(),
        ...(appliedPlanId ? { ratePlanId: appliedPlanId } : {}),
        ...(action === 'approve' ? { approvedBy: this.actorKey(actor) } : {}) }).where(and(eq(rateChangeRequests.id, id), eq(rateChangeRequests.propertyId, propertyId))).returning();
      await this.record(tx, propertyId, 'rate_change', id, action, proposal, next, guard.reason, actor, 'rate_change.' + (action === 'approve' ? 'approved' : action === 'apply' ? 'applied' : 'rejected') as WebhookEvent, guard.requestId);
      return next;
    });
  }

  private pricingDraft?: { plan: any; restrictions: any[] };
  private reportService() { return this.reports ?? new ReportsService(this.db); }
  private clean(dto: any): any {
    const { requestId: _request, expectedRevision: _revision, reason: _reason, propertyId: _property,
      revision: _serverRevision, id: _id, createdAt: _created, updatedAt: _updated, ...values } = dto;
    return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
  }
  private json(value: any): any { return JSON.parse(JSON.stringify(value)); }
  private hash(value: any): string {
    const stable = (v: any): any => Array.isArray(v) ? v.map(stable) :
      v && typeof v === 'object' && !(v instanceof Date) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v;
    return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
  }
  private actorKey(actor?: AuditActor) { return actor?.userId ?? actor?.userEmail ?? 'auth-off'; }
  private stale(): never { throw new ConflictException({ code: 'STALE_PRICING', message: 'Refresh live rates and preview again' }); }
  private expectRevision(row: any, expected?: number) { if (row.revision !== expected) this.stale(); }
  private async property(propertyId: string, tx: any, lock = false) {
    const query = tx.select().from(properties).where(eq(properties.id, propertyId));
    const [row] = await (lock ? query.for('no key update') : query);
    if (!row) throw new NotFoundException('Property not found');
    return row;
  }
  private async directAllowed(propertyId: string, tx: any) {
    const property = await this.property(propertyId, tx);
    if (property.settings?.pricingApprovalRequired) throw new ConflictException({ code: 'APPROVAL_REQUIRED', message: 'Submit a live preview to the approval queue' });
  }

  private async mutate(propertyId: string, guard: Partial<PricingMutationDto>, action: string, actor: AuditActor | undefined, work: (tx: any) => Promise<any>) {
    if (!guard.requestId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(guard.requestId) ||
      !Number.isInteger(guard.expectedRevision) || guard.expectedRevision! < 0 || !guard.reason?.trim() || guard.reason.length > 1000)
      throw new BadRequestException({ code: 'MUTATION_GUARD_REQUIRED', message: 'requestId, expectedRevision and reason are required' });
    if (!this.outbox) throw new Error('Durable pricing outbox is required');
    const fingerprint = this.hash({ action, guard }), actorKey = this.actorKey(actor);
    return this.db.transaction(async (tx: any) => {
      await this.property(propertyId, tx, true);
      // The unique-key insert serializes first execution, retry and terminal recovery.
      await tx.insert(rateMutationFences).values({ propertyId, requestId: guard.requestId, fingerprint, actorKey, status: 'running' }).onConflictDoNothing();
      const [fence] = await tx.select().from(rateMutationFences).where(and(eq(rateMutationFences.propertyId, propertyId), eq(rateMutationFences.requestId, guard.requestId!))).for('update');
      if (fence.actorKey !== actorKey) throw new ForbiddenException('Request belongs to another actor');
      if (fence.status === 'closed') throw new ConflictException({ code: 'REQUEST_CLOSED', message: 'Use a new requestId' });
      if (fence.fingerprint !== fingerprint) throw new ConflictException({ code: 'REQUEST_CHANGED', message: 'Retry key was used with a different request' });
      if (fence.status === 'committed') return { record: fence.response, replayed: true };
      const record = this.json(await work(tx));
      await tx.update(rateMutationFences).set({ status: 'committed', response: record })
        .where(and(eq(rateMutationFences.propertyId, propertyId), eq(rateMutationFences.requestId, guard.requestId!)));
      return { record, replayed: false };
    });
  }

  async recoverRequest(propertyId: string, requestId: string, actor?: AuditActor, close = false) {
    return this.db.transaction(async (tx: any) => {
      await this.property(propertyId, tx, true);
      if (close) await tx.insert(rateMutationFences).values({ propertyId, requestId, fingerprint: this.hash('closed'), actorKey: this.actorKey(actor), status: 'closed' }).onConflictDoNothing();
      const [row] = await tx.select().from(rateMutationFences).where(and(eq(rateMutationFences.propertyId, propertyId), eq(rateMutationFences.requestId, requestId))).for('update');
      if (!row) return { state: 'unconfirmed' };
      if (row.actorKey !== this.actorKey(actor)) throw new ForbiddenException('Request belongs to another actor');
      if (close && row.status === 'closed') {
        const [existing] = await tx.select().from(auditLogs).where(and(eq(auditLogs.propertyId, propertyId), eq(auditLogs.entityType, 'rate_request'), eq(auditLogs.entityId, requestId), eq(auditLogs.action, 'close')));
        if (!existing) await this.record(tx, propertyId, 'rate_request', requestId, 'close', null, { status: 'closed' }, 'Abandoned pricing request closed', actor, 'rate_request.closed', requestId);
      }
      return { state: row.status, ...(row.status === 'committed' ? { record: row.response } : {}) };
    });
  }

  private async record(tx: any, propertyId: string, entityType: string, entityId: string, action: string, previousValue: any, newValue: any,
    reason: string, actor: AuditActor | undefined, event: WebhookEvent, eventId: string) {
    await tx.insert(auditLogs).values({ propertyId, entityType, entityId, action, previousValue: previousValue ? this.json(previousValue) : null,
      newValue: this.json(newValue), description: reason.trim(), ...actorFields(actor) });
    await this.outbox!.persist(tx, { propertyId, event, entityType, entityId, timestamp: new Date().toISOString(),
      data: { ...this.json(newValue), ratePlanId: newValue.ratePlanId ?? (entityType === 'rate_plan' ? entityId : undefined) } }, 'pricing:' + eventId + ':' + event);
  }

  private async restriction(id: string, propertyId: string, tx: any, ratePlanId?: string) {
    const [row] = await tx.select().from(rateRestrictions).where(and(eq(rateRestrictions.id, id), eq(rateRestrictions.propertyId, propertyId),
      ratePlanId ? eq(rateRestrictions.ratePlanId, ratePlanId) : undefined));
    if (!row) throw new NotFoundException('Rate restriction not found in this plan/property');
    return row;
  }

  private async validatePlan(plan: any, propertyId: string, tx: any, id?: string) {
    const property = await this.property(propertyId, tx);
    for (const key of ['name', 'code', 'type', 'currencyCode', 'isTaxInclusive', 'isActive', 'sortOrder']) {
      if (plan[key] === null) throw new BadRequestException(key + ' cannot be null');
    }
    if (!/^\d+(\.\d{1,2})?$/.test(String(plan.baseAmount)) || new Decimal(plan.baseAmount).gt('9999999999.99')) throw new BadRequestException('Invalid base amount');
    if (plan.currencyCode !== property.currencyCode) throw new BadRequestException('CURRENCY_MISMATCH');
    if (plan.validFrom) reportDate(plan.validFrom);
    if (plan.validTo) reportDate(plan.validTo);
    if (plan.validFrom && plan.validTo && plan.validTo < plan.validFrom) throw new BadRequestException('Invalid plan validity interval');
    for (const [table, value, label] of [[roomTypes, plan.roomTypeId, 'room type'], [cancellationPolicies, plan.cancellationPolicyId, 'cancellation policy'], [groupProfiles, plan.groupProfileId, 'group profile']] as const) {
      if (!value) continue;
      const [row] = await tx.select().from(table).where(and(eq(table.id, value), eq(table.propertyId, propertyId)));
      if (!row) throw new BadRequestException(label + ' not found in this property');
    }
    if (plan.type === 'derived' && (!plan.parentRatePlanId || !['percentage','fixed'].includes(plan.derivedAdjustmentType) ||
      !Number.isFinite(Number(plan.derivedAdjustmentValue)) || plan.derivedAdjustmentValue == null)) throw new BadRequestException('Derived plan requires parent and adjustment');
    if (plan.parentRatePlanId) {
      const seen = new Set<string>(id ? [id] : []);
      let parentId: string | null = plan.parentRatePlanId;
      while (parentId) {
        if (seen.has(parentId)) throw new BadRequestException('Circular derived rate chain');
        seen.add(parentId);
        const parent = await this.findById(parentId, propertyId, tx);
        if (parent.currencyCode !== plan.currencyCode) throw new BadRequestException('Parent currency mismatch');
        parentId = parent.parentRatePlanId;
      }
    }
  }

  private validateRestriction(row: any) {
    for (const key of ['closedToArrival', 'closedToDeparture', 'isClosed']) {
      if (row[key] === null) throw new BadRequestException(key + ' cannot be null');
    }
    reportDates(row.startDate, row.endDate);
    if (row.minLos != null && (!Number.isInteger(row.minLos) || row.minLos < 1)) throw new BadRequestException('Invalid minLos');
    if (row.maxLos != null && (!Number.isInteger(row.maxLos) || row.maxLos < 1)) throw new BadRequestException('Invalid maxLos');
    if (row.minLos && row.maxLos && row.minLos > row.maxLos) throw new BadRequestException('minLos exceeds maxLos');
    if (row.rateOverride != null && (!/^\d+(\.\d{1,2})?$/.test(String(row.rateOverride)) || new Decimal(row.rateOverride).gt('9999999999.99'))) throw new BadRequestException('Invalid nightly override');
    if (row.rateOverride != null && !row.overrideReason?.trim()) throw new BadRequestException('A reason is required for a manual rate override');
    for (const [day, amount] of Object.entries(row.dayOfWeekOverrides ?? {})) {
      if (!['sunday','monday','tuesday','wednesday','thursday','friday','saturday'].includes(day) || !Number.isFinite(amount) ||
        !new Decimal(amount as number).times(100).isInteger()) throw new BadRequestException('Invalid day-of-week adjustment');
    }
  }

  private async applyRestriction(tx: any, plan: any, kind: string, id: string | undefined, values: any, reason: string, actor: AuditActor | undefined, requestId: string) {
    const before = id ? await this.restriction(id, plan.propertyId, tx, plan.id) : null;
    let next: any;
    if (kind === 'restriction_delete') {
      await tx.delete(rateRestrictions).where(and(eq(rateRestrictions.id, id!), eq(rateRestrictions.propertyId, plan.propertyId), eq(rateRestrictions.ratePlanId, plan.id)));
      next = { ...before, deleted: true };
    } else {
      const merged = { ...before, ...values, propertyId: plan.propertyId, ratePlanId: plan.id };
      if (values.rateOverride !== undefined) {
        merged.overrideReason = values.rateOverride === null ? null : (values.overrideReason ?? reason).trim();
        merged.overrideBy = actor?.userId ?? null;
      }
      this.validateRestriction(merged);
      this.rejectAmbiguousOverrides(await this.findRestrictions(plan.id, plan.propertyId, tx), merged, id);
      if (id) {
        const { id: _id, createdAt: _createdAt, ...patch } = merged;
        [next] = await tx.update(rateRestrictions).set({ ...patch, revision: before.revision + 1, updatedAt: new Date() })
          .where(and(eq(rateRestrictions.id, id), eq(rateRestrictions.propertyId, plan.propertyId), eq(rateRestrictions.ratePlanId, plan.id))).returning();
      } else [next] = await tx.insert(rateRestrictions).values(merged).returning();
    }
    await tx.update(ratePlans).set({ revision: plan.revision + 1, updatedAt: new Date() }).where(and(eq(ratePlans.id, plan.id), eq(ratePlans.propertyId, plan.propertyId)));
    const event = kind === 'restriction_create' ? 'rate_restriction.created' : kind === 'restriction_delete' ? 'rate_restriction.deleted' : 'rate_restriction.updated';
    await this.record(tx, plan.propertyId, 'rate_restriction', next.id, kind === 'restriction_delete' ? 'delete' : kind === 'restriction_create' ? 'create' : 'update',
      before, next, reason, actor, event, requestId);
    return { ...next, planRevision: plan.revision + 1 };
  }

  private rejectAmbiguousOverrides(rows: any[], next: any, id?: string) {
    if (next.rateOverride == null && !Object.keys(next.dayOfWeekOverrides ?? {}).length) return;
    if (rows.some(row => row.id !== id && row.startDate <= next.endDate && row.endDate >= next.startDate &&
      (row.rateOverride != null || Object.keys(row.dayOfWeekOverrides ?? {}).length)))
      throw new ConflictException({ code: 'OVERLAPPING_RATE_OVERRIDE', message: 'Update or remove the existing monetary override first' });
  }

  private addDaysIso(dateStr: string, days: number): string {
    return new Date(Date.parse(dateStr + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
  }
}

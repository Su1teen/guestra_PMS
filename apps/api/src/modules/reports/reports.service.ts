import { Injectable, Inject, NotFoundException, BadRequestException } from '@nestjs/common';
import { eq, and, or, sql, lte, gte, inArray, ne } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import Decimal from 'decimal.js';
import {
  charges,
  payments,
  reservations,
  bookings,
  folios,
  auditRuns,
  properties,
  rooms,
  depositLedgerEntries,
  arLedgers,
  arTransactions,
  roomInventoryBlocks,
  roomTypes,
  managementInputs,
} from '@telivityhaip/database';
import { MANAGEMENT_REVENUE_ARTICLES, MANAGEMENT_EXPENSE_ARTICLES, MANAGEMENT_LABELS, managementGroup, type ManagementMetrics, type ManagementRow, type ManagementReportData, type ManagementInput } from '@telivityhaip/shared';
import { DRIZZLE } from '../../database/database.module';
import { reportPaymentSumWhere } from '../payment/payment-ledger';
import { reportDate, reportDates, priorYearDate, ratio } from './reporting-policy';
import { activeInventoryBlockConditions, dayAfter } from '../room/room-inventory-policy';

@Injectable()
export class ReportsService {
  constructor(@Inject(DRIZZLE) private readonly db: any) {}

  private inSnapshot = false;

  private async snapshot<T>(read: (service: ReportsService) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx: any) => {
      const service = new ReportsService(tx);
      service.inSnapshot = true;
      return read(service);
    }, { isolationLevel: 'repeatable read', readOnly: true });
  }

  private async context(propertyId: string, date?: string) {
    const [property] = await this.db.select().from(properties).where(eq(properties.id, propertyId));
    if (!property) throw new NotFoundException('Property not found');
    const [lastAudit] = await this.db.select().from(auditRuns).where(and(
      eq(auditRuns.propertyId, propertyId), eq(auditRuns.status, 'completed'),
    )).orderBy(sql`${auditRuns.businessDate} desc`).limit(1);
    const localToday = new Intl.DateTimeFormat('en-CA', { timeZone: property.timezone,
      year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const operationalDate = lastAudit ? dayAfter(lastAudit.businessDate) : localToday;
    return { property, date: reportDate(date ?? operationalDate), operationalDate };
  }

  async getBusinessDate(propertyId: string) {
    const { property, operationalDate } = await this.context(propertyId);
    return { propertyId, date: operationalDate, timezone: property.timezone, currencyCode: property.currencyCode,
      source: 'completed_night_audit_or_property_local_today' };
  }

  async getManagementReport(propertyId: string, startDate: string, endDate: string, requestedDate?: string): Promise<ManagementReportData> {
    reportDates(startDate,endDate);
    if (!this.inSnapshot) return this.snapshot(s => s.getManagementReport(propertyId,startDate,endDate,requestedDate));
    const { property,date,operationalDate:businessDate } = await this.context(propertyId,requestedDate);
    const effective = [date,businessDate,endDate].sort()[0]!;
    const cutoff = effective < startDate ? null : effective;
    const lyStart = priorYearDate(startDate), lyEnd = priorYearDate(endDate), lyCutoff = cutoff ? priorYearDate(cutoff) : null;
    const [fullLy, toDateLy, current, versions, periods] = await Promise.all([
      this.ledger(propertyId,lyStart,lyEnd,property.currencyCode),
      lyCutoff ? this.ledger(propertyId,lyStart,lyCutoff,property.currencyCode) : null,
      cutoff ? this.ledger(propertyId,startDate,cutoff,property.currencyCode) : null,
      Promise.all(['budget','expenses'].map(kind => this.db.select().from(managementInputs).where(and(eq(managementInputs.propertyId,propertyId),eq(managementInputs.startDate,startDate),eq(managementInputs.endDate,endDate),eq(managementInputs.kind,kind))).orderBy(sql`${managementInputs.revision} desc`).limit(1))).then(rows => rows.flat()),
      cutoff ? this.getRevenuePeriods(propertyId,cutoff) : null,
    ]);
    const budget = versions.find((v: any) => v.kind === 'budget') ?? null;
    const expense = versions.find((v: any) => v.kind === 'expenses') ?? null;
    for (const input of [budget,expense]) if (input && input.currencyCode !== property.currencyCode) this.assertCurrency([input],property.currencyCode,'management_inputs');
    const inputSum = (input: any, articles: readonly string[], through: string|null) => {
      if (!input || !through) return null;
      const entries = input.entries.filter((e: any) => articles.includes(e.article) && e.date <= through);
      if (input.kind === 'expenses' && !entries.length && (!input.coverageThrough || input.coverageThrough < through)) return null;
      return entries.reduce((sum: Decimal,e: any) => sum.plus(e.amount),new Decimal(0)).toNumber();
    };
    const ledgerSum = (ledger: typeof current, articles: readonly string[]) => !ledger || ledger.actual.value === null ? null : articles.reduce((sum,a) => sum.plus(ledger.revenueByType[a] ?? 0),new Decimal(0)).toNumber();
    const metrics = (articles: readonly string[], kind: 'revenue'|'expense'): ManagementMetrics => {
      const actual = kind === 'revenue' ? ledgerSum(current,articles) : inputSum(expense,articles,cutoff);
      const plan = inputSum(budget,articles,endDate), planToDate = inputSum(budget,articles,cutoff);
      return { actual,plan,planToDate,ly:kind === 'revenue' ? ledgerSum(fullLy,articles) : null,lytd:kind === 'revenue' ? ledgerSum(toDateLy,articles) : null,
        attainment:actual === null || plan === null || plan === 0 ? null : new Decimal(actual).div(plan).mul(100).toDecimalPlaces(2).toNumber(),
        toDateVariance:actual === null || planToDate === null ? null : new Decimal(actual).minus(planToDate).toNumber(),
        remaining:actual === null || plan === null ? null : new Decimal(plan).minus(actual).toNumber(),forecast:null };
    };
    const row = (id: string,label: string,depth: number,articles: readonly string[],kind: 'revenue'|'expense',children?: ManagementRow[]): ManagementRow => ({ id:`${propertyId}:${id}`,propertyId,label,depth,article:depth === 2 ? articles[0] : undefined,metrics:metrics(articles,kind),children });
    const revenueChildren = ['accommodation','fnb','ancillary'].map(group => {
      const articles = MANAGEMENT_REVENUE_ARTICLES.filter(a => managementGroup(a) === group);
      return row(group,MANAGEMENT_LABELS[group]!,1,articles,'revenue',articles.map(a => row(a,MANAGEMENT_LABELS[a]!,2,[a],'revenue')));
    });
    const expenseChildren = MANAGEMENT_EXPENSE_ARTICLES.map(a => row(`expense-${a}`,MANAGEMENT_LABELS[a]!,1,[a],'expense',[row(`expense-article-${a}`,MANAGEMENT_LABELS[a]!,2,[a],'expense')]));
    const revenue = metrics(MANAGEMENT_REVENUE_ARTICLES,'revenue'), expenses = metrics(MANAGEMENT_EXPENSE_ARTICLES,'expense');
    const expenseComplete = !!cutoff && !!expense?.coverageThrough && expense.coverageThrough >= cutoff;
    const canCalculateResult = current?.actual.status === 'COMPLETE' && expenseComplete;
    const dailyLedger = cutoff ? await this.ledgerRows(propertyId,startDate,cutoff,property.currencyCode) : [];
    const closedDays = cutoff ? await this.db.select({date:auditRuns.businessDate}).from(auditRuns).where(and(eq(auditRuns.propertyId,propertyId),eq(auditRuns.status,'completed'),gte(auditRuns.businessDate,startDate),lte(auditRuns.businessDate,cutoff))) : [];
    const dailyFinancial = cutoff ? await this.getFinancialSummary(propertyId,cutoff) : null;
    const dailyOccupancy = cutoff ? await this.getOccupancy(propertyId,cutoff) : null;
    const previousDay = cutoff ? new Date(Date.parse(cutoff)-86400000).toISOString().slice(0,10) : null;
    const pickup = cutoff ? await this.getPickup(propertyId,cutoff,previousDay!,cutoff) : null;
    const pace = cutoff ? await this.getBookingPace(propertyId,cutoff,cutoff) : null;
    return { propertyId,propertyName:property.name,currencyCode:property.currencyCode,timezone:property.timezone,
      period:{ start:startDate,end:endDate,cutoff,businessDate,lyStart,lyEnd,lyCutoff },
      revenueRows:[row('revenue',property.name,0,MANAGEMENT_REVENUE_ARTICLES,'revenue',revenueChildren)],
      expenseRows:[row('expense',property.name,0,MANAGEMENT_EXPENSE_ARTICLES,'expense',expenseChildren)],
      totals:{ revenue,expenses,operatingResult:canCalculateResult ? new Decimal(revenue.actual!).minus(expenses.actual!).toNumber() : null },
      sources:{ actual:current?.actual.status ?? 'NO_DATA',history:fullLy.actual.value === null ? 'NO_DATA' : fullLy.actual.status,
        budget:budget ? 'CONFIGURED' : 'NOT_CONFIGURED',expenses:expense ? expenseComplete ? 'COMPLETE' : 'PARTIAL' : 'NOT_CONFIGURED',forecast:'INSUFFICIENT_HISTORY',operatingResult:canCalculateResult ? 'COMPLETE' : 'INSUFFICIENT_DATA' },
      inputs:{ budget:budget as ManagementInput|null,expenses:expense as ManagementInput|null },
      executive:dailyFinancial && dailyOccupancy ? {date:cutoff!,occupancy:dailyFinancial.kpis.occ,adr:dailyFinancial.kpis.ratioStatus.adr !== 'AVAILABLE' || dailyFinancial.actual.value === null ? null : dailyFinancial.kpis.adr,revpar:dailyFinancial.kpis.ratioStatus.revpar !== 'AVAILABLE' || dailyFinancial.actual.value === null ? null : dailyFinancial.kpis.revpar,
        arrivals:dailyOccupancy.arrivals,departures:dailyOccupancy.departures,cancellations:dailyOccupancy.cancellations,noShows:dailyOccupancy.noShows,
        receivedPayments:dailyFinancial.cash.received,refunds:dailyFinancial.cash.refunds,heldDeposits:dailyFinancial.deposits.held,separatelyPostedTax:dailyFinancial.kpis.separatelyPostedTax,pickup:pickup?.pickup.roomNights ?? null,pace:pace?.daily[0]?.roomsOnBooks ?? null} : null,
      periods:periods?.periods ?? {},
      daily:reportDates(startDate,endDate).map(d => {
        const postings = dailyLedger.filter((r: any) => r.date === d && r.type !== 'tax');
        const expenseEntries = expense?.entries.filter((e:any)=>e.date===d) ?? [];
        return { date:d,actual:d > (cutoff ?? '') || (!postings.length && !closedDays.some((day:any)=>day.date===d)) ? null : postings.reduce((sum: Decimal,r: any) => sum.plus(r.total),new Decimal(0)).toNumber(),
          plan:budget ? budget.entries.filter((e: any) => MANAGEMENT_REVENUE_ARTICLES.includes(e.article) && e.date === d).reduce((sum: Decimal,e: any) => sum.plus(e.amount),new Decimal(0)).toNumber() : null,
          expenses:expense && cutoff && d <= cutoff && (expenseEntries.length || (expense.coverageThrough && expense.coverageThrough >= d)) ? expenseEntries.reduce((sum:Decimal,e:any)=>sum.plus(e.amount),new Decimal(0)).toNumber() : null,
          expensePlan:budget ? budget.entries.filter((e:any)=>(MANAGEMENT_EXPENSE_ARTICLES as readonly string[]).includes(e.article)&&e.date===d).reduce((sum:Decimal,e:any)=>sum.plus(e.amount),new Decimal(0)).toNumber() : null };
      }) };
  }

  async getManagementOperations(propertyId: string, startDate: string, endDate: string, article?: string, offset = 0) {
    reportDates(startDate,endDate);
    if (article && !(MANAGEMENT_REVENUE_ARTICLES as readonly string[]).includes(article)) throw new BadRequestException('Неизвестная статья');
    if (!Number.isInteger(offset) || offset < 0 || offset > 100000) throw new BadRequestException('Некорректная страница');
    // Same provenance classification as ledgerRows, including reversals of room amendments.
    const parent = alias(charges,'management_parent');
    const original = alias(charges,'management_original');
    const originalParent = alias(charges,'management_original_parent');
    const category = sql<string>`case when ${charges.type} = 'adjustment' and (${parent.type} = 'room' or (${charges.isReversal} = true and ${originalParent.type} = 'room')) then 'room' else ${charges.type}::text end`;
    return this.db.select({ id:charges.id,folioId:charges.folioId,date:this.serviceDay(),article:category,description:charges.description,amount:charges.amount,currencyCode:charges.currencyCode,isReversal:charges.isReversal }).from(charges)
      .leftJoin(parent,and(eq(parent.id,charges.parentChargeId),eq(parent.propertyId,propertyId)))
      .leftJoin(original,and(eq(original.id,charges.originalChargeId),eq(original.propertyId,propertyId)))
      .leftJoin(originalParent,and(eq(originalParent.id,original.parentChargeId),eq(originalParent.propertyId,propertyId)))
      .where(and(eq(charges.propertyId,propertyId),gte(this.serviceDay(),startDate),lte(this.serviceDay(),endDate),ne(charges.revenueRole,'deposit_credit'),ne(charges.type,'tax'),article ? eq(category,article) : undefined))
      .orderBy(charges.serviceDate,charges.id).limit(100).offset(offset);
  }

  /** serviceDate is an explicit UTC-encoded business-date label, not posting time. */
  private serviceDay() { return sql<string>`(${charges.serviceDate} at time zone 'UTC')::date`; }

  private localDay(column: any, timezone: string) {
    return sql<string>`(${column} at time zone ${timezone})::date`;
  }

  private bookingDate(value: string, timezone: string) {
    if (typeof value !== 'string') throw new BadRequestException('Booking-window date is required');
    if (!value.includes('T')) return reportDate(value);
    if (!/(Z|[+-]\d{2}:\d{2})$/.test(value)) throw new BadRequestException('Timestamp must include an explicit timezone');
    const timestamp = new Date(value);
    if (!Number.isFinite(timestamp.getTime())) throw new BadRequestException('Invalid booking-window timestamp');
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit' }).format(timestamp);
  }

  private assertCurrency(rows: any[], currencyCode: string, source: string) {
    if (rows.some(row => row.currencyCode !== currencyCode)) {
      throw new BadRequestException({ statusCode: 400, code: 'CURRENCY_MISMATCH',
        message: 'CURRENCY_MISMATCH: ledger requires explicit currency conversion', expectedCurrency: currencyCode, source });
    }
  }

  private categories(values: Record<string, Decimal>) {
    const room = values['room'] ?? new Decimal(0);
    const tax = values['tax'] ?? new Decimal(0);
    const foodBeverage = values['food_beverage'] ?? new Decimal(0);
    const other = Object.entries(values).filter(([type]) => !['room', 'tax', 'food_beverage'].includes(type))
      .reduce((sum, [, amount]) => sum.plus(amount), new Decimal(0));
    const earned = room.plus(foodBeverage).plus(other);
    return { room: room.toNumber(), tax: tax.toNumber(), foodBeverage: foodBeverage.toNumber(),
      other: other.toNumber(), total: earned.plus(tax).toNumber(), earned: earned.toNumber() };
  }

  private async ledgerRows(propertyId: string, start: string, end: string, currencyCode: string) {
    reportDates(start, end);
    const parent = alias(charges, 'financial_parent_charge');
    const reversedOriginal = alias(charges, 'financial_reversed_charge');
    const reversedParent = alias(charges, 'financial_reversed_parent');
    const category = sql<string>`case when ${charges.type} = 'adjustment'
      and (${parent.type} = 'room' or (${charges.isReversal} = true and ${reversedParent.type} = 'room'))
      then 'room' else ${charges.type}::text end`;
    const rows = await this.db.select({
      date: this.serviceDay(),
      type: category, currencyCode: charges.currencyCode, isReversal: charges.isReversal,
      total: sql<string>`coalesce(sum(${charges.amount}::numeric), 0)`,
      count: sql<number>`count(*)::int`,
    }).from(charges).leftJoin(parent, and(eq(parent.propertyId, propertyId), eq(parent.id, charges.parentChargeId)))
      .leftJoin(reversedOriginal, and(eq(reversedOriginal.propertyId, propertyId), eq(reversedOriginal.id, charges.originalChargeId)))
      .leftJoin(reversedParent, and(eq(reversedParent.propertyId, propertyId), eq(reversedParent.id, reversedOriginal.parentChargeId)))
      .where(and(eq(charges.propertyId, propertyId),
      gte(this.serviceDay(), start), lte(this.serviceDay(), end),
      ne(charges.revenueRole, 'deposit_credit'),
    )).groupBy(this.serviceDay(), category, charges.currencyCode, charges.isReversal);
    this.assertCurrency(rows, currencyCode, 'charges');
    return rows;
  }

  /** One signed charge aggregation for every reporting consumer; tax is not earned revenue. */
  private async ledger(propertyId: string, start: string, end: string, currencyCode: string) {
    const rows = await this.ledgerRows(propertyId, start, end, currencyCode);
    const gross: Record<string, Decimal> = {};
    const net: Record<string, Decimal> = {};
    let signedReversals = new Decimal(0);
    let chargeCount = 0;
    for (const row of rows) {
      const amount = new Decimal(row.total);
      net[row.type] = (net[row.type] ?? new Decimal(0)).plus(amount);
      chargeCount += Number(row.count);
      if (row.isReversal) signedReversals = signedReversals.plus(amount);
      else gross[row.type] = (gross[row.type] ?? new Decimal(0)).plus(amount);
    }
    const posted = this.categories(net);
    const [coverage] = await this.db.select({ count: sql<number>`count(*)::int` }).from(auditRuns)
      .where(and(eq(auditRuns.propertyId, propertyId), eq(auditRuns.status, 'completed'),
        gte(auditRuns.businessDate, start), lte(auditRuns.businessDate, end)));
    const expectedDays = reportDates(start, end).length;
    const closedDays = Number(coverage?.count ?? 0);
    const status = closedDays === expectedDays ? 'COMPLETE' : chargeCount > 0 ? 'PARTIAL' : 'NO_POSTINGS';
    return { revenue: this.categories(gross), net: posted, revenueByType: Object.fromEntries(
      Object.entries(net).map(([type, amount]) => [type, amount.toNumber()])),
      signedReversals: signedReversals.toNumber(), chargeCount, closedDays, expectedDays,
      actual: { value: status === 'NO_POSTINGS' ? null : posted.earned, status,
        source: 'charges.serviceDate', closedDays, expectedDays } };
  }

  private async cash(propertyId: string, date: string, timezone: string, currencyCode: string) {
    const rows = await this.db.select({
      method: payments.method, currencyCode: payments.currencyCode,
      total: sql<string>`coalesce(sum(${payments.amount}::numeric), 0)`,
      received: sql<string>`coalesce(sum(case when ${payments.amount}::numeric > 0 then ${payments.amount}::numeric else 0 end), 0)`,
      refunded: sql<string>`coalesce(sum(case when ${payments.amount}::numeric < 0 then -${payments.amount}::numeric else 0 end), 0)`,
    }).from(payments).where(and(reportPaymentSumWhere(propertyId),
      eq(this.localDay(payments.processedAt, timezone), date))).groupBy(payments.method, payments.currencyCode);
    this.assertCurrency(rows, currencyCode, 'payments');
    const byMethod: Record<string, number> = {};
    let received = new Decimal(0), refunds = new Decimal(0), transfers = new Decimal(0);
    for (const row of rows) {
      byMethod[row.method] = new Decimal(row.total).toNumber();
      if (row.method === 'city_ledger') transfers = transfers.plus(row.total);
      else { received = received.plus(row.received); refunds = refunds.plus(row.refunded); }
    }
    const total = Object.values(byMethod).reduce((sum, value) => sum.plus(value), new Decimal(0));
    return { byMethod, ledgerNet: total.toNumber(), received: received.toNumber(), refunds: refunds.toNumber(),
      net: received.minus(refunds).toNumber(), arTransfers: transfers.toNumber() };
  }

  async getDailyRevenue(propertyId: string, requestedDate?: string) {
    if (requestedDate) reportDate(requestedDate);
    return this.inSnapshot ? this.readDailyRevenue(propertyId, requestedDate) : this.snapshot(service => service.readDailyRevenue(propertyId, requestedDate));
  }

  private async readDailyRevenue(propertyId: string, requestedDate?: string) {
    const { property, date } = await this.context(propertyId, requestedDate);
    const [ledger, cash] = await Promise.all([
      this.ledger(propertyId, date, date, property.currencyCode),
      this.cash(propertyId, date, property.timezone, property.currencyCode),
    ]);
    return { date, propertyId, currencyCode: property.currencyCode, timezone: property.timezone,
      revenue: ledger.revenue, revenueByType: ledger.revenueByType,
      payments: { ...cash.byMethod, total: cash.ledgerNet }, cash,
      adjustments: ledger.signedReversals === 0 ? 0 : -ledger.signedReversals,
      netRevenue: ledger.net.total, netEarnedRevenue: ledger.net.earned,
      netRevenueByCategory: ledger.net, separatelyPostedTax: ledger.net.tax, actual: ledger.actual };
  }

  private async inventory(propertyId: string, endDate: string, timezone: string, roomTypeId?: string) {
    const [physical, blocks] = await Promise.all([
      this.db.select().from(rooms).where(and(eq(rooms.propertyId, propertyId), eq(rooms.isActive, true), roomTypeId ? eq(rooms.roomTypeId, roomTypeId) : undefined)),
      this.db.select().from(roomInventoryBlocks).where(or(
        activeInventoryBlockConditions(propertyId, dayAfter(endDate)),
        and(eq(roomInventoryBlocks.propertyId, propertyId), eq(roomInventoryBlocks.status, 'released'),
          lte(roomInventoryBlocks.startDate, endDate)),
      )),
    ]);
    return (date: string) => {
      const blocked = new Map<string, string>();
      for (const room of physical) {
        if (room.status === 'out_of_order') blocked.set(room.id, 'OOO');
        if (room.status === 'out_of_service') blocked.set(room.id, 'OOS');
      }
      for (const block of blocks) {
        const releasedDay = block.releasedAt ? new Intl.DateTimeFormat('en-CA', {
          timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(block.releasedAt) : null;
        if (block.startDate <= date && (block.status === 'active' || (releasedDay && date < releasedDay)) &&
          physical.some((room: any) => room.id === block.roomId)) {
          if (blocked.get(block.roomId) !== 'OOO') blocked.set(block.roomId, block.kind);
        }
      }
      return { totalRooms: physical.length,
        outOfOrder: [...blocked.values()].filter(kind => kind === 'OOO').length,
        outOfService: [...blocked.values()].filter(kind => kind === 'OOS').length,
        availableRooms: physical.length - blocked.size, inventorySource: 'active_rooms_and_inventory_blocks',
        inventoryHistoryStatus: 'CURRENT_ROOM_ROSTER_WITH_DATED_BLOCKS' };
    };
  }

  async getOccupancy(propertyId: string, requestedDate?: string) {
    return this.inSnapshot ? this.readOccupancy(propertyId, requestedDate) : this.snapshot(service => service.readOccupancy(propertyId, requestedDate));
  }

  /** Commercial on-books signals are not realised occupancy or earned revenue. */
  async getOnBooksOccupancy(propertyId: string, date: string, db?: any) {
    const read = async (service: ReportsService) => {
      const { property } = await service.context(propertyId, date);
      const inventory = await service.inventory(propertyId, date, property.timezone);
      const stock = inventory(date);
      const [row] = await service.db.select({ count: sql<number>`count(*)::int` }).from(reservations).where(and(
        eq(reservations.propertyId, propertyId), lte(reservations.arrivalDate, date), sql`${reservations.departureDate} > ${date}`,
        inArray(reservations.status, ['pending','confirmed','assigned','checked_in','stayover','due_out','checked_out'] as any),
      ));
      return { ...stock, roomsOnBooks: Number(row?.count ?? 0), occ: ratio(Number(row?.count ?? 0), stock.availableRooms, 4) };
    };
    if (db) { const service = new ReportsService(db); service.inSnapshot = true; return read(service); }
    return this.inSnapshot ? read(this) : this.snapshot(read);
  }

  async getRevenueSignals(propertyId: string, startDate: string, endDate: string, roomTypeId?: string, db?: any) {
    if (db) {
      const service = new ReportsService(db);
      service.inSnapshot = true;
      return service.readRevenueSignals(propertyId, startDate, endDate, roomTypeId);
    }
    return this.inSnapshot ? this.readRevenueSignals(propertyId, startDate, endDate, roomTypeId) :
      this.snapshot(service => service.readRevenueSignals(propertyId, startDate, endDate, roomTypeId));
  }

  private async readRevenueSignals(propertyId: string, startDate: string, endDate: string, roomTypeId?: string) {
    const dates = reportDates(startDate, endDate);
    if (dates.length > 93) throw new BadRequestException('Live calendar supports at most 93 days');
    const { property, operationalDate } = await this.context(propertyId);
    if (roomTypeId) {
      const [category] = await this.db.select().from(roomTypes).where(and(eq(roomTypes.id, roomTypeId), eq(roomTypes.propertyId, propertyId)));
      if (!category) throw new NotFoundException('Room category not found in this property');
    }
    const inventory = await this.inventory(propertyId, endDate, property.timezone, roomTypeId);
    const pace = await this.readBookingPace(propertyId, startDate, endDate, roomTypeId);
    const pickupFrom = new Date(Date.parse(operationalDate + 'T00:00:00Z') - 6 * 86400000).toISOString().slice(0, 10);
    const daily = [];
    for (const date of dates) {
      const stock = inventory(date);
      const roomsOnBooks = pace.daily.find((day: any) => day.date === date)?.roomsOnBooks ?? 0;
      const pickup = await this.readPickup(propertyId, date, pickupFrom, operationalDate, roomTypeId);
      const [realised] = await this.db.select({ count: sql<number>`count(*)::int` }).from(reservations).where(and(
        eq(reservations.propertyId, propertyId), roomTypeId ? eq(reservations.roomTypeId, roomTypeId) : undefined,
        lte(reservations.arrivalDate, date), sql`${reservations.departureDate} > ${date}`,
        inArray(reservations.status, ['checked_in', 'stayover', 'due_out', 'checked_out'] as any),
      ));
      daily.push({ date, ...stock, roomsOnBooks, onBooksOccupancy: ratio(roomsOnBooks, stock.availableRooms, 4),
        realisedRooms: Number(realised?.count ?? 0), realisedOccupancy: ratio(Number(realised?.count ?? 0), stock.availableRooms, 4),
        pickup: pickup.pickup, pickupPeriod: pickup.period, pickupBaseline: pickup.baseline,
        pickupSource: pickup.source, historicalAmendmentsReconstructed: false });
    }
    const financial = await this.getFinancialSummary(propertyId, operationalDate);
    return { propertyId, roomTypeId: roomTypeId ?? null, currencyCode: property.currencyCode, timezone: property.timezone,
      operationalDate, startDate, endDate, source: 'ReportsService', synthetic: false,
      kpiScope: 'property_operational_date', kpis: financial.kpis, actual: financial.actual,
      daily, pace: { ...pace, historicalAmendmentsReconstructed: false },
      forecast: { status: 'INSUFFICIENT_HISTORY', value: null, source: null,
        reason: 'No validated non-synthetic commercial forecast in the reporting domain' } };
  }

  private async readOccupancy(propertyId: string, requestedDate?: string) {
    const { property, date } = await this.context(propertyId, requestedDate);
    const inventory = await this.inventory(propertyId, date, property.timezone);
    const stock = inventory(date);
    const count = async (condition: any) => {
      const [row] = await this.db.select({ count: sql<number>`count(*)::int` }).from(reservations)
        .where(and(eq(reservations.propertyId, propertyId), condition));
      return Number(row?.count ?? 0);
    };
    const covers = and(lte(reservations.arrivalDate, date), sql`${reservations.departureDate} > ${date}`);
    const [occupiedRooms, arrivals, departures, stayovers, noShows, cancellations] = await Promise.all([
      count(and(covers, inArray(reservations.status, ['checked_in','stayover','due_out','checked_out'] as any))),
      count(eq(this.localDay(reservations.checkedInAt, property.timezone), date)),
      count(eq(this.localDay(reservations.checkedOutAt, property.timezone), date)),
      count(and(covers, inArray(reservations.status, ['checked_in','stayover','due_out'] as any))),
      count(and(eq(reservations.status, 'no_show'), eq(reservations.arrivalDate, date))),
      count(eq(this.localDay(reservations.cancelledAt, property.timezone), date)),
    ]);
    const occ = ratio(occupiedRooms, stock.availableRooms, 4);
    return { date, ...stock, occupiedRooms, occupancyRate: occ ?? 0,
      occ, occupancyPercent: occ === null ? 'N/A' : `${(occ * 100).toFixed(1)}%`,
      arrivals, departures, stayovers, noShows, cancellations };
  }

  async getFinancialSummary(propertyId: string, date?: string) {
    if (date) reportDate(date);
    return this.inSnapshot ? this.readFinancialSummary(propertyId, date) : this.snapshot(service => service.readFinancialSummary(propertyId, date));
  }

  private async readFinancialSummary(propertyId: string, requestedDate?: string) {
    const { date } = await this.context(propertyId, requestedDate);
    const [daily, occupancy] = await Promise.all([this.getDailyRevenue(propertyId, date), this.getOccupancy(propertyId, date)]);
    const [balances, deposits, lastAudit, receivables] = await Promise.all([
      this.db.select({ currencyCode: folios.currencyCode, count: sql<number>`count(*)::int`,
        totalBalance: sql<string>`coalesce(sum(greatest(${folios.balance}::numeric, 0)), 0)`,
        credits: sql<string>`coalesce(sum(least(${folios.balance}::numeric, 0)), 0)`,
      }).from(folios).where(and(eq(folios.propertyId, propertyId), eq(folios.status, 'open')))
        .groupBy(folios.currencyCode),
      this.db.select({ status: depositLedgerEntries.status, currencyCode: depositLedgerEntries.currencyCode,
        total: sql<string>`coalesce(sum(${depositLedgerEntries.amount}::numeric), 0)`,
      }).from(depositLedgerEntries).where(eq(depositLedgerEntries.propertyId, propertyId))
        .groupBy(depositLedgerEntries.status, depositLedgerEntries.currencyCode),
      this.db.select().from(auditRuns).where(and(eq(auditRuns.propertyId, propertyId),
        lte(auditRuns.businessDate, daily.date))).orderBy(sql`${auditRuns.businessDate} desc`).limit(1),
      this.db.select({ currencyCode: arLedgers.currencyCode,
        due: sql<string>`coalesce(sum(greatest(${arLedgers.balance}::numeric, 0)), 0)`,
        credits: sql<string>`coalesce(sum(least(${arLedgers.balance}::numeric, 0)), 0)`,
      }).from(arLedgers).where(and(eq(arLedgers.propertyId, propertyId), eq(arLedgers.status, 'open')))
        .groupBy(arLedgers.currencyCode),
    ]);
    this.assertCurrency(balances, daily.currencyCode, 'folios'); this.assertCurrency(deposits, daily.currencyCode, 'deposits');
    const receivablesMatch = receivables.every((row: any) => row.currencyCode === daily.currencyCode);
    const balance = balances[0];
    const byStatus = Object.fromEntries(deposits.map((row: any) => [row.status, Number(row.total)]));
    const adr = ratio(daily.netRevenueByCategory.room, occupancy.occupiedRooms);
    const revpar = ratio(daily.netRevenueByCategory.room, occupancy.availableRooms);
    const trevpar = ratio(daily.netEarnedRevenue, occupancy.availableRooms);
    return { date: daily.date, propertyId, currencyCode: daily.currencyCode, timezone: daily.timezone,
      kpis: { adr: adr ?? 0, revpar: revpar ?? 0, trevpar, occ: occupancy.occ,
        occupancyRate: occupancy.occupancyRate, totalRevenue: daily.netEarnedRevenue,
        roomRevenue: daily.netRevenueByCategory.room, foodBeverageRevenue: daily.netRevenueByCategory.foodBeverage,
        ancillaryRevenue: daily.netRevenueByCategory.other, separatelyPostedTax: daily.separatelyPostedTax,
        roomsSold: occupancy.occupiedRooms, availableRooms: occupancy.availableRooms,
        ratioStatus: { adr: adr === null ? 'NO_ROOMS_SOLD' : 'AVAILABLE',
          revpar: revpar === null ? 'NO_AVAILABLE_INVENTORY' : 'AVAILABLE',
          trevpar: trevpar === null ? 'NO_AVAILABLE_INVENTORY' : 'AVAILABLE',
          occ: occupancy.occ === null ? 'NO_AVAILABLE_INVENTORY' : 'AVAILABLE' } },
      actual: daily.actual, revenueByType: daily.revenueByType, paymentsByMethod: daily.cash.byMethod,
      cash: daily.cash, deposits: { held: Number(byStatus['held'] ?? 0), byStatus, asOf: 'CURRENT_SNAPSHOT' },
      outstandingBalances: { totalFoliosOpen: Number(balance?.count ?? 0),
        totalBalanceDue: Number(balance?.totalBalance ?? 0), creditBalances: Number(balance?.credits ?? 0),
        accountsReceivableDue: receivablesMatch ? Number(receivables[0]?.due ?? 0) : null,
        accountsReceivableCredits: receivablesMatch ? Number(receivables[0]?.credits ?? 0) : null,
        accountsReceivableCurrencyStatus: receivablesMatch ? 'MATCHED' : 'CURRENCY_MISMATCH',
        accountsReceivableByCurrency: receivables.map((row: any) => ({ currencyCode: row.currencyCode,
          due: Number(row.due), credits: Number(row.credits) })),
        asOf: 'CURRENT_SNAPSHOT' },
      auditStatus: { lastAuditDate: lastAudit[0]?.businessDate ?? null,
        lastAuditStatus: lastAudit[0]?.status ?? null, errorsInLastAudit: lastAudit[0]?.errors?.length ?? 0 } };
  }

  async getOccupancyTrend(propertyId: string, startDate: string, endDate: string) {
    return this.inSnapshot ? this.readOccupancyTrend(propertyId, startDate, endDate) : this.snapshot(service => service.readOccupancyTrend(propertyId, startDate, endDate));
  }

  private async readOccupancyTrend(propertyId: string, startDate: string, endDate: string) {
    const dates = reportDates(startDate, endDate);
    const { property } = await this.context(propertyId, endDate);
    const [inventory, ledgerRows, stays, closed] = await Promise.all([
      this.inventory(propertyId, endDate, property.timezone),
      this.ledgerRows(propertyId, startDate, endDate, property.currencyCode),
      this.db.select().from(reservations).where(and(eq(reservations.propertyId, propertyId),
        lte(reservations.arrivalDate, endDate), sql`${reservations.departureDate} > ${startDate}`,
        inArray(reservations.status, ['checked_in','stayover','due_out','checked_out'] as any))),
      this.db.select().from(auditRuns).where(and(eq(auditRuns.propertyId, propertyId),
        eq(auditRuns.status, 'completed'), gte(auditRuns.businessDate, startDate), lte(auditRuns.businessDate, endDate))),
    ]);
    const daily = dates.map(date => {
      const stock = inventory(date);
      const rows = ledgerRows.filter((row: any) => row.date === date);
      const amounts: Record<string, Decimal> = {};
      for (const row of rows) amounts[row.type] = (amounts[row.type] ?? new Decimal(0)).plus(row.total);
      const net = this.categories(amounts);
      const roomRevenue = net.room, totalRevenue = net.earned;
      const closedDays = closed.some((run: any) => run.businessDate === date) ? 1 : 0;
      const status = closedDays ? 'COMPLETE' : rows.length ? 'PARTIAL' : 'NO_POSTINGS';
      const roomsSold = stays.filter((stay: any) => stay.arrivalDate <= date && stay.departureDate > date).length;
      return { date, ...stock, roomsSold, revenue: roomRevenue, roomRevenue, totalRevenue,
        foodBeverageRevenue: net.foodBeverage, ancillaryRevenue: net.other,
        separatelyPostedTax: net.tax, actual: { value: status === 'NO_POSTINGS' ? null : totalRevenue,
          status, source: 'charges.serviceDate', closedDays, expectedDays: 1 },
        occupancyRate: ratio(roomsSold, stock.availableRooms, 4) ?? 0,
        adr: ratio(roomRevenue, roomsSold) ?? 0, revpar: ratio(roomRevenue, stock.availableRooms) ?? 0,
        trevpar: ratio(totalRevenue, stock.availableRooms) };
    });
    const sum = (key: 'roomRevenue' | 'totalRevenue' | 'roomsSold' | 'availableRooms') =>
      daily.reduce((total, day) => total.plus(day[key]), new Decimal(0)).toNumber();
    const closedDays = closed.length;
    const status = closedDays === dates.length ? 'COMPLETE' : ledgerRows.length ? 'PARTIAL' : 'NO_POSTINGS';
    return { period: { start: startDate, end: endDate }, currencyCode: property.currencyCode, daily,
      actual: { value: status === 'NO_POSTINGS' ? null : sum('totalRevenue'), status,
        source: 'charges.serviceDate', closedDays, expectedDays: dates.length },
      summary: { avgOccupancy: ratio(sum('roomsSold'), sum('availableRooms'), 4) ?? 0,
        avgAdr: ratio(sum('roomRevenue'), sum('roomsSold')) ?? 0,
        avgRevpar: ratio(sum('roomRevenue'), sum('availableRooms')) ?? 0,
        trevpar: ratio(sum('totalRevenue'), sum('availableRooms')),
        totalRevenue: sum('roomRevenue'), netEarnedRevenue: sum('totalRevenue'),
        totalRoomNights: sum('roomsSold'), availableRoomNights: sum('availableRooms') } };
  }

  async getRevenuePeriods(propertyId: string, requestedDate?: string) {
    return this.inSnapshot ? this.readRevenuePeriods(propertyId, requestedDate) : this.snapshot(service => service.readRevenuePeriods(propertyId, requestedDate));
  }

  private async readRevenuePeriods(propertyId: string, requestedDate?: string) {
    const { property, date } = await this.context(propertyId, requestedDate);
    const lyDate = priorYearDate(date);
    const ranges = { mtd: [`${date.slice(0,7)}-01`, date], ytd: [`${date.slice(0,4)}-01-01`, date],
      ly: [lyDate, lyDate], lytd: [`${lyDate.slice(0,4)}-01-01`, lyDate] };
    const actuals = Object.fromEntries(await Promise.all(Object.entries(ranges).map(async ([key, [start, end]]) => {
      const ledger = await this.ledger(propertyId, start!, end!, property.currencyCode);
      return [key, { start, end, ...ledger.actual, revenueByCategory: ledger.net }];
    })));
    const [statistics] = await this.db.select({
      count: sql<number>`count(*)::int`,
      bookingWindow: sql<string>`avg(${reservations.arrivalDate} - ${this.localDay(reservations.createdAt, property.timezone)})`,
      alos: sql<string>`avg(${reservations.departureDate} - ${reservations.arrivalDate})`,
    }).from(reservations).where(and(eq(reservations.propertyId, propertyId), eq(reservations.arrivalDate, date),
      inArray(reservations.status, ['pending','confirmed','assigned','checked_in','stayover','due_out','checked_out'] as any)));
    const quoteRows = await this.db.select({ currencyCode: reservations.currencyCode,
      amount: sql<string>`coalesce(sum(${reservations.totalAmount}::numeric),0)`, count: sql<number>`count(*)::int`,
    }).from(reservations).where(and(eq(reservations.propertyId, propertyId), gte(reservations.arrivalDate, date),
      inArray(reservations.status, ['pending','confirmed','assigned'] as any))).groupBy(reservations.currencyCode);
    this.assertCurrency(quoteRows, property.currencyCode, 'reservation_quotes');
    const quotes = quoteRows[0];
    const hasSample = Number(statistics?.count ?? 0) > 0;
    return { date, propertyId, timezone: property.timezone, currencyCode: property.currencyCode, periods: actuals,
      bookingWindow: { value: hasSample ? Number(statistics.bookingWindow) : null, unit: 'days', sampleSize: Number(statistics?.count ?? 0) },
      averageLengthOfStay: { value: hasSample ? Number(statistics.alos) : null, unit: 'nights', sampleSize: Number(statistics?.count ?? 0) },
      onBooksQuotedAmount: { value: Number(quotes?.amount ?? 0), reservations: Number(quotes?.count ?? 0),
        source: 'reservations.totalAmount', isEarnedRevenue: false },
      forecast: { value: null, status: 'INSUFFICIENT_HISTORY', source: null,
        reason: 'No validated non-synthetic commercial forecast in the reporting domain' },
      planToDate: { value: null, status: 'UNAVAILABLE', reason: 'No approved budget source' },
      gop: { value: null, status: 'UNAVAILABLE', reason: 'No confirmed operating expense source' } };
  }

  async getRevenueOverview(propertyId: string, requestedDate?: string) {
    return this.inSnapshot ? this.readRevenueOverview(propertyId, requestedDate) : this.snapshot(service => service.readRevenueOverview(propertyId, requestedDate));
  }

  private async readRevenueOverview(propertyId: string, requestedDate?: string) {
    const { date } = await this.context(propertyId, requestedDate);
    const [financial, periods] = await Promise.all([
      this.getFinancialSummary(propertyId, date), this.getRevenuePeriods(propertyId, date),
    ]);
    return { ...periods, financial };
  }

  /** Management/DRR and Dashboard share the exact ledger and financial KPI contracts. */
  async getManagementSummary(propertyId: string, requestedDate?: string) {
    return this.inSnapshot ? this.readManagementSummary(propertyId, requestedDate) : this.snapshot(service => service.readManagementSummary(propertyId, requestedDate));
  }

  private async readManagementSummary(propertyId: string, requestedDate?: string) {
    const { property, date } = await this.context(propertyId, requestedDate);
    const previousDate = new Date(Date.parse(date) - 86400000).toISOString().slice(0,10);
    const lastWeekDate = new Date(Date.parse(date) - 7 * 86400000).toISOString().slice(0,10);
    const [financial, occupancy, previousFinancial, lastWeekFinancial, periods, pickup, pace, statusRows, depositRows, channelRows, roomRows] = await Promise.all([
      this.getFinancialSummary(propertyId, date), this.getOccupancy(propertyId, date),
      this.getFinancialSummary(propertyId, previousDate), this.getFinancialSummary(propertyId, lastWeekDate),
      this.getRevenuePeriods(propertyId, date), this.getPickup(propertyId, date, previousDate, date),
      this.getBookingPace(propertyId, date, date),
      this.db.select({ status: reservations.status, count: sql<number>`count(*)::int` }).from(reservations)
        .where(and(eq(reservations.propertyId, propertyId), eq(reservations.arrivalDate, date))).groupBy(reservations.status),
      this.db.select({ currencyCode: depositLedgerEntries.currencyCode,
        amount: sql<string>`coalesce(sum(${depositLedgerEntries.amount}::numeric),0)`, count: sql<number>`count(*)::int`,
      }).from(depositLedgerEntries).where(and(eq(depositLedgerEntries.propertyId, propertyId),
        eq(this.localDay(depositLedgerEntries.receivedAt, property.timezone), date))).groupBy(depositLedgerEntries.currencyCode),
      this.db.select({ source: bookings.source, count: sql<number>`count(*)::int` }).from(reservations)
        .innerJoin(bookings, and(eq(bookings.id, reservations.bookingId), eq(bookings.propertyId, propertyId)))
        .where(and(eq(reservations.propertyId, propertyId), eq(reservations.arrivalDate, date))).groupBy(bookings.source),
      this.db.select({ status: rooms.status, count: sql<number>`count(*)::int` }).from(rooms)
        .where(and(eq(rooms.propertyId, propertyId), eq(rooms.isActive, true))).groupBy(rooms.status),
    ]);
    this.assertCurrency(depositRows, property.currencyCode, 'deposits');
    const deposit = depositRows[0];
    const statuses = Object.fromEntries(statusRows.map((row: any) => [row.status, Number(row.count)]));
    const kpis = financial.kpis;
    const compare = (current: number, baseline: number, status: string, currentAvailable = true) => ({
      value: status === 'NO_POSTINGS' ? null : baseline,
      absolute: status === 'NO_POSTINGS' || !currentAvailable ? null : current - baseline,
      percent: status === 'NO_POSTINGS' || !currentAvailable || baseline === 0 ? null : ((current - baseline) / Math.abs(baseline)) * 100,
      status: status === 'NO_POSTINGS' || currentAvailable ? status : 'CURRENT_NO_POSTINGS',
    });
    const currentAvailable = financial.actual.status !== 'NO_POSTINGS';
    const comparison = (baseline: typeof financial) => ({
      revenue: compare(kpis.totalRevenue, baseline.kpis.totalRevenue, baseline.actual.status, currentAvailable),
      occupancy: compare(kpis.occupancyRate, baseline.kpis.occupancyRate, 'AVAILABLE'),
      adr: compare(kpis.adr, baseline.kpis.adr, baseline.actual.status, currentAvailable),
      revpar: compare(kpis.revpar, baseline.kpis.revpar, baseline.actual.status, currentAvailable),
    });
    return { financial, ...periods,
      today: { revenue: kpis.totalRevenue, occupancy: kpis.occupancyRate, adr: kpis.adr, revpar: kpis.revpar,
        trevpar: kpis.trevpar, arrivals: Object.values(statuses).reduce((sum: number, value: any) => sum + Number(value), 0),
        departures: occupancy.departures, inHouse: occupancy.stayovers,
        confirmed: (statuses['confirmed'] ?? 0) + (statuses['assigned'] ?? 0), cancellations: occupancy.cancellations,
        noShows: occupancy.noShows, receivedDeposits: Number(deposit?.amount ?? 0),
        receivedDepositCount: Number(deposit?.count ?? 0), pendingPayments: financial.outstandingBalances.totalBalanceDue,
        rooms: Object.fromEntries(roomRows.map((row: any) => [row.status, Number(row.count)])) },
      drr: { revenue: kpis.totalRevenue, bookings: periods.onBooksQuotedAmount.reservations,
        occupancy: kpis.occupancyRate, adr: kpis.adr, revpar: kpis.revpar, trevpar: kpis.trevpar,
        cancellations: occupancy.cancellations, deposits: Number(deposit?.amount ?? 0),
        pickup: pickup.pickup, pace: pace.daily[0] ?? { roomsOnBooks: 0, newBookings: 0 },
        channelMix: channelRows.map((row: any) => ({ source: row.source, bookings: Number(row.count) })),
        mtdRevenue: periods.periods.mtd?.value ?? null, onBooks: periods.onBooksQuotedAmount.reservations,
        forecastRevenue: null, forecast: periods.forecast,
        comparisons: { previousDay: comparison(previousFinancial), sameDayLastWeek: comparison(lastWeekFinancial) } } };
  }

  /**
   * Daily Trial Balance (KB 5, computed — no table).
   *
   * For each ledger (Deposit / Guest(current) / A/R) reports
   * Opening + Net Activity + Transfers In/Out = Closing for the business date.
   * Best-effort aggregation from `deposit_ledger_entries`, `folios`, and
   * `ar_ledgers`/`ar_transactions`. The cross-ledger transfer total (folio →
   * A/R) is surfaced so it can be reconciled to net to zero between ledgers.
   */
  async dailyTrialBalance(propertyId: string, date: string) {
    reportDate(date);
    return this.inSnapshot ? this.readTrialBalance(propertyId, date) :
      this.snapshot(service => service.readTrialBalance(propertyId, date));
  }

  private async readTrialBalance(propertyId: string, date: string) {
    const { property } = await this.context(propertyId, date);
    const currencies = await Promise.all([
      this.db.select({ currencyCode: depositLedgerEntries.currencyCode }).from(depositLedgerEntries)
        .where(eq(depositLedgerEntries.propertyId, propertyId)).groupBy(depositLedgerEntries.currencyCode),
      this.db.select({ currencyCode: folios.currencyCode }).from(folios)
        .where(and(eq(folios.propertyId, propertyId), eq(folios.status, 'open'))).groupBy(folios.currencyCode),
      this.db.select({ currencyCode: arLedgers.currencyCode }).from(arLedgers)
        .where(eq(arLedgers.propertyId, propertyId)).groupBy(arLedgers.currencyCode),
      this.db.select({ currencyCode: arTransactions.currencyCode }).from(arTransactions)
        .where(and(eq(arTransactions.propertyId, propertyId),
          eq(this.localDay(arTransactions.createdAt, property.timezone), date))).groupBy(arTransactions.currencyCode),
    ]);
    for (const [index, source] of ['deposits', 'folios', 'accounts_receivable', 'ar_transactions'].entries()) {
      this.assertCurrency(currencies[index], property.currencyCode, source);
    }
    // --- Deposit ledger (KB 10) ---
    // Opening = held liability received before the date and not yet recognized
    // before the date. Closing = held liability as of end of date.
    const [depositOpeningRow] = await this.db
      .select({
        total: sql<string>`coalesce(sum(${depositLedgerEntries.amount}::numeric), 0)`,
      })
      .from(depositLedgerEntries)
      .where(
        and(
          eq(depositLedgerEntries.propertyId, propertyId),
          sql`${this.localDay(depositLedgerEntries.receivedAt, property.timezone)} < ${date}`,
          sql`(${depositLedgerEntries.recognizedAt} is null or ${this.localDay(depositLedgerEntries.recognizedAt, property.timezone)} >= ${date})`,
        ),
      );

    const [depositReceivedRow] = await this.db
      .select({
        total: sql<string>`coalesce(sum(${depositLedgerEntries.amount}::numeric), 0)`,
      })
      .from(depositLedgerEntries)
      .where(
        and(
          eq(depositLedgerEntries.propertyId, propertyId),
          sql`${this.localDay(depositLedgerEntries.receivedAt, property.timezone)} = ${date}`,
        ),
      );

    const [depositRecognizedRow] = await this.db
      .select({
        total: sql<string>`coalesce(sum(${depositLedgerEntries.amount}::numeric), 0)`,
      })
      .from(depositLedgerEntries)
      .where(
        and(
          eq(depositLedgerEntries.propertyId, propertyId),
          sql`${this.localDay(depositLedgerEntries.recognizedAt, property.timezone)} = ${date}`,
        ),
      );

    const depositOpening = new Decimal(depositOpeningRow?.total ?? '0');
    const depositReceived = new Decimal(depositReceivedRow?.total ?? '0');
    const depositRecognized = new Decimal(depositRecognizedRow?.total ?? '0');
    // Recognition moves deposits out of the deposit ledger (to guest/revenue).
    const depositNetActivity = depositReceived;
    const depositTransfersOut = depositRecognized;
    const depositClosing = depositOpening.plus(depositReceived).minus(depositRecognized);

    // --- Guest (current) ledger (KB 5.4) — open guest folio balances ---
    const [guestBalanceRow] = await this.db
      .select({
        total: sql<string>`coalesce(sum(${folios.balance}::numeric), 0)`,
      })
      .from(folios)
      .where(
        and(
          eq(folios.propertyId, propertyId),
          eq(folios.type, 'guest' as any),
          eq(folios.status, 'open' as any),
        ),
      );
    const guestClosing = new Decimal(guestBalanceRow?.total ?? '0');

    // --- A/R ledger (KB 11) ---
    const [arBalanceRow] = await this.db
      .select({
        total: sql<string>`coalesce(sum(${arLedgers.balance}::numeric), 0)`,
      })
      .from(arLedgers)
      .where(eq(arLedgers.propertyId, propertyId));
    const arClosing = new Decimal(arBalanceRow?.total ?? '0');

    // A/R transfers in on the date (folio → A/R cross-ledger move, KB 11.3).
    const [arTransfersInRow] = await this.db
      .select({
        total: sql<string>`coalesce(sum(${arTransactions.amount}::numeric), 0)`,
      })
      .from(arTransactions)
      .where(
        and(
          eq(arTransactions.propertyId, propertyId),
          eq(arTransactions.type, 'transfer_in' as any),
          sql`${this.localDay(arTransactions.createdAt, property.timezone)} = ${date}`,
        ),
      );

    const [arPaymentsRow] = await this.db
      .select({
        total: sql<string>`coalesce(sum(${arTransactions.amount}::numeric), 0)`,
      })
      .from(arTransactions)
      .where(
        and(
          eq(arTransactions.propertyId, propertyId),
          eq(arTransactions.type, 'payment' as any),
          sql`${this.localDay(arTransactions.createdAt, property.timezone)} = ${date}`,
        ),
      );

    const arTransfersIn = new Decimal(arTransfersInRow?.total ?? '0');
    const arPayments = new Decimal(arPaymentsRow?.total ?? '0');
    const arNetActivity = arPayments.negated();
    const arOpening = arClosing.minus(arTransfersIn).plus(arPayments);

    // Cross-ledger transfer reconciliation: the balance transferred out of the
    // guest ledger should equal the amount transferred into A/R on the date.
    const interLedgerTransfers = arTransfersIn;

    return {
      date,
      currencyCode: property.currencyCode,
      timezone: property.timezone,
      completeness: { deposit: 'DATE_RECONSTRUCTED', guest: 'CURRENT_SNAPSHOT_ONLY', ar: 'CURRENT_SNAPSHOT_WITH_DAILY_ACTIVITY' },
      ledgers: {
        deposit: {
          opening: depositOpening.toFixed(2),
          netActivity: depositNetActivity.toFixed(2),
          transfersIn: '0.00',
          transfersOut: depositTransfersOut.toFixed(2),
          closing: depositClosing.toFixed(2),
        },
        guest: {
          // Opening/activity for the guest ledger requires per-day folio
          // snapshots not retained here; closing is the live open-folio balance.
          opening: '0.00',
          netActivity: '0.00',
          transfersIn: '0.00',
          transfersOut: interLedgerTransfers.toFixed(2),
          closing: guestClosing.toFixed(2),
        },
        ar: {
          opening: arOpening.toFixed(2),
          netActivity: arNetActivity.toFixed(2),
          transfersIn: arTransfersIn.toFixed(2),
          transfersOut: '0.00',
          closing: arClosing.toFixed(2),
        },
      },
      interLedgerTransfers: interLedgerTransfers.toFixed(2),
    };
  }

  /**
   * Portfolio financial summary — aggregates KPIs across multiple properties.
   */
  async getPortfolioFinancialSummary(propertyIds: string[], date?: string) {
    return this.inSnapshot ? this.readPortfolioFinancialSummary(propertyIds, date) : this.snapshot(service => service.readPortfolioFinancialSummary(propertyIds, date));
  }

  private async readPortfolioFinancialSummary(propertyIds: string[], date?: string) {
    propertyIds = [...new Set(propertyIds)];
    const summaries = await Promise.all(propertyIds.map(id => this.getFinancialSummary(id, date)));
    const byProperty = summaries.map((summary, i) => ({ propertyId: propertyIds[i], currencyCode: summary.currencyCode,
      date: summary.date, ...summary.kpis, actual: summary.actual }));
    const aggregate = (rows: typeof summaries) => {
      const sum = (key: 'totalRevenue' | 'roomRevenue' | 'roomsSold' | 'availableRooms') =>
        rows.reduce((total, row) => total.plus(row.kpis[key]), new Decimal(0)).toNumber();
      const available = rows.filter(row => row.actual.value !== null);
      const status = rows.length > 0 && rows.every(row => row.actual.status === 'COMPLETE') ? 'COMPLETE' : available.length ? 'PARTIAL' : 'NO_POSTINGS';
      const earned = available.length ? available.reduce((total, row) => total.plus(row.actual.value!), new Decimal(0)).toNumber() : null;
      const room = available.length ? available.reduce((total, row) => total.plus(row.kpis.roomRevenue), new Decimal(0)).toNumber() : null;
      const adr = room === null ? null : ratio(room, sum('roomsSold'));
      const revpar = room === null ? null : ratio(room, sum('availableRooms'));
      const trevpar = earned === null ? null : ratio(earned, sum('availableRooms'));
      return { totalRevenue: earned, roomRevenue: room,
        totalRoomsSold: sum('roomsSold'), totalAvailableRooms: sum('availableRooms'),
        occupancyRate: ratio(sum('roomsSold'), sum('availableRooms'), 4),
        occ: ratio(sum('roomsSold'), sum('availableRooms'), 4), adr, revpar, trevpar,
        ratioStatus: { adr: earned === null ? 'NO_POSTINGS' : adr === null ? 'NO_ROOMS_SOLD' : 'AVAILABLE',
          revpar: earned === null ? 'NO_POSTINGS' : revpar === null ? 'NO_AVAILABLE_INVENTORY' : 'AVAILABLE',
          trevpar: earned === null ? 'NO_POSTINGS' : trevpar === null ? 'NO_AVAILABLE_INVENTORY' : 'AVAILABLE' },
        actual: { value: earned, status, source: 'charges.serviceDate',
          closedDays: rows.reduce((n, row) => n + row.actual.closedDays, 0),
          expectedDays: rows.reduce((n, row) => n + row.actual.expectedDays, 0),
          propertiesWithActual: available.length, missingProperties: rows.length - available.length } };
    };
    const currencies = [...new Set(summaries.map(summary => summary.currencyCode))];
    const byCurrency = currencies.map(currencyCode => ({ currencyCode,
      ...aggregate(summaries.filter(summary => summary.currencyCode === currencyCode)) }));
    const combined = aggregate(summaries);
    const { actual: combinedActual, ...combinedKpis } = combined;
    const mixed = currencies.length > 1;
    return { date: date ?? null, dateMode: date ? 'EXPLICIT' : 'PROPERTY_OPERATIONAL_DATE', propertyCount: propertyIds.length, propertyIds, currencyCode: mixed ? null : currencies[0] ?? null,
      currencyStatus: mixed ? 'MIXED_CURRENCIES' : 'SINGLE_CURRENCY',
      actual: { ...combinedActual, value: mixed ? null : combinedActual.value, status: mixed ? 'MIXED_CURRENCIES' : combinedActual.status },
      kpis: { ...combinedKpis, totalRevenue: mixed ? null : combined.totalRevenue,
        roomRevenue: mixed ? null : combined.roomRevenue, adr: mixed ? null : combined.adr,
        revpar: mixed ? null : combined.revpar, trevpar: mixed ? null : combined.trevpar },
      byCurrency, byProperty };
  }

  /**
   * Portfolio occupancy — sums room counts and activity across properties.
   */
  async getPortfolioOccupancy(propertyIds: string[], date?: string) {
    const rows = await Promise.all(
      propertyIds.map((id) => this.getOccupancy(id, date)),
    );

    let totalRooms = 0;
    let availableRooms = 0;
    let occupiedRooms = 0;
    let arrivals = 0;
    let departures = 0;
    let stayovers = 0;
    const byProperty = propertyIds.map((propertyId, i) => {
      const r = rows[i]!;
      totalRooms += r.totalRooms ?? 0;
      availableRooms += r.availableRooms ?? 0;
      occupiedRooms += r.occupiedRooms ?? 0;
      arrivals += r.arrivals ?? 0;
      departures += r.departures ?? 0;
      stayovers += r.stayovers ?? 0;
      return {
        propertyId,
        date: r.date,
        occupancyRate: r.availableRooms > 0 ? r.occupancyRate : null,
        occupiedRooms: r.occupiedRooms ?? 0,
        availableRooms: r.availableRooms ?? 0,
        arrivals: r.arrivals ?? 0,
        departures: r.departures ?? 0,
      };
    });

    const occupancyRate = availableRooms > 0 ? occupiedRooms / availableRooms : null;

    return {
      date,
      propertyCount: propertyIds.length,
      propertyIds,
      totalRooms,
      availableRooms,
      occupiedRooms,
      occupancyRate: occupancyRate === null ? null : Math.round(occupancyRate * 10000) / 10000,
      occupancyPercent: occupancyRate === null ? 'N/A' : `${(occupancyRate * 100).toFixed(1)}%`,
      arrivals,
      departures,
      stayovers,
      byProperty,
    };
  }

  /**
   * Pickup report — room nights on a stay date gained or lost over a booking window.
   * Compares on-the-books room nights at the start vs end of the period, with a
   * daily breakdown of additions (by createdAt) and losses (by cancelledAt).
   */
  async getPickup(propertyId: string, stayDate: string, from: string, to: string) {
    return this.inSnapshot ? this.readPickup(propertyId, stayDate, from, to) :
      this.snapshot(service => service.readPickup(propertyId, stayDate, from, to));
  }

  private async readPickup(propertyId: string, stayDate: string, from: string, to: string, roomTypeId?: string) {
    reportDate(stayDate);
    const { property } = await this.context(propertyId, stayDate);
    from = this.bookingDate(from, property.timezone);
    to = this.bookingDate(to, property.timezone);
    reportDates(from, to);
    const coversStayDate = and(
      eq(reservations.propertyId, propertyId),
      roomTypeId ? eq(reservations.roomTypeId, roomTypeId) : undefined,
      lte(reservations.arrivalDate, stayDate),
      sql`${reservations.departureDate} > ${stayDate}`,
    );

    const activeAsOf = (asOfDate: string) =>
      and(
        coversStayDate,
        sql`${this.localDay(reservations.createdAt, property.timezone)} <= ${asOfDate}`,
        sql`(${reservations.cancelledAt} is null or ${this.localDay(reservations.cancelledAt, property.timezone)} > ${asOfDate})`,
        sql`${reservations.status} not in ('no_show')`,
      );

    const [baselineRow] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(reservations)
      .where(
        and(
          coversStayDate,
          sql`${this.localDay(reservations.createdAt, property.timezone)} < ${from}`,
          sql`(${reservations.cancelledAt} is null or ${this.localDay(reservations.cancelledAt, property.timezone)} >= ${from})`,
          // A later cancellation must still count in the earlier baseline.
          sql`${reservations.status} not in ('no_show')`,
        ),
      );

    const [currentRow] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(reservations)
      .where(activeAsOf(to));

    const baselineRoomNights = baselineRow?.count ?? 0;
    const currentRoomNights = currentRow?.count ?? 0;

    const dailyAdded = await this.db
      .select({
        date: sql<string>`${this.localDay(reservations.createdAt, property.timezone)}`,
        roomNights: sql<number>`count(*)::int`,
      })
      .from(reservations)
      .where(
        and(
          coversStayDate,
          sql`${this.localDay(reservations.createdAt, property.timezone)} >= ${from}`,
          sql`${this.localDay(reservations.createdAt, property.timezone)} <= ${to}`,
          // Count additions even if cancelled later within the same window.
          sql`${reservations.status} not in ('no_show')`,
        ),
      )
      .groupBy(sql`1`)
      .orderBy(sql`1`);

    const dailyLost = await this.db
      .select({
        date: sql<string>`${this.localDay(reservations.cancelledAt, property.timezone)}`,
        roomNights: sql<number>`count(*)::int`,
      })
      .from(reservations)
      .where(
        and(
          coversStayDate,
          eq(reservations.status, 'cancelled' as any),
          sql`${this.localDay(reservations.cancelledAt, property.timezone)} >= ${from}`,
          sql`${this.localDay(reservations.cancelledAt, property.timezone)} <= ${to}`,
        ),
      )
      .groupBy(sql`1`)
      .orderBy(sql`1`);

    const dailyMap = new Map<string, { roomNightsAdded: number; roomNightsLost: number }>();

    for (const row of dailyAdded) {
      const dateKey = typeof row.date === 'string' ? row.date : new Date(row.date).toISOString().split('T')[0]!;
      const entry = dailyMap.get(dateKey) ?? { roomNightsAdded: 0, roomNightsLost: 0 };
      entry.roomNightsAdded = row.roomNights;
      dailyMap.set(dateKey, entry);
    }

    for (const row of dailyLost) {
      const dateKey = typeof row.date === 'string' ? row.date : new Date(row.date).toISOString().split('T')[0]!;
      const entry = dailyMap.get(dateKey) ?? { roomNightsAdded: 0, roomNightsLost: 0 };
      entry.roomNightsLost = row.roomNights;
      dailyMap.set(dateKey, entry);
    }

    const daily = [...dailyMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, counts]) => ({
        date,
        roomNightsAdded: counts.roomNightsAdded,
        roomNightsLost: counts.roomNightsLost,
        netPickup: counts.roomNightsAdded - counts.roomNightsLost,
      }));

    return {
      stayDate,
      source: 'reservation_created_and_cancelled_timestamps',
      historicalAmendmentsReconstructed: false,
      period: { from, to },
      baseline: { roomNights: baselineRoomNights },
      current: { roomNights: currentRoomNights },
      pickup: { roomNights: currentRoomNights - baselineRoomNights },
      daily,
    };
  }
  async getBookingPace(propertyId: string, startDate: string, endDate: string) {
    return this.inSnapshot ? this.readBookingPace(propertyId, startDate, endDate) :
      this.snapshot(service => service.readBookingPace(propertyId, startDate, endDate));
  }

  private async readBookingPace(propertyId: string, startDate: string, endDate: string, roomTypeId?: string) {
    reportDates(startDate, endDate);
    const { property } = await this.context(propertyId, endDate);
    const bookedStatuses = [
      'pending',
      'confirmed',
      'assigned',
      'checked_in',
      'stayover',
      'due_out',
      'checked_out',
    ] as const;

    const dailyOnBooks = await this.db
      .select({
        date: sql<string>`d.d::date`,
        // Must use the drizzle table ref — alias "r" is not in the generated FROM.
        count: sql<number>`count(distinct ${reservations.id})::int`,
      })
      .from(sql`generate_series(${startDate}::date, ${endDate}::date, '1 day'::interval) as d(d)`)
      .leftJoin(
        reservations,
        and(
          eq(reservations.propertyId, propertyId),
          inArray(reservations.status, bookedStatuses as any),
          roomTypeId ? eq(reservations.roomTypeId, roomTypeId) : undefined,
          lte(reservations.arrivalDate, sql`d.d::date`),
          sql`${reservations.departureDate} > d.d::date`,
        ),
      )
      .groupBy(sql`d.d::date`)
      .orderBy(sql`d.d::date`);

    const dailyNewBookings = await this.db
      .select({
        date: sql<string>`${this.localDay(reservations.createdAt, property.timezone)}`,
        count: sql<number>`count(*)::int`,
      })
      .from(reservations)
      .where(
        and(
          eq(reservations.propertyId, propertyId),
          roomTypeId ? eq(reservations.roomTypeId, roomTypeId) : undefined,
          sql`${this.localDay(reservations.createdAt, property.timezone)} >= ${startDate}`,
          sql`${this.localDay(reservations.createdAt, property.timezone)} <= ${endDate}`,
        ),
      )
      .groupBy(sql`1`);

    const newBookingsMap = new Map<string, number>();
    for (const row of dailyNewBookings) {
      const dateKey =
        typeof row.date === 'string' ? row.date : new Date(row.date).toISOString().split('T')[0]!;
      newBookingsMap.set(dateKey, row.count);
    }

    const daily = dailyOnBooks.map((row: any) => {
      const dateKey =
        typeof row.date === 'string' ? row.date : new Date(row.date).toISOString().split('T')[0]!;
      return {
        date: dateKey,
        roomsOnBooks: row.count,
        newBookings: newBookingsMap.get(dateKey) ?? 0,
      };
    });

    const totalRoomsOnBooks = daily.reduce((s: number, d: any) => s + d.roomsOnBooks, 0);
    const totalNewBookings = daily.reduce((s: number, d: any) => s + d.newBookings, 0);
    const dayCount = daily.length || 1;

    return {
      period: { start: startDate, end: endDate },
      daily,
      summary: {
        avgRoomsOnBooks: Math.round((totalRoomsOnBooks / dayCount) * 100) / 100,
        totalNewBookings,
      },
    };
  }

}

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq } from 'drizzle-orm';
import { auditLogs, bookings, charges, domainEventOutbox, folios, guestPropertyLinks, guests, integrationLinks, properties, ratePlans, reservations, roomTypes, serviceBookings, serviceOperations, serviceResourceAllocations, serviceResourceBlocks, serviceResources, services, taxProfiles, taxRules } from '@telivityhaip/database';
import { ConnectServiceBookingService } from './connect-service-booking.service';
import { FolioService } from '../folio/folio.service';
import { TaxService } from '../tax/tax.service';
import { DomainEventOutboxService } from '../webhook/domain-event-outbox.service';
import { GuestService } from '../guest/guest.service';

// Only external delivery is replaced: capacities, guests, charges, taxes, receipts and locks are real SQL.
describe.runIf(process.env.PMS_LIVE_PG === '1')('Service operations on PostgreSQL', () => {
  const client = postgres(process.env.DATABASE_URL!, { max: 8 }); const db = drizzle(client);
  const ids = { property: randomUUID(), other: randomUUID(), guest: randomUUID(), service: randomUUID(), resource: randomUUID(), tax: randomUUID() };
  const webhooks = { emit: vi.fn(), dispatchPersisted: vi.fn() };
  const taxes = new TaxService(db); const folio = new FolioService(db, webhooks as any, taxes);
  const outbox = new DomainEventOutboxService(db, webhooks as any);
  const service = new ConnectServiceBookingService(db, folio, taxes, outbox);
  const input = { propertyId: ids.property, serviceId: ids.service, guestId: ids.guest, startAt: '2027-01-01T09:00:00Z', endAt: '2027-01-01T10:00:00Z', participants: 1 };
  const book = (changes = {}) => service.book({ ...input, idempotencyKey: randomUUID(), ...changes });
  async function clearBookings() {
    for (const table of [serviceOperations, serviceResourceBlocks, serviceResourceAllocations, serviceBookings, charges, folios, integrationLinks, domainEventOutbox, auditLogs]) {
      await db.delete(table).where(eq(table.propertyId, ids.property));
    }
  }
  beforeAll(async () => {
    await db.insert(properties).values([ids.property, ids.other].map(id => ({ id, name: 'Service test', code: 'SV-' + id.slice(0, 8), countryCode: 'KZ', timezone: 'Asia/Almaty', currencyCode: 'KZT', totalRooms: 0 })));
    await db.insert(guests).values({ id: ids.guest, firstName: 'Тест', lastName: 'Услуги' });
    await db.insert(guestPropertyLinks).values({ propertyId: ids.property, guestId: ids.guest, source: 'pms' });
    await db.insert(services).values({ id: ids.service, propertyId: ids.property, code: 'MASSAGE', name: 'Массаж', chargeType: 'spa', price: '100.00', currencyCode: 'KZT', agentBookingMode: 'live_booking', durationMinutes: 60, taxMode: 'none' });
    await db.insert(serviceResources).values({ id: ids.resource, propertyId: ids.property, serviceId: ids.service, code: 'R1', name: 'Кабинет', capacity: 1 });
    await db.insert(taxProfiles).values({ id: ids.tax, propertyId: ids.property, name: 'Тест', jurisdictionCode: 'TEST', effectiveFrom: '2026-01-01', isActive: false });
  });
  beforeEach(async () => {
    await clearBookings(); vi.restoreAllMocks(); vi.clearAllMocks(); webhooks.dispatchPersisted.mockResolvedValue(undefined);
    await db.delete(taxRules).where(eq(taxRules.taxProfileId, ids.tax));
    await db.update(taxProfiles).set({ isActive: false }).where(eq(taxProfiles.id, ids.tax));
    await db.update(services).set({ price: '100.00', durationMinutes: 60, taxMode: 'none', postingRule: 'once' }).where(eq(services.id, ids.service));
    await db.update(serviceResources).set({ capacity: 1, bufferBeforeMinutes: 0, bufferAfterMinutes: 0, schedule: null }).where(eq(serviceResources.id, ids.resource));
  });
  afterAll(async () => {
    await clearBookings();
    await db.delete(taxRules).where(eq(taxRules.taxProfileId, ids.tax)); await db.delete(taxProfiles).where(eq(taxProfiles.id, ids.tax));
    await db.delete(serviceResources).where(eq(serviceResources.propertyId, ids.property)); await db.delete(services).where(eq(services.propertyId, ids.property));
    const linked = await db.select().from(guestPropertyLinks).where(eq(guestPropertyLinks.propertyId, ids.property));
    await db.delete(guestPropertyLinks).where(eq(guestPropertyLinks.propertyId, ids.property));
    for (const row of linked) await db.delete(guests).where(eq(guests.id, row.guestId));
    await db.delete(properties).where(eq(properties.id, ids.property)); await db.delete(properties).where(eq(properties.id, ids.other)); await client.end();
  });
  it('serializes simultaneous retries and freezes one booking, allocation, folio and charge', async () => {
    const idempotencyKey = randomUUID(); const results = await Promise.all([book({ idempotencyKey }), book({ idempotencyKey })]);
    expect(results[0].serviceBookingId).toBe(results[1].serviceBookingId);
    expect(results.map(r => r.idempotentReplay).sort()).toEqual([false, true]);
    for (const table of [serviceBookings, serviceResourceAllocations, folios, charges]) expect(await db.select().from(table).where(eq(table.propertyId, ids.property))).toHaveLength(1);
    expect(await db.select().from(reservations).where(eq(reservations.propertyId, ids.property))).toHaveLength(0);
    const detail = await service.get(results[0].serviceBookingId, ids.property);
    expect(detail.folio.balance).toBe('100.00'); expect(detail.pricingSnapshot.totalAmount).toBe('100.00');
  });
  it('returns a replay for different object field order and rejects a changed payload', async () => {
    const idempotencyKey = randomUUID(); const first = await book({ idempotencyKey });
    const replay = await service.book({ idempotencyKey, ...input }); expect(replay.serviceBookingId).toBe(first.serviceBookingId);
    await expect(book({ idempotencyKey, quantity: 2 })).rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_CONFLICT' } });
  });
  it('allows one winner for two independent purchases of the final resource', async () => {
    const results = await Promise.allSettled([book(), book()]); expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect((results.find(r => r.status === 'rejected') as PromiseRejectedResult).reason.response.code).toBe('RESOURCE_CONFLICT');
    expect(await db.select().from(charges).where(eq(charges.propertyId, ids.property))).toHaveLength(1);
  });
  it('permanently closes an unaccepted attempt and refuses any late create without financial side effects', async () => {
    const idempotencyKey = randomUUID(); const dto = { propertyId: ids.property, idempotencyKey };
    expect(await service.closeRequest(dto)).toEqual({ status: 'closed' });
    expect(await service.closeRequest(dto)).toEqual({ status: 'closed' });
    await expect(book({ idempotencyKey })).rejects.toMatchObject({ response: { code: 'SERVICE_REQUEST_CLOSED' } });
    for (const table of [serviceBookings, charges, folios]) expect(await db.select().from(table).where(eq(table.propertyId, ids.property))).toHaveLength(0);
    const other = await service.closeRequest({ ...dto, propertyId: ids.other }); expect(other.status).toBe('closed');
    await db.delete(serviceOperations).where(eq(serviceOperations.propertyId, ids.other));
  });
  it('serializes create versus closure and recovers committed bookings without cancelling them', async () => {
    const idempotencyKey = randomUUID();
    const [create, close] = await Promise.allSettled([book({ idempotencyKey }), service.closeRequest({ propertyId: ids.property, idempotencyKey })]);
    expect(close.status).toBe('fulfilled');
    if (create.status === 'fulfilled') {
      expect((close as PromiseFulfilledResult<any>).value).toEqual({ status: 'committed', serviceBookingId: create.value.serviceBookingId });
      expect(await service.closeRequest({ propertyId: ids.property, idempotencyKey })).toEqual({ status: 'committed', serviceBookingId: create.value.serviceBookingId });
      expect((await service.get(create.value.serviceBookingId, ids.property)).status).toBe('scheduled');
      expect(await db.select().from(charges).where(eq(charges.propertyId, ids.property))).toHaveLength(1);
    } else {
      expect(create.reason.response.code).toBe('SERVICE_REQUEST_CLOSED');
      expect((close as PromiseFulfilledResult<any>).value.status).toBe('closed');
      expect(await db.select().from(charges).where(eq(charges.propertyId, ids.property))).toHaveLength(0);
    }
  });
  it('preserves preparation buffers and allows a genuinely adjacent free interval', async () => {
    await db.update(serviceResources).set({ bufferAfterMinutes: 15 }).where(eq(serviceResources.id, ids.resource)); await book();
    expect((await service.availability({ ...input, startAt: '2027-01-01T10:00:00Z', endAt: '2027-01-01T11:00:00Z' })).available).toBe(false);
    expect((await service.availability({ ...input, startAt: '2027-01-01T10:15:00Z', endAt: '2027-01-01T11:15:00Z' })).available).toBe(true);
  });
  it('uses peak capacity for disjoint bookings instead of summing the whole query window', async () => {
    await db.update(services).set({ durationMinutes: null }).where(eq(services.id, ids.service));
    await db.update(serviceResources).set({ capacity: 2 }).where(eq(serviceResources.id, ids.resource));
    await book(); await book({ startAt: '2027-01-01T11:00:00Z', endAt: '2027-01-01T12:00:00Z' });
    expect((await service.availability({ ...input, endAt: '2027-01-01T12:00:00Z' })).available).toBe(true);
    expect((await service.availability({ ...input, endAt: '2027-01-01T12:00:00Z', participants: 2 })).available).toBe(false);
  });
  it('honours resource working hours in the configured timezone', async () => {
    await db.update(serviceResources).set({ schedule: { timeZone: 'Asia/Almaty', windows: [{ day: 5, start: '14:00', end: '19:00' }] } }).where(eq(serviceResources.id, ids.resource));
    expect((await service.availability(input)).available).toBe(true);
    expect((await service.availability({ ...input, startAt: '2027-01-01T01:00:00Z', endAt: '2027-01-01T02:00:00Z' })).available).toBe(false);
  });
  it('books a continuous overnight service without ignoring a break in either working date', async () => {
    await db.update(serviceResources).set({ schedule: { timeZone: 'UTC', windows: [{ day: 5, start: '23:00', end: '24:00' }, { day: 6, start: '00:00', end: '02:00' }] } }).where(eq(serviceResources.id, ids.resource));
    const dto = { ...input, startAt: '2027-01-01T23:30:00Z', endAt: '2027-01-02T00:30:00Z' };
    expect((await service.availability(dto)).available).toBe(true); await book(dto);
    expect((await service.availability(dto)).available).toBe(false);
    await clearBookings();
    await db.update(serviceResources).set({ schedule: { timeZone: 'UTC', windows: [{ day: 5, start: '23:00', end: '24:00' }, { day: 6, start: '00:15', end: '02:00' }] } }).where(eq(serviceResources.id, ids.resource));
    await expect(book(dto)).rejects.toMatchObject({ response: { code: 'RESOURCE_CONFLICT' } });
  });
  it('edits resource metadata without rewriting accepted allocations and rejects invalid capacity, hours or concurrent edits', async () => {
    await db.update(serviceResources).set({ capacity: 2, bufferAfterMinutes: 15 }).where(eq(serviceResources.id, ids.resource));
    const b = await book({ participants: 2 });
    const [before] = await db.select().from(serviceResources).where(eq(serviceResources.id, ids.resource));
    const dto = { propertyId: ids.property, serviceId: ids.service, code: 'R1', name: 'Обновлённый кабинет', capacity: 2, bufferAfterMinutes: 30, expectedUpdatedAt: before.updatedAt.toISOString(), idempotencyKey: randomUUID() };
    for (const patch of [{ capacity: 1 }, { isActive: false }, { schedule: { timeZone: 'UTC', windows: [{ day: 1, start: '09:00', end: '12:00' }] } }])
      await expect(service.updateResource(ids.resource, { ...dto, ...patch, idempotencyKey: randomUUID() })).rejects.toMatchObject({ response: { code: 'RESOURCE_HAS_BOOKINGS' } });
    const edited = await service.updateResource(ids.resource, dto); expect(edited['name']).toBe(dto.name);
    const replay = await service.updateResource(ids.resource, dto); expect(replay['idempotentReplay']).toBe(true);
    await expect(service.updateResource(ids.resource, { ...dto, idempotencyKey: randomUUID() })).rejects.toMatchObject({ response: { code: 'STALE_REVISION' } });
    const [allocation] = await db.select().from(serviceResourceAllocations).where(eq(serviceResourceAllocations.serviceBookingId, b.serviceBookingId));
    expect(allocation.endAt?.toISOString()).toBe('2027-01-01T10:15:00.000Z');
    await expect(service.updateResource(ids.resource, { ...dto, propertyId: ids.other, idempotencyKey: randomUUID() })).rejects.toMatchObject({ response: { code: 'SERVICE_NOT_FOUND' } });
  });
  it('blocks a free interval with replay protection and never overwrites a sold slot', async () => {
    const dto = { propertyId: ids.property, resourceId: ids.resource, startAt: input.startAt, endAt: input.endAt, idempotencyKey: randomUUID() };
    const blocked = await service.createBlock(dto); expect((await service.createBlock(dto))['id']).toBe(blocked['id']);
    expect((await service.availability(input)).available).toBe(false);
    await service.removeBlock(blocked['id'], { propertyId: ids.property, idempotencyKey: randomUUID() }); await book();
    await expect(service.createBlock({ ...dto, idempotencyKey: randomUUID() })).rejects.toMatchObject({ response: { code: 'RESOURCE_CONFLICT' } });
  });
  it('returns actual day slot capacity with working hours, frozen buffers, blocks and cancellation release', async () => {
    await db.update(serviceResources).set({ capacity: 2, bufferAfterMinutes: 15, schedule: { timeZone: 'UTC', windows: [{ day: 5, start: '09:00', end: '18:00' }] } }).where(eq(serviceResources.id, ids.resource));
    const b = await book();
    await service.createBlock({ propertyId: ids.property, resourceId: ids.resource, startAt: '2027-01-01T12:00:00Z', endAt: '2027-01-01T13:00:00Z', idempotencyKey: randomUUID() });
    const read = () => service.resourceSlots(ids.resource, ids.property, '2027-01-01T00:00:00Z', '2027-01-02T00:00:00Z');
    const snapshot = await read();
    const free = (at: string) => snapshot.slots.find(s => s.startAt === '2027-01-01T' + at + ':00.000Z')!.availableUnits;
    expect(free('08:00')).toBe(0); expect(free('09:00')).toBe(1); expect(free('10:00')).toBe(1); expect(free('10:30')).toBe(2); expect(free('12:00')).toBe(0);
    await service.transition(b.serviceBookingId, { propertyId: ids.property, expectedRevision: 1, idempotencyKey: randomUUID() }, 'cancelled');
    expect((await read()).slots.find(s => s.startAt === '2027-01-01T09:00:00.000Z')!.availableUnits).toBe(2);
    await expect(service.resourceSlots(ids.resource, ids.other, input.startAt, input.endAt)).rejects.toMatchObject({ response: { code: 'RESOURCE_NOT_FOUND' } });
  });
  it('moves and releases the old slot while preserving the accepted price and ledger', async () => {
    const b = await book(); await db.update(services).set({ price: '900.00' }).where(eq(services.id, ids.service));
    const dto = { propertyId: ids.property, expectedRevision: 1, idempotencyKey: randomUUID(), startAt: '2027-01-01T11:00:00Z', endAt: '2027-01-01T12:00:00Z' };
    const result = await service.change(b.serviceBookingId, dto); expect(result['revision']).toBe(2);
    expect((await service.change(b.serviceBookingId, dto))['revision']).toBe(2);
    expect((await service.availability(input)).available).toBe(true);
    const detail = await service.get(b.serviceBookingId, ids.property); expect(detail.totalAmount).toBe('100.00'); expect(detail.folio.balance).toBe('100.00');
    expect(await db.select().from(charges).where(eq(charges.propertyId, ids.property))).toHaveLength(1);
  });
  it('rolls back a conflicting move and serializes competing revisions', async () => {
    const b = await book(); await book({ startAt: '2027-01-01T11:00:00Z', endAt: '2027-01-01T12:00:00Z' });
    const dto = { propertyId: ids.property, expectedRevision: 1, idempotencyKey: randomUUID(), startAt: '2027-01-01T11:00:00Z', endAt: '2027-01-01T12:00:00Z' };
    await expect(service.change(b.serviceBookingId, dto)).rejects.toMatchObject({ response: { code: 'RESOURCE_CONFLICT' } });
    expect((await service.get(b.serviceBookingId, ids.property)).revision).toBe(1);
    const results = await Promise.allSettled([1,2].map(() => service.change(b.serviceBookingId, { ...dto, idempotencyKey: randomUUID(), startAt: '2027-01-01T13:00:00Z', endAt: '2027-01-01T14:00:00Z' })));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect((results.find(r => r.status === 'rejected') as PromiseRejectedResult).reason.response.code).toBe('STALE_REVISION');
  });
  it('cancels once, frees capacity and exposes manual financial review without a fictitious refund', async () => {
    const b = await book(); const dto = { propertyId: ids.property, expectedRevision: 1, idempotencyKey: randomUUID() };
    const cancelled = await service.transition(b.serviceBookingId, dto, 'cancelled');
    expect(cancelled['financial']).toMatchObject({ requiresFinancialReview: true, chargePosted: true, chargeReversed: false, refundStatus: 'manual_workflow' });
    expect((await service.transition(b.serviceBookingId, dto, 'cancelled'))['idempotentReplay']).toBe(true);
    expect((await service.availability(input)).available).toBe(true); expect((await service.get(b.serviceBookingId, ids.property)).folio.totalPayments).toBe('0.00');
    const [charge] = await db.select().from(charges).where(eq(charges.propertyId, ids.property));
    await folio.reverseCharge(b.folioId, charge.id, ids.property);
    const detail = await service.get(b.serviceBookingId, ids.property); expect(detail.financial.chargeReversed).toBe(true); expect(detail.financial.requiresFinancialReview).toBe(false); expect(detail.folio.balance).toBe('0.00');
  });
  it('requires actual service time before completing and does not post a second charge', async () => {
    const b = await book(); await expect(service.transition(b.serviceBookingId, { propertyId: ids.property, expectedRevision: 1, idempotencyKey: randomUUID() }, 'completed')).rejects.toMatchObject({ response: { code: 'SERVICE_NOT_STARTED' } });
    const past = await book({ startAt: '2026-01-01T09:00:00Z', endAt: '2026-01-01T10:00:00Z' });
    await service.transition(past.serviceBookingId, { propertyId: ids.property, expectedRevision: 1, idempotencyKey: randomUUID() }, 'completed');
    expect(await db.select().from(charges).where(eq(charges.propertyId, ids.property))).toHaveLength(2);
  });
  it('refuses unknown tax policy without creating booking/folio/guest side effects', async () => {
    await db.update(services).set({ taxMode: null }).where(eq(services.id, ids.service));
    await expect(book({ guestId: undefined, guestFirstName: 'Налоговый тест' })).rejects.toMatchObject({ response: { code: 'TAX_POLICY_REQUIRED' } });
    for (const table of [serviceBookings, folios, charges]) expect(await db.select().from(table).where(eq(table.propertyId, ids.property))).toHaveLength(0);
    expect(await db.select().from(guests).where(eq(guests.firstName, 'Налоговый тест'))).toHaveLength(0);
  });
  const consumption = (patch = {}) => ({ propertyId: ids.property, serviceId: ids.service, guestId: ids.guest, serviceDate: '2026-01-01', quantity: 2, expectedTotal: '200.00', provided: true as const, idempotencyKey: randomUUID(), ...patch });
  it('records unscheduled actual consumption once without a fictitious booking, resource or confirmed payment', async () => {
    await db.update(services).set({ postingRule: 'on_consumption', durationMinutes: null }).where(eq(services.id, ids.service));
    const dto = consumption({ guestId: undefined, guestFirstName: 'Без расписания' });
    const quote = await service.quoteConsumption({ propertyId: ids.property, serviceId: ids.service, serviceDate: dto.serviceDate, quantity: 2 }); expect(quote.pricing.totalAmount).toBe('200.00');
    const results = await Promise.all([service.recordConsumption(dto), service.recordConsumption(dto)]);
    expect(results[0]['folioId']).toBe(results[1]['folioId']); expect(results[0]['paymentStatus']).toBe('not_confirmed');
    for (const table of [serviceBookings, serviceResourceAllocations, reservations]) expect(await db.select().from(table).where(eq(table.propertyId, ids.property))).toHaveLength(0);
    for (const table of [charges, folios]) expect(await db.select().from(table).where(eq(table.propertyId, ids.property))).toHaveLength(1);
    const [ledger] = await db.select().from(folios).where(eq(folios.propertyId, ids.property)); expect(ledger.totalCharges).toBe('200.00'); expect(ledger.totalPayments).toBe('0.00');
    const guest = await new GuestService(db).get360(results[0]['guestId'], ids.property); expect(guest.stays).toHaveLength(0); expect(guest.summary.ancillaryRevenue).toBe(200);
    expect(await service.closeRequest({ propertyId: ids.property, idempotencyKey: dto.idempotencyKey })).toEqual({ status: 'committed', kind: 'consumption', folioId: results[0]['folioId'] });
    expect(await service.recover(ids.property, dto.idempotencyKey)).toMatchObject({ kind: 'consumption', folioId: results[0]['folioId'] });
    await db.update(services).set({ price: '900.00', taxMode: null }).where(eq(services.id, ids.service));
    expect((await service.recordConsumption(dto))['totalAmount']).toBe('200.00');
    await expect(service.recordConsumption({ ...dto, quantity: 3 })).rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_CONFLICT' } });
  });
  it('refuses unscheduled package/per-night charges, future provision, stale prices and missing tax policy without side effects', async () => {
    await expect(service.recordConsumption(consumption())).rejects.toMatchObject({ response: { code: 'SERVICE_POSTING_WORKFLOW_REQUIRED' } });
    await db.update(services).set({ postingRule: 'on_consumption' }).where(eq(services.id, ids.service));
    await expect(service.recordConsumption(consumption({ serviceDate: '2099-01-01' }))).rejects.toMatchObject({ response: { code: 'SERVICE_NOT_PROVIDED' } });
    await expect(service.recordConsumption(consumption({ expectedTotal: '1.00', guestId: undefined, guestFirstName: 'Не принят' }))).rejects.toMatchObject({ response: { code: 'PRICE_CHANGED' } });
    await db.update(services).set({ taxMode: null }).where(eq(services.id, ids.service));
    await expect(service.recordConsumption(consumption())).rejects.toMatchObject({ response: { code: 'TAX_POLICY_REQUIRED' } });
    for (const table of [serviceOperations, charges, folios]) expect(await db.select().from(table).where(eq(table.propertyId, ids.property))).toHaveLength(0);
    expect(await db.select().from(guests).where(eq(guests.firstName, 'Не принят'))).toHaveLength(0);
  });
  it('fences late unscheduled consumption and rolls back ledger failures atomically', async () => {
    await db.update(services).set({ postingRule: 'on_consumption' }).where(eq(services.id, ids.service));
    const dto = consumption(); await service.closeRequest(dto);
    await expect(service.recordConsumption(dto)).rejects.toMatchObject({ response: { code: 'SERVICE_REQUEST_CLOSED' } });
    vi.spyOn(folio, 'postChargeFromSnapshotWithOutcome').mockRejectedValueOnce(new Error('ledger unavailable'));
    await expect(service.recordConsumption(consumption())).rejects.toThrow('ledger unavailable');
    for (const table of [charges, folios, domainEventOutbox]) expect(await db.select().from(table).where(eq(table.propertyId, ids.property))).toHaveLength(0);
    await expect(service.recordConsumption(consumption({ propertyId: ids.other }))).rejects.toMatchObject({ response: { code: 'SERVICE_NOT_FOUND' } });
  });
  it.each(['exclusive','inclusive'] as const)('posts the accepted %s tax result through the existing tax/folio engines', async taxMode => {
    await db.update(taxProfiles).set({ isActive: true }).where(eq(taxProfiles.id, ids.tax));
    await db.insert(taxRules).values({ taxProfileId: ids.tax, name: 'Test tax', code: 'TEST10', type: 'percentage', rate: '10.00', appliesToChargeTypes: ['spa'], effectiveFrom: '2026-01-01' });
    await db.update(services).set({ price: taxMode === 'inclusive' ? '110.00' : '100.00', taxMode }).where(eq(services.id, ids.service));
    const b = await book(); const detail = await service.get(b.serviceBookingId, ids.property);
    expect(detail.totalAmount).toBe('110.00'); expect(detail.pricingSnapshot.baseAmount).toBe('100.00'); expect(detail.pricingSnapshot.taxAmount).toBe('10.00'); expect(detail.folio.balance).toBe('110.00');
    expect(await db.select().from(charges).where(eq(charges.propertyId, ids.property))).toHaveLength(2);
  });
  it('retains durable created and charge events when dispatch fails, without reporting the commit as rejected', async () => {
    webhooks.dispatchPersisted.mockRejectedValue(new Error('external delivery unavailable'));
    const b = await book(); const rows = await db.select().from(domainEventOutbox).where(eq(domainEventOutbox.propertyId, ids.property));
    expect(rows).toHaveLength(2); expect(rows.every(r => !r.deliveredAt)).toBe(true);
    expect(rows.some(r => r.payload['event'] === 'service_booking.created')).toBe(true);
    webhooks.dispatchPersisted.mockResolvedValue(undefined);
    for (const row of rows) await outbox.deliver(ids.property, row.logicalEventId);
    expect((await service.get(b.serviceBookingId, ids.property)).status).toBe('scheduled');
  });
  it('makes a service-only customer visible in Guest 360 without fabricating a stay', async () => {
    const b = await book({ guestId: undefined, guestFirstName: 'Самостоятельная услуга' }); const detail = await service.get(b.serviceBookingId, ids.property);
    const context = await new GuestService(db).get360(detail.guestId, ids.property);
    expect(context.stays).toHaveLength(0); expect(context.bookedServices.some(s => s.id === b.serviceBookingId)).toBe(true);
    expect(context.services).toHaveLength(1); expect(context.summary.ancillaryRevenue).toBe(100);
  });
  it('posts linked services into the existing stay folio and exposes the same accepted booking in the workspace', async () => {
    const bookingId = randomUUID(), reservationId = randomUUID(), typeId = randomUUID(), rateId = randomUUID();
    await db.insert(roomTypes).values({ id: typeId, propertyId: ids.property, name: 'Номер', code: 'TEST', maxOccupancy: 2, defaultOccupancy: 1 });
    await db.insert(ratePlans).values({ id: rateId, propertyId: ids.property, roomTypeId: typeId, name: 'Тест', code: 'TEST', type: 'bar', baseAmount: '500.00', currencyCode: 'KZT' });
    await db.insert(bookings).values({ id: bookingId, propertyId: ids.property, guestId: ids.guest, confirmationNumber: 'P2-' + bookingId, source: 'direct' });
    await db.insert(reservations).values({ id: reservationId, bookingId, propertyId: ids.property, guestId: ids.guest, roomTypeId: typeId, ratePlanId: rateId, arrivalDate: '2027-01-01', departureDate: '2027-01-03', nights: 2, totalAmount: '1000.00', currencyCode: 'KZT', status: 'confirmed' });
    try {
      const existing = await folio.create({ propertyId: ids.property, guestId: ids.guest, reservationId, type: 'guest', currencyCode: 'KZT' });
      const b = await book({ reservationId }); expect(b.folioId).toBe(existing.id);
      expect(await db.select().from(folios).where(eq(folios.propertyId, ids.property))).toHaveLength(1);
      const list = await service.forReservation(ids.property, reservationId); expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ id: b.serviceBookingId, reservationId, folioId: existing.id, totalAmount: '100.00', name: 'Массаж' });
      expect(list[0]).not.toHaveProperty('idempotencyKey'); expect(list[0]).not.toHaveProperty('integrationContext');
      await expect(service.forReservation(ids.other, reservationId)).rejects.toMatchObject({ response: { code: 'RESERVATION_NOT_FOUND' } });
      const mismatched = await service.closeRequest({ propertyId: ids.other, idempotencyKey: randomUUID() }); expect(mismatched.status).toBe('closed');
      await db.delete(serviceOperations).where(eq(serviceOperations.propertyId, ids.other));
    } finally {
      await clearBookings(); await db.delete(reservations).where(eq(reservations.id, reservationId)); await db.delete(bookings).where(eq(bookings.id, bookingId));
      await db.delete(ratePlans).where(eq(ratePlans.id, rateId)); await db.delete(roomTypes).where(eq(roomTypes.id, typeId));
    }
  });
  it('denies foreign property detail, history, resource references and calendar data', async () => {
    const b = await book(); await expect(service.get(b.serviceBookingId, ids.other)).rejects.toMatchObject({ response: { code: 'SERVICE_BOOKING_NOT_FOUND' } });
    await expect(service.history(b.serviceBookingId, ids.other)).rejects.toThrow();
    await expect(service.createBlock({ propertyId: ids.other, resourceId: ids.resource, startAt: input.startAt, endAt: input.endAt, idempotencyKey: randomUUID() })).rejects.toThrow();
    expect((await service.calendar(ids.other, input.startAt, input.endAt)).bookings).toHaveLength(0);
    const own = await service.calendar(ids.property, input.startAt, input.endAt); expect(own.complete).toBe(true); expect(own.bookings).toHaveLength(1); expect(own.bookings[0]).not.toHaveProperty('integrationContext');
  });
  it('rejects a stale quote and rolls back every financial side effect', async () => {
    await expect(book({ expectedTotal: '99.00' })).rejects.toMatchObject({ response: { code: 'PRICE_CHANGED' } });
    for (const table of [serviceBookings, serviceResourceAllocations, charges, folios, domainEventOutbox]) expect(await db.select().from(table).where(eq(table.propertyId, ids.property))).toHaveLength(0);
  });
  it('rolls back capacity, identity and folio when posting a charge fails', async () => {
    vi.spyOn(folio, 'postChargeFromSnapshotWithOutcome').mockRejectedValueOnce(new Error('ledger unavailable'));
    await expect(book({ guestId: undefined, guestFirstName: 'Rollback', integrationContext: { sourceSystem: 'test', customerId: 'rollback' } })).rejects.toThrow('ledger unavailable');
    for (const table of [serviceBookings, serviceResourceAllocations, charges, folios, integrationLinks, domainEventOutbox]) expect(await db.select().from(table).where(eq(table.propertyId, ids.property))).toHaveLength(0);
    expect(await db.select().from(guests).where(eq(guests.firstName, 'Rollback'))).toHaveLength(0);
    expect((await service.availability(input)).available).toBe(true);
  });
  it('recovers a committed request and excludes private staff data from the external contract', async () => {
    const key = randomUUID(); const b = await book({ idempotencyKey: key, notes: 'Internal only' });
    expect((await service.recover(ids.property, key)).id).toBe(b.serviceBookingId);
    await expect(service.recover(ids.other, key)).rejects.toThrow();
    const detail = await service.publicDetail(b.serviceBookingId, ids.property);
    for (const field of ['notes', 'allocations', 'pricingSnapshot', 'integrationContext', 'idempotencyKey', 'folio']) expect(detail).not.toHaveProperty(field);
  });
  it('previews a move with its original accepted price without writing a receipt', async () => {
    const b = await book(); await db.update(services).set({ price: '900.00' }).where(eq(services.id, ids.service));
    const dto = { propertyId: ids.property, expectedRevision: 1, idempotencyKey: randomUUID(), startAt: '2027-01-01T11:00:00Z', endAt: '2027-01-01T12:00:00Z' };
    expect(await service.previewChange(b.serviceBookingId, dto)).toMatchObject({ available: true, totalAmount: '100.00', revision: 1 });
    expect(await db.select().from(serviceOperations).where(eq(serviceOperations.propertyId, ids.property))).toHaveLength(0);
    expect((await service.get(b.serviceBookingId, ids.property)).startAt.toISOString()).toBe(input.startAt.replace('Z', '.000Z'));
  });
  it('rejects a booking key reused for another operation', async () => {
    const key = randomUUID(); const b = await book({ idempotencyKey: key });
    await expect(service.transition(b.serviceBookingId, { propertyId: ids.property, expectedRevision: 1, idempotencyKey: key }, 'cancelled')).rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_CONFLICT' } });
    expect((await service.get(b.serviceBookingId, ids.property)).status).toBe('scheduled');
  });
  it('resolves simultaneous requests for one external customer to one guest identity', async () => {
    await db.update(serviceResources).set({ capacity: 2 }).where(eq(serviceResources.id, ids.resource));
    const context = { sourceSystem: 'test-crm', customerId: 'same-customer' };
    await Promise.all([book({ guestId: undefined, guestFirstName: 'CRM identity', integrationContext: context }), book({ guestId: undefined, guestFirstName: 'CRM identity', integrationContext: context })]);
    const rows = await db.select().from(serviceBookings).where(eq(serviceBookings.propertyId, ids.property));
    expect(rows).toHaveLength(2); expect(new Set(rows.map(r => r.guestId)).size).toBe(1);
    expect(await db.select().from(integrationLinks).where(eq(integrationLinks.propertyId, ids.property))).toHaveLength(1);
  });
  it('preserves replay of a legacy fingerprint despite reordered fields and an unconfigured tax mode', async () => {
    const key = randomUUID(); const b = await book({ idempotencyKey: key });
    await db.update(serviceBookings).set({ integrationContext: { idempotencyFingerprint: JSON.stringify(input) } }).where(and(eq(serviceBookings.id, b.serviceBookingId), eq(serviceBookings.propertyId, ids.property)));
    await db.update(services).set({ taxMode: null, price: '900.00' }).where(eq(services.id, ids.service));
    const result = await service.book({ idempotencyKey: key, participants: input.participants, endAt: input.endAt, startAt: input.startAt, guestId: input.guestId, serviceId: input.serviceId, propertyId: input.propertyId });
    expect(result.idempotentReplay).toBe(true); expect(result.totalAmount).toBe(100);
  });
  it('applies migration 0033 twice to legacy rows without rewriting accepted prices or allocations', async () => {
    const name = 'service_migration_' + randomUUID().replaceAll('-', '');
    const migration = await readFile(join(__dirname, '../../../../../packages/database/src/migrations/0033_service_operations.sql'), 'utf8');
    await client.unsafe(`CREATE SCHEMA ${name}`);
    try {
      await client.begin(async tx => {
        await tx.unsafe(`SET LOCAL search_path TO ${name}, public`);
        await tx.unsafe('CREATE TABLE properties (id uuid PRIMARY KEY); CREATE TABLE services (id uuid PRIMARY KEY, price numeric(12,2)); CREATE TABLE service_bookings (id uuid PRIMARY KEY, total_amount numeric(12,2)); CREATE TABLE service_resources (id uuid PRIMARY KEY); CREATE TABLE service_resource_allocations (id uuid PRIMARY KEY, units integer)');
        await tx`INSERT INTO services VALUES (${ids.service}, 123.45)`; await tx`INSERT INTO service_bookings VALUES (${ids.guest}, 123.45)`;
        await tx`INSERT INTO service_resource_allocations VALUES (${ids.resource}, 2)`;
        await tx.unsafe(migration); await tx.unsafe(migration);
        expect((await tx`SELECT price, tax_mode FROM services`)[0]).toEqual({ price: '123.45', tax_mode: null });
        expect((await tx`SELECT total_amount, revision, pricing_snapshot FROM service_bookings`)[0]).toEqual({ total_amount: '123.45', revision: 1, pricing_snapshot: null });
        expect((await tx`SELECT units, start_at, end_at FROM service_resource_allocations`)[0]).toEqual({ units: 2, start_at: null, end_at: null });
      });
    } finally { await client.unsafe(`DROP SCHEMA ${name} CASCADE`); }
  });
});

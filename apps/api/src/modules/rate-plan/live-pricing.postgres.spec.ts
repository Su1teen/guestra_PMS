import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID, generateKeyPairSync, sign } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import request from 'supertest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq, inArray, notInArray } from 'drizzle-orm';
import { properties, ratePlans, rateRestrictions, rateChangeRequests, rateMutationFences, auditLogs, domainEventOutbox,
  roomTypes, rooms, roomInventoryBlocks, reservations, bookings, guests, auditRuns, taxProfiles, taxRules,
  users, roles, userRoles, rolePermissions } from '@telivityhaip/database';
import { RatePlanService } from './rate-plan.service';
import { ReportsService } from '../reports/reports.service';
import { TaxService } from '../tax/tax.service';
import { DomainEventOutboxService } from '../webhook/domain-event-outbox.service';
import { calculateCanonicalRoomPricing } from './canonical-room-pricing';
import { RatePlanController } from './rate-plan.controller';
import { PermissionsService } from '../auth/permissions.service';
import { PermissionsGuard } from '../auth/permissions.guard';
import { PropertyScopeGuard } from '../auth/property-scope.guard';
import { JwtStrategy } from '../auth/jwt.strategy';
import { JwtAuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { DRIZZLE } from '../../database/database.module';
import { withAcceptedPricingLock } from '../../common/database/accepted-pricing-lock';

describe.runIf(process.env.PMS_LIVE_PG === '1')('Live pricing real PostgreSQL transactions', () => {
  const client = postgres(process.env.DATABASE_URL!, { max: 10 });
  const db = drizzle(client);
  const ids = { a: randomUUID(), b: randomUUID(), type: randomUUID(), foreignType: randomUUID(), rate: randomUUID(), foreignRate: randomUUID(),
    child: randomUUID(), guest: randomUUID(), booking: randomUUID(), reservation: randomUUID(), tax: randomUUID() };
  const actor = { userId: randomUUID(), userEmail: 'requester@test.invalid' };
  const approver = { userId: randomUUID(), userEmail: 'approver@test.invalid' };
  const staffId = randomUUID(), roleId = randomUUID();
  let app: INestApplication, jwks: Server, issuer: string;
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const token = (overrides = {}) => {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'pricing-test', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ iss: issuer, aud: 'pms-test', azp: 'pms-test', sub: actor.userId,
      exp: Math.floor(Date.now() / 1000) + 300, property_ids: [ids.a], realm_access: { roles: [] }, ...overrides })).toString('base64url');
    const content = header + '.' + payload;
    return content + '.' + sign('RSA-SHA256', Buffer.from(content), keys.privateKey).toString('base64url');
  };
  const url = (path: string) => '/api/v1/rate-plans/' + path;
  const auth = (method: 'get' | 'post' | 'patch' | 'delete', path: string) => request(app.getHttpServer())[method](url(path)).auth(token(), { type: 'bearer' });
  const permissions = ['rateplans.read', 'rateplans.manage', 'reports.view', 'revenue.manage'];
  const delivery = { dispatchPersisted: vi.fn().mockRejectedValue(new Error('delivery offline')) };
  const outbox = new DomainEventOutboxService(db, delivery as any);
  const reports = new ReportsService(db);
  const taxes = new TaxService(db);
  const svc = new RatePlanService(db, outbox, reports, taxes);
  const date = '2027-05-01';
  const guard = (expectedRevision = 1) => ({ requestId: randomUUID(), expectedRevision, reason: 'Подтверждённое изменение тарифа' });
  const patch = () => ({ ...guard(), propertyId: ids.a, ratePlanId: ids.rate, kind: 'plan', plan: { baseAmount: '120.00' }, startDate: date, endDate: '2027-05-02' });
  const calendar = (extra = {}) => svc.liveCalendar({ propertyId: ids.a, startDate: date, endDate: '2027-05-02', ...extra });
  const plan = () => svc.findById(ids.rate, ids.a);
  const scopedRows = (table: any) => db.select().from(table).where(eq(table.propertyId, ids.a));
  const proposal = async (extra = {}) => {
    const dto = { ...patch(), ...extra };
    const preview = await svc.previewLiveChange(dto);
    return { dto, preview, result: await svc.submitLiveChange({ ...dto, stateToken: preview.stateToken }, actor) };
  };
  const creation = () => ({ ...guard(0), propertyId: ids.a, kind: 'plan_create', startDate: date, endDate: date,
    createPlan: { name: 'Approved new BAR', code: 'NEW-' + randomUUID().slice(0, 8), type: 'bar', baseAmount: '150.00', currencyCode: 'KZT', roomTypeId: ids.type } });
  const accepted = { version: 1, source: 'submitted', currencyCode: 'KZT', grandTotal: '220.00', roomTotal: '200.00', taxTotal: '20.00',
    nights: [{ date, roomAmount: '100.00', taxAmount: '10.00' }, { date: '2027-05-02', roomAmount: '100.00', taxAmount: '10.00' }],
    services: [], servicesTotal: '0.00', servicesTaxTotal: '0.00', customReason: null, adjustment: null };

  beforeAll(async () => {
    await db.insert(properties).values([ids.a, ids.b].map((id, i) => ({ id, code: 'LIV' + id.slice(0, 12), name: 'Live pricing test',
      countryCode: 'KZ', timezone: 'Asia/Almaty', currencyCode: 'KZT', totalRooms: i === 0 ? 2 : 1 })));
    await db.insert(roomTypes).values([{ id: ids.type, propertyId: ids.a, code: 'STD', name: 'Стандарт', maxOccupancy: 2, defaultOccupancy: 1 },
      { id: ids.foreignType, propertyId: ids.b, code: 'STD', name: 'Foreign', maxOccupancy: 2, defaultOccupancy: 1 }]);
    await db.insert(rooms).values([1, 2].map(i => ({ propertyId: ids.a, roomTypeId: ids.type, number: String(i) })));
    await db.insert(ratePlans).values([
      { id: ids.rate, propertyId: ids.a, roomTypeId: ids.type, code: 'BAR', name: 'BAR', type: 'bar', baseAmount: '100.00', currencyCode: 'KZT' },
      { id: ids.foreignRate, propertyId: ids.b, roomTypeId: ids.foreignType, code: 'BAR', name: 'BAR', type: 'bar', baseAmount: '999.00', currencyCode: 'KZT' },
      { id: ids.child, propertyId: ids.a, roomTypeId: ids.type, code: 'DER', name: 'Derived', type: 'derived', baseAmount: '0.00', currencyCode: 'KZT',
        parentRatePlanId: ids.rate, derivedAdjustmentType: 'percentage', derivedAdjustmentValue: '-10' },
    ]);
    await db.insert(taxProfiles).values({ id: ids.tax, propertyId: ids.a, name: 'Tax', jurisdictionCode: 'KZ', effectiveFrom: '2020-01-01' });
    await db.insert(taxRules).values({ taxProfileId: ids.tax, name: 'VAT', code: 'VAT', type: 'percentage', rate: '10', effectiveFrom: '2020-01-01' });
    await db.insert(guests).values({ id: ids.guest, firstName: 'Live', lastName: 'Test' });
    await db.insert(bookings).values({ id: ids.booking, propertyId: ids.a, guestId: ids.guest, confirmationNumber: 'LIVE-' + ids.booking, source: 'direct' });
    await db.insert(reservations).values({ id: ids.reservation, propertyId: ids.a, bookingId: ids.booking, guestId: ids.guest,
      roomTypeId: ids.type, ratePlanId: ids.rate, arrivalDate: date, departureDate: '2027-05-03', nights: 2,
      totalAmount: '220.00', currencyCode: 'KZT', status: 'confirmed', acceptedPricingSnapshot: accepted as any,
      createdAt: new Date('2027-04-29T04:00:00Z') });
    await db.insert(auditRuns).values({ propertyId: ids.a, businessDate: '2027-04-30', status: 'completed' });
    await db.insert(users).values({ id: staffId, propertyId: ids.a, keycloakSub: actor.userId, name: 'Pricing operator', email: staffId + '@test.invalid' });
    await db.insert(roles).values({ id: roleId, propertyId: ids.a, key: 'pricing-test', name: 'Pricing test' });
    await db.insert(userRoles).values({ propertyId: ids.a, roleId, userId: staffId });
    jwks = createServer((req, res) => {
      if (req.url !== '/realms/pricing-test/protocol/openid-connect/certs') { res.writeHead(404).end(); return; }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ keys: [{ ...keys.publicKey.export({ format: 'jwk' }), kid: 'pricing-test', alg: 'RS256', use: 'sig' }] }));
    });
    await new Promise<void>(resolve => jwks.listen(0, '127.0.0.1', resolve));
    const keycloakUrl = 'http://127.0.0.1:' + (jwks.address() as import('node:net').AddressInfo).port;
    issuer = keycloakUrl + '/realms/pricing-test';
    const config = new ConfigService({ AUTH_ENABLED: 'true', KEYCLOAK_URL: keycloakUrl, KEYCLOAK_REALM: 'pricing-test', KEYCLOAK_CLIENT_ID: 'pms-test' });
    const moduleRef = await Test.createTestingModule({ controllers: [RatePlanController], providers: [
      { provide: RatePlanService, useValue: svc }, { provide: DRIZZLE, useValue: db }, { provide: ConfigService, useValue: config },
      PermissionsService, JwtStrategy,
    ] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    const reflector = new Reflector();
    app.useGlobalGuards(new JwtAuthGuard(reflector, config), new RolesGuard(reflector, config),
      new PropertyScopeGuard(reflector, config), new PermissionsGuard(reflector, config, moduleRef.get(PermissionsService)));
    await app.init();
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    delivery.dispatchPersisted.mockRejectedValue(new Error('delivery offline'));
    await db.delete(rolePermissions).where(and(eq(rolePermissions.propertyId, ids.a), eq(rolePermissions.roleId, roleId)));
    await db.insert(rolePermissions).values(permissions.map(permissionKey => ({ propertyId: ids.a, roleId, permissionKey })));
    await db.delete(rateChangeRequests).where(eq(rateChangeRequests.propertyId, ids.a));
    await db.delete(rateMutationFences).where(eq(rateMutationFences.propertyId, ids.a));
    await db.delete(rateRestrictions).where(eq(rateRestrictions.propertyId, ids.a));
    await db.delete(ratePlans).where(and(eq(ratePlans.propertyId, ids.a), notInArray(ratePlans.id, [ids.rate, ids.child])));
    await db.delete(auditLogs).where(eq(auditLogs.propertyId, ids.a));
    await db.delete(domainEventOutbox).where(eq(domainEventOutbox.propertyId, ids.a));
    await db.delete(roomInventoryBlocks).where(eq(roomInventoryBlocks.propertyId, ids.a));
    await db.update(properties).set({ settings: {} }).where(eq(properties.id, ids.a));
    await db.update(ratePlans).set({ revision: 1, baseAmount: '100.00', isActive: true, occupancyBands: null, losAdjustments: null, parentRatePlanId: null })
      .where(and(eq(ratePlans.id, ids.rate), eq(ratePlans.propertyId, ids.a)));
    await db.update(reservations).set({ status: 'confirmed' }).where(and(eq(reservations.id, ids.reservation), eq(reservations.propertyId, ids.a)));
  });

  afterAll(async () => {
    await app?.close();
    if (jwks) await new Promise<void>(resolve => jwks.close(() => resolve()));
    await db.delete(rolePermissions).where(and(eq(rolePermissions.propertyId, ids.a), eq(rolePermissions.roleId, roleId)));
    await db.delete(userRoles).where(and(eq(userRoles.propertyId, ids.a), eq(userRoles.userId, staffId)));
    await db.delete(roles).where(and(eq(roles.propertyId, ids.a), eq(roles.id, roleId)));
    await db.delete(users).where(and(eq(users.propertyId, ids.a), eq(users.id, staffId)));
    for (const table of [rateChangeRequests, rateMutationFences, rateRestrictions, auditLogs, domainEventOutbox, roomInventoryBlocks, auditRuns, reservations, bookings])
      await db.delete(table).where(inArray(table.propertyId, [ids.a, ids.b]));
    await db.delete(taxRules).where(eq(taxRules.taxProfileId, ids.tax));
    await db.delete(taxProfiles).where(eq(taxProfiles.propertyId, ids.a));
    await db.delete(ratePlans).where(and(eq(ratePlans.id, ids.child), eq(ratePlans.propertyId, ids.a)));
    await db.delete(ratePlans).where(inArray(ratePlans.propertyId, [ids.a, ids.b]));
    await db.delete(rooms).where(eq(rooms.propertyId, ids.a));
    await db.delete(roomTypes).where(inArray(roomTypes.propertyId, [ids.a, ids.b]));
    await db.delete(guests).where(eq(guests.id, ids.guest));
    await db.delete(properties).where(inArray(properties.id, [ids.a, ids.b]));
    await client.end();
  });

  it('commits revision + state + actor audit + durable event + fence as one operation and safely replays', async () => {
    const dto = { ...guard(), baseAmount: '150.00' };
    const result = await svc.update(ids.rate, ids.a, dto, actor);
    expect(result.record).toMatchObject({ baseAmount: '150.00', revision: 2 });
    expect(await svc.update(ids.rate, ids.a, dto, actor)).toEqual({ record: result.record, replayed: true });
    expect((await scopedRows(auditLogs)).filter(row => row.description === dto.reason)).toHaveLength(1);
    expect((await scopedRows(auditLogs)).find(row => row.description === dto.reason)?.userId).toBe(actor.userId);
    expect(await scopedRows(domainEventOutbox)).toHaveLength(1);
    expect(await scopedRows(rateMutationFences)).toHaveLength(1);
    await outbox.deliver(ids.a, (await scopedRows(domainEventOutbox))[0]!.logicalEventId);
    expect((await scopedRows(domainEventOutbox))[0]).toMatchObject({ deliveredAt: null, attempts: 1 });
    expect((await plan()).baseAmount).toBe('150.00');
    expect(await svc.recoverRequest(ids.a, dto.requestId, actor, true)).toEqual({ state: 'committed', record: result.record });
  });

  it('previews, independently approves and atomically creates a canonical plan with replay/recovery and no accepted-price rewrites', async () => {
    await db.update(properties).set({ settings: { pricingApprovalRequired: true } }).where(eq(properties.id, ids.a));
    const dto = creation(); const preview = await svc.previewLiveChange(dto);
    expect(preview).toMatchObject({ planRevision: 0, approvalRequired: true, acceptedPricesChanged: false });
    expect(preview.days[0]).toMatchObject({ before: null, beforeQuote: null, after: { effectiveRate: 150 }, afterQuote: { totalAmount: '165.00' } });
    await expect(svc.findById(dto.requestId, ids.a)).rejects.toThrow(/not found/);
    const body = { ...dto, stateToken: preview.stateToken };
    const submitted = await svc.submitLiveChange(body, actor);
    expect(submitted.record).toMatchObject({ status: 'pending', ratePlanId: null });
    expect((await svc.submitLiveChange(body, actor)).replayed).toBe(true);
    await expect(svc.decideLiveChange(submitted.record.id, ids.a, 'apply', guard(1), actor)).rejects.toThrow(/eligible/);
    await expect(svc.decideLiveChange(submitted.record.id, ids.a, 'approve', guard(1), actor)).rejects.toThrow(/Independent/);
    await svc.decideLiveChange(submitted.record.id, ids.a, 'approve', guard(1), approver);
    const applyGuard = guard(2);
    const applied = await svc.decideLiveChange(submitted.record.id, ids.a, 'apply', applyGuard, actor);
    expect(applied.record).toMatchObject({ status: 'applied', ratePlanId: dto.requestId, revision: 3 });
    expect(await svc.findById(dto.requestId, ids.a)).toMatchObject({ baseAmount: '150.00', revision: 1 });
    expect((await svc.decideLiveChange(submitted.record.id, ids.a, 'apply', applyGuard, actor)).replayed).toBe(true);
    expect(await svc.recoverRequest(ids.a, applyGuard.requestId, actor)).toMatchObject({ state: 'committed', record: { ratePlanId: dto.requestId } });
    expect((await scopedRows(auditLogs)).filter(row => row.entityType === 'rate_plan' && row.entityId === dto.requestId && row.description === dto.reason)).toHaveLength(1);
    expect((await scopedRows(domainEventOutbox)).filter(row => row.payload.event === 'rate_plan.created')).toHaveLength(1);
    expect((await scopedRows(reservations))[0]?.acceptedPricingSnapshot).toEqual(accepted);
  });

  it('rejects creation foreign references, stale dependencies and duplicate creation without bypassing approval', async () => {
    const dto = creation();
    await expect(svc.previewLiveChange({ ...dto, createPlan: { ...dto.createPlan, roomTypeId: ids.foreignType } })).rejects.toThrow(/room type/);
    await expect(svc.previewLiveChange({ ...dto, createPlan: { ...dto.createPlan, currencyCode: 'USD' } })).rejects.toThrow(/CURRENCY/);
    const derived = { ...dto, createPlan: { ...dto.createPlan, type: 'derived', parentRatePlanId: ids.rate, derivedAdjustmentType: 'percentage', derivedAdjustmentValue: '-10' } };
    const preview = await svc.previewLiveChange(derived);
    const pending = await svc.submitLiveChange({ ...derived, stateToken: preview.stateToken }, actor);
    await svc.update(ids.rate, ids.a, { ...guard(), baseAmount: '110.00' }, actor);
    await expect(svc.decideLiveChange(pending.record.id, ids.a, 'apply', guard(1), actor)).rejects.toThrow(/preview/);
    const fresh = creation(); const p = await svc.previewLiveChange(fresh);
    const proposal = await svc.submitLiveChange({ ...fresh, stateToken: p.stateToken }, actor);
    await svc.decideLiveChange(proposal.record.id, ids.a, 'apply', guard(1), actor);
    await expect(svc.previewLiveChange({ ...fresh, requestId: randomUUID() })).rejects.toThrow(/already exists/);
  });

  it('rolls back approved creation, proposal, audit, events and fence on outbox failure; same apply request recovers', async () => {
    const dto = creation(); const preview = await svc.previewLiveChange(dto);
    const pending = await svc.submitLiveChange({ ...dto, stateToken: preview.stateToken }, actor);
    const beforeEvents = (await scopedRows(domainEventOutbox)).length;
    const applyGuard = guard(1), persist = vi.spyOn(outbox, 'persist').mockRejectedValueOnce(new Error('outbox failure'));
    await expect(svc.decideLiveChange(pending.record.id, ids.a, 'apply', applyGuard, actor)).rejects.toThrow(/outbox failure/);
    await expect(svc.findById(dto.requestId, ids.a)).rejects.toThrow(/not found/);
    expect((await scopedRows(rateChangeRequests))[0]?.status).toBe('pending');
    expect((await scopedRows(domainEventOutbox)).length).toBe(beforeEvents);
    expect(await svc.recoverRequest(ids.a, applyGuard.requestId, actor)).toMatchObject({ state: 'unconfirmed' });
    persist.mockRestore(); await svc.decideLiveChange(pending.record.id, ids.a, 'apply', applyGuard, actor);
    expect(await svc.findById(dto.requestId, ids.a)).toMatchObject({ revision: 1 });
  });

  it('separates checkout stop-sell from sold-night stop-sell / CTA / CTD in canonical quote and draft preview', async () => {
    const tomorrow = '2027-05-02';
    const [restriction] = await db.insert(rateRestrictions).values({ propertyId: ids.a, ratePlanId: ids.rate, startDate: tomorrow, endDate: tomorrow, isClosed: true }).returning();
    const rates = await calendar({ endDate: date, ratePlanId: ids.rate });
    expect(rates.rates[0]).toMatchObject({ sellable: true, quote: { totalAmount: '110.00' } });
    const dto = { ...patch(), endDate: date, kind: 'restriction_update', plan: undefined, restrictionId: restriction!.id, restriction: { isClosed: true } };
    const preview = await svc.previewLiveChange(dto);
    expect(preview.days[0]).toMatchObject({ beforeSales: { sellable: true }, afterSales: { sellable: true }, afterQuote: { totalAmount: '110.00' } });
    await db.update(rateRestrictions).set({ closedToDeparture: true }).where(and(eq(rateRestrictions.id, restriction!.id), eq(rateRestrictions.propertyId, ids.a)));
    expect((await calendar({ endDate: date, ratePlanId: ids.rate })).rates[0]).toMatchObject({ sellable: false, restrictionReason: expect.stringMatching(/departure/) });
    await db.update(rateRestrictions).set({ startDate: date, closedToDeparture: false }).where(and(eq(rateRestrictions.id, restriction!.id), eq(rateRestrictions.propertyId, ids.a)));
    expect((await calendar({ endDate: date, ratePlanId: ids.rate })).rates[0]).toMatchObject({ sellable: false, restrictionReason: expect.stringMatching(/stop-sell/) });
  });

  it('rolls back state, audit and fence when durable outbox fails; original request retries', async () => {
    const dto = { ...guard(), baseAmount: '150.00' };
    vi.spyOn(outbox, 'persist').mockRejectedValueOnce(new Error('outbox unavailable'));
    await expect(svc.update(ids.rate, ids.a, dto, actor)).rejects.toThrow('outbox unavailable');
    expect((await plan()).baseAmount).toBe('100.00');
    expect(await scopedRows(auditLogs)).toHaveLength(0);
    expect(await scopedRows(domainEventOutbox)).toHaveLength(0);
    expect(await scopedRows(rateMutationFences)).toHaveLength(0);
    expect((await svc.update(ids.rate, ids.a, dto, actor)).record.revision).toBe(2);
  });

  it('rejects changed payload and another actor on immutable retry fences', async () => {
    const dto = { ...guard(), baseAmount: '150.00' };
    await svc.update(ids.rate, ids.a, dto, actor);
    await expect(svc.update(ids.rate, ids.a, { ...dto, baseAmount: '200.00' }, actor)).rejects.toMatchObject({ response: { code: 'REQUEST_CHANGED' } });
    await expect(svc.update(ids.rate, ids.a, dto, approver)).rejects.toMatchObject({ status: 403 });
    await expect(svc.recoverRequest(ids.a, dto.requestId, approver)).rejects.toMatchObject({ status: 403 });
  });

  it('serializes concurrent writes and rejects a stale revision without losing updates', async () => {
    const result = await Promise.allSettled([svc.update(ids.rate, ids.a, { ...guard(), baseAmount: '150.00' }, actor),
      svc.update(ids.rate, ids.a, { ...guard(), baseAmount: '200.00' }, approver)]);
    expect(result.filter(row => row.status === 'fulfilled')).toHaveLength(1);
    expect(result.find(row => row.status === 'rejected')).toMatchObject({ reason: { response: { code: 'STALE_PRICING' } } });
    expect((await plan()).revision).toBe(2);
    expect(await scopedRows(domainEventOutbox)).toHaveLength(1);
  });

  it('serializes simultaneous identical retries and returns one immutable committed response', async () => {
    const dto = { ...guard(), baseAmount: '150.00' };
    const result = await Promise.all([svc.update(ids.rate, ids.a, dto, actor), svc.update(ids.rate, ids.a, dto, actor)]);
    expect(result.map(row => row.replayed).sort()).toEqual([false, true]);
    expect(result[0]!.record).toEqual(result[1]!.record);
    expect(await scopedRows(domainEventOutbox)).toHaveLength(1);
  });

  it('closes unconfirmed requests durably without allowing delayed application', async () => {
    const dto = { ...guard(), baseAmount: '150.00' };
    expect(await svc.recoverRequest(ids.a, dto.requestId, actor)).toEqual({ state: 'unconfirmed' });
    expect(await svc.recoverRequest(ids.a, dto.requestId, actor, true)).toEqual({ state: 'closed' });
    await svc.recoverRequest(ids.a, dto.requestId, actor, true);
    await expect(svc.update(ids.rate, ids.a, dto, actor)).rejects.toMatchObject({ response: { code: 'REQUEST_CLOSED' } });
    expect(await scopedRows(domainEventOutbox)).toHaveLength(1);
    expect((await plan()).revision).toBe(1);
  });

  it('scopes calendar, mutations, foreign keys, queue and request recovery to the requested property', async () => {
    await expect(svc.update(ids.foreignRate, ids.a, { ...guard(), baseAmount: '150.00' }, actor)).rejects.toMatchObject({ status: 404 });
    await expect(svc.update(ids.rate, ids.a, { ...guard(), parentRatePlanId: ids.foreignRate }, actor)).rejects.toMatchObject({ status: 404 });
    await expect(calendar({ roomTypeId: ids.foreignType })).rejects.toMatchObject({ status: 404 });
    await expect(calendar({ ratePlanId: ids.foreignRate })).rejects.toMatchObject({ status: 404 });
    const submitted = await proposal();
    expect(await svc.approvalQueue(ids.b)).toHaveLength(0);
    await expect(svc.decideLiveChange(submitted.result.record.id, ids.b, 'apply', guard(), actor)).rejects.toMatchObject({ status: 404 });
    expect(await svc.recoverRequest(ids.b, submitted.dto.requestId, actor)).toEqual({ state: 'unconfirmed' });
  });

  it('protects every legacy mutation against missing guards or stale revisions', async () => {
    await expect(svc.update(ids.rate, ids.a, { baseAmount: '150.00' }, actor)).rejects.toMatchObject({ response: { code: 'MUTATION_GUARD_REQUIRED' } });
    await expect(svc.createRestriction(ids.rate, ids.a, { startDate: date, endDate: date } as any)).rejects.toMatchObject({ status: 400 });
    await expect(svc.deleteRestriction(randomUUID(), ids.a)).rejects.toMatchObject({ status: 400 });
    await expect(svc.update(ids.rate, ids.a, { ...guard(0), baseAmount: '150.00' }, actor)).rejects.toMatchObject({ response: { code: 'STALE_PRICING' } });
  });

  it('validates currency, nonnegative money, LOS, dates, override overlap and parent cycles', async () => {
    for (const patch of [{ baseAmount: '-1' }, { currencyCode: 'USD' }, { validFrom: '2027-06-01', validTo: date }, { parentRatePlanId: ids.child }])
      await expect(svc.update(ids.rate, ids.a, { ...guard(), ...patch }, actor)).rejects.toMatchObject({ status: 400 });
    await expect(svc.createRestriction(ids.rate, ids.a, { ...guard(), propertyId: ids.a, startDate: date, endDate: date, minLos: 3, maxLos: 1 }, actor)).rejects.toMatchObject({ status: 400 });
    await svc.createRestriction(ids.rate, ids.a, { ...guard(), propertyId: ids.a, startDate: date, endDate: date, rateOverride: 175, overrideReason: 'Event' }, actor);
    await expect(svc.createRestriction(ids.rate, ids.a, { ...guard(2), propertyId: ids.a, startDate: date, endDate: date, rateOverride: 180, overrideReason: 'Other event' }, actor))
      .rejects.toMatchObject({ response: { code: 'OVERLAPPING_RATE_OVERRIDE' } });
  });

  it('restriction writes atomically revise parent, canonical price, audit and outbox; update rollback and replay', async () => {
    const created = await svc.createRestriction(ids.rate, ids.a, { ...guard(), propertyId: ids.a, startDate: date, endDate: date, rateOverride: 175, overrideReason: 'Event' }, actor);
    const dto = { ...guard(2), rateOverride: 190, overrideReason: 'Adjusted event' };
    vi.spyOn(outbox, 'persist').mockRejectedValueOnce(new Error('outbox unavailable'));
    await expect(svc.updateRestriction(created.record.id, ids.a, dto, actor, ids.rate)).rejects.toThrow('outbox unavailable');
    expect((await scopedRows(rateRestrictions))[0]!.rateOverride).toBe('175.00');
    expect((await plan()).revision).toBe(2);
    const updated = await svc.updateRestriction(created.record.id, ids.a, dto, actor, ids.rate);
    expect(updated.record).toMatchObject({ revision: 2, planRevision: 3, rateOverride: '190.00' });
    expect(await svc.updateRestriction(created.record.id, ids.a, dto, actor, ids.rate)).toEqual({ record: updated.record, replayed: true });
    expect((await svc.calculateDerivedRate(ids.rate, ids.a, { stayDate: date })).effectiveRate).toBe(190);
    await expect(svc.deleteRestriction(created.record.id, ids.a, guard(3), actor, ids.child)).rejects.toMatchObject({ status: 404 });
    await svc.deleteRestriction(created.record.id, ids.a, guard(3), actor, ids.rate);
    expect((await plan()).revision).toBe(4);
    expect(await scopedRows(rateRestrictions)).toHaveLength(0);
    expect(await scopedRows(domainEventOutbox)).toHaveLength(3);
  });

  it('preview is read-only and uses the same canonical nightly quote including taxes as live rates', async () => {
    const dto = patch();
    const preview = await svc.previewLiveChange(dto);
    expect(preview).toMatchObject({ mode: 'LIVE_PREVIEW', planRevision: 1, acceptedPricesChanged: false, isEarnedRevenue: false });
    expect(preview.days[0]).toMatchObject({ before: { effectiveRate: 100 }, after: { effectiveRate: 120 }, beforeQuote: { totalAmount: '110.00' }, afterQuote: { totalAmount: '132.00' } });
    expect((await plan()).baseAmount).toBe('100.00');
    expect(await scopedRows(auditLogs)).toHaveLength(0);
    expect(await scopedRows(rateChangeRequests)).toHaveLength(0);
    const live = await calendar({ ratePlanId: ids.rate });
    const quote = await calculateCanonicalRoomPricing({ propertyId: ids.a, ratePlanId: ids.rate, checkIn: date, checkOut: '2027-05-02', nights: 1,
      isTaxInclusive: false, ratePlanService: svc, taxService: taxes });
    expect(live.rates[0].quote).toEqual(quote);
  });

  it('provides real category occupancy, pickup and pace with unavailable forecast and no quoted actuals', async () => {
    const live = await calendar({ roomTypeId: ids.type });
    expect(live.signals).toMatchObject({ source: 'ReportsService', synthetic: false, operationalDate: date,
      actual: { status: 'NO_POSTINGS', value: null }, forecast: { status: 'INSUFFICIENT_HISTORY', value: null } });
    expect(live.signals.daily[0]).toMatchObject({ roomsOnBooks: 1, onBooksOccupancy: 0.5, realisedRooms: 0, pickup: { roomNights: 1 } });
    expect(live.signals.pace.daily[0]).toMatchObject({ roomsOnBooks: 1 });
    expect(live.rates[0]).toMatchObject({ recommendation: { source: 'RatePlanService', requiresHumanReview: true }, isEarnedRevenue: false });
    await db.update(reservations).set({ status: 'cancelled' }).where(and(eq(reservations.id, ids.reservation), eq(reservations.propertyId, ids.a)));
    expect((await calendar()).signals.daily[0].roomsOnBooks).toBe(0);
  });

  it('real inventory OOO/OOS affects authoritative occupancy-band pricing without synthetic demand', async () => {
    const [room] = await scopedRows(rooms);
    await db.insert(roomInventoryBlocks).values({ propertyId: ids.a, roomId: room!.id, startDate: date, endDate: '2027-05-03', kind: 'OOO', reason: 'Repair', idempotencyKey: randomUUID() });
    await db.update(ratePlans).set({ occupancyBands: [{ occupancyPctMin: 90, occupancyPctMax: 100, adjustmentType: 'fixed', adjustmentValue: 50 }] })
      .where(and(eq(ratePlans.id, ids.rate), eq(ratePlans.propertyId, ids.a)));
    const live = await calendar({ ratePlanId: ids.rate });
    expect(live.signals.daily[0]).toMatchObject({ availableRooms: 1, onBooksOccupancy: 1 });
    expect(live.rates[0].price).toMatchObject({ occupancyPct: 100, effectiveRate: 150 });
  });

  it('enforces independent approval policy including on legacy writes and history', async () => {
    await db.update(properties).set({ settings: { pricingApprovalRequired: true } }).where(eq(properties.id, ids.a));
    await expect(svc.update(ids.rate, ids.a, { ...guard(), baseAmount: '120.00' }, actor)).rejects.toMatchObject({ response: { code: 'APPROVAL_REQUIRED' } });
    const { result } = await proposal();
    expect(result.record).toMatchObject({ status: 'pending', revision: 1 });
    expect(await svc.approvalQueue(ids.a)).toHaveLength(1);
    await expect(svc.decideLiveChange(result.record.id, ids.a, 'apply', guard(), actor)).rejects.toMatchObject({ response: { code: 'APPROVAL_REQUIRED' } });
    await expect(svc.decideLiveChange(result.record.id, ids.a, 'approve', guard(), actor)).rejects.toMatchObject({ status: 403 });
    const approved = await svc.decideLiveChange(result.record.id, ids.a, 'approve', guard(), approver);
    expect(approved.record).toMatchObject({ status: 'approved', revision: 2, approvedBy: approver.userId });
    const dto = guard(2);
    const applied = await svc.decideLiveChange(result.record.id, ids.a, 'apply', dto, actor);
    expect(applied.record).toMatchObject({ status: 'applied', revision: 3 });
    expect(await svc.decideLiveChange(result.record.id, ids.a, 'apply', dto, actor)).toEqual({ record: applied.record, replayed: true });
    expect(await svc.approvalQueue(ids.a)).toHaveLength(0);
    expect(await svc.changeHistory(ids.a)).toHaveLength(1);
    expect((await svc.pricingHistory(ids.a)).map(row => row.action)).toContain('apply');
    expect((await plan()).baseAmount).toBe('120.00');
  });

  it('rejects proposal without changing live price and retains terminal history', async () => {
    const { result } = await proposal();
    const rejected = await svc.decideLiveChange(result.record.id, ids.a, 'reject', guard(), approver);
    expect(rejected.record.status).toBe('rejected');
    expect((await plan()).baseAmount).toBe('100.00');
    await expect(svc.decideLiveChange(result.record.id, ids.a, 'apply', guard(2), actor)).rejects.toMatchObject({ status: 409 });
    expect(await svc.changeHistory(ids.a)).toHaveLength(1);
  });

  it('rejects stale preview and stale proposals after canonical rates change', async () => {
    const dto = patch();
    const preview = await svc.previewLiveChange(dto);
    const submitted = await svc.submitLiveChange({ ...dto, stateToken: preview.stateToken }, actor);
    await svc.update(ids.rate, ids.a, { ...guard(), baseAmount: '130.00' }, actor);
    await expect(svc.submitLiveChange({ ...dto, requestId: randomUUID(), stateToken: preview.stateToken }, actor)).rejects.toMatchObject({ response: { code: 'STALE_PRICING' } });
    await expect(svc.decideLiveChange(submitted.record.id, ids.a, 'apply', guard(), actor)).rejects.toMatchObject({ response: { code: 'STALE_PRICING' } });
    expect((await svc.changeHistory(ids.a))[0]?.status).toBe('pending');
  });

  it('state token detects changed occupancy/tax inputs even when plan revision is unchanged', async () => {
    await db.update(ratePlans).set({ occupancyBands: [{ occupancyPctMin: 40, occupancyPctMax: 100, adjustmentType: 'fixed', adjustmentValue: 50 }] })
      .where(and(eq(ratePlans.id, ids.rate), eq(ratePlans.propertyId, ids.a)));
    const { result } = await proposal();
    await db.update(reservations).set({ status: 'cancelled' }).where(and(eq(reservations.id, ids.reservation), eq(reservations.propertyId, ids.a)));
    await expect(svc.decideLiveChange(result.record.id, ids.a, 'apply', guard(), actor)).rejects.toMatchObject({ response: { code: 'STALE_PRICING' } });
  });

  it('applying date override changes new canonical quotes but never accepted snapshots/totals', async () => {
    const { result, preview } = await proposal({ kind: 'restriction_create', plan: undefined,
      restriction: { startDate: date, endDate: date, rateOverride: 175, overrideReason: 'Event' } });
    await svc.decideLiveChange(result.record.id, ids.a, 'apply', guard(), actor);
    const live = await calendar({ ratePlanId: ids.rate });
    expect(live.rates[0].quote).toEqual(preview.days[0].afterQuote);
    expect(live.rates[1].price.effectiveRate).toBe(100);
    const [reservation] = await scopedRows(reservations);
    expect(reservation!.acceptedPricingSnapshot).toEqual(accepted);
    expect(reservation!.totalAmount).toBe('220.00');
    expect(live.rates[0].price.override).toMatchObject({ amount: 175, reason: 'Event' });
  });

  it('rolls back both canonical application and proposal transition when event persistence fails', async () => {
    const { result } = await proposal();
    const persist = outbox.persist.bind(outbox);
    vi.spyOn(outbox, 'persist').mockImplementation(async (tx, payload, key) => {
      if (payload.event === 'rate_change.applied') throw new Error('application event failed');
      await persist(tx, payload, key);
    });
    await expect(svc.decideLiveChange(result.record.id, ids.a, 'apply', guard(), actor)).rejects.toThrow('application event failed');
    expect((await plan()).baseAmount).toBe('100.00');
    expect((await svc.changeHistory(ids.a))[0]?.status).toBe('pending');
    expect(await scopedRows(domainEventOutbox)).toHaveLength(1);
  });

  it('shows live stop sell and validates proposed sellability without mutating restrictions', async () => {
    const preview = await svc.previewLiveChange({ ...patch(), kind: 'restriction_create', plan: undefined, restriction: { startDate: date, endDate: date, isClosed: true } });
    expect(preview.days[0]).toMatchObject({ beforeSales: { sellable: true }, afterSales: { sellable: false } });
    expect(await scopedRows(rateRestrictions)).toHaveLength(0);
  });

  it('serializes canonical pricing against live rate updates without deadlocking accepted-pricing/FK locks', async () => {
    let locked!: () => void, release!: () => void, propertyLocked!: () => void;
    const ready = new Promise<void>(resolve => { locked = resolve; });
    const finish = new Promise<void>(resolve => { release = resolve; });
    const pricingMutex = new Promise<void>(resolve => { propertyLocked = resolve; });
    const originalProperty = (svc as any).property.bind(svc);
    const mutexSpy = vi.spyOn(svc as any, 'property').mockImplementation(async (...args) => {
      const result = await originalProperty(...args);
      if (args[2]) propertyLocked();
      return result;
    });
    const acceptance = withAcceptedPricingLock(db, ids.a, ids.reservation, async tx => {
      const quote = await calculateCanonicalRoomPricing({ propertyId: ids.a, ratePlanId: ids.rate, checkIn: date, checkOut: '2027-05-03', nights: 2,
        isTaxInclusive: false, ratePlanService: svc, taxService: taxes, db: tx, lockForUpdate: true });
      locked();
      await finish;
      // An accepted-price transaction can insert a property FK after locking canonical rates.
      await tx.insert(bookings).values({ propertyId: ids.a, guestId: ids.guest, confirmationNumber: 'CONCURRENT-' + randomUUID(), source: 'direct' });
      return quote;
    });
    await ready;
    const mutation = svc.update(ids.rate, ids.a, { ...guard(), baseAmount: '150.00' }, actor);
    try {
      await pricingMutex;
      release();
      const [quote, updated] = await Promise.all([acceptance, mutation]);
      expect(quote.totalAmount).toBe('220.00');
      expect(updated.record).toMatchObject({ baseAmount: '150.00', revision: 2 });
      expect((await scopedRows(reservations))[0]!.acceptedPricingSnapshot).toEqual(accepted);
    } finally {
      release();
      mutexSpy.mockRestore();
    }
  });

  it('HTTP verifies JWT, property membership and real PostgreSQL permissions before financial writes', async () => {
    await request(app.getHttpServer()).patch(url(ids.rate + '?propertyId=' + ids.a)).send({ ...guard(), baseAmount: '150.00' }).expect(401);
    await auth('patch', ids.foreignRate + '?propertyId=' + ids.b).send({ ...guard(), baseAmount: '150.00' }).expect(403);
    await db.delete(rolePermissions).where(and(eq(rolePermissions.propertyId, ids.a), eq(rolePermissions.permissionKey, 'rateplans.manage')));
    await auth('patch', ids.rate + '?propertyId=' + ids.a).send({ ...guard(), baseAmount: '150.00' }).expect(403);
    expect((await plan()).baseAmount).toBe('100.00');
    expect(await scopedRows(auditLogs)).toHaveLength(0);
  });

  it('HTTP rejects body/query property mismatch and validates guard DTOs on every legacy route', async () => {
    await auth('post', 'live-preview?propertyId=' + ids.a).send({ ...patch(), propertyId: ids.b }).expect(400);
    await auth('post', 'rate-changes?propertyId=' + ids.a).send({ ...patch(), propertyId: ids.b }).expect(400);
    await auth('post', ids.rate + '/restrictions?propertyId=' + ids.a).send({ ...guard(), propertyId: ids.b, startDate: date, endDate: date }).expect(400);
    await auth('patch', ids.rate + '?propertyId=' + ids.a).send({ baseAmount: '150.00' }).expect(400);
    await auth('patch', ids.rate + '/restrictions/' + randomUUID() + '?propertyId=' + ids.a).send({ isClosed: true }).expect(400);
    await auth('delete', ids.rate + '/restrictions/' + randomUUID() + '?propertyId=' + ids.a).expect(400);
    await auth('post', 'live-preview').send({ ...patch(), plan: { baseAmount: '120.00', propertyId: ids.b } }).expect(400);
    await auth('post', 'live-preview').send({ ...patch(), plan: { isTaxInclusive: null } }).expect(400);
    await auth('post', 'live-preview').send({ ...patch(), kind: 'restriction_create', plan: undefined,
      restriction: { startDate: date, endDate: date, isClosed: null } }).expect(400);
    expect((await plan()).revision).toBe(1);
    expect(await scopedRows(auditLogs)).toHaveLength(0);
  });

  it('HTTP requires report permission for actuals and stronger approval permission for financial decisions', async () => {
    await db.delete(rolePermissions).where(and(eq(rolePermissions.propertyId, ids.a), eq(rolePermissions.permissionKey, 'reports.view')));
    await auth('get', 'live-calendar?propertyId=' + ids.a + '&startDate=' + date + '&endDate=' + date).expect(403);
    const { result } = await proposal();
    await db.delete(rolePermissions).where(and(eq(rolePermissions.propertyId, ids.a), eq(rolePermissions.permissionKey, 'revenue.manage')));
    await auth('post', 'rate-changes/' + result.record.id + '/approve?propertyId=' + ids.a).send(guard()).expect(403);
    await auth('post', 'rate-changes/' + result.record.id + '/reject?propertyId=' + ids.a).send(guard()).expect(403);
    expect((await svc.changeHistory(ids.a))[0]!.status).toBe('pending');
  });

  it('HTTP executes validated preview→submit→apply and replay with unchanged accepted pricing', async () => {
    const dto = patch();
    const preview = (await auth('post', 'live-preview').send(dto).expect(201)).body;
    expect(preview.days[0].after.effectiveRate).toBe(120);
    const submitted = (await auth('post', 'rate-changes').send({ ...dto, stateToken: preview.stateToken }).expect(201)).body;
    const decision = guard();
    const path = 'rate-changes/' + submitted.record.id + '/apply?propertyId=' + ids.a;
    expect((await auth('post', path).send(decision).expect(201)).body.record.status).toBe('applied');
    expect((await auth('post', path).send(decision).expect(201)).body.replayed).toBe(true);
    expect((await auth('get', 'rate-changes?propertyId=' + ids.a).expect(200)).body).toHaveLength(1);
    expect((await auth('get', 'requests/' + decision.requestId + '?propertyId=' + ids.a).expect(200)).body.state).toBe('committed');
    expect((await scopedRows(reservations))[0]!.acceptedPricingSnapshot).toEqual(accepted);
  });

  it('HTTP exposes transformed numeric stays and required scope/date validation on calendar', async () => {
    const live = await auth('get', 'live-calendar?propertyId=' + ids.a + '&startDate=' + date + '&endDate=' + date + '&nights=2').expect(200);
    expect(live.body.rates.find((row: any) => row.ratePlanId === ids.rate).quote.totalAmount).toBe('220.00');
    await auth('get', 'live-calendar?propertyId=' + ids.a + '&startDate=2027-02-30&endDate=2027-03-01').expect(400);
    await auth('get', 'live-calendar?propertyId=' + ids.a + '&startDate=' + date + '&endDate=' + date + '&nights=0').expect(400);
    await auth('get', 'live-calendar?startDate=' + date + '&endDate=' + date).expect(403);
  });

  it('generates Swagger for live calendar, nested guarded patches, decisions and recovery', () => {
    const document = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle('Pricing test').build());
    expect(document.paths['/api/v1/rate-plans/live-calendar']?.get?.responses['200']).toBeDefined();
    expect(document.components?.schemas?.GuardedUpdateRatePlanDto?.required).toEqual(expect.arrayContaining(['requestId', 'expectedRevision', 'reason']));
    expect(document.components?.schemas?.LiveRateChangeDto).toBeDefined();
    expect(document.components?.schemas?.LiveRatePreviewDto).toBeDefined();
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { guests, properties, guestPropertyLinks, auditLogs, services, serviceBookings, users, roles, userRoles, rolePermissions } from '@telivityhaip/database';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { PermissionsService } from '../auth/permissions.service';
import { PermissionsGuard } from '../auth/permissions.guard';
import { PropertyScopeGuard } from '../auth/property-scope.guard';
import { GuestService } from './guest.service';
import { GuestController } from './guest.controller';
import { DRIZZLE } from '../../database/database.module';

// Run against an isolated, migrated core database, WITHOUT booking-request migrations.
describe.runIf(process.env.PMS_LIVE_PG === '1')('Guest 360 HTTP on the core PostgreSQL schema', () => {
  const client = postgres(process.env.DATABASE_URL!, { max: 4 });
  const db = drizzle(client);
  const propertyId = randomUUID();
  const otherPropertyId = randomUUID();
  const guestId = randomUUID();
  const serviceGuestId = randomUUID(); const serviceId = randomUUID();
  const staffId = randomUUID(); const roleId = randomUUID(); const staffSub = randomUUID();
  let app: INestApplication;

  beforeAll(async () => {
    await db.insert(properties).values([propertyId, otherPropertyId].map((id, i) => ({
      id, name: 'Guest 360 test', code: 'G360-' + id.slice(0, 8), countryCode: 'KZ',
      timezone: 'Asia/Almaty', currencyCode: 'KZT', totalRooms: i,
    })));
    await db.insert(guests).values({ id: guestId, firstName: 'Тест', lastName: 'Без истории', notes: 'Постоянная заметка' });
    await db.insert(guestPropertyLinks).values({ propertyId, guestId, source: 'pms' });
    await db.insert(auditLogs).values({ propertyId, entityId: guestId, entityType: 'guest', action: 'create' });
    await db.insert(guests).values({ id: serviceGuestId, firstName: 'Услуга', lastName: 'Без проживания' });
    await db.insert(services).values({ id: serviceId, propertyId, code: 'SPA', name: 'Тестовая услуга', price: '100.00', currencyCode: 'KZT' });
    await db.insert(serviceBookings).values({ propertyId, guestId: serviceGuestId, serviceId, startAt: new Date('2026-10-10T10:00:00Z'), endAt: new Date('2026-10-10T11:00:00Z'), unitPrice: '100.00', totalAmount: '100.00', currencyCode: 'KZT' });
    await db.insert(users).values({ id: staffId, keycloakSub: staffSub, name: 'Test staff', email: staffId + '@example.invalid' });
    await db.insert(roles).values({ id: roleId, propertyId, key: 'g360-test', name: 'Guest reader' });
    await db.insert(userRoles).values({ userId: staffId, roleId, propertyId });
    await db.insert(rolePermissions).values({ roleId, propertyId, permissionKey: 'guests.read' });
    const moduleRef = await Test.createTestingModule({ controllers: [GuestController], providers: [
      GuestService, PermissionsService, { provide: DRIZZLE, useValue: db },
    ] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    // Inject only a test identity. Real membership and permission guards use PostgreSQL.
    // JWT signature / Keycloak validation is deliberately outside this fixture.
    app.use((req: any, _res: any, next: () => void) => {
      if (req.headers['x-test-identity'] !== 'none') req.user = { sub: staffSub, roles: [], propertyIds: [propertyId] };
      next();
    });
    const config = new ConfigService({ AUTH_ENABLED: 'true' }); const reflector = new Reflector();
    app.useGlobalGuards(new PropertyScopeGuard(reflector, config), new PermissionsGuard(reflector, config, moduleRef.get(PermissionsService)));
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await db.delete(userRoles).where(eq(userRoles.userId, staffId));
    await db.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));
    await db.delete(roles).where(eq(roles.id, roleId));
    await db.delete(users).where(eq(users.id, staffId));
    await db.delete(serviceBookings).where(eq(serviceBookings.serviceId, serviceId));
    await db.delete(services).where(eq(services.id, serviceId));
    await db.delete(guests).where(eq(guests.id, serviceGuestId));
    await db.delete(auditLogs).where(eq(auditLogs.propertyId, propertyId));
    await db.delete(guestPropertyLinks).where(eq(guestPropertyLinks.guestId, guestId));
    await db.delete(guests).where(eq(guests.id, guestId));
    await db.delete(properties).where(eq(properties.id, propertyId));
    await db.delete(properties).where(eq(properties.id, otherPropertyId));
    await client.end();
  });

  it('opens a linked guest without contacts or stays and returns actual audit history', async () => {
    await request(app.getHttpServer()).get(`/api/v1/guests/${guestId}`).query({ propertyId }).expect(200);
    const response = await request(app.getHttpServer()).get(`/api/v1/guests/${guestId}/360`).query({ propertyId }).expect(200);
    expect(response.body.guest.notes).toBe('Постоянная заметка');
    expect(response.body.guest.email).toBeNull();
    expect(response.body.stays).toEqual([]);
    expect(response.body.services).toEqual([]);
    expect(response.body.summary.totalStays).toBe(0);
    expect(response.body.timeline).toHaveLength(1);
    expect(response.body.timeline[0].action).toBe('create');
  });

  it('does not expose a guest to an unrelated property', async () => {
    await request(app.getHttpServer()).get(`/api/v1/guests/${guestId}/360`).query({ propertyId: otherPropertyId }).expect(403);
    await expect(app.get(GuestService).get360(guestId, otherPropertyId)).rejects.toMatchObject({ status: 404 });
  });

  it('requires a valid property scope', async () => {
    await request(app.getHttpServer()).get(`/api/v1/guests/${guestId}/360`).expect(403);
  });
  it('opens a service-only guest without inventing a room stay or membership row', async () => {
    const list = await app.get(GuestService).search(propertyId, {});
    expect(list.data.some((guest: any) => guest.id === serviceGuestId)).toBe(true);
    const response = await request(app.getHttpServer()).get(`/api/v1/guests/${serviceGuestId}/360`).query({ propertyId }).expect(200);
    expect(response.body.stays).toEqual([]);
    expect(response.body.bookedServices).toHaveLength(1);
    expect(response.body.bookedServices[0].serviceName).toBe('Тестовая услуга');
  });
  it('denies a request without an authenticated identity', async () => {
    await request(app.getHttpServer()).get(`/api/v1/guests/${guestId}/360`).set('x-test-identity', 'none').query({ propertyId }).expect(403);
  });
  it('denies a member whose guest permission was revoked in PostgreSQL', async () => {
    await db.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));
    try { await request(app.getHttpServer()).get(`/api/v1/guests/${guestId}/360`).query({ propertyId }).expect(403); }
    finally { await db.insert(rolePermissions).values({ roleId, propertyId, permissionKey: 'guests.read' }); }
  });
});

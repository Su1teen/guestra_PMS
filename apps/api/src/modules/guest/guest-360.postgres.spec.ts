import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID, generateKeyPairSync, sign } from 'node:crypto';
import { createServer, type Server } from 'node:http';
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
import { JwtStrategy } from '../auth/jwt.strategy';
import { JwtAuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { AdminController } from '../admin/admin.controller';
import { UsersService } from '../admin/users.service';
import { RolesService } from '../admin/roles.service';
import { WORKSPACE_PRESETS, workspaceTemplate } from '@telivityhaip/shared';

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
  let jwks: Server; let issuer: string;
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  function token(overrides: Record<string, unknown> = {}, signingKey = keys.privateKey) {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'rc-test', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ iss: issuer, aud: 'pms-test', azp: 'pms-test',
      sub: staffSub, exp: Math.floor(Date.now() / 1000) + 300, property_ids: [propertyId],
      realm_access: { roles: [] }, ...overrides })).toString('base64url');
    const content = `${header}.${payload}`;
    return `${content}.${sign('RSA-SHA256', Buffer.from(content), signingKey).toString('base64url')}`;
  }
  const authorized = () => ({ get: (url: string) => request(app.getHttpServer()).get(url).auth(token(), { type: 'bearer' }) });

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
    await db.insert(rolePermissions).values(['guests.read', 'dashboard.view'].map(permissionKey => ({ roleId, propertyId, permissionKey })));
    // Local JWKS is an isolated issuer fixture; the production Passport strategy verifies the signature.
    // This proves JWT enforcement, not connectivity to an external Keycloak realm.
    jwks = createServer((req, res) => {
      if (req.url !== '/realms/rc-test/protocol/openid-connect/certs') { res.writeHead(404).end(); return; }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ keys: [{ ...keys.publicKey.export({ format: 'jwk' }), kid: 'rc-test', alg: 'RS256', use: 'sig' }] }));
    });
    await new Promise<void>(resolve => jwks.listen(0, '127.0.0.1', resolve));
    const keycloakUrl = `http://127.0.0.1:${(jwks.address() as import('node:net').AddressInfo).port}`;
    issuer = `${keycloakUrl}/realms/rc-test`;
    const config = new ConfigService({ AUTH_ENABLED: 'true', KEYCLOAK_URL: keycloakUrl,
      KEYCLOAK_REALM: 'rc-test', KEYCLOAK_CLIENT_ID: 'pms-test' });
    const moduleRef = await Test.createTestingModule({ controllers: [GuestController, AdminController], providers: [
      GuestService, PermissionsService, UsersService, { provide: RolesService, useValue: {} }, { provide: DRIZZLE, useValue: db },
      { provide: ConfigService, useValue: config }, JwtStrategy,
    ] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    const reflector = new Reflector();
    app.useGlobalGuards(new JwtAuthGuard(reflector, config), new RolesGuard(reflector, config),
      new PropertyScopeGuard(reflector, config), new PermissionsGuard(reflector, config, moduleRef.get(PermissionsService)));
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    if (jwks) await new Promise<void>(resolve => jwks.close(() => resolve()));
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
    await authorized().get(`/api/v1/guests/${guestId}`).query({ propertyId }).expect(200);
    const response = await authorized().get(`/api/v1/guests/${guestId}/360`).query({ propertyId }).expect(200);
    expect(response.body.guest.notes).toBe('Постоянная заметка');
    expect(response.body.guest.email).toBeNull();
    expect(response.body.stays).toEqual([]);
    expect(response.body.services).toEqual([]);
    expect(response.body.summary.totalStays).toBe(0);
    expect(response.body.timeline).toHaveLength(1);
    expect(response.body.timeline[0].action).toBe('create');
  });

  it('does not expose a guest to an unrelated property', async () => {
    await authorized().get(`/api/v1/guests/${guestId}/360`).query({ propertyId: otherPropertyId }).expect(403);
    await expect(app.get(GuestService).get360(guestId, otherPropertyId)).rejects.toMatchObject({ status: 404 });
  });

  it('requires a valid property scope', async () => {
    await authorized().get(`/api/v1/guests/${guestId}/360`).expect(403);
  });
  it('opens a service-only guest without inventing a room stay or membership row', async () => {
    const list = await app.get(GuestService).search(propertyId, {});
    expect(list.data.some((guest: any) => guest.id === serviceGuestId)).toBe(true);
    const response = await authorized().get(`/api/v1/guests/${serviceGuestId}/360`).query({ propertyId }).expect(200);
    expect(response.body.stays).toEqual([]);
    expect(response.body.bookedServices).toHaveLength(1);
    expect(response.body.bookedServices[0].serviceName).toBe('Тестовая услуга');
  });
  it('denies a request without an authenticated identity', async () => {
    await request(app.getHttpServer()).get(`/api/v1/guests/${guestId}/360`).query({ propertyId }).expect(401);
  });
  it('denies a member whose guest permission was revoked in PostgreSQL', async () => {
    await db.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));
    try { await authorized().get(`/api/v1/guests/${guestId}/360`).query({ propertyId }).expect(403); }
    finally { await db.insert(rolePermissions).values(['guests.read', 'dashboard.view'].map(permissionKey => ({ roleId, propertyId, permissionKey }))); }
  });
  it('rejects invalid JWT signatures, expiry, issuer, audience and authorized party', async () => {
    for (const claims of [{ exp: 1 }, { iss: 'https://foreign.invalid/realms/rc-test' }, { aud: 'foreign-client' }, { azp: 'foreign-client' }])
      await request(app.getHttpServer()).get(`/api/v1/guests/${guestId}/360`).auth(token(claims), { type: 'bearer' }).query({ propertyId }).expect(401);
    const otherKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    await request(app.getHttpServer()).get(`/api/v1/guests/${guestId}/360`).auth(token({}, otherKeys.privateKey), { type: 'bearer' }).query({ propertyId }).expect(401);
  });

  it('persists all five role templates and widget settings for a second authenticated HTTP client', async () => {
    let revision = 0;
    for (const preset of WORKSPACE_PRESETS) {
      const layout = workspaceTemplate(preset);
      layout.pages[0].widgets[0].settings = { propertyId, period: 'next28', density: 'compact' };
      const saved = await request(app.getHttpServer()).patch('/api/v1/admin/me/workspace')
        .auth(token(), { type: 'bearer' }).send({ propertyId, expectedRevision: revision, layout }).expect(200);
      revision++;
      expect(saved.body.revision).toBe(revision);
      const secondClient = await request(app.getHttpServer()).get('/api/v1/admin/me/workspace')
        .auth(token(), { type: 'bearer' }).query({ propertyId }).expect(200);
      expect(secondClient.body.layout).toEqual(layout);
      expect(secondClient.body.revision).toBe(revision);
      expect(secondClient.body.persistent).toBe(true);
    }
    await request(app.getHttpServer()).patch('/api/v1/admin/me/workspace').auth(token(), { type: 'bearer' })
      .send({ propertyId, expectedRevision: 0, layout: workspaceTemplate('frontdesk') }).expect(409);
    const final = await authorized().get('/api/v1/admin/me/workspace').query({ propertyId }).expect(200);
    expect(final.body.revision).toBe(revision);
    expect(final.body.layout.pages[0].preset).toBe('management');
  });

  it('rejects unauthorized property settings and workspace access without database permissions', async () => {
    const layout = workspaceTemplate('frontdesk');
    layout.pages[0].widgets[0].settings.propertyId = otherPropertyId;
    await request(app.getHttpServer()).patch('/api/v1/admin/me/workspace').auth(token(), { type: 'bearer' })
      .send({ propertyId, expectedRevision: 5, layout }).expect(403);
    await authorized().get('/api/v1/admin/me/workspace').query({ propertyId: otherPropertyId }).expect(403);
    await db.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));
    try {
      await authorized().get('/api/v1/admin/me/workspace').query({ propertyId }).expect(403);
      await request(app.getHttpServer()).patch('/api/v1/admin/me/workspace').auth(token(), { type: 'bearer' })
        .send({ propertyId, expectedRevision: 5, layout: workspaceTemplate('frontdesk') }).expect(403);
    } finally {
      await db.insert(rolePermissions).values(['guests.read', 'dashboard.view'].map(permissionKey => ({ roleId, propertyId, permissionKey })));
    }
  });

});

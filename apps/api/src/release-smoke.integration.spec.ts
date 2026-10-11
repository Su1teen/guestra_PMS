/**
 * Release smoke test — exercises migrate → seed → core PMS HTTP contract.
 *
 * Runs only when RELEASE_SMOKE=1 (CI release-smoke job). Uses AUTH_ENABLED=false
 * so the flow tests business endpoints without Keycloak setup.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import request from 'supertest';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { Queue } from 'bullmq';
import { agentWebhookSubscriptions, webhookDeliveries } from '@telivityhaip/database';
import { WebhookDeliveryService } from './modules/webhook/webhook-delivery.service';
import { DRIZZLE } from './database/database.module';

const runSmoke = process.env.RELEASE_SMOKE === '1';

/** Seeded demo property and entities (packages/database/src/seed.ts). */
const PROPERTY_ID = 'a0000001-0000-4000-a000-000000000001';
const GUEST_ID = 'e0000001-0000-4000-a000-000000000001';
const ROOM_TYPE_ID = 'b0000001-0000-4000-a000-000000000001';
const RATE_PLAN_ID = 'd0000001-0000-4000-a000-000000000001';
const ROOM_ID = 'c0000001-0000-4000-a000-000000000008'; // room 108 — vacant_clean

function offsetDate(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

describe.runIf(runSmoke)('release smoke (migrate → reservation lifecycle)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
      throw new Error('DATABASE_URL is required for release smoke');
    }

    process.env.AUTH_ENABLED = 'false';
    process.env.NODE_ENV = 'test';
    process.env.STRIPE_MODE = 'mock';
    process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

    const root = join(__dirname, '..', '..', '..');
    execSync('node packages/database/dist/run-migrations.js', {
      cwd: root,
      env: { ...process.env, DATABASE_URL: dbUrl },
      stdio: 'inherit',
    });
    execSync('node packages/database/dist/seed.js', {
      cwd: root,
      env: { ...process.env, DATABASE_URL: dbUrl },
      stdio: 'inherit',
    });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  it('search availability → create reservation → check-in → folio charge → night audit', async () => {
    const arrivalDate = offsetDate(30);
    const departureDate = offsetDate(33);

    const availRes = await request(app.getHttpServer())
      .post('/api/v1/reservations/search-availability')
      .send({
        propertyId: PROPERTY_ID,
        checkIn: arrivalDate,
        checkOut: departureDate,
        roomTypeId: ROOM_TYPE_ID,
      })
      .expect(201);

    const availability = availRes.body;
    expect(Array.isArray(availability)).toBe(true);
    expect(availability.some((r: { roomTypeId: string }) => r.roomTypeId === ROOM_TYPE_ID)).toBe(
      true,
    );

    const createRes = await request(app.getHttpServer())
      .post('/api/v1/reservations')
      .send({
        propertyId: PROPERTY_ID,
        guestId: GUEST_ID,
        arrivalDate,
        departureDate,
        roomTypeId: ROOM_TYPE_ID,
        ratePlanId: RATE_PLAN_ID,
        totalAmount: '599.00',
        currencyCode: 'USD',
        source: 'direct',
        adults: 2,
      })
      .expect(201);

    const reservationId = createRes.body.id as string;
    expect(reservationId).toBeTruthy();

    await request(app.getHttpServer())
      .patch(`/api/v1/reservations/${reservationId}/confirm`)
      .query({ propertyId: PROPERTY_ID })
      .expect(200);

    await request(app.getHttpServer())
      .patch(`/api/v1/reservations/${reservationId}/assign-room`)
      .query({ propertyId: PROPERTY_ID })
      .send({ roomId: ROOM_ID })
      .expect(200);

    const checkInRes = await request(app.getHttpServer())
      .patch(`/api/v1/reservations/${reservationId}/check-in`)
      .query({ propertyId: PROPERTY_ID })
      .send({
        roomId: ROOM_ID,
        idType: 'passport',
        idNumber: 'SMOKE123',
        idCountry: 'US',
        registrationSigned: true,
        registrationData: {
          signatureMethod: 'front_desk',
          capturedBy: 'release-smoke',
        },
      })
      .expect(200);

    const folioId = checkInRes.body.folio?.id as string;
    expect(folioId).toBeTruthy();

    await request(app.getHttpServer())
      .post(`/api/v1/folios/${folioId}/charges`)
      .send({
        propertyId: PROPERTY_ID,
        type: 'minibar',
        description: 'Release smoke minibar charge',
        amount: '12.50',
        currencyCode: 'USD',
        serviceDate: arrivalDate,
      })
      .expect(201);

    const auditDate = offsetDate(-3);
    const auditRes = await request(app.getHttpServer())
      .post('/api/v1/night-audit/run')
      .send({ propertyId: PROPERTY_ID, businessDate: auditDate })
      .expect(200);

    expect(auditRes.body.auditRun?.status === 'completed' || auditRes.body.alreadyRun === true).toBe(
      true,
    );
  });

  it('accepts one staff booking under concurrent retries and keeps one durable consequence', async () => {
    const checkIn = offsetDate(60);
    const checkOut = offsetDate(63);
    const quote = await request(app.getHttpServer()).post('/api/v1/reservations/quote')
      .send({ propertyId: PROPERTY_ID, roomTypeId: ROOM_TYPE_ID, ratePlanId: RATE_PLAN_ID, checkIn, checkOut }).expect(201);
    const requestId = randomUUID();
    const payload = { propertyId: PROPERTY_ID, guestId: GUEST_ID, roomTypeId: ROOM_TYPE_ID,
      ratePlanId: RATE_PLAN_ID, roomId: 'c0000001-0000-4000-a000-000000000004', checkIn, checkOut,
      expectedTotal: quote.body.totalAmount, currencyCode: quote.body.currency, requestId, adults: 2 };
    const [first, replay] = await Promise.all([0, 1].map(() => request(app.getHttpServer())
      .post('/api/v1/reservations/staff-create').send(payload).expect(201)));
    expect(first.body.id).toBeTruthy();
    expect(replay.body.id).toBe(first.body.id);
    expect([first.body.replayed, replay.body.replayed].sort()).toEqual([false, true]);
    const db = app.get(DRIZZLE);
    const bookingCount = await db.execute(sql`select count(*)::int as count from bookings where property_id = ${PROPERTY_ID} and idempotency_key = ${'staff:' + requestId}`);
    const eventCount = await db.execute(sql`select count(*)::int as count from domain_event_outbox where property_id = ${PROPERTY_ID} and logical_event_id = ${'staff-reservation:' + requestId}`);
    expect(bookingCount[0].count).toBe(1);
    expect(eventCount[0].count).toBe(1);
    await request(app.getHttpServer()).post('/api/v1/reservations/staff-create')
      .send({ ...payload, adults: 1 }).expect(409);
    const calendar = await request(app.getHttpServer()).get('/api/v1/reservations/calendar')
      .query({ propertyId: PROPERTY_ID, checkIn, checkOut }).expect(200);
    expect(calendar.body.complete).toBe(true);
    expect(calendar.body.reservations.filter((stay: { id: string }) => stay.id === first.body.id)).toHaveLength(1);
  });

  it('rolls back the booking and outbox when physical room assignment fails', async () => {
    const checkIn = offsetDate(70);
    const checkOut = offsetDate(73);
    const quote = await request(app.getHttpServer()).post('/api/v1/reservations/quote')
      .send({ propertyId: PROPERTY_ID, roomTypeId: ROOM_TYPE_ID, ratePlanId: RATE_PLAN_ID, checkIn, checkOut }).expect(201);
    const requestId = randomUUID();
    const failed = await request(app.getHttpServer()).post('/api/v1/reservations/staff-create')
      .send({ propertyId: PROPERTY_ID, guestId: GUEST_ID, roomTypeId: ROOM_TYPE_ID, ratePlanId: RATE_PLAN_ID,
        roomId: randomUUID(), requestId, checkIn, checkOut, expectedTotal: quote.body.totalAmount,
        currencyCode: quote.body.currency, adults: 2 });
    expect(failed.status).toBeGreaterThanOrEqual(400);
    expect(failed.status).toBeLessThan(500);
    const db = app.get(DRIZZLE);
    const bookingCount = await db.execute(sql`select count(*)::int as count from bookings where property_id = ${PROPERTY_ID} and idempotency_key = ${'staff:' + requestId}`);
    const eventCount = await db.execute(sql`select count(*)::int as count from domain_event_outbox where property_id = ${PROPERTY_ID} and logical_event_id = ${'staff-reservation:' + requestId}`);
    expect(bookingCount[0].count).toBe(0);
    expect(eventCount[0].count).toBe(0);
  });
  it('persists one webhook job in Redis across queue client recreation', async () => {
    const db = app.get(DRIZZLE);
    const subscriptionId = randomUUID();
    const logicalEventId = randomUUID();
    const delivery = app.get(WebhookDeliveryService);
    const redis = new URL(process.env.REDIS_URL!);
    const reader = new Queue('haip-webhook-deliveries', { connection: {
      host: redis.hostname, port: Number(redis.port || 6379),
      username: redis.username ? decodeURIComponent(redis.username) : undefined,
      password: redis.password ? decodeURIComponent(redis.password) : undefined,
      db: Number(redis.pathname.slice(1) || 0),
      tls: redis.protocol === 'rediss:' ? {} : undefined,
      connectTimeout: 5000, maxRetriesPerRequest: 1,
    } });
    let jobId: string | undefined;
    try {
      await db.insert(agentWebhookSubscriptions).values({ id: subscriptionId, propertyId: PROPERTY_ID,
        subscriberId: 'release-smoke', callbackUrl: 'https://example.com/not-called',
        events: ['reservation.created'], isActive: false });
      const payload = { propertyId: PROPERTY_ID, eventType: 'reservation.created',
        entityType: 'reservation', entityId: randomUUID(), data: {}, timestamp: new Date().toISOString() };
      const first = await delivery.enqueue(payload, subscriptionId, logicalEventId);
      jobId = first.id;
      const replay = await delivery.enqueue(payload, subscriptionId, logicalEventId);
      expect(replay.id).toBe(first.id);
      // Close the actual producer; an independent client must still see the persisted job.
      await delivery.onModuleDestroy();
      const client = await reader.client;
      expect(await client.ping()).toBe('PONG');
      const job = await reader.getJob(first.id);
      expect(job?.data).toEqual({ deliveryId: first.id, propertyId: PROPERTY_ID });
      expect(await job!.getState()).toBe('waiting');
      const persisted = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.subscriptionId, subscriptionId));
      expect(persisted).toHaveLength(1);
      expect(persisted[0].status).toBe('pending');
      await job!.remove();
    } finally {
      if (jobId) await (await reader.getJob(jobId))?.remove();
      await reader.close();
      await db.delete(webhookDeliveries).where(eq(webhookDeliveries.subscriptionId, subscriptionId));
      await db.delete(agentWebhookSubscriptions).where(eq(agentWebhookSubscriptions.id, subscriptionId));
    }
  }, 30_000);

});

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, inArray } from 'drizzle-orm';
import { properties, users, staffNotifications, staffNotificationReads } from '@telivityhaip/database';
import { workspaceTemplate } from '@telivityhaip/shared';
import { UsersService } from './modules/admin/users.service';
import { StaffNotificationService } from './modules/staff-notifications/staff-notification.service';

describe.runIf(process.env.PMS_LIVE_PG === '1')('PMS workspace, notification and migration storage', () => {
  const client = postgres(process.env.DATABASE_URL!, { max: 6 });
  const db = drizzle(client);
  const propertyId = randomUUID(); const otherId = randomUUID(); const userId = randomUUID();
  const workspace = new UsersService(db, {} as any);
  const delivery = { emit: vi.fn() }; const gateway = { broadcastStaffNotification: vi.fn() };
  const notifications = new StaffNotificationService(db, delivery as any, gateway as any);
  beforeAll(async () => {
    await db.insert(properties).values([propertyId, otherId].map(id => ({ id, name: 'PMS storage test', code: 'ST-' + id.slice(0, 8), countryCode: 'KZ', timezone: 'Asia/Almaty', currencyCode: 'KZT', totalRooms: 0 })));
    await db.insert(users).values({ id: userId, email: `${userId}@example.invalid`, name: 'Test operator', preferences: { reportFavorites: ['occupancy'] } });
  });
  afterAll(async () => {
    const rows = await db.select({ id: staffNotifications.id }).from(staffNotifications).where(inArray(staffNotifications.propertyId, [propertyId, otherId]));
    if (rows.length) await db.delete(staffNotificationReads).where(inArray(staffNotificationReads.notificationId, rows.map(r => r.id)));
    await db.delete(staffNotifications).where(inArray(staffNotifications.propertyId, [propertyId, otherId]));
    await db.delete(users).where(eq(users.id, userId));
    await db.delete(properties).where(inArray(properties.id, [propertyId, otherId]));
    await client.end();
  });
  it('rejects one concurrent stale revision and preserves unrelated user preferences', async () => {
    const results = await Promise.allSettled([
      workspace.updateWorkspace(userId, { propertyId, expectedRevision: 0, layout: workspaceTemplate('frontdesk') as any }),
      workspace.updateWorkspace(userId, { propertyId, expectedRevision: 0, layout: workspaceTemplate('management') as any }),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason.response.code).toBe('WORKSPACE_CONFLICT');
    expect((await workspace.getPreferences(userId)).reportFavorites).toEqual(['occupancy']);
    expect((await workspace.getWorkspace(userId, propertyId)).revision).toBe(1);
  });
  it('preserves both properties when their layouts are saved concurrently', async () => {
    await Promise.all([
      workspace.updateWorkspace(userId, { propertyId, expectedRevision: 1, layout: workspaceTemplate('reservations') as any }),
      workspace.updateWorkspace(userId, { propertyId: otherId, expectedRevision: 0, layout: workspaceTemplate('operations') as any }),
    ]);
    expect((await workspace.getWorkspace(userId, propertyId)).revision).toBe(2);
    expect((await workspace.getWorkspace(userId, otherId)).revision).toBe(1);
  });
  it('deduplicates simultaneous hotel alerts and enforces audience and per-user read receipts', async () => {
    const input = { propertyId, type: 'hotel_event', title: 'Заезд', message: 'Проверить номер', deduplicationKey: 'event-a', requiredPermission: 'reservations.read' };
    const results = await Promise.all([notifications.create(input), notifications.create(input)]);
    const created = results.find(Boolean)!;
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(gateway.broadcastStaffNotification).toHaveBeenCalledTimes(1);
    expect(await notifications.listForUser(propertyId, userId, [])).toEqual([]);
    expect(await notifications.listForUser(otherId, userId, ['reservations.read'])).toEqual([]);
    await expect(notifications.markRead(created.id, propertyId, userId, [])).rejects.toThrow();
    await notifications.markRead(created.id, propertyId, userId, ['reservations.read']);
    expect(await notifications.unreadCount(propertyId, userId, ['reservations.read'])).toBe(0);
    expect(await notifications.unreadCount(propertyId, 'different-operator', ['reservations.read'])).toBe(1);
  });
  it('applies 0030/0031 twice to a legacy schema while preserving notifications and read state', async () => {
    const name = 'pms_migration_' + randomUUID().replaceAll('-', '');
    const migrationDir = join(__dirname, '../../../packages/database/src/migrations');
    const bodies = await Promise.all(['0030_staff_notification_audience.sql', '0031_staff_reservation_event_outbox.sql'].map(file => readFile(join(migrationDir, file), 'utf8')));
    await client.unsafe(`CREATE SCHEMA ${name}`);
    try {
      await client.begin(async tx => {
        await tx.unsafe(`SET LOCAL search_path TO ${name}, public`);
        await tx.unsafe('CREATE TABLE properties (id uuid PRIMARY KEY); CREATE TABLE staff_notifications (id uuid PRIMARY KEY, property_id uuid NOT NULL REFERENCES properties(id), title text); CREATE TABLE staff_notification_reads (notification_id uuid, user_id text, read_at timestamptz)');
        await tx`INSERT INTO properties VALUES (${propertyId})`;
        await tx`INSERT INTO staff_notifications VALUES (${userId}, ${propertyId}, 'Legacy alert')`;
        await tx`INSERT INTO staff_notification_reads VALUES (${userId}, 'operator', '2026-10-01T00:00:00Z')`;
        for (let attempt = 0; attempt < 2; attempt++) for (const body of bodies) await tx.unsafe(body);
        expect((await tx`SELECT title, deduplication_key, required_permission FROM staff_notifications`)[0]).toEqual({ title: 'Legacy alert', deduplication_key: null, required_permission: null });
        expect((await tx`SELECT user_id, read_at FROM staff_notification_reads`)[0]?.user_id).toBe('operator');
        await tx`INSERT INTO domain_event_outbox (property_id, logical_event_id, payload) VALUES (${propertyId}, 'test-event', ${JSON.stringify({ event: 'reservation.created' })}::jsonb)`;
        expect(await tx`SELECT id FROM domain_event_outbox`).toHaveLength(1);
      });
    } finally { await client.unsafe(`DROP SCHEMA ${name} CASCADE`); }
  });
});

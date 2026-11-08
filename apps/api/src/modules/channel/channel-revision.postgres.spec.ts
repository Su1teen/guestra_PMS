import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  bookings, channelConnections, channelRevisionReceipts, properties, ratePlans, reservations, rooms, roomTypes,
} from '@telivityhaip/database';
import { AvailabilityService } from '../reservation/availability.service';
import { DomainEventOutboxService } from '../webhook/domain-event-outbox.service';
import { ChannelService } from './channel.service';
import { ChannelDemoController } from './channel-demo.controller';
import type { ChannelReservation } from './channel-adapter.interface';
import { InboundReservationService } from './inbound-reservation.service';
import { ChannexSyncService } from './adapters/channex/channex-sync.service';

describe.runIf(process.env['CHANNEL_REVISION_LIVE_PG'] === '1')('Channel revisions on isolated PostgreSQL', () => {
  const databaseUrl = process.env['CHANNEL_REVISION_TEST_DATABASE_URL'] ??
    'postgresql://channel_test@127.0.0.1:55438/channel_integration_test';
  const url = new URL(databaseUrl);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !url.pathname.endsWith('_integration_test')) {
    throw new Error('Channel revision tests require an isolated loopback integration_test database');
  }
  const client = postgres(databaseUrl, { max: 8 });
  const db = drizzle(client);
  const demoProperty = randomUUID();
  const pmsProperty = randomUUID();
  const vendorProperty = randomUUID();
  const connectionId = randomUUID();
  const start = '2027-04-12';
  const checkout = '2027-04-14';
  const vendorBooking = randomUUID();
  const pullReservations = vi.fn();
  const confirmReservation = vi.fn();
  const pushAvailability = vi.fn().mockResolvedValue([{ result: { success: true } }]);
  const adapter = { pullReservations, confirmReservation };
  const factory = { getAdapter: () => adapter } as any;
  const webhooks = { emit: vi.fn(), dispatchPersisted: vi.fn() } as any;
  const channelService = new ChannelService(db, webhooks, factory);
  const inventory = new AvailabilityService(db);
  const ari = { pushAvailability } as any;
  const inbound = new InboundReservationService(
    db, channelService, factory, ari, webhooks, inventory, {} as any,
    new DomainEventOutboxService(db, webhooks),
  );
  const worker = new ChannexSyncService(db, new ConfigService(), channelService, inbound, adapter as any, ari);
  const simulator = new ChannelDemoController(
    new ConfigService({ CHANNEL_DEMO_PROPERTY_ID: demoProperty }), channelService, inbound, inventory,
  );

  async function seedInventory(id: string, currencyCode: string) {
    const roomTypeId = randomUUID();
    const ratePlanId = randomUUID();
    await db.insert(properties).values({
      id, name: 'Isolated channel test', code: id.slice(0, 8), countryCode: 'KZ',
      timezone: 'Asia/Almaty', currencyCode, totalRooms: 2,
    });
    await db.insert(roomTypes).values({
      id: roomTypeId, propertyId: id, name: 'Single', code: 'SGL', maxOccupancy: 1, defaultOccupancy: 1,
    });
    await db.insert(rooms).values(['101', '102'].map(number => ({
      propertyId: id, roomTypeId, number, status: 'vacant_clean' as const,
    })));
    await db.insert(ratePlans).values({
      id: ratePlanId, propertyId: id, roomTypeId, name: 'Standard', code: 'STD',
      type: 'bar', baseAmount: '65.00', currencyCode,
    });
    return {
      roomTypeMapping: [{ roomTypeId, channelRoomCode: 'SGL' }],
      ratePlanMapping: [{ ratePlanId, channelRateCode: 'STD' }],
    };
  }

  beforeAll(async () => {
    const demoMapping = await seedInventory(demoProperty, 'KZT');
    const liveMapping = await seedInventory(pmsProperty, 'GBP');
    await db.insert(channelConnections).values(['yandex', 'ostrovok', 'bronevik'].map(channel => ({
      propertyId: demoProperty, channelCode: `SIMULATED:${channel}`,
      channelName: `SIMULATED ${channel}`, adapterType: 'mock', status: 'active' as const, ...demoMapping,
    })));
    await db.insert(channelConnections).values({
      id: connectionId, propertyId: pmsProperty, channelCode: 'channex', channelName: 'Channex test fixture',
      adapterType: 'channex', status: 'active', config: { propertyId: vendorProperty }, ...liveMapping,
    });
  });

  afterAll(async () => { await client.end(); });

  it('shares the last room across simulated channels and restores it once', async () => {
    const bookingId = randomUUID();
    const yandex = {
      bookingId, revisionId: randomUUID(), status: 'new' as const,
      arrivalDate: start, departureDate: checkout, roomCode: 'SGL', rateCode: 'STD',
    };
    const first = await simulator.apply('yandex', demoProperty, yandex);
    expect(first).toMatchObject({ mode: 'SIMULATED', availability: [{ available: 1 }, { available: 1 }] });
    const ostrovok = { ...yandex, bookingId: randomUUID(), revisionId: randomUUID() };
    const bronevik = { ...yandex, bookingId: randomUUID(), revisionId: randomUUID() };
    const attempts = await Promise.allSettled([
      simulator.apply('ostrovok', demoProperty, ostrovok),
      simulator.apply('bronevik', demoProperty, bronevik),
    ]);
    expect(attempts.map(x => x.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((await simulator.apply('yandex', demoProperty, yandex)).availability.map(x => x.available)).toEqual([0, 0]);
    const cancel = { ...yandex, revisionId: randomUUID(), status: 'cancelled' as const };
    expect((await simulator.apply('yandex', demoProperty, cancel)).availability.map(x => x.available)).toEqual([1, 1]);
    expect((await simulator.apply('yandex', demoProperty, cancel)).availability.map(x => x.available)).toEqual([1, 1]);
    const retry = attempts[0]?.status === 'rejected'
      ? simulator.apply('ostrovok', demoProperty, ostrovok)
      : simulator.apply('bronevik', demoProperty, bronevik);
    expect((await retry).availability.map(x => x.available)).toEqual([0, 0]);
    expect(pushAvailability).not.toHaveBeenCalled();
    expect(confirmReservation).not.toHaveBeenCalled();
  });

  it('commits New, Modified and Cancelled once and retries ACK on the committed booking', async () => {
    const initial: ChannelReservation = {
      externalConfirmation: vendorBooking, externalRevisionId: randomUUID(), channelCode: 'channex',
      channelHotelId: vendorProperty, channelBookingDate: new Date('2027-04-02T08:01:00Z'),
      guestFirstName: 'Guestra', guestLastName: 'Test', channelRoomCode: 'SGL', channelRateCode: 'STD',
      arrivalDate: start, departureDate: checkout, adults: 1, children: 0, totalAmount: 130,
      currencyCode: 'GBP', status: 'new',
    };
    const ingest = async (revision: ChannelReservation) => {
      pullReservations.mockResolvedValue({ success: true, reservations: [revision], errors: [] });
      return inbound.pullAndProcessReservations(connectionId, pmsProperty);
    };
    expect((await ingest({ ...initial, channelRateCode: 'unmapped' })).success).toBe(false);
    await worker.run();
    expect(confirmReservation).not.toHaveBeenCalled();
    expect((await ingest(initial)).success).toBe(true);
    confirmReservation.mockResolvedValueOnce({ success: false }).mockResolvedValue({ success: true });
    await worker.run();
    const receiptScope = and(eq(channelRevisionReceipts.propertyId, pmsProperty),
      eq(channelRevisionReceipts.revisionId, initial.externalRevisionId!));
    const [failedAck] = await db.select().from(channelRevisionReceipts).where(receiptScope);
    expect(failedAck).toMatchObject({ attempts: 1, acknowledgedAt: null, completedAt: null });
    expect((await ingest(initial)).success).toBe(true);
    await db.update(channelRevisionReceipts).set({ retryAt: new Date(0) }).where(receiptScope);
    await worker.run();
    expect(confirmReservation).toHaveBeenCalledTimes(2);
    expect(pushAvailability).toHaveBeenCalledWith(pmsProperty, start, '2027-04-13', connectionId);
    const modified: ChannelReservation = { ...initial, externalRevisionId: randomUUID(),
      channelBookingDate: new Date('2027-04-02T08:02:00Z'), status: 'modified', departureDate: '2027-04-15' };
    const cancelled: ChannelReservation = { ...modified, externalRevisionId: randomUUID(),
      channelBookingDate: new Date('2027-04-02T08:03:00Z'), status: 'cancelled' };
    expect((await ingest(modified)).success).toBe(true);
    expect((await ingest(cancelled)).success).toBe(true);
    expect((await ingest({ ...modified, externalRevisionId: randomUUID() })).success).toBe(true);
    await worker.run();
    const storedBookings = await db.select().from(bookings).where(eq(bookings.propertyId, pmsProperty));
    const storedStays = await db.select().from(reservations).where(eq(reservations.propertyId, pmsProperty));
    expect(storedBookings).toHaveLength(1);
    expect(storedStays).toMatchObject([{ status: 'cancelled', departureDate: '2027-04-15' }]);
    const receipts = await db.select().from(channelRevisionReceipts).where(eq(channelRevisionReceipts.propertyId, pmsProperty));
    expect(receipts).toHaveLength(4);
    expect(receipts.every(receipt => receipt.acknowledgedAt && receipt.completedAt)).toBe(true);
  });
});

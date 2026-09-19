import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { bookingEngineIdempotency, bookings, reservations, rooms } from '@telivityhaip/database';
import { validate } from 'class-validator';
import { BookingEngineService } from './booking-engine.service';
import { BeCreateBookingDto } from './dto/be-create-booking.dto';

const PROP = 'aaaaaaaa-0000-4000-a000-000000000001';
const RT = 'rt000000-0000-4000-a000-000000000001';
const RP = 'rp000000-0000-4000-a000-000000000001';

function makeService(overrides: Partial<Record<string, any>> = {}) {
  const db = overrides.db ?? {};
  const config = {
    getPublicConfig: vi.fn().mockResolvedValue({
      propertyId: PROP,
      isEnabled: true,
      displayName: 'Demo Hotel',
      sellableRoomTypeIds: [RT],
      sellableRatePlanIds: [RP],
      depositPolicy: { type: 'first_night', refundable: true },
      bookingMode: 'instant',
      paymentMethodCollection: 'disabled',
      formQuestions: [],
    }),
    getConfig: vi.fn().mockResolvedValue({ autoConfirm: false }),
  };
  const availability = {
    searchAvailability: vi.fn().mockResolvedValue([
      { roomTypeId: RT, date: '2026-07-01', available: 5 },
      { roomTypeId: RT, date: '2026-07-02', available: 5 },
    ]),
  };
  const ratePlan = {
    calculateDerivedRate: vi.fn().mockResolvedValue({ effectiveRate: 100, currency: 'USD' }),
    assertSellable: vi.fn().mockResolvedValue(undefined),
    findById: vi.fn().mockResolvedValue({ id: RP, roomTypeId: RT, currencyCode: 'USD' }),
  };
  const tax = { calculateTaxes: vi.fn().mockResolvedValue([{ amount: '10.00' }]) };
  const guest = { create: vi.fn().mockResolvedValue({ id: 'guest-1' }) };
  const reservation = {
    create: vi.fn().mockResolvedValue({ id: 'res-1', bookingId: 'bk-1', status: 'pending' }),
    confirm: vi.fn().mockResolvedValue({ id: 'res-1', status: 'confirmed' }),
    cancel: vi.fn(),
  };
  const folio = { createAutoFolio: vi.fn().mockResolvedValue({ id: 'folio-1' }) };
  const payment = { authorizePayment: vi.fn().mockResolvedValue({ id: 'pay-1' }) };
  const deposit = { recordDeposit: vi.fn().mockResolvedValue({ id: 'dep-1', status: 'held' }) };
  const search = { search: vi.fn() };
  const bookingSvc = { verify: vi.fn() };
  const ancillary = {
    findServiceById: vi.fn(),
    listServices: vi.fn().mockResolvedValue({ data: [], total: 0, page: 1, limit: 100 }),
    attachToReservation: vi.fn().mockResolvedValue({}),
    ensurePackageComponents: vi.fn().mockResolvedValue([]),
  };
  const policy = {
    getPolicySummary: vi.fn().mockResolvedValue({
      type: 'tiered',
      description: 'Free cancellation up to 24 hours before check-in. First night charge after.',
      freeCancelHoursBeforeArrival: 24,
    }),
    evaluateCancellation: vi.fn(),
  };

  const svc = new BookingEngineService(
    db as any,
    search as any,
    bookingSvc as any,
    reservation as any,
    availability as any,
    ratePlan as any,
    tax as any,
    guest as any,
    folio as any,
    payment as any,
    deposit as any,
    config as any,
    ancillary as any,
    policy as any,
  );
  return { svc, db, config, availability, ratePlan, tax, guest, reservation, folio, payment, deposit, ancillary, policy };
}

// Models the DB's unique (property_id, idempotency_key) claim: another
// transaction waits for the owner before it can observe the committed result.
function makeIdempotencyDb() {
  const saved = new Map<string, Record<string, unknown>>();
  const held = new Map<string, Promise<void>>();
  const partialBookings = new Set<string>();
  const db = {
    transaction: vi.fn(async (work: (tx: any) => Promise<unknown>) => {
      let claimed: string | undefined;
      let currentScope: string | undefined;
      let release: (() => void) | undefined;
      let result: Record<string, unknown> | undefined;
      const tx = {
        insert: (table: unknown) => {
          expect(table).toBe(bookingEngineIdempotency);
          return {
            values: (row: { propertyId: string; idempotencyKey: string }) => ({
              onConflictDoNothing: () => ({
                returning: async () => {
                  const scope = `${row.propertyId}:${row.idempotencyKey}`;
                  currentScope = scope;
                  if (held.has(scope)) await held.get(scope);
                  if (saved.has(scope)) return [];
                  claimed = scope;
                  held.set(scope, new Promise<void>((resolve) => { release = resolve; }));
                  return [{ idempotencyKey: row.idempotencyKey }];
                },
              }),
            }),
          };
        },
        select: () => ({
          from: (table: unknown) => ({
            where: async () => table === bookings
              ? (claimed && partialBookings.has(claimed) ? [{ id: 'existing-booking' }] : [])
              : [{ response: currentScope ? saved.get(currentScope) ?? null : null }],
          }),
        }),
        update: (table: unknown) => {
          expect(table).toBe(bookingEngineIdempotency);
          return { set: (values: { response: Record<string, unknown> }) => ({
            where: async () => { result = values.response; },
          }) };
        },
      };
      try {
        const response = await work(tx);
        if (claimed && result) saved.set(claimed, result);
        return response;
      } finally {
        if (claimed) {
          held.delete(claimed);
          release?.();
        }
      }
    }),
  };
  return { db, saved, partialBookings };
}

const physicalRoom = {
  id: '33333333-3333-4333-8333-333333333333',
  propertyId: PROP,
  roomTypeId: RT,
  number: 'SKY-01',
  status: 'vacant_clean',
  isActive: true,
};

function makeSpecificRoomDb(options: {
  room?: typeof physicalRoom | null;
  conflictingStatus?: string | null;
} = {}) {
  const room = options.room === undefined ? physicalRoom : options.room;
  const blocks = options.conflictingStatus != null
    && !['cancelled', 'no_show', 'checked_out'].includes(options.conflictingStatus);
  const tx = {
    select: vi.fn((shape?: unknown) => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => {
          if (table === rooms && shape == null) {
            const rows = room ? [room] : [];
            return {
              then: (resolve: (value: unknown[]) => void) => resolve(rows),
              for: vi.fn().mockResolvedValue(rows),
            };
          }
          return { limit: vi.fn().mockResolvedValue(blocks ? [{ id: 'overlap' }] : []) };
        }),
      })),
    })),
    update: vi.fn((table: unknown) => {
      expect(table).toBe(reservations);
      return {
        set: vi.fn((values: { roomId: string; status: string }) => ({
          where: vi.fn(() => ({
            returning: vi.fn().mockResolvedValue([{ roomId: values.roomId, status: values.status }]),
          })),
        })),
      };
    }),
  };
  const db = {
    select: tx.select,
    transaction: vi.fn((work: (inner: typeof tx) => unknown) => work(tx)),
  };
  return { db, tx };
}

function makeConcurrentSpecificRoomDb() {
  let reserved = false;
  let tail = Promise.resolve();
  const db = {
    transaction: vi.fn(async (work: (tx: any) => Promise<unknown>) => {
      let release: (() => void) | undefined;
      const previous = tail;
      tail = new Promise<void>((resolve) => { release = resolve; });
      const tx = {
        select: vi.fn((shape?: unknown) => ({
          from: vi.fn((table: unknown) => ({
            where: vi.fn(() => table === rooms && shape == null
              ? { for: vi.fn(async () => { await previous; return [physicalRoom]; }) }
              : { limit: vi.fn(async () => reserved ? [{ id: 'winner' }] : []) }),
          })),
        })),
        update: vi.fn(() => ({
          set: vi.fn((values: { roomId: string; status: string }) => ({
            where: vi.fn(() => ({
              returning: vi.fn(async () => {
                reserved = true;
                return [{ roomId: values.roomId, status: values.status }];
              }),
            })),
          })),
        })),
      };
      try {
        return await work(tx);
      } finally {
        release?.();
      }
    }),
  };
  return db;
}

function makeSpecificRoomIdempotencyDb() {
  const saved = new Map<string, Record<string, unknown>>();
  const db = {
    transaction: vi.fn(async (work: (tx: any) => Promise<unknown>) => {
      let scope: string | undefined;
      let claimed = false;
      let response: Record<string, unknown> | undefined;
      const tx = {
        insert: vi.fn((table: unknown) => {
          expect(table).toBe(bookingEngineIdempotency);
          return {
            values: (row: { propertyId: string; idempotencyKey: string }) => ({
              onConflictDoNothing: () => ({
                returning: async () => {
                  scope = `${row.propertyId}:${row.idempotencyKey}`;
                  if (saved.has(scope)) return [];
                  claimed = true;
                  return [{ idempotencyKey: row.idempotencyKey }];
                },
              }),
            }),
          };
        }),
        select: vi.fn((shape?: unknown) => ({
          from: vi.fn((table: unknown) => ({
            where: vi.fn(() => {
              if (table === bookingEngineIdempotency) {
                return Promise.resolve([{ response: scope ? saved.get(scope) ?? null : null }]);
              }
              if (table === bookings) return Promise.resolve([]);
              if (table === rooms && shape == null) {
                return { for: vi.fn().mockResolvedValue([physicalRoom]) };
              }
              return { limit: vi.fn().mockResolvedValue([]) };
            }),
          })),
        })),
        update: vi.fn((table: unknown) => ({
          set: vi.fn((values: Record<string, unknown>) => ({
            where: vi.fn(() => table === bookingEngineIdempotency
              ? Promise.resolve().then(() => { response = values.response as Record<string, unknown>; })
              : {
                returning: vi.fn().mockResolvedValue([{
                  roomId: values.roomId,
                  status: values.status,
                }]),
              }),
          })),
        })),
      };
      const result = await work(tx);
      if (claimed && scope && response) saved.set(scope, response);
      return result;
    }),
  };
  return { db, saved };
}

const bookDto = {
  roomTypeId: RT,
  ratePlanId: RP,
  checkIn: '2026-07-01',
  checkOut: '2026-07-03', // 2 nights
  guestFirstName: 'Ada',
  guestLastName: 'Lovelace',
  guestEmail: 'ada@example.com',
  adults: 2,
  paymentToken: 'tok_visa',
};

describe('BookingEngineService.checkSpecificRoom', () => {
  it('returns an occupied room as available when future dates have no overlap', async () => {
    const { db } = makeSpecificRoomDb({ room: { ...physicalRoom, status: 'occupied' } });
    const { svc } = makeService({ db });
    await expect(svc.checkSpecificRoom(PROP, {
      roomTypeId: RT,
      roomNumber: physicalRoom.number,
      checkIn: '2026-07-01',
      checkOut: '2026-07-03',
    })).resolves.toEqual({
      roomId: physicalRoom.id,
      roomNumber: physicalRoom.number,
      roomTypeId: RT,
      available: true,
    });
  });

  it('returns only a safe unavailable reason when the room overlaps', async () => {
    const { db } = makeSpecificRoomDb({ conflictingStatus: 'confirmed' });
    const { svc } = makeService({ db });
    const result = await svc.checkSpecificRoom(PROP, {
      roomTypeId: RT,
      roomNumber: physicalRoom.number,
      checkIn: '2026-07-01',
      checkOut: '2026-07-03',
    });
    expect(result).toEqual({
      roomId: physicalRoom.id,
      roomNumber: physicalRoom.number,
      roomTypeId: RT,
      available: false,
      reason: 'Room is already reserved for these dates',
    });
    expect(result).not.toHaveProperty('reservationId');
    expect(result).not.toHaveProperty('guestId');
  });
});

describe('BookingEngineService.quote', () => {
  it('returns 96,050 KZT for Sky House 85,000 plus the active 13% tax profile', async () => {
    const { svc, availability, ratePlan, tax } = makeService();
    availability.searchAvailability.mockResolvedValue([
      { roomTypeId: RT, date: '2026-07-01', available: 5 },
    ]);
    ratePlan.calculateDerivedRate.mockResolvedValue({ effectiveRate: 85000, currency: 'KZT' });
    tax.calculateTaxes.mockResolvedValue([{ amount: '11050.00' }]);
    const quote = await svc.quote(PROP, {
      roomTypeId: RT, ratePlanId: RP, checkIn: '2026-07-01', checkOut: '2026-07-02', adults: 2,
    });
    expect(quote.grandTotal).toBe('96050.00');
  });

  it('returns 85,000 KZT when no active tax profile exists', async () => {
    const { svc, availability, ratePlan, tax } = makeService();
    availability.searchAvailability.mockResolvedValue([
      { roomTypeId: RT, date: '2026-07-01', available: 5 },
    ]);
    ratePlan.calculateDerivedRate.mockResolvedValue({ effectiveRate: 85000, currency: 'KZT' });
    tax.calculateTaxes.mockResolvedValue([]);
    const quote = await svc.quote(PROP, {
      roomTypeId: RT, ratePlanId: RP, checkIn: '2026-07-01', checkOut: '2026-07-02', adults: 2,
    });
    expect(quote.grandTotal).toBe('85000.00');
  });

  it('prices server-side with the real tax engine and computes the deposit', async () => {
    const { svc } = makeService();
    const q = await svc.quote(PROP, { roomTypeId: RT, ratePlanId: RP, checkIn: '2026-07-01', checkOut: '2026-07-03', adults: 2 });
    expect(q.nights).toBe(2);
    expect(q.roomTotal).toBe('200.00');
    expect(q.taxTotal).toBe('20.00');
    expect(q.grandTotal).toBe('220.00');
    // first_night policy → total / nights
    expect(q.depositDue).toBe('110.00');
  });

  it('rejects a stay when any canonical night is absent or sold out', async () => {
    const { svc, availability } = makeService();
    availability.searchAvailability.mockResolvedValue([
      { roomTypeId: RT, date: '2026-07-01', available: 1 },
      { roomTypeId: RT, date: '2026-07-03', available: 1 },
    ]);

    await expect(svc.quote(PROP, {
      roomTypeId: RT,
      ratePlanId: RP,
      checkIn: '2026-07-01',
      checkOut: '2026-07-04',
      adults: 2,
    })).rejects.toThrow(/availability/i);
  });

  it('captures exact per-night service, tax, currency, and posting metadata', async () => {
    const { svc, ancillary, tax } = makeService();
    ancillary.findServiceById.mockResolvedValue({
      id: 'service-parking',
      code: 'PARK',
      name: 'Parking',
      price: '15.00',
      currencyCode: 'USD',
      chargeType: 'parking',
      postingRule: 'per_night',
      sellChannels: ['booking_engine'],
      isActive: true,
    });
    tax.calculateTaxes.mockImplementation(async (
      _amount: string,
      chargeType: string,
    ) => [{ amount: chargeType === 'room' ? '10.00' : '2.00' }]);

    const quote = await svc.quote(PROP, {
      roomTypeId: RT,
      ratePlanId: RP,
      checkIn: '2026-07-01',
      checkOut: '2026-07-03',
      adults: 2,
      serviceIds: ['service-parking'],
    });

    expect(quote.services[0]).toMatchObject({
      serviceId: 'service-parking',
      chargeType: 'parking',
      currencyCode: 'USD',
      postingRule: 'per_night',
      unitPrice: '15.00',
      quantity: 2,
      lineTotal: '30.00',
      taxTotal: '4.00',
      lineItems: [
        { date: '2026-07-01', amount: '15.00', tax: '2.00' },
        { date: '2026-07-02', amount: '15.00', tax: '2.00' },
      ],
    });
  });

  it('reads the complete authoritative quote through a caller transaction', async () => {
    const { svc, config, availability, ratePlan, tax, policy } = makeService();
    const tx = { marker: 'acceptance-transaction' };

    await svc.quote(PROP, {
      roomTypeId: RT,
      ratePlanId: RP,
      checkIn: '2026-07-01',
      checkOut: '2026-07-03',
      adults: 2,
    }, tx);

    expect(config.getPublicConfig).toHaveBeenCalledWith(PROP, tx);
    expect(ratePlan.findById).toHaveBeenCalledWith(RP, PROP, tx);
    expect(ratePlan.calculateDerivedRate).toHaveBeenCalledWith(
      RP,
      PROP,
      expect.any(Object),
      tx,
    );
    expect(availability.searchAvailability).toHaveBeenCalledWith(
      PROP,
      '2026-07-01',
      '2026-07-03',
      RT,
      tx,
    );
    expect(tax.calculateTaxes).toHaveBeenCalledWith(
      '100.00',
      'room',
      PROP,
      '2026-07-01',
      expect.any(Object),
      tx,
    );
    expect(policy.getPolicySummary).toHaveBeenCalledWith(PROP, RP, tx);
  });

  it('locks mutable config and rate inputs for an acceptance quote', async () => {
    const { svc, config, ratePlan } = makeService();
    const tx = { marker: 'locked-acceptance-transaction' };

    await svc.quote(PROP, {
      roomTypeId: RT,
      ratePlanId: RP,
      checkIn: '2026-07-01',
      checkOut: '2026-07-03',
      adults: 2,
    }, tx, { lockForUpdate: true });

    expect(config.getPublicConfig).toHaveBeenCalledWith(PROP, tx, true);
    expect(ratePlan.findById).toHaveBeenCalledWith(RP, PROP, tx, true);
    expect(ratePlan.calculateDerivedRate).toHaveBeenCalledWith(
      RP,
      PROP,
      expect.any(Object),
      tx,
      true,
    );
  });
});

describe('BookingEngineService.book', () => {
  it('creates independently when the idempotency key is absent or null', async () => {
    const { db } = makeIdempotencyDb();
    const { svc, guest, reservation, folio } = makeService({ db });
    const first = await svc.book(PROP, bookDto as any);
    const second = await svc.book(PROP, { ...bookDto, idempotencyKey: null } as any);
    expect(first.reservationId).toBe('res-1');
    expect(second.reservationId).toBe('res-1');
    expect(guest.create).toHaveBeenCalledTimes(2);
    expect(reservation.create).toHaveBeenCalledTimes(2);
    expect(folio.createAutoFolio).toHaveBeenCalledTimes(2);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('replays a successful result with the same IDs and no second side effects', async () => {
    const { db, saved } = makeIdempotencyDb();
    const { svc, guest, reservation, folio, payment, deposit } = makeService({ db });
    const dto = { ...bookDto, idempotencyKey: 'telegram-message-1' };
    const first = await svc.book(PROP, dto as any);
    const second = await svc.book(PROP, dto as any);
    expect(second).toEqual(first);
    expect(second.confirmationNumber).toBe(first.confirmationNumber);
    expect(second.reservationId).toBe(first.reservationId);
    expect(saved).toHaveProperty('size', 1);
    expect(reservation.create.mock.calls[0][1].idempotencyKey).toBe(dto.idempotencyKey);
    for (const service of [guest.create, reservation.create, folio.createAutoFolio, payment.authorizePayment, deposit.recordDeposit]) {
      expect(service).toHaveBeenCalledOnce();
    }
  });

  it('allows the same key independently at two properties', async () => {
    const { db, saved } = makeIdempotencyDb();
    const { svc, guest, reservation } = makeService({ db });
    const other = 'bbbbbbbb-0000-4000-a000-000000000002';
    const dto = { ...bookDto, idempotencyKey: 'same-external-id' };
    await svc.book(PROP, dto as any);
    await svc.book(other, dto as any);
    expect(saved.size).toBe(2);
    expect(guest.create).toHaveBeenCalledTimes(2);
    expect(reservation.create.mock.calls.map(([value]: any) => value.propertyId)).toEqual([PROP, other]);
  });

  it('serializes concurrent requests with the same key', async () => {
    const { db, saved } = makeIdempotencyDb();
    const { svc, guest, reservation, folio } = makeService({ db });
    const dto = { ...bookDto, idempotencyKey: 'simultaneous' };
    const [first, second] = await Promise.all([svc.book(PROP, dto as any), svc.book(PROP, dto as any)]);
    expect(second).toEqual(first);
    expect(saved.size).toBe(1);
    expect(guest.create).toHaveBeenCalledOnce();
    expect(reservation.create).toHaveBeenCalledOnce();
    expect(folio.createAutoFolio).toHaveBeenCalledOnce();
  });

  it('does not create another guest if a booking was persisted before a downstream failure', async () => {
    const { db, partialBookings } = makeIdempotencyDb();
    partialBookings.add(`${PROP}:partial`);
    const { svc, guest } = makeService({ db });
    await expect(svc.book(PROP, { ...bookDto, idempotencyKey: 'partial' } as any))
      .rejects.toThrow(/reconciliation/);
    expect(guest.create).not.toHaveBeenCalled();
  });

  it('does not persist an idempotency claim or create a guest in request mode', async () => {
    const { db, saved } = makeIdempotencyDb();
    const { svc, config, guest } = makeService({ db });
    config.getPublicConfig.mockResolvedValue({
      ...await config.getPublicConfig(PROP),
      bookingMode: 'request',
    });
    await expect(svc.book(PROP, { ...bookDto, idempotencyKey: 'request-1' } as any))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(saved.size).toBe(0);
    expect(guest.create).not.toHaveBeenCalled();
  });

  it('classifies the payment as a held deposit', async () => {
    const { svc, deposit, payment } = makeService();
    const res = await svc.book(PROP, bookDto as any);

    expect(payment.authorizePayment).toHaveBeenCalledOnce();
    expect(deposit.recordDeposit).toHaveBeenCalledOnce();
    const depArg = deposit.recordDeposit.mock.calls[0][0];
    expect(depArg).toMatchObject({
      propertyId: PROP,
      reservationId: 'res-1',
      paymentId: 'pay-1',
      amount: '110.00',
      isRefundable: true,
    });
    expect(res.deposit).toMatchObject({ paymentId: 'pay-1', amount: '110.00', status: 'held' });
  });

  it('creates the reservation via the canonical path as a direct booking', async () => {
    const { svc, reservation } = makeService();
    const res = await svc.book(PROP, bookDto as any);
    const [dto, opts] = reservation.create.mock.calls[0];
    expect(dto).toMatchObject({
      propertyId: PROP,
      source: 'direct',
      channelCode: 'booking_engine',
      totalAmount: '220.00', // server-computed, not client-supplied
    });
    expect(opts.confirmationNumber).toMatch(/^HAIP-/);
    expect(res.confirmationNumber).toMatch(/^HAIP-/);
  });

  it('leaves the reservation pending when autoConfirm is off', async () => {
    const { svc, reservation } = makeService();
    const res = await svc.book(PROP, bookDto as any);
    expect(reservation.confirm).not.toHaveBeenCalled();
    expect(res.status).toBe('pending');
  });

  it('auto-confirms a paid booking when configured', async () => {
    const { svc, config, reservation, payment, deposit } = makeService();
    config.getConfig.mockResolvedValue({ autoConfirm: true });
    const res = await svc.book(PROP, bookDto as any);
    expect(payment.authorizePayment).toHaveBeenCalledOnce();
    expect(deposit.recordDeposit).toHaveBeenCalledOnce();
    expect(reservation.confirm).toHaveBeenCalledOnce();
    expect(payment.authorizePayment.mock.invocationCallOrder[0]).toBeLessThan(deposit.recordDeposit.mock.invocationCallOrder[0]!);
    expect(deposit.recordDeposit.mock.invocationCallOrder[0]).toBeLessThan(reservation.confirm.mock.invocationCallOrder[0]!);
    expect(res.deposit).toMatchObject({ paymentId: 'pay-1', amount: '110.00', status: 'held' });
    expect(res.status).toBe('confirmed');
  });

  it('auto-confirms an instant booking with no deposit due without requiring a payment token', async () => {
    const { svc, config, reservation, payment, deposit } = makeService();
    config.getPublicConfig.mockResolvedValue({
      ...await config.getPublicConfig(PROP),
      depositPolicy: { type: 'none', refundable: true },
    });
    config.getConfig.mockResolvedValue({ autoConfirm: true });
    const { paymentToken, ...noToken } = bookDto;

    const res = await svc.book(PROP, noToken as any);

    expect(payment.authorizePayment).not.toHaveBeenCalled();
    expect(deposit.recordDeposit).not.toHaveBeenCalled();
    expect(reservation.confirm).toHaveBeenCalledOnce();
    expect(reservation.confirm).toHaveBeenCalledWith('res-1', PROP);
    expect(res.deposit).toBeNull();
    expect(res.status).toBe('confirmed');
    expect(res.roomId).toBeNull();
    expect(reservation.create.mock.calls[0][0]).not.toHaveProperty('roomId');
  });

  it('locks and assigns an explicitly requested free physical room', async () => {
    const { db, tx } = makeSpecificRoomDb();
    const { svc, config, reservation } = makeService({ db });
    config.getPublicConfig.mockResolvedValue({
      ...await config.getPublicConfig(PROP),
      depositPolicy: { type: 'none', refundable: true },
    });
    config.getConfig.mockResolvedValue({ autoConfirm: true });
    const { paymentToken, ...withoutPayment } = bookDto;

    const result = await svc.book(PROP, { ...withoutPayment, roomId: physicalRoom.id } as any);

    expect(reservation.confirm).toHaveBeenCalledWith('res-1', PROP);
    expect(result).toMatchObject({ roomId: physicalRoom.id, status: 'assigned' });
    expect(tx.update).toHaveBeenCalledOnce();
  });

  it('rejects a requested room from another room type before creating a guest', async () => {
    const { db } = makeSpecificRoomDb({ room: { ...physicalRoom, roomTypeId: 'other-type' } });
    const { svc, guest, reservation, folio } = makeService({ db });
    await expect(svc.book(PROP, { ...bookDto, roomId: physicalRoom.id } as any))
      .rejects.toThrow(/room type/i);
    expect(guest.create).not.toHaveBeenCalled();
    expect(reservation.create).not.toHaveBeenCalled();
    expect(folio.createAutoFolio).not.toHaveBeenCalled();
  });

  it('rejects a requested room from another property without exposing it', async () => {
    const { db } = makeSpecificRoomDb({ room: null });
    const { svc, guest } = makeService({ db });
    await expect(svc.book(PROP, { ...bookDto, roomId: physicalRoom.id } as any))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(guest.create).not.toHaveBeenCalled();
  });

  it('rejects an overlapping physical-room reservation before creating partial records', async () => {
    const { db } = makeSpecificRoomDb({ conflictingStatus: 'confirmed' });
    const { svc, guest, reservation, folio } = makeService({ db });
    await expect(svc.book(PROP, { ...bookDto, roomId: physicalRoom.id } as any))
      .rejects.toThrow(/already reserved/i);
    expect(guest.create).not.toHaveBeenCalled();
    expect(reservation.create).not.toHaveBeenCalled();
    expect(folio.createAutoFolio).not.toHaveBeenCalled();
  });

  it.each(['cancelled', 'no_show', 'checked_out'])('does not let a %s reservation block the room', async (status) => {
    const { db } = makeSpecificRoomDb({ conflictingStatus: status });
    const { svc } = makeService({ db });
    const result = await svc.book(PROP, { ...bookDto, roomId: physicalRoom.id } as any);
    expect(result.roomId).toBe(physicalRoom.id);
  });

  it('allows a currently occupied room when it is free for the requested future dates', async () => {
    const { db } = makeSpecificRoomDb({ room: { ...physicalRoom, status: 'occupied' } });
    const { svc } = makeService({ db });
    const result = await svc.book(PROP, { ...bookDto, roomId: physicalRoom.id } as any);
    expect(result.roomId).toBe(physicalRoom.id);
  });

  it.each(['out_of_order', 'out_of_service'])('rejects a room currently marked %s', async (status) => {
    const { db } = makeSpecificRoomDb({ room: { ...physicalRoom, status } });
    const { svc, guest } = makeService({ db });
    await expect(svc.book(PROP, { ...bookDto, roomId: physicalRoom.id } as any))
      .rejects.toThrow(new RegExp(status));
    expect(guest.create).not.toHaveBeenCalled();
  });

  it('rejects an inactive physical room', async () => {
    const { db } = makeSpecificRoomDb({ room: { ...physicalRoom, isActive: false } });
    const { svc, guest } = makeService({ db });
    await expect(svc.book(PROP, { ...bookDto, roomId: physicalRoom.id } as any))
      .rejects.toThrow(/inactive/i);
    expect(guest.create).not.toHaveBeenCalled();
  });

  it('allows only one concurrent booking to claim the same physical room and dates', async () => {
    const db = makeConcurrentSpecificRoomDb();
    const { svc, guest, reservation, folio } = makeService({ db });
    const settled = await Promise.allSettled([
      svc.book(PROP, { ...bookDto, roomId: physicalRoom.id } as any),
      svc.book(PROP, { ...bookDto, roomId: physicalRoom.id } as any),
    ]);
    expect(settled.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((item) => item.status === 'rejected')).toHaveLength(1);
    expect(guest.create).toHaveBeenCalledOnce();
    expect(reservation.create).toHaveBeenCalledOnce();
    expect(folio.createAutoFolio).toHaveBeenCalledOnce();
  });

  it('replays an idempotent specific-room booking without creating a second booking', async () => {
    const { db, saved } = makeSpecificRoomIdempotencyDb();
    const { svc, guest, reservation, folio } = makeService({ db });
    const dto = { ...bookDto, roomId: physicalRoom.id, idempotencyKey: 'telegram-room-1' };

    const first = await svc.book(PROP, dto as any);
    const second = await svc.book(PROP, dto as any);

    expect(second).toEqual(first);
    expect(second.roomId).toBe(physicalRoom.id);
    expect(second.reservationId).toBe(first.reservationId);
    expect(saved.size).toBe(1);
    expect(guest.create).toHaveBeenCalledOnce();
    expect(reservation.create).toHaveBeenCalledOnce();
    expect(folio.createAutoFolio).toHaveBeenCalledOnce();
  });

  it('leaves a zero-deposit booking pending when autoConfirm is off', async () => {
    const { svc, config, reservation, payment } = makeService();
    config.getPublicConfig.mockResolvedValue({
      ...await config.getPublicConfig(PROP),
      depositPolicy: { type: 'none', refundable: true },
    });
    const { paymentToken, ...noToken } = bookDto;

    const res = await svc.book(PROP, noToken as any);

    expect(payment.authorizePayment).not.toHaveBeenCalled();
    expect(reservation.confirm).not.toHaveBeenCalled();
    expect(res.status).toBe('pending');
  });

  it('does not confirm a paid booking if deposit recording fails', async () => {
    const { svc, config, reservation, deposit } = makeService();
    config.getConfig.mockResolvedValue({ autoConfirm: true });
    deposit.recordDeposit.mockRejectedValueOnce(new Error('Deposit recording failed'));

    await expect(svc.book(PROP, bookDto as any)).rejects.toThrow('Deposit recording failed');
    expect(reservation.confirm).not.toHaveBeenCalled();
  });

  it('rejects a room type that is not publicly sellable', async () => {
    const { svc, config } = makeService();
    config.getPublicConfig.mockResolvedValue({
      isEnabled: true,
      bookingMode: 'instant',
      sellableRoomTypeIds: [],
      sellableRatePlanIds: [RP],
      depositPolicy: { type: 'first_night', refundable: true },
    });
    await expect(svc.book(PROP, bookDto as any)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects booking when the engine is disabled', async () => {
    const { svc, config } = makeService();
    config.getPublicConfig.mockResolvedValue({
      isEnabled: false,
      sellableRoomTypeIds: [RT],
      sellableRatePlanIds: [RP],
      depositPolicy: { type: 'first_night', refundable: true },
    });
    await expect(svc.book(PROP, bookDto as any)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects request mode before creating a guest, reservation, folio, or payment', async () => {
    const { svc, config, guest, reservation, folio, payment } = makeService();
    config.getPublicConfig.mockResolvedValue({
      isEnabled: true,
      bookingMode: 'request',
      paymentMethodCollection: 'disabled',
      formQuestions: [],
      sellableRoomTypeIds: [RT],
      sellableRatePlanIds: [RP],
      depositPolicy: { type: 'first_night', refundable: true },
    });

    await expect(svc.book(PROP, bookDto as any)).rejects.toBeInstanceOf(ForbiddenException);
    expect(guest.create).not.toHaveBeenCalled();
    expect(reservation.create).not.toHaveBeenCalled();
    expect(folio.createAutoFolio).not.toHaveBeenCalled();
    expect(payment.authorizePayment).not.toHaveBeenCalled();
  });

  it('requires a payment token when a deposit is due', async () => {
    const { svc } = makeService();
    const { paymentToken, ...noToken } = bookDto as any;
    await expect(svc.book(PROP, noToken)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a rate plan that belongs to a different room type (price-tampering guard)', async () => {
    // Attacker pairs a pricey room type with a cheap room's rate plan. Both are
    // individually sellable, but the rate plan is bound to a DIFFERENT room type.
    const { svc, ratePlan } = makeService();
    ratePlan.findById.mockResolvedValue({ id: RP, roomTypeId: 'rt000000-0000-4000-a000-0000000000ff', currencyCode: 'USD' });
    await expect(svc.book(PROP, bookDto as any)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('BeCreateBookingDto.idempotencyKey', () => {
  it('allows omission and null, but rejects an empty or oversized key', async () => {
    const dto = Object.assign(new BeCreateBookingDto(), bookDto, {
      roomTypeId: '11111111-1111-4111-8111-111111111111',
      ratePlanId: '22222222-2222-4222-8222-222222222222',
    });
    expect(await validate(dto)).toEqual([]);
    dto.idempotencyKey = null as any;
    expect(await validate(dto)).toEqual([]);
    dto.idempotencyKey = '';
    expect(await validate(dto)).toEqual(expect.arrayContaining([
      expect.objectContaining({ property: 'idempotencyKey' }),
    ]));
    dto.idempotencyKey = 'x'.repeat(201);
    expect((await validate(dto)).some((error) => error.property === 'idempotencyKey')).toBe(true);
  });
});

describe('BookingEngineService.quote — rate/room pairing', () => {
  it('rejects a rate plan that does not belong to the requested room type', async () => {
    const { svc, ratePlan } = makeService();
    ratePlan.findById.mockResolvedValue({ id: RP, roomTypeId: 'rt000000-0000-4000-a000-0000000000ff', currencyCode: 'USD' });
    await expect(
      svc.quote(PROP, { roomTypeId: RT, ratePlanId: RP, checkIn: '2026-07-01', checkOut: '2026-07-03', adults: 2 } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects duplicate ancillary service IDs before pricing them', async () => {
    const { svc, ancillary } = makeService();
    await expect(svc.quote(PROP, {
      roomTypeId: RT,
      ratePlanId: RP,
      checkIn: '2026-07-01',
      checkOut: '2026-07-03',
      adults: 2,
      serviceIds: ['service-parking', 'service-parking'],
    } as any)).rejects.toThrow(/services.*duplicates/i);
    expect(ancillary.findServiceById).not.toHaveBeenCalled();
  });
});

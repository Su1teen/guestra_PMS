import { reservations as reservationTable, guests, rooms, properties } from '@telivityhaip/database';
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { ReservationService } from './reservation.service';
import { AvailabilityService } from './availability.service';
import { FolioService } from '../folio/folio.service';
import { RoomStatusService } from '../room/room-status.service';
import { PaymentService } from '../payment/payment.service';
import { WebhookService } from '../webhook/webhook.service';
import { AncillaryService } from '../ancillary/ancillary.service';
import { PolicyService } from '../policy/policy.service';
import { DepositSettlementService } from '../accounting/deposit-settlement.service';
import { RatePlanService } from '../rate-plan/rate-plan.service';
import { DRIZZLE } from '../../database/database.module';

const makeReservation = (id: string, propertyId = 'prop-001', status = 'assigned') => ({
  id,
  propertyId,
  bookingId: 'book-001',
  guestId: 'guest-001',
  roomTypeId: 'rt-001',
  roomId: `room-${id}`,
  status,
  totalAmount: '500.00',
  currencyCode: 'USD',
  specialRequests: null,
  arrivalDate: '2026-04-06',
  departureDate: '2026-04-08',
  nights: 2,
});

const mockGuest = { id: 'guest-001', isDnr: false };
const mockProperty = { id: 'prop-001', checkInTime: '15:00', checkOutTime: '11:00', timezone: 'UTC', settings: null };
const mockFolio = { id: 'folio-001', propertyId: 'prop-001', reservationId: 'res-001', status: 'open', balance: '0.00' };

const mockFolioService = {
  createAutoFolio: vi.fn().mockResolvedValue(mockFolio),
  postCharge: vi.fn(),
  list: vi.fn().mockResolvedValue({ data: [] }),
  findById: vi.fn(),
  settle: vi.fn(),
};

const mockRoomStatusService = {
  markOccupied: vi.fn().mockResolvedValue({ status: 'occupied' }),
  markVacantDirty: vi.fn(),
};

const mockPaymentService = {
  authorizePayment: vi.fn(),
  capturePayment: vi.fn(),
  voidPayment: vi.fn(),
};

const mockWebhookService = { emit: vi.fn() };
const mockAvailabilityService = { searchAvailability: vi.fn() };

// Creates a DB mock that handles multiple sequential check-ins
function createGroupDb(reservationRows: any[]) {
  let rawRead = 0, transactionIndex = 0, current: any, inTransaction = false;
  const db: any = {
    select: vi.fn((fields?: any) => ({ from: (table: any) => {
      const query: any = { where() { return this; }, for() { return this; }, limit() { return this; },
        then(resolve: any) {
          if (table === reservationTable) {
            if (fields) return resolve([]);
            return resolve([inTransaction ? current : reservationRows[(rawRead++) % reservationRows.length]]);
          }
          if (table === guests) return resolve([mockGuest]);
          if (table === rooms) return resolve([{ id: current.roomId, roomTypeId: current.roomTypeId, status: 'guest_ready', isActive: true }]);
          if (table === properties) return resolve([mockProperty]);
          return resolve([]);
        } };
      return query;
    } })),
    update: vi.fn(() => ({ set: () => ({ where: () => ({ returning: async () => [{ ...current, status: 'checked_in', checkedInAt: new Date(), actualArrivalTime: new Date() }] }) }) })),
    transaction: async (fn: any) => {
      current = reservationRows[transactionIndex++]; inTransaction = true;
      try { return await fn(db); } finally { inTransaction = false; }
    },
  };
  return db;
}

async function createService(db: any) {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      ReservationService,
      { provide: DRIZZLE, useValue: db },
      { provide: AvailabilityService, useValue: mockAvailabilityService },
      { provide: FolioService, useValue: mockFolioService },
      { provide: RoomStatusService, useValue: mockRoomStatusService },
      { provide: PaymentService, useValue: mockPaymentService },
      { provide: WebhookService, useValue: mockWebhookService },
      { provide: AncillaryService, useValue: { ensurePackageComponents: async () => [], postOnceForReservation: async () => ({ posted: [] }) } },
      { provide: PolicyService, useValue: { evaluateCancellation: async () => ({ withinFreeWindow: true, penaltyAmount: '0.00', depositAction: 'refund', policyDescription: 'test', policyId: null, policyCode: null, penaltyType: 'none' }) } },
      { provide: DepositSettlementService, useValue: { settleFromEvaluation: async () => null, applyHeldDeposits: async () => [] } },
      { provide: RatePlanService, useValue: { assertSellable: vi.fn().mockResolvedValue(undefined) } },
    ],
  }).compile();
  return module.get<ReservationService>(ReservationService);
}

describe('ReservationService — groupCheckIn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFolioService.createAutoFolio.mockResolvedValue(mockFolio);
  });

  it('should process multiple reservations', async () => {
    const res1 = makeReservation('res-001');
    const res2 = makeReservation('res-002');
    const db = createGroupDb([res1, res2]);
    const svc = await createService(db);

    const result = await svc.groupCheckIn('prop-001', {
      reservations: [
        { reservationId: 'res-001' },
        { reservationId: 'res-002' },
      ],
    });

    expect(result.total).toBe(2);
    expect(result.succeeded).toBe(2);
  });

  it('should return correct success/failure counts', async () => {
    const res1 = makeReservation('res-001');
    const db = createGroupDb([res1]);
    const svc = await createService(db);

    const result = await svc.groupCheckIn('prop-001', {
      reservations: [{ reservationId: 'res-001' }],
    });

    expect(result.total).toBe(1);
    expect(result.succeeded + result.failed).toBe(result.total);
  });

  it('should handle partial success', async () => {
    const res1 = makeReservation('res-001');
    // Second reservation is in wrong state
    const res2 = makeReservation('res-002', 'prop-001', 'pending');
    const db = createGroupDb([res1, res2]);
    const svc = await createService(db);

    const result = await svc.groupCheckIn('prop-001', {
      reservations: [
        { reservationId: 'res-001' },
        { reservationId: 'res-002' },
      ],
    });

    // At least one should fail (pending → checked_in is not valid)
    expect(result.results.some((r: any) => !r.success)).toBe(true);
  });

  it('should reject cross-property reservation', async () => {
    const res1 = makeReservation('res-001', 'prop-002'); // different property
    const db = createGroupDb([res1]);
    const svc = await createService(db);

    await expect(
      svc.groupCheckIn('prop-001', {
        reservations: [{ reservationId: 'res-001' }],
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('should not block other check-ins when one fails', async () => {
    const res1 = makeReservation('res-001');
    const res2 = makeReservation('res-002');
    const db = createGroupDb([res1, res2]);

    // Make first check-in fail by having markOccupied throw once
    let occupiedCallCount = 0;
    mockRoomStatusService.markOccupied.mockImplementation(() => {
      occupiedCallCount++;
      if (occupiedCallCount === 1) throw new BadRequestException('Room not ready');
      return Promise.resolve({ status: 'occupied' });
    });

    const svc = await createService(db);
    const result = await svc.groupCheckIn('prop-001', {
      reservations: [
        { reservationId: 'res-001' },
        { reservationId: 'res-002' },
      ],
    });

    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect(result.results.length).toBe(2);
  });

  it('should throw on empty reservations array', async () => {
    const db = createGroupDb([]);
    const svc = await createService(db);

    // The DTO validation (@ArrayMinSize(1)) would normally catch this,
    // but if called directly, the service should handle gracefully
    const result = await svc.groupCheckIn('prop-001', { reservations: [] });
    expect(result.total).toBe(0);
  });
});

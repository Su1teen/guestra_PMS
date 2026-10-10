import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
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
import { rooms } from '@telivityhaip/database';
import { DRIZZLE } from '../../database/database.module';

describe('ReservationService.moveRoom', () => {
  let svc: ReservationService;
  let db: any;
  let current: any;
  let overlaps: any[];
  const roomStatus = {
    markOccupied: vi.fn().mockResolvedValue({}),
    markVacantDirty: vi.fn().mockResolvedValue({}),
  };
  const webhook = { emit: vi.fn().mockResolvedValue(undefined) };

  const reservation = {
    id: 'res-001',
    propertyId: 'prop-001',
    roomTypeId: 'rt-001',
    roomId: 'room-old',
    status: 'checked_in',
    doNotMove: false,
  };

  const targetRoom = {
    id: 'room-new',
    propertyId: 'prop-001',
    roomTypeId: 'rt-001',
    status: 'guest_ready',
    isActive: true,
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    current = { ...reservation }; overlaps = [];
    db = {
      transaction: async (fn: any) => fn(db),
      select: vi.fn((fields?: any) => {
        let table: any;
        const chain: any = { from: (value: any) => { table = value; return chain; }, where: () => chain, orderBy: () => chain,
          for: async () => table === rooms ? [targetRoom, { id: 'room-old', status: 'occupied' }] : [current],
          limit: async () => fields ? overlaps : [] };
        return chain;
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([
              { ...reservation, roomId: 'room-new' },
            ]),
          }),
        }),
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReservationService,
        { provide: DRIZZLE, useValue: db },
        { provide: AvailabilityService, useValue: {} },
        { provide: FolioService, useValue: {} },
        { provide: RoomStatusService, useValue: roomStatus },
        { provide: PaymentService, useValue: {} },
        { provide: WebhookService, useValue: webhook },
        {
          provide: AncillaryService,
          useValue: {
            ensurePackageComponents: async () => [],
            postOnceForReservation: async () => ({ posted: [] }),
          },
        },
        {
          provide: PolicyService,
          useValue: { evaluateCancellation: async () => ({}) },
        },
        {
          provide: DepositSettlementService,
          useValue: { settleFromEvaluation: async () => null, applyHeldDeposits: async () => [] },
        },
      { provide: RatePlanService, useValue: { assertSellable: vi.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();

    svc = module.get(ReservationService);

  });

  it('moves in-house guest and flips room statuses', async () => {
    const updated = await svc.moveRoom('res-001', 'prop-001', { roomId: 'room-new' });
    expect(updated.roomId).toBe('room-new');
    expect(roomStatus.markVacantDirty).toHaveBeenCalledWith('room-old', 'prop-001', db);
    expect(roomStatus.markOccupied).toHaveBeenCalledWith('room-new', 'prop-001', db);
    expect(webhook.emit).toHaveBeenCalledWith(
      'reservation.room_moved',
      'reservation',
      'res-001',
      expect.objectContaining({ previousRoomId: 'room-old', newRoomId: 'room-new' }),
      'prop-001',
    );
  });

  it('blocks do-not-move without override', async () => {
    current.doNotMove = true;
    await expect(
      svc.moveRoom('res-001', 'prop-001', { roomId: 'room-new' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('allows do-not-move with override', async () => {
    vi.spyOn(svc as any, 'findByIdRaw').mockResolvedValue({
      ...reservation,
      doNotMove: true,
    });
    await svc.moveRoom('res-001', 'prop-001', {
      roomId: 'room-new',
      overrideDoNotMove: true,
    });
    expect(roomStatus.markOccupied).toHaveBeenCalled();
  });
  it('rejects a physical overlap before changing either room or stay', async () => {
    overlaps = [{ id: 'other-stay' }];
    await expect(svc.moveRoom('res-001','prop-001',{ roomId: 'room-new' })).rejects.toThrow('already reserved');
    expect(db.update).not.toHaveBeenCalled(); expect(roomStatus.markOccupied).not.toHaveBeenCalled(); expect(webhook.emit).not.toHaveBeenCalled();
  });
  it('propagates a room transition failure through the shared transaction before emitting consequences', async () => {
    roomStatus.markOccupied.mockRejectedValueOnce(new Error('room changed'));
    await expect(svc.moveRoom('res-001','prop-001',{ roomId: 'room-new' })).rejects.toThrow('room changed');
    expect(webhook.emit).not.toHaveBeenCalled();
  });
});

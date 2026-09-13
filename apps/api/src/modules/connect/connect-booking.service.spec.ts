import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import {
  bookings,
  guests,
  properties,
  ratePlans,
  reservationGuests,
  reservations,
  rooms,
  roomTypes,
} from '@telivityhaip/database';
import { ConnectBookingService } from './connect-booking.service';

describe('ConnectBookingService', () => {
  let service: ConnectBookingService;
  let mockDb: any;
  let mockAvailabilityService: any;
  let mockWebhookService: any;
  let mockRatePlanService: any;
  let mockReservationService: any;
  let mockPolicyService: any;

  const mockRatePlan = {
    id: 'rp-1',
    propertyId: 'prop-1',
    baseAmount: '199.99',
    currencyCode: 'USD',
    roomTypeId: 'rt-1',
    type: 'bar',
    isActive: true,
  };

  beforeEach(() => {
    let insertCallCount = 0;
    mockDb = {
      select: vi.fn().mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      })),
      insert: vi.fn().mockImplementation(() => ({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockImplementation(() => {
            insertCallCount++;
            if (insertCallCount === 1) return Promise.resolve([{ id: 'guest-1', firstName: 'John', lastName: 'Smith' }]); // guest
            if (insertCallCount === 2) return Promise.resolve([{ id: 'booking-1', confirmationNumber: 'HAIP-TEST' }]); // booking
            if (insertCallCount === 3) return Promise.resolve([{ id: 'res-1', bookingId: 'booking-1', status: 'confirmed' }]); // reservation
            return Promise.resolve([{ id: 'new-item' }]);
          }),
        }),
      })),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: 'res-1', status: 'confirmed', totalAmount: '399.98', updatedAt: new Date() }]),
          }),
        }),
      }),
    };

    mockAvailabilityService = {
      searchAvailability: vi.fn().mockResolvedValue([
        { roomTypeId: 'rt-1', date: '2024-06-01', totalRooms: 50, sold: 20, available: 30, overbookingBuffer: 0 },
        { roomTypeId: 'rt-1', date: '2024-06-02', totalRooms: 50, sold: 25, available: 25, overbookingBuffer: 0 },
      ]),
    };

    mockWebhookService = { emit: vi.fn().mockResolvedValue(undefined) };
    mockRatePlanService = { assertSellable: vi.fn().mockResolvedValue(undefined) };
    mockReservationService = {
      lockInventory: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn().mockResolvedValue({
        id: 'res-1',
        status: 'cancelled',
        cancellationSettlement: {
          penaltyPosted: false,
          penaltyAmount: '0.00',
          deposits: [],
          policyDescription: 'Free cancellation — cancelled before 24h deadline.',
          withinFreeWindow: true,
        },
      }),
    };
    mockPolicyService = {
      getPolicySummary: vi.fn().mockResolvedValue({
        type: 'tiered',
        description: 'Free cancellation up to 24 hours before check-in. First night charge after.',
      }),
      evaluateCancellation: vi.fn(),
    };

    service = new ConnectBookingService(
      mockDb,
      mockAvailabilityService,
      mockReservationService as any,
      mockWebhookService,
      mockRatePlanService as any,
      mockPolicyService as any,
    );
  });

  describe('book', () => {
    const baseDto = {
      propertyId: 'prop-1',
      roomTypeId: 'rt-1',
      ratePlanId: 'rp-1',
      roomId: 'room-301',
      checkIn: '2024-06-01',
      checkOut: '2024-06-03',
      guestFirstName: 'John',
      guestLastName: 'Smith',
      adults: 2,
    };

    function configureBookDb(options: {
      room?: any;
      roomType?: any;
      ratePlan?: any;
      conflicts?: any[];
      guestMatches?: any[];
      guestLinks?: any[];
    } = {}) {
      const responses = new Map<any, any[][]>([
        [rooms, [[options.room ?? { id: 'room-301', number: '301', propertyId: 'prop-1', roomTypeId: 'rt-1', isActive: true }]]],
        [roomTypes, [[options.roomType ?? { id: 'rt-1', propertyId: 'prop-1', maxOccupancy: 4, isActive: true }]]],
        [ratePlans, [[options.ratePlan === undefined ? mockRatePlan : options.ratePlan].filter(Boolean)]],
        [reservations, [options.conflicts ?? [], options.guestLinks ?? []]],
        [guests, [options.guestMatches ?? []]],
        [properties, [[{ settings: { taxRate: 10 } }]]],
      ]);

      const queryFor = (table: any) => {
        const rows = responses.get(table)?.shift() ?? [];
        const chain: any = {
          where: vi.fn(() => chain),
          for: vi.fn().mockResolvedValue(rows),
          limit: vi.fn().mockResolvedValue(rows),
          then: (resolve: any, reject: any) => Promise.resolve(rows).then(resolve, reject),
        };
        return chain;
      };

      const inserted: any[] = [];
      mockDb = {
        select: vi.fn(() => ({ from: vi.fn((table: any) => queryFor(table)) })),
        insert: vi.fn((table: any) => ({
          values: vi.fn((values: any) => {
            inserted.push({ table, values });
            const rowsByTable = new Map<any, any[]>([
              [guests, [{ id: 'guest-new', ...values }]],
              [bookings, [{ id: 'booking-1', confirmationNumber: 'HAIP-X', ...values }]],
              [reservations, [{ id: 'res-1', status: 'assigned', ...values }]],
              [reservationGuests, []],
            ]);
            const rows = rowsByTable.get(table) ?? [];
            const result: any = {
              returning: vi.fn().mockResolvedValue(rows),
              then: (resolve: any, reject: any) => Promise.resolve(rows).then(resolve, reject),
            };
            return result;
          }),
        })),
        transaction: vi.fn((callback: any) => callback(mockDb)),
      };
      service = new ConnectBookingService(
        mockDb,
        mockAvailabilityService,
        mockReservationService,
        mockWebhookService,
        mockRatePlanService,
        mockPolicyService,
      );
      return inserted;
    }

    it('creates and assigns guest + booking + reservation in one transaction', async () => {
      const inserted = configureBookDb();
      const result = await service.book({ ...baseDto, externalReference: 'CALL-123' });

      expect(result).toMatchObject({
        success: true,
        status: 'assigned',
        roomId: 'room-301',
        roomNumber: '301',
      });
      expect(result.confirmationCodes.external).toBe('CALL-123');
      expect(result.nightlyBreakdown).toHaveLength(2);
      expect(mockDb.transaction).toHaveBeenCalledOnce();
      expect(inserted.find((entry) => entry.table === reservations)?.values).toMatchObject({
        roomId: 'room-301',
        status: 'assigned',
      });
      expect(inserted.some((entry) => entry.table === reservationGuests)).toBe(true);
    });

    it('uses a non-null surname fallback for voice bookings', async () => {
      const inserted = configureBookDb();
      await service.book({ ...baseDto, guestLastName: undefined });
      expect(inserted.find((entry) => entry.table === guests)?.values.lastName).toBe('Не указана');
    });

    it('reuses only an email-matched guest already linked to this property', async () => {
      const existingGuest = { id: 'guest-existing', email: 'john@example.com' };
      const inserted = configureBookDb({ guestMatches: [existingGuest], guestLinks: [{ id: 'res-old' }] });
      await service.book({ ...baseDto, guestEmail: 'john@example.com' });
      expect(inserted.some((entry) => entry.table === guests)).toBe(false);
      expect(inserted.find((entry) => entry.table === bookings)?.values.guestId).toBe('guest-existing');
    });

    it('rejects a room that belongs to another room type', async () => {
      configureBookDb({ room: { id: 'room-301', number: '301', roomTypeId: 'rt-other', isActive: true } });
      await expect(service.book(baseDto)).rejects.toThrow(BadRequestException);
    });

    it('rejects a rate plan that belongs to another room type', async () => {
      configureBookDb({ ratePlan: { ...mockRatePlan, roomTypeId: 'rt-other' } });
      await expect(service.book(baseDto)).rejects.toThrow(BadRequestException);
    });

    it('rejects occupancy above room-type capacity', async () => {
      configureBookDb({ roomType: { id: 'rt-1', maxOccupancy: 2, isActive: true } });
      await expect(service.book({ ...baseDto, adults: 2, children: 1 })).rejects.toThrow(BadRequestException);
    });

    it('rejects a date overlap on the physical room', async () => {
      configureBookDb({ conflicts: [{ id: 'res-conflict' }] });
      await expect(service.book(baseDto)).rejects.toThrow(/already reserved/);
    });

    it('rejects a stay when any requested night has no type availability', async () => {
      configureBookDb();
      mockAvailabilityService.searchAvailability.mockResolvedValue([
        { roomTypeId: 'rt-1', date: '2024-06-01', available: 0 },
        { roomTypeId: 'rt-1', date: '2024-06-02', available: 1 },
      ]);
      await expect(service.book(baseDto)).rejects.toThrow(BadRequestException);
    });

    it('rejects an inactive or missing rate plan', async () => {
      configureBookDb({ ratePlan: null });
      await expect(service.book(baseDto)).rejects.toThrow(NotFoundException);
    });

    it('emits the booking webhook only after the transaction succeeds', async () => {
      configureBookDb();
      await service.book({ ...baseDto, agentId: 'voice-agent' });
      expect(mockWebhookService.emit).toHaveBeenCalledWith(
        'connect.booking_created',
        'reservation',
        'res-1',
        expect.objectContaining({ agentId: 'voice-agent' }),
        'prop-1',
      );
    });

    it('reports prepaid authorization without storing raw card data', async () => {
      configureBookDb();
      const result = await service.book({ ...baseDto, paymentMethod: 'prepaid' });
      expect(result.paymentStatus).toBe('authorized');
      expect(result.depositAmount).toBe(399.98);
    });
  });

  describe('verify', () => {
    it('should return full booking status', async () => {
      let selectCallCount = 0;
      mockDb.select.mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            selectCallCount++;
            if (selectCallCount === 1) return Promise.resolve([{ id: 'booking-1', confirmationNumber: 'HAIP-123' }]);
            if (selectCallCount === 2) return Promise.resolve([{
              id: 'res-1', bookingId: 'booking-1', guestId: 'guest-1', roomTypeId: 'rt-1',
              status: 'confirmed', arrivalDate: '2024-06-01', departureDate: '2024-06-03',
              totalAmount: '399.98', currencyCode: 'USD', roomId: null,
              updatedAt: new Date(), createdAt: new Date(),
            }]);
            if (selectCallCount === 3) return Promise.resolve([{ id: 'guest-1', firstName: 'John', lastName: 'Smith' }]);
            if (selectCallCount === 4) return Promise.resolve([{ id: 'rt-1', name: 'Standard King' }]);
            if (selectCallCount === 5) return Promise.resolve([]); // no folio
            return Promise.resolve([]);
          }),
        }),
      }));

      const result = await service.verify('HAIP-123');

      expect(result.status).toBe('confirmed');
      expect(result.confirmationNumber).toBe('HAIP-123');
      expect(result.guestName).toBe('John Smith');
      expect(result.roomType).toBe('Standard King');
      expect(result.roomAssigned).toBe(false);
      expect(result.verifiedAt).toBeDefined();
    });

    it('should include room assignment when available', async () => {
      let selectCallCount = 0;
      mockDb.select.mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            selectCallCount++;
            if (selectCallCount === 1) return Promise.resolve([{ id: 'booking-1' }]);
            if (selectCallCount === 2) return Promise.resolve([{
              id: 'res-1', bookingId: 'booking-1', guestId: 'guest-1', roomTypeId: 'rt-1',
              status: 'assigned', arrivalDate: '2024-06-01', departureDate: '2024-06-03',
              totalAmount: '399.98', currencyCode: 'USD', roomId: 'room-101',
              updatedAt: new Date(), createdAt: new Date(),
            }]);
            if (selectCallCount === 3) return Promise.resolve([{ firstName: 'John', lastName: 'Smith' }]);
            if (selectCallCount === 4) return Promise.resolve([{ name: 'Standard King' }]);
            if (selectCallCount === 5) return Promise.resolve([{ number: '101' }]); // room
            if (selectCallCount === 6) return Promise.resolve([]); // folio
            return Promise.resolve([]);
          }),
        }),
      }));

      const result = await service.verify('HAIP-123');

      expect(result.roomAssigned).toBe(true);
      expect(result.roomNumber).toBe('101');
    });

    it('should throw NotFoundException for invalid confirmation number', async () => {
      mockDb.select.mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      }));

      await expect(service.verify('INVALID')).rejects.toThrow(NotFoundException);
    });
  });

  describe('modify', () => {
    it('should handle free modifications (guest details only)', async () => {
      let selectCallCount = 0;
      mockDb.select.mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            selectCallCount++;
            if (selectCallCount === 1) return Promise.resolve([{ id: 'booking-1', propertyId: 'prop-1' }]);
            if (selectCallCount === 2) return Promise.resolve([{
              id: 'res-1', bookingId: 'booking-1', guestId: 'guest-1',
              status: 'confirmed', totalAmount: '399.98',
              arrivalDate: '2024-06-01', departureDate: '2024-06-03',
            }]);
            return Promise.resolve([]);
          }),
        }),
      }));

      const result = await service.modify('HAIP-123', {
        specialRequests: 'High floor please',
      });

      expect(result.success).toBe(true);
      expect(result.costDifference).toBe(0);
    });

    it('should re-check availability for date changes', async () => {
      let selectCallCount = 0;
      mockDb.select.mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            selectCallCount++;
            if (selectCallCount === 1) return Promise.resolve([{ id: 'booking-1', propertyId: 'prop-1' }]);
            if (selectCallCount === 2) return Promise.resolve([{
              id: 'res-1', bookingId: 'booking-1', guestId: 'guest-1',
              status: 'confirmed', totalAmount: '399.98', roomTypeId: 'rt-1', ratePlanId: 'rp-1',
              arrivalDate: '2024-06-01', departureDate: '2024-06-03',
            }]);
            if (selectCallCount === 3) return Promise.resolve([mockRatePlan]); // rate plan for re-calc
            return Promise.resolve([]);
          }),
        }),
      }));

      const result = await service.modify('HAIP-123', {
        checkIn: '2024-06-01',
        checkOut: '2024-06-04', // Extended by 1 night
      });

      expect(result.success).toBe(true);
      expect(mockAvailabilityService.searchAvailability).toHaveBeenCalled();
    });

    it('forks a property-local guest on name change when the guest is shared with another property', async () => {
      let selectCallCount = 0;
      mockDb.select.mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            selectCallCount++;
            if (selectCallCount === 1) return Promise.resolve([{ id: 'booking-1', propertyId: 'prop-1' }]);
            if (selectCallCount === 2) return Promise.resolve([{
              id: 'res-1', bookingId: 'booking-1', guestId: 'guest-shared',
              status: 'confirmed', totalAmount: '399.98',
              arrivalDate: '2024-06-01', departureDate: '2024-06-03',
            }]);
            if (selectCallCount === 3) return Promise.resolve([{ id: 'res-other' }]); // guest linked at ANOTHER property
            if (selectCallCount === 4) return Promise.resolve([{ id: 'guest-shared', firstName: 'John', lastName: 'Smith', email: 'j@x.com' }]);
            return Promise.resolve([]);
          }),
        }),
      }));

      let insertCount = 0;
      mockDb.insert.mockImplementation(() => ({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockImplementation(() => {
            insertCount++;
            return Promise.resolve([{ id: 'guest-forked', firstName: 'Johnny', lastName: 'Smith' }]);
          }),
        }),
      }));

      const result = await service.modify('HAIP-123', { guestFirstName: 'Johnny' });

      expect(result.success).toBe(true);
      // A shared guest must NOT be overwritten in place — a property-local copy is forked.
      expect(insertCount).toBe(1);
    });

    it('updates the guest in place on name change when the guest is NOT shared', async () => {
      let selectCallCount = 0;
      mockDb.select.mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            selectCallCount++;
            if (selectCallCount === 1) return Promise.resolve([{ id: 'booking-1', propertyId: 'prop-1' }]);
            if (selectCallCount === 2) return Promise.resolve([{
              id: 'res-1', bookingId: 'booking-1', guestId: 'guest-1',
              status: 'confirmed', totalAmount: '399.98',
              arrivalDate: '2024-06-01', departureDate: '2024-06-03',
            }]);
            if (selectCallCount === 3) return Promise.resolve([]); // no other-property links → not shared
            return Promise.resolve([]);
          }),
        }),
      }));

      let insertCount = 0;
      mockDb.insert.mockImplementation(() => ({
        values: vi.fn().mockReturnValue({ returning: vi.fn().mockImplementation(() => { insertCount++; return Promise.resolve([{ id: 'x' }]); }) }),
      }));

      const result = await service.modify('HAIP-123', { guestFirstName: 'Johnny' });

      expect(result.success).toBe(true);
      expect(insertCount).toBe(0); // updated in place, no fork
    });

    it('should reject modification of cancelled reservation', async () => {
      let selectCallCount = 0;
      mockDb.select.mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            selectCallCount++;
            if (selectCallCount === 1) return Promise.resolve([{ id: 'booking-1' }]);
            if (selectCallCount === 2) return Promise.resolve([{
              id: 'res-1', status: 'cancelled', totalAmount: '399.98',
            }]);
            return Promise.resolve([]);
          }),
        }),
      }));

      await expect(service.modify('HAIP-123', { adults: 3 })).rejects.toThrow(BadRequestException);
    });
  });

  describe('cancel', () => {
    it('should cancel with free cancellation when before deadline', async () => {
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 7);
      const futureDateStr = futureDate.toISOString().split('T')[0]!;

      let selectCallCount = 0;
      mockDb.select.mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            selectCallCount++;
            if (selectCallCount === 1) return Promise.resolve([{ id: 'booking-1', propertyId: 'prop-1' }]);
            if (selectCallCount === 2) return Promise.resolve([{
              id: 'res-1', status: 'confirmed', totalAmount: '399.98', nights: 2,
              arrivalDate: futureDateStr, ratePlanId: 'rp-1',
            }]);
            if (selectCallCount === 3) return Promise.resolve([mockRatePlan]);
            return Promise.resolve([]);
          }),
        }),
      }));

      const result = await service.cancel('HAIP-123', 'Changed plans');

      expect(result.cancelled).toBe(true);
      expect(result.penaltyApplied).toBe(false);
      expect(result.refundAmount).toBe(399.98);
    });

    it('should throw for already cancelled booking', async () => {
      let selectCallCount = 0;
      mockDb.select.mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            selectCallCount++;
            if (selectCallCount === 1) return Promise.resolve([{ id: 'booking-1' }]);
            if (selectCallCount === 2) return Promise.resolve([{ id: 'res-1', status: 'cancelled' }]);
            return Promise.resolve([]);
          }),
        }),
      }));

      await expect(service.cancel('HAIP-123')).rejects.toThrow(BadRequestException);
    });

    it('should emit connect.booking_cancelled webhook', async () => {
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 7);
      const futureDateStr = futureDate.toISOString().split('T')[0]!;

      let selectCallCount = 0;
      mockDb.select.mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            selectCallCount++;
            if (selectCallCount === 1) return Promise.resolve([{ id: 'booking-1', propertyId: 'prop-1' }]);
            if (selectCallCount === 2) return Promise.resolve([{
              id: 'res-1', status: 'confirmed', totalAmount: '199.99', nights: 1,
              arrivalDate: futureDateStr, ratePlanId: 'rp-1',
            }]);
            if (selectCallCount === 3) return Promise.resolve([mockRatePlan]);
            return Promise.resolve([]);
          }),
        }),
      }));

      await service.cancel('HAIP-123', 'Test');

      expect(mockWebhookService.emit).toHaveBeenCalledWith(
        'connect.booking_cancelled',
        'reservation',
        'res-1',
        expect.objectContaining({ reason: 'Test' }),
        'prop-1',
      );
    });
  });
});

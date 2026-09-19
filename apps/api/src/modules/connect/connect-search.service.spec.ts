import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConnectSearchService } from './connect-search.service';

describe('ConnectSearchService', () => {
  let service: ConnectSearchService;
  let mockDb: any;
  let mockAvailabilityService: any;
  let mockRatePlanService: any;
  let mockTaxService: any;

  const mockProperty = {
    id: 'prop-1',
    name: 'Grand Hotel NYC',
    code: 'HTLNYC01',
    description: 'A luxury hotel in Manhattan',
    addressLine1: '123 Broadway',
    city: 'New York',
    stateProvince: 'NY',
    countryCode: 'US',
    postalCode: '10001',
    phone: '+1-212-555-0100',
    email: 'info@grandhotelnyc.com',
    website: 'https://grandhotelnyc.com',
    timezone: 'America/New_York',
    currencyCode: 'USD',
    starRating: 4,
    totalRooms: 100,
    isActive: true,
    checkInTime: '15:00',
    checkOutTime: '11:00',
    overbookingPercentage: 5,
    gdsChainCode: 'GH',
    settings: { taxRate: 14.75 },
  };

  const mockRoomType = {
    id: 'rt-1',
    propertyId: 'prop-1',
    name: 'Standard King',
    code: 'STD-K',
    description: 'Comfortable king room',
    maxOccupancy: 2,
    defaultOccupancy: 2,
    bedType: 'king',
    isAccessible: false,
    amenities: ['wifi', 'minibar'],
    isActive: true,
  };

  const mockRatePlan = {
    id: 'rp-1',
    propertyId: 'prop-1',
    roomTypeId: 'rt-1',
    name: 'Best Available Rate',
    code: 'BAR1',
    type: 'bar',
    baseAmount: '199.99',
    currencyCode: 'USD',
    isActive: true,
    channelCodes: ['booking_com'],
  };

  beforeEach(() => {
    // Bug 7: findProperties now pushes pagination to SQL when no propertyId
    // is provided. Most tests here hit the propertyId branch which still
    // terminates on .where(). For city-search pagination we add .limit().offset()
    // to the chain below.
    mockDb = {
      select: vi.fn().mockImplementation(() => ({
        from: vi.fn().mockImplementation(() => ({
          where: vi.fn().mockImplementation(() => {
            const p: any = Promise.resolve([]);
            p.limit = vi.fn().mockReturnValue({
              offset: vi.fn().mockResolvedValue([]),
            });
            return p;
          }),
        })),
      })),
    };

    mockAvailabilityService = {
      searchAvailability: vi.fn().mockResolvedValue([
        { roomTypeId: 'rt-1', roomTypeName: 'Standard King', date: '2024-06-01', totalRooms: 50, sold: 20, available: 30, overbookingBuffer: 2 },
        { roomTypeId: 'rt-1', roomTypeName: 'Standard King', date: '2024-06-02', totalRooms: 50, sold: 25, available: 25, overbookingBuffer: 2 },
      ]),
    };

    mockRatePlanService = {
      calculateDerivedRate: vi.fn().mockResolvedValue({ effectiveRate: 199.99, currency: 'USD' }),
    };
    mockTaxService = {
      calculateTaxes: vi.fn().mockImplementation((amount: string) => Promise.resolve([{
        amount: (Number(amount) * 0.1475).toFixed(2),
      }])),
    };

    service = new ConnectSearchService(mockDb, mockAvailabilityService, {
      getPolicySummary: vi.fn().mockResolvedValue({
        type: 'tiered',
        penaltyType: 'first_night',
        description: 'Free cancellation up to 24 hours before check-in. First night charge after.',
        freeCancelHoursBeforeArrival: 24,
        policyId: null,
        policyCode: null,
      }),
    } as any, mockRatePlanService, mockTaxService);
  });

  describe('search', () => {
    it('should return search results with source metadata', async () => {
      let callCount = 0;
      mockDb.select.mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            callCount++;
            if (callCount === 1) return Promise.resolve([mockProperty]); // properties
            if (callCount === 2) return Promise.resolve([mockRoomType]); // room types
            if (callCount === 3) return Promise.resolve([mockRatePlan]); // rate plans
            if (callCount === 4) return Promise.resolve([]); // restrictions
            return Promise.resolve([]);
          }),
        }),
      }));

      const result = await service.search({
        propertyId: 'prop-1',
        checkIn: '2024-06-01',
        checkOut: '2024-06-03',
      });

      expect(result.source).toBe('haip');
      expect(result.sourceVersion).toBe('1.0.0');
      expect(result.searchId).toBeDefined();
      expect(result.responseTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('should include room types with availability', async () => {
      let callCount = 0;
      mockDb.select.mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            callCount++;
            if (callCount === 1) return Promise.resolve([mockProperty]);
            if (callCount === 2) return Promise.resolve([mockRoomType]);
            if (callCount === 3) return Promise.resolve([mockRatePlan]);
            if (callCount === 4) return Promise.resolve([]);
            return Promise.resolve([]);
          }),
        }),
      }));

      const result = await service.search({
        propertyId: 'prop-1',
        checkIn: '2024-06-01',
        checkOut: '2024-06-03',
      });

      expect(result.results).toHaveLength(1);
      expect(result.results[0]!.roomTypes).toHaveLength(1);
      expect(result.results[0]!.roomTypes[0]!.available).toBe(25); // min across dates
      expect(result.results[0]!.roomTypes[0]!.roomTypeName).toBe('Standard King');
    });

    it('should calculate nightly breakdown with tax', async () => {
      let callCount = 0;
      mockDb.select.mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            callCount++;
            if (callCount === 1) return Promise.resolve([mockProperty]);
            if (callCount === 2) return Promise.resolve([mockRoomType]);
            if (callCount === 3) return Promise.resolve([mockRatePlan]);
            if (callCount === 4) return Promise.resolve([]);
            return Promise.resolve([]);
          }),
        }),
      }));

      const result = await service.search({
        propertyId: 'prop-1',
        checkIn: '2024-06-01',
        checkOut: '2024-06-03',
      });

      const rate = result.results[0]!.roomTypes[0]!.rates[0]!;
      expect(rate.nightlyBreakdown).toHaveLength(2);
      expect(rate.nightlyBreakdown[0]!.baseRate).toBe(199.99);
      expect(rate.nightlyBreakdown[0]!.taxAmount).toBeCloseTo(29.5, 0);
      expect(rate.totalAmount).toBeGreaterThan(0);
    });

    it('uses the canonical tax engine for an 85,000 KZT room instead of settings.taxRate', async () => {
      let callCount = 0;
      const lesId = 'aaaaaaaa-0000-4000-a000-000000000001';
      const roomTypeId = 'rt000000-0000-4000-a000-000000000001';
      const ratePlanId = 'rp000000-0000-4000-a000-000000000001';
      const les = { ...mockProperty, id: lesId, currencyCode: 'KZT', settings: { taxRate: 0.13 } };
      const sky = { ...mockRoomType, id: roomTypeId, propertyId: lesId, name: 'Sky House' };
      const bar = {
        ...mockRatePlan,
        id: ratePlanId,
        propertyId: lesId,
        roomTypeId,
        baseAmount: '85000.00',
        currencyCode: 'KZT',
      };
      mockDb.select.mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            callCount++;
            if (callCount === 1) return Promise.resolve([les]);
            if (callCount === 2) return Promise.resolve([sky]);
            if (callCount === 3) return Promise.resolve([bar]);
            return Promise.resolve([]);
          }),
        }),
      }));
      mockAvailabilityService.searchAvailability.mockResolvedValue([
        { roomTypeId, date: '2026-07-01', totalRooms: 10, available: 10 },
      ]);
      mockRatePlanService.calculateDerivedRate.mockResolvedValue({ effectiveRate: 85000, currency: 'KZT' });
      mockTaxService.calculateTaxes.mockResolvedValue([{ amount: '11050.00' }]);

      const result = await service.search({ propertyId: lesId, checkIn: '2026-07-01', checkOut: '2026-07-02' });
      const rate = result.results[0]!.roomTypes[0]!.rates[0]!;
      expect(rate.totalAmount).toBe(96050);
      expect(rate.nightlyBreakdown).toEqual([
        { date: '2026-07-01', baseRate: 85000, taxAmount: 11050, totalRate: 96050 },
      ]);
      expect(mockTaxService.calculateTaxes).toHaveBeenCalledWith(
        '85000.00', 'room', lesId, '2026-07-01',
        { numberOfNights: 1, nightNumber: 1 }, undefined,
      );
    });

    it('returns 85,000 KZT when the canonical tax engine finds no active profile', async () => {
      let callCount = 0;
      mockDb.select.mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            callCount++;
            if (callCount === 1) return Promise.resolve([{ ...mockProperty, settings: { taxRate: 0.13 } }]);
            if (callCount === 2) return Promise.resolve([mockRoomType]);
            if (callCount === 3) return Promise.resolve([{ ...mockRatePlan, baseAmount: '85000.00', currencyCode: 'KZT' }]);
            return Promise.resolve([]);
          }),
        }),
      }));
      mockAvailabilityService.searchAvailability.mockResolvedValue([
        { roomTypeId: 'rt-1', date: '2024-06-01', totalRooms: 10, available: 10 },
      ]);
      mockRatePlanService.calculateDerivedRate.mockResolvedValue({ effectiveRate: 85000, currency: 'KZT' });
      mockTaxService.calculateTaxes.mockResolvedValue([]);

      const result = await service.search({ propertyId: 'prop-1', checkIn: '2024-06-01', checkOut: '2024-06-02' });
      expect(result.results[0]!.roomTypes[0]!.rates[0]!.totalAmount).toBe(85000);
    });

    it('should calculate content completeness score', async () => {
      let callCount = 0;
      mockDb.select.mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            callCount++;
            if (callCount === 1) return Promise.resolve([mockProperty]);
            if (callCount === 2) return Promise.resolve([mockRoomType]);
            if (callCount === 3) return Promise.resolve([mockRatePlan]);
            if (callCount === 4) return Promise.resolve([]);
            return Promise.resolve([]);
          }),
        }),
      }));

      const result = await service.search({
        propertyId: 'prop-1',
        checkIn: '2024-06-01',
        checkOut: '2024-06-03',
      });

      // mockProperty has all 10 fields filled → score = 100
      expect(result.results[0]!.contentScore).toBe(100);
    });

    it('should return empty results for non-existent property', async () => {
      mockDb.select.mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      }));

      const result = await service.search({
        propertyId: 'nonexistent',
        checkIn: '2024-06-01',
        checkOut: '2024-06-03',
      });

      expect(result.results).toHaveLength(0);
      expect(result.totalResults).toBe(0);
    });

    it('should filter by accessible rooms', async () => {
      const accessibleRoom = { ...mockRoomType, id: 'rt-2', isAccessible: true, name: 'Accessible King' };
      let callCount = 0;
      mockDb.select.mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            callCount++;
            if (callCount === 1) return Promise.resolve([mockProperty]);
            if (callCount === 2) return Promise.resolve([mockRoomType, accessibleRoom]); // both types
            if (callCount === 3) return Promise.resolve([mockRatePlan]); // rate for rt-1
            if (callCount === 4) return Promise.resolve([]); // restrictions
            if (callCount === 5) return Promise.resolve([{ ...mockRatePlan, id: 'rp-2', roomTypeId: 'rt-2' }]); // rate for rt-2
            if (callCount === 6) return Promise.resolve([]); // restrictions
            return Promise.resolve([]);
          }),
        }),
      }));

      mockAvailabilityService.searchAvailability.mockResolvedValue([
        { roomTypeId: 'rt-1', date: '2024-06-01', totalRooms: 50, sold: 20, available: 30, overbookingBuffer: 0 },
        { roomTypeId: 'rt-2', date: '2024-06-01', totalRooms: 5, sold: 1, available: 4, overbookingBuffer: 0 },
      ]);

      const result = await service.search({
        propertyId: 'prop-1',
        checkIn: '2024-06-01',
        checkOut: '2024-06-02',
        accessibleOnly: true,
      });

      // Only accessible rooms should be included
      if (result.results.length > 0) {
        const roomTypes = result.results[0]!.roomTypes;
        expect(roomTypes.every((rt: any) => rt.roomTypeName !== 'Standard King')).toBe(true);
      }
    });

    it('should include cancellation policy in rate results', async () => {
      let callCount = 0;
      mockDb.select.mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            callCount++;
            if (callCount === 1) return Promise.resolve([mockProperty]);
            if (callCount === 2) return Promise.resolve([mockRoomType]);
            if (callCount === 3) return Promise.resolve([mockRatePlan]);
            if (callCount === 4) return Promise.resolve([]);
            return Promise.resolve([]);
          }),
        }),
      }));

      const result = await service.search({
        propertyId: 'prop-1',
        checkIn: '2024-06-01',
        checkOut: '2024-06-03',
      });

      const rate = result.results[0]!.roomTypes[0]!.rates[0]!;
      expect(rate.cancellationPolicy).toBeDefined();
      expect(rate.cancellationPolicy.type).toBe('tiered');
    });

    it('should exclude closed rate plans', async () => {
      let callCount = 0;
      mockDb.select.mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            callCount++;
            if (callCount === 1) return Promise.resolve([mockProperty]);
            if (callCount === 2) return Promise.resolve([mockRoomType]);
            if (callCount === 3) return Promise.resolve([mockRatePlan]);
            if (callCount === 4) return Promise.resolve([{ isClosed: true, startDate: '2024-06-01', endDate: '2024-06-30' }]);
            return Promise.resolve([]);
          }),
        }),
      }));

      const result = await service.search({
        propertyId: 'prop-1',
        checkIn: '2024-06-01',
        checkOut: '2024-06-03',
      });

      // Closed rate plan should not appear
      if (result.results.length > 0) {
        expect(result.results[0]!.roomTypes).toHaveLength(0);
      }
    });
  });
});

import { describe, expect, it, vi } from 'vitest';
import { BookingEngineService } from './booking-engine.service';
import { ConnectSearchService } from '../connect/connect-search.service';

const PROPERTY_ID = 'aaaaaaaa-0000-4000-a000-000000000001';
const ROOM_TYPE_ID = '11111111-1111-4111-8111-111111111111';
const RATE_PLAN_ID = '22222222-2222-4222-8222-222222222222';

function makeServices(taxAmount: string | null) {
  let selectCall = 0;
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => {
          selectCall++;
          if (selectCall === 1) return Promise.resolve([{
            id: PROPERTY_ID,
            name: 'ЛЕС Боровое',
            code: 'LES',
            currencyCode: 'KZT',
            isActive: true,
            settings: { taxRate: 0.13 },
          }]);
          if (selectCall === 2) return Promise.resolve([{
            id: ROOM_TYPE_ID,
            propertyId: PROPERTY_ID,
            name: 'Sky House',
            maxOccupancy: 2,
            defaultOccupancy: 2,
            isActive: true,
          }]);
          if (selectCall === 3) return Promise.resolve([{
            id: RATE_PLAN_ID,
            propertyId: PROPERTY_ID,
            roomTypeId: ROOM_TYPE_ID,
            name: 'Sky House BAR',
            code: 'SKY-BAR',
            type: 'bar',
            baseAmount: '85000.00',
            currencyCode: 'KZT',
            isTaxInclusive: false,
            isActive: true,
          }]);
          return Promise.resolve([]); // restrictions
        }),
      })),
    })),
  };
  const availability = {
    searchAvailability: vi.fn().mockResolvedValue([{
      roomTypeId: ROOM_TYPE_ID,
      date: '2026-07-01',
      totalRooms: 10,
      available: 10,
    }]),
  };
  const ratePlan = {
    findById: vi.fn().mockResolvedValue({ roomTypeId: ROOM_TYPE_ID, isTaxInclusive: false }),
    calculateDerivedRate: vi.fn().mockResolvedValue({ effectiveRate: 85000, currency: 'KZT' }),
  };
  const tax = {
    calculateTaxes: vi.fn().mockResolvedValue(taxAmount == null ? [] : [{ amount: taxAmount }]),
  };
  const policy = {
    getPolicySummary: vi.fn().mockResolvedValue({
      type: 'flexible',
      penaltyType: 'none',
      description: 'Flexible cancellation',
    }),
  };
  const config = {
    getPublicConfig: vi.fn().mockResolvedValue({
      isEnabled: true,
      sellableRoomTypeIds: [ROOM_TYPE_ID],
      sellableRatePlanIds: [RATE_PLAN_ID],
      depositPolicy: { type: 'none', refundable: true },
    }),
  };
  const connectSearch = new ConnectSearchService(
    db as any,
    availability as any,
    policy as any,
    ratePlan as any,
    tax as any,
  );
  const bookingEngine = new BookingEngineService(
    db as any,
    connectSearch,
    {} as any,
    {} as any,
    availability as any,
    ratePlan as any,
    tax as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    config as any,
    {} as any,
    policy as any,
  );
  return bookingEngine;
}

async function searchAndQuote(taxAmount: string | null) {
  const service = makeServices(taxAmount);
  const input = {
    roomTypeId: ROOM_TYPE_ID,
    ratePlanId: RATE_PLAN_ID,
    checkIn: '2026-07-01',
    checkOut: '2026-07-02',
    adults: 2,
    children: 0,
  };
  const search = await service.search(PROPERTY_ID, input);
  const quote = await service.quote(PROPERTY_ID, input);
  return {
    searchTotal: search.results[0]!.roomTypes[0]!.rates[0]!.totalAmount,
    quoteTotal: Number(quote.grandTotal),
  };
}

describe('Booking Engine Search/Quote pricing parity', () => {
  it('returns 96,050 KZT in both paths for Sky House 85,000 plus active 13% tax', async () => {
    const totals = await searchAndQuote('11050.00');
    expect(totals).toEqual({ searchTotal: 96050, quoteTotal: 96050 });
  });

  it('returns 85,000 KZT in both paths when there is no active tax profile', async () => {
    const totals = await searchAndQuote(null);
    expect(totals).toEqual({ searchTotal: 85000, quoteTotal: 85000 });
  });
});

import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { ReservationCalendarService } from './reservation-calendar.service';

describe('complete calendar window', () => {
  it('keeps more than 100 stays and uses one tenant-scoped repeatable-read snapshot', async () => {
    const stays = Array.from({ length: 125 }, (_, i) => ({ id: String(i), firstName: 'Иван', lastName: 'Петров' }));
    const results = [[{ id: 'room' }], [{ id: 'type' }], stays, [], [{timezone:'UTC'}], []];
    const conditions: any[] = [];
    const tx: any = { select: vi.fn(() => {
      const rows = results.shift();
      const chain: any = { from: () => chain, innerJoin: () => chain,
        where: (condition: any) => { conditions.push(condition); return chain; },
        orderBy: () => Promise.resolve(rows), then: (resolve: any) => Promise.resolve(rows).then(resolve) };
      return chain;
    }) };
    const db: any = { transaction: vi.fn(async (fn: any) => fn(tx)) };
    const availability: any = { searchAvailability: vi.fn().mockResolvedValue([{ date: '2026-10-10', available: 0 }]) };
    const dto = { propertyId: 'hotel-a', checkIn: '2026-10-10', checkOut: '2026-10-17' };
    const result = await new ReservationCalendarService(db, availability).range(dto);
    expect(result.complete).toBe(true); expect(result.reservations).toHaveLength(125);
    expect(result.reservations[124].guestName).toBe('Иван Петров');
    expect(db.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'repeatable read', accessMode: 'read only' });
    expect(availability.searchAvailability).toHaveBeenCalledWith('hotel-a', dto.checkIn, dto.checkOut, undefined, tx);
    const dialect = new PgDialect();
    for (const condition of conditions) expect(dialect.sqlToQuery(condition).params).toContain('hotel-a');
    const overlaps = dialect.sqlToQuery(conditions[2]);
    expect(overlaps.params).toEqual(expect.arrayContaining([dto.checkIn, dto.checkOut, 'cancelled', 'checked_out']));
  });
  it('rejects an unbounded range before querying the database', async () => {
    const db: any = { transaction: vi.fn() };
    await expect(new ReservationCalendarService(db, {} as any).range({ propertyId: 'hotel-a', checkIn: '2026-10-01', checkOut: '2026-12-01' })).rejects.toThrow('31 nights');
    expect(db.transaction).not.toHaveBeenCalled();
  });
});

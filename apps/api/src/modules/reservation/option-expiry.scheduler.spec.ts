import { describe, expect, it, vi } from 'vitest';
import { OptionExpiryScheduler } from './option-expiry.scheduler';

describe('OptionExpiryScheduler', () => {
  it('sweeps every property with an expired option and keeps going after a failure', async () => {
    const guarantee = {
      propertiesWithExpiredOptions: vi.fn(async () => ['p1', 'p2']),
      sweepExpiredOptions: vi.fn(async (id: string) => { if (id === 'p1') throw new Error('boom'); return { cancelled: 1 }; }),
    };
    const scheduler = new OptionExpiryScheduler(guarantee as any);
    const at = new Date('2027-01-10T10:00:00Z');
    expect(await scheduler.tick(at)).toEqual({ properties: 2, skipped: false });
    expect(guarantee.sweepExpiredOptions).toHaveBeenCalledWith('p2', at);
  });

  it('does not overlap runs', async () => {
    let release!: () => void;
    const guarantee = { propertiesWithExpiredOptions: vi.fn(() => new Promise<string[]>((r) => { release = () => r([]); })), sweepExpiredOptions: vi.fn() };
    const scheduler = new OptionExpiryScheduler(guarantee as any);
    const first = scheduler.tick();
    expect(await scheduler.tick()).toEqual({ properties: 0, skipped: true });
    release(); await first;
  });
});

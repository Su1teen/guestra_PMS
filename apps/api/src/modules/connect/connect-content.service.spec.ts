import { describe, expect, it, vi } from 'vitest';
import { ConnectContentService } from './connect-content.service';

describe('ConnectContentService.getPropertyDetail', () => {
  function makeService(settings: Record<string, unknown> | null) {
    const property = {
      id: 'aaaaaaaa-0000-4000-a000-000000000001',
      name: 'ЛЕС Боровое',
      code: 'LES',
      settings,
    };
    const db = {
      select: vi.fn()
        .mockReturnValueOnce({ from: () => ({ where: async () => [property] }) })
        .mockReturnValueOnce({ from: () => ({ where: async () => [] }) }),
    };
    return new ConnectContentService(db as any);
  }

  it('exposes structured guest information from the property settings', async () => {
    const guestInfo = { pets: 'По согласованию', wifi: 'Для гостей', breakfast: 'По запросу' };
    const result = await makeService({ depositPercentage: 20, guestInfo })
      .getPropertyDetail('aaaaaaaa-0000-4000-a000-000000000001');
    expect(result.guestInfo).toEqual(guestInfo);
    expect(result.policies.depositRequired).toBe(true);
  });

  it('returns null when guest information has not been set', async () => {
    const result = await makeService(null)
      .getPropertyDetail('aaaaaaaa-0000-4000-a000-000000000001');
    expect(result.guestInfo).toBeNull();
  });
});

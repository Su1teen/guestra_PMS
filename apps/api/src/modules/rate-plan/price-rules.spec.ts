import { describe, expect, it, vi } from 'vitest';
import { finishPrice, overlappingRule, startingPrice, type PriceRuleLike } from './price-rules';
import { RatePlanService } from './rate-plan.service';
import { PriceCalendarService } from './price-calendar.service';

const rule = (over: Partial<PriceRuleLike>): PriceRuleLike => ({ id: 'r', kind: 'season', name: 'Лето', startDate: '2026-12-01', endDate: '2026-12-31',
  roomTypeIds: [], adjustmentType: 'percent', value: '20', isActive: true, ...over });
const season = rule({ id: 'season', kind: 'season', name: 'Зима', value: '20' });
const holiday = rule({ id: 'holiday', kind: 'holiday', name: 'Новый год', startDate: '2026-12-31', endDate: '2026-12-31', adjustmentType: 'fixed_price', value: '90000' });
const promo = rule({ id: 'promo', kind: 'promo', name: 'Ранняя бронь', value: '-10' });

describe('price calendar order', () => {
  it('season and holiday on the same night: the holiday wins and both the price and the reason are visible', () => {
    expect(startingPrice(50000, '2026-12-15', 'rt', [season, holiday])).toMatchObject({ amount: 60000, steps: [{ step: 'base' }, { step: 'season', label: 'Сезон «Зима»' }] });
    const night = startingPrice(50000, '2026-12-31', 'rt', [season, holiday]);
    expect(night.amount).toBe(90000);
    expect(night.steps.map((s) => s.label)).toEqual(['Базовая цена тарифа', 'Праздник «Новый год»']);
  });

  it('applies one promo after the day price and then the room type min / max', () => {
    expect(finishPrice(60000, '2026-12-15', 'rt', [promo], null, { promo: true })).toMatchObject({ amount: 54000, steps: [{ step: 'promo' }] });
    expect(finishPrice(60000, '2026-12-15', 'rt', [promo], { minPrice: '58000', maxPrice: null }, { promo: true }).amount).toBe(58000);
    expect(finishPrice(95000, '2026-12-15', 'rt', [], { minPrice: null, maxPrice: '80000' }, { promo: true })).toMatchObject({ amount: 80000, steps: [{ step: 'max' }] });
    expect(finishPrice(60000, '2026-12-15', 'rt', [promo], null, { promo: false }).steps).toEqual([]);
  });

  it('a rule for other room types does not touch this one', () => {
    expect(startingPrice(50000, '2026-12-15', 'rt', [rule({ roomTypeIds: ['other'] })]).amount).toBe(50000);
  });

  it('refuses two seasons over the same nights for a common room type', () => {
    expect(overlappingRule([season], rule({ id: 'n', name: 'Зима 2', startDate: '2026-12-20', endDate: '2027-01-10' }))?.id).toBe('season');
    expect(overlappingRule([season], rule({ id: 'n', kind: 'holiday' }))).toBeUndefined();
    expect(overlappingRule([rule({ roomTypeIds: ['a'] })], rule({ id: 'n', roomTypeIds: ['b'] }))).toBeUndefined();
  });
});

describe('RatePlanService with the price calendar', () => {
  const service = () => {
    const rates = new RatePlanService({} as any);
    vi.spyOn(rates, 'findById').mockResolvedValue({ id: 'plan', propertyId: 'p', type: 'base', baseAmount: '50000', currencyCode: 'KZT', roomTypeId: 'rt',
      losAdjustments: null, occupancyBands: null, isTaxInclusive: true } as any);
    vi.spyOn(rates, 'findRestrictions').mockResolvedValue([]);
    vi.spyOn(rates, 'priceRulesFor').mockResolvedValue([season, holiday, promo]);
    vi.spyOn(rates, 'priceBoundsFor').mockResolvedValue({ minPrice: '50000', maxPrice: null });
    return rates;
  };

  it('manual day price beats the holiday, then promo and minimum apply; every step is explained', async () => {
    const rates = service();
    const night = await rates.calculateDerivedRate('plan', 'p', { stayDate: '2026-12-31' } as any);
    expect(night.effectiveRate).toBe(81000);
    expect(night.priceSteps!.map((s) => s.step)).toEqual(['base', 'holiday', 'promo']);
    vi.mocked(rates.findRestrictions).mockResolvedValue([{ id: 'x', startDate: '2026-12-31', endDate: '2026-12-31', rateOverride: '52000', overrideReason: 'VIP', dayOfWeekOverrides: null }] as any);
    const manual = await rates.calculateDerivedRate('plan', 'p', { stayDate: '2026-12-31' } as any);
    expect(manual.priceSteps!.map((s) => s.step)).toEqual(['base', 'holiday', 'manual', 'promo', 'min']);
    expect(manual.effectiveRate).toBe(50000);
  });

  it('without rules and bounds the price is the plan price, as before', async () => {
    const rates = service();
    vi.mocked(rates.priceRulesFor).mockResolvedValue([]); vi.mocked(rates.priceBoundsFor).mockResolvedValue(null);
    expect(await rates.calculateDerivedRate('plan', 'p', { stayDate: '2026-12-31' } as any)).toMatchObject({ effectiveRate: 50000, priceSteps: [{ step: 'base' }] });
  });

  it('preview shows before / after without saving and refuses an ambiguous rule', async () => {
    const rates = service();
    vi.mocked(rates.priceRulesFor).mockResolvedValue([]);
    vi.spyOn(rates, 'withPriceRulesDraft').mockImplementation((draft) => {
      const copy = service(); vi.mocked(copy.priceRulesFor).mockResolvedValue(draft.rules); vi.mocked(copy.priceBoundsFor).mockResolvedValue(null); return copy;
    });
    vi.mocked(rates.priceBoundsFor).mockResolvedValue(null);
    const db = { select: vi.fn() } as any;
    const calendar = new PriceCalendarService(db, rates);
    vi.spyOn(calendar as any, 'types').mockResolvedValue([{ id: 'rt', name: 'Шале' }]);
    vi.spyOn(calendar as any, 'basePlans').mockResolvedValue([{ id: 'plan', roomTypeId: 'rt', type: 'base' }]);
    vi.spyOn(calendar, 'rules').mockResolvedValue([]);
    const out = await calendar.preview('p', { kind: 'season', name: 'Зима', startDate: '2026-12-01', endDate: '2026-12-02', adjustmentType: 'percent', value: '20', reason: 'Высокий сезон' });
    expect(out.days.map((d) => [d.before, d.after])).toEqual([[50000, 60000], [50000, 60000]]);
    vi.mocked(calendar.rules).mockResolvedValue([season] as any);
    await expect(calendar.preview('p', { kind: 'season', name: 'Зима 2', startDate: '2026-12-10', endDate: '2026-12-12', adjustmentType: 'percent', value: '5', reason: 'Тест' }))
      .rejects.toThrow(/пересекается/);
  });
});

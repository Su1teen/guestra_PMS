import Decimal from 'decimal.js';

export const PRICE_RULE_KINDS = ['season', 'holiday', 'promo'] as const;
export type PriceRuleKind = (typeof PRICE_RULE_KINDS)[number];
export const PRICE_ADJUSTMENT_TYPES = ['percent', 'fixed_price'] as const;

export interface PriceRuleLike {
  id: string;
  kind: PriceRuleKind | string;
  name: string;
  startDate: string;
  endDate: string;
  roomTypeIds: string[] | null;
  adjustmentType: 'percent' | 'fixed_price' | string;
  value: string | number;
  isActive: boolean;
}

export interface PriceBounds { minPrice: string | number | null; maxPrice: string | number | null }

/** One line of «почему такая цена». */
export interface PriceStep {
  step: 'base' | 'season' | 'holiday' | 'manual' | 'promo' | 'min' | 'max';
  label: string;
  amount: number;
  ruleId?: string;
}

const round = (value: Decimal.Value) => new Decimal(value).toDecimalPlaces(2).toNumber();

/** Active rules of one kind covering a night (end date inclusive) for a room type; an empty list means every type. */
export function rulesCovering(rules: PriceRuleLike[], kind: PriceRuleKind, date: string, roomTypeId: string | null | undefined) {
  return rules.filter((rule) => rule.isActive && rule.kind === kind && rule.startDate <= date && rule.endDate >= date
    && (!rule.roomTypeIds?.length || (roomTypeId != null && rule.roomTypeIds.includes(roomTypeId))));
}

export function applyAdjustment(amount: number, rule: Pick<PriceRuleLike, 'adjustmentType' | 'value'>) {
  if (rule.adjustmentType === 'fixed_price') return round(rule.value);
  return round(new Decimal(amount).mul(new Decimal(100).plus(rule.value)).div(100));
}

/** Starting price of a night: a holiday wins over a season, a season over the plan's base price. */
export function startingPrice(base: number, date: string, roomTypeId: string | null | undefined, rules: PriceRuleLike[]) {
  const steps: PriceStep[] = [{ step: 'base', label: 'Базовая цена тарифа', amount: round(base) }];
  const holiday = rulesCovering(rules, 'holiday', date, roomTypeId)[0];
  const season = rulesCovering(rules, 'season', date, roomTypeId)[0];
  const rule = holiday ?? season;
  if (!rule) return { amount: round(base), steps };
  const amount = applyAdjustment(base, rule);
  steps.push({ step: rule.kind as PriceStep['step'], label: `${rule.kind === 'holiday' ? 'Праздник' : 'Сезон'} «${rule.name}»`, amount, ruleId: rule.id });
  return { amount, steps };
}

/** After the day's price is known: one promo (base plans only), then the room type's min / max. */
export function finishPrice(amount: number, date: string, roomTypeId: string | null | undefined, rules: PriceRuleLike[],
  bounds: PriceBounds | null, options: { promo: boolean }) {
  const steps: PriceStep[] = [];
  let price = round(amount);
  const promo = options.promo ? rulesCovering(rules, 'promo', date, roomTypeId)[0] : undefined;
  if (promo) {
    price = applyAdjustment(price, promo);
    steps.push({ step: 'promo', label: `Акция «${promo.name}»`, amount: price, ruleId: promo.id });
  }
  if (bounds?.minPrice != null && price < Number(bounds.minPrice)) {
    price = round(bounds.minPrice);
    steps.push({ step: 'min', label: 'Не ниже минимальной цены типа номера', amount: price });
  }
  if (bounds?.maxPrice != null && price > Number(bounds.maxPrice)) {
    price = round(bounds.maxPrice);
    steps.push({ step: 'max', label: 'Не выше максимальной цены типа номера', amount: price });
  }
  return { amount: Math.max(0, price), steps };
}

/** Two rules of the same kind may not overlap for a common room type: the price of every night stays unambiguous. */
export function overlappingRule(existing: PriceRuleLike[], candidate: PriceRuleLike) {
  if (!candidate.isActive) return undefined;
  return existing.find((rule) => rule.id !== candidate.id && rule.isActive && rule.kind === candidate.kind
    && rule.startDate <= candidate.endDate && rule.endDate >= candidate.startDate
    && (!rule.roomTypeIds?.length || !candidate.roomTypeIds?.length || rule.roomTypeIds.some((id) => candidate.roomTypeIds!.includes(id))));
}

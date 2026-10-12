import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { useProperty } from '../../context/PropertyContext';
import { addDaysKey, propertyClock } from '../../lib/dynamic-pricing';
import { formatMoney } from '../../lib/money';
import { propertyHref } from '../../lib/navigation';
import { pricingError, unwrap, validCalendarRange, type LiveCalendar } from '../../lib/live-revenue';

export default function RatePlanCalendar({ ratePlanId, propertyId }: { ratePlanId: string; propertyId: string }) {
  const { t, i18n } = useTranslation();
  const ru = i18n.language.startsWith('ru');
  const { hasPermission } = useAuth();
  const { properties } = useProperty();
  const today = propertyClock(new Date(), properties.find(p => p.id === propertyId)?.timezone).today;
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(addDaysKey(today, 13));
  const valid = validCalendarRange(startDate, endDate);
  const allowed = hasPermission('rateplans.read', 'reports.view');
  const calendar = useQuery<LiveCalendar>({
    queryKey: ['rate-plans', 'live-calendar', propertyId, ratePlanId, startDate, endDate, 1],
    queryFn: ({ signal }) => api.get('/v1/rate-plans/live-calendar', {
      params: { propertyId, ratePlanId, startDate, endDate, nights: 1 }, signal,
    }).then(r => unwrap(r.data)),
    enabled: allowed && valid,
  });
  const field = 'rounded-lg border px-3 py-2 text-sm';
  return <section className="mt-4 rounded-xl bg-white p-4 shadow-sm">
    <div className="mb-3 flex flex-wrap items-end gap-3">
      <h2 className="mr-auto font-semibold">{t('ratePlans.calendar')}</h2>
      <label className="text-xs">{t('reports.from')}<input className={field} type="date" value={startDate} onChange={e => setStartDate(e.target.value)} /></label>
      <label className="text-xs">{t('reports.to')}<input className={field} type="date" value={endDate} onChange={e => setEndDate(e.target.value)} /></label>
    </div>
    <p className="mb-3 text-xs text-telivity-mid-grey">{ru ? 'RatePlanService: canonical тариф и котировка на одну ночь с налогами. Не earned revenue.' : 'RatePlanService: canonical one-night price and quote including tax. Not earned revenue.'}</p>
    {!allowed ? <p>{ru ? 'Для календаря требуются rateplans.read и reports.view.' : 'Calendar requires rateplans.read and reports.view.'}</p> :
      !valid ? <p role="alert">{ru ? 'Выберите период до 93 дней.' : 'Select a range of up to 93 days.'}</p> :
      calendar.isPending ? <p role="status">{t('common.loading')}</p> :
      calendar.isError ? <p role="alert">{pricingError(calendar.error, ru)} <button type="button" onClick={() => void calendar.refetch()}>{ru ? 'Повторить' : 'Retry'}</button></p> :
      calendar.data.rates.length === 0 ? <p>{t('ratePlans.calendarEmpty')}</p> :
      <div className="max-h-80 overflow-auto"><table className="w-full whitespace-nowrap text-left text-xs tabular-nums"><thead className="sticky top-0 bg-gray-50"><tr>{[t('reports.date'), t('ratePlans.baseRate'), t('ratePlans.effectiveRate'), ru ? 'Котировка с налогом' : 'Quote incl. tax', t('ratePlans.restrictions')].map(h => <th key={h} className="p-2">{h}</th>)}</tr></thead><tbody>{calendar.data.rates.map(rate => <tr key={rate.date} className="border-t"><td className="p-2">{rate.date}</td><td className="p-2">{formatMoney(rate.price.baseRate, rate.currencyCode, i18n.language)}</td><td className="p-2">{formatMoney(rate.price.effectiveRate, rate.currencyCode, i18n.language)}</td><td className="p-2">{formatMoney(rate.quote.totalAmount, rate.quote.currency, i18n.language)}</td><td className="p-2 whitespace-normal">{rate.restrictionReason ?? (ru ? 'Продажи открыты' : 'Sales open')}</td></tr>)}</tbody></table></div>}
    <Link className="mt-3 inline-block text-sm font-semibold text-telivity-teal" to={propertyHref('/revenue?ratePlanId=' + ratePlanId, propertyId)}>{ru ? 'Открыть Live Rate Management →' : 'Open Live Rate Management →'}</Link>
  </section>;
}

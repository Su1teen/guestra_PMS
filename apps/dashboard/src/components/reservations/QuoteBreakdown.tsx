import { format } from 'date-fns';
import { useTranslation } from 'react-i18next';
import { getDateLocale } from '../../lib/date-locale';
import { formatMoney } from '../../lib/money';
import type { QuoteResult, SupplementLine } from '../../lib/booking';

/** Canonical quote: total, every night, and the extra-guest supplement per guest. */
export default function QuoteBreakdown({ quote, loading, error, fallbackCurrency, title }: {
  quote?: QuoteResult; loading?: boolean; error?: string | null; fallbackCurrency?: string | null; title?: string;
}) {
  const { t, i18n } = useTranslation();
  const dateLocale = getDateLocale(i18n.resolvedLanguage);
  const currency = quote?.currency ?? fallbackCurrency ?? undefined;
  const nights = quote?.lineItems.length ?? 0;
  const supplement = quote?.occupancySupplement;
  const avg = quote && nights ? (Number(quote.totalAmount) / nights).toFixed(2) : undefined;

  return (
    <section className="card overflow-hidden" aria-live="polite">
      <div className="flex items-baseline justify-between gap-3 border-b border-gray-100 px-4 py-3">
        <div>
          <p className="text-sm font-semibold text-telivity-navy">{title ?? t('booking.stayPrice')}</p>
          <p className="text-xs text-telivity-mid-grey">
            {nights ? t('booking.nightsAvg', { count: nights, avg: formatMoney(avg, currency) }) : t('booking.chooseToPrice')}
          </p>
        </div>
        <p className="text-xl font-semibold tabular-nums text-telivity-navy">{quote ? formatMoney(quote.totalAmount, currency) : '—'}</p>
      </div>
      {loading && <p role="status" className="px-4 py-2 text-xs text-telivity-mid-grey">{t('booking.pricing')}</p>}
      {error && <p role="alert" className="px-4 py-2 text-sm text-red-700">{error}</p>}
      {quote && (
        <>
          <ul className="max-h-44 divide-y divide-gray-100 overflow-y-auto">
            {quote.lineItems.map((night) => (
              <li key={night.date} className="flex items-center justify-between px-4 py-1.5 text-sm">
                <span className="text-telivity-slate">{format(new Date(`${night.date}T00:00:00`), 'EEE, d MMM', { locale: dateLocale })}</span>
                <span className="tabular-nums font-medium text-telivity-navy">{formatMoney(night.rate, currency)}</span>
              </li>
            ))}
          </ul>
          {supplement && supplement.lines.length > 0 && (
            <div className="border-t border-gray-100 bg-telivity-light-grey/60 px-4 py-2">
              <p className="mb-1 text-xs font-semibold text-telivity-slate">{t('booking.supplementTitle')}</p>
              <ul className="space-y-0.5">
                {supplement.lines.map((line, i) => (
                  <li key={i} className="flex justify-between text-xs text-telivity-slate">
                    <span>{supplementText(line, t)}</span>
                    <span className="tabular-nums">{Number(line.amountPerNight) === 0 ? t('booking.free') : `${formatMoney(line.amountPerNight, currency)} ${t('booking.perNight')}`}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {Number(quote.taxTotal) > 0 && (
            <p className="border-t border-gray-100 px-4 py-2 text-xs text-telivity-mid-grey">{t('booking.taxIncluded', { amount: formatMoney(quote.taxTotal, currency) })}</p>
          )}
        </>
      )}
    </section>
  );
}

export function supplementText(line: SupplementLine, t: (key: string, opts?: Record<string, unknown>) => string) {
  if (line.kind === 'adult') return t('booking.extraAdult', { n: line.ordinal });
  if (line.band == null || line.age == null) return t('booking.extraChild', { n: line.ordinal });
  return t('booking.childLine', { n: line.ordinal, band: line.bandLabel ?? '', age: line.age ?? '' });
}

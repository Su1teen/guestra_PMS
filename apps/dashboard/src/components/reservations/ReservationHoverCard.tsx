import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { CalendarDays, CheckCircle2, Clock3, CreditCard, MessageSquareText, Users } from 'lucide-react';
import { formatMoney } from '../../lib/money';
import { CHIP_CLASSES, compactParty, optionState, statusTone } from '../../lib/booking';
import type { Reservation } from './types';

export interface HoverTarget { reservation: Reservation; rect: DOMRect }

/**
 * Quick facts about a booking when the pointer rests on its bar (or the bar has keyboard focus):
 * guest, dates, party, room, tariff, status and option deadline, money, source, group and requests.
 * Everything comes from the already loaded tape-chart data — no request per hover.
 */
export default function ReservationHoverCard({ target, roomNumber, roomTypeName, ledger, showMoney }: {
  target: HoverTarget | null; roomNumber?: string; roomTypeName?: string;
  ledger?: { hasPostedPayment: boolean; hasBalanceDue: boolean }; showMoney: boolean;
}) {
  const { t, i18n } = useTranslation();
  const card = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!target || !card.current) { setPosition(null); return; }
    const { rect } = target;
    const width = card.current.offsetWidth;
    const height = card.current.offsetHeight;
    const gap = 8;
    const below = rect.bottom + gap + height <= window.innerHeight;
    const top = below ? rect.bottom + gap : Math.max(gap, rect.top - gap - height);
    const left = Math.min(Math.max(gap, rect.left), window.innerWidth - width - gap);
    setPosition({ top, left });
  }, [target]);

  if (!target) return null;
  const r = target.reservation;
  const tone = statusTone(r.status);
  const option = optionState(r.optionUntil);
  const dateFmt = new Intl.DateTimeFormat(i18n.resolvedLanguage, { day: 'numeric', month: 'short' });
  const timeFmt = new Intl.DateTimeFormat(i18n.resolvedLanguage, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const nights = r.nights ?? Math.round((Date.parse(r.departureDate) - Date.parse(r.arrivalDate)) / 86_400_000);

  return createPortal(
    <div ref={card} role="tooltip" id={`hover-${r.id}`}
      style={{ top: position?.top ?? -9999, left: position?.left ?? -9999 }}
      className="pointer-events-none fixed z-[60] w-80 animate-pop-in rounded-xl border border-gray-200 bg-white p-4 text-sm shadow-lg">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-base font-semibold text-telivity-navy">{r.guestName || r.confirmationNumber}</p>
          <p className="text-xs text-telivity-mid-grey">{r.confirmationNumber}{r.groupName ? ` · ${r.groupName}` : ''}</p>
        </div>
        <span className={`chip shrink-0 ${CHIP_CLASSES[tone]}`}>{t(`reservations.statuses.${r.status}`, { defaultValue: r.status })}</span>
      </div>

      <dl className="mt-3 space-y-2">
        <Row icon={<CalendarDays size={14} />} label={t('booking.hover.stay')}>
          {dateFmt.format(new Date(`${r.arrivalDate}T00:00:00`))} – {dateFmt.format(new Date(`${r.departureDate}T00:00:00`))} · {t('booking.hover.nights', { count: nights })}
        </Row>
        <Row icon={<Users size={14} />} label={t('booking.hover.party')}>
          {t('booking.hover.partyValue', { adults: r.adults ?? 1, children: r.children ?? 0 })}{r.childAges?.length ? ` (${r.childAges.join(', ')})` : ''}
          <span className="text-telivity-mid-grey"> · {roomNumber ?? '—'}{roomTypeName ? `, ${roomTypeName}` : ''}</span>
        </Row>
        {r.ratePlanName && <Row icon={<CreditCard size={14} />} label={t('booking.hover.rate')}>{r.ratePlanName}</Row>}
        {tone === 'tentative' && (
          <Row icon={<Clock3 size={14} />} label={t('booking.hover.option')}>
            <span className={option === 'expired' ? 'font-semibold text-red-700' : option === 'soon' ? 'text-amber-800' : ''}>
              {r.optionUntil ? (option === 'expired' ? t('booking.hover.expired', { at: timeFmt.format(new Date(r.optionUntil)) }) : t('booking.hover.until', { at: timeFmt.format(new Date(r.optionUntil)) })) : t('booking.status.noDeadline')}
            </span>
            {r.requiredDeposit && <span className="block text-xs text-telivity-mid-grey">{t('booking.hover.guarantee', { amount: formatMoney(r.requiredDeposit, r.currencyCode) })}</span>}
          </Row>
        )}
        {r.detailsConfirmedAt && <Row icon={<CheckCircle2 size={14} />} label={t('booking.hover.guestCheck')}><span className="text-emerald-700">{t('booking.hover.guestConfirmed')}</span></Row>}
        {r.specialRequests && <Row icon={<MessageSquareText size={14} />} label={t('booking.hover.requests')}><span className="line-clamp-2">{r.specialRequests}</span></Row>}
      </dl>

      <div className="mt-3 flex items-center justify-between border-t border-gray-100 pt-3">
        <span className="text-xs text-telivity-mid-grey">{t('reservationWorkspace.sources.' + (r.source ?? 'unknown'), { defaultValue: r.source ?? '' })} · {compactParty(r.adults ?? 1, r.children ?? 0)}</span>
        <span className="text-right">
          <span className="block font-semibold tabular-nums text-telivity-navy">{r.totalAmount != null ? formatMoney(r.totalAmount, r.currencyCode) : '—'}</span>
          {showMoney && ledger && (
            <span className={`block text-xs ${ledger.hasBalanceDue ? 'text-red-700' : ledger.hasPostedPayment ? 'text-emerald-700' : 'text-telivity-mid-grey'}`}>
              {ledger.hasBalanceDue ? t('reservations.tape.balanceDue') : ledger.hasPostedPayment ? t('reservations.tape.paymentRecorded') : t('reservations.tape.noPaymentRecorded')}
            </span>
          )}
        </span>
      </div>
      <p className="mt-2 text-xs text-telivity-mid-grey">{t('booking.hover.clickHint')}</p>
    </div>,
    document.body,
  );
}

function Row({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="mt-0.5 text-telivity-mid-grey" aria-label={label}>{icon}</dt>
      <dd className="min-w-0 text-telivity-navy">{children}</dd>
    </div>
  );
}

import { useEffect, useMemo, useState, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { useTranslation } from 'react-i18next';
import { CalendarDays, CheckCircle2, BedDouble } from 'lucide-react';
import { api } from '../../lib/api';
import { requireCurrency, requirePropertyId } from '../../lib/api-helpers';
import { getDateLocale } from '../../lib/date-locale';
import { formatMoney } from '../../lib/money';
import { useProperty } from '../../context/PropertyContext';
import { useAuth } from '../../context/AuthContext';
import { staffRecoveryKey, saveStaffRequest, clearStaffRequest, usePendingStaffRequest } from '../../lib/staff-booking-recovery';
import { defaultDeposit, defaultOptionUntil, partyComplete, type Party, type QuoteResult } from '../../lib/booking';
import { useBookingPolicy } from '../../hooks/useBookingPolicy';
import Modal from '../ui/Modal';
import { useToast } from '../ui/Toast';
import FindGuest from '../guests/FindGuest';
import GuestContextSummary from '../guests/GuestContextSummary';
import { errorMessage } from '../../lib/error-message';
import PartyInput from './PartyInput';
import QuoteBreakdown from './QuoteBreakdown';
import BookingStartOptions, { initialStartOptions, startOptionsPayload, startOptionsValid, type StartOptions } from './BookingStartOptions';
import GuestDocumentPanel from './GuestDocumentPanel';
import type { Guest } from '../../types/guest';

/** What the tape chart knows the moment the drag ends. */
export interface CreateReservationPrefill {
  roomId?: string;
  roomNumber: string;
  roomTypeId: string;
  roomTypeName?: string;
  checkInDate: string;
  checkOutDate: string;
  ratePlanId?: string;
  adults?: number;
  children?: number;
  childAges?: number[];
  /** Room type capacity, to stop staff from building a party the room cannot take. */
  maxOccupancy?: number;
}

interface CreateReservationModalProps {
  open: boolean;
  prefill: CreateReservationPrefill | null;
  onClose: () => void;
  onCreated?: (reservationId: string) => void;
}

interface RatePlanOption {
  id: string;
  name: string;
  roomTypeId?: string;
  baseAmount?: string | number;
}

/**
 * Create a reservation from a tape-chart drag.
 *
 * Room and tax amounts come from the canonical PMS quote endpoint (child ages included).
 * Creation and room hold share one idempotent transaction. The booking starts as a tentative
 * option or confirmed; right after creation the same window builds and sends the guest document.
 */
export default function CreateReservationModal({
  open,
  prefill,
  onClose,
  onCreated,
}: CreateReservationModalProps) {
  const { t, i18n } = useTranslation();
  const { propertyId, currencyCode } = useProperty();
  const { user, hasPermission } = useAuth();
  const recoveryKey = staffRecoveryKey(user?.sub ?? 'demo', propertyId ?? '');
  const pendingRequest = usePendingStaffRequest(recoveryKey);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const dateLocale = getDateLocale(i18n.resolvedLanguage);
  const policyQuery = useBookingPolicy(propertyId, open);
  const policy = policyQuery.data;

  const requestId = useRef(crypto.randomUUID());
  const submitted = useRef<Record<string, unknown> | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [guest, setGuest] = useState<Guest | null>(null);
  const [ratePlanId, setRatePlanId] = useState('');
  const [party, setParty] = useState<Party>({ adults: 1, children: 0, childAges: [] });
  const [specialRequests, setSpecialRequests] = useState('');
  const [start, setStart] = useState<StartOptions>(initialStartOptions);
  const [created, setCreated] = useState<{ id: string; status: string } | null>(null);
  const blockedByRecovery = !!pendingRequest && !submitted.current;

  const { data: ratePlanData } = useQuery({
    queryKey: ['rate-plans', propertyId],
    queryFn: () => api.get('/v1/rate-plans', { params: { propertyId } }).then((r) => r.data),
    enabled: open && !!propertyId,
  });

  const ratePlans: RatePlanOption[] = useMemo(() => {
    const all: RatePlanOption[] = ratePlanData?.data ?? ratePlanData ?? [];
    return all.filter((rp) => rp.roomTypeId === prefill?.roomTypeId);
  }, [ratePlanData, prefill?.roomTypeId]);

  useEffect(() => {
    if (!open) {
      requestId.current = crypto.randomUUID();
      submitted.current = null;
      setUncertain(false);
      setGuest(null);
      setRatePlanId('');
      setParty({ adults: 1, children: 0, childAges: [] });
      setSpecialRequests('');
      setStart(initialStartOptions());
      setCreated(null);
    }
  }, [open]);

  useEffect(() => {
    if (open && !ratePlanId && ratePlans.length) setRatePlanId(ratePlans.find(plan => plan.id === prefill?.ratePlanId)?.id ?? ratePlans[0].id);
  }, [open, ratePlanId, ratePlans, prefill?.ratePlanId]);
  useEffect(() => {
    if (open) setParty({ adults: prefill?.adults ?? 1, children: prefill?.children ?? prefill?.childAges?.length ?? 0, childAges: prefill?.childAges ?? [] });
  }, [open, prefill?.adults, prefill?.children, prefill?.childAges]);

  const ready = partyComplete(party);
  const quoteBody = { propertyId, roomTypeId: prefill?.roomTypeId, ratePlanId, checkIn: prefill?.checkInDate, checkOut: prefill?.checkOutDate,
    adults: party.adults, ...(party.childAges.length ? { childAges: party.childAges } : { children: party.children }),
    ...(guest?.id ? { guestId: guest.id } : {}) };
  const quoteQuery = useQuery<QuoteResult>({
    queryKey: ['reservation-quote', propertyId, prefill?.roomTypeId, ratePlanId, prefill?.checkInDate, prefill?.checkOutDate, guest?.id, party.adults, party.childAges.join(','), party.children],
    queryFn: () => api.post('/v1/reservations/quote', quoteBody, { skipErrorToast: true }).then((r) => r.data?.data ?? r.data),
    enabled: open && !!propertyId && !!prefill && !!ratePlanId && ready && !created,
    staleTime: 0,
  });
  const quote = quoteQuery.data;

  // Policy defaults fill the option terms once the price is known; staff edits win afterwards.
  const touched = useRef(false);
  useEffect(() => {
    if (!open || touched.current || !policy) return;
    setStart((s) => ({ ...s, optionUntil: s.optionUntil || defaultOptionUntil(policy), requiredDeposit: defaultDeposit(policy, quote?.totalAmount) || s.requiredDeposit }));
  }, [open, policy, quote?.totalAmount]);
  useEffect(() => { if (!open) touched.current = false; }, [open]);

  const createMutation = useMutation({
    mutationFn: async () => {
      if (blockedByRecovery) throw new Error(t('staffRecovery.pending'));
      requirePropertyId(propertyId);
      requireCurrency(currencyCode);
      if (!prefill) throw new Error(t('reservationWorkspace.quoteError'));
      if (!guest?.id) throw new Error(t('reservations.tape.guestRequired'));
      if (!ratePlanId) throw new Error(t('reservations.tape.ratePlanRequired'));

      if (!submitted.current) {
        const fresh = await quoteQuery.refetch();
        if (!fresh.data || fresh.error) throw new Error(t('reservationWorkspace.quoteError'));
        if (fresh.data.currency !== currencyCode) throw new Error(t('reservationWorkspace.currencyMismatch'));
        if (fresh.data.totalAmount !== quote?.totalAmount) throw new Error(t('reservationWorkspace.quoteChanged'));
        submitted.current = { ...quoteBody, guestId: guest.id, roomId: prefill.roomId,
          requestId: requestId.current, expectedTotal: fresh.data.totalAmount, currencyCode, ...startOptionsPayload(start),
          ...(specialRequests.trim() ? { specialRequests: specialRequests.trim() } : {}) };
      }
      if (!saveStaffRequest(recoveryKey, requestId.current)) {
        submitted.current = null;
        throw new Error(t('staffRecovery.storageError'));
      }
      const res = await api.post('/v1/reservations/staff-create', submitted.current, { skipErrorToast: true });
      const body = res.data?.data ?? res.data;
      if (!body?.id) throw new Error(t('reservationWorkspace.quoteError'));
      return { id: body.id as string, status: String(body.status ?? 'pending'), notification: body.notification as { sent?: boolean } | undefined };
    },
    onSuccess: ({ id, status, notification }) => {
      clearStaffRequest(recoveryKey, requestId.current);
      queryClient.invalidateQueries({ queryKey: ['reservations'] });
      queryClient.invalidateQueries({ queryKey: ['rooms'] });
      queryClient.invalidateQueries({ queryKey: ['reservation-calendar'] });
      toast('success', status === 'pending' ? t('booking.createdTentative', { room: prefill?.roomNumber ?? '' }) : t('reservations.tape.created', { room: prefill?.roomNumber ?? '' }));
      if (notification && notification.sent === false) toast('error', t('booking.doc.notDelivered'));
      onCreated?.(id);
      setCreated({ id, status });
    },
    onError: (error: unknown) => {
      const status = (error as { response?: { status?: number } })?.response?.status;
      // A lost response can mean the transaction committed. Keep the exact request/key for retry.
      const code = (error as { response?: { data?: { code?: string } } })?.response?.data?.code;
      if (submitted.current && (!status || status >= 500 || code === 'REQUEST_CHANGED')) setUncertain(true);
      else { clearStaffRequest(recoveryKey, requestId.current); submitted.current = null; requestId.current = crypto.randomUUID(); setUncertain(false); void quoteQuery.refetch(); }
      toast('error', errorMessage(error));
    },
  });

  const dates = prefill ? `${format(new Date(`${prefill.checkInDate}T00:00:00`), 'd MMM', { locale: dateLocale })} – ${format(new Date(`${prefill.checkOutDate}T00:00:00`), 'd MMM yyyy', { locale: dateLocale })}` : '';
  const canCreate = !blockedByRecovery && !!guest && !!ratePlanId && ready && startOptionsValid(start) && !createMutation.isPending
    && (uncertain || (!!quote && !quoteQuery.isFetching && !quoteQuery.isError && quote.currency === currencyCode));

  return (
    <Modal
      open={open && !!prefill}
      onClose={onClose}
      closeDisabled={createMutation.isPending || uncertain}
      title={created ? t('booking.createdTitle') : t('reservations.tape.createTitle', { room: prefill?.roomNumber ?? '' })}
      xwide
    >
      {prefill && created && propertyId && (
        <div className="space-y-4">
          <div className={`flex items-start gap-3 rounded-lg p-4 ${created.status === 'pending' ? 'bg-amber-50 text-amber-950' : 'bg-emerald-50 text-emerald-950'}`}>
            <CheckCircle2 size={20} className="mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-semibold">{created.status === 'pending' ? t('booking.createdTentativeTitle') : t('booking.createdConfirmedTitle')}</p>
              <p className="text-sm">{t('booking.createdNext')}</p>
            </div>
          </div>
          <GuestDocumentPanel reservationId={created.id} propertyId={propertyId} canSend={hasPermission('reservations.write')} />
          <div className="flex justify-end">
            <button type="button" className="btn-secondary btn-lg" onClick={onClose}>{t('booking.done')}</button>
          </div>
        </div>
      )}

      {prefill && !created && (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
          <fieldset disabled={uncertain || createMutation.isPending} className="min-w-0 space-y-5">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg bg-telivity-light-grey px-4 py-3 text-sm">
              <span className="flex items-center gap-2 font-semibold text-telivity-navy"><BedDouble size={16} />{prefill.roomNumber} · {prefill.roomTypeName ?? '—'}</span>
              <span className="flex items-center gap-2 text-telivity-slate"><CalendarDays size={16} />{dates}</span>
            </div>

            <FindGuest selectedGuest={guest} onSelectGuest={setGuest} />
            {guest && propertyId && <GuestContextSummary key={propertyId + guest.id} guest={guest} propertyId={propertyId}/>}

            <label className="block">
              <span className="label">{t('reservations.ratePlan')}</span>
              <select value={ratePlanId} onChange={(e) => setRatePlanId(e.target.value)} className="field">
                <option value="">{t('reservations.tape.selectRatePlan')}</option>
                {ratePlans.map((rp) => <option key={rp.id} value={rp.id}>{rp.name}</option>)}
              </select>
            </label>

            <PartyInput value={party} onChange={setParty} bands={policy?.childAgeBands} maxGuests={prefill.maxOccupancy} />

            <BookingStartOptions value={start} onChange={(v) => { touched.current = true; setStart(v); }} policy={policy}
              currency={currencyCode} guestHasEmail={!!guest?.email} />

            <label className="block">
              <span className="label">{t('reservations.tape.specialRequests')}</span>
              <textarea value={specialRequests} onChange={(e) => setSpecialRequests(e.target.value)} rows={2} className="field" />
            </label>

            {uncertain && <p role="alert" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{t('reservationWorkspace.retrySame')}</p>}
          </fieldset>

          <aside className="space-y-3 lg:sticky lg:top-0 lg:self-start">
            <QuoteBreakdown quote={ready ? quote : undefined} loading={quoteQuery.isFetching}
              error={!ready ? t('booking.ageRequiredAll') : quoteQuery.isError ? errorMessage(quoteQuery.error) : null} fallbackCurrency={currencyCode} />
            <p className="text-xs text-telivity-mid-grey">{t('reservations.tape.quoteHint')}</p>
            <button type="button" onClick={() => createMutation.mutate()} disabled={!canCreate} className="btn-primary btn-lg w-full">
              {createMutation.isPending ? t('common.creating') : uncertain ? t('reservationWorkspace.continue')
                : start.confirmation === 'tentative'
                  ? t('booking.createTentative', { total: formatMoney(quote?.totalAmount, currencyCode) })
                  : t('booking.createConfirmed', { total: formatMoney(quote?.totalAmount, currencyCode) })}
            </button>
            <button type="button" disabled={createMutation.isPending || uncertain} onClick={onClose} className="btn-ghost w-full">{t('common.cancel')}</button>
          </aside>
        </div>
      )}
    </Modal>
  );
}

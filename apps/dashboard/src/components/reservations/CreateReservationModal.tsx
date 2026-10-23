import { useEffect, useMemo, useState, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { requireCurrency, requirePropertyId } from '../../lib/api-helpers';
import { getDateLocale } from '../../lib/date-locale';
import { formatMoney } from '../../lib/money';
import { useProperty } from '../../context/PropertyContext';
import { useAuth } from '../../context/AuthContext';
import { staffRecoveryKey, saveStaffRequest, clearStaffRequest, usePendingStaffRequest } from '../../lib/staff-booking-recovery';
import Modal from '../ui/Modal';
import { useToast } from '../ui/Toast';
import FindGuest from '../guests/FindGuest';
import GuestContextSummary from '../guests/GuestContextSummary';
import { errorMessage } from '../../lib/error-message';
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

interface ServerQuote { currency: string; totalAmount: string; taxTotal: string; lineItems: Array<{ date: string; rate: string; tax: string }> }

/**
 * Create a reservation from a tape-chart drag.
 *
 * Room and tax amounts come from the canonical PMS quote endpoint.
 * Creation, confirmation and assignment share one idempotent transaction.
 */
export default function CreateReservationModal({
  open,
  prefill,
  onClose,
  onCreated,
}: CreateReservationModalProps) {
  const { t, i18n } = useTranslation();
  const { propertyId, currencyCode } = useProperty();
  const { user } = useAuth();
  const recoveryKey = staffRecoveryKey(user?.sub ?? 'demo', propertyId ?? '');
  const pendingRequest = usePendingStaffRequest(recoveryKey);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const dateLocale = getDateLocale(i18n.resolvedLanguage);

  const requestId = useRef(crypto.randomUUID());
  const submitted = useRef<Record<string, unknown> | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [guest, setGuest] = useState<Guest | null>(null);
  const [ratePlanId, setRatePlanId] = useState('');
  const [adults, setAdults] = useState(1);
  const [children, setChildren] = useState(0);
  const [specialRequests, setSpecialRequests] = useState('');
  const blockedByRecovery = !!pendingRequest && !submitted.current;

  const { data: ratePlanData } = useQuery({
    queryKey: ['rate-plans', propertyId],
    queryFn: () => api.get('/v1/rate-plans', { params: { propertyId } }).then((r) => r.data),
    enabled: open && !!propertyId,
  });

  const ratePlans: RatePlanOption[] = useMemo(() => {
    const all: RatePlanOption[] = ratePlanData?.data ?? ratePlanData ?? [];
    const forType = all.filter((rp) => rp.roomTypeId === prefill?.roomTypeId);
    return forType;
  }, [ratePlanData, prefill?.roomTypeId]);

  useEffect(() => {
    if (!open) {
      requestId.current = crypto.randomUUID();
      submitted.current = null;
      setUncertain(false);
      setGuest(null);
      setRatePlanId('');
      setAdults(1);
      setChildren(0);
      setSpecialRequests('');
    }
  }, [open]);

  useEffect(() => {
    if (open && !ratePlanId && ratePlans.length) setRatePlanId(ratePlans.find(plan => plan.id === prefill?.ratePlanId)?.id ?? ratePlans[0].id);
  }, [open, ratePlanId, ratePlans, prefill?.ratePlanId]);
  useEffect(() => {
    if (open) { setAdults(prefill?.adults ?? 1); setChildren(prefill?.children ?? 0); }
  }, [open, prefill?.adults, prefill?.children]);

  const quoteBody = { propertyId, roomTypeId: prefill?.roomTypeId, ratePlanId, checkIn: prefill?.checkInDate, checkOut: prefill?.checkOutDate, adults, children, ...(guest?.id ? { guestId: guest.id } : {}) };
  const quoteQuery = useQuery<ServerQuote>({
    queryKey: ['reservation-quote', propertyId, prefill?.roomTypeId, ratePlanId, prefill?.checkInDate, prefill?.checkOutDate, guest?.id, adults, children],
    queryFn: () => api.post('/v1/reservations/quote', quoteBody, { skipErrorToast: true }).then((r) => r.data?.data ?? r.data),
    enabled: open && !!propertyId && !!prefill && !!ratePlanId,
    staleTime: 0,
  });
  const quote = quoteQuery.data;

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
          requestId: requestId.current, expectedTotal: fresh.data.totalAmount, currencyCode,
          ...(specialRequests.trim() ? { specialRequests: specialRequests.trim() } : {}) };
      }
      if (!saveStaffRequest(recoveryKey, requestId.current)) {
        submitted.current = null;
        throw new Error(t('staffRecovery.storageError'));
      }
      const res = await api.post('/v1/reservations/staff-create', submitted.current, { skipErrorToast: true });
      const id: string | undefined = res.data?.id ?? res.data?.data?.id;
      if (!id) throw new Error(t('reservationWorkspace.quoteError'));
      return { id };
    },
    onSuccess: ({ id }) => {
      clearStaffRequest(recoveryKey, requestId.current);
      queryClient.invalidateQueries({ queryKey: ['reservations'] });
      queryClient.invalidateQueries({ queryKey: ['rooms'] });
      toast('success', t('reservations.tape.created', { room: prefill?.roomNumber ?? '' }));
      if (id) onCreated?.(id);
      onClose();
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

  const nightCount = quote?.lineItems.length ?? 0;

  return (
    <Modal
      open={open && !!prefill}
      onClose={onClose}
      closeDisabled={createMutation.isPending || uncertain}
      title={t('reservations.tape.createTitle', { room: prefill?.roomNumber ?? '' })}
      wide
    >
      {prefill && (
        <div><fieldset disabled={uncertain || createMutation.isPending} className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 bg-telivity-light-grey rounded-lg p-3 text-sm">
            <Field label={t('reservations.room')} value={prefill.roomNumber} />
            <Field label={t('reservations.roomType')} value={prefill.roomTypeName ?? '—'} />
            <Field
              label={t('reservations.checkIn')}
              value={format(new Date(`${prefill.checkInDate}T00:00:00`), 'd MMM yyyy', {
                locale: dateLocale,
              })}
            />
            <Field
              label={t('reservations.checkOut')}
              value={format(new Date(`${prefill.checkOutDate}T00:00:00`), 'd MMM yyyy', {
                locale: dateLocale,
              })}
            />
          </div>

          <div className="border border-gray-200 rounded-lg">
            <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100">
              <span className="text-xs font-semibold text-telivity-navy">
                {t('reservations.tape.quoteTitle', { count: nightCount })}
              </span>
              <span className="text-base font-semibold text-telivity-teal">
                {formatMoney(quote?.totalAmount, quote?.currency ?? currencyCode)}
              </span>
            </div>
            {quoteQuery.isFetching && <p role="status" className="p-3 text-xs">{t('reservationWorkspace.quoteLoading')}</p>}
            {quoteQuery.isError && <p role="alert" className="p-3 text-xs text-red-700">{errorMessage(quoteQuery.error)}</p>}
            {quote && <p className="px-3 py-2 text-xs text-telivity-mid-grey">{t('reservationWorkspace.tax')}: {formatMoney(quote.taxTotal, quote.currency)}</p>}
            <ul className="max-h-40 overflow-y-auto divide-y divide-gray-50">
              {quote?.lineItems.map((night) => (
                <li key={night.date} className="flex items-center justify-between px-3 py-1.5 text-xs">
                  <span className="text-telivity-slate">
                    {format(new Date(`${night.date}T00:00:00`), 'EEE, d MMM', { locale: dateLocale })}
                  </span>
                  <span className="font-medium text-telivity-navy">
                    {formatMoney(night.rate, quote?.currency ?? currencyCode)}
                  </span>
                </li>
              ))}
            </ul>
            <p className="px-3 py-2 text-[11px] text-telivity-mid-grey border-t border-gray-100">
              {t('reservations.tape.quoteHint')}
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <label className="block sm:col-span-1">
              <span className="block text-xs font-medium text-telivity-mid-grey mb-1">
                {t('reservations.ratePlan')}
              </span>
              <select
                value={ratePlanId}
                onChange={(e) => setRatePlanId(e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-telivity-teal"
              >
                <option value="">{t('reservations.tape.selectRatePlan')}</option>
                {ratePlans.map((rp) => (
                  <option key={rp.id} value={rp.id}>
                    {rp.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="block text-xs font-medium text-telivity-mid-grey mb-1">
                {t('reservations.adults')}
              </span>
              <input
                type="number"
                min={1}
                value={adults}
                onChange={(e) => setAdults(Math.max(1, Number(e.target.value)))}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-telivity-teal"
              />
            </label>
            <label className="block">
              <span className="block text-xs font-medium text-telivity-mid-grey mb-1">
                {t('reservations.children')}
              </span>
              <input
                type="number"
                min={0}
                value={children}
                onChange={(e) => setChildren(Math.max(0, Number(e.target.value)))}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-telivity-teal"
              />
            </label>
          </div>

          <FindGuest selectedGuest={guest} onSelectGuest={setGuest} />
          {guest && propertyId && <GuestContextSummary key={propertyId + guest.id} guest={guest} propertyId={propertyId}/>}

          <label className="block">
            <span className="block text-xs font-medium text-telivity-mid-grey mb-1">
              {t('reservations.tape.specialRequests')}
            </span>
            <textarea
              value={specialRequests}
              onChange={(e) => setSpecialRequests(e.target.value)}
              rows={2}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-telivity-teal"
            />
          </label>

          {uncertain && <p role="alert" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{t('reservationWorkspace.retrySame')}</p>}
        </fieldset>
          <div className="flex gap-3">
            <button
              type="button"
              disabled={createMutation.isPending || uncertain}
              onClick={onClose}
              className="flex-1 border border-gray-200 text-telivity-slate rounded-lg px-4 py-2 text-sm font-semibold"
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              onClick={() => createMutation.mutate()}
              disabled={blockedByRecovery || !guest || !ratePlanId || createMutation.isPending || (!uncertain && (!quote || quoteQuery.isFetching || quoteQuery.isError || quote.currency !== currencyCode))}
              className="flex-1 bg-telivity-teal text-white rounded-lg px-4 py-2 text-sm font-semibold hover:bg-telivity-light-teal disabled:opacity-50"
            >
              {createMutation.isPending
                ? t('common.creating')
                : uncertain ? t('reservationWorkspace.continue') : t('reservations.tape.confirmCreate', {
                    total: formatMoney(quote?.totalAmount, currencyCode),
                  })}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-telivity-mid-grey">{label}</p>
      <p className="text-sm font-medium text-telivity-navy">{value}</p>
    </div>
  );
}

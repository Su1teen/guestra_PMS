import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { moneyString, requireCurrency, requirePropertyId } from '../../lib/api-helpers';
import { getDateLocale } from '../../lib/date-locale';
import { formatMoney } from '../../lib/money';
import { useProperty } from '../../context/PropertyContext';
import Modal from '../ui/Modal';
import { useToast } from '../ui/Toast';
import FindGuest from '../guests/FindGuest';
import {
  DEFAULT_PRICING_SETTINGS,
  categoryFromRoomTypeName,
  computeStayQuote,
  propertyClock,
  stayNightKeys,
  type NightDemand,
} from '../../lib/dynamic-pricing';
import type { Guest } from '../../types/guest';

/** What the tape chart knows the moment the drag ends. */
export interface CreateReservationPrefill {
  roomId: string;
  roomNumber: string;
  roomTypeId: string;
  roomTypeName?: string;
  checkInDate: string;
  checkOutDate: string;
}

interface CreateReservationModalProps {
  open: boolean;
  prefill: CreateReservationPrefill | null;
  /** Per-night demand for the visible window, so the quote is priced from what
   *  the chart is already showing rather than a second round trip. */
  demandByDate: Map<string, NightDemand>;
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
 * The stay total is the SUM OF PER-NIGHT dynamic prices, never a nightly rate
 * times a night count: the arrival night can carry a same-day discount and a
 * mid-stay night can carry an event premium, and a single multiplication would
 * quote both wrongly. The breakdown is shown so the agent can see the number
 * they are about to commit the hotel to.
 */
export default function CreateReservationModal({
  open,
  prefill,
  demandByDate,
  onClose,
  onCreated,
}: CreateReservationModalProps) {
  const { t, i18n } = useTranslation();
  const { propertyId, currencyCode, properties } = useProperty();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const dateLocale = getDateLocale(i18n.resolvedLanguage);
  const timezone = properties.find((p) => p.id === propertyId)?.timezone;

  const [guest, setGuest] = useState<Guest | null>(null);
  const [ratePlanId, setRatePlanId] = useState('');
  const [adults, setAdults] = useState(1);
  const [children, setChildren] = useState(0);
  const [specialRequests, setSpecialRequests] = useState('');

  const { data: ratePlanData } = useQuery({
    queryKey: ['rate-plans', propertyId],
    queryFn: () => api.get('/v1/rate-plans', { params: { propertyId } }).then((r) => r.data),
    enabled: open && !!propertyId,
  });

  const ratePlans: RatePlanOption[] = useMemo(() => {
    const all: RatePlanOption[] = ratePlanData?.data ?? ratePlanData ?? [];
    const forType = all.filter((rp) => !rp.roomTypeId || rp.roomTypeId === prefill?.roomTypeId);
    return forType.length ? forType : all;
  }, [ratePlanData, prefill?.roomTypeId]);

  useEffect(() => {
    if (!open) {
      setGuest(null);
      setRatePlanId('');
      setAdults(1);
      setChildren(0);
      setSpecialRequests('');
    }
  }, [open]);

  useEffect(() => {
    if (open && !ratePlanId && ratePlans.length) setRatePlanId(ratePlans[0].id);
  }, [open, ratePlanId, ratePlans]);

  const quote = useMemo(() => {
    if (!prefill) return null;
    const nights = stayNightKeys(prefill.checkInDate, prefill.checkOutDate);
    return computeStayQuote(
      nights,
      categoryFromRoomTypeName(prefill.roomTypeName),
      DEFAULT_PRICING_SETTINGS,
      propertyClock(new Date(), timezone),
      demandByDate,
    );
  }, [prefill, demandByDate, timezone]);

  const createMutation = useMutation({
    mutationFn: async () => {
      requirePropertyId(propertyId);
      requireCurrency(currencyCode);
      if (!prefill) throw new Error('Nothing selected');
      if (!guest?.id) throw new Error(t('reservations.tape.guestRequired'));
      if (!ratePlanId) throw new Error(t('reservations.tape.ratePlanRequired'));

      const res = await api.post('/v1/reservations', {
        propertyId,
        guestId: guest.id,
        roomTypeId: prefill.roomTypeId,
        ratePlanId,
        arrivalDate: prefill.checkInDate,
        departureDate: prefill.checkOutDate,
        adults,
        children,
        totalAmount: moneyString(quote?.total ?? 0),
        currencyCode,
        source: 'direct',
        ...(specialRequests.trim() ? { specialRequests: specialRequests.trim() } : {}),
      });
      const id: string | undefined = res.data?.id ?? res.data?.data?.id;
      if (!id) return { id: undefined };

      await api.patch(`/v1/reservations/${id}/confirm`, {}, { params: { propertyId } });
      // The room came from the row the user dragged on, so honour it rather
      // than leaving the booking for the unassigned queue to place.
      await api.patch(
        `/v1/reservations/${id}/assign-room`,
        { roomId: prefill.roomId },
        { params: { propertyId } },
      );
      return { id };
    },
    onSuccess: ({ id }) => {
      queryClient.invalidateQueries({ queryKey: ['reservations'] });
      queryClient.invalidateQueries({ queryKey: ['rooms'] });
      toast('success', t('reservations.tape.created', { room: prefill?.roomNumber ?? '' }));
      if (id) onCreated?.(id);
      onClose();
    },
    onError: (error: unknown) => {
      toast('error', error instanceof Error ? error.message : t('errors.Request failed'));
    },
  });

  const nightCount = quote?.nights.length ?? 0;

  return (
    <Modal
      open={open && !!prefill}
      onClose={onClose}
      title={t('reservations.tape.createTitle', { room: prefill?.roomNumber ?? '' })}
      wide
    >
      {prefill && (
        <div className="space-y-4">
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
                {formatMoney(quote?.total, currencyCode)}
              </span>
            </div>
            <ul className="max-h-40 overflow-y-auto divide-y divide-gray-50">
              {quote?.nights.map((night) => (
                <li key={night.date} className="flex items-center justify-between px-3 py-1.5 text-xs">
                  <span className="text-telivity-slate">
                    {format(new Date(`${night.date}T00:00:00`), 'EEE, d MMM', { locale: dateLocale })}
                    {night.intradayApplied && (
                      <span className="ml-2 font-semibold text-telivity-orange">
                        {t('reservations.tape.eveningDiscount')}
                      </span>
                    )}
                  </span>
                  <span className="font-medium text-telivity-navy">
                    {formatMoney(night.finalPrice, currencyCode)}
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

          <div className="flex gap-3">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 border border-gray-200 text-telivity-slate rounded-lg px-4 py-2 text-sm font-semibold"
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              onClick={() => createMutation.mutate()}
              disabled={!guest || !ratePlanId || createMutation.isPending}
              className="flex-1 bg-telivity-teal text-white rounded-lg px-4 py-2 text-sm font-semibold hover:bg-telivity-light-teal disabled:opacity-50"
            >
              {createMutation.isPending
                ? t('common.creating')
                : t('reservations.tape.confirmCreate', {
                    total: formatMoney(quote?.total, currencyCode),
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

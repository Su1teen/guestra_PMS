import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2, Plus, Trash2, Users } from 'lucide-react';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/error-message';
import { formatMoney } from '../../lib/money';
import { useProperty } from '../../context/PropertyContext';
import { useAuth } from '../../context/AuthContext';
import { useBookingPolicy } from '../../hooks/useBookingPolicy';
import { defaultDeposit, defaultOptionUntil, partyComplete, type Party } from '../../lib/booking';
import Modal from '../ui/Modal';
import { useToast } from '../ui/Toast';
import FindGuest from '../guests/FindGuest';
import PartyInput from './PartyInput';
import BookingStartOptions, { initialStartOptions, startOptionsPayload, startOptionsValid, type StartOptions } from './BookingStartOptions';
import GuestDocumentPanel from './GuestDocumentPanel';
import type { Guest } from '../../types/guest';

interface Line { key: string; roomTypeId: string; ratePlanId: string; quantity: number; party: Party }
interface RoomType { id: string; name: string; maxOccupancy?: number }
interface RatePlan { id: string; name: string; roomTypeId: string; isActive?: boolean }
interface GroupQuote {
  currency: string | null; nights: number; totalAmount: string; available: boolean;
  shortages: Array<{ roomTypeId: string; requested: number; available: number }>;
  lines: Array<{ roomTypeId: string; ratePlanId: string; quantity: number; lineTotal: string; perRoom: { totalAmount: string } }>;
}

const newLine = (): Line => ({ key: crypto.randomUUID(), roomTypeId: '', ratePlanId: '', quantity: 1, party: { adults: 2, children: 0, childAges: [] } });

/**
 * Group booking: one confirmation number for several rooms of one or more categories.
 * Every line is "category × rooms × tariff × guests per room"; the group is priced canonically,
 * shortages are shown before booking, and the whole group is created all-or-nothing.
 */
export default function GroupBookingModal({ open, onClose, initialCheckIn, initialCheckOut }: {
  open: boolean; onClose: () => void; initialCheckIn?: string; initialCheckOut?: string;
}) {
  const { t } = useTranslation();
  const { propertyId, currencyCode } = useProperty();
  const { hasPermission } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const policy = useBookingPolicy(propertyId, open).data;
  const requestId = useRef(crypto.randomUUID());

  const [guest, setGuest] = useState<Guest | null>(null);
  const [groupName, setGroupName] = useState('');
  const [profileId, setProfileId] = useState('');
  const [checkIn, setCheckIn] = useState(initialCheckIn ?? '');
  const [checkOut, setCheckOut] = useState(initialCheckOut ?? '');
  const [lines, setLines] = useState<Line[]>([newLine()]);
  const [start, setStart] = useState<StartOptions>(initialStartOptions);
  const [notes, setNotes] = useState('');
  const [created, setCreated] = useState<{ reservationId: string; confirmationNumber: string; rooms: number } | null>(null);
  const touched = useRef(false);

  useEffect(() => {
    if (!open) return;
    requestId.current = crypto.randomUUID();
    setGuest(null); setGroupName(''); setProfileId(''); setLines([newLine()]); setStart(initialStartOptions()); setNotes(''); setCreated(null);
    setCheckIn(initialCheckIn ?? ''); setCheckOut(initialCheckOut ?? '');
    touched.current = false;
  }, [open, initialCheckIn, initialCheckOut]);

  const typesQuery = useQuery<RoomType[]>({ queryKey: ['room-types', propertyId], enabled: open && !!propertyId,
    queryFn: () => api.get('/v1/rooms/types', { params: { propertyId } }).then((r) => r.data?.data ?? r.data ?? []) });
  const plansQuery = useQuery<RatePlan[]>({ queryKey: ['rate-plans', propertyId], enabled: open && !!propertyId,
    queryFn: () => api.get('/v1/rate-plans', { params: { propertyId } }).then((r) => r.data?.data ?? r.data ?? []) });
  const profilesQuery = useQuery<Array<{ id: string; name: string }>>({ queryKey: ['group-profiles', propertyId, 'active'], enabled: open && !!propertyId,
    queryFn: () => api.get('/v1/groups/profiles', { params: { propertyId, limit: 100 }, skipErrorToast: true }).then((r) => r.data?.data ?? r.data ?? []) });
  const types = typesQuery.data ?? [];
  const plans = (plansQuery.data ?? []).filter((p) => p.isActive !== false);

  const update = (key: string, patch: Partial<Line>) => setLines((all) => all.map((l) => {
    if (l.key !== key) return l;
    const next = { ...l, ...patch };
    if (patch.roomTypeId !== undefined && patch.roomTypeId !== l.roomTypeId) next.ratePlanId = plans.find((p) => p.roomTypeId === patch.roomTypeId)?.id ?? '';
    return next;
  }));

  const linesReady = lines.every((l) => l.roomTypeId && l.ratePlanId && l.quantity > 0 && partyComplete(l.party));
  const datesReady = !!checkIn && !!checkOut && checkOut > checkIn;
  const payloadLines = lines.map((l) => ({ roomTypeId: l.roomTypeId, ratePlanId: l.ratePlanId, quantity: l.quantity, adults: l.party.adults,
    ...(l.party.childAges.length ? { childAges: l.party.childAges } : { children: l.party.children }) }));
  const quoteKey = JSON.stringify([checkIn, checkOut, payloadLines, guest?.id]);
  const quoteQuery = useQuery<GroupQuote>({
    queryKey: ['group-quote', propertyId, quoteKey],
    enabled: open && !!propertyId && linesReady && datesReady && !created,
    queryFn: () => api.post('/v1/reservations/quote/group', { propertyId, checkIn, checkOut, rooms: payloadLines, ...(guest?.id ? { guestId: guest.id } : {}) },
      { skipErrorToast: true }).then((r) => r.data?.data ?? r.data),
    staleTime: 0,
  });
  const quote = quoteQuery.data;
  const roomCount = lines.reduce((n, l) => n + l.quantity, 0);

  useEffect(() => {
    if (!open || touched.current || !policy) return;
    setStart((s) => ({ ...s, optionUntil: s.optionUntil || defaultOptionUntil(policy), requiredDeposit: defaultDeposit(policy, quote?.totalAmount) || s.requiredDeposit }));
  }, [open, policy, quote?.totalAmount]);

  const create = useMutation({
    mutationFn: async () => {
      if (!guest?.id || !quote) throw new Error(t('booking.group.incomplete'));
      const res = await api.post('/v1/reservations/group-booking', {
        propertyId, requestId: requestId.current, guestId: guest.id, groupName: groupName.trim(), ...(profileId ? { groupProfileId: profileId } : {}),
        checkIn, checkOut, rooms: payloadLines, expectedTotal: quote.totalAmount, currencyCode: quote.currency ?? currencyCode,
        ...startOptionsPayload(start), ...(notes.trim() ? { specialRequests: notes.trim() } : {}),
      }, { skipErrorToast: true });
      return res.data?.data ?? res.data;
    },
    onSuccess: (body: { booking: { confirmationNumber: string }; reservations: Array<{ id: string }> }) => {
      void queryClient.invalidateQueries({ queryKey: ['reservations'] });
      toast('success', t('booking.group.created', { count: body.reservations.length, number: body.booking.confirmationNumber }));
      setCreated({ reservationId: body.reservations[0]!.id, confirmationNumber: body.booking.confirmationNumber, rooms: body.reservations.length });
    },
    onError: (error) => {
      const code = (error as { response?: { data?: { code?: string } } })?.response?.data?.code;
      if (code === 'QUOTE_CHANGED') void quoteQuery.refetch();
      else requestId.current = crypto.randomUUID();
      toast('error', errorMessage(error));
    },
  });

  const typeName = useMemo(() => new Map(types.map((ty) => [ty.id, ty.name])), [types]);
  const canSubmit = !!guest && groupName.trim().length > 0 && linesReady && datesReady && !!quote && quote.available
    && !quoteQuery.isFetching && startOptionsValid(start) && !create.isPending && hasPermission('reservations.write');

  return (
    <Modal open={open} onClose={onClose} closeDisabled={create.isPending} xwide
      title={created ? t('booking.group.createdTitle', { number: created.confirmationNumber }) : t('booking.group.title')}>
      {created && propertyId ? (
        <div className="space-y-4">
          <div className="flex items-start gap-3 rounded-lg bg-emerald-50 p-4 text-emerald-950">
            <CheckCircle2 size={20} className="mt-0.5" />
            <p className="text-sm">{t('booking.group.createdHint', { count: created.rooms })}</p>
          </div>
          <GuestDocumentPanel reservationId={created.reservationId} propertyId={propertyId} canSend={hasPermission('reservations.write')} />
          <div className="flex justify-end"><button type="button" className="btn-secondary btn-lg" onClick={onClose}>{t('booking.done')}</button></div>
        </div>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <fieldset disabled={create.isPending} className="min-w-0 space-y-5">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block sm:col-span-2">
                <span className="label">{t('booking.group.name')}</span>
                <input className="field" value={groupName} onChange={(e) => setGroupName(e.target.value)} placeholder={t('booking.group.namePlaceholder')} />
              </label>
              <label className="block">
                <span className="label">{t('booking.group.checkIn')}</span>
                <input type="date" className="field" value={checkIn} onChange={(e) => setCheckIn(e.target.value)} />
              </label>
              <label className="block">
                <span className="label">{t('booking.group.checkOut')}</span>
                <input type="date" className="field" value={checkOut} min={checkIn} onChange={(e) => setCheckOut(e.target.value)} />
              </label>
              <label className="block sm:col-span-2">
                <span className="label">{t('booking.group.company')}</span>
                <select className="field" value={profileId} onChange={(e) => setProfileId(e.target.value)}>
                  <option value="">{t('booking.group.noCompany')}</option>
                  {(profilesQuery.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
            </div>

            <div>
              <p className="label">{t('booking.group.contact')}</p>
              <FindGuest selectedGuest={guest} onSelectGuest={setGuest} />
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-telivity-navy">{t('booking.group.rooms', { count: roomCount })}</p>
                <button type="button" className="btn-secondary min-h-0 py-1.5" onClick={() => setLines((l) => [...l, newLine()])} disabled={lines.length >= 20}>
                  <Plus size={16} />{t('booking.group.addLine')}
                </button>
              </div>
              {lines.map((line, index) => {
                const quoted = quote?.lines[index];
                const shortage = quote?.shortages.find((s) => s.roomTypeId === line.roomTypeId);
                const type = types.find((ty) => ty.id === line.roomTypeId);
                return (
                  <div key={line.key} className={`card p-3 ${shortage ? 'border-red-300' : ''}`}>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1.3fr)_90px_auto]">
                      <label className="block">
                        <span className="label">{t('booking.group.category')}</span>
                        <select className="field" value={line.roomTypeId} onChange={(e) => update(line.key, { roomTypeId: e.target.value })}>
                          <option value="">{t('booking.group.selectCategory')}</option>
                          {types.map((ty) => <option key={ty.id} value={ty.id}>{ty.name}</option>)}
                        </select>
                      </label>
                      <label className="block">
                        <span className="label">{t('reservations.ratePlan')}</span>
                        <select className="field" value={line.ratePlanId} onChange={(e) => update(line.key, { ratePlanId: e.target.value })} disabled={!line.roomTypeId}>
                          {plans.filter((p) => p.roomTypeId === line.roomTypeId).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </select>
                      </label>
                      <label className="block">
                        <span className="label">{t('booking.group.quantity')}</span>
                        <input type="number" min={1} max={50} className="field tabular-nums" value={line.quantity || ''}
                          onChange={(e) => update(line.key, { quantity: Math.max(0, Math.min(50, Math.trunc(Number(e.target.value)) || 0)) })}
                          onBlur={() => { if (line.quantity < 1) update(line.key, { quantity: 1 }); }} />
                      </label>
                      <div className="flex items-end">
                        <button type="button" className="btn-ghost px-3" aria-label={t('booking.group.removeLine')} disabled={lines.length === 1}
                          onClick={() => setLines((l) => l.filter((x) => x.key !== line.key))}><Trash2 size={16} /></button>
                      </div>
                    </div>
                    <div className="mt-3">
                      <p className="label">{t('booking.group.perRoom')}</p>
                      <PartyInput compact value={line.party} onChange={(party) => update(line.key, { party })} bands={policy?.childAgeBands} maxGuests={type?.maxOccupancy} />
                    </div>
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-sm">
                      {shortage ? (
                        <span className="flex items-center gap-1 text-red-700"><AlertTriangle size={14} />{t('booking.group.shortage', { available: shortage.available, requested: shortage.requested })}</span>
                      ) : <span className="text-telivity-mid-grey">{typeName.get(line.roomTypeId) ?? ''}</span>}
                      {quoted && <span className="tabular-nums text-telivity-navy">{formatMoney(quoted.perRoom.totalAmount, quote?.currency)} × {line.quantity} = <strong>{formatMoney(quoted.lineTotal, quote?.currency)}</strong></span>}
                    </div>
                  </div>
                );
              })}
            </div>

            <BookingStartOptions value={start} onChange={(v) => { touched.current = true; setStart(v); }} policy={policy} currency={currencyCode} guestHasEmail={!!guest?.email} />

            <label className="block">
              <span className="label">{t('booking.group.notes')}</span>
              <textarea className="field" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </label>
          </fieldset>

          <aside className="space-y-3 lg:sticky lg:top-0 lg:self-start">
            <section className="card p-4">
              <p className="flex items-center gap-2 text-sm font-semibold text-telivity-navy"><Users size={16} />{t('booking.group.summary')}</p>
              <dl className="mt-3 space-y-1.5 text-sm">
                <div className="flex justify-between"><dt className="text-telivity-slate">{t('booking.group.roomsLabel')}</dt><dd className="tabular-nums">{roomCount}</dd></div>
                <div className="flex justify-between"><dt className="text-telivity-slate">{t('booking.group.guestsLabel')}</dt>
                  <dd className="tabular-nums">{lines.reduce((n, l) => n + (l.party.adults + l.party.children) * l.quantity, 0)}</dd></div>
                <div className="flex justify-between"><dt className="text-telivity-slate">{t('booking.nightsLabel')}</dt><dd className="tabular-nums">{quote?.nights ?? '—'}</dd></div>
              </dl>
              <div className="mt-3 flex items-baseline justify-between border-t border-gray-100 pt-3">
                <span className="text-sm font-semibold">{t('booking.group.total')}</span>
                <span className="text-xl font-semibold tabular-nums">{quote ? formatMoney(quote.totalAmount, quote.currency) : '—'}</span>
              </div>
              {quoteQuery.isFetching && <p role="status" className="mt-2 text-xs text-telivity-mid-grey">{t('booking.pricing')}</p>}
              {quoteQuery.isError && <p role="alert" className="mt-2 text-sm text-red-700">{errorMessage(quoteQuery.error)}</p>}
              {!linesReady && <p className="mt-2 text-xs text-telivity-mid-grey">{t('booking.group.fillLines')}</p>}
              {quote && !quote.available && <p className="mt-2 text-sm text-red-700">{t('booking.group.notAvailable')}</p>}
            </section>
            <button type="button" className="btn-primary btn-lg w-full" disabled={!canSubmit} onClick={() => create.mutate()}>
              {create.isPending ? t('common.creating') : t('booking.group.create', { count: roomCount })}
            </button>
            <button type="button" className="btn-ghost w-full" onClick={onClose} disabled={create.isPending}>{t('common.cancel')}</button>
          </aside>
        </div>
      )}
    </Modal>
  );
}

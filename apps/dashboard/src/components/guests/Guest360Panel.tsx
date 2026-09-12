import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, CircleDollarSign, Clock3, HeartHandshake, Merge, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { formatMoney } from '../../lib/money';
import Modal from '../ui/Modal';
import StatusBadge from '../ui/StatusBadge';
import type { Guest } from '../../types/guest';

type Guest360 = {
  guest: Guest;
  summary: {
    totalStays: number;
    firstStay: string | null;
    lastStay: string | null;
    propertiesVisited: string[];
    currentOrUpcoming: any | null;
    currencyCode: string | null;
    roomRevenue: number;
    ancillaryRevenue: number;
    totalRevenue: number;
    averageSpendPerStay: number;
  };
  stays: Array<any>;
  services: Array<any>;
  timeline: Array<any>;
};

export default function Guest360Panel({ data, propertyId }: { data: Guest360; propertyId: string }) {
  const { i18n } = useTranslation();
  const ru = i18n.language.startsWith('ru');
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<'overview' | 'stays' | 'services' | 'preferences' | 'history'>('overview');
  const [compare, setCompare] = useState<Guest | null>(null);
  const { guest, summary } = data;
  const { data: duplicates = [] } = useQuery<Guest[]>({
    queryKey: ['guest-duplicates', guest.id, propertyId],
    queryFn: () => api.get(`/v1/guests/${guest.id}/duplicates`, { params: { propertyId } }).then((r) => r.data),
  });
  const mergeMutation = useMutation({
    mutationFn: (targetGuestId: string) => api.post(`/v1/guests/${guest.id}/merge`, {
      propertyId, targetGuestId, confirmed: true,
    }),
    onSuccess: (_, targetGuestId) => {
      queryClient.invalidateQueries({ queryKey: ['guests'] });
      window.location.assign(`/guests/${targetGuestId}`);
    },
  });

  const tabs = [
    ['overview', ru ? 'Обзор' : 'Overview'],
    ['stays', ru ? 'Проживания' : 'Stays'],
    ['services', ru ? 'Услуги и расходы' : 'Services & spend'],
    ['preferences', ru ? 'Предпочтения' : 'Preferences'],
    ['history', ru ? 'История' : 'History'],
  ] as const;

  return (
    <section className="mb-6 space-y-4">
      {duplicates.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 flex flex-wrap items-center gap-3">
          <Merge size={18} className="text-amber-700" />
          <div className="flex-1">
            <p className="text-sm font-semibold text-amber-900">{ru ? 'Возможный дубликат' : 'Possible duplicate'}</p>
            <p className="text-xs text-amber-800">{duplicates.map((d) => `${d.firstName} ${d.lastName}`).join(', ')}</p>
          </div>
          <button onClick={() => setCompare(duplicates[0]!)} className="rounded-lg bg-white border border-amber-300 px-3 py-1.5 text-xs font-semibold text-amber-900">
            {ru ? 'Сравнить' : 'Compare'}
          </button>
        </div>
      )}

      <div className="rounded-xl bg-white shadow-sm overflow-hidden">
        <div className="flex overflow-x-auto border-b border-gray-100 px-3">
          {tabs.map(([key, label]) => (
            <button key={key} onClick={() => setTab(key)} className={`px-4 py-3 text-sm whitespace-nowrap border-b-2 ${tab === key ? 'border-telivity-teal text-telivity-teal font-semibold' : 'border-transparent text-telivity-slate'}`}>
              {label}
            </button>
          ))}
        </div>

        <div className="p-5">
          {tab === 'overview' && (
            <div className="space-y-5">
              <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
                <Mini icon={CalendarDays} label={ru ? 'Проживаний' : 'Stays'} value={summary.totalStays} />
                <Mini icon={CircleDollarSign} label={ru ? 'Доход от номеров' : 'Room revenue'} value={formatMoney(summary.roomRevenue, summary.currencyCode)} />
                <Mini icon={Sparkles} label={ru ? 'Доп. услуги' : 'Ancillary'} value={formatMoney(summary.ancillaryRevenue, summary.currencyCode)} />
                <Mini icon={CircleDollarSign} label="LTV" value={formatMoney(summary.totalRevenue, summary.currencyCode)} />
                <Mini icon={HeartHandshake} label={ru ? 'Средний чек / визит' : 'Average / stay'} value={formatMoney(summary.averageSpendPerStay, summary.currencyCode)} />
              </div>
              <div className="grid md:grid-cols-3 gap-4 text-sm">
                <Info label={ru ? 'Первое проживание' : 'First stay'} value={summary.firstStay ?? '—'} />
                <Info label={ru ? 'Последнее проживание' : 'Last stay'} value={summary.lastStay ?? '—'} />
                <Info label={ru ? 'Объекты сети' : 'Properties visited'} value={summary.propertiesVisited.join(', ') || '—'} />
              </div>
              {summary.currentOrUpcoming && (
                <div className="rounded-lg border border-telivity-teal/30 bg-telivity-teal/5 p-4">
                  <p className="text-xs uppercase font-semibold text-telivity-teal">{ru ? 'Текущее / ближайшее бронирование' : 'Current / upcoming reservation'}</p>
                  <p className="mt-1 text-sm font-semibold text-telivity-navy">{summary.currentOrUpcoming.propertyName} · {summary.currentOrUpcoming.arrivalDate} → {summary.currentOrUpcoming.departureDate}</p>
                </div>
              )}
            </div>
          )}

          {tab === 'stays' && <div className="space-y-3">{data.stays.map((stay) => (
            <a key={stay.id} href={`/reservations/${stay.id}`} className="block rounded-lg border border-gray-100 p-4 hover:border-telivity-teal/40">
              <div className="flex gap-3 items-center"><p className="font-semibold text-telivity-navy">{stay.propertyName}</p><StatusBadge status={stay.status} /></div>
              <p className="text-xs text-telivity-slate mt-1">{stay.arrivalDate} → {stay.departureDate} · {stay.nights} {ru ? 'ноч.' : 'nights'} · {stay.roomNumber ?? '—'} · {stay.roomType ?? '—'} · {stay.ratePlan ?? '—'}</p>
              <p className="text-sm font-semibold text-telivity-navy mt-2">{formatMoney(stay.totalRevenue, stay.currencyCode)}</p>
            </a>
          ))}{data.stays.length === 0 && <Empty text={ru ? 'Проживаний пока нет' : 'No stays yet'} />}</div>}

          {tab === 'services' && <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="text-left text-xs text-telivity-mid-grey border-b"><th className="py-2">{ru ? 'Дата' : 'Date'}</th><th>{ru ? 'Услуга' : 'Service'}</th><th>{ru ? 'Объект' : 'Property'}</th><th className="text-right">{ru ? 'Сумма' : 'Amount'}</th></tr></thead><tbody>{data.services.map((s) => <tr key={s.id} className="border-b border-gray-50"><td className="py-3">{new Date(s.date).toLocaleDateString()}</td><td><p className="font-medium text-telivity-navy">{s.description}</p><p className="text-xs text-telivity-mid-grey">{s.type}</p></td><td>{s.propertyName ?? '—'}</td><td className="text-right font-semibold">{formatMoney(s.amount, s.currencyCode)}</td></tr>)}</tbody></table>{data.services.length === 0 && <Empty text={ru ? 'Дополнительных услуг пока нет' : 'No ancillary services yet'} />}</div>}

          {tab === 'preferences' && <div className="grid md:grid-cols-2 gap-3">{Object.entries(guest.preferences ?? {}).map(([key, value]) => <Info key={key} label={key.replace(/_/g, ' ')} value={String(value)} />)}{Object.keys(guest.preferences ?? {}).length === 0 && <Empty text={ru ? 'Предпочтения не указаны' : 'No preferences recorded'} />}</div>}

          {tab === 'history' && <div className="space-y-3">{data.timeline.map((item) => <div key={item.id} className="flex gap-3"><Clock3 size={15} className="mt-0.5 text-telivity-teal"/><div><p className="text-sm text-telivity-navy">{item.description ?? `${item.action} · ${item.entityType}`}</p><p className="text-xs text-telivity-mid-grey">{new Date(item.occurredAt).toLocaleString()} · {item.userEmail ?? (ru ? 'Система' : 'System')}</p></div></div>)}{data.timeline.length === 0 && <Empty text={ru ? 'История пока пуста' : 'No history yet'} />}</div>}
        </div>
      </div>

      <Modal open={!!compare} onClose={() => setCompare(null)} title={ru ? 'Сравнение профилей' : 'Compare profiles'}>
        {compare && <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            {[guest, compare].map((g) => <div key={g.id} className="rounded-lg border p-3 space-y-2"><p className="font-semibold">{g.firstName} {g.lastName}</p><Info label="Email" value={g.email ?? '—'} /><Info label={ru ? 'Телефон' : 'Phone'} value={g.phone ?? '—'} /><Info label="VIP" value={g.vipLevel ?? 'none'} /><Info label={ru ? 'Лояльность' : 'Loyalty'} value={g.loyaltyNumber ?? '—'} /></div>)}
          </div>
          <p className="text-xs text-amber-800 bg-amber-50 p-3 rounded-lg">{ru ? 'Бронирования, фолио, услуги, задачи, предпочтения и история будут сохранены. Исходный профиль станет архивной записью с трассировкой слияния.' : 'Reservations, folios, services, tasks, preferences and audit history are preserved. The source becomes a merge tombstone.'}</p>
          <div className="flex justify-end gap-2"><button onClick={() => setCompare(null)} className="border rounded-lg px-4 py-2 text-sm">{ru ? 'Отмена' : 'Cancel'}</button><button disabled={mergeMutation.isPending} onClick={() => mergeMutation.mutate(compare.id)} className="bg-telivity-teal text-white rounded-lg px-4 py-2 text-sm font-semibold">{ru ? 'Объединить в выбранный профиль' : 'Merge into selected profile'}</button></div>
        </div>}
      </Modal>
    </section>
  );
}

function Mini({ icon: Icon, label, value }: { icon: typeof CalendarDays; label: string; value: string | number }) { return <div className="rounded-lg bg-gray-50 p-3"><Icon size={16} className="text-telivity-teal"/><p className="mt-2 text-xs text-telivity-mid-grey">{label}</p><p className="text-base font-semibold text-telivity-navy">{value}</p></div>; }
function Info({ label, value }: { label: string; value: string }) { return <div><p className="text-xs text-telivity-mid-grey">{label}</p><p className="text-sm font-medium text-telivity-navy break-words">{value}</p></div>; }
function Empty({ text }: { text: string }) { return <p className="py-6 text-center text-sm text-telivity-mid-grey">{text}</p>; }

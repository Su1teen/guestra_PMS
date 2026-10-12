import { useState } from 'react';
import { Link, Routes, Route, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { BadgeDollarSign, Plus, ChevronLeft } from 'lucide-react';
import { api } from '../lib/api';
import { moneyString, requirePropertyId, requireCurrency } from '../lib/api-helpers';
import { useProperty } from '../context/PropertyContext';
import StatusBadge from '../components/ui/StatusBadge';
import Modal from '../components/ui/Modal';
import { useTranslation } from 'react-i18next';
import RatePlanCalendar from '../components/rates/RatePlanCalendar';
import { formatMoney } from '../lib/money';
import RevenueWorkspaceNav from '../components/revenue/RevenueWorkspaceNav';
import LiveRateWorkflow, { PreviewTable } from '../components/revenue/LiveRateWorkflow';
import { useOperationalDate } from '../hooks/useOperationalDate';
import { useAuth } from '../context/AuthContext';
import { propertyHref } from '../lib/navigation';
import { pricingError, unwrap, type PendingPricingRequest, type LiveChange, type LivePreview } from '../lib/live-revenue';

interface RatePlan {
  id: string;
  name: string;
  code: string;
  type: string;
  roomTypeId?: string;
  roomTypeName?: string;
  baseAmount?: number;
  currency?: string;
  currencyCode?: string;
  parentRatePlanId?: string;
  derivedAdjustmentType?: string;
  derivedAdjustmentValue?: string | number;
  derivationRule?: { type: string; value: number };
  isActive?: boolean;
}

interface RateRestriction {
  id: string;
  startDate: string;
  endDate: string;
  minLos?: number | null;
  maxLos?: number | null;
  closedToArrival?: boolean;
  closedToDeparture?: boolean;
  isClosed?: boolean;
  dayOfWeekOverrides?: Record<string, number> | null;
  rateOverride?: string | number | null;
  overrideReason?: string | null;
}

// ---- Rate Plan List ----
function RatePlanList() {
  const { t, i18n } = useTranslation();
  const { propertyId, currencyCode } = useProperty();
  const { hasPermission } = useAuth();
  const canManage = hasPermission('rateplans.manage');
  const ru = i18n.language.startsWith('ru');
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [type, setType] = useState('bar');
  const [baseAmount, setBaseAmount] = useState('');
  const [roomTypeId, setRoomTypeId] = useState('');
  const [parentRatePlanId, setParentRatePlanId] = useState('');
  const [derivedAdjustmentType, setDerivedAdjustmentType] = useState('percentage');
  const [derivedAdjustmentValue, setDerivedAdjustmentValue] = useState('');
  const [reason, setReason] = useState('');
  const operational = useOperationalDate(propertyId, hasPermission('reports.view'));
  const [previewDate, setPreviewDate] = useState('');
  const [creation, setCreation] = useState<{ change: LiveChange; preview: LivePreview; fingerprint: string } | null>(null);
  const date = previewDate || operational.data?.date || '';
  const creationValues = { name: name.trim(), code: code.trim(), type, baseAmount: baseAmount || '0', roomTypeId, currencyCode,
    ...(type === 'derived' ? { parentRatePlanId, derivedAdjustmentType, derivedAdjustmentValue } : {}) };
  const fingerprint = JSON.stringify([creationValues, date, reason.trim()]);
  const validPreview = creation?.fingerprint === fingerprint ? creation : null;
  const previewCreation = useMutation({
    mutationFn: async () => {
      requirePropertyId(propertyId); requireCurrency(currencyCode);
      const change: LiveChange = { propertyId, requestId: crypto.randomUUID(), expectedRevision: 0, reason: reason.trim(), kind: 'plan_create',
        createPlan: { ...creationValues, baseAmount: moneyString(baseAmount || '0') }, startDate: date, endDate: date };
      const preview = await api.post('/v1/rate-plans/live-preview', change).then(r => unwrap<LivePreview>(r.data));
      return { change, preview, fingerprint };
    },
    onSuccess: setCreation,
  });

  const planQuery = useQuery({
    queryKey: ['rate-plans', propertyId],
    queryFn: () => api.get('/v1/rate-plans', { params: { propertyId } }).then((r) => r.data),
    enabled: !!propertyId && hasPermission('rateplans.read'),
  });

  const { data: typesData } = useQuery({
    queryKey: ['rooms', 'types', propertyId],
    queryFn: () => api.get('/v1/rooms/types', { params: { propertyId } }).then((r) => r.data),
    enabled: !!propertyId && hasPermission('rooms.read'),
  });

  const plans: RatePlan[] = planQuery.data?.data ?? planQuery.data ?? [];
  const roomTypes = typesData?.data ?? typesData ?? [];

  const createPlan = async (send: (request: PendingPricingRequest) => Promise<boolean>) => {
    requirePropertyId(propertyId);
    requireCurrency(currencyCode);
    if (!validPreview) return;
    const payload = { ...validPreview.change, stateToken: validPreview.preview.stateToken };
    if (await send({ propertyId, requestId: payload.requestId, path: '/v1/rate-plans/rate-changes', body: payload })) {
      setName(''); setCode(''); setType('bar'); setBaseAmount(''); setRoomTypeId('');
      setParentRatePlanId(''); setDerivedAdjustmentType('percentage'); setDerivedAdjustmentValue(''); setReason('');
      setCreation(null); setCreateOpen(false);
    }
  };

  const derivedReady =
    type !== 'derived' || (!!parentRatePlanId && derivedAdjustmentValue !== '');

  if (!propertyId) return <div className="flex items-center justify-center h-64 text-telivity-mid-grey">{t('ratePlans.selectProperty')}</div>;

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <BadgeDollarSign size={24} className="text-telivity-teal" />
        <h1 className="text-2xl font-semibold text-telivity-navy">{t('ratePlans.title')}</h1>
        {canManage && <button onClick={() => setCreateOpen(true)} className="ml-auto flex items-center gap-2 bg-telivity-teal text-white rounded-lg px-4 py-2 text-sm font-semibold">
          <Plus size={16} /> {t('ratePlans.new')}
        </button>}
      </div>

      {planQuery.isPending && <p role="status">{t('common.loading')}</p>}
      {planQuery.isError && <p role="alert">{pricingError(planQuery.error, ru)} <button type="button" onClick={() => void planQuery.refetch()}>{ru ? 'Повторить' : 'Retry'}</button></p>}
      <div className="bg-white rounded-xl shadow-sm overflow-auto">
        <table className="w-full">
          <thead>
            <tr className="bg-telivity-teal/5 border-b border-gray-100">
              <th className="px-4 py-3 text-left text-xs font-semibold text-telivity-slate uppercase">{t('common.name')}</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-telivity-slate uppercase">{t('ratePlans.code')}</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-telivity-slate uppercase">{t('ratePlans.type')}</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-telivity-slate uppercase">{t('ratePlans.roomType')}</th>
              <th className="px-4 py-3 text-right text-xs font-semibold text-telivity-slate uppercase">{t('ratePlans.baseRate')}</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-telivity-slate uppercase">{t('common.status')}</th>
            </tr>
          </thead>
          <tbody>
            {plans.map((p, i) => (
              <tr key={p.id} className={`border-b border-gray-50 hover:bg-telivity-light-grey/50 ${i % 2 === 1 ? 'bg-gray-50/50' : ''}`}>
                <td className="px-4 py-3 text-sm font-medium text-telivity-navy"><Link to={propertyHref(`/rate-plans/${p.id}`, propertyId)}>{p.name}</Link></td>
                <td className="px-4 py-3 text-sm text-telivity-slate">{p.code}</td>
                <td className="px-4 py-3"><StatusBadge status={p.type === 'bar' ? 'info' : p.type === 'derived' ? 'warning' : 'success'} label={p.type} /></td>
                <td className="px-4 py-3 text-sm text-telivity-slate">{p.roomTypeName ?? '—'}</td>
                <td className="px-4 py-3 text-sm text-right font-medium whitespace-nowrap tabular-nums">{p.baseAmount != null ? formatMoney(p.baseAmount, currencyCode) : '—'}</td>
                <td className="px-4 py-3"><StatusBadge status={p.isActive !== false ? 'success' : 'completed'} label={p.isActive !== false ? t('common.active') : t('common.inactive')} /></td>
              </tr>
            ))}
            {plans.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-sm text-telivity-mid-grey">{t('ratePlans.empty')}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <LiveRateWorkflow propertyId={propertyId} section="overview" editRate={null} onCloseEditor={() => setCreateOpen(false)} plans={[]} createControl={(send, busy) => <Modal open={createOpen} onClose={() => setCreateOpen(false)} title={t('ratePlans.new')} wide>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div><label className="block text-xs font-medium text-telivity-mid-grey mb-1">{t('ratePlans.nameRequired')}</label><input type="text" value={name} onChange={(e) => setName(e.target.value)} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-telivity-teal" /></div>
            <div><label className="block text-xs font-medium text-telivity-mid-grey mb-1">{t('ratePlans.codeRequired')}</label><input type="text" value={code} onChange={(e) => setCode(e.target.value)} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-telivity-teal" /></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-telivity-mid-grey mb-1">{t('ratePlans.type')}</label>
              <select value={type} onChange={(e) => setType(e.target.value)} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-telivity-teal">
                <option value="bar">BAR</option><option value="derived">{t('legacy.derived')}</option><option value="negotiated">{t('legacy.negotiated')}</option><option value="package">{t('legacy.package')}</option>
              </select>
            </div>
            <div><label className="block text-xs font-medium text-telivity-mid-grey mb-1">{t('ratePlans.baseAmount')}</label><input type="number" step="0.01" value={baseAmount} onChange={(e) => setBaseAmount(e.target.value)} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-telivity-teal" /></div>
          </div>
          <div>
            <label className="block text-xs font-medium text-telivity-mid-grey mb-1">{t('ratePlans.roomType')}</label>
            <select value={roomTypeId} onChange={(e) => setRoomTypeId(e.target.value)} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-telivity-teal">
              <option value="">{t('ratePlans.select')}</option>
              {(roomTypes as { id: string; name: string }[]).map((rt) => <option key={rt.id} value={rt.id}>{rt.name}</option>)}
            </select>
          </div>
          {type === 'derived' && (
            <div className="space-y-3 border-t border-gray-100 pt-3">
              <div>
                <label className="block text-xs font-medium text-telivity-mid-grey mb-1">{t('ratePlans.parentRatePlan')}</label>
                <select value={parentRatePlanId} onChange={(e) => setParentRatePlanId(e.target.value)} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-telivity-teal">
                  <option value="">{t('ratePlans.select')}</option>
                  {plans.filter((p) => p.type !== 'derived').map((p) => (
                    <option key={p.id} value={p.id}>{p.name} ({p.code})</option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-telivity-mid-grey mb-1">{t('ratePlans.adjustmentType')}</label>
                  <select value={derivedAdjustmentType} onChange={(e) => setDerivedAdjustmentType(e.target.value)} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-telivity-teal">
                    <option value="percentage">{t('ratePlans.percentage')}</option>
                    <option value="fixed">{t('ratePlans.fixed')}</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-telivity-mid-grey mb-1">{t('ratePlans.adjustmentValue')}</label>
                  <input type="text" value={derivedAdjustmentValue} onChange={(e) => setDerivedAdjustmentValue(e.target.value)} placeholder="-10.00" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-telivity-teal" />
                </div>
              </div>
            </div>
          )}
          <label className="block text-xs">{ru ? 'Обязательная причина создания' : 'Required creation reason'}<textarea className="w-full rounded-lg border px-3 py-2 text-sm" maxLength={1000} value={reason} onChange={e => setReason(e.target.value)} /></label>
          <label className="block text-xs">{ru ? 'Дата preview' : 'Preview date'}<input type="date" className="w-full rounded-lg border p-2" value={date} onChange={e => setPreviewDate(e.target.value)} /></label>
          <p className="text-xs">{ru ? 'Preview не создаёт продаваемый тариф. Предложение появится в очереди: отдельный approver при обязательном согласовании, затем Apply с новой проверкой. Без автоприменения.' : 'Preview creates no sellable plan. Submit adds a proposal to the queue: independent approver when required, then Apply revalidates it. No auto-apply.'}</p>
          {previewCreation.isError && <p role="alert">{pricingError(previewCreation.error, ru)}</p>}
          <button onClick={() => previewCreation.mutate()} disabled={!date || !name.trim() || !code.trim() || !roomTypeId || !derivedReady || !reason.trim() || !currencyCode || busy || previewCreation.isPending} className="w-full rounded-lg border p-2 disabled:opacity-50">{ru ? 'Preview создания' : 'Preview creation'}</button>
          {validPreview && <><p className="text-xs">{validPreview.preview.approvalRequired ? 'APPROVAL_REQUIRED' : 'PREVIEW_READY'} · acceptedPricesChanged=false</p><PreviewTable preview={validPreview.preview} /><button onClick={() => void createPlan(send)} disabled={busy || previewCreation.isPending} className="w-full bg-telivity-teal text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50">{ru ? 'Отправить предложение создания' : 'Submit creation proposal'}</button></>}
        </div>
      </Modal>} />
    </div>
  );
}

// Existing plans use the guarded preview/approval workflow.
function RestrictionsPanel({ ratePlanId }: { ratePlanId: string }) {
  const { propertyId, currencyCode } = useProperty();
  const { i18n } = useTranslation();
  const { hasPermission } = useAuth();
  const ru = i18n.language.startsWith('ru');
  const q = useQuery<RateRestriction[]>({
    queryKey: ['rate-plans', 'restrictions', propertyId, ratePlanId],
    queryFn: ({ signal }) => api.get(`/v1/rate-plans/${ratePlanId}/restrictions`, { params: { propertyId }, signal }).then(r => unwrap(r.data)),
    enabled: !!propertyId && hasPermission('rateplans.read'),
  });
  return <section className="rounded-xl bg-white p-4 shadow-sm space-y-3">
    <h2 className="font-semibold">{ru ? 'Ограничения продаж' : 'Sales restrictions'}</h2>
    <p className="text-xs">{ru ? 'Все изменения существующего плана проходят preview, проверку revision, согласование и аудит. Цены принятых броней не меняются.' : 'All existing-plan changes go through preview, revision checks, approval and audit. Accepted reservation prices are unchanged.'}</p>
    {hasPermission('rateplans.manage') && <Link className="inline-block rounded-lg border px-3 py-2 text-sm font-semibold" to={propertyHref(`/revenue?ratePlanId=${ratePlanId}`, propertyId)}>{ru ? 'Открыть Live: создать / изменить / удалить ограничение' : 'Open Live: create / edit / delete restriction'}</Link>}
    {q.isPending && <p role="status">{ru ? 'Загрузка…' : 'Loading…'}</p>}
    {q.isError && <p role="alert">{pricingError(q.error, ru)} <button type="button" onClick={() => void q.refetch()}>{ru ? 'Повторить' : 'Retry'}</button></p>}
    {q.data?.length === 0 && <p>{ru ? 'Ограничений нет.' : 'No restrictions.'}</p>}
    <div className="max-h-80 overflow-auto"><table className="w-full text-xs whitespace-nowrap"><thead className="sticky top-0 bg-gray-50"><tr>{[ru ? 'Даты' : 'Dates', 'Min / Max LOS', 'CTA / CTD / STOP', ru ? 'Цена override' : 'Override', ru ? 'Причина' : 'Reason', ru ? 'По дням недели' : 'Weekdays'].map(h => <th key={h} className="p-2 text-left">{h}</th>)}</tr></thead><tbody>{q.data?.map(r => <tr key={r.id} className="border-t"><td className="p-2">{r.startDate} — {r.endDate}</td><td className="p-2">{r.minLos ?? '—'} / {r.maxLos ?? '—'}</td><td className="p-2">{String(r.closedToArrival)} / {String(r.closedToDeparture)} / {String(r.isClosed)}</td><td className="p-2 tabular-nums">{formatMoney(r.rateOverride, currencyCode, i18n.language)}</td><td className="p-2">{r.overrideReason ?? '—'}</td><td className="p-2">{JSON.stringify(r.dayOfWeekOverrides ?? {})}</td></tr>)}</tbody></table></div>
  </section>;
}

function RatePlanDetail() {
  const { id } = useParams<{ id: string }>();
  const { propertyId } = useProperty();
  return <RatePlanDetailContent key={`${propertyId}:${id}`} />;
}

function RatePlanDetailContent() {
  const { t, i18n } = useTranslation();
  const { hasPermission } = useAuth();
  const ru = i18n.language.startsWith('ru');
  const { propertyId , currencyCode } = useProperty();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [testDate, setTestDate] = useState('');
  const [testNights, setTestNights] = useState('7');
  const [effectiveRate, setEffectiveRate] = useState<number | null>(null);

  const planQuery = useQuery({
    queryKey: ['rate-plans', id, propertyId],
    queryFn: () => api.get(`/v1/rate-plans/${id}`, { params: { propertyId } }).then((r) => r.data),
    enabled: !!id && !!propertyId && hasPermission('rateplans.read'),
  });

  const plan: RatePlan | null = planQuery.data?.data ?? planQuery.data ?? null;

  const testMutation = useMutation({
    mutationFn: () => {
      requirePropertyId(propertyId);
      return api.get(`/v1/rate-plans/${id}/effective-rate`, {
        params: {
          propertyId,
          date: testDate || undefined,
          checkIn: testDate || undefined,
          nights: Number(testNights) || 1,
          stayDate: testDate || undefined,
        },
      });
    },
    onSuccess: (res) => {
      const payload = res.data?.data ?? res.data;
      setEffectiveRate(payload?.effectiveRate ?? null);
    },
  });

  if (!propertyId) {
    return <div className="flex items-center justify-center h-64 text-telivity-mid-grey">{t('ratePlans.selectProperty')}</div>;
  }

  if (planQuery.isError) return <p role="alert">{pricingError(planQuery.error, ru)} <button type="button" onClick={() => void planQuery.refetch()}>{ru ? 'Повторить' : 'Retry'}</button></p>;
  if (!plan) return <div role="status" className="py-12 text-center text-telivity-mid-grey">{t('common.loading')}</div>;

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <button onClick={() => navigate('/rate-plans')} className="p-1.5 rounded hover:bg-telivity-light-grey"><ChevronLeft size={20} /></button>
        <BadgeDollarSign size={24} className="text-telivity-teal" />
        <h1 className="text-2xl font-semibold text-telivity-navy">{plan.name}</h1>
        <StatusBadge status={plan.type === 'bar' ? 'info' : 'warning'} label={plan.type} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white rounded-xl shadow-sm p-6 space-y-3">
          <h2 className="text-sm font-semibold text-telivity-navy">{t('ratePlans.details')}</h2>
          <div className="grid grid-cols-2 gap-3">
            <div><p className="text-xs text-telivity-mid-grey">{t('ratePlans.code')}</p><p className="text-sm font-medium">{plan.code}</p></div>
            <div><p className="text-xs text-telivity-mid-grey">{t('ratePlans.baseAmount')}</p><p className="text-sm font-medium">{plan.baseAmount != null ? formatMoney(plan.baseAmount, currencyCode) : '—'}</p></div>
            <div><p className="text-xs text-telivity-mid-grey">{t('ratePlans.roomType')}</p><p className="text-sm font-medium">{plan.roomTypeName ?? '—'}</p></div>
            <div><p className="text-xs text-telivity-mid-grey">{t('ratePlans.currency')}</p><p className="text-sm font-medium">{plan.currency ?? plan.currencyCode ?? '—'}</p></div>
            {plan.type === 'derived' && (
              <>
                <div><p className="text-xs text-telivity-mid-grey">{t('ratePlans.parentRatePlan')}</p><p className="text-sm font-medium font-mono">{plan.parentRatePlanId ?? '—'}</p></div>
                <div>
                  <p className="text-xs text-telivity-mid-grey">{t('ratePlans.adjustment')}</p>
                  <p className="text-sm font-medium">
                    {plan.derivedAdjustmentType ?? plan.derivationRule?.type ?? '—'}
                    {' '}
                    {plan.derivedAdjustmentValue ?? plan.derivationRule?.value ?? ''}
                  </p>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-sm p-6">
          <h2 className="text-sm font-semibold text-telivity-navy mb-3">{t('ratePlans.calculator')}</h2>
          <div className="flex gap-2 flex-wrap">
            <input type="date" value={testDate} disabled={testMutation.isPending} onChange={(e) => { setTestDate(e.target.value); setEffectiveRate(null); }} className="flex-1 min-w-[140px] border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-telivity-teal" />
            <input type="number" min={1} max={366} disabled={testMutation.isPending} value={testNights} onChange={(e) => { setTestNights(e.target.value); setEffectiveRate(null); }} placeholder="Nights" className="w-24 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-telivity-teal" />
            <button onClick={() => testMutation.mutate()} disabled={!testDate || !propertyId || !Number.isInteger(Number(testNights)) || Number(testNights) < 1 || Number(testNights) > 366 || testMutation.isPending} className="bg-telivity-teal text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50">{t('ratePlans.calculate')}</button>
          </div>
          {testMutation.isError && <p role="alert">{pricingError(testMutation.error, ru)}</p>}
          {effectiveRate != null && !testMutation.isError && (
            <div className="mt-4 bg-telivity-light-grey rounded-lg p-4 text-center">
              <p className="text-xs text-telivity-mid-grey">{t('ratePlans.effectiveRateFor', { date: testDate || '—' })}</p>
              <p className="text-2xl font-semibold text-telivity-navy whitespace-nowrap tabular-nums">{formatMoney(effectiveRate, currencyCode)}</p>
            </div>
          )}
        </div>
      </div>

      {id && hasPermission('rateplans.manage') && <Link className="my-4 inline-block rounded-lg border px-3 py-2 text-sm font-semibold" to={propertyHref(`/revenue?ratePlanId=${id}&kind=plan`, propertyId)}>{ru ? 'Preview глобального изменения плана →' : 'Preview global plan change →'}</Link>}
      {id && <RestrictionsPanel ratePlanId={id} />}
      {id && propertyId && (
        <RatePlanCalendar
          ratePlanId={id}
          propertyId={propertyId}
        />
      )}
    </div>
  );
}

export default function RatePlans() {
  const { propertyId } = useProperty();
  return (
    <div>
      <RevenueWorkspaceNav />
      <Routes key={propertyId}>
        <Route index element={<RatePlanList key={propertyId} />} />
        <Route path=":id" element={<RatePlanDetail key={propertyId} />} />
      </Routes>
    </div>
  );
}

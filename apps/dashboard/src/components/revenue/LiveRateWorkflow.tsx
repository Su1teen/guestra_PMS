import { useEffect, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';
import { api } from '../../lib/api';
import { formatMoney } from '../../lib/money';
import { canDecideChange, isAmbiguousPricingError, pricingError, pricingRecoveryKey, readPricingRecovery, unwrap, validCalendarRange,
  type LiveChange, type LivePreview, type LiveRate, type PendingPricingRequest, type PricingAudit,
  type PricingRequestState, type RateChange, type RatePlanRecord, type Restriction } from '../../lib/live-revenue';
import Modal from '../ui/Modal';

const input = 'w-full rounded-lg border border-gray-200 px-3 py-2 text-sm';
const button = 'rounded-lg border px-3 py-2 text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed';

function readRecovery(key: string, propertyId: string): PendingPricingRequest | null {
  try {
    return readPricingRecovery(sessionStorage.getItem(key), propertyId);
  } catch { return null; }
}

interface WorkflowProps {
  propertyId: string; section: string; editRate: LiveRate | null; onCloseEditor: () => void; plans: RatePlanRecord[];
  initialKind?: LiveChange['kind'];
  createControl?: (send: (request: PendingPricingRequest) => Promise<boolean>, busy: boolean) => ReactNode;
}

export default function LiveRateWorkflow(props: WorkflowProps) {
  const { user } = useAuth();
  return <ActorWorkflow key={`${props.propertyId}:${user?.sub ?? 'demo'}`} {...props} />;
}

function ActorWorkflow({ propertyId, section, editRate, onCloseEditor, plans, initialKind, createControl }: WorkflowProps) {
  const { i18n } = useTranslation();
  const ru = i18n.language.startsWith('ru');
  const text = (r: string, e: string) => ru ? r : e;
  const { hasPermission, user } = useAuth();
  const canRead = hasPermission('rateplans.read');
  const canManage = hasPermission('rateplans.manage');
  const canApprove = hasPermission('rateplans.manage', 'revenue.manage');
  const client = useQueryClient();
  const storageKey = pricingRecoveryKey(propertyId, user?.sub ?? 'demo');
  const [pending, setPending] = useState<PendingPricingRequest | null>(() => readRecovery(storageKey, propertyId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [decision, setDecision] = useState<{ record: RateChange; action: 'approve' | 'apply' | 'reject' } | null>(null);
  const [reason, setReason] = useState('');
  const queue = useQuery<RateChange[]>({
    queryKey: ['rate-plans', 'approval-queue', propertyId],
    queryFn: ({ signal }) => api.get('/v1/rate-plans/approval-queue', { params: { propertyId }, signal }).then(r => unwrap(r.data)),
    enabled: canRead,
  });
  const changes = useQuery<RateChange[]>({
    queryKey: ['rate-plans', 'rate-changes', propertyId],
    queryFn: ({ signal }) => api.get('/v1/rate-plans/rate-changes', { params: { propertyId }, signal }).then(r => unwrap(r.data)),
    enabled: canRead && section === 'history',
  });
  const audit = useQuery<PricingAudit[]>({
    queryKey: ['rate-plans', 'pricing-history', propertyId],
    queryFn: ({ signal }) => api.get('/v1/rate-plans/pricing-history', { params: { propertyId }, signal }).then(r => unwrap(r.data)),
    enabled: canRead && section === 'history',
  });
  const recovery = useQuery<PricingRequestState>({
    queryKey: ['rate-plans', 'request', propertyId, user?.sub ?? 'demo', pending?.requestId],
    queryFn: ({ signal }) => api.get(`/v1/rate-plans/requests/${pending!.requestId}`, { params: { propertyId }, signal }).then(r => unwrap(r.data)),
    enabled: !!pending && canManage,
    retry: false,
  });
  useEffect(() => { setPending(readRecovery(storageKey, propertyId)); }, [storageKey, propertyId]);
  const refresh = async () => {
    await Promise.all(['rate-plans', 'reports', 'dashboard', 'revenue'].map(key => client.invalidateQueries({ queryKey: [key] })));
  };
  const clearPending = () => {
    sessionStorage.removeItem(storageKey);
    setPending(null);
  };
  const finish = async (message: string) => {
    clearPending(); setError(''); setNotice(message); setDecision(null); setReason(''); onCloseEditor(); await refresh();
  };
  const send = async (request: PendingPricingRequest) => {
    if (!canManage || busy || (pending && pending.requestId !== request.requestId)) return false;
    setBusy(true); setError(''); setNotice('');
    try {
      // Persist before sending so a route change or lost response cannot hide a financial write.
      sessionStorage.setItem(storageKey, JSON.stringify(request));
      setPending(request);
    } catch {
      setBusy(false); onCloseEditor(); setDecision(null); setError(text('Недоступно sessionStorage. Включите хранилище для безопасного восстановления; запрос не отправлен.', 'Session storage unavailable. Enable it for safe recovery; request was not sent.')); return false;
    }
    try {
      const result = unwrap<{ record: RateChange; replayed: boolean }>((await api.post(request.path, request.body, { params: { propertyId }, skipErrorToast: true })).data);
      await finish(`${text('Сохранено', 'Saved')} · ${result.record.status ?? request.body.reason}${result.replayed ? ' · replayed' : ''}`);
      return true;
    } catch (err) {
      setError(pricingError(err, ru));
      if (!isAmbiguousPricingError(err)) { clearPending(); onCloseEditor(); setDecision(null); await refresh(); }
      else { onCloseEditor(); setDecision(null); await client.invalidateQueries({ queryKey: ['rate-plans', 'request', propertyId, user?.sub ?? 'demo', request.requestId] }); }
      return false;
    } finally { setBusy(false); }
  };
  const closeRequest = async () => {
    if (!pending || busy) return;
    setBusy(true); setError('');
    try {
      const result = unwrap<PricingRequestState>((await api.post(`/v1/rate-plans/requests/${pending.requestId}/close`, {}, { params: { propertyId }, skipErrorToast: true })).data);
      if (result.state === 'committed' || result.state === 'closed') await finish(text(`Запрос ${result.state}. Завершённая операция не отменяется.`, `Request ${result.state}. Completed operations are not cancelled.`));
      else { setError(text('Запрос ещё выполняется. Проверьте состояние позже.', 'Request is still running. Check status again.')); await recovery.refetch(); }
    } catch (err) { setError(pricingError(err, ru)); } finally { setBusy(false); }
  };
  const openDecision = (record: RateChange, action: 'approve' | 'apply' | 'reject') => { setDecision({ record, action }); setReason(''); setError(''); };
  const statusName = (status: string) => ({ pending: text('Ожидает', 'Pending'), approved: text('Согласован', 'Approved'), applied: text('Применён', 'Applied'), rejected: text('Отклонён', 'Rejected') }[status] ?? status);
  const proposalCard = (record: RateChange, actions: boolean) => <article key={record.id} className="rounded-lg border p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">{plans.find(p => p.id === record.ratePlanId)?.name ?? record.ratePlanId}</h3><span className="rounded-full bg-slate-100 px-2 py-1 text-xs">{statusName(record.status)} · revision {record.revision}</span></div>
    <p className="my-2 text-sm">{record.reason}</p><p className="text-xs text-telivity-mid-grey">{record.change.kind} · {record.change.startDate} — {record.change.endDate} · {new Date(record.createdAt).toLocaleString(i18n.language)}<br />{text('Инициатор', 'Requester')}: {record.requestedBy ?? '—'} · {text('Согласующий', 'Approver')}: {record.approvedBy ?? '—'}</p>
    {record.decisionReason && <p className="mt-1 text-xs">{text('Решение', 'Decision')}: {record.decisionReason}</p>}
    <details className="mt-3 text-xs"><summary className="cursor-pointer font-semibold">{text('Расшифровка предпросмотра и изменений', 'Preview & change details')}</summary><PreviewTable preview={record.preview} /><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-slate-50 p-2">{JSON.stringify({ plan: record.change.plan, restriction: record.change.restriction, restrictionId: record.change.restrictionId }, null, 2)}</pre></details>
    {actions && <div className="mt-3 flex flex-wrap gap-2">
      {canDecideChange(record, 'approve', user?.sub, canManage, canApprove) && <button type="button" className={button} disabled={busy || !!pending} onClick={() => openDecision(record, 'approve')}>{text('Согласовать', 'Approve')}</button>}
      {canDecideChange(record, 'apply', user?.sub, canManage, canApprove) && <button type="button" className={`${button} bg-telivity-teal text-white`} disabled={busy || !!pending} onClick={() => openDecision(record, 'apply')}>{text('Применить', 'Apply')}</button>}
      {canDecideChange(record, 'reject', user?.sub, canManage, canApprove) && <button type="button" className={button} disabled={busy || !!pending} onClick={() => openDecision(record, 'reject')}>{text('Отклонить', 'Reject')}</button>}
      {record.preview.approvalRequired && record.status === 'pending' && <p className="w-full text-xs text-amber-800">{text('Требуется независимый авторизованный согласующий; применение до согласования заблокировано.', 'Independent authenticated approver required; application is blocked until approval.')}</p>}
    </div>}
  </article>;
  return <>
    {createControl?.(send, busy || !!pending || !canManage)}
    {notice && <p role="status" className="rounded-lg bg-teal-50 p-3 text-sm">{notice}</p>}
    {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm">{error}</p>}
    {pending && <section className="space-y-2 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm"><h2 className="font-semibold">{text('Восстановление незавершённого запроса', 'Recover unresolved request')}</h2><p>{text('Новые записи заблокированы до проверки. Повтор отправляет идентичный запрос с тем же ключом.', 'New writes blocked until recovery. Retry sends the identical request and key.')}</p><p className="break-all text-xs">{pending.requestId} · {recovery.data?.state ?? text('Проверка…', 'Checking…')}</p>
      {recovery.isError && <p role="alert">{pricingError(recovery.error, ru)}</p>}
      {!canManage && <p>{text('Для восстановления требуются rateplans.manage и исходный пользователь.', 'Recovery requires rateplans.manage and the original actor.')}</p>}
      <div className="flex flex-wrap gap-2"><button className={button} type="button" disabled={busy || !canManage} onClick={() => void recovery.refetch()}>{text('Проверить состояние', 'Check status')}</button>
        {recovery.data?.state === 'committed' || recovery.data?.state === 'closed' ? <button className={button} type="button" disabled={busy} onClick={() => void finish(text(`Подтверждено: ${recovery.data!.state}`, `Confirmed: ${recovery.data!.state}`))}>{text('Подтвердить и обновить', 'Acknowledge & refresh')}</button> : <>
          <button className={button} type="button" disabled={busy || !canManage || !recovery.data || recovery.data.state === 'running'} onClick={() => void send(pending)}>{text('Повторить идентично', 'Retry identical request')}</button>
          <button className={button} type="button" disabled={busy || !canManage} onClick={() => void closeRequest()}>{text('Закрыть неподтверждённый запрос', 'Close unconfirmed request')}</button>
        </>}
      </div>
    </section>}
    {section === 'queue' && <section className="space-y-3 rounded-xl bg-white p-4 shadow-sm"><div className="flex items-center justify-between"><h2 className="font-semibold">{text('Очередь согласования', 'Approval queue')}</h2><button type="button" className={button} onClick={() => void queue.refetch()}>{text('Обновить', 'Refresh')}</button></div><p className="text-xs text-telivity-mid-grey">{text('Последние 200 предложений. Применение меняет canonical тариф, но не принятые цены броней.', 'Latest 200 proposals. Application updates canonical rates, not accepted reservation prices.')}</p>
      {!canRead ? <p>{text('Требуется rateplans.read.', 'Requires rateplans.read.')}</p> : queue.isPending ? <p role="status">{text('Загрузка…', 'Loading…')}</p> : queue.isError ? <p role="alert">{pricingError(queue.error, ru)}</p> : queue.data.length === 0 ? <p className="py-4 text-sm">{text('Предложений нет. Выберите тариф в обзоре и создайте предпросмотр.', 'No proposals. Select a rate in Overview and create a preview.')}</p> : queue.data.map(record => proposalCard(record, true))}
    </section>}
    {section === 'history' && <section className="space-y-3 rounded-xl bg-white p-4 shadow-sm"><h2 className="font-semibold">{text('История тарифов и согласований', 'Pricing & approval history')}</h2><p className="text-xs">{text('Последние 200 записей каждого журнала.', 'Latest 200 records per journal.')}</p>
      {!canRead ? <p>{text('Требуется rateplans.read.', 'Requires rateplans.read.')}</p> : <>
        {(changes.isPending || audit.isPending) && <p role="status">{text('Загрузка…', 'Loading…')}</p>}
        {(changes.isError || audit.isError) && <p role="alert">{pricingError(changes.error ?? audit.error, ru)} <button type="button" onClick={() => { void changes.refetch(); void audit.refetch(); }}>{text('Повторить', 'Retry')}</button></p>}
        {changes.data?.map(record => proposalCard(record, false))}
        <h3 className="pt-3 font-semibold">{text('Аудит: автор, время, до → после', 'Audit: actor, time, before → after')}</h3>
        {audit.data?.map(row => <details key={row.id} className="rounded-lg border p-3 text-xs"><summary className="cursor-pointer">{new Date(row.occurredAt).toLocaleString(i18n.language)} · {row.userEmail ?? row.userId ?? '—'} · {row.description ?? row.action}</summary><div className="mt-2 grid gap-2 md:grid-cols-2"><pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all bg-slate-50 p-2">{JSON.stringify(row.previousValue, null, 2) ?? '—'}</pre><pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all bg-slate-50 p-2">{JSON.stringify(row.newValue, null, 2) ?? '—'}</pre></div></details>)}
        {changes.data?.length === 0 && audit.data?.length === 0 && <p className="py-4">{text('Изменений пока нет.', 'No changes yet.')}</p>}
      </>}
    </section>}
    {editRate && !pending && canManage && <LiveChangeEditor key={`${editRate.date}:${editRate.ratePlanId}`} initialKind={initialKind} rate={editRate} plan={plans.find(p => p.id === editRate.ratePlanId)} propertyId={propertyId} disabled={busy} onClose={onCloseEditor} onSubmit={change => send({ requestId: change.requestId, propertyId, path: '/v1/rate-plans/rate-changes', body: change })} />}
    <Modal open={!!decision} onClose={() => setDecision(null)} closeDisabled={busy || !!pending} title={text('Подтвердить действие Live', 'Confirm live action')} wide>
      {decision && <div className="space-y-3"><p className="text-sm">{decision.action} · {decision.record.reason} · revision {decision.record.revision}</p><PreviewTable preview={decision.record.preview} /><label className="block text-xs">{text('Причина решения', 'Decision reason')}<textarea className={input} maxLength={1000} value={reason} onChange={e => setReason(e.target.value)} /></label><button type="button" className={`${button} bg-telivity-teal text-white`} disabled={busy || !!pending || !reason.trim() || !canManage || (decision.action !== 'apply' && !canApprove)} onClick={() => {
        const requestId = crypto.randomUUID();
        void send({ propertyId, requestId, path: `/v1/rate-plans/rate-changes/${decision.record.id}/${decision.action}`, body: { requestId, expectedRevision: decision.record.revision, reason: reason.trim() } });
      }}>{text('Подтвердить', 'Confirm')}</button></div>}
    </Modal>
  </>;
}

export function PreviewTable({ preview }: { preview: LivePreview }) {
  const { i18n } = useTranslation();
  const ru = i18n.language.startsWith('ru');
  const money = (value: string | number) => formatMoney(value, preview.currencyCode, i18n.language);
  return <div className="my-3 max-h-64 overflow-auto"><table className="w-full whitespace-nowrap text-left text-xs tabular-nums"><thead className="sticky top-0 bg-gray-50"><tr>{(ru ? ['Дата', 'Ночь до → после', 'Налог до → после', 'Итого до → после', 'Продажи до → после'] : ['Date', 'Night before → after', 'Tax before → after', 'Total before → after', 'Sales before → after']).map(h => <th className="p-2" key={h}>{h}</th>)}</tr></thead><tbody>{preview.days.map(day => <tr key={day.date} className="border-t"><td className="p-2">{day.date}</td><td className="p-2">{money(day.before.effectiveRate)} → {money(day.after.effectiveRate)}</td><td className="p-2">{money(day.beforeQuote.taxTotal)} → {money(day.afterQuote.taxTotal)}</td><td className="p-2">{money(day.beforeQuote.totalAmount)} → {money(day.afterQuote.totalAmount)}</td><td className="p-2">{String(day.beforeSales.sellable)} → {String(day.afterSales.sellable)}<span className="block whitespace-normal">{day.afterSales.reason}</span></td></tr>)}</tbody></table><details className="mt-2 text-xs"><summary>{ru ? 'Ограничения до → после' : 'Restrictions before → after'}</summary>{preview.days.map(day => <pre key={day.date} className="whitespace-pre-wrap break-all">{day.date}{'\n'}{JSON.stringify(day.beforeRestrictions)} → {JSON.stringify(day.afterRestrictions)}</pre>)}</details></div>;
}

function LiveChangeEditor({ rate, plan, propertyId, disabled, onClose, onSubmit, initialKind }: {
  rate: LiveRate; plan?: RatePlanRecord; propertyId: string; disabled: boolean; onClose: () => void; onSubmit: (change: LiveChange) => Promise<boolean>;
  initialKind?: LiveChange['kind'];
}) {
  const { i18n } = useTranslation();
  const ru = i18n.language.startsWith('ru');
  const text = (r: string, e: string) => ru ? r : e;
  const [kind, setKind] = useState<LiveChange['kind']>(initialKind ?? 'restriction_create');
  const [restrictionId, setRestrictionId] = useState(rate.restrictions[0]?.id ?? '');
  const [start, setStart] = useState(rate.date);
  const [end, setEnd] = useState(rate.date);
  const [previewStart, setPreviewStart] = useState(rate.date);
  const [previewEnd, setPreviewEnd] = useState(rate.date);
  const [reason, setReason] = useState('');
  const [amount, setAmount] = useState(String(rate.price.effectiveRate));
  const [baseAmount, setBaseAmount] = useState(plan?.baseAmount ?? String(rate.price.baseRate));
  const [derived, setDerived] = useState(plan?.derivedAdjustmentValue ?? '0');
  const [losRules, setLosRules] = useState(JSON.stringify(plan?.losAdjustments ?? []));
  const [occRules, setOccRules] = useState(JSON.stringify(plan?.occupancyBands ?? []));
  const [minLos, setMinLos] = useState('');
  const [maxLos, setMaxLos] = useState('');
  const [cta, setCta] = useState(false);
  const [ctd, setCtd] = useState(false);
  const [closed, setClosed] = useState(false);
  const [weekdays, setWeekdays] = useState('{}');
  const [preview, setPreview] = useState<{ result: LivePreview; change: LiveChange } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const loadRestriction = (r?: Restriction) => {
    if (!r) return;
    setStart(r.startDate); setEnd(r.endDate); setAmount(r.rateOverride == null ? '' : String(r.rateOverride));
    setMinLos(r.minLos == null ? '' : String(r.minLos)); setMaxLos(r.maxLos == null ? '' : String(r.maxLos));
    setCta(r.closedToArrival); setCtd(r.closedToDeparture); setClosed(r.isClosed); setWeekdays(JSON.stringify(r.dayOfWeekOverrides ?? {}));
  };
  const changeKind = (next: LiveChange['kind']) => { setKind(next); if (next === 'restriction_update' || next === 'restriction_delete') loadRestriction(rate.restrictions.find(r => r.id === restrictionId)); };
  const build = (): LiveChange => {
    if (!validCalendarRange(previewStart, previewEnd) || !reason.trim() || reason.trim().length > 1000 || (kind !== 'plan' && (!start || end < start))) throw new Error(text('Проверьте причину, даты ограничения и preview до 93 дней.', 'Check reason, restriction dates and preview up to 93 days.'));
    const change: LiveChange = { propertyId, ratePlanId: rate.ratePlanId, requestId: crypto.randomUUID(), expectedRevision: rate.planRevision, reason: reason.trim(), startDate: previewStart, endDate: previewEnd, kind };
    if (kind === 'plan') {
      const los = JSON.parse(losRules); const occ = JSON.parse(occRules);
      if (!Array.isArray(los) || !Array.isArray(occ)) throw new Error(text('LOS/OCC должны быть JSON-массивами.', 'LOS/OCC must be JSON arrays.'));
      change.plan = { baseAmount, losAdjustments: los, occupancyBands: occ };
      if (plan?.type === 'derived') change.plan.derivedAdjustmentValue = derived;
    } else {
      if (kind !== 'restriction_create') { if (!restrictionId) throw new Error(text('Выберите ограничение.', 'Select a restriction.')); change.restrictionId = restrictionId; }
      if (kind !== 'restriction_delete') {
        const overrides = JSON.parse(weekdays);
        if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new Error(text('Дни недели должны быть JSON-объектом.', 'Weekday overrides must be a JSON object.'));
        if ((amount !== '' && (!Number.isFinite(Number(amount)) || Number(amount) < 0)) || [minLos, maxLos].some(v => v !== '' && (!Number.isInteger(Number(v)) || Number(v) < 1))) throw new Error(text('Проверьте цену и LOS.', 'Check amount and LOS.'));
        change.restriction = { startDate: start, endDate: end, rateOverride: amount === '' ? null : Number(amount), overrideReason: amount === '' ? null : reason.trim(), minLos: minLos === '' ? null : Number(minLos), maxLos: maxLos === '' ? null : Number(maxLos), closedToArrival: cta, closedToDeparture: ctd, isClosed: closed, dayOfWeekOverrides: overrides };
      }
    }
    return change;
  };
  const runPreview = async () => {
    setBusy(true); setError(''); setPreview(null);
    try { const change = build(); const result = unwrap<LivePreview>((await api.post('/v1/rate-plans/live-preview', change, { params: { propertyId }, skipErrorToast: true })).data); setPreview({ result, change: { ...change, stateToken: result.stateToken } }); }
    catch (err) { setError(pricingError(err, ru)); } finally { setBusy(false); }
  };
  return <Modal open onClose={onClose} closeDisabled={busy || disabled} title={text('Live: предпросмотр изменения', 'Live: preview a change')} wide><div className="space-y-3">
    <p className="rounded-lg bg-teal-50 p-3 text-xs">{text('Предпросмотр ничего не записывает. Accepted prices и суммы существующих броней не меняются. Симуляционные цены не импортируются.', 'Preview writes nothing. Accepted prices and existing reservation totals are preserved. Simulation prices are not imported.')}</p>
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    <fieldset disabled={busy || disabled || !!preview} className="space-y-3 disabled:opacity-70"><label className="block text-xs">{text('Тип изменения', 'Change type')}<select className={input} value={kind} onChange={e => changeKind(e.target.value as LiveChange['kind'])}><option value="restriction_create">{text('Ограничение / цена по датам', 'Date-specific restriction / rate')}</option><option value="plan">{text('Глобальная конфигурация плана', 'Global plan configuration')}</option><option value="restriction_update">{text('Изменить ограничение', 'Update restriction')}</option><option value="restriction_delete">{text('Удалить ограничение', 'Delete restriction')}</option></select></label>
      {(kind === 'restriction_update' || kind === 'restriction_delete') && <label className="block text-xs">{text('Ограничение', 'Restriction')}<select className={input} value={restrictionId} onChange={e => { setRestrictionId(e.target.value); loadRestriction(rate.restrictions.find(r => r.id === e.target.value)); }}><option value="">—</option>{rate.restrictions.map(r => <option key={r.id} value={r.id}>{r.startDate} — {r.endDate} · {r.id.slice(0, 8)}</option>)}</select></label>}
      <div className="grid grid-cols-2 gap-3"><label className="text-xs">{text('Preview с даты', 'Preview from')}<input className={input} type="date" value={previewStart} onChange={e => setPreviewStart(e.target.value)} /></label><label className="text-xs">{text('Preview по дату (до 93 дней)', 'Preview through (up to 93 days)')}<input className={input} type="date" value={previewEnd} onChange={e => setPreviewEnd(e.target.value)} /></label></div>
      {kind !== 'plan' && <div className="grid grid-cols-2 gap-3"><label className="text-xs">{text('Ограничение с даты', 'Restriction from')}<input className={input} type="date" value={start} onChange={e => setStart(e.target.value)} /></label><label className="text-xs">{text('Ограничение по дату', 'Restriction through')}<input className={input} type="date" value={end} onChange={e => setEnd(e.target.value)} /></label></div>}
      {kind === 'plan' ? <><p className="text-xs text-amber-800">{text('Глобальное изменение плана: период ограничивает только предпросмотр, не применение.', 'Global plan change: date range limits preview only, not application.')}</p><label className="block text-xs">{text('Базовый тариф', 'Base amount')} · {rate.currencyCode}<input className={input} type="number" min={0} step="0.01" value={baseAmount} onChange={e => setBaseAmount(e.target.value)} /></label>{plan?.type === 'derived' && <label className="block text-xs">{text('Производная корректировка', 'Derived adjustment')} ({plan.derivedAdjustmentType})<input className={input} type="number" step="0.01" value={derived} onChange={e => setDerived(e.target.value)} /></label>}<label className="block text-xs">LOS rules JSON<textarea className={input} value={losRules} onChange={e => setLosRules(e.target.value)} /></label><p className="text-[11px]">[{`{"minNights":7,"adjustmentType":"percentage","adjustmentValue":-10}`} ]</p><label className="block text-xs">OCC rules JSON<textarea className={input} value={occRules} onChange={e => setOccRules(e.target.value)} /></label><p className="text-[11px]">[{`{"occupancyPctMin":0,"occupancyPctMax":50,"adjustmentType":"percentage","adjustmentValue":-10}`} ]</p></> : kind !== 'restriction_delete' && <><label className="block text-xs">{text('Цена за ночь (пусто — убрать override)', 'Nightly amount (blank clears override)')} · {rate.currencyCode}<input className={input} type="number" min={0} step="0.01" value={amount} onChange={e => setAmount(e.target.value)} /></label><div className="grid grid-cols-2 gap-3"><label className="text-xs">Min LOS<input className={input} type="number" min={1} value={minLos} onChange={e => setMinLos(e.target.value)} /></label><label className="text-xs">Max LOS<input className={input} type="number" min={1} value={maxLos} onChange={e => setMaxLos(e.target.value)} /></label></div>{([[text('Закрыть продажи', 'Stop sell'), closed, setClosed], [text('Закрыть заезд (CTA)', 'Closed to arrival'), cta, setCta], [text('Закрыть выезд (CTD)', 'Closed to departure'), ctd, setCtd]] as const).map(([label, checked, set]) => <label key={label} className="flex items-center gap-2 text-xs"><input type="checkbox" checked={checked} onChange={e => set(e.target.checked)} />{label}</label>)}<label className="block text-xs">{text('Корректировки по дням недели JSON', 'Weekday adjustments JSON')}<textarea className={input} value={weekdays} onChange={e => setWeekdays(e.target.value)} /></label><p className="text-[11px]">{`{"monday":500,"friday":1000}`} · {text('Фиксированные суммы', 'Fixed amounts')}</p></>}
      <label className="block text-xs">{text('Обязательная причина', 'Required reason')}<textarea className={input} maxLength={1000} value={reason} onChange={e => setReason(e.target.value)} /></label>
    </fieldset>
    {preview ? <><p className="text-xs">{preview.result.approvalRequired ? text('Требуется независимое согласование.', 'Independent approval required.') : text('Согласование необязательно; после отправки примените в очереди.', 'Approval optional; apply from queue after submission.')} · revision {preview.result.planRevision}</p><PreviewTable preview={preview.result} /><div className="flex gap-2"><button className={button} type="button" disabled={busy || disabled} onClick={() => setPreview(null)}>{text('Изменить ввод', 'Edit inputs')}</button><button className={`${button} bg-telivity-teal text-white`} type="button" disabled={busy || disabled} onClick={() => void onSubmit(preview.change)}>{text('Отправить предложение', 'Submit proposal')}</button></div></> : <button className={`${button} bg-telivity-teal text-white`} type="button" disabled={busy || disabled || !reason.trim()} onClick={() => void runPreview()}>{busy ? text('Проверка…', 'Checking…') : text('Получить предпросмотр', 'Preview change')}</button>}
  </div></Modal>;
}

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, ClipboardCheck, Clock3, Plus, Settings, Wrench, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { useProperty } from '../context/PropertyContext';
import Modal from '../components/ui/Modal';
import StatusBadge from '../components/ui/StatusBadge';
import { formatMoney } from '../lib/money';

type Assignee = { id: string; name: string; email: string };
type Attention = { id: string; type: string; priority: string; title: string; description: string; href: string; dueAt?: string; assignee?: string };
type Task = { id: string; title: string; description?: string; type: string; status: string; priority: number; department?: string; assigneeId?: string; slaDeadline?: string; comments?: any[]; roomId?: string; reservationId?: string };
type TicketRow = { ticket: any; roomNumber?: string; assigneeName?: string };

const today = () => new Date().toISOString().slice(0, 10);
const tomorrow = () => { const d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10); };

export default function Operations() {
  const { i18n } = useTranslation();
  const ru = i18n.language.startsWith('ru');
  const { propertyId, currencyCode } = useProperty();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'attention';
  const [createKind, setCreateKind] = useState<'task' | 'maintenance' | null>(null);
  const [expandedTicket, setExpandedTicket] = useState<string | null>(params.get('ticketId'));
  const [comment, setComment] = useState('');
  const [photoUrl, setPhotoUrl] = useState('');
  const [filters, setFilters] = useState({ department: '', priority: '', sla: '', assignee: '', status: '', type: '' });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['operations'] });
    queryClient.invalidateQueries({ queryKey: ['maintenance'] });
    queryClient.invalidateQueries({ queryKey: ['service-requests'] });
    queryClient.invalidateQueries({ queryKey: ['rooms'] });
  };

  const { data: attentionData } = useQuery({ queryKey: ['operations', 'attention', propertyId], queryFn: () => api.get('/v1/operations/attention', { params: { propertyId, date: today() } }).then(r => r.data), enabled: !!propertyId });
  const { data: arrivals = [] } = useQuery<any[]>({ queryKey: ['operations', 'pre-arrivals', propertyId], queryFn: () => api.get('/v1/operations/pre-arrivals', { params: { propertyId, startDate: today(), endDate: tomorrow() } }).then(r => r.data), enabled: !!propertyId });
  const { data: tasks = [] } = useQuery<Task[]>({ queryKey: ['service-requests', propertyId], queryFn: () => api.get('/v1/service-requests', { params: { propertyId } }).then(r => r.data), enabled: !!propertyId });
  const { data: ticketRows = [] } = useQuery<TicketRow[]>({ queryKey: ['maintenance', propertyId], queryFn: () => api.get('/v1/maintenance', { params: { propertyId } }).then(r => r.data), enabled: !!propertyId });
  const { data: assignees = [] } = useQuery<Assignee[]>({ queryKey: ['operations', 'assignees', propertyId], queryFn: () => api.get('/v1/operations/assignees', { params: { propertyId } }).then(r => r.data), enabled: !!propertyId });
  const { data: rooms = [] } = useQuery<any[]>({ queryKey: ['rooms', propertyId], queryFn: () => api.get('/v1/rooms', { params: { propertyId } }).then(r => r.data), enabled: !!propertyId });

  const taskUpdate = useMutation({ mutationFn: ({ id, body }: any) => api.patch(`/v1/service-requests/${id}`, body, { params: { propertyId } }), onSuccess: invalidate });
  const ticketUpdate = useMutation({ mutationFn: ({ id, body }: any) => api.patch(`/v1/maintenance/${id}`, body, { params: { propertyId } }), onSuccess: invalidate });
  const addComment = useMutation({ mutationFn: ({ id, body }: any) => api.post(`/v1/maintenance/${id}/comments`, { propertyId, body }), onSuccess: () => { setComment(''); invalidate(); } });
  const addPhoto = useMutation({ mutationFn: ({ id, url }: any) => api.post(`/v1/maintenance/${id}/attachments`, { propertyId, url, name: 'Maintenance photo' }), onSuccess: () => { setPhotoUrl(''); invalidate(); } });
  const returnRoom = useMutation({ mutationFn: (id: string) => api.post(`/v1/maintenance/${id}/return-to-service`, { propertyId, note: ru ? 'Возврат подтверждён' : 'Return to service confirmed' }), onSuccess: invalidate });

  if (!propertyId) return <div className="h-64 flex items-center justify-center text-telivity-mid-grey">{ru ? 'Выберите объект' : 'Select a property'}</div>;
  const attention: Attention[] = attentionData?.items ?? [];
  const filteredAttention = attention.filter((item) =>
    (!filters.priority || item.priority === filters.priority)
    && (!filters.assignee || item.assignee === filters.assignee)
    && (!filters.type || item.type === filters.type)
    && (!filters.sla || (filters.sla === 'overdue' && !!item.dueAt && new Date(item.dueAt).getTime() < Date.now())),
  );
  const filteredTasks = tasks.filter((task) =>
    (!filters.department || task.department === filters.department)
    && (!filters.priority || (['low','normal','high','critical'][task.priority] ?? 'normal') === filters.priority)
    && (!filters.assignee || task.assigneeId === filters.assignee)
    && (!filters.status || task.status === filters.status)
    && (!filters.type || task.type === filters.type)
    && (!filters.sla || (filters.sla === 'overdue' && !!task.slaDeadline && new Date(task.slaDeadline).getTime() < Date.now())),
  );
  const filteredTickets = ticketRows.filter((row) => {
    const ticket = row.ticket;
    return (!filters.department || ticket.department === filters.department)
      && (!filters.priority || ticket.priority === filters.priority)
      && (!filters.assignee || ticket.assigneeId === filters.assignee)
      && (!filters.status || ticket.status === filters.status)
      && (!filters.type || ticket.category === filters.type)
      && (!filters.sla || (filters.sla === 'overdue' && !!ticket.slaDeadline && new Date(ticket.slaDeadline).getTime() < Date.now()));
  });
  const tabs = [
    ['attention', ru ? 'Требует внимания' : 'Requires attention', AlertTriangle],
    ['pre-arrival', ru ? 'Подготовка к заезду' : 'Pre-arrival', ClipboardCheck],
    ['tasks', ru ? 'Запросы и задачи' : 'Requests & tasks', CheckCircle2],
    ['maintenance', 'Maintenance', Wrench],
  ] as const;

  return <div>
    <div className="flex flex-wrap items-center gap-3 mb-5"><Settings size={24} className="text-telivity-teal"/><div><h1 className="text-2xl font-semibold text-telivity-navy">{ru ? 'Операции' : 'Operations'}</h1><p className="text-xs text-telivity-mid-grey">{ru ? 'Единая очередь работы служб отеля' : 'One workspace for cross-department hotel operations'}</p></div><div className="ml-auto flex gap-2"><button onClick={() => setCreateKind('task')} className="border border-telivity-teal text-telivity-teal rounded-lg px-3 py-2 text-xs font-semibold flex gap-1"><Plus size={14}/>{ru ? 'Задача' : 'Task'}</button><button onClick={() => setCreateKind('maintenance')} className="bg-telivity-teal text-white rounded-lg px-3 py-2 text-xs font-semibold flex gap-1"><Plus size={14}/>Maintenance</button></div></div>
    <div className="flex gap-2 overflow-x-auto mb-5">{tabs.map(([key, label, Icon]) => <button key={key} onClick={() => setParams({ tab: key })} className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm whitespace-nowrap ${tab === key ? 'bg-telivity-navy text-white' : 'bg-white text-telivity-slate border border-gray-100'}`}><Icon size={15}/>{label}</button>)}</div>

    {tab !== 'pre-arrival' && <OperationsFilters value={filters} onChange={setFilters} assignees={assignees} ru={ru} />}

    {tab === 'attention' && <AttentionQueue items={filteredAttention} ru={ru} />}
    {tab === 'pre-arrival' && <PreArrival arrivals={arrivals} ru={ru} currencyCode={currencyCode} onTask={(reservationId: string) => { setParams({ tab: 'tasks', reservationId }); setCreateKind('task'); }} />}
    {tab === 'tasks' && <TaskList tasks={filteredTasks} assignees={assignees} ru={ru} onUpdate={(id: string, body: Record<string, unknown>) => taskUpdate.mutate({ id, body })} />}
    {tab === 'maintenance' && <MaintenanceList rows={filteredTickets} assignees={assignees} ru={ru} expanded={expandedTicket} setExpanded={setExpandedTicket} onUpdate={(id: string, body: Record<string, unknown>) => ticketUpdate.mutate({ id, body })} comment={comment} setComment={setComment} photoUrl={photoUrl} setPhotoUrl={setPhotoUrl} onComment={(id: string) => addComment.mutate({ id, body: comment })} onPhoto={(id: string) => addPhoto.mutate({ id, url: photoUrl })} onReturn={(id: string) => returnRoom.mutate(id)} />}

    <CreateOperationModal kind={createKind} onClose={() => setCreateKind(null)} propertyId={propertyId} rooms={rooms} assignees={assignees} reservationId={params.get('reservationId') ?? undefined} ru={ru} onCreated={() => { setCreateKind(null); invalidate(); }} />
  </div>;
}

function OperationsFilters({ value, onChange, assignees, ru }: { value: Record<string, string>; onChange: (next: any) => void; assignees: Assignee[]; ru: boolean }) {
  const field = (key: string, options: Array<[string, string]>) => <select value={value[key] ?? ''} onChange={(e) => onChange({ ...value, [key]: e.target.value })} className="rounded-lg border border-gray-200 bg-white px-2 py-2 text-xs"><option value="">{options[0]?.[1]}</option>{options.slice(1).map(([v, label]) => <option key={v} value={v}>{label}</option>)}</select>;
  return <div className="mb-4 grid grid-cols-2 gap-2 rounded-xl bg-white p-3 shadow-sm md:grid-cols-3 xl:grid-cols-6">
    {field('department', [['', ru ? 'Все службы' : 'All departments'], ['front_desk', 'Front Desk'], ['housekeeping', 'Housekeeping'], ['maintenance', 'Maintenance'], ['spa', 'SPA'], ['restaurant', ru ? 'Ресторан' : 'Restaurant']])}
    {field('priority', [['', ru ? 'Все приоритеты' : 'All priorities'], ['low', ru ? 'Низкий' : 'Low'], ['normal', ru ? 'Обычный' : 'Normal'], ['high', ru ? 'Высокий' : 'High'], ['critical', ru ? 'Критичный' : 'Critical']])}
    {field('sla', [['', 'SLA'], ['overdue', ru ? 'Просрочено' : 'Overdue']])}
    <select value={value.assignee ?? ''} onChange={(e) => onChange({ ...value, assignee: e.target.value })} className="rounded-lg border border-gray-200 bg-white px-2 py-2 text-xs"><option value="">{ru ? 'Все ответственные' : 'All assignees'}</option>{assignees.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
    {field('status', [['', ru ? 'Все статусы' : 'All statuses'], ['open', 'Open'], ['assigned', 'Assigned'], ['in_progress', 'In progress'], ['waiting_parts', 'Waiting parts'], ['completed', 'Completed'], ['resolved', 'Resolved'], ['closed', 'Closed']])}
    <input value={value.type ?? ''} onChange={(e) => onChange({ ...value, type: e.target.value })} placeholder={ru ? 'Тип / категория' : 'Type / category'} className="rounded-lg border border-gray-200 px-2 py-2 text-xs" />
  </div>;
}

function AttentionQueue({ items, ru }: { items: Attention[]; ru: boolean }) {
  return <div className="space-y-3">{items.map(item => <a key={`${item.type}-${item.id}`} href={item.href} className="block bg-white rounded-xl shadow-sm p-4 border-l-4 border-l-amber-400 hover:ring-2 hover:ring-telivity-teal/20"><div className="flex flex-wrap items-center gap-2"><Priority value={item.priority} ru={ru}/><p className="font-semibold text-telivity-navy">{item.title}</p>{item.dueAt && <Sla deadline={item.dueAt} ru={ru}/>}<span className="ml-auto text-xs text-telivity-teal">→</span></div><p className="text-sm text-telivity-slate mt-2">{item.description}</p>{item.assignee && <p className="text-xs text-telivity-mid-grey mt-1">{ru ? 'Ответственный' : 'Assignee'}: {item.assignee}</p>}</a>)}{items.length === 0 && <Empty text={ru ? 'Очередь пуста — критичных отклонений нет' : 'Queue is clear — no actionable exceptions'}/>}</div>;
}

function PreArrival({ arrivals, ru, currencyCode, onTask }: any) {
  const labels: Record<string, [string, string]> = { roomAssigned: ['Номер назначен', 'Room assigned'], roomOperational: ['Номер исправен', 'Room operational'], housekeepingReady: ['Уборка и проверка завершены', 'Housekeeping ready / inspected'], depositReceived: ['Предоплата получена', 'Deposit received'], guestInformationComplete: ['Данные гостя заполнены', 'Guest information complete'], hasSpecialRequests: ['Особые пожелания учтены', 'Special requests reviewed'], extrasBooked: ['Доп. услуги проверены', 'Booked extras reviewed'], operationalTasksComplete: ['Операционные задачи закрыты', 'Operational tasks complete'] };
  return <div className="grid lg:grid-cols-2 gap-4">{arrivals.map((a: any) => <div key={a.reservationId} className="bg-white rounded-xl shadow-sm p-5"><div className="flex items-start gap-3"><div className="flex-1"><p className="font-semibold text-telivity-navy">{a.guestName} {a.vipLevel !== 'none' && <span className="text-amber-600">VIP</span>}</p><p className="text-xs text-telivity-mid-grey">{a.propertyName} · {a.roomNumber ?? (ru ? 'номер не назначен' : 'unassigned')} · {a.arrivalDate} {typeof a.arrivalTime === 'string' ? a.arrivalTime.slice(0, 5) : ''}</p></div><StatusBadge status={a.roomStatus ?? 'pending'}/></div><div className="mt-4 space-y-2">{Object.entries(a.checks).map(([key, ok]) => <div key={key} className="flex items-center gap-2 text-sm">{ok ? <CheckCircle2 size={15} className="text-emerald-600"/> : <XCircle size={15} className="text-amber-600"/>}<span className={ok ? 'text-telivity-slate' : 'font-medium text-telivity-navy'}>{labels[key]?.[ru ? 0 : 1] ?? key}{key === 'depositReceived' && ok ? ` · ${formatMoney(a.checks.depositAmount, a.currencyCode ?? currencyCode)}` : ''}</span></div>)}</div>{a.notes && <p className="mt-3 rounded-lg bg-amber-50 p-2 text-xs text-amber-900">{a.notes}</p>}<div className="mt-4 flex flex-wrap gap-2"><a href={a.actions.reservation} className="text-xs font-semibold text-telivity-teal">{ru ? 'Открыть бронь' : 'Open reservation'}</a><a href={a.actions.guest} className="text-xs font-semibold text-telivity-teal">{ru ? 'Открыть гостя' : 'Open guest'}</a><button onClick={() => onTask(a.reservationId)} className="text-xs font-semibold text-telivity-teal">{ru ? 'Назначить задачу' : 'Assign task'}</button></div></div>)}{arrivals.length === 0 && <Empty text={ru ? 'Заездов в выбранном периоде нет' : 'No arrivals in the selected period'}/>}</div>;
}

function TaskList({ tasks, assignees, ru, onUpdate }: { tasks: Task[]; assignees: Assignee[]; ru: boolean; onUpdate: (id: string, body: any) => void }) {
  return <div className="space-y-3">{tasks.map(task => <div key={task.id} className="bg-white rounded-xl shadow-sm p-4"><div className="flex flex-wrap items-center gap-2"><Priority value={['low','normal','high','critical'][task.priority] ?? 'normal'} ru={ru}/><p className="font-semibold text-telivity-navy">{task.title}</p><StatusBadge status={task.status}/>{task.slaDeadline && <Sla deadline={task.slaDeadline} ru={ru}/>}</div><p className="text-sm text-telivity-slate mt-2">{task.description}</p><div className="mt-3 flex flex-wrap gap-2"><select value={task.assigneeId ?? ''} onChange={e => onUpdate(task.id, { assigneeId: e.target.value || null })} className="border rounded-lg px-2 py-1.5 text-xs"><option value="">{ru ? 'Не назначено' : 'Unassigned'}</option>{assignees.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select><select value={task.status} onChange={e => onUpdate(task.id, { status: e.target.value })} className="border rounded-lg px-2 py-1.5 text-xs">{['open','assigned','in_progress','completed','cancelled'].map(s => <option key={s} value={s}>{s.replace(/_/g,' ')}</option>)}</select>{task.reservationId && <a href={`/reservations/${task.reservationId}`} className="text-xs text-telivity-teal px-2 py-1.5">{ru ? 'Бронь →' : 'Reservation →'}</a>}</div></div>)}{tasks.length === 0 && <Empty text={ru ? 'Задач пока нет' : 'No tasks yet'}/>}</div>;
}

function MaintenanceList({ rows, assignees, ru, expanded, setExpanded, onUpdate, comment, setComment, photoUrl, setPhotoUrl, onComment, onPhoto, onReturn }: any) {
  return <div className="space-y-3">{rows.map((row: TicketRow) => { const t = row.ticket; const open = expanded === t.id; return <div key={t.id} className="bg-white rounded-xl shadow-sm p-4"><button onClick={() => setExpanded(open ? null : t.id)} className="w-full text-left"><div className="flex flex-wrap items-center gap-2"><Priority value={t.priority} ru={ru}/><p className="font-semibold text-telivity-navy">{row.roomNumber ? `${row.roomNumber} · ` : ''}{t.title}</p><StatusBadge status={t.status}/>{t.slaDeadline && <Sla deadline={t.slaDeadline} ru={ru}/>}<span className="ml-auto text-xs text-telivity-teal">{open ? '▲' : '▼'}</span></div><p className="text-sm text-telivity-slate mt-2">{t.description}</p></button>{open && <div className="mt-4 pt-4 border-t space-y-3"><div className="grid md:grid-cols-3 gap-2"><select value={t.assigneeId ?? ''} onChange={e => onUpdate(t.id, { assigneeId: e.target.value })} className="border rounded-lg px-2 py-2 text-xs"><option value="">{ru ? 'Не назначено' : 'Unassigned'}</option>{assignees.map((a: Assignee) => <option key={a.id} value={a.id}>{a.name}</option>)}</select><select value={t.status} onChange={e => { const status=e.target.value; const resolution = status === 'resolved' || status === 'closed' ? window.prompt(ru ? 'Опишите решение' : 'Describe the resolution') : undefined; if ((status === 'resolved' || status === 'closed') && !resolution) return; onUpdate(t.id, { status, ...(resolution ? { resolution } : {}) }); }} className="border rounded-lg px-2 py-2 text-xs">{['open','assigned','in_progress','waiting_parts','resolved','closed','cancelled'].map(s => <option key={s} value={s}>{s.replace(/_/g,' ')}</option>)}</select><label className="border rounded-lg px-2 py-2 text-xs flex gap-2"><input type="checkbox" checked={t.blocksInventory} onChange={e => onUpdate(t.id, { blocksInventory: e.target.checked })}/>{ru ? 'Блокирует продажи номера' : 'Blocks room inventory'}</label></div>{t.resolution && <p className="text-sm bg-emerald-50 text-emerald-900 rounded-lg p-3"><b>{ru ? 'Решение' : 'Resolution'}:</b> {t.resolution}</p>}<div className="space-y-2">{(t.comments ?? []).map((c: any) => <p key={c.id} className="text-xs rounded-lg bg-gray-50 p-2">{c.body} <span className="text-telivity-mid-grey">· {new Date(c.createdAt).toLocaleString()}</span></p>)}</div><div className="flex gap-2"><input value={comment} onChange={e => setComment(e.target.value)} placeholder={ru ? 'Добавить комментарий' : 'Add comment'} className="flex-1 border rounded-lg px-3 py-2 text-xs"/><button disabled={!comment.trim()} onClick={() => onComment(t.id)} className="bg-telivity-teal text-white rounded-lg px-3 text-xs">{ru ? 'Добавить' : 'Add'}</button></div><div className="flex gap-2"><input value={photoUrl} onChange={e => setPhotoUrl(e.target.value)} placeholder={ru ? 'URL фото / вложения' : 'Photo / attachment URL'} className="flex-1 border rounded-lg px-3 py-2 text-xs"/><button disabled={!photoUrl.trim()} onClick={() => onPhoto(t.id)} className="border border-telivity-teal text-telivity-teal rounded-lg px-3 text-xs">{ru ? 'Прикрепить' : 'Attach'}</button></div>{t.returnToServiceRequired && <button onClick={() => onReturn(t.id)} className="bg-emerald-600 text-white rounded-lg px-4 py-2 text-xs font-semibold">{ru ? 'Подтвердить возврат номера в эксплуатацию' : 'Confirm room return to service'}</button>}</div>}</div>; })}{rows.length === 0 && <Empty text={ru ? 'Заявок на ремонт пока нет' : 'No maintenance tickets yet'}/>}</div>;
}

function CreateOperationModal({ kind, onClose, propertyId, rooms, assignees, reservationId, ru, onCreated }: any) {
  const [title, setTitle] = useState(''); const [description, setDescription] = useState(''); const [roomId, setRoomId] = useState(''); const [assigneeId, setAssigneeId] = useState(''); const [priority, setPriority] = useState('normal'); const [category, setCategory] = useState('other'); const [sla, setSla] = useState(''); const [blocks, setBlocks] = useState(false);
  const payload = useMemo(() => ({ propertyId, title, description, roomId: roomId || undefined, reservationId, assigneeId: assigneeId || undefined, slaDeadline: sla ? new Date(sla).toISOString() : undefined }), [propertyId,title,description,roomId,reservationId,assigneeId,sla]);
  const create = useMutation({ mutationFn: () => kind === 'maintenance' ? api.post('/v1/maintenance', { ...payload, category, priority, blocksInventory: blocks }) : api.post('/v1/service-requests', { ...payload, type: category === 'other' ? 'service_request' : category, category, priority: ['low','normal','high','critical'].indexOf(priority) }), onSuccess: onCreated });
  return <Modal open={!!kind} onClose={onClose} title={kind === 'maintenance' ? (ru ? 'Новая заявка Maintenance' : 'New maintenance ticket') : (ru ? 'Новый запрос / задача' : 'New request / task')}><div className="space-y-3"><input value={title} onChange={e=>setTitle(e.target.value)} placeholder={ru?'Кратко: что нужно сделать?':'What needs to be done?'} className="w-full border rounded-lg px-3 py-2 text-sm"/><textarea value={description} onChange={e=>setDescription(e.target.value)} placeholder={ru?'Описание и контекст':'Description and context'} className="w-full border rounded-lg px-3 py-2 text-sm"/><div className="grid grid-cols-2 gap-2"><select value={roomId} onChange={e=>setRoomId(e.target.value)} className="border rounded-lg px-2 py-2 text-sm"><option value="">{ru?'Без номера':'No room'}</option>{rooms.map((r:any)=><option key={r.id} value={r.id}>{r.number}</option>)}</select><select value={assigneeId} onChange={e=>setAssigneeId(e.target.value)} className="border rounded-lg px-2 py-2 text-sm"><option value="">{ru?'Не назначено':'Unassigned'}</option>{assignees.map((a:Assignee)=><option key={a.id} value={a.id}>{a.name}</option>)}</select><select value={category} onChange={e=>setCategory(e.target.value)} className="border rounded-lg px-2 py-2 text-sm">{(kind==='maintenance'?['hvac','plumbing','electrical','furniture','appliance','internet','lighting','bathroom','safety','other']:['late_checkout','early_checkin','extra_towel','extra_blanket','housekeeping','spa_booking','restaurant_request','transfer','breakfast','technical_problem','other']).map(c=><option key={c} value={c}>{c.replace(/_/g,' ')}</option>)}</select><select value={priority} onChange={e=>setPriority(e.target.value)} className="border rounded-lg px-2 py-2 text-sm">{['low','normal','high','critical'].map(p=><option key={p}>{p}</option>)}</select><input type="datetime-local" value={sla} onChange={e=>setSla(e.target.value)} className="border rounded-lg px-2 py-2 text-sm"/>{kind==='maintenance'&&<label className="border rounded-lg px-2 py-2 text-xs flex items-center gap-2"><input type="checkbox" checked={blocks} onChange={e=>setBlocks(e.target.checked)}/>{ru?'Вывести номер из продажи':'Mark room out of order'}</label>}</div><div className="flex justify-end gap-2"><button onClick={onClose} className="border rounded-lg px-4 py-2 text-sm">{ru?'Отмена':'Cancel'}</button><button disabled={!title.trim()||!description.trim()||create.isPending} onClick={()=>create.mutate()} className="bg-telivity-teal text-white rounded-lg px-4 py-2 text-sm font-semibold">{ru?'Создать':'Create'}</button></div></div></Modal>;
}

function Priority({ value, ru }: { value: string; ru: boolean }) { const labels:any={low:ru?'Низкий':'Low',normal:ru?'Обычный':'Normal',high:ru?'Высокий':'High',critical:ru?'Критично':'Critical'}; const cls=value==='critical'?'bg-red-100 text-red-800':value==='high'?'bg-amber-100 text-amber-900':value==='low'?'bg-gray-100 text-gray-600':'bg-blue-50 text-blue-800'; return <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${cls}`}>{labels[value]??value}</span>; }
function Sla({ deadline, ru }: { deadline: string; ru: boolean }) { const diff=new Date(deadline).getTime()-Date.now(); const mins=Math.round(Math.abs(diff)/60000); return <span className={`inline-flex gap-1 items-center text-xs ml-auto ${diff<0?'text-red-700 font-semibold':'text-telivity-mid-grey'}`}><Clock3 size={12}/>{diff<0?(ru?`Просрочено на ${mins} мин`:`Overdue ${mins}m`):(ru?`SLA осталось ${mins} мин`:`SLA ${mins}m left`)}</span>; }
function Empty({ text }: { text: string }) { return <div className="bg-white rounded-xl shadow-sm p-10 text-center text-sm text-telivity-mid-grey">{text}</div>; }

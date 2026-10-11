import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  Clock3,
  Plus,
  Settings,
  Wrench,
  XCircle,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { useProperty } from '../context/PropertyContext';
import { useAuth } from '../context/AuthContext';
import Modal from '../components/ui/Modal';
import MaintenanceWorkspace from '../components/operations/MaintenanceWorkspace';
import RoomInventoryBlocks from '../components/operations/RoomInventoryBlocks';
import StatusBadge from '../components/ui/StatusBadge';
import { formatMoney } from '../lib/money';
import { errorMessage } from '../lib/error-message';

type Assignee = { id: string; name: string; email: string };
type Attention = {
  id: string;
  type: string;
  priority: string;
  title: string;
  description: string;
  href: string;
  dueAt?: string;
  assignee?: string;
};
type Task = {
  id: string;
  title: string;
  description?: string;
  type: string;
  status: string;
  priority: number;
  department?: string;
  assigneeId?: string;
  slaDeadline?: string;
  comments?: any[];
  roomId?: string;
  reservationId?: string;
  linkedOperation?: { kind: string; id: string; href: string };
  coordinationWarning?: string;
};
type TicketRow = { ticket: any; roomNumber?: string; assigneeName?: string };

const today = () => new Date().toISOString().slice(0, 10);
const tomorrow = () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
};

export default function Operations() {
  const { i18n } = useTranslation();
  const ru = i18n.language.startsWith('ru');
  const { propertyId, currencyCode } = useProperty();
  const queryClient = useQueryClient();
  const { hasPermission } = useAuth();
  const hasPropertyScope = !!propertyId && propertyId !== 'portfolio';
  const canManage = hasPropertyScope && hasPermission('ops.manage');
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'attention';
  const [createKind, setCreateKind] = useState<'task' | 'maintenance' | null>(
    null,
  );
  useEffect(() => {
    if (params.get('action') === 'create-task' && canManage) {
      setCreateKind('task');
      setParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          next.delete('action');
          return next;
        },
        { replace: true },
      );
    }
  }, [params, canManage, setParams]);
  const [expandedTicket, setExpandedTicket] = useState<string | null>(
    params.get('ticketId'),
  );
  useEffect(()=>{setExpandedTicket(params.get('ticketId'));},[params]);
  const [maintenancePage,setMaintenancePage]=useState(1);
  const [filters, setFilters] = useState({
    department: '',
    priority: '',
    sla: '',
    assignee: '',
    status: '',
    type: '',
  });

  useEffect(()=>{setMaintenancePage(1);},[propertyId,filters]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['operations'] });
    queryClient.invalidateQueries({ queryKey: ['maintenance'] });
    queryClient.invalidateQueries({ queryKey: ['service-requests'] });
    queryClient.invalidateQueries({ queryKey: ['rooms'] });
  };

  const { data: attentionData } = useQuery({
    queryKey: ['operations', 'attention', propertyId],
    queryFn: () =>
      api
        .get('/v1/operations/attention', {
          params: { propertyId, date: today() },
        })
        .then((r) => r.data),
    enabled: hasPropertyScope,
  });
  const { data: arrivals = [] } = useQuery<any[]>({
    queryKey: ['operations', 'pre-arrivals', propertyId],
    queryFn: () =>
      api
        .get('/v1/operations/pre-arrivals', {
          params: { propertyId, startDate: today(), endDate: tomorrow() },
        })
        .then((r) => r.data),
    enabled: hasPropertyScope,
  });
  const { data: tasks = [] } = useQuery<Task[]>({
    queryKey: ['service-requests', propertyId],
    queryFn: () =>
      api
        .get('/v1/service-requests', { params: { propertyId } })
        .then((r) => r.data),
    enabled: hasPropertyScope,
  });
  const ticketsQuery = useQuery<{data:TicketRow[];total:number;limit:number}>({
    queryKey: ['maintenance', propertyId,maintenancePage,filters],
    queryFn: () =>
      api
        .get('/v1/maintenance/page', { params: { propertyId,page:maintenancePage,limit:50,department:filters.department||undefined,priority:filters.priority||undefined,status:filters.status||undefined,assigneeId:filters.assignee||undefined,category:filters.type||undefined,overdue:filters.sla==='overdue'?true:undefined } })
        .then((r) => r.data),
    enabled: hasPropertyScope && hasPermission('maintenance.view') && tab==='maintenance',
    retry:false,
  });
  const ticketRows:TicketRow[]=ticketsQuery.data?.data??[];
  const { data: assignees = [] } = useQuery<Assignee[]>({
    queryKey: ['operations', 'assignees', propertyId],
    queryFn: () =>
      api
        .get('/v1/operations/assignees', { params: { propertyId } })
        .then((r) => r.data),
    enabled: hasPropertyScope,
  });
  const { data: rooms = [] } = useQuery<any[]>({
    queryKey: ['rooms', propertyId],
    queryFn: () =>
      api.get('/v1/rooms', { params: { propertyId } }).then((r) => r.data),
    enabled: hasPropertyScope,
  });

  const taskHandoff = useMutation({
    mutationFn: (id: string) =>
      api.post(`/v1/service-requests/${id}/create-task`, { propertyId }),
    onSuccess: invalidate,
  });
  const taskUpdate = useMutation({
    mutationFn: ({ id, body }: any) =>
      api.patch(`/v1/service-requests/${id}`, body, { params: { propertyId } }),
    onSuccess: invalidate,
  });

  if (!hasPropertyScope)
    return (
      <div className="h-64 flex items-center justify-center text-telivity-mid-grey">
        {ru ? 'Выберите объект' : 'Select a property'}
      </div>
    );
  const attention: Attention[] = attentionData?.items ?? [];
  const filteredAttention = attention.filter(
    (item) =>
      (!filters.priority || item.priority === filters.priority) &&
      (!filters.assignee || item.assignee === filters.assignee) &&
      (!filters.type || item.type === filters.type) &&
      (!filters.sla ||
        (filters.sla === 'overdue' &&
          !!item.dueAt &&
          new Date(item.dueAt).getTime() < Date.now())),
  );
  const filteredTasks = tasks.filter(
    (task) =>
      (!filters.department || task.department === filters.department) &&
      (!filters.priority ||
        (['low', 'normal', 'high', 'critical'][task.priority] ?? 'normal') ===
          filters.priority) &&
      (!filters.assignee || task.assigneeId === filters.assignee) &&
      (!filters.status || task.status === filters.status) &&
      (!filters.type || task.type === filters.type) &&
      (!filters.sla ||
        (filters.sla === 'overdue' &&
          !!task.slaDeadline &&
          new Date(task.slaDeadline).getTime() < Date.now())),
  );
  const filteredTickets = ticketRows.filter((row) => {
    const ticket = row.ticket;
    return (
      (!filters.department || ticket.department === filters.department) &&
      (!filters.priority || ticket.priority === filters.priority) &&
      (!filters.assignee || ticket.assigneeId === filters.assignee) &&
      (!filters.status || ticket.status === filters.status) &&
      (!filters.type || ticket.category === filters.type) &&
      (!filters.sla ||
        (filters.sla === 'overdue' &&
          !!ticket.slaDeadline &&
          new Date(ticket.slaDeadline).getTime() < Date.now()))
    );
  });
  const tabs = [
    [
      'attention',
      ru ? 'Требует внимания' : 'Requires attention',
      AlertTriangle,
    ],
    ['pre-arrival', ru ? 'Подготовка к заезду' : 'Pre-arrival', ClipboardCheck],
    ['tasks', ru ? 'Запросы и задачи' : 'Requests & tasks', CheckCircle2],
    ['maintenance', ru ? 'Техническая служба' : 'Maintenance', Wrench],
  ] as const;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 mb-5">
        <Settings size={24} className="text-telivity-teal" />
        <div>
          <h1 className="text-2xl font-semibold text-telivity-navy">
            {ru ? 'Операции' : 'Operations'}
          </h1>
          <p className="text-xs text-telivity-mid-grey">
            {ru
              ? 'Единая очередь работы служб отеля'
              : 'One workspace for cross-department hotel operations'}
          </p>
        </div>
        <div className="ml-auto flex gap-2">
          {canManage && <button
                onClick={() => setCreateKind('task')}
                className="border border-telivity-teal text-telivity-teal rounded-lg px-3 py-2 text-xs font-semibold flex gap-1"
              >
                <Plus size={14} />
                {ru ? 'Задача' : 'Task'}
              </button>
          }
              {hasPropertyScope && hasPermission('maintenance.create') && <button
                onClick={() => {
                  setExpandedTicket(null);
                  setCreateKind('maintenance');
                }}
                className="bg-telivity-teal text-white rounded-lg px-3 py-2 text-xs font-semibold flex gap-1"
              >
                <Plus size={14} />
                {ru ? 'Новая заявка' : 'New maintenance ticket'}
              </button>}
        </div>
      </div>
      <div className="flex gap-2 overflow-x-auto mb-5">
        {tabs.map(([key, label, Icon]) => (
          <button
            key={key}
            onClick={() => {setFilters({department:'',priority:'',sla:'',assignee:'',status:'',type:''});setParams({ tab: key });}}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm whitespace-nowrap ${tab === key ? 'bg-telivity-navy text-white' : 'bg-white text-telivity-slate border border-gray-100'}`}
          >
            <Icon size={15} />
            {label}
          </button>
        ))}
      </div>

      {tab !== 'pre-arrival' && (
        <OperationsFilters
          value={filters}
          onChange={setFilters}
          assignees={assignees}
          ru={ru}
          maintenance={tab==='maintenance'}
        />
      )}
      {(taskUpdate.isError || taskHandoff.isError) && (
        <p
          role="alert"
          className="mb-3 rounded-lg bg-red-50 p-3 text-sm text-red-700"
        >
          {errorMessage(taskUpdate.error ?? taskHandoff.error)}
        </p>
      )}

      {tab === 'attention' && (
        <AttentionQueue items={filteredAttention} ru={ru} />
      )}
      {tab === 'pre-arrival' && (
        <PreArrival
          arrivals={arrivals}
          ru={ru}
          currencyCode={currencyCode}
          onTask={
            canManage
              ? (reservationId: string) => {
                  setParams({ tab: 'tasks', reservationId });
                  setCreateKind('task');
                }
              : undefined
          }
        />
      )}
      {tab === 'tasks' && (
        <fieldset disabled={!canManage}>
          <TaskList
            tasks={filteredTasks}
            assignees={assignees}
            ru={ru}
            onUpdate={(id: string, body: Record<string, unknown>) =>
              taskUpdate.mutate({ id, body })
            }
            onHandoff={(id: string) => taskHandoff.mutate(id)}
            handoffPending={taskHandoff.isPending}
          />
        </fieldset>
      )}
      {tab === 'maintenance' && (
        <div className="space-y-3">
        {hasPropertyScope&&<RoomInventoryBlocks propertyId={propertyId!} rooms={rooms}/>}
        {ticketsQuery.isLoading && <p role="status">Загрузка заявок…</p>}
        {ticketsQuery.isError && <p role="alert" className="text-sm text-red-700">{errorMessage(ticketsQuery.error)} <button onClick={()=>ticketsQuery.refetch()} className="underline">Повторить</button></p>}
        {!ticketsQuery.isLoading && !ticketsQuery.isError && <>
        <MaintenanceList
          rows={filteredTickets}
          ru={ru}
          onOpen={(id: string) => {
            setExpandedTicket(id);
            setParams((previous) => {
              const next = new URLSearchParams(previous);
              next.set('ticketId', id);
              return next;
            });
          }}
        />
        <div className="flex flex-wrap items-center gap-3 text-sm"><button disabled={maintenancePage===1} onClick={()=>setMaintenancePage(page=>page-1)} className="rounded-lg border px-3 py-2 disabled:opacity-50">Назад</button><span>Страница {maintenancePage} · Всего заявок: {ticketsQuery.data?.total??0}</span><button disabled={maintenancePage*50>=(ticketsQuery.data?.total??0)} onClick={()=>setMaintenancePage(page=>page+1)} className="rounded-lg border px-3 py-2 disabled:opacity-50">Далее</button></div>
        </>}
        </div>
      )}
      {(expandedTicket || createKind === 'maintenance') && (
        <MaintenanceWorkspace
          key={propertyId + (expandedTicket ?? 'new')}
          propertyId={propertyId}
          ticketId={expandedTicket ?? undefined}
          rooms={rooms}
          onPlanInventoryBlock={ticket=>{
            setExpandedTicket(null);setCreateKind(null);
            setParams(previous=>{const next=new URLSearchParams(previous);next.delete('ticketId');next.set('tab','maintenance');next.set('newBlockRoomId',ticket.roomId);next.set('blockTicketId',ticket.id);return next;});
          }}
          assignees={assignees}
          reservationId={params.get('reservationId') ?? undefined}
          onClose={() => {
            setExpandedTicket(null);
            setCreateKind(null);
            setParams((previous) => {
              const next = new URLSearchParams(previous);
              next.delete('ticketId');
              return next;
            });
          }}
          onSaved={(ticket) => {
            invalidate();
            if (!expandedTicket) {
              setCreateKind(null);
              setExpandedTicket(ticket.id);
            }
          }}
        />
      )}
      <CreateOperationModal
        key={propertyId + '-' + params.get('reservationId') + '-' + createKind}
        kind={canManage && createKind === 'task' ? 'task' : null}
        onClose={() => setCreateKind(null)}
        propertyId={propertyId}
        rooms={rooms}
        assignees={assignees}
        reservationId={params.get('reservationId') ?? undefined}
        ru={ru}
        onCreated={() => {
          setCreateKind(null);
          invalidate();
        }}
      />
    </div>
  );
}

function OperationsFilters({
  value,
  onChange,
  assignees,
  ru,
  maintenance=false,
}: {
  value: Record<string, string>;
  onChange: (next: any) => void;
  assignees: Assignee[];
  ru: boolean;
  maintenance?:boolean;
}) {
  const field = (key: string, options: Array<[string, string]>) => (
    <select
      aria-label={options[0]?.[1]}
      value={value[key] ?? ''}
      onChange={(e) => onChange({ ...value, [key]: e.target.value })}
      className="rounded-lg border border-gray-200 bg-white px-2 py-2 text-xs"
    >
      <option value="">{options[0]?.[1]}</option>
      {options.slice(1).map(([v, label]) => (
        <option key={v} value={v}>
          {label}
        </option>
      ))}
    </select>
  );
  return (
    <div className="mb-4 grid grid-cols-2 gap-2 rounded-xl bg-white p-3 shadow-sm md:grid-cols-3 xl:grid-cols-6">
      {field('department', [
        ['', ru ? 'Все службы' : 'All departments'],
        ['front_desk', ru ? 'Ресепшен' : 'Front Desk'],
        ['housekeeping', ru ? 'Служба уборки' : 'Housekeeping'],
        ['maintenance', ru ? 'Техническая служба' : 'Maintenance'],
        ['spa', 'SPA'],
        ['restaurant', ru ? 'Ресторан' : 'Restaurant'],
      ])}
      {field('priority', [
        ['', ru ? 'Все приоритеты' : 'All priorities'],
        ['low', ru ? 'Низкий' : 'Low'],
        ['normal', ru ? 'Обычный' : 'Normal'],
        ['high', ru ? 'Высокий' : 'High'],
        ['critical', ru ? 'Критичный' : 'Critical'],
      ])}
      {field('sla', [
        ['', 'SLA'],
        ['overdue', ru ? 'Просрочено' : 'Overdue'],
      ])}
      <select
        value={value.assignee ?? ''}
        onChange={(e) => onChange({ ...value, assignee: e.target.value })}
        className="rounded-lg border border-gray-200 bg-white px-2 py-2 text-xs"
      >
        <option value="">{ru ? 'Все ответственные' : 'All assignees'}</option>
        {assignees.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
      {field('status', [
        ['', ru ? 'Все статусы' : 'All statuses'],
        ['open', operationLabel('open', ru)],
        ['assigned', operationLabel('assigned', ru)],
        ['in_progress', operationLabel('in_progress', ru)],
        ['waiting_parts', operationLabel('waiting_parts', ru)],
        ...(maintenance?[]:[['completed', operationLabel('completed', ru)] as [string,string]]),
        ['resolved', operationLabel('resolved', ru)],
        ['closed', operationLabel('closed', ru)],
      ])}
      {maintenance ? <select aria-label="Категория ремонта" value={value.type??''} onChange={e=>onChange({...value,type:e.target.value})} className="rounded-lg border border-gray-200 px-2 py-2 text-xs"><option value="">Все категории</option>{['hvac','plumbing','electrical','furniture','appliance','internet','lighting','bathroom','safety','other'].map(category=><option key={category} value={category}>{operationLabel(category,ru)}</option>)}</select> : <input
        value={value.type ?? ''}
        onChange={(e) => onChange({ ...value, type: e.target.value })}
        placeholder={ru ? 'Тип / категория' : 'Type / category'}
        className="rounded-lg border border-gray-200 px-2 py-2 text-xs"
      />}
    </div>
  );
}

function AttentionQueue({ items, ru }: { items: Attention[]; ru: boolean }) {
  return (
    <div className="space-y-3">
      {items.map((item) => (
        <a
          key={`${item.type}-${item.id}`}
          href={item.href}
          className="block bg-white rounded-xl shadow-sm p-4 border-l-4 border-l-amber-400 hover:ring-2 hover:ring-telivity-teal/20"
        >
          <div className="flex flex-wrap items-center gap-2">
            <Priority value={item.priority} ru={ru} />
            <p className="font-semibold text-telivity-navy">{item.title}</p>
            {item.dueAt && <Sla deadline={item.dueAt} ru={ru} />}
            <span className="ml-auto text-xs text-telivity-teal">→</span>
          </div>
          <p className="text-sm text-telivity-slate mt-2">{item.description}</p>
          {item.assignee && (
            <p className="text-xs text-telivity-mid-grey mt-1">
              {ru ? 'Ответственный' : 'Assignee'}: {item.assignee}
            </p>
          )}
        </a>
      ))}
      {items.length === 0 && (
        <Empty
          text={
            ru
              ? 'Очередь пуста — критичных отклонений нет'
              : 'Queue is clear — no actionable exceptions'
          }
        />
      )}
    </div>
  );
}

function PreArrival({ arrivals, ru, currencyCode, onTask }: any) {
  const labels: Record<string, [string, string]> = {
    roomAssigned: ['Номер назначен', 'Room assigned'],
    roomOperational: ['Номер исправен', 'Room operational'],
    housekeepingReady: [
      'Уборка и проверка завершены',
      'Housekeeping ready / inspected',
    ],
    depositReceived: ['Предоплата получена', 'Deposit received'],
    guestInformationComplete: [
      'Данные гостя заполнены',
      'Guest information complete',
    ],
    hasSpecialRequests: [
      'Особые пожелания учтены',
      'Special requests reviewed',
    ],
    extrasBooked: ['Доп. услуги проверены', 'Booked extras reviewed'],
    operationalTasksComplete: [
      'Операционные задачи закрыты',
      'Operational tasks complete',
    ],
  };
  return (
    <div className="grid lg:grid-cols-2 gap-4">
      {arrivals.map((a: any) => (
        <div
          key={a.reservationId}
          className="bg-white rounded-xl shadow-sm p-5"
        >
          <div className="flex items-start gap-3">
            <div className="flex-1">
              <p className="font-semibold text-telivity-navy">
                {a.guestName}{' '}
                {a.vipLevel !== 'none' && (
                  <span className="text-amber-600">VIP</span>
                )}
              </p>
              <p className="text-xs text-telivity-mid-grey">
                {a.propertyName} ·{' '}
                {a.roomNumber ?? (ru ? 'номер не назначен' : 'unassigned')} ·{' '}
                {a.arrivalDate}{' '}
                {typeof a.arrivalTime === 'string'
                  ? a.arrivalTime.slice(0, 5)
                  : ''}
              </p>
            </div>
            <StatusBadge status={a.roomStatus ?? 'pending'} />
          </div>
          <div className="mt-4 space-y-2">
            {Object.entries(a.checks).map(([key, ok]) => (
              <div key={key} className="flex items-center gap-2 text-sm">
                {ok ? (
                  <CheckCircle2 size={15} className="text-emerald-600" />
                ) : (
                  <XCircle size={15} className="text-amber-600" />
                )}
                <span
                  className={
                    ok
                      ? 'text-telivity-slate'
                      : 'font-medium text-telivity-navy'
                  }
                >
                  {labels[key]?.[ru ? 0 : 1] ?? key}
                  {key === 'depositReceived' && ok
                    ? ` · ${formatMoney(a.checks.depositAmount, a.currencyCode ?? currencyCode)}`
                    : ''}
                </span>
              </div>
            ))}
          </div>
          {a.notes && (
            <p className="mt-3 rounded-lg bg-amber-50 p-2 text-xs text-amber-900">
              {a.notes}
            </p>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <a
              href={a.actions.reservation}
              className="text-xs font-semibold text-telivity-teal"
            >
              {ru ? 'Открыть бронь' : 'Open reservation'}
            </a>
            <a
              href={a.actions.guest}
              className="text-xs font-semibold text-telivity-teal"
            >
              {ru ? 'Открыть гостя' : 'Open guest'}
            </a>
            {onTask && (
              <button
                onClick={() => onTask(a.reservationId)}
                className="text-xs font-semibold text-telivity-teal"
              >
                {ru ? 'Назначить задачу' : 'Assign task'}
              </button>
            )}
          </div>
        </div>
      ))}
      {arrivals.length === 0 && (
        <Empty
          text={
            ru
              ? 'Заездов в выбранном периоде нет'
              : 'No arrivals in the selected period'
          }
        />
      )}
    </div>
  );
}

function TaskList({
  tasks,
  assignees,
  ru,
  onUpdate,
  onHandoff,
  handoffPending,
}: {
  tasks: Task[];
  assignees: Assignee[];
  ru: boolean;
  onUpdate: (id: string, body: any) => void;
  onHandoff: (id: string) => void;
  handoffPending: boolean;
}) {
  return (
    <div className="space-y-3">
      {tasks.map((task) => (
        <div key={task.id} className="rounded-xl bg-white p-4 shadow-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Priority
              value={
                ['low', 'normal', 'high', 'critical'][task.priority] ?? 'normal'
              }
              ru={ru}
            />
            <p className="font-semibold text-telivity-navy">{task.title}</p>
            <StatusBadge
              status={task.status}
              label={operationLabel(task.status, ru)}
            />
            {task.slaDeadline && <Sla deadline={task.slaDeadline} ru={ru} />}
          </div>
          <p className="mt-2 text-sm text-telivity-slate">{task.description}</p>
          {task.coordinationWarning && (
            <p role="alert" className="mt-2 text-xs text-amber-800">
              {task.coordinationWarning}
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            {task.linkedOperation ? (
              <a
                href={task.linkedOperation.href}
                className="rounded-lg border px-3 py-2 text-xs font-semibold text-telivity-teal"
              >
                {task.linkedOperation.kind === 'maintenance'
                  ? 'Открыть заявку ремонта'
                  : 'Открыть задачу уборки'}{' '}
                →
              </a>
            ) : (
              <>
                <select
                  aria-label="Ответственный запроса"
                  value={task.assigneeId ?? ''}
                  onChange={(e) =>
                    onUpdate(task.id, { assigneeId: e.target.value || null })
                  }
                  className="rounded-lg border px-2 py-2 text-xs"
                >
                  <option value="">{ru ? 'Не назначено' : 'Unassigned'}</option>
                  {assignees.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Статус запроса"
                  value={task.status}
                  onChange={(e) =>
                    onUpdate(task.id, { status: e.target.value })
                  }
                  className="rounded-lg border px-2 py-2 text-xs"
                >
                  {[
                    'open',
                    'assigned',
                    'in_progress',
                    'completed',
                    'cancelled',
                  ].map((s) => (
                    <option key={s} value={s}>
                      {operationLabel(s, ru)}
                    </option>
                  ))}
                </select>
                {!['completed', 'done', 'cancelled'].includes(task.status) &&
                  [
                    'maintenance',
                    'technical_problem',
                    'housekeeping',
                    'turndown',
                    'deep_clean',
                    'checkout',
                    'stayover',
                    'inspection',
                    'extra_towel',
                    'extra_blanket',
                  ].includes(task.type) && (
                    <button
                      disabled={handoffPending}
                      onClick={() => onHandoff(task.id)}
                      className="rounded-lg border px-3 py-2 text-xs font-semibold text-telivity-teal"
                    >
                      Передать службе
                    </button>
                  )}
              </>
            )}
            {task.reservationId && (
              <a
                href={`/reservations/${task.reservationId}`}
                className="px-2 py-2 text-xs text-telivity-teal"
              >
                {ru ? 'Бронь →' : 'Reservation →'}
              </a>
            )}
          </div>
        </div>
      ))}
      {tasks.length === 0 && (
        <Empty text={ru ? 'Задач пока нет' : 'No tasks yet'} />
      )}
    </div>
  );
}
function MaintenanceList({
  rows,
  ru,
  onOpen,
}: {
  rows: TicketRow[];
  ru: boolean;
  onOpen: (id: string) => void;
}) {
  return (
    <div className="space-y-3">
      {rows.map(({ ticket: t, roomNumber, assigneeName }) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onOpen(t.id)}
          className="w-full rounded-xl bg-white p-4 text-left shadow-sm focus-visible:ring-2 focus-visible:ring-telivity-teal"
        >
          <div className="flex flex-wrap items-center gap-2">
            <Priority value={t.priority} ru={ru} />
            <p className="min-w-0 break-words font-semibold text-telivity-navy">
              {roomNumber ? `${roomNumber} · ` : ''}
              {t.title}
            </p>
            <StatusBadge
              status={t.status}
              label={operationLabel(t.status, ru)}
            />
            {t.slaDeadline && <Sla deadline={t.slaDeadline} ru={ru} />}
          </div>
          <p className="mt-2 line-clamp-2 text-sm text-telivity-slate">
            {t.description}
          </p>
          <div className="mt-3 flex flex-wrap gap-2 text-xs text-telivity-mid-grey">
            <span>{assigneeName ?? 'Ответственный не назначен'}</span>
            {t.returnToServiceRequired && (
              <span className="text-amber-800">
                Нужна проверка возврата номера
              </span>
            )}
            <span className="ml-auto font-semibold text-telivity-teal">
              Открыть заявку →
            </span>
          </div>
        </button>
      ))}
      {rows.length === 0 && (
        <Empty
          text={ru ? 'Заявок на ремонт пока нет' : 'No maintenance tickets yet'}
        />
      )}
    </div>
  );
}
function CreateOperationModal({
  kind,
  onClose,
  propertyId,
  rooms,
  assignees,
  reservationId,
  ru,
  onCreated,
}: any) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [roomId, setRoomId] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const [priority, setPriority] = useState('normal');
  const [category, setCategory] = useState('other');
  const [sla, setSla] = useState('');
  const payload = useMemo(
    () => ({
      propertyId,
      title,
      description,
      roomId: roomId || undefined,
      reservationId,
      assigneeId: assigneeId || undefined,
      slaDeadline: sla ? new Date(sla).toISOString() : undefined,
    }),
    [propertyId, title, description, roomId, reservationId, assigneeId, sla],
  );
  const create = useMutation({
    mutationFn: () =>
      api.post('/v1/service-requests', {
        ...payload,
        type: category === 'other' ? 'service_request' : category,
        category,
        priority: ['low', 'normal', 'high', 'critical'].indexOf(priority),
      }),
    onSuccess: onCreated,
  });
  return (
    <Modal
      open={!!kind}
      onClose={onClose}
      title={
        kind === 'maintenance'
          ? ru
            ? 'Новая техническая заявка'
            : 'New maintenance ticket'
          : ru
            ? 'Новый запрос / задача'
            : 'New request / task'
      }
    >
      <div className="space-y-3">
        <input
          aria-label={ru ? 'Название задачи' : 'Task title'}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={
            ru ? 'Кратко: что нужно сделать?' : 'What needs to be done?'
          }
          className="w-full border rounded-lg px-3 py-2 text-sm"
        />
        <textarea
          aria-label={ru ? 'Описание' : 'Description'}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={ru ? 'Описание и контекст' : 'Description and context'}
          className="w-full border rounded-lg px-3 py-2 text-sm"
        />
        <div className="grid grid-cols-2 gap-2">
          <select
            aria-label={ru ? 'Номер' : 'Room'}
            value={roomId}
            onChange={(e) => setRoomId(e.target.value)}
            className="border rounded-lg px-2 py-2 text-sm"
          >
            <option value="">{ru ? 'Без номера' : 'No room'}</option>
            {rooms.map((r: any) => (
              <option key={r.id} value={r.id}>
                {r.number}
              </option>
            ))}
          </select>
          <select
            aria-label={ru ? 'Ответственный' : 'Assignee'}
            value={assigneeId}
            onChange={(e) => setAssigneeId(e.target.value)}
            className="border rounded-lg px-2 py-2 text-sm"
          >
            <option value="">{ru ? 'Не назначено' : 'Unassigned'}</option>
            {assignees.map((a: Assignee) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <select
            aria-label={ru ? 'Категория' : 'Category'}
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="border rounded-lg px-2 py-2 text-sm"
          >
            {[
              'maintenance',
              'turndown',
              'deep_clean',
              'late_checkout',
              'early_checkin',
              'extra_towel',
              'extra_blanket',
              'housekeeping',
              'spa_booking',
              'restaurant_request',
              'transfer',
              'breakfast',
              'technical_problem',
              'other',
            ].map((c) => (
              <option key={c} value={c}>
                {operationLabel(c, ru)}
              </option>
            ))}
          </select>
          <select
            aria-label={ru ? 'Приоритет' : 'Priority'}
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
            className="border rounded-lg px-2 py-2 text-sm"
          >
            {['low', 'normal', 'high', 'critical'].map((p) => (
              <option key={p} value={p}>
                {operationLabel(p, ru)}
              </option>
            ))}
          </select>
          <input
            aria-label={ru ? 'Срок выполнения' : 'Deadline'}
            type="datetime-local"
            value={sla}
            onChange={(e) => setSla(e.target.value)}
            className="border rounded-lg px-2 py-2 text-sm"
          />
        </div>
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="border rounded-lg px-4 py-2 text-sm"
          >
            {ru ? 'Отмена' : 'Cancel'}
          </button>
          <button
            disabled={!title.trim() || !description.trim() || create.isPending}
            onClick={() => create.mutate()}
            className="bg-telivity-teal text-white rounded-lg px-4 py-2 text-sm font-semibold"
          >
            {ru ? 'Создать' : 'Create'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Priority({ value, ru }: { value: string; ru: boolean }) {
  const labels: any = {
    low: ru ? 'Низкий' : 'Low',
    normal: ru ? 'Обычный' : 'Normal',
    high: ru ? 'Высокий' : 'High',
    critical: ru ? 'Критично' : 'Critical',
  };
  const cls =
    value === 'critical'
      ? 'bg-red-100 text-red-800'
      : value === 'high'
        ? 'bg-amber-100 text-amber-900'
        : value === 'low'
          ? 'bg-gray-100 text-gray-600'
          : 'bg-blue-50 text-blue-800';
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${cls}`}
    >
      {labels[value] ?? value}
    </span>
  );
}
function Sla({ deadline, ru }: { deadline: string; ru: boolean }) {
  const diff = new Date(deadline).getTime() - Date.now();
  const mins = Math.round(Math.abs(diff) / 60000);
  return (
    <span
      className={`inline-flex gap-1 items-center text-xs ml-auto ${diff < 0 ? 'text-red-700 font-semibold' : 'text-telivity-mid-grey'}`}
    >
      <Clock3 size={12} />
      {diff < 0
        ? ru
          ? `Просрочено на ${mins} мин`
          : `Overdue ${mins}m`
        : ru
          ? `SLA осталось ${mins} мин`
          : `SLA ${mins}m left`}
    </span>
  );
}
function Empty({ text }: { text: string }) {
  return (
    <div className="bg-white rounded-xl shadow-sm p-10 text-center text-sm text-telivity-mid-grey">
      {text}
    </div>
  );
}

function operationLabel(value: string, ru: boolean) {
  const labels: Record<string, string> = {
    open: 'Открыта',
    assigned: 'Назначена',
    in_progress: 'В работе',
    completed: 'Выполнена',
    cancelled: 'Отменена',
    waiting_parts: 'Ожидание запчастей',
    resolved: 'Решена',
    closed: 'Закрыта',
    low: 'Низкий',
    normal: 'Обычный',
    high: 'Высокий',
    critical: 'Критичный',
    hvac: 'Отопление и вентиляция',
    plumbing: 'Сантехника',
    electrical: 'Электрика',
    furniture: 'Мебель',
    appliance: 'Бытовая техника',
    internet: 'Интернет',
    lighting: 'Освещение',
    bathroom: 'Ванная',
    safety: 'Безопасность',
    other: 'Другое',
    maintenance: 'Ремонт',
    turndown: 'Вечерняя подготовка',
    deep_clean: 'Генеральная уборка',
    late_checkout: 'Поздний выезд',
    early_checkin: 'Ранний заезд',
    extra_towel: 'Дополнительное полотенце',
    extra_blanket: 'Дополнительное одеяло',
    housekeeping: 'Уборка',
    spa_booking: 'Запись в SPA',
    restaurant_request: 'Запрос в ресторан',
    transfer: 'Трансфер',
    breakfast: 'Завтрак',
    technical_problem: 'Техническая проблема',
  };
  return ru ? (labels[value] ?? value) : value.replace(/_/g, ' ');
}

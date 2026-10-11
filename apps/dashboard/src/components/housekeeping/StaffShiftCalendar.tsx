import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import {
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  Plus,
  X,
} from 'lucide-react';
import {
  staffShiftRecoveryKey,
  saveStaffRequest,
  clearStaffRequest,
  usePendingStaffRequest,
} from '../../lib/staff-booking-recovery';
import { api } from '../../lib/api';
import { hotelDate } from '../../lib/hotel-date';
import {
  serviceDays,
  serviceInstant,
  serviceLocalInput,
} from '../../lib/service-time';
import { errorMessage } from '../../lib/error-message';
import { useProperty } from '../../context/PropertyContext';
import { useAuth } from '../../context/AuthContext';
import Modal from '../ui/Modal';

type Shift = {
  id: string;
  userId: string;
  startAt: string;
  endAt: string;
  status: 'planned' | 'confirmed' | 'cancelled';
  breaks: { startAt: string; endAt: string }[];
  maxOpenTasks: number | null;
  notes: string | null;
  revision: number;
};
type Staff = { id: string; name: string };
type Coverage = Staff & {
  load: number;
  maxOpenTasks: number | null;
  shiftConfirmed: boolean;
  available: boolean;
  workingNow: boolean;
  onBreak: boolean;
};
type Draft = {
  userId: string;
  startAt: string;
  endAt: string;
  status: Shift['status'];
  breaks: Shift['breaks'];
  maxOpenTasks: string;
  notes: string;
};
const labels = {
  planned: 'Запланирована',
  confirmed: 'Подтверждена',
  cancelled: 'Отменена',
};
const input = 'w-full rounded-lg border border-gray-200 p-2 text-sm';
const button =
  'rounded-lg border border-gray-200 px-3 py-2 text-sm disabled:opacity-50';

export default function StaffShiftCalendar() {
  const { propertyId, properties, isPortfolioMode } = useProperty();
  const { hasPermission, user } = useAuth();
  const canManage = hasPermission('housekeeping.manage');
  const zone = properties.find((p) => p.id === propertyId)?.timezone || 'UTC';
  const [params, setParams] = useSearchParams();
  const date = params.get('shiftDate') || hotelDate(zone);
  const setDate = (value: string) =>
    setParams((p) => {
      p.set('shiftDate', value);
      return p;
    });
  const rawView = params.get('shiftView');
  const view: 'day' | 'week' | 'month' =
    rawView === 'day' || rawView === 'month' ? rawView : 'week';
  const setView = (value: string) =>
    setParams((p) => {
      p.set('shiftView', value);
      return p;
    });
  const staffFilter = params.get('shiftStaff') || '';
  const setStaffFilter = (value: string) =>
    setParams((p) => {
      if (value) {
        p.set('shiftStaff', value);
      } else {
        p.delete('shiftStaff');
      }
      return p;
    });
  const [page, setPage] = useState(0);
  const [editor, setEditor] = useState<{
    id?: string;
    revision?: number;
    draft: Draft;
  } | null>(null);
  const [request, setRequest] = useState<{
    id?: string;
    body: Record<string, unknown>;
  } | null>(null);
  const [localError, setLocalError] = useState('');
  const queryClient = useQueryClient();
  const recoveryKey = staffShiftRecoveryKey(
    user?.sub ?? 'demo',
    propertyId ?? 'none',
  );
  const pending = usePendingStaffRequest(recoveryKey);
  const [recoveryNotice, setRecoveryNotice] = useState('');
  const recover = useMutation({
    mutationFn: (close: boolean) =>
      close
        ? api.post('/v1/housekeeping/shift-request/close', {
            propertyId,
            idempotencyKey: pending,
          })
        : api.get('/v1/housekeeping/shift-request', {
            params: { propertyId, idempotencyKey: pending },
          }),
    onSuccess: (r) => {
      if (r.data.state === 'unconfirmed') {
        setRecoveryNotice(
          'Сервер пока не подтвердил запрос. Закройте его перед созданием новой смены.',
        );
        return;
      }
      clearStaffRequest(recoveryKey, pending!);
      setRequest(null);
      setEditor(null);
      setRecoveryNotice(
        r.data.state === 'committed'
          ? 'Исходный запрос принят: смена сохранена.'
          : 'Запрос закрыт: поздний повтор не создаст смену.',
      );
      queryClient.invalidateQueries({ queryKey: ['housekeeping'] });
    },
  });
  const days = useMemo(
    () =>
      view === 'month'
        ? serviceDays(
            date.slice(0, 7) + '-01',
            new Date(
              Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)), 0),
            ).getUTCDate(),
          )
        : serviceDays(date, view === 'week' ? 7 : 1),
    [date, view],
  );
  const range = useMemo(() => {
    try {
      return {
        startAt: serviceInstant(days[0] + 'T00:00', zone),
        endAt: serviceInstant(
          serviceDays(days[days.length - 1]!, 2)[1] + 'T00:00',
          zone,
        ),
      };
    } catch {
      return null;
    }
  }, [days, zone]);
  const enabled = !!propertyId && !isPortfolioMode;
  const identityQuery = useQuery({
    queryKey: ['housekeeping', 'identity', propertyId],
    queryFn: () =>
      api
        .get('/v1/housekeeping/identity', { params: { propertyId } })
        .then((r) => r.data as { staffId: string | null; canManage: boolean }),
    enabled: enabled && !canManage,
  });
  const historyQuery = useQuery({
    queryKey: ['housekeeping', 'shift-history', propertyId, editor?.id],
    queryFn: () =>
      api
        .get('/v1/housekeeping/shifts/' + editor!.id + '/history', {
          params: { propertyId },
        })
        .then(
          (r) =>
            r.data as {
              action: string;
              occurredAt: string;
              authorName: string | null;
              next: Shift | null;
            }[],
        ),
    enabled: enabled && !!editor?.id,
  });
  const staffQuery = useQuery({
    queryKey: ['housekeeping', 'staff', propertyId],
    queryFn: () =>
      api
        .get('/v1/housekeeping/staff', { params: { propertyId } })
        .then((r) => r.data as Staff[]),
    enabled,
  });
  const shiftsQuery = useQuery({
    queryKey: ['housekeeping', 'shifts', propertyId, range, staffFilter],
    queryFn: () =>
      api
        .get('/v1/housekeeping/shifts', {
          params: {
            propertyId,
            ...range,
            userId: canManage && staffFilter ? staffFilter : undefined,
          },
        })
        .then((r) => r.data as Shift[]),
    enabled: enabled && !!range,
  });
  const coverageQuery = useQuery({
    queryKey: ['housekeeping', 'staff-availability', propertyId, date],
    queryFn: () =>
      api
        .get('/v1/housekeeping/staff-availability', {
          params: { propertyId, serviceDate: date },
        })
        .then((r) => r.data as Coverage[]),
    enabled: enabled && canManage,
    refetchInterval: 60000,
  });
  const staff = (staffQuery.data ?? []).filter(
    (u) => canManage || u.id === identityQuery.data?.staffId,
  );
  const shifts = shiftsQuery.data ?? [];
  const filteredStaff = staff.filter(
    (s) => !staffFilter || s.id === staffFilter,
  );
  const visible = filteredStaff.slice(page * 24, (page + 1) * 24);
  const save = useMutation({
    mutationFn: (r: { id?: string; body: Record<string, unknown> }) =>
      r.id
        ? api.patch('/v1/housekeeping/shifts/' + r.id, r.body)
        : api.post('/v1/housekeeping/shifts', r.body),
    onSuccess: () => {
      if (request)
        clearStaffRequest(recoveryKey, String(request.body.idempotencyKey));
      setRequest(null);
      setEditor(null);
      queryClient.invalidateQueries({ queryKey: ['housekeeping'] });
    },
  });
  const shiftDay = (s: Shift, d: string) =>
    serviceLocalInput(s.startAt, zone).slice(0, 10) <= d &&
    serviceLocalInput(new Date(Date.parse(s.endAt) - 1), zone).slice(0, 10) >=
      d;
  const open = (
    shift?: Shift,
    day = date,
    userId = staffFilter || staff[0]?.id || '',
  ) => {
    setLocalError('');
    setRequest(null);
    save.reset();
    setEditor({
      id: shift?.id,
      revision: shift?.revision,
      draft: shift
        ? {
            ...shift,
            startAt: serviceLocalInput(shift.startAt, zone),
            endAt: serviceLocalInput(shift.endAt, zone),
            breaks: shift.breaks.map((b) => ({
              startAt: serviceLocalInput(b.startAt, zone),
              endAt: serviceLocalInput(b.endAt, zone),
            })),
            maxOpenTasks: String(shift.maxOpenTasks ?? ''),
            notes: shift.notes ?? '',
          }
        : {
            userId,
            startAt: day + 'T09:00',
            endAt: day + 'T18:00',
            status: 'planned',
            breaks: [],
            maxOpenTasks: '',
            notes: '',
          },
    });
  };
  const submit = () => {
    if (request) {
      save.mutate(request);
      return;
    }
    if (!editor) return;
    try {
      const d = editor.draft;
      const r = {
        id: editor.id,
        body: {
          propertyId,
          userId: d.userId,
          startAt: serviceInstant(d.startAt, zone),
          endAt: serviceInstant(d.endAt, zone),
          status: d.status,
          breaks: d.breaks.map((b) => ({
            startAt: serviceInstant(b.startAt, zone),
            endAt: serviceInstant(b.endAt, zone),
          })),
          ...(d.maxOpenTasks ? { maxOpenTasks: Number(d.maxOpenTasks) } : {}),
          notes: d.notes,
          idempotencyKey: crypto.randomUUID(),
          ...(editor.revision ? { expectedRevision: editor.revision } : {}),
        },
      };
      if (!saveStaffRequest(recoveryKey, String(r.body.idempotencyKey)))
        throw new Error(
          'Не удалось сохранить ключ восстановления. Разрешите хранилище браузера перед отправкой.',
        );
      setRequest(r);
      setLocalError('');
      save.mutate(r, {
        onError: (err: any) => {
          if (err.response?.status >= 400 && err.response?.status < 500) {
            clearStaffRequest(recoveryKey, String(r.body.idempotencyKey));
            setRequest(null);
          }
        },
      });
    } catch (err) {
      setLocalError(
        err instanceof Error ? err.message : 'Проверьте поля смены.',
      );
    }
  };
  const edit = (value: Partial<Draft>) =>
    setEditor((e) => (e ? { ...e, draft: { ...e.draft, ...value } } : null));
  const shiftCard = (s: Shift) => (
    <button
      type="button"
      key={s.id}
      disabled={!!pending}
      onClick={() => open(s)}
      className={
        'mb-1 block w-full rounded-lg border p-2 text-left text-xs ' +
        (s.status === 'confirmed'
          ? 'border-teal-200 bg-teal-50'
          : s.status === 'cancelled'
            ? 'border-gray-200 bg-gray-50 text-gray-500'
            : 'border-amber-200 bg-amber-50')
      }
      aria-label={
        'Смена ' +
        (staff.find((u) => u.id === s.userId)?.name ?? 'сотрудника') +
        ' ' +
        labels[s.status]
      }
    >
      <span className="block font-semibold">
        {serviceLocalInput(s.startAt, zone).slice(11)} —{' '}
        {serviceLocalInput(s.endAt, zone).slice(11)}
        {serviceLocalInput(s.startAt, zone).slice(0, 10) !==
        serviceLocalInput(s.endAt, zone).slice(0, 10)
          ? ' (+1 день)'
          : ''}
      </span>
      <span className="block">{labels[s.status]}</span>
      {s.breaks.length > 0 && (
        <span className="block">
          Перерывы:{' '}
          {s.breaks
            .map(
              (b) =>
                serviceLocalInput(b.startAt, zone).slice(11) +
                '–' +
                serviceLocalInput(b.endAt, zone).slice(11),
            )
            .join(', ')}
        </span>
      )}
    </button>
  );
  if (!enabled)
    return (
      <p className="p-6 text-gray-500">Выберите объект для календаря смен.</p>
    );
  return (
    <div className="space-y-4">
      {canManage && pending && (
        <div
          className="space-y-2 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm"
          role="status"
        >
          <p>
            Есть запрос смены без подтверждённого ответа. Новые изменения
            доступны после проверки исходного запроса.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              className={button}
              disabled={recover.isPending}
              onClick={() => recover.mutate(false)}
            >
              Проверить результат
            </button>
            <button
              className={button}
              disabled={recover.isPending}
              onClick={() => recover.mutate(true)}
            >
              Закрыть неподтверждённый запрос
            </button>
          </div>
          {recover.isError && <p role="alert">{errorMessage(recover.error)}</p>}
        </div>
      )}
      {recoveryNotice && (
        <p className="rounded-lg bg-teal-50 p-3 text-sm" role="status">
          {recoveryNotice}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <CalendarClock className="text-telivity-teal" />
        <h2 className="mr-auto font-semibold">Календарь смен</h2>
        <span className="text-xs text-gray-500">Время объекта: {zone}</span>
        {canManage && (
          <button
            type="button"
            className="flex gap-1 rounded-lg bg-telivity-teal px-3 py-2 text-sm text-white"
            onClick={() => open()}
            disabled={!staff.length || !!pending}
          >
            <Plus size={16} />
            Новая смена
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          className={button}
          aria-label="Предыдущий период"
          onClick={() => {
            setDate(
              view === 'month'
                ? new Date(
                    Date.UTC(
                      Number(date.slice(0, 4)),
                      Number(date.slice(5, 7)) - 2,
                      1,
                    ),
                  )
                    .toISOString()
                    .slice(0, 10)
                : new Date(
                    Date.parse(date + 'T12:00Z') -
                      (view === 'week' ? 7 : 1) * 86400000,
                  )
                    .toISOString()
                    .slice(0, 10),
            );
            setPage(0);
          }}
        >
          <ChevronLeft size={16} />
        </button>
        <input
          aria-label="Дата календаря смен"
          type="date"
          className={button}
          value={date}
          onChange={(e) => {
            if (e.target.value) setDate(e.target.value);
          }}
        />
        <button
          className={button}
          aria-label="Следующий период"
          onClick={() =>
            setDate(
              view === 'month'
                ? new Date(
                    Date.UTC(
                      Number(date.slice(0, 4)),
                      Number(date.slice(5, 7)),
                      1,
                    ),
                  )
                    .toISOString()
                    .slice(0, 10)
                : serviceDays(date, view === 'week' ? 8 : 2).at(-1)!,
            )
          }
        >
          <ChevronRight size={16} />
        </button>
        {(['day', 'week', 'month'] as const).map((v) => (
          <button
            key={v}
            aria-pressed={view === v}
            className={
              button + (view === v ? ' bg-telivity-teal text-white' : '')
            }
            onClick={() => setView(v)}
          >
            {{ day: 'День', week: 'Неделя', month: 'Месяц' }[v]}
          </button>
        ))}
        <select
          aria-label="Сотрудник календаря смен"
          className={button}
          value={staffFilter}
          onChange={(e) => {
            setStaffFilter(e.target.value);
            setPage(0);
          }}
        >
          <option value="">Все сотрудники</option>
          {staff.map((s) => (
            <option value={s.id} key={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>
      {(shiftsQuery.isError || staffQuery.isError || !range) && (
        <p
          role="alert"
          className="rounded-lg bg-red-50 p-3 text-sm text-red-700"
        >
          {!range
            ? 'Граница даты неоднозначна в часовом поясе объекта. Выберите другой период.'
            : errorMessage(shiftsQuery.error ?? staffQuery.error)}{' '}
          <button
            className="underline"
            onClick={() => {
              shiftsQuery.refetch();
              staffQuery.refetch();
            }}
          >
            Повторить
          </button>
        </p>
      )}
      {shiftsQuery.isPending ? (
        <p role="status">Загрузка смен…</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border bg-white">
          <table className="w-full text-sm">
            <caption className="sr-only">
              Рабочие смены и перерывы сотрудников
            </caption>
            <thead>
              <tr>
                <th className="sticky left-0 z-10 min-w-40 border-b bg-white p-3 text-left">
                  Сотрудник
                </th>
                {days.map((d) => (
                  <th key={d} className="min-w-36 border-b p-2 text-left">
                    <span>
                      {new Intl.DateTimeFormat('ru', {
                        day: 'numeric',
                        month: 'short',
                        weekday: 'short',
                        timeZone: 'UTC',
                      }).format(new Date(d + 'T12:00Z'))}
                    </span>
                    {canManage && (
                      <button
                        className="ml-1 text-teal-700"
                        aria-label={'Добавить смену на ' + d}
                        disabled={!!pending}
                        onClick={() => open(undefined, d)}
                      >
                        +
                      </button>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((u) => (
                <tr key={u.id}>
                  <th
                    scope="row"
                    className="sticky left-0 border-b bg-white p-3 text-left font-medium"
                  >
                    {u.name}
                  </th>
                  {days.map((d) => (
                    <td key={d} className="border-b p-2 align-top">
                      {shifts
                        .filter((s) => s.userId === u.id && shiftDay(s, d))
                        .map(shiftCard)}
                      {canManage && (
                        <button
                          className="text-xs text-gray-500 hover:underline"
                          disabled={!!pending}
                          onClick={() => open(undefined, d, u.id)}
                          aria-label={'Добавить смену: ' + u.name + ', ' + d}
                        >
                          Добавить
                        </button>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {!visible.length && (
            <p className="p-6 text-gray-500">
              Нет доступных сотрудников. Проверьте их права в этом объекте.
            </p>
          )}
        </div>
      )}
      {filteredStaff.length > 24 && (
        <div className="flex gap-3">
          <button
            className={button}
            disabled={page === 0}
            onClick={() => setPage((p) => p - 1)}
          >
            Назад
          </button>
          <span>
            Сотрудники {page * 24 + 1}–
            {Math.min((page + 1) * 24, filteredStaff.length)} из{' '}
            {filteredStaff.length}
          </span>
          <button
            className={button}
            disabled={(page + 1) * 24 >= filteredStaff.length}
            onClick={() => setPage((p) => p + 1)}
          >
            Далее
          </button>
        </div>
      )}
      {canManage && (
        <div className="rounded-xl border bg-white p-4">
          <h3 className="mb-2 font-semibold">Назначение уборки на {date}</h3>
          <p className="mb-3 text-xs text-gray-500">
            Учитываются подтверждённые рабочие интервалы без перерывов и
            незавершённые задачи, включая ожидание инспекции. Завершившиеся
            смены не получают новые задачи. В нескольких сменах применяется
            наименьший заданный лимит. Длительность задач не рассчитывается без
            норматива.
          </p>
          {coverageQuery.isError ? (
            <p role="alert">{errorMessage(coverageQuery.error)}</p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {coverageQuery.data?.map((u) => (
                <div key={u.id} className="rounded-lg border p-3 text-sm">
                  <b>{u.name}</b>
                  <p>
                    Незавершённые задачи: {u.load}
                    {u.maxOpenTasks != null ? ' / ' + u.maxOpenTasks : ''}
                  </p>
                  <p
                    className={u.available ? 'text-teal-700' : 'text-amber-700'}
                  >
                    {!u.shiftConfirmed
                      ? 'Смена не подтверждена'
                      : u.onBreak
                        ? 'Сейчас перерыв'
                        : u.workingNow
                          ? 'Сотрудник на смене'
                          : u.available
                            ? 'Смена впереди'
                            : 'Нет доступного рабочего времени или достигнут лимит'}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <Modal
        open={!!editor}
        onClose={() => {
          if (!save.isPending) setEditor(null);
        }}
        closeDisabled={save.isPending}
        title={editor?.id ? 'Рабочая смена' : 'Новая рабочая смена'}
        wide
      >
        {editor && (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <fieldset
              disabled={!canManage || save.isPending || !!request}
              className="grid gap-3 sm:grid-cols-2"
            >
              <label className="text-sm">
                Сотрудник
                <select
                  required
                  className={input}
                  value={editor.draft.userId}
                  onChange={(e) => edit({ userId: e.target.value })}
                >
                  <option value="">Выберите сотрудника</option>
                  {staff.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-sm">
                Статус
                <select
                  className={input}
                  value={editor.draft.status}
                  onChange={(e) =>
                    edit({ status: e.target.value as Shift['status'] })
                  }
                >
                  {Object.entries(labels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-sm">
                Начало смены
                <input
                  type="datetime-local"
                  required
                  className={input}
                  value={editor.draft.startAt}
                  onInput={(e) => edit({ startAt: e.currentTarget.value })}
                  onChange={(e) => edit({ startAt: e.target.value })}
                />
              </label>
              <label className="text-sm">
                Конец смены
                <input
                  type="datetime-local"
                  required
                  className={input}
                  value={editor.draft.endAt}
                  onInput={(e) => edit({ endAt: e.currentTarget.value })}
                  onChange={(e) => edit({ endAt: e.target.value })}
                />
              </label>
              <div className="sm:col-span-2">
                <p className="mb-2 text-sm font-medium">Перерывы</p>
                {editor.draft.breaks.map((b, i) => (
                  <div key={i} className="mb-2 flex flex-wrap gap-2">
                    <input
                      aria-label={'Начало перерыва ' + (i + 1)}
                      type="datetime-local"
                      required
                      className={input + ' flex-1'}
                      value={b.startAt}
                      onInput={(e) => {
                        const value = e.currentTarget.value;
                        edit({
                          breaks: editor.draft.breaks.map((v, j) =>
                            j === i ? { ...v, startAt: value } : v,
                          ),
                        });
                      }}
                      onChange={(e) =>
                        edit({
                          breaks: editor.draft.breaks.map((v, j) =>
                            j === i ? { ...v, startAt: e.target.value } : v,
                          ),
                        })
                      }
                    />
                    <input
                      aria-label={'Конец перерыва ' + (i + 1)}
                      type="datetime-local"
                      required
                      className={input + ' flex-1'}
                      value={b.endAt}
                      onInput={(e) => {
                        const value = e.currentTarget.value;
                        edit({
                          breaks: editor.draft.breaks.map((v, j) =>
                            j === i ? { ...v, endAt: value } : v,
                          ),
                        });
                      }}
                      onChange={(e) =>
                        edit({
                          breaks: editor.draft.breaks.map((v, j) =>
                            j === i ? { ...v, endAt: e.target.value } : v,
                          ),
                        })
                      }
                    />
                    <button
                      type="button"
                      aria-label={'Удалить перерыв ' + (i + 1)}
                      onClick={() =>
                        edit({
                          breaks: editor.draft.breaks.filter((_, j) => j !== i),
                        })
                      }
                    >
                      <X size={18} />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className={button}
                  disabled={editor.draft.breaks.length >= 20}
                  onClick={() =>
                    edit({
                      breaks: [
                        ...editor.draft.breaks,
                        {
                          startAt: editor.draft.startAt,
                          endAt: editor.draft.startAt,
                        },
                      ],
                    })
                  }
                >
                  Добавить перерыв
                </button>
              </div>
              <label className="text-sm">
                Лимит незавершённых задач на дату
                <input
                  className={input}
                  type="number"
                  min="1"
                  max="1000"
                  value={editor.draft.maxOpenTasks}
                  onChange={(e) => edit({ maxOpenTasks: e.target.value })}
                />
                <span className="text-xs text-gray-500">
                  Пусто — руководитель не задал лимит.
                </span>
              </label>
              <label className="text-sm">
                Примечание
                <textarea
                  maxLength={2000}
                  className={input}
                  value={editor.draft.notes}
                  onChange={(e) => edit({ notes: e.target.value })}
                />
              </label>
            </fieldset>
            <p className="text-xs text-gray-500">
              Время: {zone}. Отмена смены сохраняет историю и уже назначенные
              задачи: переназначьте их явно. Оплата труда и нормативы
              длительности уборки здесь не рассчитываются.
            </p>
            {editor.id && (
              <section className="rounded-lg border p-3">
                <h3 className="mb-2 font-semibold">История смены</h3>
                {historyQuery.isError ? (
                  <p role="alert">{errorMessage(historyQuery.error)}</p>
                ) : historyQuery.isPending ? (
                  <p>Загрузка истории…</p>
                ) : (
                  <ol className="max-h-48 space-y-2 overflow-y-auto text-sm">
                    {historyQuery.data?.map((entry, i) => (
                      <li key={i}>
                        <b>
                          {entry.action === 'create' ? 'Создана' : 'Изменена'}
                        </b>{' '}
                        ·{' '}
                        {new Intl.DateTimeFormat('ru', {
                          timeZone: zone,
                          dateStyle: 'short',
                          timeStyle: 'short',
                        }).format(new Date(entry.occurredAt))}{' '}
                        · {entry.authorName ?? 'Автор не подтверждён'}
                        {entry.next && (
                          <p>
                            {labels[entry.next.status]} · Редакция{' '}
                            {entry.next.revision} ·{' '}
                            {serviceLocalInput(
                              entry.next.startAt,
                              zone,
                            ).replace('T', ' ')}{' '}
                            —{' '}
                            {serviceLocalInput(entry.next.endAt, zone).replace(
                              'T',
                              ' ',
                            )}
                          </p>
                        )}
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            )}
            {(localError || save.isError) && (
              <p
                role="alert"
                className="rounded-lg bg-red-50 p-3 text-sm text-red-700"
              >
                {localError || errorMessage(save.error)}
              </p>
            )}
            {request && save.isError && (
              <p className="text-sm">
                Ответ не подтверждён. Повторите исходный запрос с тем же ключом;
                поля остаются зафиксированы.
              </p>
            )}
            {canManage && (
              <button
                type="submit"
                className="rounded-lg bg-telivity-teal px-4 py-2 text-white disabled:opacity-50"
                disabled={save.isPending}
              >
                {save.isPending
                  ? 'Сохранение…'
                  : request && save.isError
                    ? 'Повторить исходный запрос'
                    : 'Сохранить смену'}
              </button>
            )}
          </form>
        )}
      </Modal>
    </div>
  );
}

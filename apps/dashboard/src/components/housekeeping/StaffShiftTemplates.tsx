import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/error-message';
import {
  saveStaffRequest,
  clearStaffRequest,
} from '../../lib/staff-booking-recovery';
import Modal from '../ui/Modal';
type Template = {
  id: string;
  revision: number;
  userId: string;
  name: string;
  weekdays: number[];
  startTime: string;
  endTime: string;
  overnight: number;
  maxOpenTasks?: number | null;
  notes?: string | null;
};
type Props = {
  propertyId: string;
  staff: { id: string; name: string }[];
  date: string;
  recoveryKey: string;
  pending: string | null;
};
const weekdays = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const input = 'w-full rounded-lg border p-2 text-sm';
const button = 'rounded-lg border px-3 py-2 text-sm disabled:opacity-50';
export default function StaffShiftTemplates({
  propertyId,
  staff,
  date,
  recoveryKey,
  pending,
}: Props) {
  const cache = useQueryClient();
  const templates = useQuery({
    queryKey: ['housekeeping', 'shift-templates', propertyId],
    queryFn: () =>
      api
        .get('/v1/housekeeping/shift-templates', { params: { propertyId } })
        .then((r) => r.data as Template[]),
  });
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Partial<Template>>({
    name: '',
    userId: staff[0]?.id,
    weekdays: [1, 2, 3, 4, 5],
    startTime: '09:00',
    endTime: '18:00',
    overnight: 0,
  });
  const [range, setRange] = useState({
    startDate: date,
    endDate: date,
    status: 'planned',
  });
  const [preview, setPreview] = useState<{
    canApply: boolean;
    candidates: unknown[];
    absenceWarnings: string[];
    foreignConflict: boolean;
    conflictingShiftIds: string[];
  } | null>(null);
  const [request, setRequest] = useState<{
    path: string;
    method: 'post' | 'patch';
    body: Record<string, unknown>;
  } | null>(null);
  const [notice, setNotice] = useState('');
  const [localError, setLocalError] = useState('');
  const commit = useMutation({
    mutationFn: (r: NonNullable<typeof request>) =>
      api[r.method](r.path, r.body),
    onSuccess: (_r, sent) => {
      clearStaffRequest(recoveryKey, String(sent.body.idempotencyKey));
      setRequest(null);
      setOpen(false);
      setPreview(null);
      setNotice(
        'Операция сохранена. Созданные смены доступны в этом календаре.',
      );
      cache.invalidateQueries({ queryKey: ['housekeeping'] });
    },
    onError: (e: any, sent) => {
      if (e.response?.status >= 400 && e.response?.status < 500) {
        clearStaffRequest(recoveryKey, String(sent.body.idempotencyKey));
        setRequest(null);
      }
    },
  });
  const inspect = useMutation({
    mutationFn: () =>
      api.post('/v1/housekeeping/shift-templates/' + draft.id + '/preview', {
        propertyId,
        ...range,
        expectedRevision: draft.revision,
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: (r) => setPreview(r.data),
  });
  const change = (values: Partial<Template>) => {
    setDraft((d) => ({ ...d, ...values }));
    setPreview(null);
  };
  const begin = (t?: Template) => {
    setDraft(
      t ?? {
        name: '',
        userId: staff[0]?.id,
        weekdays: [1, 2, 3, 4, 5],
        startTime: '09:00',
        endTime: '18:00',
        overnight: 0,
      },
    );
    setPreview(null);
    setLocalError('');
    commit.reset();
    inspect.reset();
    setOpen(true);
  };
  const submit = (apply: boolean) => {
    if (request) {
      commit.mutate(request);
      return;
    }
    if (pending) return;
    const body = apply
      ? {
          propertyId,
          ...range,
          expectedRevision: draft.revision,
          idempotencyKey: crypto.randomUUID(),
        }
      : {
          propertyId,
          userId: draft.userId,
          name: draft.name,
          weekdays: draft.weekdays,
          startTime: draft.startTime,
          endTime: draft.endTime,
          overnight: draft.overnight,
          ...(draft.maxOpenTasks != null
            ? { maxOpenTasks: draft.maxOpenTasks }
            : {}),
          notes: draft.notes ?? '',
          ...(draft.id ? { expectedRevision: draft.revision } : {}),
          idempotencyKey: crypto.randomUUID(),
        };
    const sent = {
      path:
        '/v1/housekeeping/shift-templates' +
        (draft.id ? '/' + draft.id : '') +
        (apply ? '/apply' : ''),
      method: (!apply && draft.id ? 'patch' : 'post') as 'post' | 'patch',
      body,
    };
    if (!saveStaffRequest(recoveryKey, String(body.idempotencyKey))) {
      setLocalError(
        'Разрешите хранилище браузера для безопасного восстановления запроса.',
      );
      return;
    }
    setRequest(sent);
    commit.mutate(sent);
  };
  return (
    <section
      className="rounded-xl border bg-white p-4 space-y-3"
      aria-label="Шаблоны смен"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="mr-auto font-semibold">Повторяемые шаблоны смен</h3>
        <button
          type="button"
          className={button}
          disabled={!!pending || !staff.length}
          onClick={() => begin()}
        >
          Новый шаблон
        </button>
      </div>
      <p className="text-sm text-gray-500">
        Шаблон создаёт обычные смены на выбранный период. Индивидуальные
        изменения не перезаписываются. Перерывы можно указать в созданных
        сменах.
      </p>
      {notice && (
        <p role="status" className="text-sm text-teal-700">
          {notice}
        </p>
      )}
      {templates.isError ? (
        <p role="alert">{errorMessage(templates.error)}</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {templates.data?.map((t) => (
            <button
              key={t.id}
              className={button}
              disabled={!!pending}
              onClick={() => begin(t)}
            >
              {t.name} ·{' '}
              {staff.find((s) => s.id === t.userId)?.name ?? 'Сотрудник'}
            </button>
          ))}
          {!templates.isPending && !templates.data?.length && (
            <p className="text-sm text-gray-500">Шаблонов пока нет.</p>
          )}
        </div>
      )}
      <Modal
        open={open}
        onClose={() => {
          if (!commit.isPending) setOpen(false);
        }}
        closeDisabled={commit.isPending}
        title={draft.id ? 'Шаблон смен' : 'Новый шаблон смен'}
        wide
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit(false);
          }}
        >
          <fieldset
            disabled={commit.isPending || !!request || !!pending}
            className="grid gap-3 sm:grid-cols-2"
          >
            <label className="text-sm">
              Название шаблона
              <input
                className={input}
                required
                maxLength={100}
                value={draft.name ?? ''}
                onChange={(e) => change({ name: e.target.value })}
              />
            </label>
            <label className="text-sm">
              Сотрудник шаблона
              <select
                className={input}
                required
                value={draft.userId ?? ''}
                onChange={(e) => change({ userId: e.target.value })}
              >
                <option value="">Выберите сотрудника</option>
                {staff.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              Начало по времени объекта
              <input
                className={input}
                type="time"
                required
                value={draft.startTime}
                onChange={(e) => change({ startTime: e.target.value })}
              />
            </label>
            <label className="text-sm">
              Окончание по времени объекта
              <input
                className={input}
                type="time"
                required
                value={draft.endTime}
                onChange={(e) => change({ endTime: e.target.value })}
              />
            </label>
            <label className="text-sm flex gap-2">
              <input
                type="checkbox"
                checked={draft.overnight === 1}
                onChange={(e) =>
                  change({ overnight: e.target.checked ? 1 : 0 })
                }
              />
              Окончание на следующий день
            </label>
            <div
              className="flex flex-wrap gap-2 sm:col-span-2"
              role="group"
              aria-label="Дни недели"
            >
              {weekdays.map((name, i) => (
                <label key={name} className="flex gap-1 text-sm">
                  <input
                    type="checkbox"
                    checked={draft.weekdays?.includes(i) ?? false}
                    onChange={(e) =>
                      change({
                        weekdays: e.target.checked
                          ? [...(draft.weekdays ?? []), i]
                          : (draft.weekdays ?? []).filter((d) => d !== i),
                      })
                    }
                  />
                  {name}
                </label>
              ))}
            </div>
            <label className="text-sm">
              Лимит задач шаблона
              <input
                type="number"
                min={1}
                max={1000}
                className={input}
                value={draft.maxOpenTasks ?? ''}
                onChange={(e) =>
                  change({
                    maxOpenTasks: e.target.value
                      ? Number(e.target.value)
                      : null,
                  })
                }
              />
            </label>
            <label className="text-sm">
              Примечание
              <textarea
                className={input}
                maxLength={2000}
                value={draft.notes ?? ''}
                onChange={(e) => change({ notes: e.target.value })}
              />
            </label>
          </fieldset>
          {!request && (
            <button
              type="submit"
              className={button}
              disabled={commit.isPending || !!pending}
            >
              Сохранить шаблон
            </button>
          )}
          {draft.id && (
            <fieldset
              disabled={
                commit.isPending || inspect.isPending || !!pending || !!request
              }
              className="space-y-3 border-t pt-4"
            >
              <h3 className="font-medium">Применить сохранённый шаблон</h3>
              <p className="text-sm text-gray-500">
                Обе даты включены. До 93 дней за одну операцию. Изменения формы
                сначала сохраните; применение использует сохранённую версию.
              </p>
              <div className="grid gap-3 sm:grid-cols-3">
                <label className="text-sm">
                  С даты
                  <input
                    type="date"
                    className={input}
                    required
                    value={range.startDate}
                    onChange={(e) => {
                      setRange((r) => ({ ...r, startDate: e.target.value }));
                      setPreview(null);
                    }}
                  />
                </label>
                <label className="text-sm">
                  По дату
                  <input
                    type="date"
                    className={input}
                    required
                    value={range.endDate}
                    onChange={(e) => {
                      setRange((r) => ({ ...r, endDate: e.target.value }));
                      setPreview(null);
                    }}
                  />
                </label>
                <label className="text-sm">
                  Статус создаваемых смен
                  <select
                    className={input}
                    value={range.status}
                    onChange={(e) => {
                      setRange((r) => ({ ...r, status: e.target.value }));
                      setPreview(null);
                    }}
                  >
                    <option value="planned">Запланированы</option>
                    <option value="confirmed">Подтверждены</option>
                  </select>
                </label>
              </div>
              <button
                type="button"
                className={button}
                onClick={() => inspect.mutate()}
              >
                Проверить период
              </button>
              {preview && (
                <div
                  role="status"
                  className="rounded-lg bg-gray-50 p-3 text-sm"
                >
                  Смен: {preview.candidates.length}.{' '}
                  {preview.canApply
                    ? 'Пересечений со сменами нет.'
                    : 'Обнаружено пересечение. Существующие смены сохранены.'}
                  {preview.absenceWarnings.length > 0 && (
                    <p className="text-amber-800">
                      Есть отпуск / отсутствие. Проверьте покрытие и назначенные
                      задачи.
                    </p>
                  )}
                </div>
              )}
              <button
                type="button"
                className={button}
                disabled={!preview?.canApply}
                onClick={() => submit(true)}
              >
                Создать смены по шаблону
              </button>
            </fieldset>
          )}
          {localError && <p role="alert">{localError}</p>}
          {inspect.isError && <p role="alert">{errorMessage(inspect.error)}</p>}
          {commit.isError && <p role="alert">{errorMessage(commit.error)}</p>}
          {request && (
            <div className="space-y-2">
              <p className="text-sm">
                Проверяется исходная операция. Поля сохранены до подтверждения.
              </p>
              <button
                type="button"
                className={button}
                disabled={commit.isPending}
                onClick={() => commit.mutate(request)}
              >
                Повторить исходную операцию
              </button>
              {!pending && !commit.isPending && (
                <button
                  type="button"
                  className={button}
                  onClick={() => {
                    setRequest(null);
                    setPreview(null);
                    commit.reset();
                  }}
                >
                  Вернуться к форме после проверки результата
                </button>
              )}
            </div>
          )}
        </form>
      </Modal>
    </section>
  );
}

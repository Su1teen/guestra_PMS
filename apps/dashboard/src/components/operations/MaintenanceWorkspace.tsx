import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { errorMessage } from '../../lib/error-message';
import {
  clearStaffRequest,
  readStaffRequest,
  saveStaffRequest,
  usePendingStaffRequest,
} from '../../lib/staff-booking-recovery';
import Modal from '../ui/Modal';
import StatusBadge from '../ui/StatusBadge';
import PrivatePhotos from './PrivatePhotos';

const statuses: Record<string, string> = {
  open: 'Открыта',
  assigned: 'Назначена',
  in_progress: 'В работе',
  waiting_parts: 'Ожидание запчастей',
  resolved: 'Решена',
  closed: 'Закрыта',
  cancelled: 'Отменена',
};
const priorities: Record<string, string> = {
  low: 'Низкий',
  normal: 'Обычный',
  high: 'Высокий',
  critical: 'Критичный',
};
const categories: Record<string, string> = {
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
};
type Assignee = { id: string; name: string };
type Props = {
  propertyId: string;
  ticketId?: string;
  onClose: () => void;
  onSaved: (ticket: any) => void;
  assignees: Assignee[];
  rooms?: Array<{ id: string; number: string }>;
  reservationId?: string;
};
const inputClass =
  'w-full min-w-0 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm disabled:bg-gray-50';
const localDate = (value?: string) =>
  value
    ? new Date(
        new Date(value).getTime() - new Date(value).getTimezoneOffset() * 60000,
      )
        .toISOString()
        .slice(0, 16)
    : '';

/** Replaces the former inline editor; all mutations stay in the existing Maintenance API. */
export default function MaintenanceWorkspace(props: Props) {
  const { hasPermission, user } = useAuth();
  const client = useQueryClient();
  const canWrite = hasPermission(
    props.ticketId ? 'maintenance.update' : 'maintenance.create',
  );
  const canInventory = hasPermission('rooms.write'),
    canReturn = hasPermission('maintenance.close') && canInventory;
  const query = useQuery({
    queryKey: ['maintenance', 'detail', props.propertyId, props.ticketId],
    queryFn: () =>
      api
        .get('/v1/maintenance/' + props.ticketId, {
          params: { propertyId: props.propertyId },
        })
        .then((r) => r.data),
    enabled: !!props.ticketId,
    retry: false,
  });
  const ticket = query.data?.ticket;
  const [form, setForm] = useState({
    title: '',
    description: '',
    roomId: '',
    assigneeId: '',
    priority: 'normal',
    category: 'other',
    status: 'open',
    slaDeadline: '',
    resolution: '',
    blocksInventory: false,
  });
  const [comment, setComment] = useState(''),
    [note, setNote] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const recoveryKey = `guestra.maintenance-request.v1:${encodeURIComponent(user?.sub ?? 'demo')}:${props.propertyId}`;
  const pending = usePendingStaffRequest(recoveryKey);
  const [retryRequest, setRetryRequest] = useState<{
    url: string;
    method: 'post' | 'patch';
    body: any;
  } | null>(null);
  useEffect(() => {
    if (ticket)
      setForm({
        title: ticket.title,
        description: ticket.description,
        roomId: ticket.roomId ?? '',
        assigneeId: ticket.assigneeId ?? '',
        priority: ticket.priority,
        category: ticket.category,
        status: ticket.status,
        slaDeadline: localDate(ticket.slaDeadline),
        resolution: ticket.resolution ?? '',
        blocksInventory: ticket.blocksInventory,
      });
  }, [ticket]);
  async function accepted(result: any, key: string) {
    clearStaffRequest(recoveryKey, key);
    setRetryRequest(null);
    setError('');
    setComment('');
    await client.invalidateQueries({ queryKey: ['maintenance'] });
    await client.invalidateQueries({ queryKey: ['operations'] });
    await client.invalidateQueries({ queryKey: ['rooms'] });
    await client.invalidateQueries({ queryKey: ['housekeeping'] });
    setNotice(
      result.roomReturned === false
        ? 'Заявка закрыта. Номер остаётся заблокирован другой заявкой.'
        : 'Изменения сохранены.',
    );
    props.onSaved(result);
  }
  async function send(request: {
    url: string;
    method: 'post' | 'patch';
    body: any;
  }) {
    if (busy) return;
    const key = readStaffRequest(recoveryKey) ?? crypto.randomUUID();
    if (!saveStaffRequest(recoveryKey, key)) {
      setError('Не удалось сохранить ключ повтора в браузере.');
      return;
    }
    const frozen = {
      ...request,
      body: { ...request.body, idempotencyKey: key },
    };
    setRetryRequest(frozen);
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const { data } = await api[frozen.method](frozen.url, frozen.body, {
        params: { propertyId: props.propertyId },
      });
      await accepted(data, key);
    } catch (e) {
      setError(
        errorMessage(e) +
          ' Проверьте результат либо закройте непринятый запрос перед редактированием.',
      );
    } finally {
      setBusy(false);
    }
  }
  async function recover(close = false) {
    const key = readStaffRequest(recoveryKey);
    if (!key || busy) return;
    setBusy(true);
    setError('');
    try {
      const { data } = close
        ? await api.post('/v1/maintenance/request/close', {
            propertyId: props.propertyId,
            idempotencyKey: key,
          })
        : await api.get('/v1/maintenance/request', {
            params: { propertyId: props.propertyId, idempotencyKey: key },
          });
      if (data.state === 'committed') await accepted(data.result, key);
      else if (data.state === 'closed') {
        clearStaffRequest(recoveryKey, key);
        setRetryRequest(null);
        setNotice(
          'Запрос закрыт на сервере. Поздняя доставка не изменит заявку.',
        );
      } else
        setNotice(
          'Сервер пока не подтвердил сохранение. Можно повторить исходный запрос или безопасно закрыть его.',
        );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const field = (key: keyof typeof form, label: string, type = 'text') => (
    <label className="space-y-1 text-xs text-telivity-slate">
      {label}
      <input
        type={type}
        value={String(form[key])}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        className={inputClass}
      />
    </label>
  );
  const select = (
    key: keyof typeof form,
    label: string,
    options: Record<string, string>,
  ) => (
    <label className="space-y-1 text-xs text-telivity-slate">
      {label}
      <select
        value={String(form[key])}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        className={inputClass}
      >
        {Object.entries(options).map(([id, name]) => (
          <option key={id} value={id}>
            {name}
          </option>
        ))}
      </select>
    </label>
  );
  const save = () => {
    const body: any = {
      title: form.title,
      description: form.description,
      category: form.category,
      priority: form.priority,
      assigneeId: form.assigneeId || null,
      slaDeadline: form.slaDeadline
        ? new Date(form.slaDeadline).toISOString()
        : null,
    };
    if (props.ticketId) {
      body.status = form.status;
      body.resolution = form.resolution;
      body.expectedRevision = ticket.revision;
      if (canInventory && form.blocksInventory !== ticket.blocksInventory)
        body.blocksInventory = form.blocksInventory;
    } else {
      body.propertyId = props.propertyId;
      body.roomId = form.roomId || undefined;
      body.reservationId = props.reservationId;
      body.blocksInventory = canInventory && form.blocksInventory;
    }
    void send({
      method: props.ticketId ? 'patch' : 'post',
      url: '/v1/maintenance' + (props.ticketId ? '/' + props.ticketId : ''),
      body,
    });
  };
  return (
    <Modal
      open
      onClose={props.onClose}
      closeDisabled={busy}
      title={props.ticketId ? 'Техническая заявка' : 'Новая техническая заявка'}
      wide
    >
      <div className="space-y-4">
        {props.ticketId && query.isLoading && (
          <p role="status">Загрузка заявки…</p>
        )}
        {query.isError && (
          <p role="alert" className="text-red-700">
            {errorMessage(query.error)}{' '}
            <button onClick={() => query.refetch()} className="underline">
              Повторить
            </button>
          </p>
        )}
        {pending && (
          <div className="space-y-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
            <p>
              Есть запрос с неподтверждённым результатом. Новые изменения
              приостановлены.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                disabled={busy}
                onClick={() => recover()}
                className="rounded-lg border p-2"
              >
                Проверить результат
              </button>
              {retryRequest && (
                <button
                  disabled={busy}
                  onClick={() => send(retryRequest)}
                  className="rounded-lg border p-2"
                >
                  Повторить исходный запрос
                </button>
              )}
              {canWrite && (
                <button
                  disabled={busy}
                  onClick={() => recover(true)}
                  className="rounded-lg border p-2"
                >
                  Закрыть непринятый запрос
                </button>
              )}
            </div>
          </div>
        )}
        {(!props.ticketId || ticket) && (
          <>
            {ticket && (
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge
                  status={ticket.status}
                  label={statuses[ticket.status]}
                />
                <span className="text-sm text-telivity-mid-grey">
                  Номер {query.data.roomNumber ?? 'не указан'} ·{' '}
                  {query.data.assigneeName ?? 'Ответственный не назначен'}
                </span>
                {ticket.slaDeadline && (
                  <span
                    className={
                      new Date(ticket.slaDeadline) < new Date()
                        ? 'text-sm font-semibold text-red-700'
                        : 'text-sm text-telivity-mid-grey'
                    }
                  >
                    Срок: {new Date(ticket.slaDeadline).toLocaleString('ru-RU')}
                  </span>
                )}
              </div>
            )}
            <fieldset
              disabled={!canWrite || busy || !!pending}
              className="space-y-3 disabled:opacity-80"
            >
              {field('title', 'Название')}
              <label className="block space-y-1 text-xs text-telivity-slate">
                Описание
                <textarea
                  value={form.description}
                  onChange={(e) =>
                    setForm({ ...form, description: e.target.value })
                  }
                  rows={3}
                  className={inputClass}
                />
              </label>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {!props.ticketId &&
                  select(
                    'roomId',
                    'Номер',
                    Object.fromEntries([
                      ['', 'Без номера'],
                      ...(props.rooms ?? []).map((r) => [r.id, r.number]),
                    ]),
                  )}
                {select(
                  'assigneeId',
                  'Ответственный',
                  Object.fromEntries([
                    ['', 'Не назначен'],
                    ...props.assignees.map((a) => [a.id, a.name]),
                  ]),
                )}
                {select('priority', 'Приоритет', priorities)}
                {select('category', 'Категория', categories)}
                {props.ticketId && select('status', 'Статус', statuses)}
                {field('slaDeadline', 'Срок выполнения', 'datetime-local')}
              </div>
              {props.ticketId && (
                <label className="block space-y-1 text-xs text-telivity-slate">
                  Результат ремонта
                  <textarea
                    value={form.resolution}
                    onChange={(e) =>
                      setForm({ ...form, resolution: e.target.value })
                    }
                    rows={2}
                    className={inputClass}
                  />
                </label>
              )}
              {canInventory && (
                <label className="flex gap-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
                  <input
                    type="checkbox"
                    disabled={!!ticket?.returnToServiceRequired}
                    checked={form.blocksInventory}
                    onChange={(e) =>
                      setForm({ ...form, blocksInventory: e.target.checked })
                    }
                  />
                  Вывести номер из продажи сейчас
                </label>
              )}
              <p className="text-xs text-telivity-mid-grey">
                Завершение ремонта не снимает блокировку. Возврат подтверждается
                отдельно; затем номер проходит уборку.
              </p>
              {canWrite && (
                <button
                  type="button"
                  disabled={
                    !form.title.trim() ||
                    !form.description.trim() ||
                    busy ||
                    !!pending
                  }
                  onClick={save}
                  className="rounded-lg bg-telivity-teal px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                >
                  {props.ticketId ? 'Сохранить изменения' : 'Создать заявку'}
                </button>
              )}
            </fieldset>
            {ticket && (
              <>
                <section aria-label="Комментарии" className="space-y-2">
                  <h3 className="text-sm font-semibold">Комментарии</h3>
                  {(ticket.comments ?? []).map((c: any) => (
                    <div
                      key={c.id}
                      className="rounded-lg bg-gray-50 p-3 text-sm"
                    >
                      <p className="whitespace-pre-wrap break-words">
                        {c.body}
                      </p>
                      <time className="text-xs text-telivity-mid-grey">
                        {new Date(c.createdAt).toLocaleString('ru-RU')}
                      </time>
                    </div>
                  ))}
                  {canWrite && (
                    <div className="space-y-2">
                      <textarea
                        aria-label="Комментарий"
                        value={comment}
                        disabled={busy || !!pending}
                        onChange={(e) => setComment(e.target.value)}
                        maxLength={10000}
                        rows={2}
                        className={inputClass}
                      />
                      <button
                        disabled={!comment.trim() || busy || !!pending}
                        onClick={() =>
                          send({
                            method: 'post',
                            url: `/v1/maintenance/${ticket.id}/comments`,
                            body: {
                              propertyId: props.propertyId,
                              body: comment,
                              expectedRevision: ticket.revision,
                            },
                          })
                        }
                        className="rounded-lg border px-3 py-2 text-sm"
                      >
                        Добавить комментарий
                      </button>
                    </div>
                  )}
                </section>
                <PrivatePhotos
                  propertyId={props.propertyId}
                  ownerId={ticket.id}
                  kind="maintenance"
                  canUpload={canWrite && !pending && !busy}
                />
                {ticket.returnToServiceRequired && (
                  <section className="space-y-2 rounded-lg border border-amber-200 p-3">
                    <h3 className="text-sm font-semibold">
                      Возврат в эксплуатацию
                    </h3>
                    <p className="text-xs text-telivity-mid-grey">
                      Подтвердите проверку после завершения ремонта. Другие
                      блокирующие причины сохраняются.
                    </p>
                    {canReturn && (
                      <>
                        <textarea
                          aria-label="Примечание проверки"
                          value={note}
                          onChange={(e) => setNote(e.target.value)}
                          disabled={busy || !!pending}
                          rows={2}
                          className={inputClass}
                        />
                        <button
                          disabled={
                            busy ||
                            !!pending ||
                            !['resolved', 'closed', 'cancelled'].includes(
                              ticket.status,
                            )
                          }
                          onClick={() =>
                            send({
                              method: 'post',
                              url: `/v1/maintenance/${ticket.id}/return-to-service`,
                              body: {
                                propertyId: props.propertyId,
                                note,
                                expectedRevision: ticket.revision,
                              },
                            })
                          }
                          className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
                        >
                          Подтвердить возврат
                        </button>
                      </>
                    )}
                    {!['resolved', 'closed', 'cancelled'].includes(
                      ticket.status,
                    ) && (
                      <p className="text-xs text-amber-900">
                        Сначала укажите результат и завершите заявку.
                      </p>
                    )}
                  </section>
                )}
                <section aria-label="История изменений" className="space-y-2">
                  <h3 className="text-sm font-semibold">История изменений</h3>
                  {(query.data.history ?? []).map((entry: any) => (
                    <div
                      key={entry.id}
                      className="flex flex-wrap gap-2 border-b border-gray-100 py-2 text-xs"
                    >
                      <span>
                        {(
                          {
                            create: 'Создание',
                            update: 'Изменение',
                            comment: 'Комментарий',
                            attachment: 'Фотография',
                            return_to_service: 'Проверка возврата',
                          } as Record<string, string>
                        )[entry.description] ?? 'Изменение заявки'}
                      </span>
                      <span className="ml-auto text-telivity-mid-grey">
                        {new Date(entry.occurredAt).toLocaleString('ru-RU')}
                      </span>
                    </div>
                  ))}
                </section>
              </>
            )}
          </>
        )}
        {error && (
          <p
            role="alert"
            className="rounded-lg bg-red-50 p-3 text-sm text-red-700"
          >
            {error}
          </p>
        )}
        {notice && (
          <p
            role="status"
            className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-900"
          >
            {notice}
          </p>
        )}
      </div>
    </Modal>
  );
}

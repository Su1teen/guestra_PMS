import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { useProperty } from '../../context/PropertyContext';
import { hotelDate } from '../../lib/hotel-date';
import { errorMessage } from '../../lib/error-message';
import {
  clearStaffRequest,
  readStaffRequest,
  saveStaffRequest,
  usePendingStaffRequest,
} from '../../lib/staff-booking-recovery';
import Modal from '../ui/Modal';

type Block = {
  id: string;
  roomId: string;
  maintenanceTicketId?: string;
  startDate: string;
  endDate: string;
  kind: string;
  reason: string;
  revision: number;
  status: string;
};
type Draft = {
  roomId: string;
  maintenanceTicketId?: string;
  startDate: string;
  endDate: string;
  kind: string;
  reason: string;
};
const fieldClass =
  'w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm';
const buttonClass =
  'rounded-lg border border-gray-200 px-3 py-2 text-sm disabled:opacity-50';
const draftOf = (block: Block): Draft => ({
  roomId: block.roomId,
  maintenanceTicketId: block.maintenanceTicketId,
  startDate: block.startDate,
  endDate: block.endDate,
  kind: block.kind,
  reason: block.reason,
});

export default function RoomInventoryBlocks({
  propertyId,
  rooms,
}: {
  propertyId: string;
  rooms: Array<{ id: string; number: string }>;
}) {
  const { hasPermission, user } = useAuth();
  const { properties } = useProperty();
  const zone =
    properties.find((property) => property.id === propertyId)?.timezone ??
    'UTC';
  const today = hotelDate(zone);
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('blockId') ?? undefined;
  const canRead = hasPermission('maintenance.view', 'rooms.read');
  const canCreate = hasPermission('maintenance.create', 'rooms.write');
  const canUpdate = hasPermission('maintenance.update', 'rooms.write');
  const canReturn = hasPermission('maintenance.close', 'rooms.write');
  const client = useQueryClient();
  const [roomFilter, setRoomFilter] = useState('');
  const [page, setPage] = useState(0);
  const [editor, setEditor] = useState<{
    id?: string;
    revision?: number;
    draft: Draft;
  } | null>(null);
  const [returnReason, setReturnReason] = useState('');
  const [preview, setPreview] = useState<any>(null);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const recoveryKey = `guestra.inventory-block-request.v1:${encodeURIComponent(user?.sub ?? 'demo')}:${propertyId}`;
  const pending = usePendingStaffRequest(recoveryKey);
  const [request, setRequest] = useState<{
    url: string;
    method: 'post' | 'patch';
    body: any;
  } | null>(null);
  const query = useQuery({
    queryKey: ['maintenance', 'inventory-blocks', propertyId, roomFilter],
    queryFn: () =>
      api
        .get('/v1/maintenance/inventory-blocks', {
          params: { propertyId, roomId: roomFilter || undefined },
        })
        .then((result) => result.data),
    enabled: canRead,
    retry: false,
  });
  const detail = useQuery({
    queryKey: ['maintenance', 'inventory-block', propertyId, selectedId],
    queryFn: () =>
      api
        .get('/v1/maintenance/inventory-blocks/' + selectedId, {
          params: { propertyId },
        })
        .then((result) => result.data),
    enabled: canRead && !!selectedId,
    retry: false,
  });
  useEffect(() => {
    if (!editor && detail.data && selectedId)
      setEditor({
        id: selectedId,
        revision: detail.data.block.revision,
        draft: draftOf(detail.data.block),
      });
  }, [selectedId, detail.data, editor]);
  useEffect(() => {
    const roomId = params.get('newBlockRoomId');
    if (!editor && roomId && canCreate)
      setEditor({
        draft: {
          roomId,
          maintenanceTicketId: params.get('blockTicketId') ?? undefined,
          startDate: today,
          endDate: new Date(Date.parse(today + 'T00:00Z') + 86400000)
            .toISOString()
            .slice(0, 10),
          kind: 'OOO',
          reason: '',
        },
      });
  }, [params, editor, canCreate, today]);
  function select(id?: string) {
    setPreview(null);
    setError('');
    setReturnReason('');
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      next.delete('newBlockRoomId');
      next.delete('blockTicketId');
      if (id) next.set('blockId', id);
      else next.delete('blockId');
      return next;
    });
  }
  function close() {
    if (busy) return;
    select();
    setEditor(null);
  }
  function create() {
    select();
    setEditor({
      draft: {
        roomId: '',
        startDate: today,
        endDate: new Date(Date.parse(today + 'T00:00Z') + 86400000)
          .toISOString()
          .slice(0, 10),
        kind: 'OOO',
        reason: '',
      },
    });
  }
  async function refresh() {
    for (const key of [
      'maintenance',
      'operations',
      'calendar',
      'rooms',
      'housekeeping',
    ])
      await client.invalidateQueries({ queryKey: [key] });
  }
  async function accepted(result: any, key: string) {
    clearStaffRequest(recoveryKey, key);
    setRequest(null);
    select(result.id);
    setEditor({
      id: result.id,
      revision: result.revision,
      draft: draftOf(result),
    });
    await refresh();
    setNotice(
      result.status === 'released'
        ? 'Ограничение снято. Другие блокирующие причины сохраняются.'
        : 'Блокировка сохранена. Дата окончания не разрешает продажу.',
    );
  }
  async function send(
    operation: { url: string; method: 'post' | 'patch'; body: any },
    retry = false,
  ) {
    if (busy || (!retry && readStaffRequest(recoveryKey))) return;
    const key = retry ? operation.body.idempotencyKey : crypto.randomUUID();
    if (!saveStaffRequest(recoveryKey, key)) {
      setError(
        'Не удалось сохранить ключ восстановления. Изменение не отправлено.',
      );
      return;
    }
    const frozen = {
      ...operation,
      body: { ...operation.body, idempotencyKey: key },
    };
    setRequest(frozen);
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await accepted(
        (await api[frozen.method](frozen.url, frozen.body)).data,
        key,
      );
    } catch (cause) {
      setError(
        errorMessage(cause) +
          ' Проверьте результат либо закройте непринятый запрос.',
      );
    } finally {
      setBusy(false);
    }
  }
  async function recover(closeRequest = false) {
    const key = readStaffRequest(recoveryKey);
    if (!key || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = closeRequest
        ? (
            await api.post('/v1/maintenance/request/close', {
              propertyId,
              idempotencyKey: key,
            })
          ).data
        : (
            await api.get('/v1/maintenance/request', {
              params: { propertyId, idempotencyKey: key },
            })
          ).data;
      if (result.state === 'committed') await accepted(result.result, key);
      else if (result.state === 'closed') {
        clearStaffRequest(recoveryKey, key);
        setRequest(null);
        setNotice(
          'Непринятый запрос закрыт. Поздний повтор не изменит блокировку.',
        );
      } else
        setNotice(
          'Сервер пока не подтвердил запрос. Повторите исходную операцию или безопасно закройте её.',
        );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  async function check() {
    if (!editor || busy) return;
    setBusy(true);
    setError('');
    try {
      setPreview(
        (
          await api.post(
            '/v1/maintenance/inventory-blocks/preview',
            {
              propertyId,
              ...editor.draft,
              idempotencyKey: crypto.randomUUID(),
            },
            { params: { blockId: editor.id } },
          )
        ).data,
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  const rows: any[] = query.data ?? [];
  const active = detail.data?.block.status === 'active';
  const update = (key: keyof Draft, value: string) => {
    setPreview(null);
    setEditor((current) =>
      current
        ? { ...current, draft: { ...current.draft, [key]: value } }
        : current,
    );
  };
  if (!canRead) return null;
  return (
    <section className="rounded-xl border border-orange-100 bg-white p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="mr-auto">
          <h2 className="font-semibold text-telivity-navy">
            Плановые блокировки OOO/OOS
          </h2>
          <p className="mt-1 text-xs text-telivity-mid-grey">
            Фактический статус номера сохраняется. Продажи открываются только
            после подтверждённого возврата.
          </p>
        </div>
        {canCreate && (
          <button
            className={buttonClass}
            onClick={create}
            disabled={busy || !!pending}
          >
            Планировать блокировку
          </button>
        )}
      </div>
      <label className="mt-3 block max-w-xs text-xs">
        Номер в очереди блокировок
        <select
          className={fieldClass}
          value={roomFilter}
          onChange={(event) => {
            setRoomFilter(event.target.value);
            setPage(0);
          }}
        >
          <option value="">Все номера</option>
          {rooms.map((room) => (
            <option key={room.id} value={room.id}>
              {room.number}
            </option>
          ))}
        </select>
      </label>
      {query.isLoading && <p role="status">Загрузка блокировок…</p>}
      {query.isError && (
        <p role="alert" className="mt-3 text-sm text-red-700">
          {errorMessage(query.error)}{' '}
          <button onClick={() => query.refetch()}>Повторить</button>
        </p>
      )}
      {!query.isLoading && !query.isError && rows.length === 0 && (
        <p className="mt-3 text-sm text-telivity-mid-grey">
          Активных блокировок нет.
        </p>
      )}
      <div className="mt-3 space-y-2">
        {rows.slice(page * 20, (page + 1) * 20).map((row) => (
          <button
            key={row.block.id}
            className="block w-full rounded-lg border border-gray-100 p-3 text-left hover:border-telivity-teal"
            onClick={() => {
              setEditor(null);
              select(row.block.id);
            }}
          >
            <span className="font-semibold text-telivity-navy">
              {row.roomNumber} · {row.block.kind}
            </span>
            <span className="ml-2 text-xs text-orange-700">
              {row.overdue
                ? 'Просрочена блокировка / Требуется подтверждение'
                : 'Требуется подтверждённый возврат'}
            </span>
            <span className="mt-1 block text-xs text-telivity-mid-grey">
              {row.block.startDate} → {row.block.endDate} (ожидаемый срок) ·
              Фактический статус:{' '}
              {row.physicalRoomStatus === 'guest_ready'
                ? 'Готов к гостю'
                : row.physicalRoomStatus === 'vacant_clean'
                  ? 'Свободен, чистый'
                  : row.physicalRoomStatus === 'vacant_dirty'
                    ? 'Требуется уборка'
                    : row.physicalRoomStatus === 'occupied'
                      ? 'Занят'
                      : row.physicalRoomStatus === 'out_of_order'
                        ? 'OOO'
                        : row.physicalRoomStatus === 'out_of_service'
                          ? 'OOS'
                          : 'Требуется проверка'}
            </span>
            <span className="mt-1 block text-sm">{row.block.reason}</span>
          </button>
        ))}
      </div>
      {rows.length > 20 && (
        <div className="mt-3 flex items-center gap-2 text-xs">
          <button
            className={buttonClass}
            disabled={page === 0}
            onClick={() => setPage(page - 1)}
          >
            Назад
          </button>
          <span>
            Страница {page + 1} · Всего: {rows.length}
          </span>
          <button
            className={buttonClass}
            disabled={(page + 1) * 20 >= rows.length}
            onClick={() => setPage(page + 1)}
          >
            Далее
          </button>
        </div>
      )}
      {selectedId && detail.isLoading && (
        <p role="status">Загрузка выбранной блокировки…</p>
      )}
      {selectedId && detail.isError && (
        <p role="alert">
          {errorMessage(detail.error)}{' '}
          <button onClick={() => detail.refetch()}>Повторить</button>
        </p>
      )}
      {notice && (
        <p role="status" className="mt-3 text-sm text-telivity-teal">
          {notice}
        </p>
      )}
      {error && !editor && (
        <p role="alert" className="mt-3 text-sm text-red-700">
          {error}
        </p>
      )}
      {pending && !editor && (
        <div className="mt-3 flex flex-wrap gap-2 text-sm">
          <p>Есть операция с неподтверждённым результатом.</p>
          <button
            className={buttonClass}
            disabled={busy}
            onClick={() => recover()}
          >
            Проверить результат
          </button>
          {(canCreate || canUpdate || canReturn) && (
            <button
              className={buttonClass}
              disabled={busy}
              onClick={() => recover(true)}
            >
              Закрыть непринятый запрос
            </button>
          )}
        </div>
      )}
      <Modal
        open={!!editor}
        onClose={close}
        closeDisabled={busy}
        title={editor?.id ? 'Блокировка номера' : 'Плановая блокировка'}
        wide
      >
        {editor && (
          <div className="space-y-4">
            {editor.id && (
              <button
                className={buttonClass}
                disabled={busy || !!pending}
                onClick={async () => {
                  const result = await detail.refetch();
                  if (result.data)
                    setEditor({
                      id: result.data.block.id,
                      revision: result.data.block.revision,
                      draft: draftOf(result.data.block),
                    });
                  setPreview(null);
                }}
              >
                Обновить карточку
              </button>
            )}
            {error && (
              <p
                role="alert"
                className="rounded-lg bg-red-50 p-3 text-sm text-red-700"
              >
                {error}
              </p>
            )}
            {pending && (
              <div className="flex flex-wrap gap-2 rounded-lg bg-orange-50 p-3 text-sm">
                <p>
                  Результат операции не подтверждён. Изменение полей
                  заблокировано.
                </p>
                <button
                  className={buttonClass}
                  disabled={busy}
                  onClick={() => recover()}
                >
                  Проверить результат
                </button>
                {request && (
                  <button
                    className={buttonClass}
                    disabled={busy}
                    onClick={() => send(request, true)}
                  >
                    Повторить исходный запрос
                  </button>
                )}
                {(canCreate || canUpdate || canReturn) && (
                  <button
                    className={buttonClass}
                    disabled={busy}
                    onClick={() => recover(true)}
                  >
                    Закрыть непринятый запрос
                  </button>
                )}
              </div>
            )}
            {notice && (
              <p role="status" className="text-sm text-telivity-teal">
                {notice}
              </p>
            )}
            <fieldset
              disabled={
                busy ||
                !!pending ||
                (editor.id ? !canUpdate || !active : !canCreate)
              }
              className="grid gap-3 sm:grid-cols-2"
            >
              <label className="text-xs">
                Номер
                <select
                  aria-label="Номер блокировки"
                  className={fieldClass}
                  value={editor.draft.roomId}
                  disabled={!!editor.id}
                  onChange={(event) => update('roomId', event.target.value)}
                >
                  <option value="">Выберите номер</option>
                  {rooms.map((room) => (
                    <option key={room.id} value={room.id}>
                      {room.number}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs">
                Вид
                <select
                  aria-label="Вид блокировки"
                  className={fieldClass}
                  value={editor.draft.kind}
                  onChange={(event) => update('kind', event.target.value)}
                >
                  <option value="OOO">OOO — ремонт</option>
                  <option value="OOS">OOS — временно недоступен</option>
                </select>
              </label>
              <label className="text-xs">
                Начало
                <input
                  aria-label="Начало блокировки"
                  type="date"
                  className={fieldClass}
                  value={editor.draft.startDate}
                  onChange={(event) => update('startDate', event.target.value)}
                />
              </label>
              <label className="text-xs">
                Ожидаемое окончание
                <input
                  aria-label="Ожидаемое окончание"
                  type="date"
                  className={fieldClass}
                  value={editor.draft.endDate}
                  onChange={(event) => update('endDate', event.target.value)}
                />
              </label>
              <label className="text-xs sm:col-span-2">
                Причина
                <textarea
                  aria-label="Причина блокировки"
                  className={fieldClass}
                  maxLength={2000}
                  value={editor.draft.reason}
                  onChange={(event) => update('reason', event.target.value)}
                />
              </label>
            </fieldset>
            <p className="text-xs text-telivity-mid-grey">
              OOO и OOS исключаются из продаж по действующим правилам PMS.
              Конечная дата — ожидаемый срок; активное ограничение действует с
              начала до разрешённого возврата, включая будущие ночи после этого
              срока.
            </p>
            {editor.draft.maintenanceTicketId && (
              <Link
                className="text-sm text-telivity-teal underline"
                to={
                  '/operations?tab=maintenance&propertyId=' +
                  propertyId +
                  '&ticketId=' +
                  editor.draft.maintenanceTicketId
                }
                onClick={() => setEditor(null)}
              >
                Открыть связанную техническую заявку
              </Link>
            )}
            {(editor.id ? canUpdate && active : canCreate) && (
              <div className="flex flex-wrap gap-2">
                <button
                  className={buttonClass}
                  disabled={busy || !!pending || !editor.draft.roomId}
                  onClick={check}
                >
                  Проверить конфликты
                </button>
                <button
                  className="rounded-lg bg-telivity-teal px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
                  disabled={busy || !!pending || preview?.canApply !== true}
                  onClick={() =>
                    send({
                      url:
                        '/v1/maintenance/inventory-blocks' +
                        (editor.id ? '/' + editor.id : ''),
                      method: editor.id ? 'patch' : 'post',
                      body: {
                        propertyId,
                        ...editor.draft,
                        expectedRevision: editor.revision,
                      },
                    })
                  }
                >
                  Сохранить блокировку
                </button>
              </div>
            )}
            {preview && (
              <p
                role="status"
                className={
                  'rounded-lg p-3 text-sm ' +
                  (preview.canApply
                    ? 'bg-teal-50 text-teal-800'
                    : 'bg-orange-50 text-orange-800')
                }
              >
                {preview.canApply
                  ? 'Конфликтов не найдено. При сохранении сервер проверит инвентарь повторно.'
                  : 'Есть конфликты: броней ' +
                    preview.conflictingReservationIds.length +
                    ', ночей с недостатком инвентаря ' +
                    preview.shortages.length +
                    '.'}
              </p>
            )}
            {editor.id && active && canReturn && (
              <div className="rounded-lg border border-orange-200 p-3">
                <h3 className="font-semibold text-telivity-navy">
                  Return-to-Service — возврат в эксплуатацию
                </h3>
                <p className="mt-1 text-xs text-telivity-mid-grey">
                  Разрешён и досрочно. Сервер проверит ремонт, уборку, инспекции
                  и сохранит другие активные ограничения.
                </p>
                <label className="mt-3 block text-xs">
                  Причина подтверждения
                  <textarea
                    aria-label="Причина подтверждения возврата"
                    className={fieldClass}
                    value={returnReason}
                    maxLength={2000}
                    disabled={busy || !!pending}
                    onChange={(event) => setReturnReason(event.target.value)}
                  />
                </label>
                <button
                  className={buttonClass + ' mt-2'}
                  disabled={busy || !!pending || !returnReason.trim()}
                  onClick={() =>
                    send({
                      url:
                        '/v1/maintenance/inventory-blocks/' +
                        editor.id +
                        '/return-to-service',
                      method: 'post',
                      body: {
                        propertyId,
                        reason: returnReason,
                        expectedRevision: editor.revision,
                      },
                    })
                  }
                >
                  Подтвердить Return-to-Service
                </button>
              </div>
            )}
            {detail.data && editor.id === selectedId && (
              <div>
                <h3 className="font-semibold text-telivity-navy">
                  История блокировки
                </h3>
                {detail.data.block.status === 'released' && (
                  <p className="mt-2 text-sm text-telivity-teal">
                    Возврат подтверждён. Ограничение снято.
                  </p>
                )}
                {detail.data.history.map((entry: any) => (
                  <div
                    key={entry.id}
                    className="mt-2 border-b border-gray-100 pb-2 text-xs"
                  >
                    <strong>
                      {entry.action === 'create'
                        ? 'Создание'
                        : entry.action === 'update'
                          ? 'Изменение'
                          : 'Подтверждение возврата'}
                    </strong>
                    <span className="ml-2 text-telivity-mid-grey">
                      {new Date(entry.occurredAt).toLocaleString('ru-RU', {
                        timeZone: zone,
                      })}{' '}
                      · {entry.userEmail ?? 'Сотрудник'}
                    </span>
                    <p className="mt-1">{entry.description}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Modal>
    </section>
  );
}

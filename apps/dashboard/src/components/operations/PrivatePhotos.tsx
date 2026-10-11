import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Image, Upload } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { errorMessage } from '../../lib/error-message';
import {
  clearStaffRequest,
  readStaffRequest,
  saveStaffRequest,
  usePendingStaffRequest,
} from '../../lib/staff-booking-recovery';

type Photo = { id: string; name: string; contentType: string; size: number };
type Capability = {
  configured: boolean;
  canUpload: boolean;
  attachments: Photo[];
  maxBytes: number;
  contentTypes: string[];
};
/** Private files are fetched with the current API credentials; no anonymous image URL is rendered. */
export default function PrivatePhotos({
  propertyId,
  ownerId,
  kind,
  canUpload,
}: {
  propertyId: string;
  ownerId: string;
  kind: 'maintenance' | 'housekeeping';
  canUpload: boolean;
}) {
  const { user } = useAuth();
  const client = useQueryClient();
  const endpoint = `/v1/operational-attachments/${kind}/${ownerId}`;
  const recoveryKey = `guestra.photo-request.v1:${encodeURIComponent(user?.sub ?? 'demo')}:${propertyId}:${kind}:${ownerId}`;
  const pending = usePendingStaffRequest(recoveryKey);
  const [file, setFile] = useState<File | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const picker = useRef<HTMLInputElement>(null);
  const queryKey = ['private-photos', propertyId, kind, ownerId];
  const query = useQuery<Capability>({
    queryKey,
    queryFn: () =>
      api
        .get(endpoint + '/capabilities', { params: { propertyId } })
        .then((r) => r.data),
    retry: false,
  });
  useEffect(() => {
    setFile(null);
    setMessage('');
  }, [propertyId, ownerId, kind]);
  async function recover() {
    const key = readStaffRequest(recoveryKey);
    if (!key) return;
    setBusy(true);
    setMessage('');
    try {
      const { data } = await api.get(endpoint + '/request', {
        params: { propertyId, idempotencyKey: key },
      });
      if (data.state === 'committed') {
        clearStaffRequest(recoveryKey, key);
        setFile(null);
        await client.invalidateQueries({ queryKey });
        setMessage('Фотография сохранена.');
      } else
        setMessage(
          'Сохранение пока не подтверждено. Выберите исходный файл и повторите загрузку с тем же ключом.',
        );
    } catch (e) {
      setMessage(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function upload() {
    if (!file || busy || !query.data?.configured || !query.data.canUpload)
      return;
    if (
      file.size > query.data.maxBytes ||
      !query.data.contentTypes.includes(file.type)
    ) {
      setMessage('Выберите JPEG, PNG или WebP размером до 10 МБ.');
      return;
    }
    const key = readStaffRequest(recoveryKey) ?? crypto.randomUUID();
    if (!saveStaffRequest(recoveryKey, key)) {
      setMessage(
        'Не удалось сохранить ключ повтора. Разрешите хранилище браузера перед загрузкой.',
      );
      return;
    }
    setBusy(true);
    setMessage('');
    const body = new FormData();
    body.append('file', file);
    body.append('idempotencyKey', key);
    try {
      await api.post(endpoint, body, {
        params: { propertyId },
        headers: { 'Content-Type': undefined },
      });
      clearStaffRequest(recoveryKey, key);
      setFile(null);
      if (picker.current) picker.current.value = '';
      await client.invalidateQueries({ queryKey });
      await client.invalidateQueries({ queryKey: ['maintenance'] });
      await client.invalidateQueries({ queryKey: ['housekeeping'] });
      setMessage('Фотография сохранена.');
    } catch (e) {
      setMessage(
        errorMessage(e) +
          ' Ключ повтора сохранён; проверьте результат перед новой загрузкой.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="space-y-3 rounded-xl border border-gray-100 p-4"
      aria-label="Фотографии задачи"
    >
      <h3 className="flex items-center gap-2 text-sm font-semibold text-telivity-navy">
        <Image size={16} />
        Фотографии
      </h3>
      <p className="text-xs text-telivity-mid-grey">
        Доступны только сотрудникам с правом доступа к этой задаче.
      </p>
      {query.isLoading && (
        <p role="status" className="text-sm">
          Загрузка фотографий…
        </p>
      )}
      {query.isError && (
        <div role="alert" className="text-sm text-red-700">
          {errorMessage(query.error)}{' '}
          <button
            type="button"
            onClick={() => query.refetch()}
            className="underline"
          >
            Повторить
          </button>
        </div>
      )}
      {query.data && (
        <>
          {!query.data.configured && (
            <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-900">
              Приватное хранилище не настроено. Для загрузки обратитесь к
              администратору.
            </p>
          )}
          <div className="space-y-2">
            {query.data.attachments.map((photo) => (
              <ProtectedPhoto
                key={photo.id}
                photo={photo}
                endpoint={endpoint}
                propertyId={propertyId}
              />
            ))}
          </div>
          {query.data.attachments.length === 0 && (
            <p className="text-xs text-telivity-mid-grey">
              Фотографий пока нет.
            </p>
          )}
          {canUpload && query.data.canUpload && query.data.configured && (
            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={picker}
                aria-label={
                  pending
                    ? 'Исходная фотография для повтора'
                    : 'Выбрать фотографию'
                }
                type="file"
                accept="image/jpeg,image/png,image/webp"
                disabled={busy}
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="min-w-0 max-w-full text-xs"
              />
              <button
                type="button"
                disabled={!file || busy}
                onClick={upload}
                className="flex items-center gap-2 rounded-lg bg-telivity-teal px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
              >
                <Upload size={14} />
                {busy
                  ? 'Сохраняем…'
                  : pending
                    ? 'Повторить загрузку'
                    : 'Загрузить'}
              </button>
              <span className="text-xs text-telivity-mid-grey">
                JPEG / PNG / WebP · до 10 МБ
              </span>
            </div>
          )}
          {pending && (
            <button
              type="button"
              disabled={busy}
              onClick={recover}
              className="rounded-lg border px-3 py-2 text-xs"
            >
              Проверить результат загрузки
            </button>
          )}
        </>
      )}
      {message && (
        <p role="status" className="text-sm text-telivity-slate">
          {message}
        </p>
      )}
    </section>
  );
}
function ProtectedPhoto({
  photo,
  endpoint,
  propertyId,
}: {
  photo: Photo;
  endpoint: string;
  propertyId: string;
}) {
  const [url, setUrl] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const active = useRef(true),
    objectUrl = useRef<string | null>(null);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    };
  }, [photo.id, propertyId, endpoint]);
  async function open() {
    if (busy || url) return;
    setBusy(true);
    setError('');
    try {
      const { data } = await api.get(endpoint + '/' + photo.id, {
        params: { propertyId },
        responseType: 'blob',
      });
      if (active.current) {
        const next = URL.createObjectURL(data);
        objectUrl.current = next;
        setUrl(next);
      }
    } catch (e) {
      if (active.current) setError(errorMessage(e));
    } finally {
      if (active.current) setBusy(false);
    }
  }
  return (
    <div className="rounded-lg bg-gray-50 p-3">
      <button
        type="button"
        onClick={open}
        disabled={busy}
        className="max-w-full break-all text-left text-xs font-semibold text-telivity-teal"
      >
        {busy ? 'Загрузка…' : photo.name} · {(photo.size / 1024).toFixed(0)} КБ
      </button>
      {url && (
        <img
          src={url}
          alt={photo.name}
          className="mt-2 max-h-72 max-w-full rounded-lg object-contain"
        />
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}

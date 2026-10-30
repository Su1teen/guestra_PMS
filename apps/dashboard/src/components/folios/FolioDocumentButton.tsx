import { useState } from 'react';
import { FileText } from 'lucide-react';
import { api } from '../../lib/api';
import { openFolioDocument } from '../../lib/folio-document';
import { useAuth } from '../../context/AuthContext';
import { errorMessage } from '../../lib/error-message';

/** Opens the printable folio / receipt. Resolves the guest folio of a reservation when no folio id is given. */
export default function FolioDocumentButton({ propertyId, folioId, reservationId, label, className }: {
  propertyId: string; folioId?: string; reservationId?: string; label?: string; className?: string;
}) {
  const { hasPermission } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!hasPermission('folios.read') || (!folioId && !reservationId)) return null;
  async function open() {
    setBusy(true); setError('');
    try {
      let id = folioId;
      if (!id) {
        const { data } = await api.get('/v1/folios', { params: { propertyId, reservationId, limit: 100 }, skipErrorToast: true });
        const rows: any[] = data?.data ?? data ?? [];
        id = (rows.find(f => f.type === 'guest') ?? rows[0])?.id;
        if (!id) throw new Error('У брони ещё нет фолио.');
      }
      await openFolioDocument(id, propertyId);
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }
  return <span className="inline-flex flex-col">
    <button type="button" disabled={busy} onClick={() => void open()}
      className={className ?? 'flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold disabled:opacity-50'}>
      <FileText size={14}/>{busy ? 'Формируем…' : label ?? 'Фолио (PDF)'}
    </button>
    {error && <span role="alert" className="mt-1 text-xs text-red-700">{error}</span>}
  </span>;
}

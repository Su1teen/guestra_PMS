import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { useProperty } from '../../context/PropertyContext';
import Modal from '../ui/Modal';
import { QueryError } from '../ui/ErrorBoundary';
import Guest360Panel from './Guest360Panel';
const QuickViewContext = createContext<{ openGuest: (id: string, propertyId: string) => void }>({ openGuest: () => {} });
export const useGuestQuickView = () => useContext(QuickViewContext);
export function GuestQuickViewProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation(); const { hasPermission, user } = useAuth(); const { propertyId, properties, setPropertyId } = useProperty();
  const [selected, setSelected] = useState<{ id: string; propertyId: string } | null>(null);
  useEffect(() => { setSelected(null); }, [propertyId, user?.sub]);
  const query = useQuery({ queryKey: ['guest-360', selected?.id, selected?.propertyId, user?.sub], enabled: !!selected && hasPermission('guests.read'),
    queryFn: () => api.get('/v1/guests/' + selected!.id + '/360', { params: { propertyId: selected!.propertyId }, skipErrorToast: true }).then(r => r.data?.data ?? r.data) });
  return <QuickViewContext.Provider value={{ openGuest: (id, property) => { if (hasPermission('guests.read') && properties.some(p => p.id === property)) setSelected({ id, propertyId: property }); } }}>
    {children}
    <Modal open={!!selected} onClose={() => setSelected(null)} title={query.data?.guest ? `${t('guestQuickView.title')} · ${query.data.guest.firstName} ${query.data.guest.lastName}` : t('guestQuickView.title')} wide>
      {query.data?.guest && <div className="mb-4 rounded-lg bg-gray-50 p-3 text-sm"><p>{query.data.guest.email ?? '—'}{query.data.guest.phone ? ' · ' + query.data.guest.phone : ''}</p>{query.data.guest.isDnr && <p className="mt-2 font-semibold text-red-700">{t('guestQuickView.dnr')}</p>}</div>}
      {query.isError ? <QueryError onRetry={() => void query.refetch()}/> : query.data && selected ? <Guest360Panel data={query.data} propertyId={selected.propertyId}/> : <p role="status">{t('common.loading')}</p>}
      {selected && <Link className="mt-4 inline-block rounded-lg bg-telivity-teal px-4 py-2 text-sm font-semibold text-white" to={'/guests/' + selected.id + '?propertyId=' + selected.propertyId} onClick={() => { setPropertyId(selected.propertyId); setSelected(null); }}>{t('guestQuickView.fullProfile')} →</Link>}
    </Modal>
  </QuickViewContext.Provider>;
}

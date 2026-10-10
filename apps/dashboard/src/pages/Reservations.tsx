import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatMoney } from '../lib/money';
import { Routes, Route, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getPaginationRowModel,
  flexRender,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table';
import { CalendarDays, Plus, ChevronLeft, ChevronRight, ArrowUpDown, X, MoreHorizontal, Eye, Pencil, Ban, DoorOpen, LogIn, LogOut, Upload, UserX, Check } from 'lucide-react';
import { format, addDays, eachDayOfInterval } from 'date-fns';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { moneyString, requirePropertyId } from '../lib/api-helpers';
import { getDateLocale } from '../lib/date-locale';
import { hotelDate } from '../lib/hotel-date';
import { useAuth } from '../context/AuthContext';
import { QueryError } from '../components/ui/ErrorBoundary';
import { useGuestQuickView } from '../components/guests/GuestQuickView';
import { useProperty } from '../context/PropertyContext';
import { useToast } from '../components/ui/Toast';
import StatusBadge from '../components/ui/StatusBadge';
import Modal from '../components/ui/Modal';
import ReservationWorkspace from '../components/reservations/ReservationWorkspace';
import type { Reservation } from '../components/reservations/types';
import CreateReservationModal, {
  type CreateReservationPrefill,
} from '../components/reservations/CreateReservationModal';
import type { Guest } from '../types/guest';



/** Statuses that a bulk action can still move. */
const BULK_ELIGIBLE: Record<'check_in' | 'check_out' | 'cancel', string[]> = {
  check_in: ['confirmed', 'assigned'],
  check_out: ['checked_in', 'stayover', 'due_out'],
  cancel: ['pending', 'confirmed', 'assigned'],
};

/**
 * Parse the reservation-import textarea. The API takes pre-parsed JSON rows, so
 * this accepts either a JSON array or one CSV row per line with the columns:
 * guestId,arrivalDate,departureDate,roomTypeId,ratePlanId,totalAmount,currencyCode,source,adults,children
 */
function parseImportRows(text: string): Record<string, unknown>[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) throw new Error('Expected a JSON array of rows');
    return parsed;
  }
  return trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const [
        guestId,
        arrivalDate,
        departureDate,
        roomTypeId,
        ratePlanId,
        totalAmount,
        currencyCode,
        source,
        adults,
        children,
      ] = line.split(',').map((s) => s.trim());
      if (!currencyCode) {
        // Was `currencyCode || 'USD'`. A missing column is not a USD booking —
        // it is a row we cannot price, and importing it as dollars against a
        // property trading in anything else writes a wrong number to a ledger.
        throw new Error(`Row ${index + 1}: currencyCode is required`);
      }
      const row: Record<string, unknown> = {
        guestId,
        arrivalDate,
        departureDate,
        roomTypeId,
        ratePlanId,
        totalAmount: totalAmount ? moneyString(totalAmount) : undefined,
        currencyCode,
        source: source || 'direct',
      };
      if (adults) row.adults = Number(adults);
      if (children) row.children = Number(children);
      return row;
    });
}

// ---- Reservation List ----
function ReservationList() {
  const { t } = useTranslation();
  const { propertyId, currencyCode } = useProperty();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Filters
  const [statusFilter, setStatusFilter] = useState('');
  const [serverPage, setServerPage] = useState(1);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [sorting, setSorting] = useState<SortingState>([]);

  // Modals
  const [createOpen, setCreateOpen] = useState(false);
  const [detailRes, setDetailRes] = useState<Reservation | null>(null);
  const [actionMenu, setActionMenu] = useState<string | null>(null);
  const { toast } = useToast();

  // Bulk actions + import
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkAction, setBulkAction] = useState<'check_in' | 'check_out' | 'cancel' | ''>('');
  const [bulkReason, setBulkReason] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importResult, setImportResult] = useState<
    { created: number; failed: number; results: { index: number; error?: string }[] } | null
  >(null);

  // Create wizard state
  const [createStep, setCreateStep] = useState(0);
  const [listPrefill, setListPrefill] = useState<CreateReservationPrefill | null>(null);
  const [createCheckIn, setCreateCheckIn] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [createCheckOut, setCreateCheckOut] = useState(format(addDays(new Date(), 1), 'yyyy-MM-dd'));
  const [createAdults, setCreateAdults] = useState(1);
  const [createChildren, setCreateChildren] = useState(0);
  const [availResults, setAvailResults] = useState<{ roomTypeId: string; roomTypeName: string; ratePlans: { id: string; name: string; rate: number }[] }[]>([]);
  const [selectedRoomType, setSelectedRoomType] = useState('');
  const [selectedRatePlan, setSelectedRatePlan] = useState('');
  const [selectedGuest, setSelectedGuest] = useState<Guest | null>(null);

  useEffect(() => { setServerPage(1); setSelectedIds([]); }, [statusFilter, dateFrom, dateTo]);
  const params: Record<string, string> = { page: String(serverPage), limit: '20' };
  if (propertyId) params.propertyId = propertyId;
  if (statusFilter) params.status = statusFilter;
  if (dateFrom) params.arrivalDateFrom = dateFrom;
  if (dateTo) params.arrivalDateTo = dateTo;

  const listQuery = useQuery({
    queryKey: ['reservations', params],
    queryFn: () => api.get('/v1/reservations', { params }).then((r) => r.data),
    enabled: !!propertyId,
  });

  // Memoised so the `columns` memo below keeps a stable identity between
  // renders — its cell renderers are the element *type* passed to flexRender,
  // so a new identity remounts every cell (and drops in-flight interactions).
  const data = listQuery.data;
  const reservations: Reservation[] = useMemo(() => data?.data ?? data ?? [], [data]);

  const searchAvailMutation = useMutation({
    mutationFn: async () => {
      requirePropertyId(propertyId);
      const [availRes, rateRes] = await Promise.all([
        api.post('/v1/reservations/search-availability', {
          propertyId,
          checkIn: createCheckIn,
          checkOut: createCheckOut,
        }),
        api.get('/v1/rate-plans', { params: { propertyId } }),
      ]);
      const rows: { roomTypeId: string; roomTypeName: string; available: number }[] =
        availRes.data?.data ?? availRes.data ?? [];
      const ratePlans: { id: string; name: string; roomTypeId: string; baseAmount?: string | number }[] =
        rateRes.data?.data ?? rateRes.data ?? [];

      const byType = new Map<string, { roomTypeId: string; roomTypeName: string; minAvailable: number }>();
      for (const row of rows) {
        const existing = byType.get(row.roomTypeId);
        if (!existing) {
          byType.set(row.roomTypeId, {
            roomTypeId: row.roomTypeId,
            roomTypeName: row.roomTypeName,
            minAvailable: row.available,
          });
        } else {
          existing.minAvailable = Math.min(existing.minAvailable, row.available);
        }
      }

      return [...byType.values()]
        .filter((rt) => rt.minAvailable > 0)
        .map((rt) => ({
          roomTypeId: rt.roomTypeId,
          roomTypeName: rt.roomTypeName,
          ratePlans: ratePlans
            .filter((rp) => rp.roomTypeId === rt.roomTypeId)
            .map((rp) => ({
              id: rp.id,
              name: rp.name,
              rate: Number(rp.baseAmount ?? 0),
            })),
        }));
    },
    onSuccess: (grouped) => {
      setAvailResults(grouped);
      setCreateStep(1);
    },
  });

  const cancelMutation = useMutation({
    mutationFn: (id: string) =>
      api.patch(`/v1/reservations/${id}/cancel`, { cancellationReason: 'Cancelled by front desk' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['reservations'] }),
  });

  const noShowMutation = useMutation({
    mutationFn: (id: string) => api.patch(`/v1/reservations/${id}/no-show`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['reservations'] });
      toast('success', t('reservations.noShowMarked'));
    },
  });

  // Only reservations whose current status the chosen action can actually move.
  const eligibleSelected = bulkAction
    ? reservations.filter((r) => selectedIds.includes(r.id) && BULK_ELIGIBLE[bulkAction].includes(r.status))
    : [];

  /** Bulk check-in / check-out / cancel — the API allows partial success. */
  const bulkMutation = useMutation({
    mutationFn: () => {
      requirePropertyId(propertyId);
      return api.post(
        '/v1/reservations/bulk-action',
        {
          ids: eligibleSelected.map((r) => r.id),
          action: bulkAction,
          ...(bulkAction === 'cancel' && bulkReason.trim() ? { reason: bulkReason.trim() } : {}),
        },
        { params: { propertyId } },
      );
    },
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['reservations'] });
      const body = res.data?.data ?? res.data ?? {};
      const succeeded = body.succeeded ?? 0;
      const failed = body.failed ?? 0;
      toast(
        failed > 0 ? 'error' : 'success',
        t('reservations.bulkResult', { succeeded, failed }),
      );
      setSelectedIds([]);
      setBulkAction('');
      setBulkReason('');
    },
  });

  const importMutation = useMutation({
    mutationFn: () => {
      requirePropertyId(propertyId);
      const rows = parseImportRows(importText);
      if (rows.length === 0) throw new Error('No rows to import');
      return api.post('/v1/reservations/import', { propertyId, rows });
    },
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['reservations'] });
      setImportResult(res.data?.data ?? res.data ?? null);
    },
  });

  function resetCreateForm() {
    setCreateStep(0);
    setCreateCheckIn(format(new Date(), 'yyyy-MM-dd'));
    setCreateCheckOut(format(addDays(new Date(), 1), 'yyyy-MM-dd'));
    setCreateAdults(1);
    setCreateChildren(0);
    setAvailResults([]);
    setSelectedRoomType('');
    setSelectedRatePlan('');
    setSelectedGuest(null);
    setCreateStep(0);
  }

  function guestName(r: Reservation) {
    if (r.guestName) return r.guestName;
    if (r.guest) return `${r.guest.firstName} ${r.guest.lastName}`;
    return '—';
  }

  const pageIds = useMemo(() => reservations.map((r) => r.id), [reservations]);
  const allOnPageSelected = pageIds.length > 0 && pageIds.every((rid) => selectedIds.includes(rid));
  const cancelReservation = cancelMutation.mutate;
  const markNoShow = noShowMutation.mutate;

  const columns = useMemo<ColumnDef<Reservation>[]>(() => [
    {
      id: 'select',
      size: 36,
      // NOTE: no stopPropagation here — React derives a checkbox's onChange from
      // the click event, so stopping it would swallow the change. The row and
      // header handlers skip clicks tagged with data-row-select instead.
      header: () => (
        <input
          type="checkbox"
          data-row-select
          checked={allOnPageSelected}
          onChange={(e) => setSelectedIds(e.target.checked ? pageIds : [])}
          aria-label={t('reservations.selectAll')}
          className="rounded border-gray-300 text-telivity-teal"
        />
      ),
      cell: ({ row }) => (
        <input
          type="checkbox"
          data-row-select
          checked={selectedIds.includes(row.original.id)}
          onChange={(e) =>
            setSelectedIds((prev) =>
              e.target.checked ? [...prev, row.original.id] : prev.filter((rid) => rid !== row.original.id),
            )
          }
          aria-label={t('reservations.selectRow')}
          className="rounded border-gray-300 text-telivity-teal"
        />
      ),
    },
    {
      accessorKey: 'confirmationNumber',
      header: t('reservations.confirmation'),
      cell: ({ getValue }) => {
        const confirmation = getValue() as string;
        return <span title={confirmation}>Бронь #{confirmation?.slice(-6) ?? '—'}</span>;
      },
      size: 140,
    },
    { id: 'guest', header: t('reservations.guest'), cell: ({ row }) => guestName(row.original) },
    { accessorKey: 'roomTypeName', header: t('reservations.roomType'), cell: ({ getValue }) => (getValue() as string) ?? '—' },
    { accessorKey: 'roomNumber', header: t('reservations.roomNumber'), cell: ({ getValue }) => (getValue() as string) ?? '—', size: 80 },
    { accessorKey: 'arrivalDate', header: t('reservations.arrival'), size: 110 },
    { accessorKey: 'departureDate', header: t('reservations.departure'), size: 110 },
    {
      accessorKey: 'status', header: t('reservations.status'), cell: ({ getValue }) => {
        const status = getValue() as string;
        return <StatusBadge status={status} label={t(`reservations.statuses.${status}`, { defaultValue: status })} />;
      }, size: 120
    },
    { accessorKey: 'totalAmount', header: t('reservations.total'), cell: ({ getValue }) => getValue() != null ? formatMoney(getValue() as string | number, currencyCode) : '—', size: 100 },
    { accessorKey: 'source', header: t('reservations.source'), cell: ({ getValue }) => t('reservationWorkspace.sources.' + (getValue() ?? 'direct'), { defaultValue: '—' }), size: 90 },
    {
      id: 'actions',
      header: t('reservations.actions'),
      size: 50,
      cell: ({ row }) => (
        <div className="relative">
          <button
            onClick={(e) => { e.stopPropagation(); setActionMenu(actionMenu === row.original.id ? null : row.original.id); }}
            className="p-1 rounded hover:bg-telivity-light-grey"
          >
            <MoreHorizontal size={16} />
          </button>
          {actionMenu === row.original.id && (
            <div className="absolute right-0 top-full mt-1 bg-white rounded-lg shadow-lg border border-gray-200 z-50 py-1 w-40" onClick={(e) => e.stopPropagation()}>
              <button onClick={() => { setDetailRes(row.original); setActionMenu(null); }} className="w-full text-left px-3 py-1.5 text-sm hover:bg-telivity-light-grey flex items-center gap-2">
                <Eye size={14} /> {t('reservations.viewDetails')}
              </button>
              {row.original.status === 'pending' && (
                <button onClick={() => { api.patch(`/v1/reservations/${row.original.id}/confirm`).then(() => queryClient.invalidateQueries({ queryKey: ['reservations'] })); setActionMenu(null); }} className="w-full text-left px-3 py-1.5 text-sm hover:bg-telivity-light-grey flex items-center gap-2">
                  <Pencil size={14} /> {t('reservations.confirm')}
                </button>
              )}
              {['confirmed', 'assigned'].includes(row.original.status) && (
                <button onClick={() => { setActionMenu(null); navigate('/front-desk'); }} className="w-full text-left px-3 py-1.5 text-sm hover:bg-telivity-light-grey flex items-center gap-2">
                  <LogIn size={14} /> {t('reservations.checkIn')}
                </button>
              )}
              {row.original.status === 'checked_in' && (
                <button onClick={() => { api.patch(`/v1/reservations/${row.original.id}/check-out`, {}).then(() => queryClient.invalidateQueries({ queryKey: ['reservations'] })); setActionMenu(null); }} className="w-full text-left px-3 py-1.5 text-sm hover:bg-telivity-light-grey flex items-center gap-2">
                  <LogOut size={14} /> {t('reservations.checkOut')}
                </button>
              )}
              {['confirmed', 'assigned', 'pending'].includes(row.original.status) && (
                <button onClick={() => { if (confirm(t('reservations.confirmNoShow'))) { markNoShow(row.original.id); } setActionMenu(null); }} className="w-full text-left px-3 py-1.5 text-sm hover:bg-telivity-light-grey flex items-center gap-2">
                  <UserX size={14} /> {t('reservations.markNoShow')}
                </button>
              )}
              {!['cancelled', 'checked_out', 'no_show'].includes(row.original.status) && (
                <button onClick={() => { if (confirm(t('reservations.confirmCancellation'))) { cancelReservation(row.original.id); } setActionMenu(null); }} className="w-full text-left px-3 py-1.5 text-sm text-telivity-orange hover:bg-telivity-light-grey flex items-center gap-2">
                  <Ban size={14} /> {t('common.cancel')}
                </button>
              )}
            </div>
          )}
        </div>
      ),
    },
  ], [actionMenu, queryClient, navigate, cancelReservation, markNoShow, selectedIds, allOnPageSelected, pageIds, t]);

  const table = useReactTable({
    data: reservations,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize: 20 } },
  });

  if (!propertyId) {
    return <div className="flex items-center justify-center h-64 text-telivity-mid-grey">{t('reservations.selectProperty')}</div>;
  }

  return (
    <div onClick={() => setActionMenu(null)}>
      <div className="flex items-center gap-3 mb-6">
        <CalendarDays size={24} className="text-telivity-teal" />
        <h1 className="text-2xl font-semibold text-telivity-navy">{t('reservations.title')}</h1>
        <div className="ml-auto flex gap-2 flex-wrap">
          <button onClick={() => navigate('/reservations/unassigned')} className="border border-gray-200 text-telivity-slate rounded-lg px-4 py-2 text-sm font-semibold hover:bg-telivity-light-grey transition-colors">
            {t('reservations.unassignedQueue')}
          </button>
          <button onClick={() => { setImportText(''); setImportResult(null); setImportOpen(true); }} className="flex items-center gap-2 border border-gray-200 text-telivity-slate rounded-lg px-4 py-2 text-sm font-semibold hover:bg-telivity-light-grey transition-colors">
            <Upload size={16} /> {t('reservations.import')}
          </button>
          <button onClick={() => navigate('/reservations/calendar')} className="border border-gray-200 text-telivity-slate rounded-lg px-4 py-2 text-sm font-semibold hover:bg-telivity-light-grey transition-colors">
            {t('reservations.calendar')}
          </button>
          <button onClick={() => { resetCreateForm(); setCreateOpen(true); }} className="flex items-center gap-2 bg-telivity-teal text-white rounded-lg px-4 py-2 text-sm font-semibold hover:bg-telivity-light-teal transition-colors">
            <Plus size={16} /> {t('reservations.newReservation')}
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-xl shadow-sm p-4 mb-4 flex flex-wrap gap-3 items-end">
        <div>
          <label className="block text-xs font-medium text-telivity-mid-grey mb-1">{t('reservations.status')}</label>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-telivity-teal">
            <option value="">{t('reservations.all')}</option>
            <option value="pending">{t('reservations.statuses.pending')}</option>
            <option value="confirmed">{t('reservations.statuses.confirmed')}</option>
            <option value="checked_in">{t('reservations.statuses.checked_in')}</option>
            <option value="checked_out">{t('reservations.statuses.checked_out')}</option>
            <option value="cancelled">{t('reservations.statuses.cancelled')}</option>
            <option value="no_show">{t('reservations.statuses.no_show')}</option>
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-telivity-mid-grey mb-1">{t('reservations.from')}</label>
          <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-telivity-teal" />
        </div>
        <div>
          <label className="block text-xs font-medium text-telivity-mid-grey mb-1">{t('reservations.to')}</label>
          <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-telivity-teal" />
        </div>
        {(statusFilter || dateFrom || dateTo) && (
          <button onClick={() => { setStatusFilter(''); setDateFrom(''); setDateTo(''); }} className="p-2 text-telivity-mid-grey hover:text-telivity-orange">
            <X size={16} />
          </button>
        )}
      </div>

      {/* Bulk action bar */}
      {selectedIds.length > 0 && (
        <div className="bg-telivity-navy text-white rounded-xl shadow-sm p-3 mb-4 flex flex-wrap items-center gap-3">
          <span className="text-sm font-semibold">{t('reservations.selectedCount', { count: selectedIds.length })}</span>
          <select
            value={bulkAction}
            onChange={(e) => setBulkAction(e.target.value as typeof bulkAction)}
            aria-label={t('reservations.chooseBulkAction')}
            className="border border-white/30 bg-telivity-navy rounded-lg px-3 py-1.5 text-sm"
          >
            <option value="">{t('reservations.chooseBulkAction')}</option>
            <option value="check_in">{t('reservations.bulkCheckIn')}</option>
            <option value="check_out">{t('reservations.bulkCheckOut')}</option>
            <option value="cancel">{t('reservations.bulkCancel')}</option>
          </select>
          {bulkAction === 'cancel' && (
            <input
              type="text"
              value={bulkReason}
              onChange={(e) => setBulkReason(e.target.value)}
              placeholder={t('reservations.cancellationReason')}
              className="border border-white/30 bg-telivity-navy rounded-lg px-3 py-1.5 text-sm placeholder-white/50"
            />
          )}
          {bulkAction && (
            <span className="text-xs text-white/70">
              {t('reservations.bulkEligible', { eligible: eligibleSelected.length, total: selectedIds.length })}
            </span>
          )}
          <button
            onClick={() => bulkMutation.mutate()}
            disabled={!bulkAction || eligibleSelected.length === 0 || bulkMutation.isPending}
            className="ml-auto flex items-center gap-1 bg-telivity-teal text-white rounded-lg px-4 py-1.5 text-sm font-semibold disabled:opacity-40"
          >
            <Check size={14} /> {t('reservations.applyBulk')}
          </button>
          <button onClick={() => { setSelectedIds([]); setBulkAction(''); }} className="p-1.5 rounded hover:bg-white/10">
            <X size={16} />
          </button>
        </div>
      )}

      {/* Table */}
      <div className="bg-white rounded-xl shadow-sm overflow-visible">
        <table className="w-full">
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id} className="bg-telivity-teal/5 border-b border-gray-100">
                {hg.headers.map((h) => (
                  <th
                    key={h.id}
                    className="px-4 py-3 text-left text-xs font-semibold text-telivity-slate uppercase tracking-wider cursor-pointer select-none"
                    onClick={(e) => {
                      if ((e.target as HTMLElement).closest('[data-row-select]')) return;
                      h.column.getToggleSortingHandler()?.(e);
                    }}
                  >
                    <span className="flex items-center gap-1">
                      {flexRender(h.column.columnDef.header, h.getContext())}
                      {h.column.getCanSort() && <ArrowUpDown size={12} className="text-telivity-mid-grey" />}
                    </span>
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row, i) => (
              <tr
                key={row.id}
                className={`border-b border-gray-50 ${i % 2 === 1 ? 'bg-gray-50/50' : ''} hover:bg-telivity-light-grey/50 transition-colors cursor-pointer`}
                onClick={(e) => {
                  if ((e.target as HTMLElement).closest('[data-row-select]')) return;
                  setDetailRes(row.original);
                }}
              >
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className="px-4 py-3 text-sm">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
            {reservations.length === 0 && (
              <tr><td colSpan={columns.length} className="px-4 py-8 text-center text-sm text-telivity-mid-grey">{t('reservations.empty')}</td></tr>
            )}
          </tbody>
        </table>

        {/* Pagination */}
        {(data?.total ?? 0) > 20 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100">
            <span className="text-xs text-telivity-mid-grey">
              {t('reservations.pagination', { page: serverPage, total: Math.ceil(data.total / 20), count: data.total })}
            </span>
            <div className="flex gap-1">
              <button onClick={() => setServerPage(p => p - 1)} disabled={serverPage <= 1} className="p-1.5 rounded hover:bg-telivity-light-grey disabled:opacity-30">
                <ChevronLeft size={16} />
              </button>
              <button onClick={() => setServerPage(p => p + 1)} disabled={!data?.hasMore} className="p-1.5 rounded hover:bg-telivity-light-grey disabled:opacity-30">
                <ChevronRight size={16} />
              </button>
            </div>
          </div>
        )}
      </div>

      {detailRes && <ReservationWorkspace key={propertyId + detailRes.id} reservationId={detailRes.id} initial={detailRes} onClose={() => setDetailRes(null)}/>}

      {listQuery.isError && <QueryError onRetry={() => void listQuery.refetch()}/>}
      {/* Import Reservations Modal */}
      <Modal open={importOpen} onClose={() => setImportOpen(false)} title={t('reservations.importReservations')} wide>
        <div className="space-y-4">
          <p className="text-xs text-telivity-mid-grey">{t('reservations.importHint')}</p>
          <textarea
            value={importText}
            onChange={(e) => { setImportText(e.target.value); setImportResult(null); }}
            rows={8}
            placeholder={'<guestId>,2026-06-01,2026-06-04,<roomTypeId>,<ratePlanId>,599.00,USD,direct,2,0'}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono"
          />
          {importResult && (
            <div className="rounded-lg border border-gray-200 p-3 text-sm space-y-1 max-h-48 overflow-y-auto">
              <p className="font-semibold text-telivity-navy">
                {t('reservations.importResult', { created: importResult.created, failed: importResult.failed })}
              </p>
              {importResult.results
                .filter((r) => r.error)
                .map((r) => (
                  <p key={r.index} className="text-xs text-red-600">
                    {t('reservations.importRowError', { row: r.index + 1, error: r.error })}
                  </p>
                ))}
            </div>
          )}
          <button
            onClick={() => importMutation.mutate()}
            disabled={!importText.trim() || importMutation.isPending}
            className="w-full bg-telivity-teal text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
          >
            {importMutation.isPending ? t('reservations.importing') : t('reservations.importReservations')}
          </button>
        </div>
      </Modal>

      {/* Create Reservation Modal */}
      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title={t('reservations.newReservation')} wide>
        {createStep === 0 && (
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-telivity-navy">{t('reservations.searchAvailabilityStep')}</h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-telivity-mid-grey mb-1">{t('reservations.checkIn')}</label>
                <input type="date" value={createCheckIn} onChange={(e) => setCreateCheckIn(e.target.value)} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-telivity-teal" />
              </div>
              <div>
                <label className="block text-xs font-medium text-telivity-mid-grey mb-1">{t('reservations.checkOut')}</label>
                <input type="date" value={createCheckOut} onChange={(e) => setCreateCheckOut(e.target.value)} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-telivity-teal" />
              </div>
              <div>
                <label className="block text-xs font-medium text-telivity-mid-grey mb-1">{t('reservations.adults')}</label>
                <input type="number" min={1} value={createAdults} onChange={(e) => setCreateAdults(Number(e.target.value))} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-telivity-teal" />
              </div>
              <div>
                <label className="block text-xs font-medium text-telivity-mid-grey mb-1">{t('reservations.children')}</label>
                <input type="number" min={0} value={createChildren} onChange={(e) => setCreateChildren(Number(e.target.value))} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-telivity-teal" />
              </div>
            </div>
            <button onClick={() => searchAvailMutation.mutate()} disabled={searchAvailMutation.isPending} className="w-full bg-telivity-teal text-white rounded-lg px-4 py-2 text-sm font-semibold hover:bg-telivity-light-teal disabled:opacity-50">
              {searchAvailMutation.isPending ? t('reservations.searching') : t('reservations.searchAvailability')}
            </button>
          </div>
        )}

        {createStep === 1 && (
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-telivity-navy">{t('reservations.selectRoomRateStep')}</h3>
            {availResults.length === 0 ? (
              <p className="text-sm text-telivity-mid-grey">{t('reservations.noAvailability')}</p>
            ) : (
              <div className="space-y-2">
                {availResults.map((rt) => (
                  <div key={rt.roomTypeId} className={`border rounded-lg p-3 cursor-pointer transition-colors ${selectedRoomType === rt.roomTypeId ? 'border-telivity-teal bg-telivity-teal/5' : 'border-gray-200 hover:border-telivity-teal/50'}`} onClick={() => setSelectedRoomType(rt.roomTypeId)}>
                    <p className="text-sm font-semibold text-telivity-navy">{rt.roomTypeName}</p>
                    <div className="mt-2 space-y-1">
                      {(rt.ratePlans ?? []).map((rp) => (
                        <label key={rp.id} className="flex items-center gap-2 text-sm cursor-pointer">
                          <input type="radio" name="ratePlan" value={rp.id} checked={selectedRatePlan === rp.id} onChange={() => { setSelectedRoomType(rt.roomTypeId); setSelectedRatePlan(rp.id); }} className="text-telivity-teal" />
                          {rp.name}
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="flex gap-3">
              <button onClick={() => setCreateStep(0)} className="flex-1 border border-gray-200 text-telivity-slate rounded-lg px-4 py-2 text-sm font-semibold">{t('reservations.back')}</button>
              <button onClick={() => { setListPrefill({ ratePlanId: selectedRatePlan, adults: createAdults, children: createChildren, roomTypeId: selectedRoomType, roomNumber: t('reservations.unassigned'), roomTypeName: availResults.find(rt => rt.roomTypeId === selectedRoomType)?.roomTypeName, checkInDate: createCheckIn, checkOutDate: createCheckOut }); setCreateOpen(false); }} disabled={!selectedRatePlan} className="flex-1 bg-telivity-teal text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50">{t('reservations.next')}</button>
            </div>
          </div>
        )}

      </Modal>
      <CreateReservationModal open={!!listPrefill} prefill={listPrefill} onClose={() => setListPrefill(null)}/>
    </div>
  );
}


interface TapeRoom {
  id: string;
  number: string;
  status?: string;
  roomTypeId?: string;
  isAccessible?: boolean;
}

/** Room-level states that cannot be sold, whatever the date. */
const UNSELLABLE_ROOM_STATUSES = ['out_of_order', 'out_of_service'];

/**
 * Interactive tape chart: drag across a room row to select the nights, drop to
 * open the create modal.
 *
 * Two rules that look like details and are not:
 *
 * 1. A drag is locked to the row it STARTED on. The pointer wandering onto a
 *    neighbouring row must never retarget the booking — that is how a guest
 *    ends up in someone else's room.
 * 2. The release is finalised from a window-level mouseup, not the cell's. A
 *    pointer let go outside the grid otherwise leaves the chart stuck in a
 *    selecting state that keeps repainting as the mouse moves.
 */
function AvailabilityCalendar() {
  const { t, i18n } = useTranslation();
  const { propertyId, currencyCode, properties } = useProperty();
  const { hasPermission } = useAuth();
  const { openGuest } = useGuestQuickView();
  const navigate = useNavigate();
  const { toast } = useToast();
  const dateLocale = getDateLocale(i18n.resolvedLanguage);
  const todayKey = hotelDate(properties.find(p => p.id === propertyId)?.timezone);
  const [startDate, setStartDate] = useState(new Date(todayKey + 'T00:00:00'));
  const [statusFilter, setStatusFilter] = useState('');
  const [accessibleOnly, setAccessibleOnly] = useState(false);
  const [priceMode, setPriceMode] = useState(false); const [previewRatePlan, setPreviewRatePlan] = useState('');
  const [dayCount, setDayCount] = useState(14);
  const [search, setSearch] = useState('');
  const [roomTypeFilter, setRoomTypeFilter] = useState('');
  const days = eachDayOfInterval({ start: startDate, end: addDays(startDate, dayCount - 1) });
  const dayKeys = days.map((d) => format(d, 'yyyy-MM-dd'));

  const [drag, setDrag] = useState<{ roomId: string; anchor: string; hovered: string } | null>(null);
  const [prefill, setPrefill] = useState<CreateReservationPrefill | null>(null);
  const [detailRes, setDetailRes] = useState<Reservation | null>(null);

  const calendarQuery = useQuery({
    queryKey: ['reservations', 'calendar', propertyId, dayKeys[0], dayCount],
    queryFn: () => api.get('/v1/reservations/calendar', { params: { propertyId, checkIn: dayKeys[0], checkOut: format(addDays(startDate, dayCount), 'yyyy-MM-dd') }, skipErrorToast: true }).then(r => r.data?.data ?? r.data),
    enabled: !!propertyId && hasPermission('reservations.read', 'rooms.read'),
  });
  const ledgerQuery = useQuery({ queryKey: ['calendar-ledger', propertyId, dayKeys[0], dayCount], enabled: !!propertyId && hasPermission('folios.read'), queryFn: () => api.get('/v1/reservations/calendar-ledger', { params: { propertyId, checkIn: dayKeys[0], checkOut: format(addDays(startDate, dayCount), 'yyyy-MM-dd') }, skipErrorToast: true }).then(r => r.data?.data ?? r.data) });
  const ledgerByStay = new Map<string, { hasPostedPayment: boolean; hasBalanceDue: boolean }>((ledgerQuery.data ?? []).map((row: any) => [row.reservationId, row]));
  const plansQuery = useQuery({ queryKey: ['rate-plans', propertyId], enabled: priceMode && !!propertyId && hasPermission('rateplans.read'), queryFn: () => api.get('/v1/rate-plans', { params: { propertyId }, skipErrorToast: true }).then(r => r.data?.data ?? r.data) });
  const pricesQuery = useQuery({ queryKey: ['calendar-prices', propertyId, previewRatePlan, dayKeys[0], dayCount], enabled: priceMode && !!previewRatePlan && !!propertyId && hasPermission('rateplans.read'), queryFn: () => api.get('/v1/reservations/calendar-prices', { params: { propertyId, ratePlanId: previewRatePlan, checkIn: dayKeys[0], checkOut: format(addDays(startDate, dayCount), 'yyyy-MM-dd') }, skipErrorToast: true }).then(r => r.data?.data ?? r.data) });
  const rooms: TapeRoom[] = calendarQuery.data?.rooms ?? [];
  const roomTypes: { id: string; name: string }[] = calendarQuery.data?.roomTypes ?? [];
  const reservations: Reservation[] = calendarQuery.data?.reservations ?? [];
  const blocks: { roomTypeId: string; startDate: string; endDate: string }[] = calendarQuery.data?.blocks ?? [];
  const cellIndex = useMemo(() => {
    const map = new Map<string, Reservation>();
    for (const r of reservations) for (const date of dayKeys) if (r.roomId && r.arrivalDate <= date && r.departureDate > date) map.set(r.roomId + ':' + date, r);
    return map;
  }, [reservations, dayKeys.join(',')]);
  const getResForCell = useCallback((roomId: string, date: string) => cellIndex.get(roomId + ':' + date), [cellIndex]);
  /**
   * Sellability of one cell.
   *
   * OOO / OOS is a property of the ROOM, so it blocks every date. "Vacant
   * dirty" is a property of the room RIGHT NOW — it blocks tonight, because
   * nobody can be walked into an uncleaned room, but it says nothing about next
   * Tuesday, and refusing future bookings on it would take sellable inventory
   * off the chart every morning.
   */
  const cellState = useCallback(
    (room: TapeRoom, date: string): 'booked' | 'blocked' | 'dirty' | 'free' => {
      if (getResForCell(room.id, date)) return 'booked';
      if (calendarQuery.data?.availability?.some((a: any) => a.roomTypeId === room.roomTypeId && a.date === date && a.available <= 0)) return 'blocked';
      if (room.status && UNSELLABLE_ROOM_STATUSES.includes(room.status)) return 'blocked';
      if (room.status === 'vacant_dirty' && date === todayKey) return 'dirty';
      return 'free';
    },
    [getResForCell, todayKey, calendarQuery.data],
  );

  const rangeKeys = useCallback((from: string, to: string) => {
    const [first, last] = from <= to ? [from, to] : [to, from];
    return dayKeys.filter((key) => key >= first && key <= last);
  }, [dayKeys]);

  const isSelected = (roomId: string, date: string) =>
    !!drag && drag.roomId === roomId && date >= drag.anchor && date <= drag.hovered;

  // Finalising on the window means a release anywhere ends the drag — including
  // outside the table, where a cell-level handler never fires.
  useEffect(() => {
    if (!drag) return;
    function finish() {
      setDrag(null);
      if (!drag) return;
      const room = rooms.find((r) => r.id === drag.roomId);
      if (!room) return;
      const nights = rangeKeys(drag.anchor, drag.hovered);
      if (nights.length === 0) return;
      if (nights.some((date) => cellState(room, date) !== 'free')) {
        // Abort outright rather than silently trimming the range: a half-length
        // stay the user did not ask for is worse than no selection at all.
        toast('error', t('reservations.tape.unavailable'));
        return;
      }
      const checkIn = nights[0];
      const checkOut = format(addDays(new Date(`${nights[nights.length - 1]}T00:00:00`), 1), 'yyyy-MM-dd');
      setPrefill({
        roomId: room.id,
        roomNumber: room.number,
        roomTypeId: room.roomTypeId ?? '',
        roomTypeName: roomTypes.find((rt) => rt.id === room.roomTypeId)?.name,
        checkInDate: checkIn,
        checkOutDate: checkOut,
      });
    }
    window.addEventListener('mouseup', finish);
    // Escape must abandon a drag: a user who starts one on a wrong row needs a
    // way out that is not "release and cancel a modal".
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setDrag(null);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mouseup', finish);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [drag, rooms, roomTypes, rangeKeys, cellState, toast, t]);

  const visibleRooms = rooms.filter((room) => {
    if (roomTypeFilter && room.roomTypeId !== roomTypeFilter) return false;
    if (accessibleOnly && !room.isAccessible) return false;
    if (statusFilter && !reservations.some(r => r.roomId === room.id && r.status === statusFilter)) return false;
    const needle = search.trim().toLocaleLowerCase();
    return !needle || room.number.toLocaleLowerCase().includes(needle) || reservations.some((r) => r.roomId === room.id && [r.guestName, r.guest?.firstName, r.guest?.lastName, r.confirmationNumber].some((v) => v?.toLocaleLowerCase().includes(needle)));
  });

  if (!propertyId) {
    return <div className="flex items-center justify-center h-64 text-telivity-mid-grey">{t('common.selectProperty')}</div>;
  }

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <button onClick={() => navigate('/reservations')} className="p-1.5 rounded hover:bg-telivity-light-grey">
          <ChevronLeft size={20} />
        </button>
        <CalendarDays size={24} className="text-telivity-teal" />
        <div>
          <h1 className="text-2xl font-semibold text-telivity-navy">{t('reservations.availabilityCalendar')}</h1>
          <p className="text-xs text-telivity-mid-grey">{t('reservations.tape.dragHint')}</p>
        </div>
        <div className="ml-auto flex gap-2">
          <button onClick={() => setStartDate(addDays(startDate, -7))} className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm hover:bg-telivity-light-grey" aria-label={t('reservations.tape.previousWeek')}>
            <ChevronLeft size={14} />
          </button>
          <button onClick={() => setStartDate(new Date(todayKey + 'T00:00:00'))} className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm hover:bg-telivity-light-grey">
            {t('reservations.today')}
          </button>
          <button onClick={() => setStartDate(addDays(startDate, 7))} className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm hover:bg-telivity-light-grey" aria-label={t('reservations.tape.nextWeek')}>
            <ChevronRight size={14} />
          </button>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap gap-3">
        <input value={search} onChange={(e) => setSearch(e.target.value)} aria-label={t('reservationWorkspace.search')} placeholder={t('reservationWorkspace.search')} className="min-w-[240px] flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm"/>
        <select value={roomTypeFilter} onChange={(e) => setRoomTypeFilter(e.target.value)} aria-label={t('reservations.roomType')} className="rounded-lg border border-gray-200 px-3 py-2 text-sm"><option value="">{t('reservationWorkspace.allTypes')}</option>{roomTypes.map((rt) => <option key={rt.id} value={rt.id}>{rt.name}</option>)}</select>
        <select value={dayCount} onChange={(e) => setDayCount(Number(e.target.value))} aria-label={t('reservations.availabilityCalendar')} className="rounded-lg border border-gray-200 px-3 py-2 text-sm">{[7,14,28].map((n) => <option key={n} value={n}>{t('reservationWorkspace.days', { count:n })}</option>)}</select>
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-3 text-sm"><input type="date" aria-label={t('reservations.arrival')} value={dayKeys[0]} onChange={e => { if (e.target.value) setStartDate(new Date(e.target.value + 'T00:00:00')); }} className="rounded-lg border p-2"/><select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} aria-label={t('reservations.status')} className="rounded-lg border p-2"><option value="">{t('reservationWorkspace.allStatuses')}</option>{['pending','confirmed','assigned','checked_in','stayover','due_out'].map(s => <option key={s} value={s}>{t('reservations.statuses.' + s)}</option>)}</select><label className="flex items-center gap-2"><input type="checkbox" checked={accessibleOnly} onChange={e => setAccessibleOnly(e.target.checked)}/>{t('reservationWorkspace.accessible')}</label></div>
      {hasPermission('rateplans.read') && <div className="mb-3 flex flex-wrap items-center gap-3 text-sm"><label className="flex items-center gap-2"><input type="checkbox" checked={priceMode} onChange={e => setPriceMode(e.target.checked)}/>{t('reservationWorkspace.priceMode')}</label>{priceMode && <><select value={previewRatePlan} onChange={e => setPreviewRatePlan(e.target.value)} aria-label={t('reservations.ratePlan')} className="rounded-lg border p-2"><option value="">{t('reservations.tape.selectRatePlan')}</option>{(plansQuery.data ?? []).map((plan: any) => <option key={plan.id} value={plan.id}>{plan.name}</option>)}</select><p className="text-xs text-gray-500">{t('reservationWorkspace.pricePreview')}</p></>}</div>}
      {(plansQuery.isError || pricesQuery.isError) && <QueryError onRetry={() => { void plansQuery.refetch(); if (previewRatePlan) void pricesQuery.refetch(); }}/>}
      {blocks.length > 0 && <p className="mb-3 rounded-lg bg-orange-50 p-3 text-xs text-orange-800">{t('reservationWorkspace.icalPool', { count: blocks.length })}</p>}
      {calendarQuery.isError && <QueryError onRetry={() => void calendarQuery.refetch()}/>}
      {calendarQuery.isPending && <p role="status" className="mb-4 text-sm">{t('common.loading')}</p>}
      <div className="flex flex-wrap gap-4 mb-3 text-xs text-telivity-mid-grey">
        <LegendSwatch className="bg-telivity-teal/20" label={t('reservations.tape.legendBooked')} />
        <LegendSwatch className="bg-telivity-orange/25" label={t('reservations.tape.legendBlocked')} />
        <LegendSwatch className="bg-yellow-100" label={t('reservations.tape.legendDirty')} />
        <LegendSwatch className="bg-telivity-teal/60" label={t('reservations.tape.legendSelecting')} />
      </div>

      <div className="bg-white rounded-xl shadow-sm overflow-auto max-h-[70vh]">
        <table className="w-full select-none" style={{ minWidth: dayCount * 80 + 160, tableLayout: 'fixed' }}>
          <thead className="sticky top-0 z-20 bg-white">
            <tr className="bg-telivity-teal/5 border-b border-gray-100">
              <th className="px-3 py-2 text-left text-xs font-semibold text-telivity-slate w-40 sticky left-0 bg-white z-30">{t('reservations.room')}</th>
              {days.map((d) => (
                <th key={d.toISOString()} className="px-1 py-2 text-center text-xs font-medium text-telivity-slate min-w-[60px]">
                  <div>{format(d, 'EEE', { locale: dateLocale })}</div>
                  <div className="text-telivity-mid-grey">{format(d, 'd MMM', { locale: dateLocale })}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleRooms.map((room, i) => (
              <tr key={room.id} className={`border-b border-gray-50 ${i % 2 === 1 ? 'bg-gray-50/30' : ''}`}>
                <td className="px-3 py-2 text-xs font-medium text-telivity-navy sticky left-0 bg-white">{room.number}<div className="mt-1 text-[10px] text-telivity-mid-grey">{roomTypes.find((rt) => rt.id === room.roomTypeId)?.name}</div></td>
                <td colSpan={dayCount} className="p-0"><div className="relative h-20">
                  <div className="grid h-full" style={{ gridTemplateColumns: 'repeat(' + dayCount + ', minmax(60px, 1fr))' }}>{dayKeys.map(date => {
                    const state = cellState(room, date); const free = state === 'free' && !calendarQuery.isFetching && calendarQuery.data?.complete === true && hasPermission('reservations.write', 'rateplans.read');
                    return <button key={date} disabled={!free} aria-label={t('reservationWorkspace.selectNight', { room: room.number, date })}
                      onMouseDown={e => { if (free) { e.preventDefault(); setDrag({ roomId: room.id, anchor: date, hovered: date }); } }}
                      onMouseEnter={() => { if (drag?.roomId === room.id && date >= drag.anchor) setDrag({ ...drag, hovered: date }); }}
                      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPrefill({ roomId: room.id, roomNumber: room.number, roomTypeId: room.roomTypeId ?? '', checkInDate: date, checkOutDate: format(addDays(new Date(date + 'T00:00:00'), 1), 'yyyy-MM-dd') }); } }}
                      className={'h-full border-r border-gray-100 ' + (isSelected(room.id, date) ? 'bg-telivity-teal/50' : state === 'blocked' ? 'bg-orange-100' : state === 'dirty' ? 'bg-yellow-100' : 'hover:bg-teal-50')}
                      title={state === 'blocked' ? t('reservations.tape.legendBlocked') : state === 'dirty' ? t('reservations.tape.legendDirty') : date}>{priceMode && pricesQuery.data?.roomTypeId === room.roomTypeId && <span className="block pt-14 text-[10px] font-medium text-gray-600">{formatMoney(pricesQuery.data.prices.find((p: any) => p.date === date)?.totalAmount, currencyCode)}</span>}</button>
                  })}</div>
                  {reservations.filter(r => r.roomId === room.id && (!statusFilter || r.status === statusFilter)).map(res => {
                    const left = res.arrivalDate < dayKeys[0] ? 0 : dayKeys.indexOf(res.arrivalDate);
                    const right = res.departureDate > dayKeys[dayCount - 1] ? dayCount : dayKeys.indexOf(res.departureDate);
                    if (left < 0 || right <= left) return null;
                    return <div key={res.id} className={'absolute top-2 flex h-16 items-center gap-1 rounded-lg border px-2 text-xs shadow-sm ' + (['checked_in','stayover','due_out'].includes(res.status) ? 'border-teal-300 bg-teal-100' : 'border-blue-200 bg-blue-50')}
                      style={{ left: 'calc(' + left/dayCount*100 + '% + 2px)', width: 'calc(' + (right-left)/dayCount*100 + '% - 4px)' }}>
                      <button className="min-w-0 flex-1 text-left" onClick={() => setDetailRes(res)} aria-label={t('reservationWorkspace.open', { number: res.confirmationNumber })}><strong className="block truncate text-telivity-navy">{res.guestName ?? res.confirmationNumber?.slice(-6)}</strong><span className="block truncate text-[10px] text-telivity-slate">{t('reservations.statuses.' + res.status)} · {t('reservationWorkspace.sources.' + res.source, { defaultValue: t('reservationWorkspace.unknownStatus') })}</span>{hasPermission('folios.read') && <span className="block truncate text-[9px]">{ledgerQuery.isError ? t('reservations.tape.ledgerUnavailable') : ledgerQuery.isPending ? '…' : ledgerByStay.get(res.id)?.hasBalanceDue ? t('reservations.tape.balanceDue') : ledgerByStay.get(res.id)?.hasPostedPayment ? t('reservations.tape.paymentRecorded') : t('reservations.tape.noPaymentRecorded')}</span>}</button>
                      {res.guestId && hasPermission('guests.read') && <button className="rounded p-1 text-telivity-teal" aria-label={t('guestQuickView.title')} onClick={() => openGuest(res.guestId!, propertyId)}>◉</button>}
                    </div>;
                  })}
                </div></td>
              </tr>
            ))}
            {visibleRooms.length === 0 && (
              <tr><td colSpan={dayCount + 1} className="px-4 py-8 text-center text-sm text-telivity-mid-grey">{t('rooms.noRoomsFound')}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <CreateReservationModal
        key={propertyId}
        open={!!prefill}
        prefill={prefill}
        onClose={() => setPrefill(null)}
      />

      {detailRes && <ReservationWorkspace key={propertyId + detailRes.id} reservationId={detailRes.id} initial={detailRes} onClose={() => setDetailRes(null)}/>}

    </div>
  );
}

function LegendSwatch({ className, label }: { className: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`inline-block w-3 h-3 rounded ${className}`} aria-hidden="true" />
      {label}
    </span>
  );
}

// ---- Unassigned Queue ----
/**
 * Assignable-but-unassigned reservations (confirmed/assigned with no room).
 * The API filters this window with `from` / `to`, not the list endpoint's
 * arrivalDateFrom / arrivalDateTo.
 */
function UnassignedQueue() {
  const { t } = useTranslation();
  const { propertyId } = useProperty();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [from, setFrom] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [to, setTo] = useState(format(addDays(new Date(), 7), 'yyyy-MM-dd'));
  const [assignFor, setAssignFor] = useState<Reservation | null>(null);
  const [assignRoomId, setAssignRoomId] = useState('');

  const { data } = useQuery({
    queryKey: ['reservations', 'unassigned', propertyId, from, to],
    queryFn: () =>
      api
        .get('/v1/reservations/unassigned', { params: { propertyId, from, to } })
        .then((r) => r.data),
    enabled: !!propertyId,
  });

  const { data: roomsData } = useQuery({
    queryKey: ['rooms', propertyId, 'available'],
    queryFn: () =>
      api.get('/v1/rooms', { params: { propertyId, status: 'available' } }).then((r) => r.data),
    enabled: !!propertyId && !!assignFor,
  });

  const rows: (Reservation & { reasonHint?: string })[] = data?.data ?? (Array.isArray(data) ? data : []);
  const total = data?.total ?? rows.length;
  const rooms: { id: string; number: string; roomTypeId?: string }[] = roomsData?.data ?? roomsData ?? [];
  // Prefer rooms matching the reservation's room type; fall back to all available.
  const matchingRooms = assignFor?.roomTypeId
    ? rooms.filter((r) => !r.roomTypeId || r.roomTypeId === assignFor.roomTypeId)
    : rooms;

  const assignMutation = useMutation({
    mutationFn: () =>
      api.patch(`/v1/reservations/${assignFor!.id}/assign-room`, { roomId: assignRoomId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['reservations'] });
      setAssignFor(null);
      setAssignRoomId('');
      toast('success', t('reservations.roomAssigned'));
    },
  });

  if (!propertyId) {
    return <div className="flex items-center justify-center h-64 text-telivity-mid-grey">{t('common.selectProperty')}</div>;
  }

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <button onClick={() => navigate('/reservations')} className="p-1.5 rounded hover:bg-telivity-light-grey">
          <ChevronLeft size={20} />
        </button>
        <DoorOpen size={24} className="text-telivity-teal" />
        <h1 className="text-2xl font-semibold text-telivity-navy">{t('reservations.unassignedQueue')}</h1>
        <span className="rounded-full bg-telivity-orange/15 text-telivity-orange text-xs font-semibold px-2.5 py-1">
          {total}
        </span>
      </div>

      <div className="bg-white rounded-xl shadow-sm p-4 mb-4 flex flex-wrap gap-3 items-end">
        <div>
          <label className="block text-xs font-medium text-telivity-mid-grey mb-1">{t('reservations.from')}</label>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
        </div>
        <div>
          <label className="block text-xs font-medium text-telivity-mid-grey mb-1">{t('reservations.to')}</label>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="bg-telivity-teal/5 border-b border-gray-100">
              <th className="px-4 py-3 text-left text-xs font-semibold text-telivity-slate uppercase">{t('reservations.confirmation')}</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-telivity-slate uppercase">{t('reservations.guest')}</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-telivity-slate uppercase">{t('reservations.roomType')}</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-telivity-slate uppercase">{t('reservations.arrival')}</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-telivity-slate uppercase">{t('reservations.status')}</th>
              <th className="px-4 py-3 text-right text-xs font-semibold text-telivity-slate uppercase">{t('reservations.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.id} className={`border-b border-gray-50 ${i % 2 === 1 ? 'bg-gray-50/50' : ''}`}>
                <td className="px-4 py-3 text-sm font-medium text-telivity-navy">{r.confirmationNumber}</td>
                <td className="px-4 py-3 text-sm text-telivity-slate">{r.guestName ?? '—'}</td>
                <td className="px-4 py-3 text-sm text-telivity-slate">{r.roomTypeName ?? '—'}</td>
                <td className="px-4 py-3 text-sm text-telivity-slate">{r.arrivalDate}</td>
                <td className="px-4 py-3">
                  <StatusBadge status={r.status} label={t(`reservations.statuses.${r.status}`, { defaultValue: r.status })} />
                </td>
                <td className="px-4 py-3 text-right">
                  <button
                    onClick={() => { setAssignFor(r); setAssignRoomId(''); }}
                    className="text-xs font-semibold text-telivity-teal hover:underline"
                  >
                    {t('reservations.assignRoom')}
                  </button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-sm text-telivity-mid-grey">{t('reservations.noUnassigned')}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <Modal open={!!assignFor} onClose={() => setAssignFor(null)} title={t('reservations.assignRoom')}>
        <div className="space-y-4">
          <p className="text-sm text-telivity-mid-grey">
            {assignFor?.confirmationNumber} · {assignFor?.roomTypeName ?? '—'}
          </p>
          <select value={assignRoomId} onChange={(e) => setAssignRoomId(e.target.value)} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm">
            <option value="">{t('reservations.selectRoom')}</option>
            {matchingRooms.map((room) => (
              <option key={room.id} value={room.id}>{room.number}</option>
            ))}
          </select>
          {matchingRooms.length === 0 && (
            <p className="text-xs text-telivity-mid-grey">{t('reservations.noAvailableRooms')}</p>
          )}
          <button
            onClick={() => assignMutation.mutate()}
            disabled={!assignRoomId || assignMutation.isPending}
            className="w-full bg-telivity-teal text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
          >
            {t('reservations.assign')}
          </button>
        </div>
      </Modal>
    </div>
  );
}

// ---- Router ----
export default function Reservations() {
  const { propertyId } = useProperty();
  return (
    <Routes key={propertyId}>
      <Route index element={<ReservationList />} />
      <Route path="calendar" element={<AvailabilityCalendar />} />
      <Route path="unassigned" element={<UnassignedQueue />} />
      <Route path=":id" element={<ReservationDetailRoute />} />
    </Routes>
  );
}

function ReservationDetailRoute() {
  const { id } = useParams();
  const { propertyId } = useProperty();
  const navigate = useNavigate();
  return id ? <ReservationWorkspace key={propertyId + id} mode="page" reservationId={id} onClose={() => navigate('/reservations')}/> : null;
}

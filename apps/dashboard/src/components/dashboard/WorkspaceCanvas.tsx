import { Children, isValidElement, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, GripVertical, Settings2, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { CONFIGURABLE_WIDGETS, REPORT_WIDGETS, WIDGET_PERMISSIONS, type DashboardLayout, type WorkspaceWidget } from '../../lib/dashboard-layout';
import { useAuth } from '../../context/AuthContext';
import { useProperty } from '../../context/PropertyContext';
import { QueryError } from '../ui/ErrorBoundary';
import WorkspaceDataWidget from './WorkspaceDataWidget';
import WorkspaceReportWidget from './WorkspaceReportWidget';
export default function WorkspaceCanvas({ children, layout, pageId, onChange, queryStates = {} }: { queryStates?: Partial<Record<string, Array<{ isError: boolean; isPending: boolean; error?: unknown; refetch: () => Promise<unknown> }>>>; children: ReactNode; layout: DashboardLayout; pageId: string; onChange: (next: DashboardLayout) => void }) {
  const { t } = useTranslation(); const { hasPermission } = useAuth(); const { properties } = useProperty();
  const [dragged, setDragged] = useState<string | null>(null); const [editing, setEditing] = useState<string | null>(null);
  const page = layout.pages.find(p => p.id === pageId) ?? layout.pages[0];
  const content = new Map(Children.toArray(children).filter(isValidElement).map(child => [(child.props as Record<string, unknown>)['data-widget'], child]));
  const update = (widgets: WorkspaceWidget[]) => onChange({ ...layout, pages: layout.pages.map(p => p.id === page.id ? { ...p, widgets } : p) });
  const patch = (id: string, values: Partial<WorkspaceWidget>) => update(page.widgets.map(w => w.id === id ? { ...w, ...values } : w));
  const move = (from: string, to: string) => {
    const widgets = [...page.widgets]; const a = widgets.findIndex(w => w.id === from); const b = widgets.findIndex(w => w.id === to);
    if (a < 0 || b < 0 || a === b) return; widgets.splice(b, 0, widgets.splice(a, 1)[0]); update(widgets);
  };
  return <div className="workspace-canvas">{page.widgets.filter(w => hasPermission(...WIDGET_PERMISSIONS[w.type])).map((widget, index) => <section key={widget.id} className="workspace-tile group" style={{ '--tile-width': widget.width, '--tile-height': widget.height } as React.CSSProperties}
    onDragOver={e => { if (dragged) e.preventDefault(); }} onDrop={e => { e.preventDefault(); if (dragged) move(dragged, widget.id); setDragged(null); }}>
    <div className="flex flex-wrap items-center gap-1 border-b border-gray-100 bg-white p-2 text-xs">
      <button draggable onDragStart={e => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', widget.id); setDragged(widget.id); }} onDragEnd={() => setDragged(null)} className="cursor-grab rounded p-1" aria-label={t('workspace.drag', { name: t('workspace.widgets.' + widget.type) })}><GripVertical size={15}/></button>
      <span className="flex-1 font-semibold text-telivity-navy">{t('workspace.widgets.' + widget.type)}</span>
      <button disabled={index === 0} onClick={() => move(widget.id, page.widgets[index - 1].id)} aria-label={t('workspace.moveUp', { name: t('workspace.widgets.' + widget.type) })} className="rounded p-1 disabled:opacity-20"><ArrowLeft size={14}/></button>
      <button disabled={index === page.widgets.length - 1} onClick={() => move(widget.id, page.widgets[index + 1].id)} aria-label={t('workspace.moveDown', { name: t('workspace.widgets.' + widget.type) })} className="rounded p-1 disabled:opacity-20"><ArrowRight size={14}/></button>
      <button onClick={() => setEditing(editing === widget.id ? null : widget.id)} aria-label={t('workspace.widgetSettings')} className="rounded p-1"><Settings2 size={14}/></button>
      <button onClick={() => update(page.widgets.filter(w => w.id !== widget.id))} aria-label={t('workspace.removeWidget')} className="rounded p-1"><Trash2 size={14}/></button>
    </div>
    {editing === widget.id && <div className="grid grid-cols-2 gap-2 border-b bg-gray-50 p-3 text-xs">
      <label>{t('workspace.width')}<input type="range" min={1} max={3} value={widget.width} onChange={e => patch(widget.id, { width: Number(e.target.value) as 1|2|3 })}/></label>
      <label>{t('workspace.height')}<input type="range" min={1} max={3} value={widget.height} onChange={e => patch(widget.id, { height: Number(e.target.value) as 1|2|3 })}/></label>
      {CONFIGURABLE_WIDGETS.includes(widget.type) ? <>
        <label>{t('workspace.property')}<select className="mt-1 w-full rounded border p-1" value={widget.settings.propertyId ?? ''} onChange={e => patch(widget.id, { settings: { ...widget.settings, propertyId: e.target.value || undefined } })}><option value="">{t('workspace.currentProperty')}</option>{properties.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        {!['tasks','maintenance','requests','inhouse'].includes(widget.type) ? <label>{t('workspace.period')}<select className="mt-1 w-full rounded border p-1" value={widget.settings.period} onChange={e => patch(widget.id, { settings: { ...widget.settings, period: e.target.value as WorkspaceWidget['settings']['period'] } })}>{(REPORT_WIDGETS.includes(widget.type) ? widget.type === 'bookingPace' ? ['today','next7','next28','past7','past28'] : ['today','past7','past28'] : ['today','next7','next28']).map(p => <option key={p} value={p}>{t('workspace.periods.' + p)}</option>)}</select></label> : <p>{t('workspace.fixedPeriod')}</p>}
        <label>{t('workspace.density')}<select className="mt-1 w-full rounded border p-1" value={widget.settings.density} onChange={e => patch(widget.id, { settings: { ...widget.settings, density: e.target.value as 'compact'|'comfortable' } })}>{['compact','comfortable'].map(d => <option key={d} value={d}>{t('workspace.' + d)}</option>)}</select></label>
      </> : <p className="col-span-2 text-gray-500">{t('workspace.fixedPeriod')}</p>}
    </div>}
    <div className="min-h-0 flex-1 overflow-auto">{REPORT_WIDGETS.includes(widget.type) ? <WorkspaceReportWidget widget={widget}/> : CONFIGURABLE_WIDGETS.includes(widget.type) ? <WorkspaceDataWidget widget={widget}/> : queryStates[widget.type]?.some(q => q.isError) ? <QueryError error={queryStates[widget.type]?.find(q => q.isError)?.error} onRetry={() => { queryStates[widget.type]?.forEach(q => { void q.refetch(); }); }}/> : queryStates[widget.type]?.some(q => q.isPending) ? <p role="status" className="p-5 text-sm text-gray-500">{t('common.loading')}</p> : content.get(widget.type) ?? <p className="p-5 text-sm text-gray-500">{t('workspace.noData')}</p>}</div>
  </section>)}</div>;
}

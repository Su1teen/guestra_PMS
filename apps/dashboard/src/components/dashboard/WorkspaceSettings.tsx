import { useState } from 'react';
import { SlidersHorizontal, Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import Modal from '../ui/Modal';
import { DASHBOARD_WIDGETS, PRESETS, WIDGET_PERMISSIONS, workspaceTemplate, type DashboardLayout, type WorkspacePreset } from '../../lib/dashboard-layout';
export default function WorkspaceSettings({ layout, pageId, onChange, onSelectPage, hasPermission }: {
  layout: DashboardLayout; pageId: string; onChange: (layout: DashboardLayout) => void; onSelectPage: (id: string) => void;
  hasPermission: (...permissions: string[]) => boolean;
}) {
  const { t } = useTranslation(); const [open, setOpen] = useState(false);
  const page = layout.pages.find(p => p.id === pageId) ?? layout.pages[0];
  const [preset, setPreset] = useState<WorkspacePreset>('frontdesk');
  const update = (patch: Partial<typeof page>) => onChange({ ...layout, pages: layout.pages.map(p => p.id === page.id ? { ...p, ...patch } : p) });
  return <>
    <button onClick={() => setOpen(true)} className="inline-flex items-center gap-2 rounded-lg border bg-white px-3 py-2 text-sm font-semibold"><SlidersHorizontal size={16}/>{t('workspace.customize')}</button>
    <Modal open={open} onClose={() => setOpen(false)} title={t('workspace.customize')}>
      <div className="space-y-5">
        <p className="text-sm text-telivity-mid-grey">{t('workspace.builderHint')}</p>
        <label className="block text-sm font-semibold">{t('workspace.pageName')}<input maxLength={80} value={page.name} onChange={e => update({ name: [...e.target.value].filter(char => char.charCodeAt(0) >= 32 && char !== '<' && char !== '>').join('') })} className="mt-2 w-full rounded-lg border p-2"/></label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={layout.startPageId === page.id} onChange={() => onChange({ ...layout, startPageId: page.id })}/>{t('workspace.startPage')}</label>
        <div className="flex gap-2"><select aria-label={t('workspace.preset')} value={preset} onChange={e => setPreset(e.target.value as WorkspacePreset)} className="flex-1 rounded-lg border p-2">{Object.keys(PRESETS).map(id => <option key={id} value={id}>{t('workspace.presets.' + id)}</option>)}</select>
          <button disabled={layout.pages.length >= 8} className="rounded-lg border p-2 disabled:opacity-40" onClick={() => {
            const next = workspaceTemplate(preset, crypto.randomUUID(), t('workspace.presets.' + preset)).pages[0];
            onChange({ ...layout, pages: [...layout.pages, next] }); onSelectPage(next.id);
          }}><Plus size={16}/>{t('workspace.addPage')}</button></div>
        <button className="rounded-lg border p-2 text-sm" onClick={() => update({ preset, widgets: workspaceTemplate(preset).pages[0].widgets })}>{t('workspace.restore')}</button>
        <div className="grid grid-cols-2 gap-2">{DASHBOARD_WIDGETS.filter(id => hasPermission(...WIDGET_PERMISSIONS[id])).map(type => {
          const exists = page.widgets.some(w => w.type === type);
          return <label key={type} className="flex items-center gap-2 rounded-lg border p-3 text-sm"><input type="checkbox" checked={exists} onChange={e => update({ widgets: e.target.checked ? [...page.widgets, { id: crypto.randomUUID(), type, width: 1, height: 1, settings: { period: 'today', density: 'comfortable' } }] : page.widgets.filter(w => w.type !== type) })}/>{t('workspace.widgets.' + type)}</label>;
        })}</div>
        <button disabled={layout.pages.length < 2} className="flex items-center gap-2 rounded-lg border border-red-200 p-2 text-sm text-red-700 disabled:opacity-30" onClick={() => {
          const pages = layout.pages.filter(p => p.id !== page.id);
          onChange({ ...layout, pages, startPageId: layout.startPageId === page.id ? pages[0].id : layout.startPageId }); onSelectPage(pages[0].id);
        }}><Trash2 size={16}/>{t('workspace.deletePage')}</button>
      </div>
    </Modal>
  </>;
}

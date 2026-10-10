export const WORKSPACE_WIDGETS = ['operations', 'rooms', 'metrics', 'drr', 'revenue', 'activity', 'arrivals', 'departures', 'inhouse', 'unassigned', 'availability', 'tasks', 'maintenance', 'requests', 'occupancy', 'adr', 'revpar', 'pickup', 'bookingPace'] as const;
export type WorkspaceWidgetType = typeof WORKSPACE_WIDGETS[number];
export const WORKSPACE_PRESETS = ['frontdesk', 'reservations', 'operations', 'revenue', 'management'] as const;
export type WorkspacePreset = typeof WORKSPACE_PRESETS[number];
export interface WorkspaceWidget { id: string; type: WorkspaceWidgetType; width: 1 | 2 | 3; height: 1 | 2 | 3;
  settings: { propertyId?: string; period: 'today' | 'next7' | 'next28' | 'past7' | 'past28'; density: 'comfortable' | 'compact' } }
export interface WorkspacePage { id: string; name: string; preset: WorkspacePreset; widgets: WorkspaceWidget[] }
export interface WorkspaceLayout { version: 2; startPageId: string; pages: WorkspacePage[] }
export const WORKSPACE_TEMPLATE_WIDGETS: Record<WorkspacePreset, WorkspaceWidgetType[]> = {
  frontdesk: ['arrivals', 'departures', 'inhouse', 'rooms', 'operations', 'tasks'],
  reservations: ['arrivals', 'availability', 'unassigned', 'operations', 'activity'],
  operations: ['rooms', 'maintenance', 'tasks', 'requests', 'arrivals', 'operations'],
  revenue: ['occupancy', 'adr', 'revpar', 'pickup', 'bookingPace', 'revenue', 'availability', 'activity'],
  management: ['occupancy', 'adr', 'revpar', 'operations', 'rooms', 'pickup', 'bookingPace', 'activity'],
};
const plain = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const only = (v: Record<string, any>, keys: string[]) => Object.keys(v).every(k => keys.includes(k));
const identifier = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(v);
/** Strict bounded allowlist: UI preferences never contain guest data, URLs or queries. */
export function isWorkspaceLayout(v: unknown): v is WorkspaceLayout {
  if (!plain(v) || !only(v, ['version', 'startPageId', 'pages']) || v['version'] !== 2 || !identifier(v['startPageId']) || !Array.isArray(v['pages']) || v['pages'].length < 1 || v['pages'].length > 8) return false;
  const ids = new Set<string>();
  for (const page of v['pages']) {
    if (!plain(page) || !only(page, ['id', 'name', 'preset', 'widgets']) || !identifier(page['id']) || ids.has(page['id']) || typeof page['name'] !== 'string' || !page['name'].trim() || page['name'].length > 80 || (/[<>]/.test(page['name']) || [...page['name']].some(char => char.charCodeAt(0) < 32)) || !WORKSPACE_PRESETS.includes(page['preset']) || !Array.isArray(page['widgets']) || page['widgets'].length > 24) return false;
    ids.add(page['id']);
    const types = new Set(); const widgetIds = new Set();
    for (const widget of page['widgets']) {
      if (!plain(widget) || !only(widget, ['id', 'type', 'width', 'height', 'settings']) || !identifier(widget['id']) || widgetIds.has(widget['id']) || !WORKSPACE_WIDGETS.includes(widget['type']) || types.has(widget['type']) || ![1,2,3].includes(widget['width']) || ![1,2,3].includes(widget['height'])) return false;
      widgetIds.add(widget['id']); types.add(widget['type']);
      const s = widget['settings'];
      if (!plain(s) || !only(s, ['propertyId', 'period', 'density']) || !['today', 'next7', 'next28', 'past7', 'past28'].includes(s['period']) || !['comfortable', 'compact'].includes(s['density']) || (s['propertyId'] !== undefined && (typeof s['propertyId'] !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s['propertyId'])))) return false;
    }
  }
  return ids.has(v['startPageId']);
}
export function workspaceTemplate(preset: WorkspacePreset = 'management', id = 'home', name = 'Рабочий стол'): WorkspaceLayout {
  return { version: 2, startPageId: id, pages: [{ id, name, preset, widgets: WORKSPACE_TEMPLATE_WIDGETS[preset].map(type => ({ id: type, type, width: ['metrics','drr','operations','rooms'].includes(type) ? 3 : 1, height: 1, settings: { period: 'today', density: 'comfortable' } })) }] };
}

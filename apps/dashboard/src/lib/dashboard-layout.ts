import { isWorkspaceLayout, validWorkspaceGrid, normalizeWorkspace, widgetDefaultGrid, packWorkspace, workspaceTemplate, WORKSPACE_WIDGETS, WORKSPACE_TEMPLATE_WIDGETS, type WorkspaceLayout, type WorkspaceWidgetType } from '@telivityhaip/shared';
export type { WorkspacePreset, WorkspaceWidget, WorkspacePage } from '@telivityhaip/shared';
export type DashboardLayout = WorkspaceLayout;
export type DashboardWidget = WorkspaceWidgetType;
export const DASHBOARD_WIDGETS = WORKSPACE_WIDGETS;
export const PRESETS = WORKSPACE_TEMPLATE_WIDGETS;
export { workspaceTemplate };
export const WIDGET_PERMISSIONS: Record<DashboardWidget, string[]> = {
  operations: ['ops.read'], rooms: ['rooms.read', 'reservations.read'], metrics: ['reports.view'],
  drr: ['management_dashboard.view'], revenue: ['revenue.manage'], activity: ['dashboard.view'],
  arrivals: ['ops.read', 'reservations.read'], departures: ['reservations.read'], inhouse: ['reservations.read'],
  unassigned: ['reservations.read'], availability: ['reservations.read', 'rooms.read'],
  tasks: ['ops.read'], maintenance: ['ops.read', 'maintenance.view'], requests: ['ops.read'],
  occupancy: ['reports.view'], adr: ['reports.view'], revpar: ['reports.view'], pickup: ['reports.view'], bookingPace: ['reports.view'],
  earnedRevenue: ['reports.view'], financialSummary: ['reports.view'], housekeeping: ['housekeeping.read'], services: ['services.read'],
};
export const REPORT_WIDGETS: DashboardWidget[] = ['occupancy', 'adr', 'revpar', 'pickup', 'bookingPace','earnedRevenue','financialSummary'];
export const CONFIGURABLE_WIDGETS: DashboardWidget[] = ['arrivals', 'departures', 'inhouse', 'unassigned', 'availability', 'tasks', 'maintenance', 'requests','housekeeping','services', ...REPORT_WIDGETS];
export function layoutKey(userId: string, propertyId: string) { return 'guestra.dashboard.v1:' + encodeURIComponent(userId) + ':' + encodeURIComponent(propertyId); }
export function parseLayout(raw: string | null): DashboardLayout {
  try {
    const value = JSON.parse(raw ?? 'null');
    if (isWorkspaceLayout(value)) return normalizeWorkspace(value);
    // Repair only coordinates, never allow arbitrary settings/fields through the wire validator.
    // The original server preference is unchanged until an explicit save.
    if (value?.version === 3 && Array.isArray(value.pages) && value.pages.length <= 8 && value.pages.every((p: any)=>Array.isArray(p.widgets)&&p.widgets.length<=24)) {
      const repaired={...value,pages:value.pages.map((p:any)=>({...p,widgets:packWorkspace(p.widgets.map((w:any)=>({...w,grid:validWorkspaceGrid(w.grid)?w.grid:widgetDefaultGrid(w.type)})))}))};
      if (isWorkspaceLayout(repaired)) return repaired;
    }
    if (value?.version === 1 && Object.prototype.hasOwnProperty.call(PRESETS, value.preset) && Array.isArray(value.widgets)) {
      const next = workspaceTemplate(value.preset);
      next.pages[0].widgets = packWorkspace([...new Set<DashboardWidget>(value.widgets.filter((id: unknown) => DASHBOARD_WIDGETS.includes(id as DashboardWidget)))].map(type => ({ id: type, type, grid:widgetDefaultGrid(type), settings: { period: 'today', density: 'comfortable' } })));
      return next;
    }
  } catch { /* Corrupt caches fall back to the bounded default, never execute. */ }
  return workspaceTemplate();
}
export function visibleWidgets(layout: DashboardLayout, hasPermission: (...permissions: string[]) => boolean, pageId = layout.startPageId) {
  return (layout.pages.find(p => p.id === pageId) ?? layout.pages[0]).widgets.filter(w => hasPermission(...WIDGET_PERMISSIONS[w.type])).map(w => w.type);
}

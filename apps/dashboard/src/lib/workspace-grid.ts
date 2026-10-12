import {
  packWorkspace,
  widgetDefaultGrid,
  type WorkspaceWidget,
  type WorkspaceGrid,
} from "@telivityhaip/shared";
/** Projection never mutates saved coordinates on container resize. */
export function projectWorkspace(
  widgets: WorkspaceWidget[],
  columns: number,
): WorkspaceWidget[] {
  return packWorkspace(
    widgets.map((w) => {
      const g = w.grid ?? widgetDefaultGrid(w.type);
      return {
        ...w,
        grid: {
          ...g,
          x: Math.floor((g.x * columns) / 12),
          w: Math.max(2, Math.round((g.w * columns) / 12)),
        },
      };
    }),
    columns,
  );
}
export function commitGridChange(
  widgets: WorkspaceWidget[],
  id: string,
  grid: WorkspaceGrid,
  columns: number,
): WorkspaceWidget[] {
  const w = Math.max(2, Math.min(12, Math.round((grid.w * 12) / columns)));
  const canonical = {
    ...grid,
    w,
    x: Math.max(0, Math.min(12 - w, Math.round((grid.x * 12) / columns))),
  };
  return packWorkspace(
    widgets.map((widget) =>
      widget.id === id ? { ...widget, grid: canonical } : widget,
    ),
    12,
    id,
  );
}

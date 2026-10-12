export const WORKSPACE_WIDGETS = [
  "operations",
  "rooms",
  "metrics",
  "drr",
  "revenue",
  "activity",
  "arrivals",
  "departures",
  "inhouse",
  "unassigned",
  "availability",
  "tasks",
  "maintenance",
  "requests",
  "occupancy",
  "adr",
  "revpar",
  "pickup",
  "bookingPace",
  "earnedRevenue",
  "financialSummary",
  "housekeeping",
  "services",
] as const;
export type WorkspaceWidgetType = (typeof WORKSPACE_WIDGETS)[number];
export const WORKSPACE_PRESETS = [
  "frontdesk",
  "reservations",
  "operations",
  "revenue",
  "management",
] as const;
export type WorkspacePreset = (typeof WORKSPACE_PRESETS)[number];
export interface WorkspaceWidget {
  id: string;
  type: WorkspaceWidgetType;
  width?: 1 | 2 | 3;
  height?: 1 | 2 | 3;
  grid?: WorkspaceGrid;
  settings: {
    propertyId?: string;
    period: "today" | "next7" | "next28" | "past7" | "past28";
    density: "comfortable" | "compact";
  };
}
export interface WorkspacePage {
  id: string;
  name: string;
  preset: WorkspacePreset;
  widgets: WorkspaceWidget[];
}
export interface WorkspaceGrid {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface WorkspaceLayout {
  version: 2 | 3;
  startPageId: string;
  pages: WorkspacePage[];
}
export const WORKSPACE_TEMPLATE_WIDGETS: Record<
  WorkspacePreset,
  WorkspaceWidgetType[]
> = {
  frontdesk: [
    "arrivals",
    "departures",
    "inhouse",
    "rooms",
    "operations",
    "tasks",
  ],
  reservations: [
    "arrivals",
    "availability",
    "unassigned",
    "operations",
    "activity",
  ],
  operations: [
    "housekeeping",
    "maintenance",
    "tasks",
    "requests",
    "services",
    "arrivals",
    "operations",
  ],
  revenue: [
    "occupancy",
    "adr",
    "revpar",
    "earnedRevenue",
    "pickup",
    "bookingPace",
    "revenue",
    "availability",
    "activity",
  ],
  management: [
    "occupancy",
    "adr",
    "revpar",
    "earnedRevenue",
    "financialSummary",
    "drr",
    "operations",
    "rooms",
    "pickup",
    "bookingPace",
    "activity",
  ],
};
const plain = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const only = (v: Record<string, any>, keys: string[]) =>
  Object.keys(v).every((k) => keys.includes(k));
const identifier = (v: unknown): v is string =>
  typeof v === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(v);
/** Strict bounded allowlist: UI preferences never contain guest data, URLs or queries. */
export function isWorkspaceLayout(v: unknown): v is WorkspaceLayout {
  if (
    !plain(v) ||
    !only(v, ["version", "startPageId", "pages"]) ||
    ![2, 3].includes(v["version"]) ||
    !identifier(v["startPageId"]) ||
    !Array.isArray(v["pages"]) ||
    v["pages"].length < 1 ||
    v["pages"].length > 8
  )
    return false;
  const ids = new Set<string>();
  for (const page of v["pages"]) {
    if (
      !plain(page) ||
      !only(page, ["id", "name", "preset", "widgets"]) ||
      !identifier(page["id"]) ||
      ids.has(page["id"]) ||
      typeof page["name"] !== "string" ||
      !page["name"].trim() ||
      page["name"].length > 80 ||
      /[<>]/.test(page["name"]) ||
      [...page["name"]].some((char) => char.charCodeAt(0) < 32) ||
      !WORKSPACE_PRESETS.includes(page["preset"]) ||
      !Array.isArray(page["widgets"]) ||
      page["widgets"].length > 24
    )
      return false;
    ids.add(page["id"]);
    const types = new Set();
    const widgetIds = new Set();
    for (const widget of page["widgets"]) {
      if (
        !plain(widget) ||
        !only(
          widget,
          v["version"] === 2
            ? ["id", "type", "width", "height", "settings"]
            : ["id", "type", "grid", "settings"],
        ) ||
        !identifier(widget["id"]) ||
        widgetIds.has(widget["id"]) ||
        !WORKSPACE_WIDGETS.includes(widget["type"]) ||
        types.has(widget["type"]) ||
        (v["version"] === 2
          ? ![1, 2, 3].includes(widget["width"]) ||
            ![1, 2, 3].includes(widget["height"])
          : !validWorkspaceGrid(widget["grid"]))
      )
        return false;
      widgetIds.add(widget["id"]);
      types.add(widget["type"]);
      const s = widget["settings"];
      if (
        !plain(s) ||
        !only(s, ["propertyId", "period", "density"]) ||
        !["today", "next7", "next28", "past7", "past28"].includes(
          s["period"],
        ) ||
        !["comfortable", "compact"].includes(s["density"]) ||
        (s["propertyId"] !== undefined &&
          (typeof s["propertyId"] !== "string" ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
              s["propertyId"],
            )))
      )
        return false;
    }
    if (
      v["version"] === 3 &&
      page["widgets"].some((w: WorkspaceWidget, i: number) =>
        page["widgets"]
          .slice(i + 1)
          .some((other: WorkspaceWidget) => gridsOverlap(w.grid!, other.grid!)),
      )
    )
      return false;
  }
  return ids.has(v["startPageId"]);
}
export function validWorkspaceGrid(g: unknown): g is WorkspaceGrid {
  if (!plain(g) || !only(g, ["x", "y", "w", "h"])) return false;
  return (
    ["x", "y", "w", "h"].every((k) => Number.isInteger(g[k])) &&
    g["x"] >= 0 &&
    g["y"] >= 0 &&
    g["y"] <= 1024 &&
    g["w"] >= 2 &&
    g["w"] <= 12 &&
    g["x"] + g["w"] <= 12 &&
    g["h"] >= 3 &&
    g["h"] <= 16
  );
}
export function gridsOverlap(a: WorkspaceGrid, b: WorkspaceGrid) {
  return (
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
  );
}
export function widgetDefaultGrid(type: WorkspaceWidgetType): WorkspaceGrid {
  return ["occupancy", "adr", "revpar", "pickup", "earnedRevenue"].includes(
    type,
  )
    ? { x: 0, y: 0, w: 3, h: 3 }
    : ["metrics", "operations", "drr", "financialSummary"].includes(type)
      ? { x: 0, y: 0, w: 12, h: 6 }
      : { x: 0, y: 0, w: 6, h: 6 };
}
/** Stable bounded placement. The moved card keeps its requested cell; collisions push other cards down. */
export function packWorkspace(
  widgets: WorkspaceWidget[],
  columns = 12,
  priorityId?: string,
): WorkspaceWidget[] {
  const placed: WorkspaceWidget[] = [];
  const ordered = priorityId
    ? [
        ...widgets.filter((w) => w.id === priorityId),
        ...widgets.filter((w) => w.id !== priorityId),
      ]
    : widgets;
  for (const widget of ordered) {
    const original = widget.grid ?? widgetDefaultGrid(widget.type);
    const g = {
      ...original,
      w: Math.max(Math.min(2, columns), Math.min(columns, original.w)),
      h: Math.max(3, Math.min(16, original.h)),
    };
    g.x = Math.max(0, Math.min(columns - g.w, g.x));
    g.y = Math.max(0, Math.min(1024, g.y));
    if (!widget.grid) {
      g.y = 0;
      g.x = 0;
      while (placed.some((w) => gridsOverlap(g, w.grid!))) {
        g.x++;
        if (g.x + g.w > columns) {
          g.x = 0;
          g.y++;
        }
      }
    }
    while (placed.some((w) => gridsOverlap(g, w.grid!))) {
      g.y++;
      // A move at the last permitted row must not produce an unsavable layout.
      // The bounded (24-card) canvas has ample free space from the top.
      if (g.y > 1024) {
        g.y = 0;
        g.x = 0;
        while (placed.some((w) => gridsOverlap(g, w.grid!))) {
          g.x++;
          if (g.x + g.w > columns) { g.x = 0; g.y++; }
        }
      }
    }
    placed.push({ ...widget, grid: g });
  }
  return widgets.map((w) => placed.find((p) => p.id === w.id)!);
}
/** Read-only conversion. Existing page IDs, ordering, settings and start page are preserved. */
export function normalizeWorkspace(layout: WorkspaceLayout): WorkspaceLayout {
  if (layout.version === 3) return layout;
  return {
    ...layout,
    version: 3,
    pages: layout.pages.map((page) => {
      let cursorX = 0,
        cursorY = 0,
        rowHeight = 0;
      const widgets = page.widgets.map(({ width, height, ...widget }) => {
        const w = (width ?? 1) * 4,
          h = Math.min(16, (height ?? 1) * widgetDefaultGrid(widget.type).h);
        if (cursorX + w > 12) {
          cursorY += rowHeight;
          cursorX = 0;
          rowHeight = 0;
        }
        const grid = { x: cursorX, y: cursorY, w, h };
        cursorX += w;
        rowHeight = Math.max(rowHeight, h);
        return { ...widget, grid };
      });
      return { ...page, widgets: packWorkspace(widgets) };
    }),
  };
}
export function workspaceTemplate(
  preset: WorkspacePreset = "management",
  id = "home",
  name = "Рабочий стол",
): WorkspaceLayout {
  return {
    version: 3,
    startPageId: id,
    pages: [
      {
        id,
        name,
        preset,
        widgets: packWorkspace(
          WORKSPACE_TEMPLATE_WIDGETS[preset].map((type) => ({
            id: type,
            type,
            settings: { period: "today", density: "comfortable" },
          })),
        ),
      },
    ],
  };
}

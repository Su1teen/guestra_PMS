import { describe, it, expect } from "vitest";
import {
  workspaceTemplate,
  isWorkspaceLayout,
  normalizeWorkspace,
  gridsOverlap,
  packWorkspace,
} from "@telivityhaip/shared";
import { projectWorkspace, commitGridChange } from "./workspace-grid";
import { parseLayout } from "./dashboard-layout";
describe("Workspace coordinate grid", () => {
  it("migrates saved v2 pages without losing ids, settings, order or start page; conversion is idempotent", () => {
    const legacy = {
      version: 2 as const,
      startPageId: "desk",
      pages: [
        {
          id: "desk",
          name: "Мой стол",
          preset: "frontdesk" as const,
          widgets: [
            {
              id: "a",
              type: "arrivals" as const,
              width: 2 as const,
              height: 2 as const,
              settings: {
                period: "next7" as const,
                density: "compact" as const,
              },
            },
            {
              id: "b",
              type: "rooms" as const,
              width: 1 as const,
              height: 1 as const,
              settings: {
                period: "today" as const,
                density: "comfortable" as const,
              },
            },
          ],
        },
      ],
    };
    expect(isWorkspaceLayout(legacy)).toBe(true);
    const converted = normalizeWorkspace(legacy);
    expect(converted.version).toBe(3);
    expect(converted.pages[0].widgets[0]).toMatchObject({
      id: "a",
      grid: { x: 0, y: 0, w: 8, h: 12 },
      settings: legacy.pages[0].widgets[0].settings,
    });
    expect(converted.startPageId).toBe("desk");
    expect(normalizeWorkspace(converted)).toEqual(converted);
    expect(parseLayout(JSON.stringify(legacy))).toEqual(converted);
    expect(legacy.version).toBe(2);
  });
  it("avoids every collision after movement, resizing and container projection without mutating persistence", () => {
    const layout = workspaceTemplate("revenue");
    const original = JSON.stringify(layout);
    for (const columns of [4, 8, 12]) {
      const projected = projectWorkspace(layout.pages[0].widgets, columns);
      for (const [i, a] of projected.entries()) {
        expect(a.grid!.x + a.grid!.w).toBeLessThanOrEqual(columns);
        for (const b of projected.slice(i + 1))
          expect(gridsOverlap(a.grid!, b.grid!)).toBe(false);
      }
    }
    expect(JSON.stringify(layout)).toBe(original);
    const moved = commitGridChange(
      layout.pages[0].widgets,
      layout.pages[0].widgets[0].id,
      { x: 0, y: 1, w: 8, h: 8 },
      8,
    );
    expect(
      isWorkspaceLayout({
        ...layout,
        pages: [{ ...layout.pages[0], widgets: moved }],
      }),
    ).toBe(true);
  });
  it("auto-places new cards in a free cell and validates max sizes", () => {
    const widgets = packWorkspace([
      {
        id: "a",
        type: "adr",
        settings: { period: "today", density: "compact" },
      },
      {
        id: "b",
        type: "revpar",
        settings: { period: "today", density: "compact" },
      },
    ]);
    expect(widgets.map((w) => w.grid?.x)).toEqual([0, 3]);
    const edge = packWorkspace(widgets.map(w => ({...w, grid:{x:0,y:1024,w:12,h:16}})),12,'a');
    expect(edge.every(w => w.grid!.y <= 1024)).toBe(true);
    expect(gridsOverlap(edge[0].grid!,edge[1].grid!)).toBe(false);
    const layout = workspaceTemplate();
    layout.pages[0].widgets[0].grid!.w = 13;
    expect(isWorkspaceLayout(layout)).toBe(false);
  });
  it("recovers corrupt coordinates while preserving safe pages and widget settings", () => {
    const layout = workspaceTemplate("frontdesk");
    layout.pages[0].name = "Мой ресепшен";
    layout.pages[0].widgets[0].grid!.w = 999;
    const recovered = parseLayout(JSON.stringify(layout));
    expect(recovered.pages[0].name).toBe("Мой ресепшен");
    expect(recovered.pages[0].widgets.map((w) => w.id)).toEqual(
      layout.pages[0].widgets.map((w) => w.id),
    );
    expect(isWorkspaceLayout(recovered)).toBe(true);
  });
});

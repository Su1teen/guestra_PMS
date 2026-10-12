import {
  Children,
  isValidElement,
  useState,
  useEffect,
  useRef,
  type ReactNode,
  type PointerEvent,
} from "react";
import { GripVertical, Settings2, Trash2, Expand } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  packWorkspace,
  widgetDefaultGrid,
  type WorkspaceGrid,
} from "@telivityhaip/shared";
import {
  CONFIGURABLE_WIDGETS,
  REPORT_WIDGETS,
  WIDGET_PERMISSIONS,
  type DashboardLayout,
  type WorkspaceWidget,
} from "../../lib/dashboard-layout";
import { useAuth } from "../../context/AuthContext";
import { useProperty } from "../../context/PropertyContext";
import { QueryError } from "../ui/ErrorBoundary";
import Modal from "../ui/Modal";
import WorkspaceDataWidget from "./WorkspaceDataWidget";
import WorkspaceReportWidget from "./WorkspaceReportWidget";
import { projectWorkspace, commitGridChange } from "../../lib/workspace-grid";

export default function WorkspaceCanvas({
  children,
  layout,
  pageId,
  onChange,
  customizing = false,
  queryStates = {},
}: {
  queryStates?: Partial<
    Record<
      string,
      Array<{
        isError: boolean;
        isPending: boolean;
        error?: unknown;
        refetch: () => Promise<unknown>;
      }>
    >
  >;
  children: ReactNode;
  layout: DashboardLayout;
  pageId: string;
  onChange: (next: DashboardLayout) => void;
  customizing?: boolean;
}) {
  const { t } = useTranslation(),
    { hasPermission } = useAuth(),
    { properties } = useProperty();
  const container = useRef<HTMLDivElement>(null),
    [width, setWidth] = useState(1200),
    [editing, setEditing] = useState<string | null>(null),
    [preview, setPreview] = useState<WorkspaceWidget[] | null>(null),
    [announcement, setAnnouncement] = useState("");
  const gesture = useRef<{
    id: string;
    mode: "move" | "resize";
    pointer: number;
    sx: number;
    sy: number;
    grid: WorkspaceGrid;
    current: WorkspaceGrid;
  } | null>(null);
  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const measure = () => setWidth(el.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setPreview(null);
    gesture.current = null;
    setEditing(null);
  }, [pageId, customizing]);
  const page = layout.pages.find((p) => p.id === pageId) ?? layout.pages[0],
    columns = width >= 1000 ? 12 : width >= 640 ? 8 : 4;
  const projected = projectWorkspace(
      page.widgets.filter((w) => hasPermission(...WIDGET_PERMISSIONS[w.type])),
      columns,
    ),
    rendered = preview ?? projected;
  const content = new Map(
    Children.toArray(children)
      .filter(isValidElement)
      .map((c) => [(c.props as Record<string, unknown>)["data-widget"], c]),
  );
  const update = (widgets: WorkspaceWidget[]) =>
    onChange({
      ...layout,
      version: 3,
      pages: layout.pages.map((p) =>
        p.id === page.id ? { ...p, widgets } : p,
      ),
    });
  const patch = (id: string, values: Partial<WorkspaceWidget>) =>
    update(
      packWorkspace(
        page.widgets.map((w) => (w.id === id ? { ...w, ...values } : w)),
        12,
        id,
      ),
    );
  const commit = (id: string, grid: WorkspaceGrid) => {
    update(commitGridChange(page.widgets, id, grid, columns));
    setAnnouncement("Положение и размер изменены. Сохраните рабочий стол.");
  };
  const start = (
    e: PointerEvent<HTMLButtonElement>,
    id: string,
    mode: "move" | "resize",
    grid: WorkspaceGrid,
  ) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    gesture.current = {
      id,
      mode,
      pointer: e.pointerId,
      sx: e.clientX,
      sy: e.clientY,
      grid,
      current: grid,
    };
  };
  const change = (e: PointerEvent<HTMLButtonElement>) => {
    const g = gesture.current;
    if (!g || g.pointer !== e.pointerId) return;
    const dx = Math.round((e.clientX - g.sx) / ((width + 12) / columns)),
      dy = Math.round((e.clientY - g.sy) / 52);
    g.current =
      g.mode === "move"
        ? {
            ...g.grid,
            x: Math.max(0, Math.min(columns - g.grid.w, g.grid.x + dx)),
            y: Math.max(0, Math.min(1024, g.grid.y + dy)),
          }
        : {
            ...g.grid,
            w: Math.max(2, Math.min(columns - g.grid.x, g.grid.w + dx)),
            h: Math.max(3, Math.min(16, g.grid.h + dy)),
          };
    setPreview(
      packWorkspace(
        projected.map((w) => (w.id === g.id ? { ...w, grid: g.current } : w)),
        columns,
        g.id,
      ),
    );
  };
  const finish = (e: PointerEvent<HTMLButtonElement>, cancel = false) => {
    const g = gesture.current;
    if (!g) return;
    gesture.current = null;
    setPreview(null);
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
    if (!cancel && JSON.stringify(g.current) !== JSON.stringify(g.grid))
      commit(g.id, g.current);
  };
  const keyboard = (
    event: React.KeyboardEvent,
    id: string,
    grid: WorkspaceGrid,
    resize = false,
  ) => {
    if (event.key === "Escape") {
      gesture.current = null;
      setPreview(null);
      return;
    }
    if (
      !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
    )
      return;
    event.preventDefault();
    const dx =
        event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0,
      dy = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    commit(
      id,
      resize || event.shiftKey
        ? {
            ...grid,
            w: Math.max(2, Math.min(columns - grid.x, grid.w + dx)),
            h: Math.max(3, Math.min(16, grid.h + dy)),
          }
        : {
            ...grid,
            x: Math.max(0, Math.min(columns - grid.w, grid.x + dx)),
            y: Math.max(0, Math.min(1024, grid.y + dy)),
          },
    );
  };
  const selected = page.widgets.find((w) => w.id === editing);
  return (
    <>
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
      {customizing && (
        <p className="mb-3 text-xs text-gray-500">
          Перетащите карточку за ручку; размер — в нижнем углу. Стрелки на ручке
          — перемещение, Shift + стрелки — размер. Esc отменяет перетаскивание.
        </p>
      )}
      <div
        ref={container}
        className={`workspace-canvas ${customizing ? "workspace-customizing" : ""}`}
        style={{ gridTemplateColumns: `repeat(${columns},minmax(0,1fr))` }}
      >
        {rendered.map((widget) => {
          const g = widget.grid ?? widgetDefaultGrid(widget.type),
            name = t("workspace.widgets." + widget.type);
          return (
            <section
              data-workspace-id={widget.id}
              data-grid={JSON.stringify(g)}
              key={widget.id}
              className="workspace-tile"
              style={{
                gridColumn: `${g.x + 1} / span ${g.w}`,
                gridRow: `${g.y + 1} / span ${g.h}`,
              }}
            >
              <div className="workspace-tile-heading">
                {customizing && (
                  <button
                    className="workspace-grip"
                    aria-label={t("workspace.drag", { name })}
                    onPointerDown={(e) => start(e, widget.id, "move", g)}
                    onPointerMove={change}
                    onPointerUp={(e) => finish(e)}
                    onPointerCancel={(e) => finish(e, true)}
                    onKeyDown={(e) => keyboard(e, widget.id, g)}
                  >
                    <GripVertical size={16} />
                  </button>
                )}
                <h2 title={name}>{name}</h2>
                {customizing && (
                  <>
                    <button
                      aria-label={`Настройки: ${name}`}
                      onClick={() => setEditing(widget.id)}
                    >
                      <Settings2 size={16} />
                    </button>
                    <button
                      aria-label={`Удалить: ${name}`}
                      onClick={() =>
                        update(page.widgets.filter((w) => w.id !== widget.id))
                      }
                    >
                      <Trash2 size={16} />
                    </button>
                  </>
                )}
              </div>
              <div className="workspace-tile-content">
                {REPORT_WIDGETS.includes(widget.type) ? (
                  <WorkspaceReportWidget widget={widget} />
                ) : CONFIGURABLE_WIDGETS.includes(widget.type) ? (
                  <WorkspaceDataWidget widget={widget} />
                ) : queryStates[widget.type]?.some((q) => q.isError) ? (
                  <QueryError
                    error={
                      queryStates[widget.type]?.find((q) => q.isError)?.error
                    }
                    onRetry={() => {
                      queryStates[widget.type]?.forEach(
                        (q) => void q.refetch(),
                      );
                    }}
                  />
                ) : queryStates[widget.type]?.some((q) => q.isPending) ? (
                  <p role="status" className="p-5 text-sm text-gray-500">
                    {t("common.loading")}
                  </p>
                ) : (
                  (content.get(widget.type) ?? (
                    <p className="p-5 text-sm text-gray-500">
                      {t("workspace.noData")}
                    </p>
                  ))
                )}
              </div>
              {customizing && (
                <button
                  className="workspace-resize"
                  aria-label={`Изменить размер: ${name}`}
                  onPointerDown={(e) => start(e, widget.id, "resize", g)}
                  onPointerMove={change}
                  onPointerUp={(e) => finish(e)}
                  onPointerCancel={(e) => finish(e, true)}
                  onKeyDown={(e) => keyboard(e, widget.id, g, true)}
                >
                  <Expand size={14} />
                </button>
              )}
            </section>
          );
        })}
      </div>
      <Modal
        side
        open={!!selected && customizing}
        onClose={() => setEditing(null)}
        title={
          selected
            ? `Настройки · ${t("workspace.widgets." + selected.type)}`
            : "Настройки карточки"
        }
      >
        {selected && (
          <div className="space-y-4">
            <p className="text-xs text-gray-500">
              Размер: {selected.grid?.w} × {selected.grid?.h}. Изменяйте его на
              рабочем столе.
            </p>
            {CONFIGURABLE_WIDGETS.includes(selected.type) ? (
              <>
                <label className="block">
                  Объект
                  <select
                    className="block w-full rounded border p-2"
                    value={selected.settings.propertyId ?? ""}
                    aria-label="Объект карточки"
                    onChange={(e) =>
                      patch(selected.id, {
                        settings: {
                          ...selected.settings,
                          propertyId: e.target.value || undefined,
                        },
                      })
                    }
                  >
                    <option value="">Текущий объект</option>
                    {properties.map((p) => (
                      <option value={p.id} key={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  Период
                  <select
                    disabled={["financialSummary", "tasks", "maintenance", "requests", "inhouse", "housekeeping"].includes(selected.type)}
                    className="block w-full rounded border p-2"
                    value={selected.settings.period}
                    aria-label="Период карточки"
                    onChange={(e) =>
                      patch(selected.id, {
                        settings: {
                          ...selected.settings,
                          period: e.target
                            .value as WorkspaceWidget["settings"]["period"],
                        },
                      })
                    }
                  >
                    {(REPORT_WIDGETS.includes(selected.type)
                      ? selected.type === "bookingPace"
                        ? ["today", "next7", "next28", "past7", "past28"]
                        : ["today", "past7", "past28"]
                      : ["today", "next7", "next28"]
                    ).map((p) => (
                      <option value={p} key={p}>
                        {t("workspace.periods." + p)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  Отображение
                  <select
                    className="block w-full rounded border p-2"
                    value={selected.settings.density}
                    aria-label="Отображение карточки"
                    onChange={(e) =>
                      patch(selected.id, {
                        settings: {
                          ...selected.settings,
                          density: e.target.value as "compact" | "comfortable",
                        },
                      })
                    }
                  >
                    {["compact", "comfortable"].map((d) => (
                      <option key={d} value={d}>
                        {t("workspace." + d)}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            ) : (
              <p>Карточка показывает операционные данные текущего объекта.</p>
            )}
          </div>
        )}
      </Modal>
    </>
  );
}

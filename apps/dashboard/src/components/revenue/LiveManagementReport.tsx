import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  ChevronDown,
  ChevronRight,
  Download,
  Plus,
  Trash2,
} from "lucide-react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
} from "recharts";
import {
  MANAGEMENT_REVENUE_ARTICLES,
  MANAGEMENT_EXPENSE_ARTICLES,
  MANAGEMENT_LABELS,
  type ManagementReportData,
  type ManagementRow,
  type ManagementMetrics,
  type ManagementEntry,
} from "@telivityhaip/shared";
import { useProperty } from "../../context/PropertyContext";
import { useAuth } from "../../context/AuthContext";
import { useOperationalDate } from "../../hooks/useOperationalDate";
import { api } from "../../lib/api";
import { formatMoney } from "../../lib/money";
import { errorMessage } from "../../lib/error-message";
import {
  currencyTotals,
  MANAGEMENT_STATUS_LABELS,
} from "../../lib/management-live";
import { QueryError } from "../ui/ErrorBoundary";
import Modal from "../ui/Modal";

const percent = (v: number | null) =>
  v === null
    ? "—"
    : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(v) +
      "%";
const money = (v: number | null, c: string) =>
  v === null ? "—" : formatMoney(v, c);
const unpack = <T,>(response: { data: { data?: T } | T }): T =>
  ((response.data as { data?: T }).data ?? response.data) as T;

export function LiveHierarchy({
  reports,
  kind,
  onDrill,
}: {
  reports: ManagementReportData[];
  kind: "revenue" | "expenses";
  onDrill: (r: ManagementRow) => void;
}) {
  const [closed, setClosed] = useState(new Set<string>());
  const [expanded, setExpanded] = useState(new Set<string>());
  const rows: { row: ManagementRow; currency: string }[] = [];
  const visit = (row: ManagementRow, currency: string) => {
    rows.push({ row, currency });
    if (row.depth === 0 ? !closed.has(row.id) : expanded.has(row.id))
      row.children?.forEach((c) => visit(c, currency));
  };
  reports.forEach((r) =>
    (kind === "revenue" ? r.revenueRows : r.expenseRows).forEach((row) =>
      visit(row, r.currencyCode),
    ),
  );
  const cells = (m: ManagementMetrics, c: string) => (
    <>
      <td>{money(m.ly, c)}</td>
      <td>{money(m.lytd, c)}</td>
      <td>
        <strong>{money(m.plan, c)}</strong>
      </td>
      <td>{money(m.planToDate, c)}</td>
      <td>
        <strong>{money(m.actual, c)}</strong>
        <small className="mrr-sub">
          Δ к плану к дате: {money(m.toDateVariance, c)}
        </small>
      </td>
      <td>
        <div className="mrr-percent">
          <span>{percent(m.attainment)}</span>
          <i>
            <b
              style={{
                width: `${Math.max(0, Math.min(100, m.attainment ?? 0))}%`,
              }}
            />
          </i>
        </div>
      </td>
      <td>{money(m.remaining, c)}</td>
      <td>{money(m.forecast, c)}</td>
    </>
  );
  return (
    <div className="mrr-table-scroll">
      <table className="mrr-table">
        <thead>
          <tr>
            {[
              "Объект / направление / статья",
              "LY факт",
              "LY к дате",
              "План",
              "План к дате",
              "Факт",
              "Выполнение плана",
              "Остаток",
              "Прогноз",
            ].map((h) => (
              <th scope="col" key={h}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ row: r, currency: c }) => {
            const open = r.depth === 0 ? !closed.has(r.id) : expanded.has(r.id);
            return (
              <tr key={r.id} className={`mrr-table-row mrr-row-${r.depth}`}>
                <th scope="row" className="mrr-name">
                  <span className="mrr-name-inner">
                    {r.children?.length ? (
                      <button
                        className="mrr-toggle"
                        aria-expanded={open}
                        aria-label={`${open ? "Свернуть" : "Развернуть"} ${r.label}`}
                        onClick={() => {
                          const setter =
                            r.depth === 0 ? setClosed : setExpanded;
                          setter((s) => {
                            const n = new Set(s);
                            if (n.has(r.id)) n.delete(r.id);
                            else n.add(r.id);
                            return n;
                          });
                        }}
                      >
                        {open ? (
                          <ChevronDown size={15} />
                        ) : (
                          <ChevronRight size={15} />
                        )}
                      </button>
                    ) : (
                      <span className="mrr-toggle-spacer" />
                    )}
                    {r.article && kind === "revenue" ? (
                      <button className="mrr-drill" onClick={() => onDrill(r)}>
                        {r.label}
                      </button>
                    ) : (
                      <span>{r.label}</span>
                    )}
                    {r.depth === 0 && <small>{c}</small>}
                  </span>
                </th>
                {cells(r.metrics, c)}
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          {[...currencyTotals(reports, kind)].map(([c, m]) => (
            <tr key={c} className="mrr-table-row mrr-row-total">
              <th className="mrr-name" scope="row">
                Итого · {c}
              </th>
              {cells(m, c)}
            </tr>
          ))}
        </tfoot>
      </table>
    </div>
  );
}

function ManagementInputEditor({
  report,
  kind,
  onClose,
}: {
  report: ManagementReportData;
  kind: "budget" | "expenses";
  onClose: () => void;
}) {
  const previous = report.inputs[kind];
  const [entries, setEntries] = useState<ManagementEntry[]>(
    previous?.entries ?? [],
  );
  const [reason, setReason] = useState("");
  const [coverage, setCoverage] = useState(previous?.coverageThrough ?? "");
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState("");
  const client = useQueryClient();
  const history = useQuery({
    queryKey: [
      "management-input-history",
      report.propertyId,
      report.period.start,
      report.period.end,
    ],
    queryFn: () =>
      api
        .get("/v1/reports/management-inputs", {
          params: {
            propertyId: report.propertyId,
            startDate: report.period.start,
            endDate: report.period.end,
          },
        })
        .then((r) =>
          unpack<
            Array<{
              id: string;
              revision: number;
              kind: string;
              reason: string;
            }>
          >(r),
        ),
  });
  const articles =
    kind === "budget"
      ? [...MANAGEMENT_REVENUE_ARTICLES, ...MANAGEMENT_EXPENSE_ARTICLES]
      : [...MANAGEMENT_EXPENSE_ARTICLES];
  const save = async () => {
    setSaving(true);
    setFailure("");
    try {
      await api.post(
        "/v1/reports/management-inputs",
        {
          propertyId: report.propertyId,
          startDate: report.period.start,
          endDate: report.period.end,
          kind,
          currencyCode: report.currencyCode,
          expectedRevision: previous?.revision ?? 0,
          entries,
          reason,
          coverageThrough: coverage || undefined,
        },
        { skipErrorToast: true },
      );
      await client.invalidateQueries({ queryKey: ["management-report"] });
      onClose();
    } catch (e) {
      setFailure(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      closeDisabled={saving}
      wide
      title={
        kind === "budget"
          ? "Бюджет периода"
          : "Подтверждённые операционные расходы"
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-gray-600">
          {report.propertyName} · {report.currencyCode} · версия{" "}
          {previous?.revision ?? 0}. Публикуется полная новая версия.
          Неуказанные дни и статьи в опубликованном бюджете означают нулевой
          план; распределение по дням задаётся явно. Расходы — управленческие
          данные, без проводок в гостевом фолио.
        </p>
        <div className="max-h-72 overflow-auto space-y-2">
          {entries.map((entry, i) => (
            <div className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2" key={i}>
              <input
                aria-label={`Дата строки ${i + 1}`}
                type="date"
                min={report.period.start}
                max={report.period.end}
                value={entry.date}
                onChange={(e) =>
                  setEntries((s) =>
                    s.map((v, j) =>
                      j === i ? { ...v, date: e.target.value } : v,
                    ),
                  )
                }
              />
              <select
                aria-label={`Статья строки ${i + 1}`}
                value={entry.article}
                onChange={(e) =>
                  setEntries((s) =>
                    s.map((v, j) =>
                      j === i ? { ...v, article: e.target.value } : v,
                    ),
                  )
                }
              >
                {articles.map((a) => (
                  <option key={a} value={a}>
                    {MANAGEMENT_LABELS[a]}
                  </option>
                ))}
              </select>
              <input
                aria-label={`Сумма строки ${i + 1}`}
                type="number"
                step="0.01"
                value={entry.amount}
                onChange={(e) =>
                  setEntries((s) =>
                    s.map((v, j) =>
                      j === i ? { ...v, amount: e.target.value } : v,
                    ),
                  )
                }
              />
              <button
                aria-label={`Удалить строку ${i + 1}`}
                onClick={() => setEntries((s) => s.filter((_, j) => j !== i))}
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
        </div>
        <button
          onClick={() =>
            setEntries((s) => [
              ...s,
              { date: report.period.start, article: articles[0], amount: "0" },
            ])
          }
          className="flex gap-2"
        >
          <Plus size={16} />
          Добавить строку
        </button>
        {kind === "expenses" && (
          <label className="block">
            Все операционные расходы подтверждены по дату
            <input
              className="block"
              type="date"
              min={report.period.start}
              max={report.period.cutoff ?? report.period.end}
              value={coverage}
              onChange={(e) => setCoverage(e.target.value)}
            />
          </label>
        )}
        <label className="block">
          Основание изменения
          <textarea
            className="block w-full rounded border p-2"
            maxLength={1000}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        {failure && (
          <p role="alert" className="text-red-700">
            {failure}
          </p>
        )}
        <button
          className="rounded bg-telivity-teal text-white px-4 py-2"
          disabled={saving || !reason.trim()}
          onClick={() => void save()}
        >
          {saving ? "Сохраняем…" : "Опубликовать версию"}
        </button>
        <details>
          <summary>История версий</summary>
          {history.isError ? (
            <QueryError onRetry={() => void history.refetch()} />
          ) : history.isPending ? (
            <p>Загрузка…</p>
          ) : (
            history.data.map((v) => (
              <p key={v.id}>
                {v.kind === "budget" ? "Бюджет" : "Расходы"} · {v.revision} ·{" "}
                {v.reason}
              </p>
            ))
          )}
        </details>
      </div>
    </Modal>
  );
}

function OperationsDrill({
  row,
  report,
  onClose,
}: {
  row: ManagementRow;
  report: ManagementReportData;
  onClose: () => void;
}) {
  const [offset, setOffset] = useState(0);
  const { hasPermission } = useAuth();
  const query = useQuery({
    queryKey: [
      "management-operations",
      row.propertyId,
      report.period.start,
      report.period.cutoff,
      row.article,
      offset,
    ],
    enabled: !!report.period.cutoff && hasPermission("folios.read"),
    queryFn: ({ signal }) =>
      api
        .get("/v1/reports/management-operations", {
          signal,
          params: {
            propertyId: row.propertyId,
            startDate: report.period.start,
            endDate: report.period.cutoff,
            article: row.article,
            offset,
          },
          skipErrorToast: true,
        })
        .then((r) =>
          unpack<
            Array<{
              id: string;
              folioId: string | null;
              date: string;
              description: string;
              amount: string;
              currencyCode: string;
            }>
          >(r),
        ),
  });
  return (
    <Modal open wide title={`Операции · ${row.label}`} onClose={onClose}>
      {!hasPermission("folios.read") ? (
        <p>Нет доступа к исходным операциям.</p>
      ) : !report.period.cutoff ? (
        <p>Период ещё не наступил. Исходных операций нет.</p>
      ) : query.isError ? (
        <QueryError onRetry={() => void query.refetch()} />
      ) : query.isPending ? (
        <p>Загрузка…</p>
      ) : (
        <>
          <ul className="divide-y">
            {query.data.map((o) => (
              <li key={o.id} className="py-3">
                <div className="flex justify-between gap-3">
                  <span>
                    {o.date} · {o.description}
                  </span>
                  <strong>{money(Number(o.amount), o.currencyCode)}</strong>
                </div>
                {o.folioId && (
                  <Link
                    className="text-telivity-teal text-sm"
                    to={`/folios/${o.folioId}?propertyId=${row.propertyId}`}
                  >
                    Открыть фолио
                  </Link>
                )}
              </li>
            ))}
          </ul>
          {!query.data.length && <p>Нет операций в выбранном периоде.</p>}
          <div className="flex justify-between mt-3">
            <button
              disabled={!offset}
              onClick={() => setOffset((v) => Math.max(0, v - 100))}
            >
              Назад
            </button>
            <span>
              {offset + 1}–{offset + query.data.length}
            </span>
            <button
              disabled={query.data.length < 100}
              onClick={() => setOffset((v) => v + 100)}
            >
              Далее
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

export default function LiveManagementReport() {
  const { propertyId, isPortfolioMode, properties, setPropertyId } =
    useProperty();
  const { hasPermission } = useAuth();
  const operational = useOperationalDate(
    isPortfolioMode ? null : propertyId,
    hasPermission("reports.view"),
  );
  const [selection, setSelection] = useState({ year: "", month: "", date: "" });
  const [kind, setKind] = useState<"revenue" | "expenses">("revenue");
  const [editing, setEditing] = useState<{
    report: ManagementReportData;
    kind: "budget" | "expenses";
  } | null>(null);
  const [drill, setDrill] = useState<ManagementRow | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  useEffect(() => {
    setSelection(s => ({...s, date:""}));
    setDrill(null);
    setEditing(null);
  }, [propertyId, isPortfolioMode]);
  const reference =
    operational.data?.date ?? new Date().toISOString().slice(0, 10);
  const year = selection.year || reference.slice(0, 4),
    month = selection.month || reference.slice(5, 7);
  const validYear = /^\d{4}$/.test(year) && Number(year) >= 2000 && Number(year) <= 2100;
  const reportYear = validYear ? year : reference.slice(0,4);
  const startDate = month === "all" ? `${reportYear}-01-01` : `${reportYear}-${month}-01`;
  const endDate =
    month === "all"
      ? `${reportYear}-12-31`
      : new Date(Date.UTC(Number(reportYear), Number(month), 0))
          .toISOString()
          .slice(0, 10);
  const ids = isPortfolioMode
    ? properties.map((p) => p.id)
    : propertyId
      ? [propertyId]
      : [];
  const query = useQuery({
    queryKey: ["management-report", ids, startDate, endDate, selection.date],
    enabled:
      ids.length > 0 &&
      hasPermission("reports.view", "management_dashboard.view"),
    queryFn: ({ signal }) =>
      Promise.all(
        ids.map((id) =>
          api
            .get("/v1/reports/management-report", {
              signal,
              params: {
                propertyId: id,
                startDate,
                endDate,
                date: selection.date || undefined,
              },
              skipErrorToast: true,
            })
            .then((r) => unpack<ManagementReportData>(r)),
        ),
      ),
  });
  const reports = query.data ?? [];
  const exportExcel = async () => {
    setExporting(true);
    setExportError("");
    try {
      const { downloadLiveManagementWorkbook } = await import(
        "../../lib/management-live-excel"
      );
      await downloadLiveManagementWorkbook(reports);
    } catch {
      setExportError("Не удалось создать Excel. Повторите попытку.");
    } finally {
      setExporting(false);
    }
  };
  return (
    <div className="mrr">
      <header className="mrr-hero">
        <div>
          <p className="mrr-eyebrow">GUESTRA / УПРАВЛЕНИЕ</p>
          <h1>Управленческий отчёт</h1>
          <p>Доходы, расходы и результат по каждому отелю и всей сети.</p>
        </div>
        <div className="mrr-hero-side">
          <span className="mrr-demo-badge">ДАННЫЕ PMS</span>
          <button
            disabled={!reports.length || exporting || query.isFetching}
            onClick={() => void exportExcel()}
          >
            <Download size={16} />
            {exporting ? "Создаём Excel…" : "Excel · все разделы"}
          </button>
        </div>
      </header>
      {exportError && <p role="alert">{exportError}</p>}
      <div className="mrr-layout">
        <aside className="mrr-filters">
          <div className="mrr-filter-head">
            <span>Период и объекты</span>
            <small>Операционная дата каждого отеля</small>
          </div>
          <label>
            Год
            <input
              aria-label="Год отчёта"
              aria-invalid={!validYear}
              type="number"
              min={2000}
              max={2100}
              value={year}
              onChange={(e) =>
                setSelection((s) => ({ ...s, year: e.target.value }))
              }
            />
            {!validYear && <small>Укажите год от 2000 до 2100.</small>}
          </label>
          <label>
            Период
            <select
              value={month}
              onChange={(e) =>
                setSelection((s) => ({ ...s, month: e.target.value }))
              }
            >
              <option value="all">Весь год</option>
              {Array.from({ length: 12 }, (_, i) => (
                <option key={i} value={String(i + 1).padStart(2, "0")}>
                  {new Intl.DateTimeFormat("ru-RU", { month: "long" }).format(
                    new Date(2026, i, 1),
                  )}
                </option>
              ))}
            </select>
          </label>
          <label>
            Срез
            <input
              type="date"
              value={selection.date}
              onChange={(e) =>
                setSelection((s) => ({ ...s, date: e.target.value }))
              }
            />
          </label>
          <button onClick={() => setSelection((s) => ({ ...s, date: "" }))}>
            Операционная дата
          </button>
          <div className="mrr-property-list">
            {properties.length > 1 && (
              <button
                className={isPortfolioMode ? "active" : ""}
                onClick={() => setPropertyId("portfolio")}
              >
                Вся сеть · по валютам
              </button>
            )}
            {properties.map((p) => (
              <button
                key={p.id}
                className={propertyId === p.id ? "active" : ""}
                onClick={() => setPropertyId(p.id)}
              >
                {p.name}
              </button>
            ))}
          </div>
          <p className="mrr-filter-note">
            Факт — заработанная выручка без отдельно проведённых налогов.
            Депозиты, оплаты и задолженность отражаются отдельно в DRR и
            финансовой сводке.
          </p>
        </aside>
        <main className="min-w-0">
          {!hasPermission("reports.view", "management_dashboard.view") ? (
            <p>Нет доступа к управленческим отчётам.</p>
          ) : query.isError ? (
            <QueryError
              error={query.error}
              onRetry={() => void query.refetch()}
            />
          ) : query.isPending ? (
            <p role="status">Загрузка отчёта…</p>
          ) : (
            <>
              {[...currencyTotals(reports, kind)].map(([c, m]) => (
                <div key={c} className="mrr-metrics">
                  {[
                    [
                      kind === "revenue" ? "Выручка" : "Расходы",
                      money(m.actual, c),
                    ],
                    ["План периода", money(m.plan, c)],
                    ["Выполнение плана", percent(m.attainment)],
                    ["Отклонение к плану к дате", money(m.toDateVariance, c)],
                  ].map(([label, value]) => (
                    <div key={label} className="mrr-metric">
                      <span>
                        {label} · {c}
                      </span>
                      <strong>{value}</strong>
                      <small>
                        {startDate} — {endDate}
                      </small>
                    </div>
                  ))}
                </div>
              ))}
              {reports.map((r) => (
                <section className="mrr-card mb-5" key={r.propertyId}>
                  <div className="mrr-card-head">
                    <h2>
                      {r.propertyName} · {r.currencyCode}
                    </h2>
                    <small>
                      Срез: {r.period.cutoff ?? "Период ещё не наступил"}
                    </small>
                  </div>
                  <div className="p-4 flex flex-wrap gap-4 text-sm">
                    <span>
                      Факт: {MANAGEMENT_STATUS_LABELS[r.sources.actual]}
                    </span>
                    <span>
                      Бюджет: {MANAGEMENT_STATUS_LABELS[r.sources.budget]}
                    </span>
                    <span>
                      Расходы: {MANAGEMENT_STATUS_LABELS[r.sources.expenses]}
                    </span>
                    <span>
                      Прогноз: {MANAGEMENT_STATUS_LABELS[r.sources.forecast]}
                    </span>
                    <span>
                      Операционный результат:{" "}
                      {money(r.totals.operatingResult, r.currencyCode)}
                    </span>
                    {hasPermission("accounting.manage") && (
                      <>
                        <button
                          className="text-telivity-teal"
                          onClick={() =>
                            setEditing({ report: r, kind: "budget" })
                          }
                        >
                          Бюджет · версия {r.inputs.budget?.revision ?? 0}
                        </button>
                        <button
                          className="text-telivity-teal"
                          onClick={() =>
                            setEditing({ report: r, kind: "expenses" })
                          }
                        >
                          Расходы · версия {r.inputs.expenses?.revision ?? 0}
                        </button>
                      </>
                    )}
                  </div>
                  <div className="grid grid-cols-3 gap-3 p-4 text-sm">
                    {["mtd", "ytd", "lytd"].map((k) => (
                      <div key={k}>
                        <strong>{k.toUpperCase()}</strong>
                        <p>
                          {money(r.periods[k]?.value ?? null, r.currencyCode)}
                        </p>
                      </div>
                    ))}
                  </div>
                  <div className="p-4 grid gap-3 sm:grid-cols-3 text-sm">
                    <div>
                      <span>OCC · срез</span>
                      <strong className="block">
                        {r.executive
                          ? percent(
                              r.executive.occupancy === null
                                ? null
                                : r.executive.occupancy * 100,
                            )
                          : "—"}
                      </strong>
                    </div>
                    <div>
                      <span>ADR · срез</span>
                      <strong className="block">
                        {money(r.executive?.adr ?? null, r.currencyCode)}
                      </strong>
                    </div>
                    <div>
                      <span>RevPAR · срез</span>
                      <strong className="block">
                        {money(r.executive?.revpar ?? null, r.currencyCode)}
                      </strong>
                    </div>
                  </div>
                  <div className="p-4 flex flex-wrap gap-4 text-sm">
                    {r.executive && (
                      <>
                        <span>Заезды: {r.executive.arrivals}</span>
                        <span>Выезды: {r.executive.departures}</span>
                        <span>Отмены: {r.executive.cancellations}</span>
                        <span>Неявки: {r.executive.noShows}</span>
                        <span>Pickup: {r.executive.pickup ?? "—"}</span>
                        <span>Pace: {r.executive.pace ?? "—"}</span>
                        <span>
                          Оплаты:{" "}
                          {money(r.executive.receivedPayments, r.currencyCode)}
                        </span>
                        <span>
                          Возвраты оплат:{" "}
                          {money(r.executive.refunds, r.currencyCode)}
                        </span>
                        <span>
                          Депозиты · текущий остаток:{" "}
                          {money(r.executive.heldDeposits, r.currencyCode)}
                        </span>
                      </>
                    )}
                  </div>
                  <div style={{ height: 230, minWidth: 0 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={r.daily}>
                        <XAxis
                          dataKey="date"
                          tickFormatter={(d) => String(d).slice(5)}
                          minTickGap={36}
                        />
                        <YAxis
                          width={58}
                          tickFormatter={(v) =>
                            new Intl.NumberFormat("ru-RU", {
                              notation: "compact",
                            }).format(v)
                          }
                        />
                        <Tooltip
                          formatter={(v) => money(Number(v), r.currencyCode)}
                        />
                        <Legend />
                        <Bar
                          dataKey={kind === "revenue" ? "plan" : "expensePlan"}
                          name="План"
                          fill="#d0c09b"
                        />
                        <Bar
                          dataKey={kind === "revenue" ? "actual" : "expenses"}
                          name="Факт"
                          fill="#0c7368"
                        />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="p-4 flex flex-wrap gap-4">
                    {(kind === "revenue"
                      ? r.revenueRows
                      : r.expenseRows)[0]?.children?.map((row) => (
                      <div key={row.id}>
                        <span className="text-sm">{row.label}</span>
                        <strong className="block">
                          {money(row.metrics.actual, r.currencyCode)}
                        </strong>
                      </div>
                    ))}
                  </div>
                </section>
              ))}
              <section className="mrr-card">
                <div className="mrr-section-head">
                  <h2>Финансовая иерархия</h2>
                  <div className="mrr-tabs">
                    <button
                      aria-pressed={kind === "revenue"}
                      onClick={() => setKind("revenue")}
                    >
                      Доходы
                    </button>
                    <button
                      aria-pressed={kind === "expenses"}
                      onClick={() => setKind("expenses")}
                    >
                      Расходы
                    </button>
                  </div>
                </div>
                <LiveHierarchy
                  reports={reports}
                  kind={kind}
                  onDrill={setDrill}
                />
                <p className="mrr-footnote">
                  Прогноз: недостаточно подтверждённой истории. «—» означает
                  отсутствие источника. Выполнение плана относится ко всему
                  периоду; отклонение к плану к дате показано отдельно. Валюты
                  не суммируются. Нажмите на статью дохода для просмотра
                  операций.
                </p>
              </section>
            </>
          )}
        </main>
      </div>
      {editing && (
        <ManagementInputEditor
          key={editing.report.propertyId + editing.kind}
          {...editing}
          onClose={() => setEditing(null)}
        />
      )}{" "}
      {drill && reports.find((r) => r.propertyId === drill.propertyId) && (
        <OperationsDrill
          row={drill}
          report={reports.find((r) => r.propertyId === drill.propertyId)!}
          onClose={() => setDrill(null)}
        />
      )}
    </div>
  );
}

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type {
  ManagementReportData,
  ManagementMetrics,
} from "@telivityhaip/shared";
import { buildLiveManagementWorkbook } from "./management-live-excel";
import { currencyTotals } from "./management-live";
import { LiveHierarchy } from "../components/revenue/LiveManagementReport";
const metrics: ManagementMetrics = {
  ly: null,
  lytd: null,
  plan: 100,
  planToDate: 60,
  actual: 123.45,
  attainment: 123.45,
  toDateVariance: 63.45,
  remaining: -23.45,
  forecast: null,
};
function fixture(currencyCode = "KZT"): ManagementReportData {
  return {
    propertyId: currencyCode,
    propertyName: "Отель " + currencyCode,
    currencyCode,
    timezone: "UTC",
    period: {
      start: "2024-02-01",
      end: "2024-02-29",
      cutoff: "2024-02-20",
      businessDate: "2024-02-20",
      lyStart: "2023-02-01",
      lyEnd: "2023-02-28",
      lyCutoff: "2023-02-20",
    },
    revenueRows: [
      {
        id: currencyCode,
        propertyId: currencyCode,
        label: "Отель " + currencyCode,
        depth: 0,
        metrics,
        children: [
          {
            id: currencyCode + "room",
            propertyId: currencyCode,
            label: "Проживание",
            depth: 1,
            metrics,
            children: [
              {
                id: currencyCode + "article",
                propertyId: currencyCode,
                label: "Номерной фонд",
                depth: 2,
                article: "room",
                metrics,
              },
            ],
          },
        ],
      },
    ],
    expenseRows: [],
    totals: {
      revenue: metrics,
      expenses: { ...metrics, actual: null },
      operatingResult: null,
    },
    sources: {
      actual: "PARTIAL",
      history: "NO_DATA",
      budget: "CONFIGURED",
      expenses: "NOT_CONFIGURED",
      forecast: "INSUFFICIENT_HISTORY",
      operatingResult: "INSUFFICIENT_DATA",
    },
    inputs: { budget: null, expenses: null },
    daily: [
      {
        date: "2024-02-20",
        actual: 123.45,
        plan: 60,
        expenses: null,
        expensePlan: null,
      },
    ],
    executive: null,
    periods: { mtd: { value: 123.45, status: "PARTIAL" } },
  };
}
describe("Live Management UI and Excel snapshot reconciliation", () => {
  it("exports exact signed values and null cells, keeps each currency separate and preserves hierarchy", async () => {
    const book = buildLiveManagementWorkbook([fixture(), fixture("USD")]);
    const revenue = book.getWorksheet("Доходы")!;
    expect(revenue.getCell("G2").value).toBe(123.45);
    expect(revenue.getCell("H2").value).toBe(123.45);
    expect(revenue.getCell("I2").value).toBe(-23.45);
    expect(revenue.getCell("C2").value).toBeNull();
    expect(revenue.getCell("J2").value).toBeNull();
    expect(revenue.getCell("G8").value).toBe(123.45);
    expect(revenue.getCell("G9").value).toBe(123.45);
    expect(revenue.getRow(4).outlineLevel).toBe(2);
    expect((await book.xlsx.writeBuffer()).byteLength).toBeGreaterThan(8000);
  });
  it("does not cap displayed attainment, exposes plan-to-date variance and opens available source operations", () => {
    const onDrill = vi.fn();
    render(
      <LiveHierarchy reports={[fixture()]} kind="revenue" onDrill={onDrill} />,
    );
    expect(screen.getAllByText("123,5%")).toHaveLength(3);
    fireEvent.click(
      screen.getByRole("button", { name: "Развернуть Проживание" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Номерной фонд" }));
    expect(onDrill).toHaveBeenCalledWith(
      expect.objectContaining({ article: "room" }),
    );
  });
  it("keeps missing values null in currency totals and never aggregates across currencies", () => {
    expect([
      ...currencyTotals([fixture(), fixture("USD")], "revenue").keys(),
    ]).toEqual(["KZT", "USD"]);
    expect(
      currencyTotals([fixture()], "expenses").get("KZT")?.actual,
    ).toBeNull();
    expect(currencyTotals([fixture()], "revenue").get("KZT")?.attainment).toBe(
      123.45,
    );
  });
});

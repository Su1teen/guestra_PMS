export const MANAGEMENT_REVENUE_ARTICLES = [
  "room",
  "food_beverage",
  "minibar",
  "phone",
  "laundry",
  "parking",
  "spa",
  "incidental",
  "fee",
  "adjustment",
  "package",
] as const;
export const MANAGEMENT_EXPENSE_ARTICLES = [
  "operations",
  "selling",
  "administration",
  "other",
] as const;
export const MANAGEMENT_LABELS: Record<string, string> = {
  room: "Номерной фонд",
  food_beverage: "Ресторан и питание",
  minibar: "Минибар",
  phone: "Связь",
  laundry: "Прачечная",
  parking: "Парковка",
  spa: "SPA",
  incidental: "Прочие услуги",
  fee: "Сборы",
  adjustment: "Корректировки",
  package: "Пакеты",
  accommodation: "Проживание",
  fnb: "F&B",
  ancillary: "Дополнительные доходы",
  operations: "Операционные расходы",
  selling: "Продажи",
  administration: "Административные расходы",
  other: "Прочие расходы",
};
export const managementGroup = (article: string) =>
  article === "room"
    ? "accommodation"
    : article === "food_beverage"
      ? "fnb"
      : "ancillary";
export interface ManagementEntry {
  date: string;
  article: string;
  amount: string;
}
export interface ManagementInput {
  id: string;
  revision: number;
  kind: "budget" | "expenses";
  currencyCode: string;
  entries: ManagementEntry[];
  reason: string;
  coverageThrough: string | null;
  createdAt: string;
}
export interface ManagementMetrics {
  ly: number | null;
  lytd: number | null;
  plan: number | null;
  planToDate: number | null;
  actual: number | null;
  attainment: number | null;
  toDateVariance: number | null;
  remaining: number | null;
  forecast: number | null;
}
export interface ManagementRow {
  id: string;
  propertyId: string;
  label: string;
  depth: number;
  article?: string;
  metrics: ManagementMetrics;
  children?: ManagementRow[];
}
export interface ManagementReportData {
  propertyId: string;
  propertyName: string;
  currencyCode: string;
  timezone: string;
  period: {
    start: string;
    end: string;
    cutoff: string | null;
    businessDate: string;
    lyStart: string;
    lyEnd: string;
    lyCutoff: string | null;
  };
  revenueRows: ManagementRow[];
  expenseRows: ManagementRow[];
  totals: {
    revenue: ManagementMetrics;
    expenses: ManagementMetrics;
    operatingResult: number | null;
  };
  sources: {
    actual: string;
    history: string;
    budget: string;
    expenses: string;
    forecast: string;
    operatingResult: string;
  };
  inputs: { budget: ManagementInput | null; expenses: ManagementInput | null };
  daily: {
    date: string;
    actual: number | null;
    plan: number | null;
    expenses: number | null;
    expensePlan: number | null;
  }[];
  executive: {
    date: string;
    occupancy: number | null;
    adr: number | null;
    revpar: number | null;
    arrivals: number;
    departures: number;
    cancellations: number;
    noShows: number;
    receivedPayments: number;
    refunds: number;
    heldDeposits: number;
    separatelyPostedTax: number;
    pickup: number | null;
    pace: number | null;
  } | null;
  periods: Record<string, { value: number | null; status: string }>;
}

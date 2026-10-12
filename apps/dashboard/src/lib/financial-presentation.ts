import { type ActualRevenue } from './live-revenue';

export function hasActual(actual?: Pick<ActualRevenue, 'value' | 'status'>) {
  return actual?.value != null && actual.status !== 'NO_POSTINGS' && actual.status !== 'MIXED_CURRENCIES';
}

export function reportedKpis(report: any) {
  const kpis = report?.kpis ?? report ?? {};
  const actual = report?.actual;
  const earned = hasActual(actual);
  const ratio = (key: string) => earned && (!kpis.ratioStatus?.[key] || kpis.ratioStatus[key] === 'AVAILABLE') ? kpis[key] ?? null : null;
  return { ...kpis, totalRevenue: earned ? actual.value : null,
    roomRevenue: earned ? kpis.roomRevenue : null, foodBeverageRevenue: earned ? kpis.foodBeverageRevenue : null,
    ancillaryRevenue: earned ? kpis.ancillaryRevenue : null, separatelyPostedTax: earned ? kpis.separatelyPostedTax : null,
    adr: ratio('adr'), revpar: ratio('revpar'), trevpar: ratio('trevpar'),
    occupancyRate: kpis.occ !== undefined ? kpis.occ : kpis.availableRooms === 0 || kpis.totalAvailableRooms === 0 ? null : kpis.occupancyRate ?? null };
}

export function reportForPresentation(type: string, data: any): any {
  if (type === 'financial-summary') return { ...data, kpis: reportedKpis(data),
    byProperty: data.byProperty?.map((row: any) => ({ ...row, ...reportedKpis(row) })),
    byCurrency: data.byCurrency?.map((row: any) => ({ ...row, ...reportedKpis(row) })) };
  if (type === 'daily-revenue') {
    const { revenue, netRevenue, ...signed } = data;
    return { ...signed, grossNonReversalChargesIncludingTax: revenue, netTaxInclusiveCharges: netRevenue,
    netEarnedRevenue: hasActual(data.actual) ? data.actual.value : null,
    adjustments: hasActual(data.actual) ? data.adjustments : null,
    netRevenueByCategory: Object.fromEntries(Object.entries(data.netRevenueByCategory ?? {}).map(([key, value]) => [key, hasActual(data.actual) ? value : null])) };
  }
  if (type === 'occupancy-trend') return { ...data, daily: data.daily?.map((row: any) => ({ ...row,
    revenue: hasActual(row.actual) ? row.roomRevenue : null, totalRevenue: hasActual(row.actual) ? row.actual.value : null,
    adr: hasActual(row.actual) && row.roomsSold > 0 ? row.adr : null,
    revpar: hasActual(row.actual) && row.availableRooms > 0 ? row.revpar : null,
    occupancyRate: row.availableRooms > 0 ? row.occupancyRate : null })) };
  return data;
}

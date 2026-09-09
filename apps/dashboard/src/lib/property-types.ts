/** Sentinel value for portfolio (all properties) mode in the property switcher. */
export const PORTFOLIO_MODE_ID = 'portfolio';

export interface PropertySummary {
  id: string;
  name: string;
  code: string;
  /** ISO 4217 from the property record — drives every money render in the UI. */
  currencyCode?: string | null;
  /** IANA zone from the property record. Time-of-day pricing rules (e.g. the
   *  same-day evening discount) must be evaluated here, not in the browser's
   *  zone, or they fire at the wrong hour for every remote user. */
  timezone?: string | null;
  totalRooms?: number | null;
  organizationId?: string | null;
  staffDisplayName?: string | null;
  staffLogoMediaId?: string | null;
  staffLogoUrl?: string | null;
  staffPrimaryColor?: string | null;
  staffAccentColor?: string | null;
  settings?: {
    kpiThresholds?: {
      occupancyRate?: { warnBelow?: number; goodAbove?: number };
      adr?: { warnBelow?: number };
      revpar?: { warnBelow?: number };
      totalRevenue?: { warnBelow?: number };
    };
  } | null;
}

export interface OrganizationSummary {
  id: string;
  name: string;
  code: string;
}

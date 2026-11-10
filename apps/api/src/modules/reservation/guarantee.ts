/** How a confirmed booking is guaranteed. */
export const GUARANTEE_TYPES = ['deposit', 'card', 'company', 'none'] as const;
export type GuaranteeType = (typeof GUARANTEE_TYPES)[number];

/**
 * Booking policy applied when the property has not chosen otherwise (pilot hotel decisions, 2026-11-10):
 * a 50% prepayment confirms a tentative booking, and an expired option only reminds staff; it is never
 * released automatically. A hotel overrides either in Settings -> Booking policy.
 */
export const BOOKING_POLICY_DEFAULTS = { depositPercentage: 50, optionExpiryAction: 'notify' as 'cancel' | 'notify' };

/** Tenders front desk can record by hand as a received prepayment while no payment gateway is connected. */
export const MANUAL_PREPAYMENT_METHODS = ['cash', 'bank_transfer', 'credit_card', 'debit_card', 'other'] as const;
export type ManualPrepaymentMethod = (typeof MANUAL_PREPAYMENT_METHODS)[number];

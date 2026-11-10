export interface Reservation {
  id: string;
  confirmationNumber: string;
  status: string;
  arrivalDate: string;
  departureDate: string;
  roomId?: string;
  roomNumber?: string;
  roomTypeId?: string;
  roomTypeName?: string;
  ratePlanId?: string;
  ratePlanName?: string;
  guestId?: string;
  guestName?: string;
  guest?: { id: string; firstName: string; lastName: string; email?: string | null };
  adults: number;
  children: number;
  childAges?: number[] | null;
  nights?: number;
  bookingId?: string;
  groupName?: string | null;
  /** Tentative booking terms */
  optionUntil?: string | null;
  /** Guest confirmed the booking details sent into a chat. */
  detailsConfirmedAt?: string | null;
  requiredDeposit?: string | null;
  guaranteeType?: string | null;
  confirmedAt?: string | null;
  proposalSentAt?: string | null;
  confirmationSentAt?: string | null;
  totalAmount?: number | string;
  currencyCode?: string;
  source?: string;
  specialRequests?: string;
  notes?: string;
  createdAt?: string;
}

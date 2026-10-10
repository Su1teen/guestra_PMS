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
  totalAmount?: number | string;
  currencyCode?: string;
  source?: string;
  specialRequests?: string;
  notes?: string;
  createdAt?: string;
}

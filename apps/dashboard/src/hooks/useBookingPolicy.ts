import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { BookingPolicy } from '../lib/booking';

/** The property's tentative-booking, guarantee and child-age policy (effective values with defaults). */
export function useBookingPolicy(propertyId: string | null | undefined, enabled = true) {
  return useQuery<BookingPolicy>({
    queryKey: ['booking-policy', propertyId],
    queryFn: () => api.get(`/v1/properties/${propertyId}/booking-policy`).then((r) => r.data?.data ?? r.data),
    enabled: enabled && !!propertyId,
    staleTime: 5 * 60_000,
  });
}

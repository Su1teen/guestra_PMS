import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { unwrap } from '../lib/live-revenue';

export function shiftBusinessDate(date: string, days: number) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

export function useOperationalDate(propertyId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ['reports', 'business-date', propertyId],
    queryFn: ({ signal }) => api.get('/v1/reports/business-date', { params: { propertyId }, signal })
      .then(r => unwrap<{ date: string; currencyCode: string; timezone: string }>(r.data)),
    enabled: !!propertyId && enabled,
  });
}

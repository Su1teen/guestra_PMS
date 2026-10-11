import { QueryClient } from '@tanstack/react-query';
import axios from 'axios';

export function shouldRetryQuery(failureCount: number, error: unknown) {
  if (axios.isCancel(error)) return false;
  const status = (error as { response?: { status?: number } } | null)?.response?.status;
  // Permission, validation, missing-object and conflict errors need a deliberate user action.
  if (status && status >= 400 && status < 500) return false;
  return failureCount < 1;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      retry: shouldRetryQuery,
    },
  },
});

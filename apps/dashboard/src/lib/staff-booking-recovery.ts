import { useEffect, useState } from 'react';
const eventName = 'guestra:staff-request';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const staffRecoveryKey = (actor: string, propertyId: string) => `guestra.staff-request.v1:${encodeURIComponent(actor)}:${propertyId}`;
/** Session recovery stores a random request token only, never guest details or a booking payload. */
export function readStaffRequest(key: string): string | null {
  try { const value = sessionStorage.getItem(key); return value && uuid.test(value) ? value : null; } catch { return null; }
}
export function saveStaffRequest(key: string, requestId: string): boolean {
  try { sessionStorage.setItem(key, requestId); window.dispatchEvent(new Event(eventName)); return true; } catch { return false; }
}
export function clearStaffRequest(key: string, requestId: string) {
  try { if (readStaffRequest(key) === requestId) { sessionStorage.removeItem(key); window.dispatchEvent(new Event(eventName)); } } catch { /* Keep a recoverable token if storage becomes unavailable. */ }
}
export function usePendingStaffRequest(key: string) {
  const [pending, setPending] = useState(() => readStaffRequest(key));
  useEffect(() => {
    const refresh = () => setPending(readStaffRequest(key));
    refresh(); window.addEventListener(eventName, refresh); window.addEventListener('storage', refresh);
    return () => { window.removeEventListener(eventName, refresh); window.removeEventListener('storage', refresh); };
  }, [key]);
  return pending;
}

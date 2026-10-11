import { useCallback, useState } from 'react';

/** Cosmetic preferences must never prevent the PMS opening in private/restricted storage. */
export function useStoredPreference(key: string, fallback = false) {
  const [value, setValue] = useState(() => {
    try { const stored = localStorage.getItem(key); return stored === null ? fallback : stored === 'true'; }
    catch { return fallback; }
  });
  const update = useCallback((next: boolean) => {
    setValue(next);
    try { localStorage.setItem(key, String(next)); } catch { /* In-memory preference remains usable. */ }
  }, [key]);
  return [value, update] as const;
}

'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * useState that persists to localStorage under `key`, so a selection survives
 * navigating away and back within the app until it's explicitly changed or reset.
 * SSR-safe: reads storage only after mount to avoid hydration mismatches.
 */
export function usePersistedState<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(initial);
  const hydrated = useRef(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw != null) setValue(JSON.parse(raw) as T);
    } catch {
      /* ignore malformed/unavailable storage */
    }
  }, [key]);

  useEffect(() => {
    // Skip the write paired with the very first render. `value` is still the
    // fallback at that point, and persisting it would clobber the stored value
    // the read above is about to restore — which is what happens the moment a
    // second component mounts against the same key (e.g. switching tabs), and
    // it silently wipes the saved selection.
    if (!hydrated.current) {
      hydrated.current = true;
      return;
    }
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* ignore quota/unavailable storage */
    }
  }, [key, value]);

  return [value, setValue];
}

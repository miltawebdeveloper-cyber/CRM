'use client';

import { useEffect, useRef, useState } from 'react';
import { isAppHydrated } from './hydration';

/** Distinguishes "storage holds no value" from "storage holds null". */
const MISSING = Symbol('missing');

function readStored<T>(key: string): T | typeof MISSING {
  if (typeof window === 'undefined') return MISSING;
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? MISSING : (JSON.parse(raw) as T);
  } catch {
    /* malformed / unavailable storage */
    return MISSING;
  }
}

/**
 * useState that persists to localStorage under `key`, so a selection survives
 * navigating away and back within the app until it's explicitly changed or reset.
 *
 * The saved value is read DURING the first render wherever that is safe — see
 * `isAppHydrated`. It matters more than it looks: several of these values are
 * query parameters (the Lead Management date filter, the Calling Panel's zone),
 * so restoring one a render late changes the query key a render late. The page
 * then asks the API for the default filter, throws the answer away, and asks
 * again for the real one — two requests per visit, with an empty table on screen
 * between them.
 *
 * On a full page load there is server markup to match, so the first render still
 * uses `initial` and the effect below restores the value. That path is unchanged
 * and remains hydration-safe; it simply no longer applies to the navigations
 * where the flicker was actually visible.
 */
export function usePersistedState<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    if (!isAppHydrated()) return initial;
    const stored = readStored<T>(key);
    return stored === MISSING ? initial : stored;
  });

  // Whether storage has already been consulted for the CURRENT key. Set during
  // the initial render when the read happened there, so the effect below does
  // not re-set the same value — `JSON.parse` returns a fresh object every call,
  // and setting an equal-but-new object is exactly the extra render (and extra
  // query key) this hook exists to avoid.
  const restoredKey = useRef<string | null>(isAppHydrated() ? key : null);

  useEffect(() => {
    if (restoredKey.current === key) return;
    restoredKey.current = key;
    const stored = readStored<T>(key);
    if (stored !== MISSING) setValue(stored);
  }, [key]);

  const written = useRef(false);
  useEffect(() => {
    // Skip the write paired with the very first render. `value` may still be the
    // fallback at that point, and persisting it would clobber the stored value
    // the read above is about to restore — which is what happens the moment a
    // second component mounts against the same key (e.g. switching tabs), and
    // it silently wipes the saved selection.
    if (!written.current) {
      written.current = true;
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

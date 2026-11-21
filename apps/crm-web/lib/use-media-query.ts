'use client';

import { useSyncExternalStore } from 'react';

/**
 * Whether a CSS media query matches, kept up to date as the window resizes.
 *
 * For a layout that must be ONE of two things rather than both hidden by CSS:
 * the team comparison is a table on wide screens and a list of cards on narrow
 * ones, and rendering both would put every rep's name — a button — in the
 * page twice. `serverValue` is what the server render and the first client
 * render use (the server can't measure a screen); React swaps in the real
 * value straight after, without a hydration mismatch. Where there's no
 * `matchMedia` (tests), it stays at `serverValue`.
 */
export function useMediaQuery(query: string, serverValue = true): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window === 'undefined' || !window.matchMedia) return () => {};
      const mq = window.matchMedia(query);
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    },
    () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : serverValue),
    () => serverValue,
  );
}

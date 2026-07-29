'use client';

import { useEffect, useState } from 'react';

/**
 * A value that settles rather than tracking every keystroke.
 *
 * Search boxes drive server queries now, and typing "Miami" without this fires
 * five of them — four of which are obsolete before they return, and which the
 * browser queues behind each other on the same connection. Waiting for a pause
 * turns that into one request.
 *
 * 250ms is the default: below about 150ms it stops collapsing ordinary typing,
 * and much above 300ms the box starts to feel like it is lagging behind.
 */
export function useDebounced<T>(value: T, delayMs = 250): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const id = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);

  return settled;
}

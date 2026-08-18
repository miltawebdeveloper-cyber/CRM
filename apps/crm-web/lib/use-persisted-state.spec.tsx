/** @jest-environment jsdom */
import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { renderHook, act } from '@testing-library/react';

/**
 * WHEN this hook reads storage, not just whether it does.
 *
 * That distinction is the entire bug it was changed to fix. Several of these
 * values are query parameters — the Lead Management date filter, the Calling
 * Panel's zone — so restoring one a render late changes the query KEY a render
 * late: the page asks the API for the default filter, throws the answer away,
 * and asks again for the real one. Two requests per visit, with an empty table
 * on screen in between, and nothing in a "does it persist?" test would notice.
 *
 * So the assertions below are mostly about the SEQUENCE of values a component
 * sees, and about the one render where the answer has to already be right.
 */

/**
 * Whether the app shell has finished hydrating — the one input that decides
 * which path the hook takes.
 *
 * Stubbed rather than driven through the real module because the real one is
 * one-way module state, and resetting it by re-requiring the module registry
 * would hand the test a second copy of React along with it.
 */
let mockHydrated = false;
jest.mock('./hydration', () => ({
  isAppHydrated: () => mockHydrated,
  markAppHydrated: () => {
    mockHydrated = true;
  },
}));

import { usePersistedState } from './use-persisted-state';

describe('usePersistedState', () => {
  beforeEach(() => {
    localStorage.clear();
    mockHydrated = false;
  });

  describe('on a client-side navigation (the app is already hydrated)', () => {
    beforeEach(() => {
      mockHydrated = true;
    });

    it('has the saved value on the FIRST render', () => {
      // The fix, stated plainly. There is no server markup to match on a soft
      // navigation, so there is no reason to show the default first — and every
      // reason not to, because a query fires off this value.
      localStorage.setItem('leads:date-filter', JSON.stringify({ mode: 'day', from: '2026-08-18', to: '2026-08-18' }));

      const seen: unknown[] = [];
      renderHook(() => {
        const [value] = usePersistedState('leads:date-filter', { mode: 'all', from: '', to: '' });
        seen.push(value);
        return value;
      });

      expect(seen[0]).toEqual({ mode: 'day', from: '2026-08-18', to: '2026-08-18' });
    });

    it('never shows the default first, so no query is fired against it', () => {
      localStorage.setItem('calling:queue-timezone', JSON.stringify('CST'));

      const seen: unknown[] = [];
      renderHook(() => {
        const [value] = usePersistedState<string>('calling:queue-timezone', '');
        seen.push(value);
        return value;
      });

      // Not merely "ends up right" — the default is never rendered at all.
      expect(seen).not.toContain('');
      expect(seen[seen.length - 1]).toBe('CST');
    });

    it('does not re-set an equal value as a new object', () => {
      // `JSON.parse` returns a fresh object every call. Setting one that equals
      // what is already in state would still change its IDENTITY — and identity
      // is what a query key is compared by, so it would refetch the list for a
      // filter nobody touched. The reference has to be stable across renders.
      localStorage.setItem('leads:date-filter', JSON.stringify({ mode: 'day', from: '2026-08-18', to: '' }));

      const seen: unknown[] = [];
      const { rerender } = renderHook(() => {
        const [value] = usePersistedState('leads:date-filter', { mode: 'all', from: '', to: '' });
        seen.push(value);
        return value;
      });
      rerender();

      expect(new Set(seen).size).toBe(1);
    });

    it('falls back to the default when nothing is stored', () => {
      const { result } = renderHook(() => usePersistedState('leads:date-field', 'created'));
      expect(result.current[0]).toBe('created');
    });
  });

  describe('on a full page load (the app is still hydrating)', () => {
    it('renders the default first, so the markup matches the server', () => {
      // The SSR-safe path, unchanged and deliberately kept. Reading storage
      // during this render is what causes a hydration mismatch, and React 19
      // answers one by throwing away the server render for the whole root —
      // a far bigger blank than the one being fixed.
      localStorage.setItem('leads:date-field', JSON.stringify('scheduled'));

      const seen: unknown[] = [];
      renderHook(() => {
        const [value] = usePersistedState<string>('leads:date-field', 'created');
        seen.push(value);
        return value;
      });

      expect(seen[0]).toBe('created');
    });

    it('still restores the saved value once mounted', () => {
      localStorage.setItem('leads:date-field', JSON.stringify('scheduled'));
      const { result } = renderHook(() => usePersistedState<string>('leads:date-field', 'created'));
      expect(result.current[0]).toBe('scheduled');
    });
  });

  describe('writing', () => {
    it('persists a new value', () => {
      mockHydrated = true;
      const { result } = renderHook(() => usePersistedState<string>('calling:queue-timezone', ''));

      act(() => result.current[1]('PST'));

      expect(JSON.parse(localStorage.getItem('calling:queue-timezone')!)).toBe('PST');
    });

    it('does not clobber the stored value just by mounting', () => {
      // The failure this guard exists for: a second component mounting against
      // the same key wrote its fallback back over the saved selection before the
      // read had a chance to run, silently wiping it.
      localStorage.setItem('calling:queue-timezone', JSON.stringify('EST'));

      renderHook(() => usePersistedState<string>('calling:queue-timezone', ''));

      expect(JSON.parse(localStorage.getItem('calling:queue-timezone')!)).toBe('EST');
    });
  });

  describe('storage that cannot be trusted', () => {
    it('falls back to the default on malformed JSON', () => {
      // Written by an older version, or by hand. It must not take the page down.
      mockHydrated = true;
      localStorage.setItem('leads:date-field', '{not json');
      const { result } = renderHook(() => usePersistedState<string>('leads:date-field', 'created'));
      expect(result.current[0]).toBe('created');
    });

    it('treats a stored null as a value, not as "nothing stored"', () => {
      // The Calling Panel's session is legitimately null — "no lead being
      // worked" — and reading that as absent would restore the fallback instead
      // of the deliberate empty state.
      mockHydrated = true;
      localStorage.setItem('calling:queue-session', JSON.stringify(null));
      const { result } = renderHook(() =>
        usePersistedState<{ leadId: string } | null>('calling:queue-session', { leadId: 'stale' }),
      );
      expect(result.current[0]).toBeNull();
    });
  });
});

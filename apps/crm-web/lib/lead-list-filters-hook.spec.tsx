/** @jest-environment jsdom */
import { beforeEach, describe, expect, it } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react';
import { DEFAULT_LEAD_LIST_FILTERS, useLeadListFilters } from './lead-list-filters';

/**
 * The bug this hook exists for: every filter on Lead Management except the date
 * was plain component state, so opening a lead and coming back reset them all.
 */
const KEY = 'leads:filters';

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, '', '/leads');
});

describe('useLeadListFilters', () => {
  it('brings saved filters back on the next visit, and puts them in the URL', async () => {
    localStorage.setItem(KEY, JSON.stringify({ ...DEFAULT_LEAD_LIST_FILTERS, country: 'US', state: 'TX' }));
    const { result } = renderHook(() => useLeadListFilters(KEY));
    await waitFor(() => expect(result.current.filters.state).toBe('TX'));
    expect(result.current.filters.country).toBe('US');
    expect(window.location.search).toBe('?country=US&state=TX');
  });

  it('lets a link win over what was saved', async () => {
    localStorage.setItem(KEY, JSON.stringify({ ...DEFAULT_LEAD_LIST_FILTERS, state: 'FL' }));
    window.history.replaceState(null, '', '/leads?state=TX&outcome=call_back');
    const { result } = renderHook(() => useLeadListFilters(KEY));
    await waitFor(() => expect(result.current.filters.state).toBe('TX'));
    expect(result.current.filters.outcomes).toEqual(['call_back']);
  });

  it('saves and links every change, keeping parameters it does not own', async () => {
    window.history.replaceState(null, '', '/leads?leadId=abc');
    const { result } = renderHook(() => useLeadListFilters(KEY));
    act(() => result.current.update({ city: 'Austin' }));
    await waitFor(() => expect(window.location.search).toContain('city=Austin'));
    expect(window.location.search).toContain('leadId=abc');
    expect(JSON.parse(localStorage.getItem(KEY) ?? '{}').city).toBe('Austin');
  });

  it('clears to an unfiltered list with a clean address', async () => {
    window.history.replaceState(null, '', '/leads?state=TX&q=acme');
    const { result } = renderHook(() => useLeadListFilters(KEY));
    await waitFor(() => expect(result.current.activeCount).toBe(2));
    act(() => result.current.clear());
    await waitFor(() => expect(window.location.search).toBe(''));
    expect(result.current.activeCount).toBe(0);
  });
});

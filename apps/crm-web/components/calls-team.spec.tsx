/** @jest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import type { TeamCallsRow } from '@/lib/crm';
import { CallsTeam, sortTeam, teamRates } from './calls-team';

jest.mock('@/lib/crm', () => ({ callsApi: {}, formatDuration: (s: number) => `${s}s` }));
const mockDownloadCsv = jest.fn();
jest.mock('@/lib/export', () => ({ downloadCsv: (...a: unknown[]) => mockDownloadCsv(...a) }));
jest.mock('next/link', () => ({ __esModule: true, default: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

const row = (over: Partial<TeamCallsRow>): TeamCallsRow => ({
  id: 'x', name: 'X', calls: 0, given: 0, answered: 0, talkSecs: 0, warm: 0, hot: 0, won: 0, lost: 0, noOutcome: 0, target: null,
  ...over,
});
const ANN = row({ id: 'ann', name: 'Ann', calls: 40, given: 30, answered: 20, warm: 9, hot: 3, won: 2, talkSecs: 900, target: 50, noOutcome: 4 });
const BOB = row({ id: 'bob', name: 'Bob', calls: 10, given: 10, answered: 8, warm: 5, hot: 1, won: 0, talkSecs: 300, target: null });
const CY = row({ id: 'cy', name: 'Cy', calls: 25, given: 20, answered: 10, warm: 2, won: 4, talkSecs: 1200, target: 20 });

describe('teamRates', () => {
  it('measures each rate against its own base', () => {
    expect(teamRates(ANN)).toEqual({ answeredPct: 50, warmHotPct: 40, targetPct: 80 });
    expect(teamRates(BOB).targetPct).toBeNull();
    expect(teamRates(row({})).answeredPct).toBe(0);
  });
});

describe('sortTeam', () => {
  it('sorts on any column, either way, names breaking ties', () => {
    const rows = [BOB, ANN, CY];
    expect(sortTeam(rows, { key: 'calls', dir: 'desc' }).map((r) => r.id)).toEqual(['ann', 'cy', 'bob']);
    expect(sortTeam(rows, { key: 'answered', dir: 'desc' }).map((r) => r.id)).toEqual(['bob', 'ann', 'cy']);
    expect(sortTeam(rows, { key: 'name', dir: 'asc' }).map((r) => r.id)).toEqual(['ann', 'bob', 'cy']);
  });

  it('puts a rep with no target below every target, whichever way', () => {
    expect(sortTeam([BOB, ANN, CY], { key: 'target', dir: 'desc' }).map((r) => r.id)).toEqual(['cy', 'ann', 'bob']);
  });
});

describe('CallsTeam', () => {
  const setUserId = jest.fn();
  function renderTeam(userId = '') {
    try {
      localStorage.clear();
    } catch {
      /* no storage in this environment */
    }
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(['calls-made', 'team', { from: '2026-11-16', to: '2026-11-20' }], [ANN, BOB, CY]);
    const filters = {
      params: { from: '2026-11-16', to: '2026-11-20', ...(userId ? { userId } : {}) },
      userId,
      setUserId,
      dateFilter: { mode: 'week', from: '2026-11-16', to: '2026-11-20' },
    } as never;
    return render(
      <QueryClientProvider client={qc}>
        <CallsTeam filters={filters} />
      </QueryClientProvider>,
    );
  }
  beforeEach(() => {
    setUserId.mockClear();
    mockDownloadCsv.mockClear();
  });

  it('lists every rep, busiest first, with a team total', () => {
    const { container } = renderTeam();
    const names = Array.from(container.querySelectorAll('tbody tr td:first-child button')).map((b) => b.textContent);
    expect(names).toEqual(['Ann', 'Cy', 'Bob']);
    const total = container.querySelector('tfoot tr') as HTMLElement;
    expect(within(total).getByText('75')).toBeTruthy();
    // Target %: only reps with a target count — (40 + 25) of (50 + 20), not 75 of 70.
    expect(within(total).getByText('93%')).toBeTruthy();
  });

  it('reads the page for a rep on a click on their name', () => {
    renderTeam();
    fireEvent.click(screen.getByRole('button', { name: 'Ann' }));
    expect(setUserId).toHaveBeenLastCalledWith('ann');
  });

  it('marks the rep the page is on, and a click on them goes back to the team', () => {
    // The team list is the same whoever is selected — it is keyed without the rep.
    renderTeam('cy');
    const cy = screen.getByRole('button', { name: 'Cy' });
    expect(cy.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(cy);
    expect(setUserId).toHaveBeenLastCalledWith('');
  });

  it('sorts when a heading is clicked', () => {
    const { container } = renderTeam();
    fireEvent.click(screen.getByRole('button', { name: /^Answered/ }));
    const names = Array.from(container.querySelectorAll('tbody tr td:first-child button')).map((b) => b.textContent);
    expect(names).toEqual(['Bob', 'Ann', 'Cy']);
  });

  it('exports the table as shown', () => {
    renderTeam();
    fireEvent.click(screen.getByRole('button', { name: 'Export team CSV' }));
    const [name, headers, rows] = mockDownloadCsv.mock.calls[0] as [string, string[], unknown[][]];
    expect(name).toBe('calls-team-2026-11-16_2026-11-20');
    expect(headers[0]).toBe('Rep');
    expect(rows[0]).toEqual(['Ann', 40, 20, 50, 30, 9, 3, 40, 2, 0, '900s', 50, 80, 4]);
    expect(rows[2][11]).toBe(''); // Bob: no target
  });
});

/** Below 1280px each rep is a card: every figure stays in view, nothing scrolls off to the side. */
describe('CallsTeam on a narrow screen', () => {
  const setUserId = jest.fn();
  let restore: (() => void) | undefined;
  beforeEach(() => {
    const original = window.matchMedia;
    // Narrower than 1280px: the (min-width: 1280px) query doesn't match.
    window.matchMedia = ((query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    restore = () => { window.matchMedia = original; };
    setUserId.mockClear();
  });
  afterEach(() => restore?.());

  function renderNarrow() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(['calls-made', 'team', { from: '2026-11-16', to: '2026-11-20' }], [ANN, BOB, CY]);
    const filters = {
      params: { from: '2026-11-16', to: '2026-11-20' }, userId: '', setUserId,
      dateFilter: { mode: 'week', from: '2026-11-16', to: '2026-11-20' },
    } as never;
    return render(
      <QueryClientProvider client={qc}>
        <CallsTeam filters={filters} />
      </QueryClientProvider>,
    );
  }

  it('shows a card per rep, busiest first, with every figure and no table', () => {
    const { container } = renderNarrow();
    expect(container.querySelector('table')).toBeNull();
    const cards = Array.from(container.querySelectorAll('li'));
    expect(cards.map((li) => li.querySelector('button')?.textContent)).toEqual(['Ann', 'Cy', 'Bob']);
    const ann = within(cards[0]);
    for (const label of ['Answered', 'Warm & hot', 'Won', 'Talk time', 'Target', 'No outcome']) expect(ann.getByText(label)).toBeTruthy();
    expect(ann.getByText('80%')).toBeTruthy(); // Ann's target
  });

  it('sorts with the picker and flips with the arrow', () => {
    const { container } = renderNarrow();
    fireEvent.change(screen.getByLabelText('Sort by'), { target: { value: 'answered' } });
    const names = () => Array.from(container.querySelectorAll('li > div button')).map((b) => b.textContent);
    expect(names()).toEqual(['Bob', 'Ann', 'Cy']);
    fireEvent.click(screen.getByRole('button', { name: /switch to ascending/ }));
    expect(names()).toEqual(['Cy', 'Ann', 'Bob']);
  });

  it('reads the page for a rep from their card', () => {
    renderNarrow();
    fireEvent.click(screen.getByRole('button', { name: 'Cy' }));
    expect(setUserId).toHaveBeenLastCalledWith('cy');
  });
});

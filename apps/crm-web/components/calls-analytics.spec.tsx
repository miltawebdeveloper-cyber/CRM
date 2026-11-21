/** @jest-environment jsdom */
import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import type { CallsMadeStats } from '@/lib/crm';
import type { DateFilterValue } from '@/lib/date-filters';
import { quickRange } from '@/lib/quick-ranges';
import { businessTodayLocal } from '@/lib/business-day';
import { CallsAnalytics } from './calls-analytics';

beforeAll(() => {
  // recharts' ResponsiveContainer measures its box; jsdom has no layout.
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

// The pivot chart above has its own concerns; this is about the cards, the
// outcome mix and the breakdown. The filter bar is a plain wrapper, and the
// date filter is whatever the test sets.
let mockDateFilter: DateFilterValue = { mode: 'all', from: '', to: '' };
const mockSetDateFilter = jest.fn();
jest.mock('@/components/calls-aspects', () => ({ CallsAspects: () => null }));
// The trend and team table have their own tests; here, only whether they show.
jest.mock('@/components/calls-trend', () => ({ CallsTrend: () => <div data-testid="trend" /> }));
jest.mock('@/components/calls-team', () => ({ CallsTeam: () => <div data-testid="team" /> }));
const mockDownloadCsv = jest.fn();
jest.mock('@/lib/export', () => ({ downloadCsv: (...a: unknown[]) => mockDownloadCsv(...a) }));
jest.mock('@/components/calls-shared', () => {
  const actual = jest.requireActual('@/components/calls-shared') as Record<string, unknown>;
  return {
    ...actual,
    CallFilterBar: ({ children }: { children?: React.ReactNode }) => <div data-testid="filter-bar">{children}</div>,
    useCallFilters: () => ({
      params: {},
      dateFilter: mockDateFilter,
      setDateFilter: (v: unknown) => mockSetDateFilter(v),
      userId: '',
      users: [],
      userOpts: [],
      isManager: true,
    }),
  };
});
jest.mock('@/lib/crm', () => ({ callsApi: {}, formatDuration: (s: number) => `${s}s` }));

/** 20 calls with an outcome out of 25: 8 cold, 5 warm, 2 hot, 3 follow-ups, 1 won, 1 lost. */
const STATS = {
  total: 25,
  given: 20,
  connected: 12,
  connectedPct: 48,
  totalDurationSecs: 600,
  avgDurationSecs: 24,
  noOutcome: 5,
  byStatus: [{ slug: 'no_answer', name: 'No Answer', color: null, category: 'cold', count: 8 }],
  categories: { cold: 8, warm: 5, hot: 2, connected: 3, closedPositive: 1, closedNegative: 1 },
  ratios: { callsMade: 60, warm: 25, hot: 10, connected: 15, closedPositive: 5, closedNegative: 5 },
  coldPct: 40,
  target: null,
} as unknown as CallsMadeStats;

function renderAnalytics(stats: CallsMadeStats = STATS, { onDrill, before, isManager = true }: { onDrill?: (o: string) => void; before?: { key: unknown; stats: CallsMadeStats }; isManager?: boolean } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['calls-made', 'stats', {}], stats);
  if (before) qc.setQueryData(['calls-made', 'stats', before.key], before.stats);
  qc.setQueryData(['lead-book', ''], { assigned: 10, contacted: 4, balance: 6, closed: 2 });
  const { container } = render(
    <QueryClientProvider client={qc}>
      <CallsAnalytics isManager={isManager} onDrill={onDrill} />
    </QueryClientProvider>,
  );
  return container;
}

const strip = (container: HTMLElement) => container.querySelector('.sticky') as HTMLElement;
const columnTitles = (container: HTMLElement) => Array.from(container.querySelectorAll('h4')).map((h) => h.textContent);

beforeEach(() => {
  mockDateFilter = { mode: 'all', from: '', to: '' };
  mockSetDateFilter.mockClear();
});

describe('CallsAnalytics', () => {
  it('labels the first ratio as the reach rate, and lists them in funnel order', () => {
    renderAnalytics();
    const card = screen.getByText('Conversion Ratios').closest('div')!;
    const labels = Array.from(card.querySelectorAll('.w-\\[150px\\]')).map((n) => n.textContent);
    expect(labels).toEqual(['Reached', 'Warm', 'Hot', 'Connected / Follow-ups', 'Closed — Won', 'Closed — Lost']);
    expect(within(card).queryByText('Calls made')).toBeNull();
    expect(within(card).getByText('60%')).toBeTruthy();
  });

  it('counts calls, not leads, and shows every outcome group so they add up to the total', () => {
    const s = strip(renderAnalytics());
    expect(within(s).getByText('Calls with an outcome')).toBeTruthy();
    expect(within(s).getByText('of 25 calls')).toBeTruthy();
    // Connected / Follow-ups was missing, so the groups never added up to 20.
    expect(within(s).getByText('Connected / Follow-ups')).toBeTruthy();
    expect(within(s).getByText('15% of calls')).toBeTruthy();
    expect(within(s).getByText('1 won · 1 lost')).toBeTruthy();
    expect(s.textContent).not.toContain('of leads');
  });

  it('draws the mix as one segmented bar, not a chain of arrows', () => {
    const s = strip(renderAnalytics());
    expect(s.textContent).not.toContain('→');
    const segments = s.querySelectorAll('[aria-hidden] > span[title]');
    expect(Array.from(segments).map((x) => x.getAttribute('title'))).toEqual([
      'Cold: 8 · 40%',
      'Warm: 5 · 25%',
      'Hot: 2 · 10%',
      'Connected / Follow-ups: 3 · 15%',
      'Closed: 2 · 10%',
    ]);
  });

  it('shows each number once: no ring, no column repeating every status', () => {
    const container = renderAnalytics();
    expect(screen.queryByText('Pipeline Mix')).toBeNull();
    expect(columnTitles(container)).toEqual(['Cold', 'Warm', 'Hot', 'Connected / Follow-ups', 'Closed']);
  });

  it('gives outcomes with no group their own tile and column, so nothing drops out of the total', () => {
    const stats = {
      ...STATS,
      given: 22,
      byStatus: [{ slug: 'custom', name: 'Left message', color: null, category: null, count: 2 }],
    } as unknown as CallsMadeStats;
    const container = renderAnalytics(stats);
    expect(within(strip(container)).getByText('No group')).toBeTruthy();
    expect(columnTitles(container)).toContain('No group');
    expect(screen.getByText('Give these a group in Admin → Outcomes so they count in one.')).toBeTruthy();
  });

  it('shows the lead book in the dashboard’s terms', () => {
    renderAnalytics();
    expect(screen.getByText('Contacted')).toBeTruthy();
    expect(screen.getByText('Not contacted yet')).toBeTruthy();
    expect(screen.getByText('Closed · won or lost')).toBeTruthy();
    expect(screen.queryByText('Completed')).toBeNull();
    expect(screen.getByText('40.0%')).toBeTruthy(); // 4 of 10 contacted
  });

  it('sets a quick range in one click', () => {
    renderAnalytics();
    const chips = within(screen.getByTestId('filter-bar')).getByRole('group', { name: 'Quick date range' });
    fireEvent.click(within(chips).getByRole('button', { name: 'This week' }));
    expect(mockSetDateFilter).toHaveBeenLastCalledWith(quickRange('week', businessTodayLocal()));
  });

  it('marks the quick range in force, and clicking it again goes back to all dates', () => {
    mockDateFilter = quickRange('today', businessTodayLocal());
    renderAnalytics();
    const today = within(screen.getByTestId('filter-bar')).getByRole('button', { name: 'Today' });
    expect(today.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(today);
    expect(mockSetDateFilter).toHaveBeenLastCalledWith({ mode: 'all', from: '', to: '' });
  });

  it('says once that a range has no calls, instead of a page of zeroes', () => {
    mockDateFilter = quickRange('today', businessTodayLocal());
    renderAnalytics({ ...STATS, total: 0, given: 0 } as CallsMadeStats);
    expect(screen.getByText('No calls today')).toBeTruthy();
    expect(screen.queryByText('Conversion Ratios')).toBeNull();
    expect(columnTitles(document.body)).toEqual([]);
    // The lead book still shows — it counts leads held now, not calls.
    expect(screen.getByText('Contacted')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show all dates' }));
    expect(mockSetDateFilter).toHaveBeenLastCalledWith({ mode: 'all', from: '', to: '' });
  });

  it('with all dates and no calls at all, says there are none yet', () => {
    renderAnalytics({ ...STATS, total: 0, given: 0 } as CallsMadeStats);
    expect(screen.getByText('No calls yet')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show all dates' })).toBeNull();
  });

  it('uses theme colours for the dark tiles, so they show in dark mode', () => {
    const container = renderAnalytics();
    expect(container.innerHTML).not.toContain('#27301d');
    expect(container.innerHTML).not.toContain('#9aa08e');
  });
});

describe('CallsAnalytics — headline, drill-down and export', () => {
  const headline = () => screen.getByText('Calls with no outcome').closest('.grid') as HTMLElement;

  it('leads with the range at a glance', () => {
    renderAnalytics();
    const row = headline();
    expect(within(row).getByText('25')).toBeTruthy();
    expect(within(row).getByText('48%')).toBeTruthy();
    expect(within(row).getByText('Answered · 12 calls')).toBeTruthy();
    expect(within(row).getByText('600s')).toBeTruthy();
    expect(within(row).getByText('5')).toBeTruthy();
  });

  it('compares with the period just before, the same length, when the range is closed', () => {
    mockDateFilter = { mode: 'custom', from: '2026-11-15', to: '2026-11-21' };
    renderAnalytics(STATS, {
      before: { key: { from: '2026-11-08', to: '2026-11-14' }, stats: { ...STATS, total: 20, connectedPct: 40, noOutcome: 10 } as CallsMadeStats },
    });
    const row = headline();
    // Calls 25 vs 20: up 25%. Answered 48% vs 40%: up 8 points. No outcome 5 vs 10: down, and that's better.
    expect(within(row).getByTitle('up 25% — 25 vs 20 in the previous 7 days')).toBeTruthy();
    expect(within(row).getByTitle('up 8 pts — 48% vs 40% in the previous 7 days')).toBeTruthy();
    const fewer = within(row).getByTitle('down 50% — 5 vs 10 in the previous 7 days');
    expect(fewer.className).toContain('teal');
  });

  it('shows no ▲/▼ over all dates — there is no period before it', () => {
    renderAnalytics();
    expect(headline().textContent).not.toMatch(/[▲▼]/);
  });

  it('opens the calls behind a number in Calls Made', () => {
    const onDrill = jest.fn();
    const container = renderAnalytics(STATS, { onDrill });
    fireEvent.click(screen.getByText('Calls with no outcome').closest('button')!);
    expect(onDrill).toHaveBeenLastCalledWith('none');
    fireEvent.click(within(strip(container)).getByText('Cold').closest('button')!);
    expect(onDrill).toHaveBeenLastCalledWith('bucket:cold');
    fireEvent.click(within(strip(container)).getByText('Connected / Follow-ups').closest('button')!);
    expect(onDrill).toHaveBeenLastCalledWith('bucket:connected');
    fireEvent.click(screen.getByText('No Answer').closest('button')!);
    expect(onDrill).toHaveBeenLastCalledWith('no_answer');
  });

  it('leaves a zero as plain text — there is nothing to open', () => {
    const onDrill = jest.fn();
    renderAnalytics({ ...STATS, noOutcome: 0 } as CallsMadeStats, { onDrill });
    expect(screen.getByText('Calls with no outcome').closest('button')).toBeNull();
  });

  it('shows the trend to everyone and the team comparison to managers only', () => {
    renderAnalytics();
    expect(screen.getByTestId('trend')).toBeTruthy();
    expect(screen.getByTestId('team')).toBeTruthy();
  });

  it('hides the team comparison from an employee', () => {
    renderAnalytics(STATS, { isManager: false });
    expect(screen.queryByTestId('team')).toBeNull();
  });

  it('exports the breakdown: every status with its group and share, then the totals', () => {
    mockDownloadCsv.mockClear();
    renderAnalytics();
    fireEvent.click(screen.getByRole('button', { name: 'Export breakdown CSV' }));
    const [name, headers, rows] = mockDownloadCsv.mock.calls[0] as [string, string[], unknown[][]];
    expect(name).toBe('calls-analytics-all-dates');
    expect(headers).toEqual(['Group', 'Outcome', 'Calls', 'Share of calls with an outcome %']);
    expect(rows[0]).toEqual(['Cold', 'No Answer', 8, 40]);
    expect(rows.slice(-3)).toEqual([
      ['', 'Calls with an outcome', 20, ''],
      ['', 'Calls with no outcome', 5, ''],
      ['', 'All calls', 25, ''],
    ]);
  });
});

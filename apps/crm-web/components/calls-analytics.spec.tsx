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

// The explorer, trend and team table have their own tests; here, only whether
// they show. The filter bar is a plain wrapper, the date filter what the test sets.
let mockDateFilter: DateFilterValue = { mode: 'all', from: '', to: '' };
const mockSetDateFilter = jest.fn();
jest.mock('@/components/calls-aspects', () => ({ CallsAspects: () => <div data-testid="explore" /> }));
jest.mock('@/components/calls-trend', () => ({ CallsTrend: () => <div data-testid="trend" /> }));
jest.mock('@/components/calls-team', () => ({ CallsTeam: () => <div data-testid="team" /> }));
const mockDownloadCsv = jest.fn();
jest.mock('@/lib/export', () => ({ downloadCsv: (...a: unknown[]) => mockDownloadCsv(...a) }));
jest.mock('@/components/calls-shared', () => ({
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
}));
jest.mock('@/lib/crm', () => ({ callsApi: {}, formatDuration: (s: number) => `${s}s` }));

/** 20 calls with an outcome out of 25: 8 cold, 5 warm, 2 hot, 3 follow-ups, 1 won, 1 lost. */
const STATS = {
  total: 25,
  outgoing: 22,
  incoming: 3,
  given: 20,
  connected: 12,
  connectedPct: 48,
  totalDurationSecs: 600,
  avgDurationSecs: 24,
  noOutcome: 5,
  byStatus: [
    { slug: 'no_answer', name: 'No Answer', color: null, category: 'cold', count: 8 },
    { slug: 'call_back', name: 'Call Back', color: null, category: 'warm', count: 5 },
    { slug: 'negotiation', name: 'Negotiation', color: null, category: 'hot', count: 2 },
    { slug: 'follow_up_1', name: 'Follow-up 1', color: null, category: 'connected', count: 3 },
    { slug: 'closed_won', name: 'Closed-Won', color: null, category: 'closed_positive', count: 1 },
    { slug: 'closed_lost', name: 'Closed-Lost', color: null, category: 'closed_negative', count: 1 },
  ],
  categories: { cold: 8, warm: 5, hot: 2, connected: 3, closedPositive: 1, closedNegative: 1 },
  ratios: { callsMade: 60, warm: 25, hot: 10, connected: 15, closedPositive: 5, closedNegative: 5 },
  coldPct: 40,
  target: null,
} as unknown as CallsMadeStats;

function renderAnalytics(
  stats: CallsMadeStats = STATS,
  { onDrill, before, isManager = true }: { onDrill?: (o: string) => void; before?: { key: unknown; stats: CallsMadeStats }; isManager?: boolean } = {},
) {
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

const panel = (name: string) => screen.getByRole('region', { name });
const overview = () => screen.getByLabelText('Overview');
const groupTitles = () => Array.from(panel('Outcomes in detail').querySelectorAll('h4')).map((h) => h.textContent);

beforeEach(() => {
  mockDateFilter = { mode: 'all', from: '', to: '' };
  mockSetDateFilter.mockClear();
  mockDownloadCsv.mockClear();
});

describe('CallsAnalytics — the outcome mix', () => {
  it('leads with the reach rate, named for what it is', () => {
    renderAnalytics();
    const mix = panel('Outcome mix');
    expect(within(mix).getByText('Reached')).toBeTruthy();
    expect(within(mix).getByText('60%')).toBeTruthy();
    expect(within(mix).queryByText(/Calls made/)).toBeNull();
  });

  it('counts calls, not leads, and lists every group in funnel order so they add up to the total', () => {
    renderAnalytics();
    const mix = panel('Outcome mix');
    expect(within(mix).getByText('20 of 25 calls have an outcome')).toBeTruthy();
    const rows = Array.from(mix.querySelectorAll('li')).map((li) => li.textContent);
    expect(rows).toEqual([
      'Cold840%',
      'Warm525%',
      'Hot210%',
      'Connected / Follow-ups315%',
      'Closed · 1 won · 1 lost210%',
    ]);
    expect(mix.textContent).not.toContain('of leads');
  });

  it('draws the split as one segmented bar, not a chain of arrows', () => {
    renderAnalytics();
    const mix = panel('Outcome mix');
    expect(mix.textContent).not.toContain('→');
    const segments = Array.from(mix.querySelectorAll('[aria-hidden] > span[title]')).map((s) => s.getAttribute('title'));
    expect(segments).toEqual(['Cold: 8 · 40%', 'Warm: 5 · 25%', 'Hot: 2 · 10%', 'Connected / Follow-ups: 3 · 15%', 'Closed: 2 · 10%']);
  });

  it('shows the split once: no ratio card, no tile strip, no ring', () => {
    renderAnalytics();
    expect(screen.queryByText('Conversion Ratios')).toBeNull();
    expect(screen.queryByText('Pipeline Mix')).toBeNull();
    expect(screen.queryAllByText('Reached')).toHaveLength(1);
  });

  it('gives outcomes with no group their own line and block, so nothing drops out of the total', () => {
    renderAnalytics({
      ...STATS,
      given: 22,
      byStatus: [...(STATS.byStatus as unknown[]), { slug: 'custom', name: 'Left message', color: null, category: null, count: 2 }],
    } as unknown as CallsMadeStats);
    expect(within(panel('Outcome mix')).getByText('No group')).toBeTruthy();
    expect(groupTitles()).toContain('No group');
    expect(screen.getByText('Give these a group in Admin → Outcomes so they count in one.')).toBeTruthy();
  });
});

describe('CallsAnalytics — overview, detail and lead book', () => {
  it('leads with the range at a glance', () => {
    renderAnalytics();
    const band = overview();
    expect(within(band).getByText('25')).toBeTruthy();
    expect(within(band).getByText('22 out · 3 in')).toBeTruthy();
    expect(within(band).getByText('48%')).toBeTruthy();
    expect(within(band).getByText('12 of 25 calls')).toBeTruthy();
    expect(within(band).getByText('600s')).toBeTruthy();
    expect(within(band).getByText('5')).toBeTruthy();
  });

  it('compares with the period just before, the same length, when the range is closed', () => {
    mockDateFilter = { mode: 'custom', from: '2026-11-15', to: '2026-11-21' };
    renderAnalytics(STATS, {
      before: { key: { from: '2026-11-08', to: '2026-11-14' }, stats: { ...STATS, total: 20, connectedPct: 40, noOutcome: 10 } as CallsMadeStats },
    });
    const band = overview();
    expect(within(band).getByTitle('up 25% — 25 vs 20 in the previous 7 days')).toBeTruthy();
    expect(within(band).getByTitle('up 8 pts — 48% vs 40% in the previous 7 days')).toBeTruthy();
    // Fewer calls without an outcome is better, so it's teal though it went down.
    expect(within(band).getByTitle('down 50% — 5 vs 10 in the previous 7 days').className).toContain('teal');
  });

  it('shows no ▲/▼ over all dates — there is no period before it', () => {
    renderAnalytics();
    expect(overview().textContent).not.toMatch(/[▲▼]/);
  });

  it('lists every status by group, one block each', () => {
    renderAnalytics();
    expect(groupTitles()).toEqual(['Cold', 'Warm', 'Hot', 'Connected / Follow-ups', 'Closed']);
  });

  it('shows the lead book in the dashboard’s terms', () => {
    renderAnalytics();
    const book = panel('Lead book');
    expect(within(book).getByText('Contacted')).toBeTruthy();
    expect(within(book).getByText('Not contacted yet')).toBeTruthy();
    expect(within(book).getByText('Closed · won or lost')).toBeTruthy();
    expect(within(book).getByText('40.0%')).toBeTruthy(); // 4 of 10 contacted
    expect(screen.queryByText('Completed')).toBeNull();
  });

  it('shows the trend and the explorer to everyone, the team to managers', () => {
    renderAnalytics();
    expect(screen.getByTestId('trend')).toBeTruthy();
    expect(screen.getByTestId('explore')).toBeTruthy();
    expect(screen.getByTestId('team')).toBeTruthy();
  });

  it('hides the team comparison from an employee', () => {
    renderAnalytics(STATS, { isManager: false });
    expect(screen.queryByTestId('team')).toBeNull();
  });

  it('gives a single day the mix, the book and the target side by side, and no trend', () => {
    mockDateFilter = quickRange('today', businessTodayLocal());
    renderAnalytics();
    expect(screen.queryByTestId('trend')).toBeNull();
    expect(panel('Outcome mix')).toBeTruthy();
    expect(panel('Call target')).toBeTruthy();
  });

  it('uses theme colours only, so dark mode reads as well as light', () => {
    const container = renderAnalytics();
    for (const fixed of ['#27301d', '#9aa08e', '#e4e9fb', '#fbf0dc', '#fdeae9', '#e0f1f3', '#e0f2e9']) {
      expect(container.innerHTML).not.toContain(fixed);
    }
  });
});

describe('CallsAnalytics — ranges, drill-down and export', () => {
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

  it('opens the calls behind a number in Calls Made', () => {
    const onDrill = jest.fn();
    renderAnalytics(STATS, { onDrill });
    fireEvent.click(within(overview()).getByText('No outcome').closest('button')!);
    expect(onDrill).toHaveBeenLastCalledWith('none');
    fireEvent.click(within(panel('Outcome mix')).getByText('Cold').closest('button')!);
    expect(onDrill).toHaveBeenLastCalledWith('bucket:cold');
    fireEvent.click(within(panel('Outcome mix')).getByText('Connected / Follow-ups').closest('button')!);
    expect(onDrill).toHaveBeenLastCalledWith('bucket:connected');
    fireEvent.click(within(panel('Outcomes in detail')).getByText('No Answer').closest('button')!);
    expect(onDrill).toHaveBeenLastCalledWith('no_answer');
  });

  it('leaves a zero as plain text — there is nothing to open', () => {
    const onDrill = jest.fn();
    renderAnalytics({ ...STATS, noOutcome: 0 } as CallsMadeStats, { onDrill });
    expect(within(overview()).getByText('No outcome').closest('button')).toBeNull();
    expect(within(overview()).getByText('Every call has an outcome')).toBeTruthy();
  });

  it('exports the detail: every status with its group and share, then the totals', () => {
    renderAnalytics();
    fireEvent.click(screen.getByRole('button', { name: 'Export breakdown CSV' }));
    const [name, headers, rows] = mockDownloadCsv.mock.calls[0] as [string, string[], unknown[][]];
    expect(name).toBe('calls-analytics-all-dates');
    expect(headers).toEqual(['Group', 'Outcome', 'Calls', 'Share of calls with an outcome %']);
    expect(rows[0]).toEqual(['Cold', 'No Answer', 8, 40]);
    expect(rows[4]).toEqual(['Closed', 'Closed-Won', 1, 5]);
    expect(rows.slice(-3)).toEqual([
      ['', 'Calls with an outcome', 20, ''],
      ['', 'Calls with no outcome', 5, ''],
      ['', 'All calls', 25, ''],
    ]);
  });

  it('says once that a range has no calls, instead of a page of zeroes', () => {
    mockDateFilter = quickRange('today', businessTodayLocal());
    renderAnalytics({ ...STATS, total: 0, given: 0 } as CallsMadeStats);
    expect(screen.getByText('No calls today')).toBeTruthy();
    expect(screen.queryByLabelText('Overview')).toBeNull();
    // The lead book still shows — it counts leads held now, not calls.
    expect(panel('Lead book')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show all dates' }));
    expect(mockSetDateFilter).toHaveBeenLastCalledWith({ mode: 'all', from: '', to: '' });
  });

  it('with all dates and no calls at all, says there are none yet', () => {
    renderAnalytics({ ...STATS, total: 0, given: 0 } as CallsMadeStats);
    expect(screen.getByText('No calls yet')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show all dates' })).toBeNull();
  });
});

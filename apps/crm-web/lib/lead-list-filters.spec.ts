import { describe, expect, it } from '@jest/globals';
import {
  DEFAULT_LEAD_LIST_FILTERS as D,
  activeFilterCount,
  clearedFilters,
  filtersFromParams,
  filtersToParams,
  leadListHref,
  normaliseFilters,
  type LeadListFilters,
} from './lead-list-filters';

const f = (patch: Partial<LeadListFilters>): LeadListFilters => ({ ...D, ...patch });

describe('lead list filters ↔ URL', () => {
  it('leaves an unfiltered list with a clean address', () => {
    expect(filtersToParams(D).toString()).toBe('');
  });

  it('round-trips every filter through the URL', () => {
    const view = f({
      q: 'acme',
      country: 'US',
      tz: 'CST',
      state: 'TX',
      city: 'Austin',
      employeeId: 'u-1',
      ownership: 'unassigned',
      contact: 'never',
      followUp: 'overdue',
      outcomes: ['no_answer', 'busy'],
      dateField: 'scheduled',
      dateFilter: { mode: 'custom', from: '2026-11-01', to: '2026-11-19' },
      sort: { key: 'businessName', dir: 'desc' },
    });
    expect(filtersFromParams(filtersToParams(view))).toEqual(view);
  });

  it('reads a URL with no filter parameters as "no link", not as "clear everything"', () => {
    expect(filtersFromParams(new URLSearchParams('leadId=abc'))).toBeNull();
  });

  it('fills what a link leaves out with defaults, not with whatever was saved', () => {
    const got = filtersFromParams(new URLSearchParams('state=TX'));
    expect(got).toEqual(f({ state: 'TX' }));
  });

  it('drops values the API would refuse instead of passing them on', () => {
    const got = filtersFromParams(new URLSearchParams('date=fortnight&on=yesterday&sort=phone&state=TX'))!;
    expect(got.dateFilter).toEqual(D.dateFilter);
    expect(got.dateField).toBe('created');
    expect(got.sort).toEqual(D.sort);
    expect(got.state).toBe('TX');
  });
});

describe('activeFilterCount / clearedFilters', () => {
  it('counts what narrows the list, not the sort or the date field', () => {
    expect(activeFilterCount(f({ sort: { key: 'phone', dir: 'desc' }, dateField: 'scheduled' }))).toBe(0);
    expect(activeFilterCount(f({ state: 'TX', city: 'Austin', dateFilter: { mode: 'day', from: '2026-11-19', to: '2026-11-19' } }))).toBe(3);
  });

  it('ignores a blank search', () => {
    expect(activeFilterCount(f({ q: '   ' }))).toBe(0);
  });

  it("doesn't count the admin-only employee filter for someone who can't see it", () => {
    expect(activeFilterCount(f({ employeeId: 'u-1' }))).toBe(0);
    expect(activeFilterCount(f({ employeeId: 'u-1' }), { employee: true })).toBe(1);
  });

  it('clears every filter but keeps the sort and the date field', () => {
    const view = f({ state: 'TX', q: 'acme', sort: { key: 'phone', dir: 'desc' }, dateField: 'scheduled' });
    expect(clearedFilters(view)).toEqual(f({ sort: { key: 'phone', dir: 'desc' }, dateField: 'scheduled' }));
  });
});

/**
 * Status used to be one dropdown (Assigned / Unassigned / Contacted) and Call
 * Outcome a single pick. Views saved, and links made, before the split must
 * still open the list they named.
 */
describe('views from before Status was split', () => {
  // What was actually saved before the split: the old keys, none of the new ones.
  const { ownership: _o, contact: _c, followUp: _f, outcomes: _out, ...OLD_BASE } = D;

  it('reads a saved view in the old shape', () => {
    expect(normaliseFilters({ ...OLD_BASE, status: 'unassigned', callStatus: 'call_back' })).toMatchObject({
      ownership: 'unassigned',
      contact: '',
      outcomes: ['call_back'],
    });
    expect(normaliseFilters({ ...OLD_BASE, status: 'contacted' })).toMatchObject({ ownership: '', contact: 'contacted' });
  });

  it('lets the new fields win when a saved view somehow has both', () => {
    expect(normaliseFilters({ ...D, status: 'unassigned', ownership: 'assigned' }).ownership).toBe('assigned');
  });

  it('reads an old link', () => {
    expect(filtersFromParams(new URLSearchParams('status=assigned&outcome=busy'))).toMatchObject({
      ownership: 'assigned',
      outcomes: ['busy'],
    });
  });

  it('drops a closed-list value that is not one of its options', () => {
    expect(normaliseFilters({ ...D, followUp: 'tomorrow' }).followUp).toBe('');
    expect(filtersFromParams(new URLSearchParams('owner=everyone&state=TX'))!.ownership).toBe('');
  });

  it('counts the outcome picks as one filter however many are ticked', () => {
    expect(activeFilterCount(f({ outcomes: ['no_answer', 'busy', 'voicemail'] }))).toBe(1);
    expect(activeFilterCount(f({ contact: 'never', followUp: 'today' }))).toBe(2);
  });
});

/** Links into a lead list — what a dashboard card points at. */
describe('leadListHref', () => {
  it('names the filters it wants, everything else at its default', () => {
    expect(leadListHref('/leads', { contact: 'never' })).toBe('/leads?contact=never');
  });

  it('asks for the default view explicitly rather than leaving the reader’s saved filters in charge', () => {
    expect(leadListHref('/leads')).toBe('/leads?all=1');
    expect(filtersFromParams(new URLSearchParams('all=1'))).toEqual(D);
  });
});

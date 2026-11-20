import { describe, expect, it } from '@jest/globals';
import { DEFAULT_LEAD_LIST_FILTERS as D, type LeadListFilters } from './lead-list-filters';
import { MAX_SAVED_VIEWS, parseSavedViews, sameFilters, withSavedView, type SavedView } from './saved-views';

const f = (patch: Partial<LeadListFilters>): LeadListFilters => ({ ...D, ...patch });
let n = 0;
const id = () => `v${++n}`;

describe('saved views', () => {
  it('reads stored views defensively, dropping junk and filling old filter shapes', () => {
    const views = parseSavedViews([
      { id: 'a', name: ' Texas overdue ', filters: { state: 'TX', followUp: 'overdue' } },
      { id: 'b', name: '', filters: {} },
      null,
      'nonsense',
      // Saved before Status was split — still opens the view it named.
      { id: 'c', name: 'Old', filters: { status: 'unassigned' } },
    ]);
    expect(views.map((v) => v.name)).toEqual(['Texas overdue', 'Old']);
    expect(views[0].filters).toEqual(f({ state: 'TX', followUp: 'overdue' }));
    expect(views[1].filters.ownership).toBe('unassigned');
    expect(parseSavedViews({ not: 'an array' })).toEqual([]);
  });

  it('updates a view saved under the same name instead of making a twin', () => {
    const one = withSavedView([], 'Texas', f({ state: 'TX' }), id);
    const two = withSavedView(one, 'texas', f({ state: 'TX', city: 'Austin' }), id);
    expect(two).toHaveLength(1);
    expect(two[0].id).toBe(one[0].id);
    expect(two[0].filters.city).toBe('Austin');
  });

  it('keeps no more than the limit', () => {
    let views: SavedView[] = [];
    for (let i = 0; i < MAX_SAVED_VIEWS + 3; i++) views = withSavedView(views, `View ${i}`, D, id);
    expect(views).toHaveLength(MAX_SAVED_VIEWS);
  });

  it('recognises the view on screen whatever order its keys were stored in', () => {
    // Same view, keys in the opposite order — as a round trip through storage may leave them.
    const stored = Object.fromEntries(Object.entries(f({ q: 'acme' })).reverse()) as unknown as LeadListFilters;
    expect(sameFilters(stored, f({ q: 'acme' }))).toBe(true);
    expect(sameFilters(stored, f({ q: 'acme', city: 'Austin' }))).toBe(false);
  });
});

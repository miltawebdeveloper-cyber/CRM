import { describe, expect, it, jest, beforeEach } from '@jest/globals';

/**
 * What actually goes on the wire when the lead list is asked for.
 *
 * Two things here are easy to get wrong and impossible to see from the outside.
 *
 * `closed: false` is MEANINGFUL — it is what selects Lead Management over the
 * Onboarding module — so it cannot be dropped with the other falsy values, and
 * an off-by-one in that rule silently merges two modules' lists.
 *
 * The abort signal has to reach axios. React Query only cancels a superseded
 * request if the query function CONSUMED the signal; pass it and forget to
 * forward it, and every filter change leaves its request running to completion
 * with nobody to read the answer. Nothing about the UI looks different when this
 * breaks, which is why it is asserted here.
 */
const get = jest.fn(async (_url: string, _config?: unknown) => ({ data: { rows: [], total: 0, page: 1, pageSize: 50 } }));

jest.mock('./api', () => ({
  api: {
    get: (...args: unknown[]) => (get as unknown as (...a: unknown[]) => unknown)(...args),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));

// Imported after the mock is registered, so the module picks up the stub.
const { leadsApi } = require('./leads') as typeof import('./leads');

/** The params object the last request was built with. */
const sentParams = () => (get.mock.calls[0][1] as { params?: Record<string, unknown> } | undefined)?.params;
const sentConfig = () => get.mock.calls[0][1] as { params?: unknown; signal?: AbortSignal } | undefined;

describe('leadsApi.page', () => {
  beforeEach(() => {
    get.mockClear();
  });

  it('keeps `closed: false`, which is what selects Lead Management', () => {
    // The one falsy value that carries meaning. Dropped, the request asks for
    // "every lead in either module" and Onboarding rows appear in Lead
    // Management.
    void leadsApi.page({ closed: false });
    expect(sentParams()).toEqual({ closed: false });
  });

  it('keeps `closed: true` for the Onboarding module', () => {
    void leadsApi.page({ closed: true });
    expect(sentParams()).toEqual({ closed: true });
  });

  it('drops empty filters rather than sending them as blanks', () => {
    // An empty string is "no filter chosen". Sent, it becomes a filter for the
    // empty string and the list comes back with nothing in it.
    void leadsApi.page({ closed: false, q: '', state: '', timezone: 'EST' });
    expect(sentParams()).toEqual({ closed: false, timezone: 'EST' });
  });

  it('trims what the user typed', () => {
    void leadsApi.page({ closed: false, q: '  acme  ' });
    expect(sentParams()).toMatchObject({ q: 'acme' });
  });

  it('sends paging and sorting through to the API', () => {
    // Both are the SERVER's job — the grid holds one chunk, so a sort applied in
    // the browser would only order the rows already downloaded.
    void leadsApi.page({ closed: false, page: 3, pageSize: 50, sortBy: 'importSeq', sortDir: 'asc' });
    expect(sentParams()).toMatchObject({ page: 3, pageSize: 50, sortBy: 'importSeq', sortDir: 'asc' });
  });

  it('sends no params at all when there are none', () => {
    // `undefined` rather than `{}`, so the URL has no trailing `?`.
    void leadsApi.page();
    expect(sentConfig()?.params).toBeUndefined();
  });

  it('forwards the abort signal to axios', () => {
    // Without this the request cannot be cancelled, and React Query will not
    // even try — it only cancels when the query function consumed the signal.
    const controller = new AbortController();
    void leadsApi.page({ closed: false }, controller.signal);
    expect(sentConfig()?.signal).toBe(controller.signal);
  });

  it('works without a signal, for the callers that have none', () => {
    // The export path asks for the whole filtered set outside React Query.
    void leadsApi.page({ closed: false });
    expect(sentConfig()?.signal).toBeUndefined();
  });

  it('asks for /leads', () => {
    void leadsApi.page({ closed: false });
    expect(get.mock.calls[0][0]).toBe('/leads');
  });
});

describe('leadsApi.filterOptions', () => {
  beforeEach(() => {
    get.mockClear();
  });

  it('cascades the chosen zone and state, and forwards the signal', () => {
    // The menus narrow each other — states within a zone, cities within a state
    // — so both travel with the request.
    const controller = new AbortController();
    void leadsApi.filterOptions({ closed: false, timezone: 'EST', state: 'FL' }, controller.signal);
    expect(sentParams()).toEqual({ closed: false, timezone: 'EST', state: 'FL' });
    expect(sentConfig()?.signal).toBe(controller.signal);
  });
});

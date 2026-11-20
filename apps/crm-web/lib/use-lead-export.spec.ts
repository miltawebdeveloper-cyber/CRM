import { describe, expect, it, jest } from '@jest/globals';
import type { Lead, LeadListQuery, LeadPage } from './leads';
import { EXPORT_CHUNK, fetchAllLeads } from './use-lead-export';

const lead = (n: number) => ({ id: `l${n}` }) as Lead;
const range = (from: number, count: number) => Array.from({ length: count }, (_, i) => lead(from + i));

/** A fake API holding `book` leads, answering in chunks the way `GET /leads` does. */
function api(book: Lead[]) {
  return jest.fn(async (q: LeadListQuery, _signal?: AbortSignal): Promise<LeadPage> => {
    const size = q.limit!;
    const start = (q.page! - 1) * size;
    return { rows: book.slice(start, start + size), total: book.length, page: q.page!, pageSize: size };
  });
}

describe('fetchAllLeads — exports of any size', () => {
  it('reads the whole filtered list in chunks, past the old 5,000 ceiling', async () => {
    const fetchPage = api(range(1, EXPORT_CHUNK * 2 + 123));
    const progress: number[] = [];
    const rows = await fetchAllLeads({ closed: false, state: 'TX' }, (done) => progress.push(done), undefined, fetchPage);

    expect(rows).toHaveLength(EXPORT_CHUNK * 2 + 123);
    expect(fetchPage).toHaveBeenCalledTimes(3);
    // The list's own filters travel with every chunk; paging is by `limit`.
    expect(fetchPage.mock.calls[2][0]).toMatchObject({ state: 'TX', page: 3, limit: EXPORT_CHUNK, pageSize: undefined });
    expect(progress).toEqual([EXPORT_CHUNK, EXPORT_CHUNK * 2, EXPORT_CHUNK * 2 + 123]);
  });

  it('needs one request for a list under a chunk', async () => {
    const fetchPage = api(range(1, 40));
    expect(await fetchAllLeads({}, undefined, undefined, fetchPage)).toHaveLength(40);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('keeps each lead once if rows shift between chunks', async () => {
    // Chunk 2 starts with the last lead of chunk 1 — a lead removed ahead of it mid-export.
    const first = range(1, EXPORT_CHUNK);
    const fetchPage = jest.fn(async (q: LeadListQuery): Promise<LeadPage> =>
      q.page === 1
        ? { rows: first, total: EXPORT_CHUNK + 10, page: 1, pageSize: EXPORT_CHUNK }
        : { rows: [first[first.length - 1], ...range(EXPORT_CHUNK + 1, 9)], total: EXPORT_CHUNK + 10, page: 2, pageSize: EXPORT_CHUNK },
    );
    const rows = await fetchAllLeads({}, undefined, undefined, fetchPage);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    expect(rows).toHaveLength(EXPORT_CHUNK + 9);
  });

  it('stops at a short chunk even if the total said there was more', async () => {
    const fetchPage = jest.fn(async (): Promise<LeadPage> => ({ rows: range(1, 10), total: 50, page: 1, pageSize: EXPORT_CHUNK }));
    expect(await fetchAllLeads({}, undefined, undefined, fetchPage)).toHaveLength(10);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('passes the cancel signal to every request', async () => {
    const ctrl = new AbortController();
    const fetchPage = api(range(1, 3));
    await fetchAllLeads({}, undefined, ctrl.signal, fetchPage);
    expect(fetchPage.mock.calls[0][1]).toBe(ctrl.signal);
  });
});

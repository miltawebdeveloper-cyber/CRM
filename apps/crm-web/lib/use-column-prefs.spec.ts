import { describe, expect, it } from '@jest/globals';
import { mergeSavedOrder, resolveOrder } from './use-column-prefs';

/**
 * Reconciling a saved column layout with the columns that exist today.
 *
 * The rule this protects: what the user arranged is theirs and is never
 * rearranged, and what they have never seen is placed where the author declared
 * it. Getting the second half wrong is quiet — the column IS there, just off the
 * right-hand edge of a table wide enough to need a scrollbar, so it reads as a
 * missing feature rather than a misplaced column.
 */
describe('mergeSavedOrder', () => {
  it('leaves a saved layout exactly as it is when nothing has changed', () => {
    const declared = ['id', 'name', 'phone'];
    // Deliberately not the declared order: this is what the user dragged it to.
    expect(mergeSavedOrder(['phone', 'id', 'name'], declared)).toEqual(['phone', 'id', 'name']);
  });

  it('puts a new column where it was declared, not on the end', () => {
    // "created" was declared between "leadId" and "source". A user who has
    // customised this table should see it there, the same as everyone else.
    const declared = ['leadId', 'created', 'source', 'company'];
    expect(mergeSavedOrder(['leadId', 'source', 'company'], declared)).toEqual([
      'leadId',
      'created',
      'source',
      'company',
    ]);
  });

  it('places a new column relative to the neighbour the user actually has', () => {
    // The user moved "company" to the front and hid nothing. "created" is still
    // declared after "leadId", so it follows "leadId" wherever that now sits.
    const declared = ['leadId', 'created', 'source', 'company'];
    expect(mergeSavedOrder(['company', 'leadId', 'source'], declared)).toEqual([
      'company',
      'leadId',
      'created',
      'source',
    ]);
  });

  it('keeps a run of new columns in their declared sequence', () => {
    // Three added at once — they must arrive as a block in the order the author
    // wrote them, not reversed and not scattered.
    const declared = ['leadId', 'createdAt', 'scheduled', 'movement', 'source'];
    expect(mergeSavedOrder(['leadId', 'source'], declared)).toEqual([
      'leadId',
      'createdAt',
      'scheduled',
      'movement',
      'source',
    ]);
  });

  it('sends a column declared before everything to the front', () => {
    const declared = ['seq', 'leadId', 'name'];
    expect(mergeSavedOrder(['leadId', 'name'], declared)).toEqual(['seq', 'leadId', 'name']);
  });

  it('drops columns the table no longer declares', () => {
    // A saved layout outlives the code that produced it, and a stale key would
    // otherwise resolve to no column and leave a gap.
    const declared = ['leadId', 'name'];
    expect(mergeSavedOrder(['leadId', 'retired', 'name'], declared)).toEqual(['leadId', 'name']);
  });

  it('returns the declared order when there is nothing saved to honour', () => {
    const declared = ['leadId', 'created', 'source'];
    expect(mergeSavedOrder([], declared)).toEqual(declared);
  });

  it('upgrades a Lead Management layout to the order the module now declares', () => {
    // The real case this was written for, with the real keys.
    //
    // Before: the module showed a date-only "Created Date". After: that column
    // is withdrawn and three arrive — the timestamp that replaces it, the day
    // the lead is scheduled for, and why it is on that day. A user who had
    // customised this table got all three appended to the end of a
    // thirty-column table, off the right edge of the screen.
    const saved = ['importSeq', 'leadId', 'leadGenerationId', 'createdDate', 'leadSource', 'businessName', 'phone'];
    const declared = [
      'importSeq',
      'leadId',
      'leadGenerationId',
      'createdAt',
      'scheduledDate',
      'movement',
      'leadSource',
      'businessName',
      'phone',
    ];

    expect(mergeSavedOrder(saved, declared)).toEqual(declared);

    // Which, with the two default-hidden columns dropped, is the order asked
    // for: Lead ID → Lead Generation ID → Created Date & Time → Scheduled Date
    // → Lead Source → Company Name → …
    const hiddenByDefault = new Set(['importSeq', 'movement']);
    expect(mergeSavedOrder(saved, declared).filter((k) => !hiddenByDefault.has(k))).toEqual([
      'leadId',
      'leadGenerationId',
      'createdAt',
      'scheduledDate',
      'leadSource',
      'businessName',
      'phone',
    ]);
  });

  it('never invents, loses or duplicates a column', () => {
    // The invariant behind the rest: whatever the saved layout says, the result
    // is exactly today's column set, once each.
    const declared = ['a', 'b', 'c', 'd', 'e'];
    for (const saved of [[], ['e', 'a'], ['c', 'b', 'a'], ['x', 'y'], ['a', 'b', 'c', 'd', 'e']]) {
      const merged = mergeSavedOrder(saved, declared);
      expect(merged.slice().sort()).toEqual(declared.slice().sort());
      expect(new Set(merged).size).toBe(declared.length);
    }
  });
});

/**
 * A module is occasionally allowed to overrule a saved arrangement.
 *
 * Normally it is not: the order is the user's and nothing moves it. But when a
 * table restructures its columns — one withdrawn, others put in its place — the
 * saved order describes a table that no longer exists, and honouring it means
 * the change ships and nobody who has ever touched that table can see it.
 * Bumping the revision adopts the new arrangement once.
 */
describe('resolveOrder — adopting a restructured layout', () => {
  const DECLARED = ['leadId', 'createdAt', 'scheduled', 'source', 'company'];

  it('keeps a saved arrangement while the layout revision is unchanged', () => {
    // Same revision: the user dragged company to the front and it stays there.
    const saved = ['company', 'leadId', 'source'];
    expect(resolveOrder(saved, DECLARED, 1, 1)).toEqual(['company', 'leadId', 'createdAt', 'scheduled', 'source']);
  });

  it('adopts the declared order when the table has been restructured since', () => {
    // The user's own arrangement, saved against the OLD layout. The module has
    // rearranged since, so the new arrangement wins — once.
    const saved = ['company', 'leadId', 'source'];
    expect(resolveOrder(saved, DECLARED, 0, 1)).toEqual(DECLARED);
  });

  it('treats a layout saved before the mechanism existed as revision zero', () => {
    // Every layout saved before `layoutRev` shipped has no revision at all, and
    // those are exactly the ones that need the new arrangement.
    expect(resolveOrder(['company', 'leadId'], DECLARED, undefined, 1)).toEqual(DECLARED);
  });

  it('leaves every table that has never been restructured completely alone', () => {
    // The default. A table that does not pass `layoutRev` gets 0, which can
    // never be behind, so nothing about the existing behaviour changes.
    const saved = ['company', 'leadId', 'source'];
    expect(resolveOrder(saved, DECLARED, undefined, 0)).toEqual(mergeSavedOrder(saved, DECLARED));
  });

  it('does not adopt again once the user has saved against the new revision', () => {
    // The revision is stamped on save, so the next load sees an up-to-date
    // layout and the arrangement is the user's again — including one they made
    // deliberately AFTER the restructure, which must not be reset every load.
    const rearrangedAfterwards = ['leadId', 'source', 'createdAt', 'scheduled', 'company'];
    expect(resolveOrder(rearrangedAfterwards, DECLARED, 1, 1)).toEqual(rearrangedAfterwards);
  });

  it('still drops columns that no longer exist when it adopts', () => {
    expect(resolveOrder(['leadId', 'retired'], DECLARED, 0, 1)).not.toContain('retired');
  });
});

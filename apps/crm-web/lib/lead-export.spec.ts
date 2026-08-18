import { describe, expect, it } from '@jest/globals';
import { EXPORT_HEADERS, exportColumnIndex, exportRows } from './lead-export';
import type { Lead } from './leads';

/**
 * The export's failure mode is silence.
 *
 * If a column is added to the headings and not to the values (or the other way
 * round, or in a different position), nothing throws and the file still opens —
 * every field after the seam is simply under the wrong heading. Somebody reads
 * phone numbers in the Email column and only notices if they happen to look.
 *
 * So these tests read the file the way a person does: find the heading, then
 * check what is under it.
 */
describe('Lead Management export', () => {
  const CREATED = '2026-07-02T09:14:00Z';
  const SCHEDULED = '2026-08-14T04:00:00Z';

  const lead = (over: Partial<Lead> = {}): Lead =>
    ({
      leadId: 'L-2026-1',
      businessName: 'Acme Plumbing',
      phone: '305-555-1234',
      state: 'FL',
      city: 'Miami',
      createdAt: CREATED,
      assignedAt: SCHEDULED,
      assignmentType: 'carry_forward',
      carriedForwardCount: 3,
      assignedTo: { id: 'u1', name: 'Lisa', email: 'lisa@example.com' },
      ...over,
    }) as Lead;

  /** What the file shows under a given heading, for one lead. */
  const cell = (l: Lead, header: string) => exportRows([l])[0][exportColumnIndex(header)];

  it('gives every heading exactly one value, in the same position', () => {
    const [row] = exportRows([lead()]);
    expect(row).toHaveLength(EXPORT_HEADERS.length);
    // And no heading appears twice — two "Comments" columns would make the
    // lookup above ambiguous and the file misleading.
    expect(new Set(EXPORT_HEADERS).size).toBe(EXPORT_HEADERS.length);
  });

  it('exports the original creation stamp with its time, beside the plain date', () => {
    const l = lead();
    // Both columns, from the same instant: the date for scanning, the timestamp
    // for telling an original record from a lead that has since been moved.
    expect(cell(l, 'Created Date')).toContain('2026');
    expect(String(cell(l, 'Created Date & Time'))).toMatch(/\d{1,2}:\d{2}/);
    expect(String(cell(l, 'Created Date & Time'))).toContain('2026');
  });

  it('exports the scheduled day separately from the created day', () => {
    // The point of the pair. This lead was created in July and is on today's
    // queue, and the file has to say both — a created date alone would read as
    // a six-week-old lead nobody had scheduled.
    const l = lead();
    expect(cell(l, 'Created Date')).not.toBe(cell(l, 'Scheduled Date'));
    expect(String(cell(l, 'Scheduled Date'))).toContain('Aug');
  });

  it('writes every timestamp on the LEAD\'s clock, not the exporter\'s', () => {
    // 6:30pm on the 14th in New York; already 4am on the 15th in Chennai. A file
    // pulled from India used to date this lead the 15th, disagreeing with the
    // CRM screen and with the day the queue had it on.
    const evening = '2026-08-14T22:30:00Z';
    const eastern = lead({ timezone: 'EST', createdAt: evening, assignedAt: evening });

    expect(cell(eastern, 'Created Date')).toBe('Aug 14, 2026');
    expect(cell(eastern, 'Created Date & Time')).toBe('Aug 14, 2026, 06:30 PM');
    expect(cell(eastern, 'Scheduled Date')).toBe('Aug 14, 2026');

    // The same instant on a lead in a different zone is a different date, and
    // the file says so per row rather than per export.
    const pacific = lead({ timezone: 'PST', createdAt: evening, assignedAt: evening });
    expect(cell(pacific, 'Created Date & Time')).toBe('Aug 14, 2026, 03:30 PM');

    // Which clock each row is on travels with it — the column was already here.
    expect(cell(eastern, 'Time Zone')).toBe('EST');
    expect(cell(pacific, 'Time Zone')).toBe('PST');
  });

  it('gives the follow-up its hour, on the lead\'s clock', () => {
    // The appointment column. An hour agreed with the customer, stated a day out
    // in the export, is a call made on the wrong day — and stated to the day
    // only it does not say when to ring at all. A disposition writes a real time
    // into this field now, so the file carries it.
    const l = lead({ timezone: 'EST', nextFollowUpDate: '2026-08-14T22:30:00Z' });
    expect(cell(l, 'Next Follow-up')).toBe('Aug 14, 2026, 06:30 PM');
  });

  it('gives First and Last Contact their hours too', () => {
    // Three calls in one afternoon read as three identical dates without them,
    // and this pair is the evidence that a lead is being worked at all.
    const l = lead({
      timezone: 'EST',
      firstContact: '2026-08-10T14:05:00Z',
      lastContact: '2026-08-14T22:30:00Z',
    });
    expect(cell(l, 'First Contact')).toBe('Aug 10, 2026, 10:05 AM');
    expect(cell(l, 'Last Contact')).toBe('Aug 14, 2026, 06:30 PM');
  });

  it('carries no Callback column — the follow-up column already answers it', () => {
    // Withdrawn deliberately. A booked callback IS the lead's next follow-up, so
    // the file was reporting one commitment twice under two headings, and a
    // reader had no way to tell whether the two were meant to differ.
    expect(exportColumnIndex('Callback Date & Time')).toBe(-1);
    expect(EXPORT_HEADERS.filter((h) => /callback/i.test(h))).toEqual([]);
  });

  it('exports the Zoom meeting with its HOUR, on the lead\'s clock', () => {
    // 2:30pm on the 14th in Miami. Dated to the day this is unusable — a meeting
    // is an appointment, and the day is not the appointment — and read on the
    // exporter's clock in Chennai it would say 1:00am on the 15th.
    const l = lead({ timezone: 'EST', meetingDate: '2026-08-14T18:30:00Z' });
    expect(cell(l, 'Meeting Date & Time')).toBe('Aug 14, 2026, 02:30 PM');

    // Same instant, a lead in another zone: a different hour, decided per row.
    const pacific = lead({ timezone: 'PST', meetingDate: '2026-08-14T18:30:00Z' });
    expect(cell(pacific, 'Meeting Date & Time')).toBe('Aug 14, 2026, 11:30 AM');
  });

  it('leaves the meeting column blank when none is booked', () => {
    // Most leads, most of the time. An empty cell, not a placeholder date that
    // would sort and filter as a real appointment.
    expect(cell(lead(), 'Meeting Date & Time')).toBe('');
  });

  it('keeps the meeting and the follow-up in separate columns', () => {
    // The separation the file exists to preserve. A lead can easily have a Zoom
    // on Friday and a call-back on Tuesday, and neither column may be filled
    // from the other — that mapping error is invisible in a spreadsheet and
    // sends somebody to the wrong commitment.
    const l = lead({
      timezone: 'EST',
      meetingDate: '2026-08-21T18:30:00Z',
      nextFollowUpDate: '2026-08-18T14:00:00Z',
    });
    expect(cell(l, 'Meeting Date & Time')).toBe('Aug 21, 2026, 02:30 PM');
    expect(cell(l, 'Next Follow-up')).toBe('Aug 18, 2026, 10:00 AM');
  });

  it('leaves the follow-up blank on a lead that only has a meeting', () => {
    // The mapping error stated the other way round: a Zoom must not make a lead
    // look due for a call.
    const l = lead({ timezone: 'EST', meetingDate: '2026-08-21T18:30:00Z' });
    expect(cell(l, 'Next Follow-up')).toBe('');
  });
  it('spells out the next-day movement and counts it', () => {
    const l = lead();
    expect(cell(l, 'Movement')).toBe('Moved to next day (3×)');
    expect(cell(l, 'Times Moved to Next Day')).toBe(3);
  });

  it('carries the agent, the outcome and the remarks alongside the dates', () => {
    // The set the export is asked for: who owns it, what happened on the call,
    // and what was said — next to when it was created and when it is due.
    const l = lead({ callStatus: 'no_answer', comments: 'Left voicemail', followupCount: 2 });
    expect(cell(l, 'Assigned To')).toBe('Lisa');
    expect(cell(l, 'Call Status')).toBe('no_answer');
    expect(cell(l, 'Comments')).toBe('Left voicemail');
    expect(cell(l, 'Follow-up Count')).toBe(2);
  });

  it('writes blanks, not "null" or "undefined", for what a lead does not have', () => {
    // These land in spreadsheet cells. A literal "undefined" in the Email column
    // is worse than an empty one, and it sorts and filters as text.
    const bare = {
      leadId: 'L-2026-2',
      businessName: 'Bare Co',
      phone: '305-555-0000',
      state: 'FL',
      city: 'Miami',
      createdAt: CREATED,
    } as Lead;

    const [row] = exportRows([bare]);
    for (const value of row) {
      expect(value).not.toBeNull();
      expect(value).not.toBeUndefined();
      expect(String(value)).not.toMatch(/^(null|undefined|NaN)$/);
    }
    expect(cell(bare, 'Email')).toBe('');
    expect(cell(bare, 'Scheduled Date')).toBe('');
    // Never assigned, never moved — the count is a number, so the column still
    // sums in a spreadsheet.
    expect(cell(bare, 'Times Moved to Next Day')).toBe(0);
    expect(cell(bare, 'Movement')).toBe('');
  });

  it('exports every lead it is handed, in order', () => {
    const rows = exportRows([lead({ leadId: 'L-1' }), lead({ leadId: 'L-2' }), lead({ leadId: 'L-3' })]);
    expect(rows.map((r) => r[exportColumnIndex('Lead ID')])).toEqual(['L-1', 'L-2', 'L-3']);
  });

  it('keeps the columns the module has always exported', () => {
    // A regression guard on the file's shape: people build spreadsheets on these
    // headings, so a rename is a decision, not a refactor.
    for (const header of ['Lead ID', 'Company Name', 'Phone', 'Assigned To', 'Call Status', 'Comments']) {
      expect(exportColumnIndex(header)).toBeGreaterThanOrEqual(0);
    }
  });
});

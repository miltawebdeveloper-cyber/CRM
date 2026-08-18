import { describe, expect, it } from '@jest/globals';
import { owedNow, queueStatusOf, type QueueLeadState } from './queue-status';

/**
 * The reported bug, stated as a test: after an agent finishes a call, the lead
 * must read Completed — never New Call — and Your Queue must stop offering it.
 *
 * The panel filters on this verdict, so "completed" here IS "gone from the
 * queue". Everything below is one of the ways a lead can arrive at, or escape
 * from, that state.
 */
describe('call lifecycle status', () => {
  const NOW = new Date('2026-08-18T15:00:00Z'); // 3pm
  const at = (hhmm: string) => new Date(`2026-08-18T${hhmm}:00Z`);

  const lead = (over: Partial<QueueLeadState> = {}): QueueLeadState => ({
    status: 'new',
    lastCallAt: null,
    lastCallEndedAt: null,
    lastWorkedAt: null,
    callbackAt: null,
    callbackCompletedAt: null,
    nextZoomMeeting: null,
    ...over,
  });

  it('starts a never-touched lead as a new call', () => {
    expect(queueStatusOf(lead(), NOW)).toBe('new');
  });

  it('is in progress while a call is live', () => {
    expect(queueStatusOf(lead({ lastCallAt: at('14:55'), lastCallEndedAt: null }), NOW)).toBe('in_progress');
  });

  it('is completed once the call has ended', () => {
    // The headline case. Not "new", not "new with a tick" — completed, and out
    // of the queue.
    expect(queueStatusOf(lead({ lastCallAt: at('14:30'), lastCallEndedAt: at('14:40') }), NOW)).toBe('completed');
  });

  it('is completed when the lead was saved with no call placed', () => {
    // Lead-processing mode stamps no call, so this used to be the case where a
    // finished lead fell through every check and came back reading "New Call".
    expect(queueStatusOf(lead({ lastWorkedAt: at('14:40') }), NOW)).toBe('completed');
  });

  it('is completed whatever the outcome was', () => {
    // "Regardless of the previous call status" — no answer, wrong number,
    // interested. The agent has finished with the lead either way.
    for (const status of ['new', 'contacted', 'in_progress', 'interested']) {
      expect(queueStatusOf(lead({ status, lastCallEndedAt: at('14:40') }), NOW)).toBe('completed');
    }
  });

  it('treats a closed or rejected lead as completed however it got there', () => {
    // A manager may have closed it from Lead Management, with no call on it at
    // all. Nothing further is owed, so it does not belong in anyone's queue.
    expect(queueStatusOf(lead({ status: 'closed' }), NOW)).toBe('completed');
    expect(queueStatusOf(lead({ status: 'rejected' }), NOW)).toBe('completed');
  });

  it('lets a live call outrank work done earlier the same day', () => {
    // Saved this morning, being rung again now. The lead is being worked NOW.
    expect(
      queueStatusOf(lead({ lastWorkedAt: at('10:00'), lastCallAt: at('14:58'), lastCallEndedAt: null }), NOW),
    ).toBe('in_progress');
  });

  describe('a booked appointment brings the lead back', () => {
    it('stays completed while the callback is still ahead', () => {
      // Rung at 10, callback agreed for 4pm. At 3pm there is nothing to do, so
      // the lead is out of the queue rather than sitting in it all day.
      expect(queueStatusOf(lead({ lastWorkedAt: at('10:00'), callbackAt: at('16:00') }), NOW)).toBe('completed');
    });

    it('re-opens the moment the callback falls due', () => {
      // 2pm callback, now 3pm: the customer is expecting a call and the lead is
      // back on the list — the reason "completed" is per pass, not forever.
      expect(queueStatusOf(lead({ lastWorkedAt: at('10:00'), callbackAt: at('14:00') }), NOW)).toBe('new');
    });

    it('stays completed once that callback has been answered', () => {
      expect(
        queueStatusOf(
          lead({ lastWorkedAt: at('14:10'), callbackAt: at('14:00'), callbackCompletedAt: at('14:10') }),
          NOW,
        ),
      ).toBe('completed');
    });

    it('re-opens for a Zoom meeting whose time has come', () => {
      expect(
        queueStatusOf(lead({ lastWorkedAt: at('10:00'), nextZoomMeeting: { scheduledAt: at('14:30') } }), NOW),
      ).toBe('new');
      expect(
        queueStatusOf(lead({ lastWorkedAt: at('10:00'), nextZoomMeeting: { scheduledAt: at('16:30') } }), NOW),
      ).toBe('completed');
    });

    it('does not re-open a lead that was never worked — it was never completed', () => {
      // An appointment on an untouched lead is ordinary queued work, not a
      // return from completion.
      expect(queueStatusOf(lead({ callbackAt: at('14:00') }), NOW)).toBe('new');
    });
  });

  describe('owedNow', () => {
    it('is false with nothing booked', () => {
      expect(owedNow(lead(), NOW)).toBe(false);
    });

    it('reads the clock, not the calendar day', () => {
      // The distinction the whole rule turns on: both of these are "today".
      expect(owedNow(lead({ callbackAt: at('14:59') }), NOW)).toBe(true);
      expect(owedNow(lead({ callbackAt: at('15:01') }), NOW)).toBe(false);
    });

    it('counts an overdue callback from an earlier day', () => {
      expect(owedNow(lead({ callbackAt: new Date('2026-08-17T09:00:00Z') }), NOW)).toBe(true);
    });
  });
});

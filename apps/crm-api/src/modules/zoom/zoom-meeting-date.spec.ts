import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { ZoomMeetingStatus } from '@crm/database';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ZoomService } from './zoom.service';
import type { CreateZoomMeetingDto, UpdateZoomMeetingDto } from './dto/zoom.dto';

/**
 * Lead Management's Meeting Date & Time, and the column it must never touch.
 *
 * The field was a lead-sheet value and nothing more: it held whatever the import
 * wrote, and a Zoom booked through the CRM never reached it — so the grid said a
 * lead had no meeting while the calendar had one.
 *
 * The other half is the separation. A meeting and a follow-up call are two
 * different promises to the customer, and writing one from the other is the kind
 * of error that never looks wrong on screen: the row shows a plausible date, and
 * somebody rings on the day of a meeting they were supposed to attend. So every
 * test here also checks what was NOT written.
 */
describe('ZoomService — Lead Management meeting date', () => {
  const LEAD = 'lead-1';
  const at = (iso: string) => new Date(iso);

  /**
   * Enough Prisma to run the meeting lifecycle. `pending` is what the lead's
   * meetings table would answer with after the operation under test — the
   * service re-reads it rather than writing the date from whichever call it is
   * in, and that read is the thing being exercised.
   */
  function harness(pending: { scheduledAt: Date } | null) {
    const leadUpdate = jest.fn(async (_args: { where: { id: string }; data: Record<string, unknown> }) => ({}));
    const meeting = (over: Record<string, unknown> = {}) => ({
      id: 'zm-1',
      leadId: LEAD,
      taskId: 'task-1',
      scheduledAt: at('2026-08-21T18:30:00Z'),
      status: ZoomMeetingStatus.scheduled,
      organizerId: 'user-1',
      lead: { businessName: 'Acme', timezone: 'EST' },
      ...over,
    });

    const prisma = {
      lead: {
        findFirst: jest.fn(async () => ({ id: LEAD, businessName: 'Acme', timezone: 'EST' })),
        findUnique: jest.fn(async () => ({ timezone: 'EST' })),
        update: leadUpdate,
      },
      task: { create: jest.fn(async () => ({ id: 'task-1' })), update: jest.fn(async () => ({})), delete: jest.fn(async () => ({})) },
      zoomMeeting: {
        create: jest.fn(async () => meeting()),
        update: jest.fn(async (args: { data: Record<string, unknown> }) => meeting(args.data)),
        delete: jest.fn(async () => meeting()),
        findUnique: jest.fn(async () => meeting()),
        // The "what is still pending for this lead" read the sync is built on.
        findFirst: jest.fn(async () => pending),
      },
      zoomMeetingActivity: { create: jest.fn(async () => ({})) },
      activity: { create: jest.fn(async () => ({})) },
      note: { create: jest.fn(async () => ({})) },
    } as unknown as PrismaService;

    const service = new ZoomService(prisma, { notifyAndEmail: jest.fn() } as unknown as NotificationsService);
    return { service, prisma, leadUpdate };
  }

  /** What the lead was written with — the whole point of these tests. */
  const written = (h: ReturnType<typeof harness>) =>
    h.leadUpdate.mock.calls[0]?.[0].data as Record<string, unknown> | undefined;

  describe('scheduling', () => {
    let h: ReturnType<typeof harness>;
    beforeEach(async () => {
      h = harness({ scheduledAt: at('2026-08-21T18:30:00Z') });
      await h.service.create({ leadId: LEAD, scheduledAt: '2026-08-21T14:30' } as CreateZoomMeetingDto, 'user-1');
    });

    it('stores the meeting time on the lead', () => {
      expect(written(h)?.meetingDate).toEqual(at('2026-08-21T18:30:00Z'));
    });

    it('writes that field and nothing else', () => {
      // The guarantee, enforced structurally rather than by reading the code:
      // if `nextFollowUpDate` or `callbackAt` ever appears in this payload, a
      // Zoom booking has started overwriting a call-back commitment.
      expect(Object.keys(written(h) ?? {})).toEqual(['meetingDate']);
    });
  });

  describe('rescheduling', () => {
    it('moves the meeting date to the new time', async () => {
      const h = harness({ scheduledAt: at('2026-08-25T18:30:00Z') });
      await h.service.update('zm-1', { scheduledAt: '2026-08-25T14:30' } as UpdateZoomMeetingDto, 'user-1');

      expect(written(h)?.meetingDate).toEqual(at('2026-08-25T18:30:00Z'));
    });

    it('still touches nothing else', async () => {
      // "If the Zoom meeting is rescheduled, only the Meeting Date & Time should
      // be updated" — stated as a test.
      const h = harness({ scheduledAt: at('2026-08-25T18:30:00Z') });
      await h.service.update('zm-1', { scheduledAt: '2026-08-25T14:30' } as UpdateZoomMeetingDto, 'user-1');

      expect(Object.keys(written(h) ?? {})).toEqual(['meetingDate']);
    });
  });

  describe('when the meeting stops being pending', () => {
    it('clears the date on cancellation', async () => {
      // The grid must stop advertising a meeting that is not happening. Nobody
      // remembers to handle this when the date is written by the booking call
      // instead of read back from the meetings table.
      const h = harness(null);
      await h.service.cancel('zm-1', 'user-1');

      expect(written(h)?.meetingDate).toBeNull();
    });

    it('clears the date once the meeting is completed', async () => {
      const h = harness(null);
      await h.service.complete('zm-1', {} as never, 'user-1');

      expect(written(h)?.meetingDate).toBeNull();
    });

    it('clears the date when the meeting is deleted outright', async () => {
      const h = harness(null);
      await h.service.remove('zm-1');

      expect(written(h)?.meetingDate).toBeNull();
    });

    it('falls back to the next meeting still booked, rather than clearing', async () => {
      // A lead with two meetings loses one: the column moves to the survivor. A
      // write-on-booking scheme cannot do this at all — it has no idea another
      // meeting exists.
      const h = harness({ scheduledAt: at('2026-09-02T15:00:00Z') });
      await h.service.cancel('zm-1', 'user-1');

      expect(written(h)?.meetingDate).toEqual(at('2026-09-02T15:00:00Z'));
    });
  });

  it('asks only for meetings that are still going to happen', async () => {
    // Cancelled and completed meetings must not decide the column, or cancelling
    // one would leave its time on the lead forever.
    const h = harness(null);
    await h.service.cancel('zm-1', 'user-1');

    const where = (h.prisma.zoomMeeting.findFirst as unknown as jest.Mock).mock.calls[0][0] as {
      where: { leadId: string; status: { in: ZoomMeetingStatus[] } };
      orderBy: { scheduledAt: string };
    };
    expect(where.where.leadId).toBe(LEAD);
    expect(where.where.status.in).toEqual([
      ZoomMeetingStatus.scheduled,
      ZoomMeetingStatus.in_progress,
      ZoomMeetingStatus.rescheduled,
    ]);
    // Earliest first — the same meeting the Calling Panel pins on the queue row,
    // so the two screens cannot disagree about which one is next.
    expect(where.orderBy.scheduledAt).toBe('asc');
  });

  it('does not fail the meeting operation if the lead write fails', async () => {
    // A lead deleted from under a meeting is not a reason to reject a
    // cancellation the user actually asked for.
    const h = harness(null);
    (h.leadUpdate as unknown as jest.Mock).mockImplementation(() => Promise.reject(new Error('lead gone')));

    await expect(h.service.cancel('zm-1', 'user-1')).resolves.toBeDefined();
  });
});

import { describe, expect, it, jest } from '@jest/globals';
import { PrismaService } from '../../prisma/prisma.service';
import { LeadsService } from './leads.service';
import { NotificationsService } from '../notifications/notifications.service';
import { LeadIdService } from './lead-id.service';

describe('LeadsService import optimization helpers', () => {
  it('builds a compact set of update windows for a phone field', () => {
    const service = new LeadsService({} as PrismaService, {} as NotificationsService, {} as LeadIdService);
    const buildWindows = (service as unknown as { buildUpdateWindows?: (raw?: string | null, keyLens?: Set<number>) => Set<string> }).buildUpdateWindows;
    expect(buildWindows).toBeDefined();

    const windows = buildWindows?.('3055551234', new Set([10]));
    expect(windows).toEqual(new Set(['3055551234']));
  });
});

/**
 * A comment is a trail entry, not a column value.
 *
 * Re-entering the same remark used to be dropped as "no change": the field diff
 * skipped it, and the early return that fires when nothing else changed skipped
 * the history write with it. "Left voicemail" on Monday and again on Thursday is
 * two calls, and the second one silently vanished.
 */
describe('LeadsService — comments are always recorded', () => {
  const LEAD = { id: 'lead-1', leadId: 'L-2026-1', comments: 'Left voicemail', assignedToId: 'user-1', assignedTo: null, status: 'new', timezone: 'EST' };

  function harness() {
    const noteCreate = jest.fn(async (_args: { data: Record<string, unknown> }) => ({ id: 'note-1' }));
    const prisma = {
      lead: {
        findFirst: jest.fn(async () => LEAD),
        update: jest.fn(async () => ({ ...LEAD })),
        // Read by `log` when a real column change is written — clearing a
        // comment is one, so that path is reached.
        findUnique: jest.fn(async () => ({ callStatus: null, assignedToId: 'user-1' })),
      },
      note: { create: noteCreate },
      activity: { create: jest.fn(async () => ({})) },
    } as unknown as PrismaService;
    const service = new LeadsService(prisma, {} as NotificationsService, {} as LeadIdService);
    return { service, noteCreate };
  }

  it('records a repeated remark rather than treating it as no change', async () => {
    const { service, noteCreate } = harness();
    // Byte-identical to what is already on the lead — the case that was lost.
    await service.update('lead-1', { comments: 'Left voicemail' } as never, { id: 'user-1', role: 'admin' } as never);
    expect(noteCreate).toHaveBeenCalledTimes(1);
    expect(noteCreate.mock.calls[0][0].data.noteText).toBe('Left voicemail');
  });

  it('ignores an empty comment — clearing the field is not a remark', async () => {
    const { service, noteCreate } = harness();
    await service.update('lead-1', { comments: '   ' } as never, { id: 'user-1', role: 'admin' } as never);
    expect(noteCreate).not.toHaveBeenCalled();
  });
});

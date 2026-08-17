import { describe, expect, it, jest } from '@jest/globals';
import { PrismaService } from '../../prisma/prisma.service';
import { OpenPhoneService } from '../openphone/openphone.service';
import { OpenPhoneCall } from '../openphone/openphone.types';
import { CallInsightsService } from './call-insights.service';
import { QuoSyncService } from './quo-sync.service';

/**
 * One call, one row — from the backfill's side.
 *
 * `startCall` writes a Call the moment the agent clicks Call, carrying no
 * `quoCallId` because the provider has not issued one yet. The webhook normally
 * claims that row. When it doesn't — a delivery rejected on a signature
 * mismatch, a webhook added after the call, an outage — this backfill used to
 * create a SECOND row for the same conversation, and Call Details showed the
 * call twice: once with the agent's outcome and no recording, once with the
 * recording and no outcome.
 *
 * These pin both halves of the rule: the unlinked row is adopted rather than
 * duplicated, and a genuinely separate call is still recorded separately.
 */
describe('QuoSyncService — the backfill never doubles a call', () => {
  type CallRow = {
    id: string;
    quoCallId: string | null;
    leadId: string | null;
    direction: string | null;
    startTime: Date;
    endTime: Date | null;
  };

  /**
   * Prisma cut down to what `upsertCall` touches. `rows` is the CRM's existing
   * call table; the findFirst below answers from it the way the real queries do.
   */
  function harness(rows: CallRow[]) {
    const create = jest.fn(async (_args: { data: Record<string, unknown> }) => ({ id: 'created-1' }));
    const update = jest.fn(async (_args: { where: { id: string }; data: Record<string, unknown> }) => ({}));

    const findFirst = jest.fn(async (args: { where: Record<string, unknown> }) => {
      const w = args.where;
      // Lookup 1: already linked to this provider call?
      if (typeof w.quoCallId === 'string') {
        return rows.find((r) => r.quoCallId === w.quoCallId) ?? null;
      }
      // Lookup 2: an unlinked CRM row for the same lead, direction and window.
      const st = w.startTime as { gte: Date; lte: Date } | undefined;
      const found = rows
        .filter(
          (r) =>
            r.quoCallId === null &&
            r.leadId === w.leadId &&
            r.direction === w.direction &&
            (!st || (r.startTime >= st.gte && r.startTime <= st.lte)),
        )
        .sort((a, b) => b.startTime.getTime() - a.startTime.getTime());
      return found[0] ?? null;
    });

    const prisma = { call: { findFirst, create, update } } as unknown as PrismaService;
    const service = new QuoSyncService(
      prisma,
      {} as unknown as OpenPhoneService,
      { enqueue: jest.fn() } as unknown as CallInsightsService,
    );
    return { service, create, update, findFirst };
  }

  /** The CRM row `startCall` leaves behind: outbound, unlinked, no end time. */
  const pending = (startTime: Date, over: Partial<CallRow> = {}): CallRow => ({
    id: 'crm-1',
    quoCallId: null,
    leadId: 'lead-1',
    direction: 'outbound',
    startTime,
    endTime: null,
    ...over,
  });

  const providerCall = (over: Partial<OpenPhoneCall> = {}): OpenPhoneCall =>
    ({
      id: 'quo-abc',
      direction: 'outgoing',
      status: 'completed',
      duration: 95,
      createdAt: '2026-08-12T14:00:00.000Z',
      completedAt: '2026-08-12T14:01:35.000Z',
      ...over,
    }) as OpenPhoneCall;

  /** `upsertCall` is private — this is the one seam worth reaching through. */
  const upsert = (service: QuoSyncService, c: OpenPhoneCall) =>
    (service as unknown as {
      upsertCall(leadId: string, callerId: string, c: OpenPhoneCall): Promise<string | null>;
    }).upsertCall('lead-1', 'user-1', c);

  it('adopts the CRM row the webhook never claimed, instead of creating a second', async () => {
    // The agent dialled at 14:00; the provider says the same.
    const { service, create, update } = harness([pending(new Date('2026-08-12T14:00:00Z'))]);
    const id = await upsert(service, providerCall());

    expect(create).not.toHaveBeenCalled();
    expect(id).toBe('crm-1');
    // The surviving row is the CRM's, now carrying the provider's detail.
    expect(update.mock.calls[0][0].where.id).toBe('crm-1');
    expect(update.mock.calls[0][0].data).toMatchObject({ quoCallId: 'quo-abc', status: 'completed', durationSecs: 95 });
  });

  it('does not overwrite an end time the CRM already recorded', async () => {
    // The agent pressed End, so the duration they were credited with stands.
    const ended = pending(new Date('2026-08-12T14:00:00Z'), { endTime: new Date('2026-08-12T14:01:00Z') });
    const { service, update } = harness([ended]);
    await upsert(service, providerCall());

    expect(update.mock.calls[0][0].data).not.toHaveProperty('endTime');
  });

  it('enriches in place when the webhook already linked the row', async () => {
    const linked = pending(new Date('2026-08-12T14:00:00Z'), { id: 'crm-1', quoCallId: 'quo-abc' });
    const { service, create, update } = harness([linked]);
    const id = await upsert(service, providerCall());

    expect(create).not.toHaveBeenCalled();
    expect(id).toBe('crm-1');
    expect(update.mock.calls[0][0].where.id).toBe('crm-1');
  });

  it('creates a row when the CRM has nothing to adopt', async () => {
    // An inbound call, or history from before the CRM existed — no pending row.
    const { service, create } = harness([]);
    await upsert(service, providerCall());

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].data).toMatchObject({ quoCallId: 'quo-abc', leadId: 'lead-1' });
  });

  it('leaves a legitimately separate call alone — a different day is not the same call', async () => {
    // A real call to the same lead yesterday must not be swallowed by today's.
    const { service, create, update } = harness([pending(new Date('2026-08-11T14:00:00Z'))]);
    await upsert(service, providerCall());

    expect(create).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
  });

  it('does not adopt across directions — an inbound row is never an outbound call', async () => {
    const { service, create } = harness([pending(new Date('2026-08-12T14:00:00Z'), { direction: 'inbound' })]);
    await upsert(service, providerCall());

    expect(create).toHaveBeenCalledTimes(1);
  });

  it('does not adopt another lead\'s pending call', async () => {
    const { service, create } = harness([pending(new Date('2026-08-12T14:00:00Z'), { leadId: 'lead-2' })]);
    await upsert(service, providerCall());

    expect(create).toHaveBeenCalledTimes(1);
  });

  it('takes the most recent of two back-to-back attempts', async () => {
    // Two tries at the same lead; the provider call is the later one.
    const { service, update } = harness([
      pending(new Date('2026-08-12T13:20:00Z'), { id: 'crm-early' }),
      pending(new Date('2026-08-12T13:55:00Z'), { id: 'crm-late' }),
    ]);
    await upsert(service, providerCall());

    expect(update.mock.calls[0][0].where.id).toBe('crm-late');
  });

  it('ignores a provider call with no id', async () => {
    const { service, create, update } = harness([pending(new Date('2026-08-12T14:00:00Z'))]);
    const id = await upsert(service, providerCall({ id: undefined }));

    expect(id).toBeNull();
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});

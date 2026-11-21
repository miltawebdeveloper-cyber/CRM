import { describe, expect, it, jest } from '@jest/globals';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { COUNTED_CALL, connectedCall, isConnectedCall, reachedOutcomeSlugs } from './call-status.js';

/**
 * "Connected" means the customer ANSWERED. The rep's outcome decides when
 * there is one; otherwise the phone system's answered status and talk time.
 */
describe('connected = answered', () => {
  const reached = new Set(['call_back', 'not_interested', 'closed_won']);
  const ended = new Date('2026-11-20T15:00:00Z');
  const call = (patch: Partial<Parameters<typeof isConnectedCall>[0]>) => ({
    endTime: ended,
    outcome: null,
    status: null,
    durationSecs: null,
    ...patch,
  });

  it('counts a call the rep marked as a conversation — a "not interested" included', () => {
    expect(isConnectedCall(call({ outcome: 'call_back' }), reached)).toBe(true);
    expect(isConnectedCall(call({ outcome: 'not_interested' }), reached)).toBe(true);
  });

  it('does not count one the rep marked No Answer — even if the line reports it completed', () => {
    expect(isConnectedCall(call({ outcome: 'no_answer', status: 'completed', durationSecs: 25 }), reached)).toBe(false);
    expect(isConnectedCall(call({ outcome: 'voice_mail' }), reached)).toBe(false);
  });

  it('takes the phone system’s word when there is no outcome: answered, with talk time', () => {
    expect(isConnectedCall(call({ status: 'completed', durationSecs: 42 }), reached)).toBe(true);
    expect(isConnectedCall(call({ status: 'completed', durationSecs: 0 }), reached)).toBe(false);
    expect(isConnectedCall(call({ status: 'no-answer', durationSecs: 0 }), reached)).toBe(false);
  });

  it('cannot show a call was answered with neither an outcome nor a status', () => {
    // Dialled by hand and never dispositioned, or abandoned.
    expect(isConnectedCall(call({ status: 'initiated' }), reached)).toBe(false);
    expect(isConnectedCall(call({ status: 'abandoned', durationSecs: 0 }), reached)).toBe(false);
  });

  it('only counts a call that has finished', () => {
    expect(isConnectedCall(call({ endTime: null, outcome: 'call_back' }), reached)).toBe(false);
  });

  it('says the same thing in the database filter the totals use', () => {
    expect(connectedCall(['call_back'])).toEqual({
      endTime: { not: null },
      OR: [
        { outcome: { in: ['call_back'] } },
        { outcome: null, status: { in: ['completed', 'answered', 'in-progress', 'in_progress', 'connected'] }, durationSecs: { gt: 0 } },
      ],
    });
  });

  it('reads the reached outcomes from the configured list, by group', async () => {
    const findMany = jest.fn(async (_a: unknown) => [{ slug: 'call_back' }, { slug: 'closed_won' }]);
    const slugs = await reachedOutcomeSlugs({ outcome: { findMany } } as unknown as Pick<PrismaService, 'outcome'>);
    expect(slugs).toEqual(['call_back', 'closed_won']);
    const where = JSON.stringify((findMany.mock.calls[0][0] as { where: unknown }).where);
    for (const group of ['warm', 'hot', 'connected', 'closed_positive', 'closed_negative']) expect(where).toContain(group);
    // "cold" — nobody reached — is never one of them.
    expect(where).not.toContain('cold');
  });

  it('leaves missed inbound calls on known leads out of every call total', () => {
    expect(COUNTED_CALL).toEqual({ NOT: { direction: 'inbound', status: { in: ['missed', 'no-answer', 'no_answer'] }, leadId: { not: null } } });
  });
});

import { describe, expect, it } from '@jest/globals';
import { redactPayload } from './webhooks.controller.js';

/** Logged webhook payloads keep their shape for debugging, and nothing personal. */
describe('redactPayload', () => {
  const payload = {
    id: 'EVabc123',
    type: 'call.completed',
    data: {
      object: {
        id: 'ACxyz',
        direction: 'incoming',
        status: 'completed',
        from: '+18135550199',
        to: ['+18135550100'],
        duration: 95,
        transcript: { dialogue: [{ content: 'Hi, my SSN is …' }] },
        summary: ['Customer wants payroll help'],
        contactName: 'Jane Customer',
      },
    },
  };

  it('keeps ids, types, statuses, direction and numbers that are not phones', () => {
    const r = redactPayload(payload) as typeof payload;
    expect(r.id).toBe('EVabc123');
    expect(r.type).toBe('call.completed');
    expect(r.data.object).toMatchObject({ id: 'ACxyz', direction: 'incoming', status: 'completed', duration: 95 });
  });

  it('masks phone numbers to their last four digits and drops free text and names', () => {
    const text = JSON.stringify(redactPayload(payload));
    expect(text).not.toContain('8135550199');
    expect(text).toContain('…0199');
    expect(text).not.toContain('SSN');
    expect(text).not.toContain('payroll');
    expect(text).not.toContain('Jane');
  });
});

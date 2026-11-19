import { describe, expect, it, jest } from '@jest/globals';
import { Role } from '@crm/database';
import { CalendarService } from './calendar.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';

/**
 * 20:00 Eastern on 1 Aug 2026 is 05:30 on 2 Aug in Kolkata. The grid cell an
 * event lands in must be the day on the CUSTOMER's calendar, not the server's —
 * a server on IST used to file this Eastern callback under the 2nd.
 */
describe('CalendarService — events land on the lead\'s calendar day', () => {
  const AT = new Date('2026-08-02T00:00:00Z'); // 8pm EDT on Aug 1, 5:30am IST on Aug 2

  const serviceWith = (tz: string) => {
    const lead = {
      id: 'l1', leadId: 'L-1', businessName: 'Acme', contactName: null, status: 'new', timezone: tz,
      assignedTo: null, callbackAt: AT, callbackCompletedAt: null, nextFollowUpDate: null,
    };
    const prisma = {
      lead: { findMany: jest.fn(async (args: { where?: { callbackAt?: unknown } }) => (args.where?.callbackAt ? [lead] : [])) },
      zoomMeeting: { findMany: jest.fn(async () => []) },
    } as unknown as PrismaService;
    return new CalendarService(prisma);
  };

  it('puts an Eastern lead\'s evening callback on Aug 1', async () => {
    const { events } = await serviceWith('EST').events({ from: '2026-08-01', to: '2026-08-31' }, { id: 'u', role: Role.admin });
    expect(events[0]).toMatchObject({ ymd: '2026-08-01', day: 1 });
  });

  it('puts the same instant on Aug 2 for an India lead', async () => {
    const { events } = await serviceWith('IND').events({ from: '2026-08-01', to: '2026-08-31' }, { id: 'u', role: Role.admin });
    expect(events[0]).toMatchObject({ ymd: '2026-08-02', day: 2 });
  });
});

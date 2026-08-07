import { describe, expect, it } from '@jest/globals';
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

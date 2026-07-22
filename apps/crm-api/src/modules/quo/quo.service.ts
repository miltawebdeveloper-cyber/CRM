import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { Prisma, QuoSyncStatus } from '@crm/database';
import { PrismaService } from '../../prisma/prisma.service';
import { OpenPhoneService } from '../openphone/openphone.service';
import { OpenPhoneContactPayload } from '../openphone/openphone.types';

/**
 * Orchestrates the Lead → phone-provider sync: build a contact payload → create
 * it in OpenPhone (Quo) → persist the response (or error) on the lead → write an
 * audit log row. (Quo == OpenPhone; the lead's quo* columns are kept as-is.)
 */
@Injectable()
export class QuoService {
  private readonly logger = new Logger(QuoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly openphone: OpenPhoneService,
  ) {}

  get sandboxMode() {
    return this.openphone.isSandbox;
  }

  async syncLead(leadId: string) {
    const lead = await this.prisma.lead.findFirst({ where: { id: leadId, deletedAt: null } });
    if (!lead) throw new NotFoundException('Lead not found');

    // mark in-flight
    await this.prisma.lead.update({
      where: { id: leadId },
      data: { quoStatus: QuoSyncStatus.pending },
    });

    const payload: OpenPhoneContactPayload = {
      defaultFields: {
        company: lead.businessName,
        firstName: lead.businessName,
        phoneNumbers: [{ name: 'primary', value: lead.phone }],
        emails: lead.email ? [{ name: 'primary', value: lead.email }] : [],
      },
      externalId: lead.id,
      source: 'CRM',
    };

    const result = await this.openphone.createContact(payload);

    // Persist result on the lead + write the audit log in one transaction.
    const [updated] = await this.prisma.$transaction([
      this.prisma.lead.update({
        where: { id: leadId },
        data: result.success
          ? {
              quoStatus: QuoSyncStatus.synced,
              quoExternalId: result.data?.id ?? null,
              quoResponse: ((result.data ?? Prisma.DbNull) as unknown) as Prisma.InputJsonValue,
              quoError: null,
              quoSyncedAt: new Date(),
            }
          : {
              quoStatus: QuoSyncStatus.failed,
              quoError: result.error ?? 'Unknown error',
              quoResponse: ((result.data ?? Prisma.DbNull) as unknown) as Prisma.InputJsonValue,
            },
      }),
      this.prisma.quoSyncLog.create({
        data: {
          leadId,
          success: result.success,
          statusCode: result.statusCode ?? null,
          request: payload as unknown as Prisma.InputJsonValue,
          response: ((result.data ?? Prisma.DbNull) as unknown) as Prisma.InputJsonValue,
          error: result.error ?? null,
          durationMs: result.durationMs,
        },
      }),
    ]);

    return {
      success: result.success,
      sandbox: this.openphone.isSandbox,
      quoStatus: updated.quoStatus,
      quoExternalId: updated.quoExternalId,
      quoSyncedAt: updated.quoSyncedAt,
      error: updated.quoError,
      response: result.data,
    };
  }

  /**
   * Bulk-sync every lead that isn't already synced (covers not_synced + failed).
   * Processed in small concurrent chunks to stay within OpenPhone's rate limits.
   */
  async syncAllLeads() {
    const leads = await this.prisma.lead.findMany({
      where: { deletedAt: null, quoStatus: { not: QuoSyncStatus.synced } },
      select: { id: true },
    });
    let synced = 0;
    let failed = 0;
    const chunkSize = 5;
    for (let i = 0; i < leads.length; i += chunkSize) {
      const chunk = leads.slice(i, i + chunkSize);
      const results = await Promise.all(
        chunk.map(async (l) => {
          try {
            return (await this.syncLead(l.id)).success;
          } catch (err) {
            this.logger.warn(`Bulk sync failed for lead ${l.id}: ${(err as Error).message}`);
            return false;
          }
        }),
      );
      for (const ok of results) { if (ok) synced++; else failed++; }
    }
    return { total: leads.length, synced, failed, sandbox: this.openphone.isSandbox };
  }

  /** Sync history for the Lead Details page. */
  async getLogs(leadId: string) {
    return this.prisma.quoSyncLog.findMany({
      where: { leadId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
  }
}

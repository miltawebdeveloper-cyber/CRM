import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@crm/database';
import { PrismaService } from '../../prisma/prisma.service.js';

/**
 * The one place a Lead ID is minted.
 *
 * Every lead entering the CRM gets an id in the established `L-YYYY-N` format,
 * whatever created it — the New Lead form, an Excel import, the calling queue,
 * an inbound call from a number nobody has seen before, or an integration
 * posting a lead over the API.
 *
 * It exists as a service rather than a private helper because it previously
 * WASN'T shared. The leads module generated `L-2026-1251`, while a lead minted
 * from an unrecognised inbound caller got `L-${Date.now().toString(36)}` —
 * `L-M8XK2P9`. Those ids sort wrongly against every other lead and read as a
 * different kind of record to anyone looking at them. A second copy of "how do
 * we number a lead" is exactly how that happens, so now there is one copy and
 * both modules call it.
 *
 * Ordering no longer depends on any of this. Lead Management, auto-assignment
 * and the calling queue all read `lead.importSeq` — the position the lead held
 * in the file it arrived in — which is filled from a Postgres sequence on
 * insert. `create` below therefore needs no ordering logic: creating rows in
 * file order is what puts them in file order. The retry can leave GAPS in that
 * sequence, since a rolled-back transaction does not return the number it took;
 * gaps are harmless, because only the relative order is ever read.
 */
@Injectable()
export class LeadIdService {
  private readonly logger = new Logger(LeadIdService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Serialises id generation across every connection.
   *
   * The sequence is computed as MAX+1 in application code, so two creates that
   * read before either writes both get the same number — routine when an import
   * is running while calls are coming in. A transaction-scoped advisory lock
   * makes the read-then-insert atomic against other CRM instances too, and
   * Postgres releases it at commit or rollback with nothing to clean up.
   *
   * The constant is arbitrary; all that matters is that every caller uses the
   * same one. `pg_advisory_xact_lock` takes a bigint, so this stays well inside
   * a signed 64-bit value.
   */
  private static readonly LOCK_KEY = 4_815_162_342n;

  /** How many times a collision is worth re-deriving the next id. */
  private static readonly MAX_ATTEMPTS = 5;

  /**
   * The next id in the running sequence, e.g. `L-2026-1251` after `L-2026-1250`.
   *
   * Numbering is per-year, which is what the `L-YYYY-N` format means and what
   * this CRM has always done: on 1 January the prefix changes and the sequence
   * starts again at 1. Ids stay unique because the year is part of the id.
   *
   * Only ids that match the canonical shape count toward the maximum, so a
   * legacy `L-M8XK2P9` or a seeded `L-00001` can neither be parsed as a
   * sequence number nor hold the counter back.
   */
  async next(client: Pick<PrismaService, '$queryRaw'> = this.prisma): Promise<string> {
    const year = new Date().getFullYear();
    const prefix = `L-${year}-`;
    // NB: the start position must be cast to ::int. A bound parameter arrives as
    // text, and `SUBSTRING(x FROM <text>)` is read as the POSIX-regex form
    // (pattern) rather than positional extraction — which silently returns NULL,
    // making every generated id collide on "L-YYYY-1". `::int` forces the
    // positional form.
    const rows = await client.$queryRaw<Array<{ max_seq: number | null }>>(Prisma.sql`
      SELECT MAX(
        CAST(SUBSTRING(lead_id FROM ${prefix.length + 1}::int) AS INTEGER)
      ) AS max_seq
      FROM leads
      WHERE lead_id LIKE ${prefix + '%'}
        AND lead_id ~ ${'^L-' + year + '-[0-9]+$'}
    `);
    return `${prefix}${(rows[0]?.max_seq ?? 0) + 1}`;
  }

  /**
   * Create a lead, generating its id unless the caller supplied one.
   *
   * `explicitLeadId` is for an import sheet or an integration that carries its
   * own reference. It is never regenerated: a clash there is the caller's own
   * duplicate and is surfaced rather than silently renumbered.
   *
   * The advisory lock makes concurrent generation safe, so the retry is a
   * backstop for the one case the lock cannot cover — a row inserted by
   * something outside this service (a seed, a migration, a hand-written SQL
   * INSERT) taking the number in between.
   */
  async create(buildData: (leadId: string) => Prisma.LeadCreateInput, explicitLeadId?: string) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          let leadId = explicitLeadId;
          if (!leadId) {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LeadIdService.LOCK_KEY})`;
            leadId = await this.next(tx);
          }
          return tx.lead.create({ data: buildData(leadId) });
        });
      } catch (e) {
        const collided = e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
        if (explicitLeadId || !collided || attempt >= LeadIdService.MAX_ATTEMPTS) throw e;
        this.logger.warn(`Lead ID collision on attempt ${attempt}; regenerating`);
      }
    }
  }
}

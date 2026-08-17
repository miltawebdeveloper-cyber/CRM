// One-off repair for calls recorded TWICE — the duplicate pairs already sitting
// in Call Details.
//
// The bug: `startCall` writes a Call row the moment the agent clicks Call, before
// the provider has an id for it, so that row carries `quoCallId: null`. The
// `call.*` webhook normally claims it (`adoptPendingOutboundCall`). When the
// webhook never lands — a delivery rejected on a signature mismatch, a webhook
// configured after the call, an outage — the row stays unlinked, and the history
// backfill (`QuoSyncService.upsertCall`) then created a SECOND row for the same
// conversation because it only ever matched on `quoCallId`.
//
// The result is one call showing twice: the CRM row carrying the agent's outcome
// and no recording, the synced row carrying the recording, duration and provider
// status but no outcome.
//
// The fix in the code makes the backfill adopt the unlinked row instead of
// creating a second one, so no new pairs appear. This script cleans up the ones
// already written.
//
// The repair: for each pair, keep the CRM row — it is the one the agent's
// outcome, notes and activity trail hang off, and the one every other module
// already references — fold the provider's detail into it, move everything that
// hangs off the synced row across, and delete the synced row.
//
//   keep    = the row with no quoCallId (CRM-created, has the outcome)
//   fold in = quoCallId, status, durationSecs, conversationId, endTime,
//             recordingUrl, transcript, aiSummary
//   move    = recordings, notes, and — where the kept row has none of its own —
//             the AI insight and the voice coaching report
//   delete  = the synced row
//
// The children matter as much as the columns: CallRecording, CallInsight and
// VoiceCoachingReport all cascade on delete, and the synced row is precisely the
// one that carries them (they are generated after a recording syncs). Deleting it
// without moving them first would fix the duplicate by destroying the recording,
// the transcript and the AI summary — the half of the call that only the provider
// ever had. `CallInsight` and `VoiceCoachingReport` are 1:1 on callId, so they
// move only when the kept row has none; where both rows have one the kept row's
// is authoritative and the twin's goes with it. The preview reports both cases.
//
// MATCHING is deliberately narrow, and mirrors what the code now does: same lead,
// same direction, one row linked and one not, started within MATCH_HOURS of each
// other. Two genuine calls to one lead an hour apart are NOT merged — the pair
// must be one linked and one unlinked, which two real calls never are once the
// backfill has run.
//
// USAGE (from the repo root) — dry run first, it changes nothing:
//   DATABASE_URL="<db-url>" npm run -w @crm/database merge-duplicate-calls
//   ... then, once the preview looks right:
//   DATABASE_URL="<db-url>" APPLY=1 npm run -w @crm/database merge-duplicate-calls
//
// Options:
//   MATCH_HOURS=<n>  how far apart the two start times may be. Default 2, the
//                    same window the webhook and backfill adopt on.
//   APPLY=1          write the merges. Without it, preview only.
//
// Re-running is safe: once a pair is merged there is only one row left, and a
// single row matches nothing.
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const DEFAULT_MATCH_HOURS = 2;

interface Merge {
  lead: string;
  keptId: string;
  droppedId: string;
  direction: string;
  keptStart: string;
  droppedStart: string;
  gainedQuoCallId: string;
  gainedDuration: string;
  gainedRecordings: number;
  /** Children that moved, or were dropped because the kept row already had one. */
  movedInsight: 'moved' | 'kept own' | 'none';
  movedCoaching: 'moved' | 'kept own' | 'none';
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set.');
  const apply = process.env.APPLY === '1';
  const matchHours = Number(process.env.MATCH_HOURS ?? DEFAULT_MATCH_HOURS);
  if (!Number.isFinite(matchHours) || matchHours <= 0) {
    throw new Error(`MATCH_HOURS must be a positive number, got: ${process.env.MATCH_HOURS}`);
  }
  const windowMs = matchHours * 60 * 60 * 1000;

  console.log(`Merging duplicate call rows written within ${matchHours}h of each other`);
  console.log(apply ? 'MODE: apply — changes will be written\n' : 'MODE: dry run — nothing will be written\n');

  const prisma = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL) });
  const merges: Merge[] = [];

  try {
    // Only leads that actually have an unlinked row — the pair cannot exist
    // without one, and this keeps the scan off the whole call table.
    const unlinked = await prisma.call.findMany({
      where: { quoCallId: null, leadId: { not: null } },
      orderBy: { startTime: 'asc' },
      select: {
        id: true,
        leadId: true,
        direction: true,
        startTime: true,
        endTime: true,
        durationSecs: true,
        status: true,
        conversationId: true,
        recordingUrl: true,
        transcript: true,
        aiSummary: true,
        insight: { select: { id: true } },
        coachingReport: { select: { id: true } },
        lead: { select: { leadId: true } },
      },
    });

    // A synced row already claimed by an earlier pair must not be claimed again.
    const claimed = new Set<string>();

    for (const crmRow of unlinked) {
      const twin = await prisma.call.findFirst({
        where: {
          leadId: crmRow.leadId,
          direction: crmRow.direction,
          quoCallId: { not: null },
          id: { notIn: Array.from(claimed) },
          startTime: {
            gte: new Date(crmRow.startTime.getTime() - windowMs),
            lte: new Date(crmRow.startTime.getTime() + windowMs),
          },
        },
        // Closest in time wins, so back-to-back attempts pair up correctly.
        orderBy: { startTime: 'asc' },
        select: {
          id: true,
          quoCallId: true,
          status: true,
          durationSecs: true,
          conversationId: true,
          startTime: true,
          endTime: true,
          recordingUrl: true,
          transcript: true,
          aiSummary: true,
          insight: { select: { id: true } },
          coachingReport: { select: { id: true } },
          _count: { select: { recordings: true } },
        },
      });
      if (!twin) continue;
      claimed.add(twin.id);

      // A 1:1 child moves only into an empty slot; the kept row's own is
      // authoritative where it has one.
      const moveInsight = !!twin.insight && !crmRow.insight;
      const moveCoaching = !!twin.coachingReport && !crmRow.coachingReport;

      merges.push({
        lead: crmRow.lead?.leadId ?? crmRow.leadId ?? '—',
        keptId: crmRow.id,
        droppedId: twin.id,
        direction: crmRow.direction ?? '—',
        keptStart: crmRow.startTime.toISOString(),
        droppedStart: twin.startTime.toISOString(),
        gainedQuoCallId: twin.quoCallId ?? '—',
        gainedDuration:
          crmRow.durationSecs == null && twin.durationSecs != null ? `${twin.durationSecs}s` : '—',
        gainedRecordings: twin._count.recordings,
        movedInsight: moveInsight ? 'moved' : twin.insight ? 'kept own' : 'none',
        movedCoaching: moveCoaching ? 'moved' : twin.coachingReport ? 'kept own' : 'none',
      });

      if (!apply) continue;

      // The CRM row survives and takes on everything the synced row knew that it
      // did not. Its OWN values win where it has them: the duration the agent was
      // credited with, and the end time it already recorded, are not overwritten
      // by the provider's.
      await prisma.$transaction([
        // Children first, while the row they hang off still exists. Each of
        // these would otherwise be destroyed by the cascade on the delete below.
        prisma.callRecording.updateMany({ where: { callId: twin.id }, data: { callId: crmRow.id } }),
        // Notes hang off a call as well, and a note written against the synced
        // row would be orphaned by the delete.
        prisma.note.updateMany({ where: { callId: twin.id }, data: { callId: crmRow.id } }),
        ...(moveInsight
          ? [prisma.callInsight.update({ where: { callId: twin.id }, data: { callId: crmRow.id } })]
          : []),
        ...(moveCoaching
          ? [prisma.voiceCoachingReport.update({ where: { callId: twin.id }, data: { callId: crmRow.id } })]
          : []),
        prisma.call.delete({ where: { id: twin.id } }),
        prisma.call.update({
          where: { id: crmRow.id },
          data: {
            quoCallId: twin.quoCallId,
            ...(crmRow.status == null && twin.status != null ? { status: twin.status } : {}),
            ...(crmRow.durationSecs == null && twin.durationSecs != null ? { durationSecs: twin.durationSecs } : {}),
            ...(crmRow.conversationId == null && twin.conversationId != null ? { conversationId: twin.conversationId } : {}),
            ...(crmRow.endTime == null && twin.endTime != null ? { endTime: twin.endTime } : {}),
            ...(crmRow.recordingUrl == null && twin.recordingUrl != null ? { recordingUrl: twin.recordingUrl } : {}),
            ...(crmRow.transcript == null && twin.transcript != null ? { transcript: twin.transcript } : {}),
            ...(crmRow.aiSummary == null && twin.aiSummary != null ? { aiSummary: twin.aiSummary } : {}),
          },
        }),
      ]);
    }

    if (merges.length === 0) {
      console.log('Nothing to merge — no duplicate call pairs found.');
    } else {
      console.table(
        merges.map((m) => ({
          lead: m.lead,
          direction: m.direction,
          kept: m.keptId.slice(0, 8),
          dropped: m.droppedId.slice(0, 8),
          'kept start': m.keptStart,
          'dropped start': m.droppedStart,
          'gains duration': m.gainedDuration,
          'gains recordings': m.gainedRecordings,
          insight: m.movedInsight,
          coaching: m.movedCoaching,
        })),
      );
      const keptOwn = merges.filter((m) => m.movedInsight === 'kept own' || m.movedCoaching === 'kept own');
      if (keptOwn.length > 0) {
        console.log(
          `\nNote: ${keptOwn.length} pair(s) had an AI insight or coaching report on BOTH rows. ` +
            `The kept row's own is authoritative and the duplicate's is removed with its row.`,
        );
      }
      console.log(
        apply
          ? `\nMerged ${merges.length} duplicate pair(s). Each call now has one row.`
          : `\n${merges.length} duplicate pair(s) would be merged. Re-run with APPLY=1 to write them.`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

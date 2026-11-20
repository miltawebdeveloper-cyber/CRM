// One-off repair for leads saved through the lead page's OLD Edit form.
//
// The bug: the form sent every field back on every save, whatever was touched.
// Two of those fields were damaged by the round trip:
//
//  • DATES. First Contact, Last Contact, Next Follow-up and Meeting were
//    pre-filled as `value.slice(0, 10)` — the UTC calendar day, time dropped —
//    and the API read that back as midnight UTC. So fixing a lead's phone number
//    turned a 2:30 pm Eastern follow-up into 7 pm the previous evening. The
//    booked callback (`callbackAt`) was never touched, so the two drifted apart.
//
//  • COMMENTS. The latest comment was sent back too, and the API records every
//    comment it receives as a new trail entry — so each save added a copy.
//
// The fix in the code sends only changed fields and keeps dates on the lead's
// clock. This script repairs what the old form already wrote.
//
// DATES are repaired exactly, from the activity log: every change the old form
// made was logged with the value before and after, and the damage has a precise
// signature — the "after" is the "before" cut to midnight UTC of its own day.
// A field is restored only when that cut is its LATEST logged change, it was
// made before the fix went live, and the lead still holds the damaged value.
// Anything changed since is left alone: the later change wins.
//
// COMMENTS are listed, not removed, unless asked. A copy can't be told apart
// with certainty from a manager genuinely repeating a remark on another day, so
// the preview shows each repeat — flagging the ones made within seconds of a
// logged edit, the strongest sign of the form — and deleting them takes its own
// switch. The earliest entry of a repeated run is always kept.
//
// USAGE (from the repo root) — dry run first, it changes nothing:
//   DATABASE_URL="<db-url>" npm run -w @crm/database repair-lead-edits
//   ... then, once the preview looks right:
//   DATABASE_URL="<db-url>" APPLY=1 FIX_AT=<ISO> ACTOR_EMAIL=<admin email> npm run -w @crm/database repair-lead-edits
//
// Options:
//   FIX_AT=<ISO>         when the fixed Edit form went live. Changes logged at or
//                        after it are never touched — the new form doesn't cut
//                        dates, so a midnight value then was chosen on purpose.
//                        Required with APPLY=1; the dry run defaults to now.
//   ACTOR_EMAIL=<email>  an active admin. Required with APPLY=1: every repair is
//                        written to the lead's activity log under their name.
//   APPLY=1              restore the dates.
//   DEDUPE_COMMENTS=1    with APPLY=1, also delete the repeated comments listed.
//
// Re-running is safe: a restored field no longer holds the damaged value, and a
// deleted copy is no longer there to match.
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  DATE_FIELDS,
  decideDateRepair,
  duplicateComments,
  isDateLabel,
  isMidnightCut,
  latestChanges,
  type DateChange,
  type TrailNote,
} from './lead-edit-repair-rules.js';

const PAGE = 5_000;
const SHOW = 200;

/**
 * Run an `IN (...)` lookup in batches. Postgres allows ~32k bind parameters per
 * statement, and a large book can name more leads than that.
 */
async function inChunks<T>(ids: string[], run: (part: string[]) => Promise<T[]>, size = 10_000): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += size) out.push(...(await run(ids.slice(i, i + size))));
  return out;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set.');
  const apply = process.env.APPLY === '1';
  const dedupe = process.env.DEDUPE_COMMENTS === '1';
  if (apply && !process.env.FIX_AT) throw new Error('FIX_AT is required with APPLY=1 — the time the fixed Edit form went live.');
  if (apply && !process.env.ACTOR_EMAIL) throw new Error('ACTOR_EMAIL is required with APPLY=1 — the admin the repairs are logged under.');
  const fixAt = process.env.FIX_AT ? new Date(process.env.FIX_AT) : new Date();
  if (Number.isNaN(fixAt.getTime())) throw new Error(`FIX_AT is not a date: ${process.env.FIX_AT}`);

  console.log(`Repairing leads saved through the old lead Edit form, before ${fixAt.toISOString()}`);
  if (!process.env.FIX_AT) console.log('(FIX_AT not set — using now. Set it to when the fix went live before applying.)');
  console.log(
    apply
      ? `MODE: apply — dates will be restored${dedupe ? ' and repeated comments deleted' : '; comments are listed only'}\n`
      : 'MODE: dry run — nothing will be written\n',
  );

  const prisma = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL) });
  try {
    const actor = apply
      ? await prisma.user.findFirst({ where: { email: { equals: process.env.ACTOR_EMAIL!, mode: 'insensitive' }, isActive: true, role: 'admin' }, select: { id: true } })
      : null;
    if (apply && !actor) throw new Error(`ACTOR_EMAIL ${process.env.ACTOR_EMAIL} is not an active admin.`);

    // ── Dates ──
    // Every logged change to the four fields, so "latest" is judged against
    // later changes too — including ones made after the fix.
    const changes: DateChange[] = [];
    for (let cursor: string | undefined; ; ) {
      const page = await prisma.activity.findMany({
        where: { action: 'lead_updated', leadId: { not: null }, remarks: { in: Object.keys(DATE_FIELDS) } },
        orderBy: { id: 'asc' },
        take: PAGE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        select: { id: true, leadId: true, remarks: true, oldValue: true, newValue: true, createdAt: true },
      });
      for (const a of page) {
        if (a.leadId && isDateLabel(a.remarks)) {
          changes.push({ activityId: a.id, leadId: a.leadId, label: a.remarks, oldValue: a.oldValue, newValue: a.newValue, createdAt: a.createdAt });
        }
      }
      if (page.length < PAGE) break;
      cursor = page[page.length - 1].id;
    }

    const cuts = [...latestChanges(changes).values()].filter((c) => isMidnightCut(c.oldValue, c.newValue));
    const leads = await inChunks([...new Set(cuts.map((c) => c.leadId))], (part) =>
      prisma.lead.findMany({
        where: { id: { in: part }, deletedAt: null },
        select: { id: true, leadId: true, nextFollowUpDate: true, firstContact: true, lastContact: true, meetingDate: true },
      }),
    );
    const leadById = new Map(leads.map((l) => [l.id, l]));

    const restores: { lead: string; leadUuid: string; label: string; column: (typeof DATE_FIELDS)[keyof typeof DATE_FIELDS]; damaged: Date; to: Date; cutAt: Date }[] = [];
    const skipped: Record<string, number> = {};
    for (const c of cuts) {
      const lead = leadById.get(c.leadId);
      if (!lead) { skipped['lead deleted'] = (skipped['lead deleted'] ?? 0) + 1; continue; }
      const column = DATE_FIELDS[c.label];
      const decision = decideDateRepair(c, lead[column], fixAt);
      if (decision.kind === 'skip') { skipped[decision.reason] = (skipped[decision.reason] ?? 0) + 1; continue; }
      restores.push({ lead: lead.leadId, leadUuid: lead.id, label: c.label, column, damaged: new Date(c.newValue!), to: decision.to, cutAt: c.createdAt });
    }

    console.log(`DATES — ${restores.length} field(s) to restore`);
    if (restores.length) {
      console.table(
        restores.slice(0, SHOW).map((r) => ({
          lead: r.lead,
          field: r.label,
          'cut on': r.cutAt.toISOString(),
          'now (UTC)': r.damaged.toISOString(),
          'restore to (UTC)': r.to.toISOString(),
        })),
      );
      if (restores.length > SHOW) console.log(`… and ${restores.length - SHOW} more.`);
    }
    const skips = Object.entries(skipped);
    if (skips.length) console.log(`Left alone: ${skips.map(([why, n]) => `${n} ${why}`).join(', ')}.`);

    // ── Comments ──
    const managers = await prisma.user.findMany({ where: { role: { in: ['admin', 'team_leader'] } }, select: { id: true } });
    const managerIds = new Set(managers.map((m) => m.id));
    const suspectLeads = await prisma.note.findMany({
      where: { callId: null, createdById: { in: [...managerIds] }, createdAt: { lt: fixAt }, lead: { deletedAt: null } },
      distinct: ['leadId'],
      select: { leadId: true },
    });
    const leadIds = suspectLeads.map((n) => n.leadId);
    const [notes, edits, leadNames] = await Promise.all([
      inChunks(leadIds, (part) =>
        prisma.note.findMany({
          where: { leadId: { in: part } },
          select: { id: true, leadId: true, noteText: true, callId: true, createdById: true, createdAt: true },
        }),
      ),
      inChunks(leadIds, (part) =>
        prisma.activity.findMany({
          where: { action: 'lead_updated', leadId: { in: part }, userId: { in: [...managerIds] }, createdAt: { lt: fixAt } },
          select: { leadId: true, userId: true, createdAt: true },
        }),
      ),
      inChunks(leadIds, (part) => prisma.lead.findMany({ where: { id: { in: part } }, select: { id: true, leadId: true } })),
    ]);
    const editTimes = new Map<string, Date[]>();
    for (const e of edits) {
      const key = `${e.leadId}|${e.userId}`;
      editTimes.set(key, [...(editTimes.get(key) ?? []), e.createdAt]);
    }
    const byLead = new Map<string, TrailNote[]>();
    for (const n of notes) {
      byLead.set(n.leadId, [...(byLead.get(n.leadId) ?? []), { id: n.id, leadId: n.leadId, text: n.noteText, callId: n.callId, createdById: n.createdById, createdAt: n.createdAt }]);
    }
    const leadLabel = new Map(leadNames.map((l) => [l.id, l.leadId]));
    const repeats = [...byLead.values()].flatMap((trail) => duplicateComments(trail, managerIds, fixAt, editTimes));

    console.log(`\nCOMMENTS — ${repeats.length} repeated manual comment(s) by a manager (${repeats.filter((r) => r.nearEdit).length} alongside a logged edit)`);
    if (repeats.length) {
      console.table(
        repeats.slice(0, SHOW).map((r) => ({
          lead: leadLabel.get(r.note.leadId) ?? r.note.leadId,
          comment: r.note.text.length > 48 ? `${r.note.text.slice(0, 47)}…` : r.note.text,
          'first written': r.repeats.createdAt.toISOString(),
          'repeated at': r.note.createdAt.toISOString(),
          'with an edit': r.nearEdit ? 'yes' : '',
        })),
      );
      if (repeats.length > SHOW) console.log(`… and ${repeats.length - SHOW} more.`);
    }

    if (!apply) {
      console.log(
        `\nDry run. Re-run with APPLY=1 FIX_AT=<ISO> ACTOR_EMAIL=<admin> to restore the dates` +
          (repeats.length ? ', adding DEDUPE_COMMENTS=1 to delete the repeated comments as well.' : '.'),
      );
      return;
    }

    // ── Apply ──
    let restored = 0;
    for (const r of restores) {
      // Guarded on the damaged value, so a field changed while this ran — by a
      // call, the rollover or a person — is never overwritten.
      await prisma.$transaction(async (tx) => {
        const res = await tx.lead.updateMany({ where: { id: r.leadUuid, [r.column]: r.damaged }, data: { [r.column]: r.to } });
        if (res.count === 0) return;
        restored++;
        await tx.activity.create({
          data: {
            leadId: r.leadUuid,
            userId: actor!.id,
            action: 'lead_updated',
            oldValue: r.damaged.toISOString(),
            newValue: r.to.toISOString(),
            remarks: `${r.label} restored by repair — the old edit form had cut it to midnight UTC`,
          },
        });
      });
    }
    console.log(`\nRestored ${restored} of ${restores.length} date field(s).`);

    if (dedupe && repeats.length) {
      const perLead = new Map<string, string[]>();
      for (const r of repeats) perLead.set(r.note.leadId, [...(perLead.get(r.note.leadId) ?? []), r.note.id]);
      let removed = 0;
      for (const [leadId, ids] of perLead) {
        await prisma.$transaction(async (tx) => {
          const res = await tx.note.deleteMany({ where: { id: { in: ids }, leadId } });
          removed += res.count;
          if (res.count) {
            await tx.activity.create({
              data: {
                leadId,
                userId: actor!.id,
                action: 'lead_updated',
                remarks: `Removed ${res.count} repeated comment(s) left by the old edit form (repair)`,
              },
            });
          }
        });
      }
      console.log(`Deleted ${removed} repeated comment(s).`);
    } else if (repeats.length) {
      console.log('Repeated comments were listed only. Add DEDUPE_COMMENTS=1 to delete them.');
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

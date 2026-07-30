// One-off repair for callbacks and Zoom meetings booked BEFORE scheduling was
// taught to read times in the lead's own time zone.
//
// The bug: the pickers post a bare wall clock ("2026-08-01T16:00"), meaning that
// time where the CUSTOMER is. Before the fix the API ran it through `new Date()`,
// which resolves a bare wall clock in the SERVER's zone — and the Zoom form went
// further and converted in the BROWSER's zone before sending. So a 4pm Eastern
// callback booked from an IST server was stored as 4pm IST: the same wall clock,
// the wrong instant, out by the difference between the two zones.
//
// The repair: recover the wall clock the user actually typed by rendering the
// stored instant back in the zone it was wrongly read in, then re-read that wall
// clock in the lead's zone — which is what the fixed code would have done.
//
//   typed        = format(stored, WRONG_ZONE)
//   corrected    = parse(typed, lead.timezone)
//
// Only rows written before the fix are touched, matched on `createdAt` (and, for
// leads, `updatedAt` — a callback set after the fix is already right even on an
// older lead). Rows whose zone happened to match need no change and are skipped.
//
// USAGE (from the repo root) — dry run first, it changes nothing:
//   DATABASE_URL="<db-url>" npm run -w @crm/database fix-schedule-timezones
//   ... then, once the preview looks right:
//   DATABASE_URL="<db-url>" APPLY=1 npm run -w @crm/database fix-schedule-timezones
//
// Options:
//   FIX_AT=<ISO>     when the fix was deployed. Rows written at or after this are
//                    left alone. Default: the commit date of the fix.
//   WRONG_ZONE=<IANA> the zone the old code resolved times in — normally the API
//                    server's own zone. Default: this machine's zone.
//   APPLY=1          write the corrections. Without it, preview only.
//
// Re-running is safe: once a row is corrected it is older than nothing and newer
// than nothing, so run it once per database and check the preview each time.
import { PrismaClient, Timezone } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

/** When the scheduling fix landed (commit f32bc6f). Rows from before it are suspect. */
const DEFAULT_FIX_AT = '2026-07-27T12:33:24Z';

/**
 * Lead zone → IANA zone. Mirrors apps/crm-api/src/common/timezone.ts, which is
 * the source of truth; duplicated here so this one-off script stays standalone
 * and does not depend on the API being built.
 */
const IANA: Record<Timezone, string> = {
  EST: 'America/New_York',
  CST: 'America/Chicago',
  MST: 'America/Denver',
  PST: 'America/Los_Angeles',
};

/** The zone's UTC offset in ms at a given instant — DST falls out of this. */
function offsetMsAt(instant: Date, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(instant);
  const get = (t: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === t)?.value ?? '0');
  const hour = get('hour') % 24; // some ICU builds render midnight as 24
  return Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second')) - instant.getTime();
}

/** The wall clock an instant reads as in `zone` — what the user originally typed. */
function wallClockIn(instant: Date, zone: string): string {
  const shifted = new Date(instant.getTime() + offsetMsAt(instant, zone));
  return shifted.toISOString().slice(0, 19); // YYYY-MM-DDTHH:mm:ss
}

/** Read a wall clock as an instant in `zone`. Two passes, for DST boundaries. */
function parseInZone(wall: string, zone: string): Date {
  const [y, mo, d, h, mi, s] = wall.split(/[-T:]/).map(Number);
  const asIfUtc = Date.UTC(y, mo - 1, d, h, mi, s || 0);
  const firstPass = new Date(asIfUtc - offsetMsAt(new Date(asIfUtc), zone));
  return new Date(asIfUtc - offsetMsAt(firstPass, zone));
}

interface Change {
  table: string;
  id: string;
  ref: string;
  field: string;
  leadZone: string;
  from: string;
  to: string;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set.');
  const apply = process.env.APPLY === '1';
  const fixAt = new Date(process.env.FIX_AT ?? DEFAULT_FIX_AT);
  const wrongZone = process.env.WRONG_ZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (Number.isNaN(fixAt.getTime())) throw new Error(`FIX_AT is not a valid date: ${process.env.FIX_AT}`);

  console.log(`Repairing schedules written before ${fixAt.toISOString()}`);
  console.log(`Assuming the old code resolved them in: ${wrongZone}`);
  console.log(apply ? 'MODE: apply — changes will be written\n' : 'MODE: dry run — nothing will be written\n');

  const prisma = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL) });
  const changes: Change[] = [];

  /** Correct one instant, or null when the two zones agree at that moment. */
  const correct = (stored: Date, leadZone: Timezone | null | undefined) => {
    const zone = IANA[leadZone ?? Timezone.EST];
    const fixed = parseInZone(wallClockIn(stored, wrongZone), zone);
    return fixed.getTime() === stored.getTime() ? null : fixed;
  };
  const show = (d: Date, leadZone: Timezone | null | undefined) =>
    `${d.toISOString()} (${wallClockIn(d, IANA[leadZone ?? Timezone.EST]).slice(11, 16)} local)`;

  try {
    // ── Lead callbacks ──
    // `updatedAt` too: a callback re-set after the fix is already correct even
    // though the lead itself is older.
    const leads = await prisma.lead.findMany({
      where: { callbackAt: { not: null }, createdAt: { lt: fixAt }, updatedAt: { lt: fixAt } },
      select: { id: true, leadId: true, timezone: true, callbackAt: true },
    });
    for (const l of leads) {
      const fixed = correct(l.callbackAt!, l.timezone);
      if (!fixed) continue;
      // `?? 'EST'` matches what `correct`/`show` assumed for a lead with no zone
      // — this script predates zones being nullable and only ever reports.
      changes.push({ table: 'lead', id: l.id, ref: l.leadId, field: 'callbackAt', leadZone: l.timezone ?? 'EST', from: show(l.callbackAt!, l.timezone), to: show(fixed, l.timezone) });
      if (apply) await prisma.lead.update({ where: { id: l.id }, data: { callbackAt: fixed } });
    }

    // ── Zoom meetings (and the task that mirrors the meeting time) ──
    const meetings = await prisma.zoomMeeting.findMany({
      where: { createdAt: { lt: fixAt } },
      select: { id: true, scheduledAt: true, followUpAt: true, taskId: true, lead: { select: { leadId: true, timezone: true } } },
    });
    for (const m of meetings) {
      const zone = m.lead?.timezone;
      const ref = m.lead?.leadId ?? m.id;
      const fixedAt = correct(m.scheduledAt, zone);
      if (fixedAt) {
        changes.push({ table: 'zoomMeeting', id: m.id, ref, field: 'scheduledAt', leadZone: zone ?? 'EST', from: show(m.scheduledAt, zone), to: show(fixedAt, zone) });
        if (apply) {
          await prisma.zoomMeeting.update({ where: { id: m.id }, data: { scheduledAt: fixedAt } });
          // The linked task's due date is the meeting time — keep them together.
          if (m.taskId) await prisma.task.update({ where: { id: m.taskId }, data: { dueDate: fixedAt } });
        }
      }
      if (m.followUpAt) {
        const fixedFollow = correct(m.followUpAt, zone);
        if (fixedFollow) {
          changes.push({ table: 'zoomMeeting', id: m.id, ref, field: 'followUpAt', leadZone: zone ?? 'EST', from: show(m.followUpAt, zone), to: show(fixedFollow, zone) });
          if (apply) await prisma.zoomMeeting.update({ where: { id: m.id }, data: { followUpAt: fixedFollow } });
        }
      }
    }

    // ── Note follow-up dates ──
    const notes = await prisma.note.findMany({
      where: { nextFollowupDate: { not: null }, createdAt: { lt: fixAt } },
      select: { id: true, nextFollowupDate: true, lead: { select: { leadId: true, timezone: true } } },
    });
    for (const n of notes) {
      const zone = n.lead?.timezone;
      const fixed = correct(n.nextFollowupDate!, zone);
      if (!fixed) continue;
      changes.push({ table: 'note', id: n.id, ref: n.lead?.leadId ?? n.id, field: 'nextFollowupDate', leadZone: zone ?? 'EST', from: show(n.nextFollowupDate!, zone), to: show(fixed, zone) });
      if (apply) await prisma.note.update({ where: { id: n.id }, data: { nextFollowupDate: fixed } });
    }

    if (changes.length === 0) {
      console.log('Nothing to repair — no schedules were written before the fix.');
    } else {
      console.table(changes.map((c) => ({ table: c.table, lead: c.ref, field: c.field, zone: c.leadZone, from: c.from, to: c.to })));
      console.log(
        apply
          ? `\nRepaired ${changes.length} value(s).`
          : `\n${changes.length} value(s) would be repaired. Re-run with APPLY=1 to write them.`,
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

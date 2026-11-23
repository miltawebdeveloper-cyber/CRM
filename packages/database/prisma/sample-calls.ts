/**
 * Sample calls for a LOCAL database — so the Calling Panel's Analytics tab,
 * Calls Made and the dashboard have something to show.
 *
 *   npx tsx prisma/sample-calls.ts inspect   — what's there (read-only)
 *   npx tsx prisma/sample-calls.ts seed      — add ~4 weeks of calls
 *   npx tsx prisma/sample-calls.ts remove    — delete every sample call, and nothing else
 *
 * Every row it writes carries `providerSid = 'sample-data'` (a column nothing
 * in the app reads), which is how `remove` finds them. It writes calls only —
 * no leads, users, outcomes, targets or settings are created or changed — on
 * each rep's own assigned leads, with outcomes from the configured list.
 *
 * Refuses to run against anything but a database on this machine.
 */
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { PrismaClient, Role, CommDirection } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

// Run from packages/database, like seed.ts: the repo's .env is two levels up.
loadEnv({ path: resolve(process.cwd(), '../../.env') });

const MARK = 'sample-data';
const url = process.env.DATABASE_URL ?? '';
const host = url.match(/@([^:/?]+)/)?.[1] ?? '';
if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
  console.error(`Refusing: DATABASE_URL points at "${host || 'nothing'}", not this machine.`);
  process.exit(1);
}
const prisma = new PrismaClient({ adapter: new PrismaPg(url) });

/** Deterministic, so a re-seed gives the same picture. */
let seed = 20261121;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const pickWeighted = <T,>(items: [T, number][]): T => {
  let x = rnd() * items.reduce((a, [, w]) => a + w, 0);
  for (const [v, w] of items) if ((x -= w) <= 0) return v;
  return items[0][0];
};

/** A wall-clock time in New York (the CRM's business zone) as a UTC instant. */
function nyInstant(y: number, m: number, d: number, h: number, min: number): Date {
  const guess = new Date(Date.UTC(y, m, d, h, min));
  const ny = new Date(guess.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const utc = new Date(guess.toLocaleString('en-US', { timeZone: 'UTC' }));
  return new Date(guess.getTime() + (utc.getTime() - ny.getTime()));
}

async function inspect() {
  const [reps, outcomes, calls, sample, assigned] = await Promise.all([
    prisma.user.findMany({ where: { role: Role.employee, isActive: true }, select: { id: true, name: true } }),
    prisma.outcome.findMany({ select: { slug: true, category: true, isActive: true } }),
    prisma.call.count(),
    prisma.call.count({ where: { providerSid: MARK } }),
    prisma.lead.groupBy({ by: ['assignedToId'], where: { deletedAt: null, assignedToId: { not: null } }, _count: { _all: true } }),
  ]);
  const held = new Map(assigned.map((a) => [a.assignedToId, a._count._all]));
  console.log(`database host: ${host}`);
  console.log(`active employees: ${reps.length}`);
  for (const r of reps) console.log(`  - ${r.name}: ${held.get(r.id) ?? 0} assigned leads`);
  console.log(`outcomes: ${outcomes.length} (${outcomes.filter((o) => o.category).length} with a group)`);
  console.log(`calls: ${calls} (sample: ${sample})`);
}

async function seedCalls() {
  const existing = await prisma.call.count({ where: { providerSid: MARK } });
  if (existing > 0) {
    console.error(`There are already ${existing} sample calls. Run "remove" first.`);
    process.exit(1);
  }
  const reps = await prisma.user.findMany({ where: { role: Role.employee, isActive: true }, select: { id: true, name: true } });
  const outcomes = await prisma.outcome.findMany({ where: { isActive: true }, select: { slug: true, category: true } });
  const bySlug = new Map(outcomes.map((o) => [o.slug, o.category]));
  const want: [string | null, number][] = [
    ['no_answer', 18], ['voice_mail', 9], ['answering_machine', 5], ['not_available', 4], ['disconnected', 2], ['wrong_number', 2],
    ['call_back', 10], ['email', 4], ['opposite_call_back', 2], ['zoom', 2], ['negotiation', 3],
    ['meeting_scheduled', 3], ['follow_up_required', 4], ['follow_up_1', 3], ['follow_up_2', 2],
    ['closed_won', 2], ['closed_lost', 2], ['not_interested', 6], ['dm_not_interested', 2], [null, 12],
  ];
  // Only outcomes this database has.
  const weights = want.filter(([slug]) => slug === null || bySlug.has(slug));
  const reached = (slug: string | null) => !!slug && !!bySlug.get(slug) && bySlug.get(slug) !== 'cold';

  const now = new Date();
  const today = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const rows: Parameters<typeof prisma.call.createMany>[0]['data'] = [];

  for (const rep of reps) {
    const leads = await prisma.lead.findMany({ where: { assignedToId: rep.id, deletedAt: null }, select: { id: true, phone: true }, take: 400 });
    if (leads.length === 0) {
      console.log(`  ${rep.name}: no assigned leads — skipped`);
      continue;
    }
    // Some reps busier than others, so the team comparison has a spread.
    const pace = 0.55 + rnd() * 0.75;
    let n = 0;
    for (let back = 27; back >= 0; back--) {
      const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back);
      const wd = day.getDay();
      if (wd === 0) continue; // no Sunday calling
      const count = Math.round((wd === 6 ? 6 : 24) * pace * (0.7 + rnd() * 0.6));
      for (let i = 0; i < count; i++) {
        const start = nyInstant(day.getFullYear(), day.getMonth(), day.getDate(), 9 + Math.floor(rnd() * 9), Math.floor(rnd() * 60));
        if (start > now) continue; // nothing in the future
        const outcome = pickWeighted(weights);
        const inbound = rnd() < 0.1;
        const answered = outcome ? reached(outcome) : rnd() < 0.3;
        const secs = answered ? 45 + Math.floor(rnd() * 560) : outcome === 'voice_mail' ? 20 + Math.floor(rnd() * 25) : Math.floor(rnd() * 18);
        const lead = leads[Math.floor(rnd() * leads.length)];
        rows.push({
          leadId: lead.id,
          callerId: rep.id,
          startTime: start,
          endTime: new Date(start.getTime() + secs * 1000),
          durationSecs: secs,
          externalNumber: lead.phone,
          outcome,
          direction: inbound ? CommDirection.inbound : CommDirection.outbound,
          status: answered || inbound ? 'completed' : pickWeighted<string>([['no-answer', 7], ['completed', 2], ['busy', 1]]),
          providerSid: MARK,
        });
        n++;
      }
    }
    console.log(`  ${rep.name}: ${n} calls`);
  }
  for (let i = 0; i < rows.length; i += 1000) await prisma.call.createMany({ data: rows.slice(i, i + 1000) });
  console.log(`Added ${rows.length} sample calls (providerSid = '${MARK}').`);
}

async function removeCalls() {
  const { count } = await prisma.call.deleteMany({ where: { providerSid: MARK } });
  console.log(`Removed ${count} sample calls.`);
}

const mode = process.argv[2];
(mode === 'seed' ? seedCalls() : mode === 'remove' ? removeCalls() : inspect())
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

// Sample leads, with a call history to match, for testing Lead Management,
// Follow-ups, the dashboard and the Calling Panel's Analytics on a LOCAL
// database.
//
// Every row it adds is tagged: lead IDs start with SAMPLE- and the lead
// source is "Sample data". Removing them removes everything hanging off them
// (calls, assignments, notes, activity — all cascade from the lead), and
// nothing else.
//
//   npm run -w @crm/database sample-data             preview — changes nothing
//   APPLY=1  npm run -w @crm/database sample-data    add the sample set
//   REMOVE=1 npm run -w @crm/database sample-data    delete the sample set
//
// It refuses any database that isn't on this machine (localhost / 127.0.0.1)
// unless ALLOW_REMOTE=1 — sample leads have no business on a live CRM.
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { CommDirection, LeadStatus, PrismaClient, Role } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

loadEnv({ path: resolve(process.cwd(), '../../.env') });

const PREFIX = 'SAMPLE-';
const SOURCE = 'Sample data';
const LEADS = 120;

// ── Deterministic randomness, so two runs give the same set ──
let seed = 20261121;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];

// ── Places: state, city, the lead's zone code, its UTC offset in November, area code ──
const PLACES = [
  ['NY', 'New York', 'EST', -5, '212'], ['NY', 'Buffalo', 'EST', -5, '716'], ['FL', 'Miami', 'EST', -5, '305'],
  ['FL', 'Orlando', 'EST', -5, '407'], ['GA', 'Atlanta', 'EST', -5, '404'], ['NC', 'Charlotte', 'EST', -5, '704'],
  ['NJ', 'Newark', 'EST', -5, '973'], ['MA', 'Boston', 'EST', -5, '617'], ['TX', 'Dallas', 'CST', -6, '214'],
  ['TX', 'Houston', 'CST', -6, '713'], ['IL', 'Chicago', 'CST', -6, '312'], ['MN', 'Minneapolis', 'CST', -6, '612'],
  ['TN', 'Nashville', 'CST', -6, '615'], ['CO', 'Denver', 'MST', -7, '303'], ['AZ', 'Phoenix', 'MST', -7, '602'],
  ['UT', 'Salt Lake City', 'MST', -7, '801'], ['CA', 'Los Angeles', 'PST', -8, '213'], ['CA', 'San Diego', 'PST', -8, '619'],
  ['WA', 'Seattle', 'PST', -8, '206'], ['OR', 'Portland', 'PST', -8, '503'],
] as const;

const FIRST = ['Maria', 'James', 'Linda', 'Robert', 'Patricia', 'Michael', 'Jennifer', 'David', 'Susan', 'Daniel', 'Karen', 'Thomas', 'Nancy', 'Kevin', 'Angela', 'Brian', 'Rachel', 'Gary', 'Monica', 'Steven'];
const LAST = ['Alvarez', 'Bennett', 'Coleman', 'Delgado', 'Ellison', 'Foster', 'Garrison', 'Holloway', 'Ingram', 'Jacobs', 'Keller', 'Lawson', 'Moreno', 'Nolan', 'Ortega', 'Prescott', 'Quinn', 'Ramsey', 'Sutton', 'Thornton'];
const NAME_A = ['Brightline', 'Summit', 'Cedar', 'Harbor', 'Keystone', 'Northgate', 'Pinnacle', 'Riverbend', 'Silverleaf', 'Trailhead', 'Bluewater', 'Ironwood', 'Lakeshore', 'Meridian', 'Oakridge', 'Redstone'];
const NAME_B = ['Tax Services', 'Bookkeeping', 'CPA Group', 'Accounting', 'Financial Partners', 'Tax & Advisory', 'Payroll Solutions', 'Business Services'];
const INDUSTRY = ['Tax Preparation Services', 'Bookkeeping Services', 'Accounting Firm', 'Payroll Services', 'Financial Advisory'];
const TITLE = ['Owner', 'Managing Partner', 'Office Manager', 'Principal', 'CFO', 'Operations Lead'];
const SIZE = ['1-10', '11-50', '51-200'];

/**
 * What happens to a lead, start to finish. `final` is the outcome on its last
 * call; earlier calls are attempts (no answer, voicemail, a callback).
 */
type Scenario = 'never' | 'cold' | 'callback' | 'interested' | 'won' | 'lost';
const SCENARIOS: [Scenario, number][] = [['never', 18], ['cold', 24], ['callback', 22], ['interested', 12], ['won', 9], ['lost', 15]];
const FINAL: Record<Exclude<Scenario, 'never'>, readonly string[]> = {
  cold: ['no_answer', 'voice_mail', 'answering_machine', 'not_available'],
  callback: ['call_back', 'call_back', 'opposite_call_back', 'follow_up_required', 'email'],
  interested: ['meeting_scheduled', 'zoom', 'negotiation'],
  won: ['closed_won'],
  lost: ['not_interested', 'not_interested', 'dm_not_interested', 'wrong_number', 'closed_lost'],
};
const ATTEMPTS = ['no_answer', 'no_answer', 'voice_mail', 'answering_machine', 'call_back'];

const DAY = 86_400_000;

/** A business-hours instant (9:00–17:59 lead time) on the UTC calendar day of `day`. */
function atLeadHour(day: Date, offset: number): Date {
  const d = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), int(9, 17) - offset, int(0, 59), int(0, 59)));
  return d;
}
/** A weekday `n` days ago (stepping back off weekends). */
function weekdayAgo(n: number): Date {
  let d = new Date(Date.now() - n * DAY);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d = new Date(d.getTime() - DAY);
  return d;
}
/** Midnight US Eastern today, as an instant — the CRM's business day starts here. */
function businessDayStart(): Date {
  const now = new Date();
  const est = new Date(now.getTime() - 5 * 3600_000);
  return new Date(Date.UTC(est.getUTCFullYear(), est.getUTCMonth(), est.getUTCDate(), 5, 0, 0));
}

function isLocal(url: string): boolean {
  try {
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set (looked in the repo root .env).');
  const host = new URL(url).hostname;
  if (!isLocal(url) && process.env.ALLOW_REMOTE !== '1') {
    console.error(`Refusing: ${host} is not a local database. Sample data is for local testing only (ALLOW_REMOTE=1 to override).`);
    process.exit(1);
  }
  const prisma = new PrismaClient({ adapter: new PrismaPg(url) });
  const mode = process.env.REMOVE === '1' ? 'remove' : process.env.APPLY === '1' ? 'apply' : 'preview';
  const tagged = { leadId: { startsWith: PREFIX } };

  try {
    const existing = await prisma.lead.count({ where: tagged });
    console.log(`Database: ${host}. Sample leads present: ${existing}.`);

    if (mode === 'remove') {
      const calls = await prisma.call.count({ where: { lead: tagged } });
      const { count } = await prisma.lead.deleteMany({ where: tagged });
      console.log(`Removed ${count} sample leads and the ${calls} calls on them (assignments, notes and activity went with them).`);
      return;
    }

    const reps = await prisma.user.findMany({ where: { role: Role.employee, isActive: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
    const admin = await prisma.user.findFirst({ where: { role: Role.admin }, select: { id: true } });
    const outcomes = new Map((await prisma.outcome.findMany({ select: { slug: true, name: true, leadStatus: true } })).map((o) => [o.slug, o]));
    if (!reps.length || !admin) throw new Error('Needs at least one active employee and one admin.');
    const missing = [...new Set([...Object.values(FINAL).flat(), ...ATTEMPTS])].filter((s) => !outcomes.has(s));
    if (missing.length) throw new Error(`These outcomes aren't configured: ${missing.join(', ')}`);

    console.log(`Plan: ${LEADS} leads (about 15% unassigned, the rest shared by ${reps.map((r) => r.name).join(', ')}),`);
    console.log('  statuses across new / in progress / contacted / interested / closed / rejected, callbacks due today,');
    console.log('  overdue and upcoming, and 1–5 calls per worked lead over the last four weeks, some of them today.');
    if (mode === 'preview') {
      console.log('\nPreview only — nothing written. Run with APPLY=1 to add it, REMOVE=1 to take it out again.');
      return;
    }
    if (existing > 0) {
      console.log('\nSample data is already in. Run with REMOVE=1 first to replace it.');
      return;
    }

    const now = Date.now();
    const todayStart = businessDayStart();
    const scenarioPool = SCENARIOS.flatMap(([s, n]) => Array<Scenario>(n).fill(s));
    let calls = 0;
    let todayCalls = 0;

    for (let i = 0; i < LEADS; i++) {
      const [state, city, tz, offset, area] = pick(PLACES);
      const first = pick(FIRST);
      const last = pick(LAST);
      const company = `${pick(NAME_A)} ${pick(NAME_B)}`;
      const unassigned = rnd() < 0.15;
      const rep = unassigned ? null : reps[i % reps.length];
      const scenario: Scenario = unassigned ? 'never' : scenarioPool[i % scenarioPool.length];

      // The calls first, so the lead can be written with the history they imply.
      type PlannedCall = { at: Date; outcome: string | null; secs: number; status: string; inbound: boolean };
      const planned: PlannedCall[] = [];
      if (scenario !== 'never') {
        const n = scenario === 'cold' ? int(1, 3) : int(2, 5);
        const days = Array.from({ length: n }, () => int(1, 27)).sort((a, b) => b - a);
        // Every fourth worked lead gets its latest call today, when there's room before now.
        const today = i % 4 === 0 && now - todayStart.getTime() > 30 * 60_000;
        days.forEach((ago, k) => {
          const isLast = k === n - 1;
          let at = atLeadHour(weekdayAgo(ago), offset);
          if (isLast && today) at = new Date(todayStart.getTime() + rnd() * (now - todayStart.getTime() - 10 * 60_000));
          const outcome = isLast ? pick(FINAL[scenario]) : pick(ATTEMPTS);
          // About one call in twelve has no outcome logged — the Analytics "No outcome" card needs some.
          const unlogged = !isLast && rnd() < 0.12;
          const reached = !['no_answer', 'voice_mail', 'answering_machine', 'not_available', 'wrong_number'].includes(outcome);
          const secs = reached ? int(90, 900) : outcome === 'voice_mail' || outcome === 'answering_machine' ? int(20, 60) : int(0, 20);
          planned.push({
            at,
            outcome: unlogged ? null : outcome,
            secs,
            status: reached || outcome === 'voice_mail' || outcome === 'answering_machine' ? 'completed' : 'no-answer',
            inbound: reached && rnd() < 0.1,
          });
        });
        planned.sort((a, b) => a.at.getTime() - b.at.getTime());
      }

      const lastLogged = [...planned].reverse().find((c) => c.outcome);
      const finalOutcome = lastLogged?.outcome ? outcomes.get(lastLogged.outcome)! : null;
      const status: LeadStatus =
        scenario === 'never' ? LeadStatus.new : ((finalOutcome?.leadStatus as LeadStatus | null) ?? LeadStatus.in_progress);
      const firstAt = planned[0]?.at ?? null;
      const lastAt = planned[planned.length - 1]?.at ?? null;
      const createdAt = new Date((firstAt?.getTime() ?? now) - int(1, 12) * DAY);

      // Callbacks and follow-ups spread across overdue, today and the days ahead.
      let followUp: Date | null = null;
      if (scenario === 'callback' || scenario === 'interested') {
        const slot = i % 5;
        // slot 2 is today: an instant inside today's business day, so 3 pm lead time lands on today's date.
        const base = slot === 0 ? now - int(2, 3) * DAY : slot === 1 ? now - DAY : slot === 2 ? todayStart.getTime() + 3600_000 : now + int(1, 6) * DAY;
        const d = new Date(base);
        followUp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 15 - offset, 0, 0));
      }

      const n = String(i + 1).padStart(4, '0');
      const lead = await prisma.lead.create({
        data: {
          leadId: `${PREFIX}${n}`,
          leadSource: SOURCE,
          businessName: `${company} (${city})`,
          contactName: `${first} ${last}`,
          title: pick(TITLE),
          industry: pick(INDUSTRY),
          companySize: pick(SIZE),
          phone: `+1 (${area}) 555-0${100 + (i % 100)}`,
          email: `${first}.${last}@${company.toLowerCase().replace(/[^a-z]+/g, '')}.example`.toLowerCase(),
          website: `https://${company.toLowerCase().replace(/[^a-z]+/g, '')}.example`,
          state,
          city,
          timezone: tz,
          country: 'USA',
          status,
          callStatus: lastLogged?.outcome ?? null,
          firstContact: firstAt,
          lastContact: lastAt,
          followupCount: planned.length ? planned.length - 1 : null,
          nextFollowUpDate: followUp,
          callbackAt: finalOutcome && lastLogged?.outcome && ['call_back', 'opposite_call_back'].includes(lastLogged.outcome) ? followUp : null,
          lostReason: status === LeadStatus.rejected ? finalOutcome?.name ?? null : null,
          closedAt: status === LeadStatus.closed ? lastAt : null,
          closedById: status === LeadStatus.closed ? rep?.id ?? null : null,
          assignedToId: rep?.id ?? null,
          comments: scenario === 'never' ? null : `Sample lead — ${scenario.replace('_', ' ')} path.`,
          createdAt,
        },
        select: { id: true },
      });

      if (rep) {
        await prisma.assignment.create({
          data: { leadId: lead.id, callerId: rep.id, assignedById: admin.id, batchName: SOURCE, assignedAt: createdAt },
        });
      }
      for (const c of planned) {
        await prisma.call.create({
          data: {
            leadId: lead.id,
            callerId: rep!.id,
            startTime: c.at,
            endTime: new Date(c.at.getTime() + c.secs * 1000),
            durationSecs: c.secs,
            outcome: c.outcome,
            status: c.status,
            direction: c.inbound ? CommDirection.inbound : CommDirection.outbound,
            createdAt: c.at,
          },
        });
        calls++;
        if (c.at >= todayStart) todayCalls++;
      }
    }
    console.log(`\nAdded ${LEADS} sample leads and ${calls} calls (${todayCalls} of them today). Lead IDs ${PREFIX}0001–${PREFIX}${String(LEADS).padStart(4, '0')}.`);
    console.log('Remove them any time with REMOVE=1.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

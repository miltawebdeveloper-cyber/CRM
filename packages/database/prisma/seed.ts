// DB-017 — seed: 1 admin, 3 team leaders, 10 callers, 500 sample leads
// across all states/timezones, plus per-city targets.
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { PrismaClient, Role, Timezone, LeadStatus, User } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcrypt';

loadEnv({ path: resolve(process.cwd(), '../../.env') });

const prisma = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL as string) });

const PASSWORD = 'Passw0rd!';

// Representative US cities grouped by timezone (state, city).
const GEO: Record<Timezone, Array<[string, string]>> = {
  EST: [
    ['Florida', 'Miami'],
    ['Florida', 'Tampa'],
    ['Florida', 'Orlando'],
    ['Florida', 'West Palm Beach'],
    ['New York', 'New York'],
    ['Connecticut', 'Hartford'],
    ['Connecticut', 'Stamford'],
    ['Connecticut', 'New Haven'],
    ['Georgia', 'Atlanta'],
  ],
  CST: [
    ['Texas', 'Houston'],
    ['Texas', 'Dallas'],
    ['Texas', 'Austin'],
    ['Illinois', 'Chicago'],
    ['Tennessee', 'Nashville'],
  ],
  MST: [
    ['Arizona', 'Phoenix'],
    ['Colorado', 'Denver'],
    ['Utah', 'Salt Lake City'],
  ],
  PST: [
    ['California', 'Los Angeles'],
    ['California', 'San Francisco'],
    ['California', 'San Diego'],
    ['Washington', 'Seattle'],
    ['Nevada', 'Las Vegas'],
  ],
};

const STATUSES: LeadStatus[] = [
  LeadStatus.new,
  LeadStatus.new,
  LeadStatus.in_progress,
  LeadStatus.contacted,
  LeadStatus.interested,
  LeadStatus.closed,
  LeadStatus.rejected,
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Unique caller identity per user — the number the customer sees. Every seeded
// user gets a distinct OpenPhone line so outbound calling works out of the box and
// no two employees ever share a caller ID. Real deployments assign these in Admin →
// Users; the seed just guarantees a valid 1:1 mapping for the demo.
const callerNumber = (slot: number) => `+1305555${String(slot).padStart(4, '0')}`;

async function main() {
  console.log('Seeding…');
  const passwordHash = await bcrypt.hash(PASSWORD, 12);

  // ── Users ──────────────────────────────────────────────
  const admin = await prisma.user.upsert({
    where: { email: 'admin@crm.local' },
    update: { openphoneNumber: callerNumber(0) },
    create: { name: 'Admin', email: 'admin@crm.local', passwordHash, role: Role.admin, openphoneNumber: callerNumber(0) },
  });

  for (let i = 1; i <= 3; i++) {
    await prisma.user.upsert({
      where: { email: `leader${i}@crm.local` },
      update: { openphoneNumber: callerNumber(i) },
      create: {
        name: `Team Leader ${i}`,
        email: `leader${i}@crm.local`,
        passwordHash,
        role: Role.team_leader,
        openphoneNumber: callerNumber(i),
      },
    });
  }

  const timezones = Object.keys(GEO) as Timezone[];
  const callers: User[] = [];
  for (let i = 1; i <= 10; i++) {
    const caller = await prisma.user.upsert({
      where: { email: `caller${i}@crm.local` },
      update: { openphoneNumber: callerNumber(10 + i) },
      create: {
        name: `Caller ${i}`,
        email: `caller${i}@crm.local`,
        passwordHash,
        role: Role.employee,
        openphoneNumber: callerNumber(10 + i),
        employee: {
          create: { shiftTimezone: timezones[i % timezones.length], performanceScore: 0 },
        },
      },
    });
    callers.push(caller);
  }

  // ── Targets (per city) ─────────────────────────────────
  for (const tz of timezones) {
    for (const [state, city] of GEO[tz]) {
      await prisma.target.upsert({
        where: { state_city_timezone: { state, city, timezone: tz } },
        update: {},
        create: {
          state,
          city,
          timezone: tz,
          monthlyTarget: 500,
          setById: admin.id,
        },
      });
    }
  }

  // ── 500 leads ──────────────────────────────────────────
  const existing = await prisma.lead.count();
  if (existing === 0) {
    const allCities = timezones.flatMap((tz) => GEO[tz].map(([s, c]) => ({ tz, s, c })));
    const data = Array.from({ length: 500 }).map((_, i) => {
      const g = pick(allCities);
      return {
        leadId: `L-${String(i + 1).padStart(5, '0')}`,
        businessName: `Business ${i + 1} LLC`,
        phone: `+1${Math.floor(2000000000 + Math.random() * 7999999999)}`,
        email: `lead${i + 1}@example.com`,
        state: g.s,
        city: g.c,
        timezone: g.tz,
        status: pick(STATUSES),
        assignedToId: pick(callers).id,
      };
    });
    await prisma.lead.createMany({ data });
    console.log('Created 500 leads.');
  } else {
    console.log(`Skipped leads (already ${existing}).`);
  }

  console.log(`Done. Login with any seeded email + password: ${PASSWORD}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

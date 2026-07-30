// Flush every transactional record from a database, keeping the people and the
// configuration. Written for resetting a deployed environment (Northflank) to an
// empty-but-working CRM: everyone can still sign in, every admin setting stands,
// and there is not a single lead, call or note left.
//
// WHAT SURVIVES
//   users             the accounts themselves, with their password hashes
//   employees         the 1:1 profile hanging off each user (shift zone, targets)
//   user_preferences  per-user table column layouts
//   trusted_devices   the 180-day "remember this device" cookies, so admins are
//                     not locked out behind an OTP round trip after the flush
//   app_settings      the live OTP policy and calling mode — wiping these would
//                     silently reset 2FA configuration
//   outcomes          the admin-configured disposition list. Every call in the
//                     CRM references one by slug, and the Calling Panel cannot
//                     log anything without them
//   targets           per-city monthly targets an admin entered by hand
//
// WHAT GOES
//   Everything else: leads and their whole dependent tree (assignments, calls,
//   insights, recordings, notes, activities, messages, Zoom meetings, Quo sync
//   logs), plus notifications, tasks, productivity logs, AI training sessions,
//   voice coaching reports, work reassignments, and any pending login OTPs.
//
// USAGE (from the repo root) — dry run first, it changes nothing:
//   DATABASE_URL="<northflank-url>" npm run -w @crm/database flush-data
//   ... then, once the preview looks right:
//   DATABASE_URL="<northflank-url>" APPLY=1 npm run -w @crm/database flush-data
//
// Options:
//   APPLY=1        actually truncate. Without it, preview only.
//   I_UNDERSTAND=1 skip the ten-second countdown before an APPLY run.
//
// THIS IS NOT REVERSIBLE. Take a dump first:
//   pg_dump "<northflank-url>" > backup-$(date +%F).sql
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

/**
 * Tables the flush preserves. Listed as data rather than inferred, because
 * "which tables are configuration" is a judgement call that deserves to be
 * written down and reviewed, not derived from a naming convention.
 */
const KEEP = [
  'users',
  'employees',
  'user_preferences',
  'trusted_devices',
  'app_settings',
  'outcomes',
  'targets',
] as const;

/**
 * Tables the flush empties, in one statement.
 *
 * Deliberately NOT `TRUNCATE ... CASCADE`. Cascade would silently pull in any
 * table that references these — including, if this list were ever wrong, one of
 * the KEEP tables. Truncating them together as an explicit list satisfies the
 * foreign keys between them, and Postgres raises "cannot truncate a table
 * referenced in a foreign key constraint" if a referencing table has been left
 * out. A loud failure naming the missing table is exactly the right outcome; a
 * silent extra deletion is not.
 */
const FLUSH = [
  'leads',
  'assignments',
  'work_reassignments',
  'activities',
  'calls',
  'call_insights',
  'call_recordings',
  'notes',
  'messages',
  'quo_sync_logs',
  'zoom_meetings',
  'zoom_meeting_activities',
  'notifications',
  'tasks',
  'productivity_logs',
  'ai_training_sessions',
  'voice_coaching_reports',
  'login_otps',
] as const;

/** Prisma's own migration ledger. Touching it would strand the database. */
const NEVER_TOUCH = ['_prisma_migrations'];

const apply = process.env.APPLY === '1';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set. Pass the target database explicitly:\n' +
      '  DATABASE_URL="<northflank-url>" npm run -w @crm/database flush-data');
    process.exit(1);
  }

  // Name the target back to the operator with the password stripped. Running
  // this against the wrong database is the failure that matters, and "which one
  // am I pointed at" should never be a guess.
  const shown = url.replace(/:\/\/[^@]*@/, '://***@');
  const prisma = new PrismaClient({ adapter: new PrismaPg(url) });

  try {
    console.log(`\nTarget: ${shown}`);
    console.log(apply ? 'MODE:   APPLY — data will be permanently deleted\n' : 'MODE:   dry run — nothing will be written\n');

    // Every table actually present, so a schema that has drifted from this
    // script is reported rather than half-processed.
    const present = (
      await prisma.$queryRawUnsafe<{ tablename: string }[]>(
        `SELECT tablename FROM pg_tables WHERE schemaname = current_schema()`,
      )
    ).map((r) => r.tablename);

    const unknown = present.filter(
      (t) => !FLUSH.includes(t as never) && !KEEP.includes(t as never) && !NEVER_TOUCH.includes(t),
    );
    const missing = FLUSH.filter((t) => !present.includes(t));

    const count = async (t: string) =>
      Number((await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "${t}"`))[0].n);

    console.log('WILL BE EMPTIED');
    let total = 0;
    for (const t of FLUSH) {
      if (!present.includes(t)) { console.log(`  ${t.padEnd(26)} (table not present — skipped)`); continue; }
      const n = await count(t);
      total += n;
      console.log(`  ${t.padEnd(26)} ${n.toLocaleString().padStart(9)}`);
    }
    console.log(`  ${''.padEnd(26)} ${'—'.padStart(9)}\n  ${'TOTAL ROWS'.padEnd(26)} ${total.toLocaleString().padStart(9)}\n`);

    console.log('WILL BE KEPT');
    for (const t of KEEP) {
      if (!present.includes(t)) { console.log(`  ${t.padEnd(26)} (table not present)`); continue; }
      console.log(`  ${t.padEnd(26)} ${(await count(t)).toLocaleString().padStart(9)}`);
    }
    console.log();

    if (missing.length) {
      console.log(`NOTE: listed but absent from this database: ${missing.join(', ')}\n`);
    }
    if (unknown.length) {
      // A table this script has never heard of. Left alone, and reported, so a
      // newer migration cannot be quietly missed by a stale flush list.
      console.log(
        `WARNING: ${unknown.length} table(s) not in either list and therefore LEFT UNTOUCHED:\n` +
        `  ${unknown.join(', ')}\n` +
        `  Add them to FLUSH or KEEP in this script if they should be handled.\n`,
      );
    }

    if (!apply) {
      console.log('Dry run complete — nothing was changed.');
      console.log('Re-run with APPLY=1 to delete the rows listed above. Take a dump first:');
      console.log(`  pg_dump "<url>" > backup-$(date +%F).sql`);
      return;
    }

    if (total === 0) {
      console.log('Nothing to delete — the database is already flushed.');
      return;
    }

    if (process.env.I_UNDERSTAND !== '1') {
      process.stdout.write(`Deleting ${total.toLocaleString()} rows from ${shown} in 10s — Ctrl-C to abort  `);
      for (let i = 10; i > 0; i--) { process.stdout.write(`${i} `); await sleep(1000); }
      console.log('\n');
    }

    // One statement, one transaction: either the whole database is flushed or
    // none of it is. A partial flush would leave orphaned calls and notes whose
    // leads no longer exist.
    const list = FLUSH.filter((t) => present.includes(t)).map((t) => `"${t}"`).join(', ');
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY`);

    console.log('Flushed. Verifying…\n');
    let leftover = 0;
    for (const t of FLUSH) {
      if (!present.includes(t)) continue;
      const n = await count(t);
      leftover += n;
      if (n > 0) console.log(`  !! ${t} still has ${n} row(s)`);
    }
    for (const t of KEEP) {
      if (!present.includes(t)) continue;
      console.log(`  kept ${t.padEnd(24)} ${(await count(t)).toLocaleString().padStart(9)}`);
    }
    console.log(leftover === 0
      ? '\nDone. Every listed table is empty and the kept tables are intact.'
      : `\nWARNING: ${leftover} row(s) survived — investigate before using this database.`);
    console.log('Lead numbering restarts at L-<year>-1, since ids are derived from the leads table.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error('\nFAILED:', e instanceof Error ? e.message : e);
  console.error('Nothing was committed — the truncate runs as a single statement.');
  process.exit(1);
});

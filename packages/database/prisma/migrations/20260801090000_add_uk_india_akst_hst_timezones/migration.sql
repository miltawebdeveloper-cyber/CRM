-- Widen the lead time zone enum beyond the four continental-US zones.
--
-- The CRM now calls into the UK and India as well as Alaska and Hawaii, and a
-- lead in any of those had nowhere honest to sit: the enum only offered
-- EST/CST/MST/PST, so those leads were left with no zone at all (which blocks
-- scheduling outright — see `parseFutureInZone`) or filed under the nearest US
-- zone, which books the callback hours out.
--
-- Values are positioned rather than appended so the enum's sort order matches
-- the order the dropdowns offer them in — UK, India, then the US zones east to
-- west. `GROUP BY timezone` in the analytics breakdown reads off that order, so
-- appending would have put Alaska and Hawaii ahead of Eastern in every chart.
--
-- Adding enum values is purely additive: no existing row changes, and no column
-- default referenced any of these. Postgres 12+ permits ADD VALUE inside the
-- transaction Prisma wraps a migration in, provided the new value is not also
-- USED in that transaction — this migration only declares them.
ALTER TYPE "Timezone" ADD VALUE IF NOT EXISTS 'UK' BEFORE 'EST';
ALTER TYPE "Timezone" ADD VALUE IF NOT EXISTS 'IND' BEFORE 'EST';
ALTER TYPE "Timezone" ADD VALUE IF NOT EXISTS 'AKST' AFTER 'PST';
ALTER TYPE "Timezone" ADD VALUE IF NOT EXISTS 'HST' AFTER 'AKST';

-- Admin-configurable time zones: add timezone_options, seed it from the
-- current fixed enum, then convert Lead/Target/Employee's timezone columns
-- from the enum to plain text so an admin can add a zone without a deploy.
--
-- Values and order are copied verbatim from the enum and from
-- common/timezone.ts's IANA_BY_TIMEZONE/TIMEZONE_LABELS — this is a pure
-- data carry-over, not a behavior change. sort_order preserves the enum's
-- declaration order (UK, IND, then the US zones, then AKST, HST), which is
-- what GROUP BY timezone / the filter dropdowns have always shown.

-- 1) Reference table.
CREATE TABLE "timezone_options" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "code" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "iana_zone" TEXT NOT NULL,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "timezone_options_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "timezone_options_code_key" ON "timezone_options"("code");

INSERT INTO "timezone_options" ("id","code","label","iana_zone","sort_order","updated_at") VALUES
  (gen_random_uuid(),'UK','UK (Europe/London)','Europe/London',10,CURRENT_TIMESTAMP),
  (gen_random_uuid(),'IND','India (Asia/Kolkata)','Asia/Kolkata',20,CURRENT_TIMESTAMP),
  (gen_random_uuid(),'EST','EST (Eastern Standard Time)','America/New_York',30,CURRENT_TIMESTAMP),
  (gen_random_uuid(),'CST','CST (Central Standard Time)','America/Chicago',40,CURRENT_TIMESTAMP),
  (gen_random_uuid(),'MST','MST (Mountain Standard Time)','America/Denver',50,CURRENT_TIMESTAMP),
  (gen_random_uuid(),'PST','PST (Pacific Standard Time)','America/Los_Angeles',60,CURRENT_TIMESTAMP),
  (gen_random_uuid(),'AKST','AKST (Alaska Standard Time)','America/Anchorage',70,CURRENT_TIMESTAMP),
  (gen_random_uuid(),'HST','HST (Hawaii Standard Time)','Pacific/Honolulu',80,CURRENT_TIMESTAMP);

-- 2) Convert the 3 enum-typed columns to text, preserving every existing
--    value verbatim (an enum member casts losslessly to its own text label).
ALTER TABLE "leads" ALTER COLUMN "timezone" TYPE TEXT USING "timezone"::text;

ALTER TABLE "targets" ALTER COLUMN "timezone" TYPE TEXT USING "timezone"::text;

-- DROP DEFAULT before the type change — Postgres refuses to retype a column
-- under an enum-typed default — then restore the (now plain-text) default.
ALTER TABLE "employees" ALTER COLUMN "shift_timezone" DROP DEFAULT;
ALTER TABLE "employees" ALTER COLUMN "shift_timezone" TYPE TEXT USING "shift_timezone"::text;
ALTER TABLE "employees" ALTER COLUMN "shift_timezone" SET DEFAULT 'EST';

-- 3) The enum is now unreferenced. Must be last — Postgres refuses to drop a
--    type still in use by any column.
DROP TYPE "Timezone";

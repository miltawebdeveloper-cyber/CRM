-- Link each time zone to the country it belongs to, and give each country a
-- default zone, so filters can cascade Country -> Time Zone and forms can
-- refuse a pair like India + EST. Soft references (no FK), same as
-- Lead.country. No lead, target or employee row is touched.

ALTER TABLE "timezone_options" ADD COLUMN "country_code" TEXT;
ALTER TABLE "countries" ADD COLUMN "default_timezone" TEXT;

-- India had no country row (no lead carries it yet), but IND is a shipped
-- zone and needs an owner. Code = name, the Phase 1 convention.
INSERT INTO "countries" ("id", "code", "name", "sort_order", "updated_at")
SELECT gen_random_uuid(), 'India', 'India',
       COALESCE((SELECT MAX("sort_order") FROM "countries"), 0) + 10, CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM "countries" WHERE "code" = 'India');

UPDATE "timezone_options" SET "country_code" = 'USA'
  WHERE "code" IN ('EST', 'CST', 'MST', 'PST', 'AKST', 'HST')
    AND EXISTS (SELECT 1 FROM "countries" WHERE "code" = 'USA');
UPDATE "timezone_options" SET "country_code" = 'UK'
  WHERE "code" = 'UK' AND EXISTS (SELECT 1 FROM "countries" WHERE "code" = 'UK');
UPDATE "timezone_options" SET "country_code" = 'India' WHERE "code" = 'IND';

UPDATE "countries" SET "default_timezone" = 'EST' WHERE "code" = 'USA';
UPDATE "countries" SET "default_timezone" = 'UK' WHERE "code" = 'UK';
UPDATE "countries" SET "default_timezone" = 'IND' WHERE "code" = 'India';

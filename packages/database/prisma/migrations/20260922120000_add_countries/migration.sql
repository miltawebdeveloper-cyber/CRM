-- Admin-configurable countries: add the table, seed it from existing lead
-- data so the list starts as exactly what's already on real leads — zero
-- behavior change. Lead.country stays a plain, untouched free-text column;
-- this only adds a reference list behind the create-form dropdown and the
-- Admin → Countries screen.

CREATE TABLE "countries" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "countries_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "countries_code_key" ON "countries"("code");

-- Seed from whatever is already on leads today. TRIM only (no case folding),
-- so the exact stored string on every existing lead still matches its
-- Country row 1:1 — a case-variant like "usa" next to "USA" becomes two
-- separate rows, which is correct for zero-behavior-change even though it
-- reads as a near-duplicate in the admin list (a one-time manual cleanup,
-- not something this migration merges on its own).
INSERT INTO "countries" ("id", "code", "name", "sort_order", "updated_at")
SELECT gen_random_uuid(), v.country, v.country, 0, CURRENT_TIMESTAMP
FROM (
  SELECT DISTINCT TRIM("country") AS country
  FROM "leads"
  WHERE "country" IS NOT NULL AND TRIM("country") <> ''
) v
ORDER BY v.country;

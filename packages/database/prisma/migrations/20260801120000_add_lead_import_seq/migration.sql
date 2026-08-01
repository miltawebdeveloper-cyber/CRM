-- Import Sequence: the position a lead occupied in the spreadsheet it arrived in.
--
-- Lead Management, auto-assignment and the calling queue all needed "the order
-- the file was in" and none of them had it. They used `createdAt` or `leadId`
-- instead, and both are wrong for the job:
--   • `leadId` is a STRING — 'L-2026-10' sorts before 'L-2026-2' — and an import
--     may supply its own ids, so it need not run in file order at all.
--   • `createdAt` has millisecond resolution; a bulk import writes hundreds of
--     rows inside one millisecond, so SQL is free to return those in any order,
--     and did — differently between two reads of the same list.
--
-- Backfill orders existing leads by (created_at, id): the closest thing to the
-- order they arrived in that the current data actually records, and identical to
-- what the list was already showing. `id` breaks ties so the numbering is
-- deterministic rather than whatever the table scan happened to return.
ALTER TABLE "leads" ADD COLUMN "import_seq" INTEGER;

WITH ordered AS (
  SELECT "id", row_number() OVER (ORDER BY "created_at", "id") AS rn FROM "leads"
)
UPDATE "leads" l SET "import_seq" = o.rn FROM ordered o WHERE l."id" = o."id";

-- Owned by the column, so dropping the column later drops the sequence with it.
-- `setval(..., false)` sets the NEXT value to max+1 rather than max+2.
CREATE SEQUENCE "leads_import_seq_seq" OWNED BY "leads"."import_seq";
SELECT setval('"leads_import_seq_seq"', COALESCE((SELECT MAX("import_seq") FROM "leads"), 0) + 1, false);
ALTER TABLE "leads" ALTER COLUMN "import_seq" SET DEFAULT nextval('"leads_import_seq_seq"');
ALTER TABLE "leads" ALTER COLUMN "import_seq" SET NOT NULL;

-- Unique, so the ordering is TOTAL: no two leads can compare equal, which is
-- what stops a paged list showing one lead twice and skipping another at the
-- seam between two chunks, and stops the calling queue reshuffling on refresh.
-- Doubles as the index every default ordering now reads.
CREATE UNIQUE INDEX "leads_import_seq_key" ON "leads"("import_seq");

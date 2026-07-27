-- A provider call may only ever have ONE row. Quo re-delivers events (retries, and
-- workspaces with more than one webhook subscription pointed at the same URL), so
-- without this two concurrent deliveries can each miss the other's insert and log
-- the same call twice. NULL is still allowed many times over — that is the state of
-- a CRM-initiated call that has not yet been linked to its provider call.

-- Collapse any pre-existing duplicates onto the oldest row before the index is
-- created, so this cannot fail on live data.
UPDATE "calls" c
SET "quo_call_id" = NULL
WHERE "quo_call_id" IS NOT NULL
  AND "id" <> (
    SELECT "id" FROM "calls" k
    WHERE k."quo_call_id" = c."quo_call_id"
    ORDER BY k."created_at" ASC, k."id" ASC
    LIMIT 1
  );

-- DropIndex (replaced by the unique one below)
DROP INDEX IF EXISTS "calls_quo_call_id_idx";

-- CreateIndex
CREATE UNIQUE INDEX "calls_quo_call_id_key" ON "calls"("quo_call_id");

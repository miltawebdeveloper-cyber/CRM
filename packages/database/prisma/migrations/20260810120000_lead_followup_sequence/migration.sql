-- A lead's follow-ups, numbered and kept.
--
-- `leads.callback_at` is one column, so booking a second callback wrote over the
-- first. The date went, and with it who had agreed it and what was said — a lead
-- chased five times read as though it had been followed up once, and there was
-- no way to answer "what happened on the second call" because the second call
-- had overwritten the first and then been overwritten itself.
--
-- One row per follow-up instead. `leads.callback_at` stays, pointing at whichever
-- row is currently open: the queue, the reminder cron, the due popup and the
-- Calling Panel all read it, and none of them change.

CREATE TABLE "lead_followups" (
  "id"      UUID NOT NULL DEFAULT gen_random_uuid(),
  "lead_id" UUID NOT NULL,

  -- Position in this lead's sequence, from 1.
  "seq" INTEGER NOT NULL,

  -- When this follow-up is due. Mirrored into leads.callback_at while open.
  "scheduled_at" TIMESTAMP(3) NOT NULL,

  -- Who owed it when it was booked. Held per row rather than read off the lead:
  -- reassigning a lead in March must not rewrite who was responsible in January.
  "assigned_to_id" UUID,

  -- Filled in when the follow-up is worked. All null on an open one, which is
  -- what makes it the open one.
  "outcome"         TEXT,
  "comments"        TEXT,
  "completed_at"    TIMESTAMP(3),
  "completed_by_id" UUID,

  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "lead_followups_pkey" PRIMARY KEY ("id")
);

-- Two callbacks booked at the same moment cannot both become Follow-Up 3. The
-- sequence number is assigned by reading the highest one so far, which is a
-- read-then-write; this is what makes the loser fail loudly instead of both rows
-- claiming the same rung.
CREATE UNIQUE INDEX "lead_followups_lead_id_seq_key" ON "lead_followups" ("lead_id", "seq");

-- The two questions asked of this table: "this lead's sequence, open one first"
-- and "what is due" for the follow-up lists.
CREATE INDEX "lead_followups_lead_id_completed_at_idx" ON "lead_followups" ("lead_id", "completed_at");
CREATE INDEX "lead_followups_scheduled_at_idx" ON "lead_followups" ("scheduled_at");

-- Deleting a lead takes its follow-ups; losing a USER must not. Who made a call
-- leaving the company does not unmake the call, so the attribution goes null and
-- the follow-up stands — the same rule import decisions and closures follow.
ALTER TABLE "lead_followups"
  ADD CONSTRAINT "lead_followups_lead_id_fkey"
  FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "lead_followups"
  ADD CONSTRAINT "lead_followups_assigned_to_id_fkey"
  FOREIGN KEY ("assigned_to_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "lead_followups"
  ADD CONSTRAINT "lead_followups_completed_by_id_fkey"
  FOREIGN KEY ("completed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Backfill ──
--
-- Every lead that already carries a callback gets Follow-Up 1, so the sequence
-- starts from the truth rather than from the next call. It is the only rung that
-- can be recovered: the appointments before it were overwritten by this one and
-- are genuinely gone, which is the defect this table exists to end.
--
-- Completion is read from the column that already records it, so a callback
-- marked done arrives as a completed Follow-Up 1 rather than an open one that
-- would put the lead back in the queue.
INSERT INTO "lead_followups" ("lead_id", "seq", "scheduled_at", "assigned_to_id", "outcome", "completed_at", "completed_by_id", "created_at")
SELECT
  l."id",
  1,
  l."callback_at",
  l."assigned_to",
  -- The disposition standing against the lead is the best available record of
  -- how a completed callback went; an open one has not happened yet.
  CASE WHEN l."callback_completed_at" IS NOT NULL THEN l."call_status" END,
  l."callback_completed_at",
  CASE WHEN l."callback_completed_at" IS NOT NULL THEN l."assigned_to" END,
  COALESCE(l."created_at", CURRENT_TIMESTAMP)
FROM "leads" l
WHERE l."callback_at" IS NOT NULL
  AND l."deleted_at" IS NULL;

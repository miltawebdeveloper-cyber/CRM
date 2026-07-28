-- Processing time for a lead worked from the queue without a call.
--
-- While live calling is switched off the queue times from opening a lead to
-- pressing Save, and that elapsed time stands in for a call duration in the
-- Calls Made log and in reporting. Nullable: every other activity has no
-- duration to speak of, and existing rows predate the timer.
ALTER TABLE "activities" ADD COLUMN "duration_secs" INTEGER;

-- The Calls Made log reads these dispositions by action + time; without this
-- index the no-call rows force a scan of the whole activity feed.
CREATE INDEX "activities_action_created_at_idx" ON "activities" ("action", "created_at");

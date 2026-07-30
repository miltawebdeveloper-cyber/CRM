-- Lead time zone becomes optional.
--
-- `timezone` was NOT NULL DEFAULT 'EST'. That default is what made an import row
-- with a blank or unrecognised zone indistinguishable from a lead deliberately
-- configured as Eastern, so a Texas lead read as EST and got called an hour
-- early. Dropping the default (and the NOT NULL) lets an unconfigured lead be
-- honestly blank; the API refuses to schedule a callback against one until a
-- zone is picked.
--
-- Existing rows keep whatever value they already hold — this migration widens
-- the column and changes nothing that is already stored. Only rows written from
-- here on can be NULL.
ALTER TABLE "leads" ALTER COLUMN "timezone" DROP DEFAULT;
ALTER TABLE "leads" ALTER COLUMN "timezone" DROP NOT NULL;

-- On-screen callback reminder state (the popup), separate from the one-shot
-- e-mail/notification stamps above it. Snooze hides the popup until an instant;
-- Dismiss hides it for this appointment. A reschedule clears both.
ALTER TABLE "leads" ADD COLUMN "callback_snoozed_until" TIMESTAMP(3);
ALTER TABLE "leads" ADD COLUMN "callback_dismissed_at" TIMESTAMP(3);

-- The popup's feed asks for "callbacks still open for this user, soonest
-- first" on a short poll, so give it the same partial index shape the lead list
-- indexes use rather than making it scan every lead.
CREATE INDEX "leads_callback_open_idx"
  ON "leads" ("assigned_to", "callback_at")
  WHERE "callback_at" IS NOT NULL AND "callback_completed_at" IS NULL AND "deleted_at" IS NULL;

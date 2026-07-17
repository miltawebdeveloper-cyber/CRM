-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "closed_at" TIMESTAMP(3),
ADD COLUMN     "closed_by" UUID;

-- CreateIndex
CREATE INDEX "leads_closed_by_idx" ON "leads"("closed_by");

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_closed_by_fkey" FOREIGN KEY ("closed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill leads that were already closed before this column existed, so the
-- Closed Leads module shows them with the right owner instead of blank.
-- `closed_by` comes from the activity that recorded the close (the user who set
-- the status), falling back to the lead's assignee; `closed_at` from that same
-- activity, falling back to the lead's last update.
UPDATE "leads" l
SET "closed_by" = COALESCE(a."user_id", l."assigned_to"),
    "closed_at" = COALESCE(a."created_at", l."updated_at")
FROM (
  SELECT DISTINCT ON ("lead_id") "lead_id", "user_id", "created_at"
  FROM "activities"
  WHERE "action" = 'status_changed' AND "new_value" = 'closed' AND "lead_id" IS NOT NULL
  ORDER BY "lead_id", "created_at" DESC
) a
WHERE l."status" = 'closed' AND a."lead_id" = l."id";

UPDATE "leads"
SET "closed_by" = "assigned_to",
    "closed_at" = "updated_at"
WHERE "status" = 'closed' AND "closed_at" IS NULL;

-- Where clicking a notification goes: a path inside the CRM, such as
-- /leads/<id> or /zoom/<id>. Nullable: older notifications have none.
ALTER TABLE "notifications" ADD COLUMN "link" TEXT;

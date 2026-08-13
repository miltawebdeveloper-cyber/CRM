-- Unknown calls: a call no longer has to belong to a lead.
--
-- An incoming call from a number that matches no lead or contact used to mint a
-- minimal "Unknown caller" lead so the call had somewhere to hang. That put spam,
-- wrong numbers and personal calls straight into Lead Management as new leads.
-- Such a call is now stored with lead_id NULL and listed in Calls Made against
-- external_number, which is the caller's own number and what Call Back dials.
--
-- Existing rows are untouched: dropping NOT NULL widens the column, and
-- external_number is backfilled from the linked lead's phone so every historical
-- call carries the customer number the new call log reads.
ALTER TABLE "calls" ALTER COLUMN "lead_id" DROP NOT NULL;
ALTER TABLE "calls" ADD COLUMN "external_number" TEXT;

UPDATE "calls" c
SET "external_number" = l."phone"
FROM "leads" l
WHERE c."lead_id" = l."id" AND c."external_number" IS NULL;

-- Duplicate detection outside the import, and a memory of what was decided.
--
-- Two separate problems, one migration because they arrive with the same work:
--
--   1. The import was the only door that checked for duplicates. Leads typed
--      into the New Lead form went in unchecked, so the book collected exactly
--      the duplicates the import screen exists to prevent. Checking one new
--      record needs indexes the list-performance migration never had a reason
--      to add, because it indexed for SEARCH, not for equality.
--
--   2. Reviewing a file's duplicates and choosing "import anyway" was worth
--      nothing the second time: re-running the same file asked every question
--      again, with no sign the answer had already been given once.

-- ── 1. Exact-match lookup indexes ──
--
-- Partial (WHERE deleted_at IS NULL) to match every read path, which never
-- looks at deleted rows, and to keep the indexes off rows nothing will match.
--
-- Phone and alt phone are compared AS WRITTEN by the exact rule, so plain btree
-- equality is exactly the right shape. The existing digits trigram indexes from
-- 20260729120000 stay where they are — they serve the looser "ignore
-- formatting" mode and unanchored search, which LIKE needs and btree cannot do.
CREATE INDEX IF NOT EXISTS leads_phone_exact_idx
  ON leads (phone) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS leads_alt_phone_exact_idx
  ON leads (alt_phone) WHERE deleted_at IS NULL;

-- Email is indexed by its DOMAIN, not by the whole normalised address.
--
-- That is deliberate. The address rule folds +tags and (for Gmail only) dots,
-- and writing that rule a second time in SQL is how the two copies drift into
-- disagreeing about who is a duplicate. The domain survives every part of the
-- folding untouched, so a domain match is a strict superset of an address
-- match: the query narrows to candidates with this index, and the one
-- implementation of the folding rule — lead-dedupe.ts — decides among them.
CREATE INDEX IF NOT EXISTS leads_email_domain_idx
  ON leads ((split_part(lower(email), '@', 2))) WHERE deleted_at IS NULL;

-- ── 2. Remembered duplicate decisions ──
--
-- Keyed by the CONTACT POINTS of the row that was ruled on, not by the lead it
-- matched or the file it came from. The same company re-exported next month
-- arrives as a different file, in a different row, very likely matching a
-- different lead — but it is the same question, and the answer given last time
-- is the useful thing to carry forward.
CREATE TABLE "import_duplicate_decisions" (
  "id"          UUID         NOT NULL DEFAULT gen_random_uuid(),
  -- Canonical key built by decisionKey() in lead-dedupe.ts. Written by one
  -- function so the key a decision is saved under and the key it is looked up
  -- by cannot be built differently.
  "match_key"   TEXT         NOT NULL,
  -- 'import' or 'skip' — what the reviewer chose for a row with this key.
  "decision"    TEXT         NOT NULL,
  "decided_by_id" UUID,
  "decided_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "import_duplicate_decisions_pkey" PRIMARY KEY ("id")
);

-- One standing answer per question: deciding again overwrites, so the record is
-- always the MOST RECENT ruling rather than a pile the reader has to date-sort.
CREATE UNIQUE INDEX "import_duplicate_decisions_match_key_key"
  ON "import_duplicate_decisions" ("match_key");

-- Decisions outlive the user who made them: a reviewer leaving must not delete
-- the reasoning behind rows that are still being imported, so the attribution
-- goes null and the decision stands.
ALTER TABLE "import_duplicate_decisions"
  ADD CONSTRAINT "import_duplicate_decisions_decided_by_id_fkey"
  FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

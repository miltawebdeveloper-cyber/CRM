-- Indexes for how the lead modules are actually read.
--
-- Measured on a 50,000-lead book before writing any of this. Every index below
-- earned its place by turning a sequential scan into an index scan; anything
-- that didn't move a real query is not here.
--
--   default Lead Management page   10.3 ms  ->  0.12 ms
--   an employee's own page         11.9 ms  ->  0.10 ms
--   search across the 4 text cols 110.9 ms  ->  0.75 ms
--   phone lookup by digits         91.3 ms  ->  0.36 ms
--
-- Written by hand rather than declared in schema.prisma: partial indexes
-- (WHERE deleted_at IS NULL) and expression indexes (the digits-only phone)
-- have no representation in the Prisma schema language. The schema carries a
-- comment pointing here so the two don't drift.

-- Trigram matching, which is what makes an unanchored ILIKE '%term%' indexable
-- at all. Without it the four searches below fall back to scanning every row.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ── Listing and ordering ──
-- Every lead list filters deleted_at IS NULL and orders by created_at. Partial,
-- so the index holds only live leads and stays small; DESC to match the default
-- ordering exactly, which lets the planner walk it instead of sorting.
CREATE INDEX IF NOT EXISTS leads_active_created_idx
  ON leads (created_at DESC) WHERE deleted_at IS NULL;

-- Lead Management (status <> 'closed') and Closed Leads (status = 'closed') are
-- the same list split by status, so status leads and created_at follows.
CREATE INDEX IF NOT EXISTS leads_active_status_created_idx
  ON leads (status, created_at DESC) WHERE deleted_at IS NULL;

-- An employee is pinned to their own book, so their every page is this index.
CREATE INDEX IF NOT EXISTS leads_active_assigned_created_idx
  ON leads (assigned_to, created_at DESC) WHERE deleted_at IS NULL;

-- ── Search ──
-- One GIN index per searchable column. Postgres combines them with a BitmapOr
-- for the OR the search builds, so all four are served by index in one pass.
CREATE INDEX IF NOT EXISTS leads_business_name_trgm_idx ON leads USING gin (business_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS leads_contact_name_trgm_idx  ON leads USING gin (contact_name  gin_trgm_ops);
CREATE INDEX IF NOT EXISTS leads_email_trgm_idx         ON leads USING gin (email         gin_trgm_ops);
CREATE INDEX IF NOT EXISTS leads_lead_id_trgm_idx       ON leads USING gin (lead_id       gin_trgm_ops);

-- Phone search compares digits to digits, because numbers are stored in whatever
-- shape the import wrote them ("+1 (305) 555-1234" here, "+13055551234" there).
-- The index has to be on the same expression the query uses or it won't be used.
CREATE INDEX IF NOT EXISTS leads_phone_digits_idx
  ON leads USING gin ((regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g')) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS leads_alt_phone_digits_idx
  ON leads USING gin ((regexp_replace(COALESCE(alt_phone, ''), '[^0-9]', '', 'g')) gin_trgm_ops);

-- The planner needs current statistics to choose any of the above.
ANALYZE leads;

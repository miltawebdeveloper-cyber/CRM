-- Indexes for the ordering the lead modules ACTUALLY use.
--
-- The first two performance migrations were written when every lead list was
-- ordered by `created_at`, and their partial indexes say so. The default sort
-- has since moved to `import_seq` (see 20260801120000_add_lead_import_seq): the
-- position a lead held in the file it arrived in, which is unique and therefore
-- makes the ordering total — the property that stops a scrolled list showing one
-- lead twice at a chunk boundary.
--
-- Nothing replaced those indexes when the sort changed, so the DEFAULT list —
-- the one Lead Management opens on, and the one the Calling Panel's queue reads
-- — had an index for the filter and none for the order. Postgres could narrow
-- to the live, non-closed leads quickly and then had to sort every one of them
-- to hand back the first fifty. The cost lands twice per scroll chunk, because
-- the row page and its COUNT run against the same predicate.
--
-- Written by hand for the same reason as the earlier ones: partial indexes
-- (WHERE deleted_at IS NULL) have no representation in schema.prisma.

-- ── The default ordering ──
-- Every module's list is `deleted_at IS NULL` ordered by import_seq. Partial, so
-- it holds only live leads; ASC to match the order exactly, which lets the
-- planner walk it instead of sorting.
CREATE INDEX IF NOT EXISTS leads_active_import_seq_idx
  ON leads (import_seq) WHERE deleted_at IS NULL;

-- Lead Management (status <> 'closed') and Closed Leads (status = 'closed') are
-- one list split by status, so status leads and import_seq follows.
CREATE INDEX IF NOT EXISTS leads_active_status_import_seq_idx
  ON leads (status, import_seq) WHERE deleted_at IS NULL;

-- An employee is pinned to their own book by the API, so every page they ever
-- see is this index — and theirs is the read that suffered most, because the
-- filter selects a small slice which then had to be sorted in full.
CREATE INDEX IF NOT EXISTS leads_active_assigned_import_seq_idx
  ON leads (assigned_to, import_seq) WHERE deleted_at IS NULL;

-- ── The active assignment ──
-- Two reads want the same thing and neither had an index for it: the Scheduled
-- Date column, which takes each listed lead's current assignment, and the
-- `dateField=scheduled` filter, which asks whether that assignment falls in a
-- date range. Both restrict to `is_active`, which is a small fraction of the
-- table — one row per lead against a row per handover ever made — so a partial
-- index on it stays far smaller than the assignments table itself.
CREATE INDEX IF NOT EXISTS assignments_active_lead_assigned_idx
  ON assignments (lead_id, assigned_at DESC) WHERE is_active;

-- The carried-forward count beside it walks a lead's history by type.
CREATE INDEX IF NOT EXISTS assignments_lead_type_idx
  ON assignments (lead_id, type);

-- The planner needs current statistics to choose any of the above.
ANALYZE leads;
ANALYZE assignments;

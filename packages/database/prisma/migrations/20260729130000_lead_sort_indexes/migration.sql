-- Indexes for the grid's other sort columns.
--
-- The first performance migration covered the DEFAULT ordering (created_at) and
-- search. Clicking a different column header still fell back to a sequential
-- scan and a sort of every live lead: measured at ~80 ms for the first 50 rows
-- of 50,000 sorted by company name, and it grows with the book.
--
-- Only the columns the grid actually offers as a sort, and only over live leads,
-- so these stay small. Sorting by assigned user is deliberately absent: it
-- orders by a column on another table, which no index here can serve.
CREATE INDEX IF NOT EXISTS leads_active_business_name_idx ON leads (business_name) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS leads_active_contact_name_idx  ON leads (contact_name)  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS leads_active_call_status_idx   ON leads (call_status)   WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS leads_active_callback_at_idx   ON leads (callback_at)   WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS leads_active_last_contact_idx  ON leads (last_contact)  WHERE deleted_at IS NULL;
-- Closed Leads orders by closure date.
CREATE INDEX IF NOT EXISTS leads_active_closed_at_idx     ON leads (closed_at DESC) WHERE deleted_at IS NULL;

ANALYZE leads;

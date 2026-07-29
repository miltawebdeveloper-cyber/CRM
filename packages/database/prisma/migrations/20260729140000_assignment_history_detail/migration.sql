-- Assignment history that can be read a row at a time.
--
-- `assignments` recorded who a lead went TO and who sent it, but not who held it
-- before, whether this was a first assignment or a transfer, or why. Answering
-- those meant finding the preceding row and assuming none had ever been pruned.
-- The daily assignment restriction needs the "why" in particular: a same-day
-- reassignment is now allowed with explicit confirmation, and the record has to
-- say that a human confirmed it.

CREATE TYPE "AssignmentType" AS ENUM ('new_assignment', 'reassignment');

ALTER TABLE assignments
  ADD COLUMN previous_caller_id UUID REFERENCES users(id),
  ADD COLUMN type "AssignmentType" NOT NULL DEFAULT 'new_assignment',
  ADD COLUMN remarks TEXT;

-- Backfill the existing trail. Each row's predecessor for the same lead is the
-- owner it took over from; a row with no predecessor was a first assignment.
-- Done in one pass rather than row by row so it is safe on a large table.
WITH ordered AS (
  SELECT id,
         LAG(caller_id) OVER (PARTITION BY lead_id ORDER BY assigned_at, id) AS prior_caller
  FROM assignments
)
UPDATE assignments a
SET previous_caller_id = o.prior_caller,
    type = CASE WHEN o.prior_caller IS NULL THEN 'new_assignment' ELSE 'reassignment' END::"AssignmentType",
    remarks = CASE WHEN o.prior_caller IS NULL THEN NULL ELSE 'Reassigned (recorded before assignment reasons were kept)' END
FROM ordered o
WHERE a.id = o.id;

-- The history view reads a lead's rows newest-first, and the daily restriction
-- asks whether any row for a lead falls after midnight. Both are this index.
CREATE INDEX IF NOT EXISTS assignments_lead_id_assigned_at_idx ON assignments (lead_id, assigned_at);
CREATE INDEX IF NOT EXISTS assignments_previous_caller_id_idx ON assignments (previous_caller_id);

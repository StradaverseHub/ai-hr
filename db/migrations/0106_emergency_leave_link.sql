-- Emergency Leave — AL→UPL cascade via decomposition into child requests. Additive column only — no new
-- table, no new RLS: the column is reachable by the existing leave_request FOR ALL tenant +
-- can_see_employment policies (same as 0098's doc-config columns), so grouping reads inherit the request's
-- own access rule.
--
-- Emergency Leave (leave_type.code = 'EMERGENCY') is an APPLICATION TYPE ONLY: it has no balance and no
-- ledger of its own, and NO leave_request row of type EMERGENCY is ever persisted. On submission,
-- requestLeave decomposes an EL application into up to two ordinary child requests over the same dates —
-- an ANNUAL request for the AL-covered portion and an UNPAID request for the remainder. The two children
-- are linked by a UUID minted per EL submission so the UI can group them as one logical absence.
--
--   leave_request.parent_group_id: groups the AL + UPL children produced by one EL submission. NULL for
--     all pre-existing rows and for every ordinary (non-EL) request — only the decomposed EL children
--     carry a (shared) value. A partial index keeps the grouping read cheap and the index small.
ALTER TABLE leave_request ADD COLUMN parent_group_id uuid;--> statement-breakpoint
CREATE INDEX leave_request_parent_group_idx ON leave_request (parent_group_id) WHERE parent_group_id IS NOT NULL;

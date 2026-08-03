-- 0365 — leave_type.override_rules: the Override Leave Application engine's storage (feedback 56910869,
-- absorbing 65f466e2 and fef49b9a).
--
-- WHAT IT HOLDS. An ORDERED array of `{ "trigger": ..., "action": ..., "enabled": bool }` objects — what
-- the system should do when a leave rule is not met. Two triggers ship with it (the notice period not met,
-- and the balance not covering the application) and three actions (convert the application to Emergency
-- Leave, split the uncovered part into unpaid days, or block). Order is HR-visible precedence.
--
-- WHY ON leave_type AND NOT leave_policy. leave_policy supplies DAYS and is the fallback for types that
-- carry no type-level rules; 9816a5ad consolidated the RULES onto the type precisely so one type could not
-- disagree with itself across 57 near-identical policy rows. Putting a behaviour rule back on the policy
-- would re-split what that consolidation joined, and would mean an employee's grade decided whether their
-- short-notice application converts. It sits beside min_advance_days, allow_unpaid_leave and
-- duplicate_application_policy — the other type-level APPLICATION rules — which is where it belongs.
--
-- WHY JSONB AND NOT A TABLE. Several rules per type, each two enumerated fields and a switch, always read
-- as a whole set with the type row that is already being selected, never joined and never filtered on in
-- SQL. That is the same shape as `eligibility`, `day_type_inclusion`, `custom_messages` and
-- `ess_view_config`, all of which live in JSONB on this table and are REPLACED wholesale on write. A table
-- would add a join to every application submission to store at most four rows per type. If the approval
-- list ever needs to FILTER on "was this converted", the answer is a column on leave_request, not a
-- normalised rule table — the audit stamp on the submitted event carries it today.
--
-- ADDITIVE, AND OFF FOR EVERYONE. NULL on every existing row and no default, because NULL is exactly
-- today's behaviour: no rule, so the notice-period refusal and the balance refusal both stand unchanged.
-- Not even a configured rule changes anything until its `enabled` is true — see the engine's
-- normalizeLeaveOverrideRules, which reads a missing/garbage `enabled` as OFF. Nothing is backfilled and
-- no leave type moves on deploy.
--
-- NO GRANT / NO POLICY STATEMENT IS NEEDED HERE and that is deliberate rather than forgotten: this adds a
-- COLUMN to an existing table. leave_type already carries its GRANT to ai_hr_app and its RLS policies from
-- the migration that created it, and both are table-scoped — a new column inherits them. (A migration that
-- creates a TABLE must grant on it explicitly; that is a different case and it is not this one.)
ALTER TABLE leave_type
  ADD COLUMN IF NOT EXISTS override_rules jsonb;
--> statement-breakpoint

-- The only shape guard the database can usefully make. The engine validates the vocabulary (which actions
-- a trigger admits, one enabled action per trigger) with a readable message, and normalizeLeaveOverrideRules
-- drops anything it does not recognise on read — but a non-array here would make every reader's
-- Array.isArray branch the thing standing between HR and a silently ignored configuration. Refuse it at the
-- bottom instead. NULL stays valid: it is what "no rules" means and what every existing row holds.
ALTER TABLE leave_type
  DROP CONSTRAINT IF EXISTS leave_type_override_rules_is_array_check;
--> statement-breakpoint
ALTER TABLE leave_type
  ADD CONSTRAINT leave_type_override_rules_is_array_check
  CHECK (override_rules IS NULL OR jsonb_typeof(override_rules) = 'array');

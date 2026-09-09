-- 9583deac stage two — THE ONE THING THE REQUEST-AND-APPROVE PATH GENUINELY DID NOT HAVE.
--
-- The approved plan promises the reporter: "Rejecting asks for a reason, and the reason is stored and
-- shown to the employee. That part genuinely does not exist today." It was measured before it was
-- promised: `profile_change_request` (migration 0029) carries tenant, employment, person, the `proposed`
-- jsonb, a status enum, decided_by_employment_id and decided_at — and nowhere to put a sentence. An
-- administrator could reject an employee's bank-detail change and the employee learned only that it had
-- been refused. Everything else in stage two is a widening of what already exists; this column is the
-- single new fact in the schema.
--
-- ── WHY `decision_reason` AND NOT `reject_reason` ──────────────────────────────────────────────────
-- The reason is REQUIRED on a rejection (core/profile.ts throws ProfileChangeReasonRequiredError before
-- the transaction opens — the same shape as leave's MissingRejectReasonError) and OPTIONAL on an
-- approval, where an approver may want to record "verified against the bank letter". One column holds
-- both, so the employee's own history reads the same way whichever decision it was, and so a future
-- surface cannot end up with two half-used note columns.
--
-- ── NO RLS OR GRANT CHANGES ARE NEEDED, AND THAT IS A STATEMENT, NOT AN OMISSION ────────────────────
-- This is an ALTER that ADDs one column to an EXISTING table. `profile_change_request` already has
-- ENABLE ROW LEVEL SECURITY and policy `profile_change_request_rls`
-- (tenant_id = app.current_tenant_id() AND app.can_see_employment(employment_id)) from 0029, and that
-- policy is ROW-scoped — a new column is covered by it the moment it exists. The table grant
-- (GRANT SELECT, INSERT, UPDATE, DELETE ON profile_change_request TO ai_hr_app, also 0029) is a
-- table-level privilege with no column list, so it extends to this column too. A CREATE TABLE here would
-- have needed both a policy and a GRANT; an ADD COLUMN needs neither, and saying so is cheaper than
-- somebody re-deriving it during the next incident.
--
-- ── THE CHECK IS `NOT VALID` ON PURPOSE ────────────────────────────────────────────────────────────
-- "A rejected request carries a reason" is the property the plan sells, and a constraint is the only
-- place it cannot be forgotten. But rows rejected BEFORE this migration have no reason and never will —
-- inventing one would be fabricating an administrator's words. `NOT VALID` is exactly that distinction:
-- Postgres enforces the check on every INSERT and on every UPDATE from here on, and does not scan the
-- history. So a rejection made from now on cannot be stored without a reason, and a rejection made last
-- month keeps saying nothing, honestly. (`decideProfileChange` refuses to re-decide a settled request,
-- so no historical row is ever updated back through this constraint.)

ALTER TABLE "profile_change_request" ADD COLUMN "decision_reason" text;--> statement-breakpoint

ALTER TABLE "profile_change_request"
  ADD CONSTRAINT "profile_change_request_reject_reason_ck"
  CHECK (
    "status" <> 'rejected'
    OR ("decision_reason" IS NOT NULL AND btrim("decision_reason") <> '')
  ) NOT VALID;--> statement-breakpoint

COMMENT ON COLUMN "profile_change_request"."decision_reason" IS
  '9583deac stage two - the approver''s words, shown to the EMPLOYEE on My Profile beside their own '
  'request. REQUIRED when status = ''rejected'' (constraint profile_change_request_reject_reason_ck, '
  'NOT VALID so pre-existing rejections are left honestly blank rather than back-filled); optional on '
  'an approval, where it records why the approver was satisfied.';--> statement-breakpoint

-- REPORT, so the release note can state what the switch found rather than assert it.
DO $$
DECLARE total int; rejected_before int;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE status = 'rejected')
    INTO total, rejected_before FROM "profile_change_request";
  RAISE NOTICE '0458 profile-change decision reason: % request(s) on file, % already rejected and left with a NULL reason (expected - the constraint is NOT VALID and nothing is back-filled)',
    total, rejected_before;
END $$;

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
-- ── AND THERE IS DELIBERATELY NO CHECK CONSTRAINT. THE FIRST DRAFT OF THIS FILE HAD ONE. ───────────
-- The rule "a rejected request carries a reason" was written here first, as
--   CHECK (status <> 'rejected' OR btrim(decision_reason) <> '') NOT VALID
-- on the theory that NOT VALID enforces it on every future write while leaving pre-existing rejections
-- honestly blank. The theory was wrong about WHICH future writes, and the adversarial verify pass proved
-- it on a live probe table rather than by reading code:
--
--   A NOT VALID CHECK is still enforced against the NEW ROW VERSION OF EVERY UPDATE. It skips the
--   historical SCAN; it does not skip the row you touch.
--
-- And this table has a SECOND writer that nobody enumerating "who rejects a request?" would think of:
-- `core/pdpa.ts` erasePersonPii does
--   `tx.update(profileChangeRequest).set({ proposed: { redacted: true } }).where(personId = ...)`
-- over EVERY one of the subject's rows, with no status filter, inside the ONE transaction the whole
-- erasure runs in. So on any deployment already holding a rejection with no reason — exactly the legacy
-- rows this migration deliberately leaves blank — a PDPA erasure for that employee would have hit the
-- constraint on the redaction UPDATE and rolled the ENTIRE erasure back. Nothing erased, for a statutory
-- obligation with a deadline, because of a presentation rule about an approver's wording.
--
-- The rule itself is not in doubt and is not weakened: `decideProfileChange` (core/profile.ts) throws
-- ProfileChangeReasonRequiredError BEFORE opening its transaction, both admin surfaces mark the reason
-- `required` on the reject form, and test/me-profile-change-requests.test.ts pins it. What changed is
-- WHERE it lives — at the decision, which is the only place a rejection is ever made, instead of on the
-- row, where every unrelated writer of the row inherits it. A data rule must not be able to take an
-- erasure down with it.

ALTER TABLE "profile_change_request" ADD COLUMN "decision_reason" text;--> statement-breakpoint

COMMENT ON COLUMN "profile_change_request"."decision_reason" IS
  '9583deac stage two - the approver''s words, shown to the EMPLOYEE on My Profile beside their own '
  'request. REQUIRED when status = ''rejected'', enforced at the decision in core/profile.ts '
  '(ProfileChangeReasonRequiredError) and NOT by a table constraint: core/pdpa.ts rewrites every one of '
  'a subject''s rows during an erasure, and a CHECK here would have aborted that erasure over any '
  'pre-existing reasonless rejection. Optional on an approval, where it records why the approver was '
  'satisfied. Erased with the record - erasePersonPii NULLs it alongside the redaction of proposed.';--> statement-breakpoint

-- REPORT, so the release note can state what the switch found rather than assert it.
DO $$
DECLARE total int; rejected_before int;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE status = 'rejected')
    INTO total, rejected_before FROM "profile_change_request";
  RAISE NOTICE '0458 profile-change decision reason: % request(s) on file, % already rejected and left with a NULL reason (expected - nothing is back-filled, and no constraint is added that a later UPDATE of those rows could trip over)',
    total, rejected_before;
END $$;

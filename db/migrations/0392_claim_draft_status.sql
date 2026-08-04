-- e7eb5d83 stage 1 — DRAFT claims, and the schema half of limit RESERVATION.
--
-- ── MEASURED FIRST, BEFORE ANY OF THIS WAS WRITTEN ────────────────────────────────────────────────────
-- Counted on production 2026-08-05: `claim_request` has ZERO ROWS of any status, and no employee has more
-- than one pending claim on a claim type. So this migration is a **no-op on today's data** — there is no
-- over-approved balance to repair, nothing to backfill, and no repair migration anywhere in this change.
-- The fix is PREVENTIVE. Recorded here the way 0386 / 0387 recorded their own measurements, so a future
-- reader does not go looking for the cleanup that "must" have accompanied it.
--
-- ── WHAT THE TICKET SAID, AND WHAT THE CODE ACTUALLY DID ──────────────────────────────────────────────
-- The approved item says limits cap APPROVED claims only, so N pending claims all pass the same check and
-- all become approvable. That is what `claim_policy.annual_budget`'s COMMENT says. It is not what
-- core/claims.ts does: `insertClaimTx` has always summed status IN ('pending','approved','paid'), i.e. a
-- pending claim already consumes limit and a rejected/cancelled one already releases it by dropping out of
-- that set. The reservation is DERIVED from status, and a derived reservation cannot be double-released —
-- there is no counter to decrement twice. The stale comment is corrected in this change; no stored
-- reserved-amount column is added, deliberately, because adding one would introduce exactly the
-- double-release failure the ticket warns about.
--
-- The REAL defect is that none of it is serialized. Two transactions that submit (or approve) at the same
-- moment each read the same sum, neither sees the other's uncommitted row, and both pass. The fix is a
-- transaction-scoped advisory lock per (tenant × employment × claim type) plus SELECT … FOR UPDATE on the
-- claim row being decided — both in core/claims.ts, both released by COMMIT/ROLLBACK, so neither can leak.
-- Nothing about that needs schema, which is why this file is small.
--
-- ── WHY `ALTER TYPE … ADD VALUE` IS THE ONLY ENUM STATEMENT HERE ──────────────────────────────────────
-- drizzle wraps each migration file in ONE transaction. Postgres 16 permits ADD VALUE inside a transaction
-- block, but the new label CANNOT BE USED (cast to, compared as, or inserted as the enum type) in that same
-- transaction — see 0294's header, which split into 0294/0295 for exactly this reason. Nothing below casts
-- a literal to `claim_status`; the CHECK compares the COLUMN cast to text against a plain text constant
-- (`status::text`), which is the same text-literal discipline 0295 used across the boundary. That is legal
-- here and is the only reason this fits in one file.
ALTER TYPE "claim_status" ADD VALUE IF NOT EXISTS 'draft';
--> statement-breakpoint

-- ── THE INVARIANT A DRAFT MUST NEVER BREAK ────────────────────────────────────────────────────────────
-- A draft is a claim that has not been submitted: it reserves no limit, notifies no approver, and is
-- invisible to the approvals inbox and to both payout paths. The payout paths select on
-- status = 'approved' / 'paid', so a draft cannot reach them through the service — but `payroll_batch_id`
-- and `paid_at` are plain nullable columns and a future writer could set them without going through the
-- lifecycle. A draft carrying payout provenance would be a claim that was paid without ever being
-- submitted or approved, which is the worst thing this table can say. Refused at the constraint level.
--
-- Written as `status::text <> 'draft' OR (…)` rather than `status = 'draft'`: casting the COLUMN to text is
-- safe in the same transaction as the ADD VALUE above; casting the LITERAL to claim_status is not.
ALTER TABLE claim_request DROP CONSTRAINT IF EXISTS claim_request_draft_unsettled_check;
--> statement-breakpoint
ALTER TABLE claim_request ADD CONSTRAINT claim_request_draft_unsettled_check
  CHECK (
    status::text <> 'draft'
    OR (decided_at IS NULL AND decided_by_employment_id IS NULL AND payroll_batch_id IS NULL AND paid_at IS NULL)
  );
--> statement-breakpoint

-- Drafts are read as "my drafts" on every visit to /claims, alongside the existing
-- claim_request_employment_idx (employment_id, status) which already serves that shape. No new index.

-- ── GRANTS: NOTHING NEW IS OWED, AND HERE IS WHY THAT IS NOT AN OVERSIGHT ─────────────────────────────
-- The house rule is that a migration CREATING a table must also GRANT on it (production's ALTER DEFAULT
-- PRIVILEGES masks the omission; a dev cluster does not — 0353 shipped without one and answered the first
-- real render with `permission denied`). This migration creates NO table. `claim_request` was granted
-- SELECT/INSERT/UPDATE/DELETE to ai_hr_app in 0048_claims_rls.sql and a new enum LABEL carries no
-- privileges of its own, so there is nothing to grant. Re-stated rather than assumed, because "no GRANT
-- line" and "GRANT line forgotten" look identical in a diff.
--
-- ── RLS: UNCHANGED, DELIBERATELY ─────────────────────────────────────────────────────────────────────
-- `claim_request_rls` (0048) is FOR ALL on tenant_id + app.can_see_employment(employment_id) — it scopes
-- WHO, never WHICH STATUS. A draft is an ordinary claim_request row owned by the claimant, so the existing
-- policy already lets the employee insert, read, update and delete their own, and already lets an admin and
-- the claimant's administrative manager SEE it. Widening or narrowing the policy for drafts would put the
-- state machine in two places. Instead the OWNERSHIP rule for drafts (only the claimant may edit, submit or
-- delete a draft — a manager who can see it may not touch it) lives in core/claims.ts beside every other
-- transition rule, which is the split 0048's own header describes: RLS scopes tenancy + visibility, the
-- service scopes the transition rules. test/claims-draft-reservation.test.ts pins the manager refusal.

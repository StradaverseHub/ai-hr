-- r86 · ae9350f2 — "Movement Type: Termination".
--
-- Two additive, nullable columns on `employment`. Nothing is backfilled and nothing is dropped: an
-- employment terminated before this ships keeps its `termination_type` + free-text `termination_reason`
-- exactly as they are, and reads as "no reason code recorded".
--
-- ── WHY `text` AND NOT AN ENUM ─────────────────────────────────────────────────────────────────────
-- `termination_reason_code` is the reporter's exit-reason master list (Resignation, Redundancy, Misconduct,
-- Contract Expiry, …). The obvious modelling is a Postgres enum beside the existing `termination_type` one.
-- It is deliberately NOT one, for two reasons:
--   1. A new enum value CANNOT be used in the same transaction that added it. This repo has hit that trap.
--      Every future addition to an exit-reason list would then need to be split across two migrations, which
--      is a permanent tax on a list whose whole nature is that it grows.
--   2. Item 476f23ed (PLANNED, not approved) makes movement event types configurable. Whatever it builds will
--      own this list. A column that is plain text can be pointed at a catalogue table later with no type
--      surgery; an enum cannot.
-- The validity rule therefore lives in ONE place on the write path — core/termination-reason.ts — which is
-- also where the mapping onto `termination_type` lives, so the coded reason and the turnover classification
-- can never disagree.
--
-- ── WHY A NOTICE COLUMN AT ALL ────────────────────────────────────────────────────────────────────
-- `employment` already carries CONTRACTUAL notice (resignation_notice_months/days, notice_after_confirmation_*).
-- Those are POLICY: how much notice this person's contract requires. `termination_notice_days` is the notice
-- ACTUALLY served on this exit, which is what final pay and the notice-pay calculation need and which the
-- policy columns cannot express (short notice, notice waived, notice bought out).
--
-- ── WHAT THIS MIGRATION DOES NOT DO ───────────────────────────────────────────────────────────────
-- No status column. Employee Status is DERIVED (migration 0331, core/employment-status.ts) from
-- least(resignation_date, last_working_date, terminated_on) — 0331's header names this item as the writer of
-- that seam and it is honoured here: the Termination movement writes the DATES, and the status follows.

ALTER TABLE employment ADD COLUMN IF NOT EXISTS termination_reason_code text;
ALTER TABLE employment ADD COLUMN IF NOT EXISTS termination_notice_days integer;

COMMENT ON COLUMN employment.termination_reason_code IS
  'ae9350f2 — coded exit reason from the built-in catalogue in core/termination-reason.ts. Plain text, not an enum, so the list can grow in one migration and be repointed at 476f23ed''s catalogue later. Derives employment.termination_type; NULL for terminations recorded before r86.';
COMMENT ON COLUMN employment.termination_notice_days IS
  'ae9350f2 — notice ACTUALLY served on this exit, in days. Distinct from the contractual notice policy columns (resignation_notice_*, notice_after_confirmation_*), which say what the contract requires rather than what happened.';

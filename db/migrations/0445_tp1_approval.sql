-- 7ad37961 — the TP1 record grows a deduction month, an employee declaration, and an employer consent
-- block; AND the already-submitted rows are stamped approved so the payroll feed does not go dark.
--
-- Runs strictly AFTER 0444, which put the three new labels on `tp1_status`. 0444's header is worth
-- reading before touching either file: drizzle replays EVERY pending migration inside ONE transaction,
-- so the file split is NOT what makes the new labels usable here — the type swap in 0444 is.
--
-- ════════════════════════════════════════════════════════════════════════════════════════════════════
-- THE COLUMNS
-- ════════════════════════════════════════════════════════════════════════════════════════════════════
--
-- deduction_month     the official form's own DEDUCTION MONTH box (1–12). NULL on every pre-existing
--                     row: those are whole-year declarations that were never keyed against a month, and
--                     the screen shows them as such rather than inventing a January.
-- declared_at         Section E. A TIMESTAMP, not a boolean — "who confirmed and when" is what the
--                     paper form's Date/Signature pair records, and a bare tick cannot answer it.
-- approved_by         Section F, FK to app_user. The approver's NAME is deliberately not copied here:
--                     it is read through this reference, so a renamed user is never two names on two
--                     screens. approver_position IS stored, because a position is a fact about the
--                     moment of approval and changes under the person.
-- approved_at         Section F date.
-- approved_month      Section F "approved for the deduction of MONTH / YEAR" — the month the approval
-- approved_year       takes effect from, which is NOT necessarily the month claimed.
--
-- ALL NULLABLE, no defaults. A non-volatile ADD COLUMN default is materialised for every existing row
-- (0443's header records the same trap), which here would stamp every historical declaration with an
-- approval date it never had — a false record on a statutory document.
--
-- ════════════════════════════════════════════════════════════════════════════════════════════════════
-- THE BACKFILL, AND WHY IT IS IN THE MIGRATION RATHER THAN IN A SCRIPT
-- ════════════════════════════════════════════════════════════════════════════════════════════════════
--
-- The feed gate moves from status='submitted' to status='approved' (core/payroll.ts
-- prefillTp1FromSelfRelief). Every declaration already in the system is 'submitted'. If nothing stamps
-- them, EVERY EXISTING EMPLOYEE'S RELIEF SILENTLY STOPS on the first payroll run after this deploy — the
-- single highest risk on this item's risk watchlist, and one with no error message attached to it.
--
-- deploy.sh runs MIGRATIONS. It does not run scripts. A backfill written as a script is a backfill that
-- has to be remembered by a human at 11pm, so it is written HERE, where the same command that ships the
-- columns also stamps the rows, and where re-running is a no-op because the WHERE clause no longer
-- matches. (Verification after deploy is still owed and is a read, not a write — see the round's
-- scriptsToRunByHand.)
--
-- WHAT THE BACKFILL ASSERTS, STATED HONESTLY. `approved_at = submitted_at` is not a claim that somebody
-- approved the row at that instant; it is the only timestamp that exists for a declaration that predates
-- the approval workflow, and using now() instead would claim the deploy approved them. `approved_by`
-- stays NULL for the same reason: nobody approved these, the system grandfathered them, and a NULL
-- approver is precisely how that reads on the screen and on the printed form. `approved_month = 1` makes
-- the relief effective from January, which is the behaviour these rows have TODAY — the gate they are
-- crossing must not change what any of them does.
--
-- ONLY status='submitted' IS TOUCHED. A draft stays a draft. There are no other statuses on any row
-- before this migration (the enum had exactly two labels), so the WHERE clause is exhaustive.
--
-- No GRANT: ALTER TABLE ADD COLUMN inherits the table's existing privileges — a GRANT is owed by CREATE
-- TABLE, which this is not. No RLS change: tp1_relief's policy is app.can_see_person(person_id) for both
-- USING and WITH CHECK (self + admin) and is column-blind; it is neither re-stated nor widened here.

ALTER TABLE "tp1_relief"
  ADD COLUMN IF NOT EXISTS "deduction_month" smallint,
  ADD COLUMN IF NOT EXISTS "declared_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "approved_by" uuid REFERENCES "app_user"("id"),
  ADD COLUMN IF NOT EXISTS "approved_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "approved_month" smallint,
  ADD COLUMN IF NOT EXISTS "approved_year" integer,
  ADD COLUMN IF NOT EXISTS "approver_position" text;
--> statement-breakpoint

-- The grandfathering UPDATE. Legal because 0444 CREATED the type carrying 'approved' in this same
-- transaction rather than ADDing a value to a pre-existing one — see 0444's header.
UPDATE "tp1_relief"
   SET "status" = 'approved',
       "approved_at" = COALESCE("submitted_at", "created_at"),
       "approved_month" = 1,
       "approved_year" = "assessment_year"
 WHERE "status" = 'submitted';

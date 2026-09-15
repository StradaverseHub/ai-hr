-- 3fb1a611 (r279) "Leave Credit" — the replacement-leave CREDIT REGISTER gains an HR-minted source and a
-- reason, so a hand-granted credit is a first-class row rather than a ghost.
--
-- ── WHAT THIS IS NOT ─────────────────────────────────────────────────────────────────────────────────
-- It is NOT a new "Leave Credit Ledger" table, and declining that is the load-bearing decision of the
-- round. `leave_ledger` is the single balance authority (core/leave.ts:4499) and `toil_accrual` is the
-- per-lot REGISTER whose `ledger_entry_id` points INTO it (core/toil.ts). The reporter's proposed table
-- maps almost column-for-column onto `toil_accrual`; a second one would give replacement leave three
-- places that each claim to know the balance. This EXTENDS the register instead: two enum values and one
-- nullable text column. No new table, no new expiry framework (0155 built a generic per-leave-type expiry
-- and 0370 removed it as a deliberate reset — per-CREDIT expiry on `toil_accrual` is a different thing and
-- is untouched here).
--
-- ── 1 · toil_accrual_source GAINS 'hr_manual_grant' AND 'adjustment' ──────────────────────────────────
-- Today the column records which of the three EARNING paths minted a credit (roster / auto_approval /
-- employee_request). HR has no way to mint one at all: the only manual route is a `leave_ledger`
-- adjustment from /admin/leave-config/adjustments, which can be posted against ANY leave type and creates
-- a GHOST CREDIT — a balance with no register row, therefore no expiry, no FIFO position and no link to a
-- worked day. `consumeReplacementLeaveTx` already logs exactly that case as `toil.consumption.shortfall`.
-- With these two values an HR grant writes BOTH rows through `bankToilCreditTx`, so expiry, the
-- First-Schedule gate, the freezing and the events stay in ONE place.
--   • 'hr_manual_grant' — an administrator granting a credit for a day nobody claimed.
--   • 'adjustment'      — a correction posted against an existing balance.
--
-- ⚠️ A TYPE SWAP, NOT `ALTER TYPE … ADD VALUE`, and 0448's header records why at length: a value added by
-- ADD VALUE cannot be USED in the same transaction (55P04 `unsafe use of new value`).
--
-- AND THE SCOPE OF "THE SAME TRANSACTION" IS THE WHOLE JOURNAL, which is worth writing down because it is
-- not obvious and it bit this very file. drizzle's `migrate()` wraps EVERY pending migration in ONE
-- transaction (`PgDialect.migrate` → `sql.begin`), so on a fresh database — every `gate:shadow` run, every
-- test bootstrap, every restore — 0001 and 0465 are inside the same BEGIN. The first draft of the NOTICE
-- block below compared `leave_ledger.entry_type` to the literal `'in_lieu_accrual'`, a value that migration
-- 0076 adds to `leave_entry_type`, and it failed with exactly that 55P04 against a real bootstrap. The
-- comparison is cast to `text` for that reason: an enum LABEL added earlier in the same transaction cannot
-- be named, but the column can always be read as text.
--
-- So a `toil_accrual_source` added here by ADD VALUE would be un-nameable by every later migration and by
-- any statement in this one, for the life of a fresh bootstrap. The swap has no such footgun at any
-- distance. `toil_accrual.source` is the type's only column and carries NO default (a legacy row genuinely
-- does not know its path and stays NULL), so it is three statements.
--
-- ── 2 · toil_accrual.note ────────────────────────────────────────────────────────────────────────────
-- The reason line the approved plan promises ("Let HR grant a credit by hand, WITH A REASON"). It lives on
-- the register rather than only on the event because the admin ledger and the employee's own Replacement
-- Leave table read rows, not the event log, and a credit that appeared from nowhere with no stated reason
-- is the thing the reporter complained about. NULLABLE with no backfill and no default: every existing row
-- genuinely has no reason, and inventing one would make the audit trail claim a precision it lacks. Also
-- carries the stated reason of a REVERSAL for the short window before the row is removed.
--
-- ── NO GRANT, NO POLICY CHANGE ───────────────────────────────────────────────────────────────────────
-- Nothing is CREATEd as a table here. A column on an existing table inherits `toil_accrual`'s grants
-- (0076, re-granted 0354) and its RLS policies, which govern by ROW and not by column: `toil_accrual_rls`
-- (0076) keys on `app.can_see_employment` / `app.can_admin_employment`, `toil_accrual_payroll_read` (0314)
-- on `app.can_admin_payroll_employment`, and the RESTRICTIVE `toil_accrual_delete_admin_only` (0314) keys
-- on `app.can_admin_employment`. None of them mentions `source` or `note`.
--
-- That DELETE policy is now load-bearing for the first time. 0314's header says "No application code
-- deletes from this table, so nothing regresses" — this round adds the first such path
-- (`reverseToilCredit`, core/toil.ts), which removes an UNCONSUMED HR-minted credit so that the worked
-- day's overtime becomes payable again. It is money-bearing in both directions and the policy 0314 wrote
-- pre-emptively is exactly the right gate for it: admin-for-company only, never the employee, never the
-- manager, never a payroll partner.
--
-- ── NO CHECK CONSTRAINT, DELIBERATELY (CLAUDE.md §6) ─────────────────────────────────────────────────
-- The rule the new sources introduce is "an HR-minted credit may be reversed only while it is untouched".
-- That is enforced in the SERVICE that decides (`reverseToilCredit`), not in the database: a NOT VALID
-- check still fires on every UPDATE, and `consumeReplacementLeaveTx`, `expireAccrualsTx` and
-- `closeReplacementLeaveYear` all UPDATE this table for reasons that have nothing to do with grants.
--
-- Journal entry: idx 465 (see meta/_journal.json). ⚠️ NUMBERING: the journal holds 380 ENTRIES but its
-- last idx is 464. The count and the number diverged long ago; allocating from `entries.length` would
-- write a `when` below drizzle's watermark and be a SILENT SKIP at exit 0 (CLAUDE.md §6).

DO $$
DECLARE total int; ghosts int;
BEGIN
  SELECT count(*) INTO total FROM toil_accrual;
  -- The ghost credits this round exists to stop being created: a REPLACEMENT-type ledger credit with no
  -- register row behind it. Reported, never repaired here — a backfill would have to invent a worked date
  -- and an expiry for each, which is the fabrication the whole register exists to prevent.
  -- `::text` and not `= 'in_lieu_accrual'` — see the 55P04 note in the header. On a fresh bootstrap this
  -- statement runs in the same transaction that created the label, so it cannot be named directly.
  SELECT count(*) INTO ghosts
    FROM leave_ledger ll
   WHERE ll.entry_type::text = 'in_lieu_accrual'
     AND NOT EXISTS (SELECT 1 FROM toil_accrual ta WHERE ta.ledger_entry_id = ll.id);
  RAISE NOTICE '0465 toil_accrual: % existing credit rows keep their source verbatim (NULL stays NULL); % in_lieu_accrual ledger rows have no register row behind them (pre-existing ghost credits, NOT repaired here).', total, ghosts;
END $$;
--> statement-breakpoint

ALTER TYPE "toil_accrual_source" RENAME TO "toil_accrual_source_pre_0465";
--> statement-breakpoint

CREATE TYPE "toil_accrual_source" AS ENUM('roster', 'auto_approval', 'employee_request', 'hr_manual_grant', 'adjustment');
--> statement-breakpoint

ALTER TABLE "toil_accrual"
  ALTER COLUMN "source" TYPE "toil_accrual_source" USING "source"::text::"toil_accrual_source";
--> statement-breakpoint

DROP TYPE "toil_accrual_source_pre_0465";
--> statement-breakpoint

ALTER TABLE "toil_accrual" ADD COLUMN "note" text;

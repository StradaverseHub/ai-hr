-- 1.2.4 Zakat Deduction (ADR-0058) — a per-employee zakat-via-salary ELECTION, stored on the existing
-- per-person MY statutory row (employee_statutory_my). No new table: zakat opt-in is per-employee MY
-- statutory config and belongs on that row, beside the TP3 / zakat-paid accumulator block. This also
-- means NO new RLS policy is needed — the existing person-scoped policy (employee_statutory_my, from the
-- statutory-identity slice) covers these columns by inheritance (can_see_person to read, is_admin to write),
-- and ai_hr_app already has DML grants on the table, so column adds need none.
--
-- Columns (all additive + back-compat; every existing row defaults to no election):
--   zakat_active           opt-in flag (false ⇒ no zakat regardless of the other fields)
--   zakat_state            one of MY_STATES (display/metadata only; no per-state behaviour in v1)
--   zakat_method           'percent_of_pcb' (fraction of normal monthly MTD, derived live) or 'fixed' (RM)
--   zakat_percent          decimal e.g. 0.0250 = 2.5% (only for percent_of_pcb)
--   zakat_fixed            flat monthly RM amount (only for fixed)
--   zakat_effective_from   INERT display-only — nothing in the calc path filters on it
--   zakat_effective_to     INERT display-only — nothing in the calc path filters on it
--
-- The election offsets PCB per LHDN spec §E.5 (applyZakatOffset, unchanged); the full amount still accrues
-- to the Z accumulator. statutory.my.created/updated already fire on this row's upsert — the service extends
-- that existing event's payload to carry the zakat fields, so NO new aggregate type enters the event log.
--
-- Rollback:
--   ALTER TABLE employee_statutory_my
--     DROP COLUMN zakat_active, DROP COLUMN zakat_state, DROP COLUMN zakat_method,
--     DROP COLUMN zakat_percent, DROP COLUMN zakat_fixed,
--     DROP COLUMN zakat_effective_from, DROP COLUMN zakat_effective_to;
--   DROP TYPE zakat_method;
DO $$ BEGIN
  CREATE TYPE "public"."zakat_method" AS ENUM('percent_of_pcb', 'fixed');
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
ALTER TABLE "employee_statutory_my"
  ADD COLUMN IF NOT EXISTS "zakat_active" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "zakat_state" text,
  ADD COLUMN IF NOT EXISTS "zakat_method" "public"."zakat_method",
  ADD COLUMN IF NOT EXISTS "zakat_percent" numeric(5, 4),
  ADD COLUMN IF NOT EXISTS "zakat_fixed" numeric(12, 2),
  ADD COLUMN IF NOT EXISTS "zakat_effective_from" date,
  ADD COLUMN IF NOT EXISTS "zakat_effective_to" date;

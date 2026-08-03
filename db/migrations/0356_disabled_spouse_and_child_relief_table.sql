-- d64d0df4 — "Tax Information", the remaining two employee circumstances.
--
-- Both columns are ADDITIVE and carry a default that reproduces today's behaviour exactly, so every
-- existing row is byte-identical after this migration and NO employee's PCB moves on the day it ships.
-- That is the promise the approved plan makes to the reporter in as many words.
--
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- (1) disabled_spouse
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
--
-- Whether the employee's SPOUSE is a registered disabled individual (OKU). Like disabled_individual
-- (migration 0341) this is a CIRCUMSTANCE and therefore tenant data; the RELIEF AMOUNT it entitles the
-- employee to is statutory and lives only in the country pack's ruleset
-- (localization/my/statutory-tables.ts `MY_RELIEFS.disabledSpouse`, applied by pcbMonth). Nothing about
-- this column makes a legislated figure tenant-editable.
--
-- SCOPE OF EFFECT: the deduction is gated to tax category 2 (married, spouse not working), exactly as
-- the existing `spouse` deduction is. For a category-1 or category-3 employee the value is stored and
-- displayed but adds nothing to P — the Identity & Tax card says so rather than letting it look ignored.
--
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- (2) child_relief_table
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
--
-- The employee's own child-relief GRID, read by payroll ONLY when child_relief_mode = 'auto_table' (the
-- third mode this item adds beside 'manual' and 'auto'). Shape:
--
--   { "under_18": { "full": 2, "half": 0 }, "study_tertiary": { "full": 0, "half": 1 }, ... }
--
-- keyed by the five LHDN s.48 categories already in use on the Family register (under_18, study_preu,
-- study_tertiary, disabled, disabled_study — see core/dependents.ts CHILD_RELIEF_CATEGORIES). `full` is
-- the count claimed at 100%, `half` the count claimed at 50% (LHDN: 100% to one parent, or 50% each when
-- parents split the claim). Both are whole numbers ≥ 0; the setter validates and drops unknown keys.
--
-- ── WHY A JSONB COLUMN AND NOT A CHILD TABLE ──────────────────────────────────────────────────────
-- Following the precedent recorded in migration 0250 (per-child relief category on the dependent row):
-- it inherits employee_statutory_my's existing row-level security unchanged, so no new policy has to be
-- written and reviewed; and it lands WHOLE inside the existing `employee.tax.updated` before/after
-- payload, so the audit trail for a relief claim needs no new path. A child table would need both, for
-- a grid that is at most five rows and is only ever read together with the row it hangs off.
--
-- ── WHAT IT DOES *NOT* REPLACE ────────────────────────────────────────────────────────────────────
-- num_children stays the whole HEAD COUNT and keeps every reader it has today: core/payroll.ts, and the
-- three statutory reports at localization/my/reports.ts (Form E / CP8D, the EA statement, and the
-- cross-employer PCB exposure figure). This grid produces a relief AMOUNT alongside that count. Nothing
-- loses a home, and the annual returns keep printing the number of children exactly as they do now.
--
-- ── PDPA ──────────────────────────────────────────────────────────────────────────────────────────
-- This grid records how many of an employee's children fall into a DISABLED category — health data about
-- people who are not the employee. The erasure decision is recorded in core/pdpa.ts beside PII_FIELDS:
-- the column is NULLable precisely so the existing NULL-based erasure mechanism can express it, and it
-- is listed there as statutory-locked (erased with the rest once the LHDN retention period lifts).
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS on both.
-- ROLLBACK: DROP COLUMN disabled_spouse, DROP COLUMN child_relief_table. The only readers are the tax
-- profile path and pcbMonth; dropping them returns every employee to the pre-item behaviour.

ALTER TABLE employee_statutory_my
  ADD COLUMN IF NOT EXISTS disabled_spouse boolean NOT NULL DEFAULT false;--> statement-breakpoint

ALTER TABLE employee_statutory_my
  ADD COLUMN IF NOT EXISTS child_relief_table jsonb;--> statement-breakpoint

COMMENT ON COLUMN employee_statutory_my.disabled_spouse IS
  'd64d0df4 — the employee''s SPOUSE is a registered disabled individual (OKU). Tenant data about a circumstance; the RELIEF AMOUNT is statutory and lives in the country pack ruleset (MY_RELIEFS.disabledSpouse), never here. Gated to tax category 2 exactly like the spouse deduction. Default false ⇒ every pre-existing row keeps today''s PCB exactly.';--> statement-breakpoint

COMMENT ON COLUMN employee_statutory_my.child_relief_table IS
  'd64d0df4 — the employee''s child-relief grid, read by payroll ONLY when child_relief_mode = ''auto_table''. { "<LHDN s.48 category>": { "full": n, "half": n } } over under_18 / study_preu / study_tertiary / disabled / disabled_study. num_children stays the whole HEAD COUNT for Form E / CP8D / EA; this produces a relief AMOUNT alongside it. NULL = not configured.';

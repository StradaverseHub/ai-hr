-- Item 6c635212 (R45) — Malaysia Income Tax (PCB / TP1) child-relief configuration, per child.
--
-- Captures the LHDN per-child detail the tax figure needs but the Family register never held: the relief
-- CATEGORY (the five s.48 cases — under 18; 18+ in full-time pre-university study; diploma/degree and above;
-- disabled child; disabled child in full-time study), a Y/N "claim relief" flag, and a 100 | 50 relief share
-- for parents splitting the claim. The disabled cases are folded into the category enum, so no separate
-- disabled-child indicator column is added.
--
-- Purely ADDITIVE and BACKWARD COMPATIBLE: every column is NULLABLE with no default, so every existing
-- dependent row is unaffected (all-NULL ⇒ no per-child relief config ⇒ the derived eligible-child count
-- falls back to the DOB/student inference exactly as before). BENEFITS-vs-TAX FIREWALL preserved: these
-- columns live on the Family register and only SURFACE a suggested relief total for HR to confirm into
-- employee_statutory_my.num_children — they never silently drive the approval-gated tax figure or payroll.
--
-- No new table → the existing RLS on employee_dependent (app.can_see_person read / app.is_admin() write)
-- already covers these columns (same inheritance as migration 0185). Value validation (allowed category set,
-- 100|50 percentage) lives in core/dependents.ts; the DB stays permissive so legacy rows and imports never
-- trip a CHECK. IF NOT EXISTS keeps a re-run idempotent.
ALTER TABLE "employee_dependent" ADD COLUMN IF NOT EXISTS "child_relief_category" text;--> statement-breakpoint
ALTER TABLE "employee_dependent" ADD COLUMN IF NOT EXISTS "child_tax_relief" boolean;--> statement-breakpoint
ALTER TABLE "employee_dependent" ADD COLUMN IF NOT EXISTS "child_relief_percentage" integer;

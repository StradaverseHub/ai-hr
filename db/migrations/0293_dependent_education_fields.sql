-- Item 5988053a — Family tab: child records as a table + Add Child dialog. Adds the two ADDITIVE education
-- fields to employee_dependent (study level + study country), alongside the existing school_name. Mirrors
-- the additive shape of 0185_dependent_family_fields.sql: both columns NULLABLE, no default, no CHECK — the
-- DB stays permissive (legacy rows and imports unaffected; existing rows simply show the fields blank).
-- Child-gating (the fields persist only for relationship = 'child') is enforced in core/dependents.ts, not
-- by constraint. No new table → the existing employee_dependent RLS + table-level GRANT (0137) already
-- cover these columns; study level / country are not identity or contact data, so core/pdpa.ts is unchanged.
-- IF NOT EXISTS keeps it idempotent.

ALTER TABLE "employee_dependent" ADD COLUMN IF NOT EXISTS "study_level" text;--> statement-breakpoint
ALTER TABLE "employee_dependent" ADD COLUMN IF NOT EXISTS "study_country" text;

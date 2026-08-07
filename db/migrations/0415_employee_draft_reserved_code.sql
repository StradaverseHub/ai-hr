-- r173c · 06f0cb8f — "Simplify Create New Employee Workflow with Draft Creation".
--
-- WHAT CHANGES, AND WHAT DELIBERATELY DOES NOT.
-- A draft used to consume NOTHING (0337's header says so in as many words). The reporter's request
-- inverts exactly one clause of that: the Employee ID must be taken AT CREATE and held, so no second
-- draft, no hand-entry and no bulk import can be given it while the record is still being filled in.
-- Everything else 0337 promised stays true by construction — a draft is still captured input, still
-- creates no person and no employment, still enters no headcount, payroll run, leave balance or report.
--
-- WHY FOUR COLUMNS AND NOT ONE. `reserved_employee_code` is the claim itself; the other three exist so
-- the claim can be GIVEN BACK. Discarding a draft rolls the running number back only when it was the
-- LAST one issued (see core/employee-draft.ts discardEmployeeDraft), and proving that needs to know
-- which setup issued it (`reserved_config_id`) and which number it took (`reserved_number`). Without
-- them a discard could only ever leak the number, which is the trade-off the plan explicitly refused to
-- accept for the common case. `reserved_at` is when the hold started, for the audit answer to "who was
-- sitting on X0007 for three weeks".
--
-- `reserved_config_id` IS NULLABLE ON PURPOSE and null carries meaning: the legacy per-tenant
-- EMP-#### counter (core/comp.ts nextEmployeeCode) issued it because no Employee ID Auto Running Number
-- Setup resolved for that company. The release path reads the null and rolls back `tenant_counter`
-- instead. ON DELETE SET NULL rather than a hard reference: deleting a setup must not be blocked by, or
-- silently delete, an in-flight draft — it just stops the number being returnable, which is honest.
--
-- THE PARTIAL UNIQUE INDEX IS THE ACTUAL RESERVATION. The service pre-checks both tables for a friendly
-- message, but two administrators pressing Create in the same second serialize HERE. It is partial
-- (`where reserved_employee_code is not null`) because every draft written before this migration, and
-- every draft that is still only captured input, carries null — and NULLs are not unique-compared, so
-- the old rows are untouched and keep behaving exactly as they did.
--
-- NOTE WHAT THIS INDEX DOES *NOT* DO: it does not span `employment.employee_code`. Postgres has no
-- cross-table unique constraint, so the two-table check lives in TypeScript
-- (core/org.ts assertEmployeeCodeUnique + core/employee-draft.ts isEmployeeCodeTaken) with each table's
-- own index as the race net on its own side. A draft claiming a code an employment already has is
-- refused by the service; the reverse is refused by the same service before hireEmployee runs.
--
-- NO NEW GRANT: 0337 already granted SELECT/INSERT/UPDATE/DELETE on employee_draft to ai_hr_app, and a
-- column added to a granted table inherits the table grant. NO RLS CHANGE: the 0337 policy is FOR ALL
-- over the whole row and covers new columns unchanged.
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS.
-- ROLLBACK: DROP INDEX employee_draft_reserved_code_uq, then DROP COLUMN the four. Existing drafts lose
-- their hold and behave as they did before this item; no employee record depends on a reservation.

ALTER TABLE employee_draft
  ADD COLUMN IF NOT EXISTS reserved_employee_code text,
  ADD COLUMN IF NOT EXISTS reserved_at timestamptz,
  ADD COLUMN IF NOT EXISTS reserved_config_id uuid REFERENCES employee_id_config(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reserved_number integer;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS employee_draft_reserved_code_uq
  ON employee_draft (tenant_id, reserved_employee_code)
  WHERE reserved_employee_code IS NOT NULL;--> statement-breakpoint

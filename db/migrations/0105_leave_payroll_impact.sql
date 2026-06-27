-- Unpaid Leave Payroll Impact Integration. Additive column only — no new tables, no new RLS (the new column
-- is reachable by the existing leave_type FOR ALL tenant policy + table-level grants, same as 0098's doc-
-- config columns). Discrete typed boolean (claims/doc-config style) so the admin update is a flat set with no
-- JSONB partial-merge.
--   leave_type.send_to_payroll: gates emission of the on-approval payroll signal (it enriches the existing
--     leave-request.approved domain event). "Activated once Payroll module integration is done." This column
--     does NOT change what payroll deducts — payroll deduction is still driven by paid=false in
--     core/payroll.ts (unpaidDaysByEmployment). Default false.
ALTER TABLE leave_type ADD COLUMN send_to_payroll boolean NOT NULL DEFAULT false;--> statement-breakpoint
-- Backfill (data, not DDL — intentionally absent from the generated meta snapshot/journal): existing unpaid
-- (paid=false) types emit the signal by default. Idempotent: re-running on the test-DB rebuild — where seed.ts
-- also sets the flag — is a no-op (UPDATE ... WHERE paid=false double-applied changes nothing).
UPDATE leave_type SET send_to_payroll = true WHERE paid = false;

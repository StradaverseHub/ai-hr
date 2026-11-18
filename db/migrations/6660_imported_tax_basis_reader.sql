-- Approved PCB history source boundary: immutable imported figures, additive input evidence only.
ALTER TABLE payroll_import_code DROP CONSTRAINT payroll_import_code_destination_ck;
--> statement-breakpoint
ALTER TABLE payroll_import_code ADD CONSTRAINT payroll_import_code_destination_ck CHECK(destination IN ('basic','allowance','overtime','bonus','other_deduction','noncash','epf_employee','epf_employer','socso_employee','socso_employer','socso_skbbk','eis_employee','eis_employer','pcb','cp38','zakat','lp','hrdf','gross','net'));
--> statement-breakpoint
-- Old application readers cannot silently fall back to gross for newly held imported inputs.
-- Inline row evidence avoids recursion through payslip RLS and preserves every existing audience predicate.
CREATE POLICY payroll_import_tax_basis_reader_guard ON payslip AS RESTRICTIVE FOR SELECT TO ai_hr_app USING (statutory->'importedTaxBasis' IS NULL OR current_setting('app.payroll_import_tax_basis_reader',true)='1');

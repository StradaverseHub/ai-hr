-- The existing append-only replacement owner records independently recalculated open-run results.
ALTER TABLE payroll_tax_basis_replacement ADD COLUMN recalculated boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.payroll_tax_basis_replacement_bind() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE correction public.payroll_tax_basis_revision;slip public.payslip;batch public.payroll_batch;history public.payroll_employee_result_history;prior public.payroll_tax_basis_replacement;period_state text;
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NEW.created_by IS DISTINCT FROM app.current_user_id() OR NOT app.principal_snapshot_current() OR NOT app.can_admin_payroll_for(NEW.company_id) THEN RAISE EXCEPTION 'Payroll replacement authority unavailable'; END IF;
 SELECT * INTO correction FROM public.payroll_tax_basis_revision WHERE id=NEW.correction_id;
 SELECT * INTO slip FROM public.payslip WHERE id=NEW.payslip_id;
 SELECT * INTO batch FROM public.payroll_batch WHERE id=slip.batch_id;
 SELECT status::text INTO period_state FROM public.pay_period WHERE id=batch.pay_period_id;
 SELECT * INTO history FROM public.payroll_employee_result_history WHERE id=NEW.history_id;
 IF correction.id IS NULL OR slip.id IS NULL OR history.id IS NULL OR correction.tenant_id<>NEW.tenant_id OR correction.company_id<>NEW.company_id OR correction.employment_id<>NEW.employment_id OR correction.payslip_id<>NEW.payslip_id
  OR slip.tenant_id<>NEW.tenant_id OR slip.employment_id<>NEW.employment_id OR batch.tenant_id<>NEW.tenant_id OR batch.company_id<>NEW.company_id OR batch.pay_period<>correction.period OR batch.status::text<>'processed' OR period_state<>'open' OR batch.history_import_attempt_id IS NOT NULL
  OR history.tenant_id<>NEW.tenant_id OR history.batch_id<>batch.id OR history.employment_id<>NEW.employment_id OR history.action<>'reprocess' OR history.actor_id IS DISTINCT FROM NEW.created_by OR history.version_after<>slip.version OR history.version_before+1<>history.version_after
  OR NEW.after_source->'source' IS DISTINCT FROM to_jsonb(slip) OR NEW.after_source->>'id' IS DISTINCT FROM slip.id::text
  OR NEW.before_source->>'id' IS DISTINCT FROM slip.id::text OR NEW.after_source->>'employmentId' IS DISTINCT FROM NEW.employment_id::text OR NEW.before_source->>'employmentId' IS DISTINCT FROM NEW.employment_id::text
  OR NEW.after_source->>'companyId' IS DISTINCT FROM NEW.company_id::text OR NEW.before_source->>'companyId' IS DISTINCT FROM NEW.company_id::text
  OR NEW.before_source->>'period' IS DISTINCT FROM batch.pay_period OR NEW.after_source->>'period' IS DISTINCT FROM batch.pay_period
  OR (NEW.before_source->'source'->>'version')::int IS DISTINCT FROM history.version_before OR (NEW.after_source->'source'->>'version')::int IS DISTINCT FROM history.version_after
  OR (NEW.recalculated AND (
       (history.before->>'grossPay')::numeric IS DISTINCT FROM (NEW.before_source->'source'->>'gross_pay')::numeric
    OR (history.before->>'netPay')::numeric IS DISTINCT FROM (NEW.before_source->'source'->>'net_pay')::numeric
    OR (history.before->>'totalDeductions')::numeric IS DISTINCT FROM (NEW.before_source->'source'->>'total_deductions')::numeric
    OR (history.before->>'employerCost')::numeric IS DISTINCT FROM (NEW.before_source->'source'->>'employer_cost')::numeric))
  OR history.before->'statutory' IS DISTINCT FROM NEW.before_source->'source'->'statutory' OR history.after->'statutory' IS DISTINCT FROM to_jsonb(slip)->'statutory'
  OR octet_length(NEW.before_source::text)>2000000 OR octet_length(NEW.after_source::text)>2000000
 THEN RAISE EXCEPTION 'Payroll replacement source binding changed'; END IF;
 SELECT * INTO prior FROM public.payroll_tax_basis_replacement WHERE correction_id=NEW.correction_id ORDER BY created_at DESC,id DESC LIMIT 1;
 IF NEW.recalculated THEN
  -- A freshly calculated result may bridge changed source bytes, but only for the same
  -- physical result and version. The correction itself remains bound to its old hash.
  IF prior.id IS NOT NULL AND (NEW.before_source->'source'->>'version')::int
     IS DISTINCT FROM (prior.after_source->'source'->>'version')::int
  THEN RAISE EXCEPTION 'Payroll replacement version changed'; END IF;
 ELSIF (prior.id IS NULL AND NEW.before_hash IS DISTINCT FROM correction.source_hash)
    OR (prior.id IS NOT NULL AND (NEW.before_hash IS DISTINCT FROM prior.after_hash OR NEW.before_source IS DISTINCT FROM prior.after_source))
 THEN RAISE EXCEPTION 'Payroll replacement lineage changed'; END IF;
 RETURN NEW;
END $$;

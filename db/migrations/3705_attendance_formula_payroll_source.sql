-- A discriminated contribution on the existing Payroll source owner, with real formula/result FKs.
ALTER TABLE public.payroll_attendance_allowance_source
 ALTER COLUMN policy_id DROP NOT NULL,ALTER COLUMN result_id DROP NOT NULL,
 ADD COLUMN formula_id uuid REFERENCES public.attendance_formula(id),
 ADD COLUMN formula_result_id uuid REFERENCES public.attendance_formula_result(id),
 ADD CONSTRAINT attendance_contribution_binding_ck CHECK(
  (policy_id IS NOT NULL AND result_id IS NOT NULL AND formula_id IS NULL AND formula_result_id IS NULL)
  OR(policy_id IS NULL AND result_id IS NULL AND formula_id IS NOT NULL AND formula_result_id IS NOT NULL));
CREATE UNIQUE INDEX attendance_formula_payroll_result_uq ON public.payroll_attendance_allowance_source(formula_result_id) WHERE formula_result_id IS NOT NULL;
CREATE UNIQUE INDEX attendance_formula_payroll_period_uq ON public.payroll_attendance_allowance_source(tenant_id,formula_id,employment_id,period_key) WHERE formula_id IS NOT NULL;
ALTER TABLE public.payroll_attendance_allowance_source ADD CONSTRAINT attendance_contribution_formula_tenant_fk FOREIGN KEY(formula_id,tenant_id,company_id) REFERENCES public.attendance_formula(id,tenant_id,company_id);
ALTER TABLE public.payroll_attendance_allowance_source ADD CONSTRAINT attendance_contribution_result_scope_fk FOREIGN KEY(formula_result_id,tenant_id,company_id,employment_id) REFERENCES public.attendance_formula_result(id,tenant_id,company_id,employment_id);
DROP TRIGGER payroll_attendance_allowance_source_identity ON public.payroll_attendance_allowance_source;
CREATE TRIGGER payroll_attendance_allowance_source_identity BEFORE INSERT OR UPDATE ON public.payroll_attendance_allowance_source FOR EACH ROW WHEN(NEW.formula_result_id IS NULL) EXECUTE FUNCTION app.attendance_allowance_identity_guard();
--> statement-breakpoint
CREATE FUNCTION app.attendance_formula_contribution_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
DECLARE r public.attendance_formula_result;b public.payroll_batch;state text;
BEGIN
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'Formula contributions retain their exact result; reverse and recalculate'; END IF;
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM public.payroll_batch_component c WHERE c.batch_id=OLD.batch_id AND c.employment_id=OLD.employment_id AND c.component_id=OLD.component_id) THEN RAISE EXCEPTION 'Remove the canonical draft Payroll input before releasing its formula contributions'; END IF;
  SELECT * INTO b FROM public.payroll_batch WHERE id=OLD.batch_id AND tenant_id=OLD.tenant_id;
  IF b.status IS DISTINCT FROM 'draft' OR NOT app.can_admin_payroll_for(OLD.company_id) THEN RAISE EXCEPTION 'Only an authorized draft Payroll reversal can release a formula result'; END IF;
  SELECT kind INTO state FROM public.attendance_formula_result_event WHERE result_id=OLD.formula_result_id AND tenant_id=OLD.tenant_id ORDER BY sequence DESC LIMIT 1;
  IF state='posted' THEN INSERT INTO public.attendance_formula_result_event(tenant_id,company_id,employment_id,result_id,kind,reason,batch_id,created_by) VALUES(OLD.tenant_id,OLD.company_id,OLD.employment_id,OLD.formula_result_id,'reversed','Canonical draft Payroll contribution released.',OLD.batch_id,app.current_user_id());END IF;
  RETURN OLD;
 END IF;
 SELECT * INTO r FROM public.attendance_formula_result WHERE id=NEW.formula_result_id AND tenant_id=NEW.tenant_id AND company_id=NEW.company_id AND employment_id=NEW.employment_id;
 SELECT * INTO b FROM public.payroll_batch WHERE id=NEW.batch_id AND tenant_id=NEW.tenant_id AND company_id=NEW.company_id;
 SELECT kind INTO state FROM public.attendance_formula_result_event WHERE result_id=r.id AND tenant_id=r.tenant_id ORDER BY sequence DESC LIMIT 1;
 IF r.id IS NULL OR b.id IS NULL OR state IS DISTINCT FROM 'approved' OR NOT app.can_admin_payroll_for(NEW.company_id)
  OR b.status<>'draft' OR b.pay_period<>NEW.pay_month OR r.period_to::text<>NEW.period_key OR to_char(r.period_to,'YYYY-MM')<>b.pay_period
  OR r.formula_id<>NEW.formula_id OR r.pay_component_id<>NEW.component_id OR r.amount<>NEW.amount
  THEN RAISE EXCEPTION 'Formula contribution requires its exact approved native result and draft Payroll month'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.attendance_formula_contribution_guard() FROM PUBLIC;
CREATE TRIGGER attendance_formula_contribution_insert BEFORE INSERT ON public.payroll_attendance_allowance_source FOR EACH ROW WHEN(NEW.formula_result_id IS NOT NULL) EXECUTE FUNCTION app.attendance_formula_contribution_guard();
CREATE TRIGGER attendance_formula_contribution_update BEFORE UPDATE ON public.payroll_attendance_allowance_source FOR EACH ROW WHEN(NEW.formula_result_id IS NOT NULL OR OLD.formula_result_id IS NOT NULL) EXECUTE FUNCTION app.attendance_formula_contribution_guard();
CREATE TRIGGER attendance_formula_contribution_delete BEFORE DELETE ON public.payroll_attendance_allowance_source FOR EACH ROW WHEN(OLD.formula_result_id IS NOT NULL) EXECUTE FUNCTION app.attendance_formula_contribution_guard();

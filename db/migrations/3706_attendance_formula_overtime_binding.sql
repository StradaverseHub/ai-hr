-- Formula calculations are evidence beneath the EXISTING overtime parent/settlement, not assignments.
ALTER TABLE public.attendance_overtime_source ADD CONSTRAINT attendance_formula_ot_source_scope_uq UNIQUE(id,tenant_id,company_id,employment_id);
CREATE TABLE public.attendance_formula_ot_binding(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES public.tenant(id),company_id uuid NOT NULL,
 employment_id uuid NOT NULL,batch_id uuid NOT NULL REFERENCES public.payroll_batch(id),period_from date NOT NULL,period_to date NOT NULL,
 payload jsonb NOT NULL,created_by uuid NOT NULL REFERENCES public.app_user(id),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,tenant_id,company_id,employment_id),UNIQUE(id,tenant_id,company_id),
 FOREIGN KEY(company_id,tenant_id) REFERENCES public.company(id,tenant_id),FOREIGN KEY(employment_id,tenant_id) REFERENCES public.employment(id,tenant_id),
 CHECK(period_to>=period_from AND period_to-period_from<=61),CHECK(jsonb_typeof(payload)='object' AND octet_length(payload::text)<=8388608)
);
CREATE TABLE public.attendance_formula_ot_binding_result(
 binding_id uuid NOT NULL,tenant_id uuid NOT NULL REFERENCES public.tenant(id),company_id uuid NOT NULL,employment_id uuid NOT NULL,result_id uuid NOT NULL,
 PRIMARY KEY(binding_id,result_id),
 FOREIGN KEY(binding_id,tenant_id,company_id,employment_id) REFERENCES public.attendance_formula_ot_binding(id,tenant_id,company_id,employment_id),
 FOREIGN KEY(result_id,tenant_id,company_id,employment_id) REFERENCES public.attendance_formula_result(id,tenant_id,company_id,employment_id),
 FOREIGN KEY(company_id,tenant_id) REFERENCES public.company(id,tenant_id)
);
CREATE TABLE public.attendance_formula_ot_binding_day(
 binding_id uuid NOT NULL,source_id uuid NOT NULL,tenant_id uuid NOT NULL REFERENCES public.tenant(id),company_id uuid NOT NULL,employment_id uuid NOT NULL,
 coverage int8multirange NOT NULL CHECK(NOT isempty(coverage)),payload jsonb NOT NULL,
 PRIMARY KEY(binding_id,source_id),
 FOREIGN KEY(binding_id,tenant_id,company_id,employment_id) REFERENCES public.attendance_formula_ot_binding(id,tenant_id,company_id,employment_id),
 FOREIGN KEY(source_id,tenant_id,company_id,employment_id) REFERENCES public.attendance_overtime_source(id,tenant_id,company_id,employment_id),
 FOREIGN KEY(company_id,tenant_id) REFERENCES public.company(id,tenant_id),
 CHECK(jsonb_typeof(payload)='object' AND octet_length(payload::text)<=1048576)
);
--> statement-breakpoint
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['attendance_formula_ot_binding','attendance_formula_ot_binding_result','attendance_formula_ot_binding_day'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,ai_hr_app',t);EXECUTE format('GRANT SELECT,INSERT ON public.%I TO ai_hr_app',t);
  EXECUTE format('CREATE POLICY attendance_formula_ot_read ON public.%I FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.can_admin_payroll_for(company_id) AND app.attendance_formula_trace_access(company_id,employment_id,''{"financial":true,"workforce":false}''::jsonb))',t);
  EXECUTE format('CREATE POLICY attendance_formula_ot_insert ON public.%I FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.can_admin_payroll_for(company_id) AND app.attendance_formula_trace_access(company_id,employment_id,''{"financial":true,"workforce":false}''::jsonb))',t);
  EXECUTE format('CREATE TRIGGER attendance_formula_ot_immutable BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.attendance_formula_immutable()',t);
 END LOOP;
END $$;
ALTER TABLE public.overtime_source_settlement ADD COLUMN formula_binding_id uuid;
ALTER TABLE public.overtime_source_settlement ADD CONSTRAINT formula_ot_settlement_binding_fk FOREIGN KEY(formula_binding_id,tenant_id,company_id) REFERENCES public.attendance_formula_ot_binding(id,tenant_id,company_id);
ALTER TABLE public.overtime_source_settlement DROP CONSTRAINT overtime_settlement_coverage_shape_ck;
ALTER TABLE public.overtime_source_settlement ADD CONSTRAINT overtime_settlement_coverage_shape_ck CHECK(
 (coverage_employment_id IS NULL AND coverage_calculation_id IS NULL AND coverage_kind IS NULL AND reservation_coverage IS NULL AND formula_binding_id IS NULL)
 OR(coverage_employment_id IS NOT NULL AND coverage_kind IS NOT NULL AND reservation_coverage IS NOT NULL AND NOT isempty(reservation_coverage)
  AND((coverage_kind='legacyUnknown' AND formula_binding_id IS NULL) OR(coverage_kind='policyPhysical' AND coverage_calculation_id IS NOT NULL AND formula_binding_id IS NULL) OR(coverage_kind='formulaPhysical' AND formula_binding_id IS NOT NULL))));
ALTER TABLE public.overtime_source_settlement ADD CONSTRAINT overtime_formula_physical_no_overlap EXCLUDE USING gist(tenant_id WITH =,coverage_employment_id WITH =,reservation_coverage WITH &&) WHERE(released_at IS NULL AND coverage_kind='formulaPhysical');
--> statement-breakpoint
-- Runs AFTER the original coverage owner. Original principal, source, cash/TOIL, batch and current
-- calculation guards still run. Only the typed formula binding supplies formulaPhysical coverage.
CREATE FUNCTION app.attendance_formula_ot_settlement_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
DECLARE b public.attendance_formula_ot_binding;d public.attendance_formula_ot_binding_day;source public.attendance_overtime_source;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.formula_binding_id IS DISTINCT FROM OLD.formula_binding_id THEN RAISE EXCEPTION 'An overtime formula binding is immutable'; END IF;RETURN NEW;
 END IF;
 IF NEW.formula_binding_id IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO b FROM public.attendance_formula_ot_binding WHERE id=NEW.formula_binding_id AND tenant_id=NEW.tenant_id AND company_id=NEW.company_id;
 SELECT * INTO d FROM public.attendance_formula_ot_binding_day WHERE binding_id=b.id AND source_id=NEW.source_id AND tenant_id=NEW.tenant_id;
 SELECT * INTO source FROM public.attendance_overtime_source WHERE id=NEW.source_id AND tenant_id=NEW.tenant_id;
 IF b.id IS NULL OR d.source_id IS NULL OR source.id IS NULL OR source.employment_id<>b.employment_id OR NEW.mode<>'cash' OR b.batch_id IS DISTINCT FROM NEW.payroll_batch_id
  OR NOT app.can_admin_payroll_for(b.company_id) OR NOT EXISTS(SELECT 1 FROM public.payroll_batch run WHERE run.id=b.batch_id AND run.tenant_id=b.tenant_id AND run.company_id=b.company_id AND run.status='draft' AND run.run_type='regular')
  OR NOT EXISTS(SELECT 1 FROM public.attendance_formula_ot_binding_result x WHERE x.binding_id=b.id AND x.tenant_id=b.tenant_id)
  OR EXISTS(SELECT 1 FROM public.attendance_formula_ot_binding_result x JOIN public.attendance_formula_result r ON r.id=x.result_id JOIN public.attendance_formula_revision v ON v.id=r.revision_id WHERE x.binding_id=b.id AND (v.definition->>'purpose'<>'overtime' OR r.period_from<>b.period_from OR r.period_to<>b.period_to OR (SELECT kind FROM public.attendance_formula_result_event e WHERE e.result_id=r.id ORDER BY sequence DESC LIMIT 1) IS DISTINCT FROM 'approved'))
  THEN RAISE EXCEPTION 'Only a complete approved native overtime result set may reserve the parent'; END IF;
 IF NOT(d.coverage <@ int8multirange(int8range((extract(epoch FROM(source.attendance_date::timestamp AT TIME ZONE 'Asia/Kuala_Lumpur'))*1000)::bigint,(extract(epoch FROM(source.attendance_date::timestamp AT TIME ZONE 'Asia/Kuala_Lumpur'))*1000)::bigint+259200000,'[)'))) THEN RAISE EXCEPTION 'Overtime coverage exceeds the parent source envelope'; END IF;
 NEW.coverage_employment_id:=source.employment_id;NEW.coverage_kind:='formulaPhysical';NEW.coverage_calculation_id:=NEW.calculation_id;NEW.reservation_coverage:=d.coverage;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.attendance_formula_ot_settlement_guard() FROM PUBLIC;
CREATE TRIGGER ac_attendance_formula_ot_settlement_guard BEFORE INSERT OR UPDATE ON public.overtime_source_settlement FOR EACH ROW EXECUTE FUNCTION app.attendance_formula_ot_settlement_guard();
--> statement-breakpoint
CREATE FUNCTION app.attendance_formula_ot_release() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
DECLARE binding public.attendance_formula_ot_binding;r public.attendance_formula_result;
BEGIN
 IF NEW.formula_binding_id IS NULL OR OLD.released_at IS NOT NULL OR NEW.released_at IS NULL THEN RETURN NEW; END IF;
 IF EXISTS(SELECT 1 FROM public.overtime_source_settlement WHERE formula_binding_id=NEW.formula_binding_id AND released_at IS NULL) THEN RETURN NEW; END IF;
 SELECT * INTO binding FROM public.attendance_formula_ot_binding WHERE id=NEW.formula_binding_id AND tenant_id=NEW.tenant_id;
 FOR r IN SELECT result.* FROM public.attendance_formula_result result JOIN public.attendance_formula_ot_binding_result x ON x.result_id=result.id WHERE x.binding_id=binding.id AND x.tenant_id=binding.tenant_id LOOP
  IF(SELECT kind FROM public.attendance_formula_result_event WHERE result_id=r.id ORDER BY sequence DESC LIMIT 1)='posted' THEN
   INSERT INTO public.attendance_formula_result_event(tenant_id,company_id,employment_id,result_id,kind,reason,batch_id,created_by) VALUES(r.tenant_id,r.company_id,r.employment_id,r.id,'reversed','Canonical overtime parent settlements released.',binding.batch_id,app.current_user_id());
  END IF;
 END LOOP;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.attendance_formula_ot_release() FROM PUBLIC;
CREATE TRIGGER attendance_formula_ot_release AFTER UPDATE ON public.overtime_source_settlement FOR EACH ROW EXECUTE FUNCTION app.attendance_formula_ot_release();
--> statement-breakpoint
CREATE FUNCTION app.attendance_formula_ot_binding_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF NEW.created_by IS DISTINCT FROM app.current_user_id() OR NEW.payload->>'version' IS DISTINCT FROM 'attendance-formula-overtime-1'
  OR NOT EXISTS(SELECT 1 FROM public.payroll_batch b WHERE b.id=NEW.batch_id AND b.tenant_id=NEW.tenant_id AND b.company_id=NEW.company_id AND b.status='draft' AND b.run_type='regular' AND b.pay_period=to_char(NEW.period_to,'YYYY-MM') AND app.can_admin_payroll_for(b.company_id)) THEN RAISE EXCEPTION 'Use the current financial actor and matching draft run for overtime evidence'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.attendance_formula_ot_binding_guard() FROM PUBLIC;
CREATE TRIGGER attendance_formula_ot_binding_guard BEFORE INSERT ON public.attendance_formula_ot_binding FOR EACH ROW EXECUTE FUNCTION app.attendance_formula_ot_binding_guard();

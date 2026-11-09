-- Immutable calculation/review evidence. Payroll remains the contribution/settlement owner.
CREATE TABLE public.attendance_formula_result (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,formula_id uuid NOT NULL,revision_id uuid NOT NULL,
 employment_id uuid NOT NULL,period_from date NOT NULL,period_to date NOT NULL,
 pay_component_id uuid NOT NULL,quantity text NOT NULL,unit text NOT NULL CHECK(unit IN('amount','minutes','hours','days')),
 rate text,amount numeric(12,2) NOT NULL CHECK(amount>=0),source_hash text NOT NULL CHECK(source_hash~'^[a-f0-9]{64}$'),
 read_requirements jsonb NOT NULL,payload jsonb NOT NULL,created_by uuid NOT NULL REFERENCES public.app_user(id),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,tenant_id,company_id,employment_id),
 FOREIGN KEY(company_id,tenant_id) REFERENCES public.company(id,tenant_id),
 FOREIGN KEY(revision_id,formula_id,tenant_id,company_id) REFERENCES public.attendance_formula_revision(id,formula_id,tenant_id,company_id),
 FOREIGN KEY(employment_id,tenant_id) REFERENCES public.employment(id,tenant_id),
 FOREIGN KEY(pay_component_id,tenant_id) REFERENCES public.pay_component(id,tenant_id),
 CHECK(period_to>=period_from AND period_to-period_from<=61),CHECK(quantity~'^[0-9]{1,16}(\.[0-9]{1,12})?$'),
 CHECK(jsonb_typeof(payload)='object' AND octet_length(payload::text)<=2097152),
 CHECK(read_requirements->>'financial'='true' AND jsonb_typeof(read_requirements->'workforce')='boolean')
);
CREATE INDEX attendance_formula_result_subject_idx ON public.attendance_formula_result(tenant_id,employment_id,period_from,period_to);
CREATE TABLE public.attendance_formula_result_event (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),sequence bigserial NOT NULL UNIQUE,tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,employment_id uuid NOT NULL,result_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN('calculated','reviewed','approved','superseded','posted','reversed')),
 reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),batch_id uuid REFERENCES public.payroll_batch(id) ON DELETE RESTRICT,
 created_by uuid NOT NULL REFERENCES public.app_user(id),created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(result_id,tenant_id,company_id,employment_id) REFERENCES public.attendance_formula_result(id,tenant_id,company_id,employment_id),
 FOREIGN KEY(company_id,tenant_id) REFERENCES public.company(id,tenant_id),
 CHECK(kind NOT IN('posted','reversed') OR batch_id IS NOT NULL)
);
CREATE INDEX attendance_formula_result_event_latest_idx ON public.attendance_formula_result_event(tenant_id,result_id,sequence DESC);
--> statement-breakpoint
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['attendance_formula_result','attendance_formula_result_event'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,ai_hr_app',t);
  EXECUTE format('GRANT SELECT,INSERT ON public.%I TO ai_hr_app',t);
  IF t='attendance_formula_result' THEN
   EXECUTE format('CREATE POLICY attendance_formula_result_read ON public.%I FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.attendance_formula_trace_access(company_id,employment_id,read_requirements))',t);
   EXECUTE format('CREATE POLICY attendance_formula_result_insert ON public.%I FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND created_by=app.current_user_id() AND app.attendance_formula_trace_access(company_id,employment_id,read_requirements))',t);
  ELSE
   EXECUTE format('CREATE POLICY attendance_formula_result_event_read ON public.%I FOR SELECT USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM public.attendance_formula_result r WHERE r.id=result_id AND r.tenant_id=attendance_formula_result_event.tenant_id))',t);
   EXECUTE format('CREATE POLICY attendance_formula_result_event_insert ON public.%I FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND created_by=app.current_user_id() AND EXISTS(SELECT 1 FROM public.attendance_formula_result r WHERE r.id=result_id AND r.tenant_id=attendance_formula_result_event.tenant_id))',t);
  END IF;
  EXECUTE format('CREATE TRIGGER attendance_formula_result_immutable BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.attendance_formula_immutable()',t);
 END LOOP;
END $$;
GRANT USAGE,SELECT ON SEQUENCE public.attendance_formula_result_event_sequence_seq TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.attendance_formula_result_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
DECLARE r public.attendance_formula_result;previous text;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text||':'||NEW.employment_id::text,0));
 IF TG_TABLE_NAME='attendance_formula_result' THEN
  IF NOT EXISTS(SELECT 1 FROM public.attendance_formula_revision v WHERE v.id=NEW.revision_id AND v.formula_id=NEW.formula_id AND v.tenant_id=NEW.tenant_id AND v.company_id=NEW.company_id AND v.pay_component_id=NEW.pay_component_id AND v.definition->>'outputUnit'=NEW.unit AND v.definition->>'effectiveFrom'<=NEW.period_from::text)
   OR (SELECT e.revision_id FROM public.attendance_formula_event e WHERE e.formula_id=NEW.formula_id AND e.tenant_id=NEW.tenant_id AND e.kind IN('activated','deactivated','archived') ORDER BY e.sequence DESC LIMIT 1) IS DISTINCT FROM NEW.revision_id
   OR (SELECT e.kind FROM public.attendance_formula_event e WHERE e.formula_id=NEW.formula_id AND e.tenant_id=NEW.tenant_id AND e.kind IN('activated','deactivated','archived') ORDER BY e.sequence DESC LIMIT 1) IS DISTINCT FROM 'activated' THEN
   RAISE EXCEPTION 'Only an effective active formula version may calculate results'; END IF;
 ELSE
  SELECT * INTO r FROM public.attendance_formula_result WHERE id=NEW.result_id AND tenant_id=NEW.tenant_id AND company_id=NEW.company_id AND employment_id=NEW.employment_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Result is unavailable'; END IF;
  SELECT kind INTO previous FROM public.attendance_formula_result_event WHERE result_id=r.id AND tenant_id=r.tenant_id ORDER BY sequence DESC LIMIT 1;
  IF NOT ((NEW.kind='calculated' AND previous IS NULL) OR(NEW.kind='reviewed' AND previous='calculated') OR(NEW.kind='approved' AND previous='reviewed') OR(NEW.kind='superseded' AND previous IN('calculated','reviewed','approved')) OR(NEW.kind='posted' AND previous='approved') OR(NEW.kind='reversed' AND previous='posted')) THEN RAISE EXCEPTION 'Invalid Attendance result transition'; END IF;
  IF NEW.kind IN('posted','reversed') AND NOT EXISTS(SELECT 1 FROM public.payroll_batch b WHERE b.id=NEW.batch_id AND b.tenant_id=NEW.tenant_id AND b.company_id=NEW.company_id AND b.status='draft' AND app.can_admin_payroll_for(b.company_id)) THEN RAISE EXCEPTION 'Use an authorized draft Payroll run'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.attendance_formula_result_guard() FROM PUBLIC;
CREATE TRIGGER attendance_formula_result_guard BEFORE INSERT ON public.attendance_formula_result FOR EACH ROW EXECUTE FUNCTION app.attendance_formula_result_guard();
CREATE TRIGGER attendance_formula_result_event_guard BEFORE INSERT ON public.attendance_formula_result_event FOR EACH ROW EXECUTE FUNCTION app.attendance_formula_result_guard();

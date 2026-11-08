-- The existing primary key already makes this pair unique; expose it for tenant-bound references.
ALTER TABLE public.pay_component ADD CONSTRAINT attendance_formula_pay_component_tenant_uq UNIQUE(id,tenant_id);
--> statement-breakpoint
-- Formula configuration, immutable versions and private testing evidence. No payroll ledger or settlement.
CREATE TABLE public.attendance_formula (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL REFERENCES public.company(id),code text NOT NULL CHECK(code~'^[A-Za-z][A-Za-z0-9_]{0,63}$'),
 created_by uuid NOT NULL REFERENCES public.app_user(id),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,tenant_id,company_id),FOREIGN KEY(company_id,tenant_id) REFERENCES public.company(id,tenant_id)
);
CREATE UNIQUE INDEX attendance_formula_code_uq ON public.attendance_formula(tenant_id,company_id,lower(code));
CREATE TABLE public.attendance_formula_revision (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL REFERENCES public.company(id),formula_id uuid NOT NULL,ordinal integer NOT NULL CHECK(ordinal>0),
 pay_component_id uuid NOT NULL REFERENCES public.pay_component(id),definition jsonb NOT NULL,
 registry_version text NOT NULL,evaluator_version text NOT NULL,
 content_hash text NOT NULL CHECK(content_hash~'^[a-f0-9]{64}$'),read_requirements jsonb NOT NULL,
 created_by uuid NOT NULL REFERENCES public.app_user(id),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(formula_id,ordinal),UNIQUE(id,formula_id,tenant_id,company_id),
 FOREIGN KEY(company_id,tenant_id) REFERENCES public.company(id,tenant_id),
 FOREIGN KEY(formula_id,tenant_id,company_id) REFERENCES public.attendance_formula(id,tenant_id,company_id),
 FOREIGN KEY(pay_component_id,tenant_id) REFERENCES public.pay_component(id,tenant_id),
 CHECK(jsonb_typeof(definition)='object' AND octet_length(definition::text)<=262144),
 CHECK(definition->>'companyId' IS NOT DISTINCT FROM company_id::text AND definition->>'payItemId' IS NOT DISTINCT FROM pay_component_id::text),
 CHECK(coalesce(jsonb_typeof(read_requirements->'financial')='boolean' AND jsonb_typeof(read_requirements->'workforce')='boolean'
  AND read_requirements-ARRAY['financial','workforce']='{}'::jsonb,false))
);
CREATE TABLE public.attendance_formula_test (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL REFERENCES public.company(id),formula_id uuid NOT NULL,revision_id uuid NOT NULL,
 employment_id uuid NOT NULL REFERENCES public.employment(id),period_from date NOT NULL,period_to date NOT NULL,
 passed boolean NOT NULL,source_hash text NOT NULL CHECK(source_hash~'^[a-f0-9]{64}$'),payload jsonb NOT NULL,
 created_by uuid NOT NULL REFERENCES public.app_user(id),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,formula_id,revision_id,tenant_id,company_id),
 FOREIGN KEY(company_id,tenant_id) REFERENCES public.company(id,tenant_id),
 FOREIGN KEY(revision_id,formula_id,tenant_id,company_id) REFERENCES public.attendance_formula_revision(id,formula_id,tenant_id,company_id),
 FOREIGN KEY(employment_id,tenant_id) REFERENCES public.employment(id,tenant_id),
 CHECK(period_to>=period_from AND period_to-period_from<=61),CHECK(jsonb_typeof(payload)='object' AND octet_length(payload::text)<=2097152)
);
CREATE TABLE public.attendance_formula_event (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),sequence bigserial NOT NULL UNIQUE,
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),company_id uuid NOT NULL REFERENCES public.company(id),formula_id uuid NOT NULL,
 revision_id uuid,test_id uuid,kind text NOT NULL CHECK(kind IN('created','saved','tested','activated','deactivated','archived')),
 detail jsonb NOT NULL DEFAULT '{}'::jsonb,created_by uuid NOT NULL REFERENCES public.app_user(id),created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(company_id,tenant_id) REFERENCES public.company(id,tenant_id),
 FOREIGN KEY(formula_id,tenant_id,company_id) REFERENCES public.attendance_formula(id,tenant_id,company_id),
 FOREIGN KEY(revision_id,formula_id,tenant_id,company_id) REFERENCES public.attendance_formula_revision(id,formula_id,tenant_id,company_id),
 FOREIGN KEY(test_id,formula_id,revision_id,tenant_id,company_id) REFERENCES public.attendance_formula_test(id,formula_id,revision_id,tenant_id,company_id),
 CHECK(kind NOT IN('saved','tested','activated') OR revision_id IS NOT NULL),
 CHECK(kind NOT IN('tested','activated') OR test_id IS NOT NULL),CHECK(jsonb_typeof(detail)='object' AND octet_length(detail::text)<=16384)
);
CREATE INDEX attendance_formula_event_latest_idx ON public.attendance_formula_event(tenant_id,formula_id,sequence DESC);
CREATE INDEX attendance_formula_test_subject_idx ON public.attendance_formula_test(tenant_id,company_id,employment_id,created_at DESC);
--> statement-breakpoint
CREATE FUNCTION app.attendance_formula_trace_access(p_company uuid,p_employment uuid,p_required jsonb) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,app AS $$
 SELECT app.attendance_policy_principal_current() AND app.is_admin_for(p_company) AND app.can_admin_employment(p_employment)
  AND jsonb_typeof(p_required->'financial')='boolean' AND jsonb_typeof(p_required->'workforce')='boolean'
  AND (NOT(p_required->>'workforce')::boolean OR app.access_workforce_employment(p_employment,'workforce.view'))
  AND (NOT(p_required->>'financial')::boolean OR app.pay_formula_trace_access(p_company,p_employment,
   '{"categories":["compensation"],"fieldIds":["payroll.basic_salary_and_salary_history.basicsalary"],"workforce":false}'::jsonb))
$$;
REVOKE ALL ON FUNCTION app.attendance_formula_trace_access(uuid,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.attendance_formula_trace_access(uuid,uuid,jsonb) TO ai_hr_app;
--> statement-breakpoint
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['attendance_formula','attendance_formula_revision','attendance_formula_test','attendance_formula_event'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,ai_hr_app',t);
  EXECUTE format('GRANT SELECT,INSERT ON public.%I TO ai_hr_app',t);
  IF t='attendance_formula_test' THEN
   EXECUTE format('CREATE POLICY attendance_formula_read ON public.%I FOR SELECT USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM public.attendance_formula_revision r WHERE r.id=attendance_formula_test.revision_id AND r.formula_id=attendance_formula_test.formula_id AND r.tenant_id=attendance_formula_test.tenant_id AND r.company_id=attendance_formula_test.company_id AND app.attendance_formula_trace_access(attendance_formula_test.company_id,attendance_formula_test.employment_id,r.read_requirements)))',t);
   EXECUTE format('CREATE POLICY attendance_formula_insert ON public.%I FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND created_by=app.current_user_id() AND EXISTS(SELECT 1 FROM public.attendance_formula_revision r WHERE r.id=attendance_formula_test.revision_id AND r.formula_id=attendance_formula_test.formula_id AND r.tenant_id=attendance_formula_test.tenant_id AND r.company_id=attendance_formula_test.company_id AND app.attendance_formula_trace_access(attendance_formula_test.company_id,attendance_formula_test.employment_id,r.read_requirements)))',t);
  ELSE
   EXECUTE format('CREATE POLICY attendance_formula_read ON public.%I FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.attendance_policy_principal_current() AND app.is_admin_for(company_id))',t);
   EXECUTE format('CREATE POLICY attendance_formula_insert ON public.%I FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND created_by=app.current_user_id() AND app.attendance_policy_principal_current() AND app.is_admin_for(company_id))',t);
  END IF;
 END LOOP;
END $$;
GRANT USAGE,SELECT ON SEQUENCE public.attendance_formula_event_sequence_seq TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.attendance_formula_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
BEGIN RAISE EXCEPTION 'Attendance formula identities, versions and evidence are append-only'; END $$;
REVOKE ALL ON FUNCTION app.attendance_formula_immutable() FROM PUBLIC;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['attendance_formula','attendance_formula_revision','attendance_formula_test','attendance_formula_event'] LOOP
  EXECUTE format('CREATE TRIGGER attendance_formula_immutable BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.attendance_formula_immutable()',t);
 END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.attendance_formula_binding_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
DECLARE f public.attendance_formula; r public.attendance_formula_revision; proof public.attendance_formula_test;
BEGIN
 SELECT * INTO f FROM public.attendance_formula WHERE id=NEW.formula_id AND tenant_id=NEW.tenant_id AND company_id=NEW.company_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Attendance formula or scope is unavailable'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text||':attendance-formula:'||NEW.formula_id::text,0));
 IF EXISTS(SELECT 1 FROM public.attendance_formula_event WHERE formula_id=f.id AND kind='archived') THEN RAISE EXCEPTION 'An archived formula retains its history and cannot change'; END IF;
 IF TG_TABLE_NAME='attendance_formula_revision' THEN
  IF NEW.definition->>'code' IS DISTINCT FROM f.code OR NEW.ordinal<>(SELECT coalesce(max(ordinal),0)+1 FROM public.attendance_formula_revision WHERE formula_id=f.id) THEN RAISE EXCEPTION 'Save the next exact formula version'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.pay_component p WHERE p.id=NEW.pay_component_id AND p.tenant_id=f.tenant_id AND p.archived_at IS NULL AND p.pending_input_kind IS NULL AND NOT p.is_non_payable AND p.kind IN('allowance','deduction') AND(p.applied_company_ids IS NULL OR f.company_id=ANY(p.applied_company_ids))) THEN RAISE EXCEPTION 'Choose an available company Pay Item'; END IF;
 ELSIF TG_TABLE_NAME='attendance_formula_event' AND NEW.kind='activated' THEN
  SELECT * INTO r FROM public.attendance_formula_revision WHERE id=NEW.revision_id AND formula_id=f.id AND tenant_id=f.tenant_id AND company_id=f.company_id;
  IF NOT FOUND OR r.ordinal<>(SELECT max(ordinal) FROM public.attendance_formula_revision WHERE formula_id=f.id) THEN RAISE EXCEPTION 'Activate only the current saved version'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.pay_component p WHERE p.id=r.pay_component_id AND p.tenant_id=f.tenant_id AND p.archived_at IS NULL AND p.pending_input_kind IS NULL AND NOT p.is_non_payable AND p.kind IN('allowance','deduction') AND(p.applied_company_ids IS NULL OR f.company_id=ANY(p.applied_company_ids))) THEN RAISE EXCEPTION 'The company Pay Item changed or is unavailable'; END IF;
  SELECT * INTO proof FROM public.attendance_formula_test WHERE id=NEW.test_id AND formula_id=f.id AND revision_id=r.id AND tenant_id=f.tenant_id AND company_id=f.company_id AND passed;
  IF NOT FOUND THEN RAISE EXCEPTION 'A matching successful actual-attendance test is required'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.attendance_formula_binding_guard() FROM PUBLIC;
CREATE TRIGGER attendance_formula_revision_bind BEFORE INSERT ON public.attendance_formula_revision FOR EACH ROW EXECUTE FUNCTION app.attendance_formula_binding_guard();
CREATE TRIGGER attendance_formula_event_bind BEFORE INSERT ON public.attendance_formula_event FOR EACH ROW EXECUTE FUNCTION app.attendance_formula_binding_guard();

--> statement-breakpoint
-- Independent child restriction for this authoring purpose; disclosure review remains fail-closed.
INSERT INTO app.ai_centre_function_kind(function_key,default_enabled) VALUES('read:operation_attendance_formula_draft',true);

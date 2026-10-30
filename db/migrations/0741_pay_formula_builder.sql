ALTER TABLE pay_component ADD COLUMN formula_context jsonb CHECK(formula_context IS NULL OR jsonb_typeof(formula_context)='object');
--> statement-breakpoint
-- Reusable bounded formulas: immutable revisions, test evidence and protected calculation traces.
CREATE TABLE pay_formula(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),formula_id text NOT NULL CHECK(formula_id~'^[A-Z][A-Z0-9_]{0,63}$'),created_by uuid NOT NULL REFERENCES app_user(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,formula_id));
CREATE TABLE pay_formula_revision(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),formula_id uuid NOT NULL REFERENCES pay_formula(id),ordinal integer NOT NULL CHECK(ordinal>0),description text NOT NULL CHECK(length(description) BETWEEN 1 AND 10000),method text NOT NULL CHECK(method IN ('write','conditions')),source text NOT NULL CHECK(length(source) BETWEEN 1 AND 24000),program jsonb NOT NULL CHECK(program->>'version'='1'),content_hash text NOT NULL CHECK(content_hash~'^[a-f0-9]{64}$'),dependencies jsonb NOT NULL CHECK(jsonb_typeof(dependencies)='array'),dependency_snapshot jsonb NOT NULL,created_by uuid NOT NULL REFERENCES app_user(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(formula_id,ordinal));
CREATE TABLE pay_formula_test(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),revision_id uuid NOT NULL REFERENCES pay_formula_revision(id),company_id uuid NOT NULL REFERENCES company(id),employment_id uuid NOT NULL REFERENCES employment(id),actor_id uuid NOT NULL REFERENCES app_user(id),context jsonb NOT NULL,source_fingerprint text NOT NULL,dependency_fingerprint text NOT NULL,evaluator_version text NOT NULL,registry_version text NOT NULL,passed boolean NOT NULL,amount text,explanations jsonb NOT NULL,error text,read_requirements jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE pay_formula_event(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),formula_id uuid NOT NULL REFERENCES pay_formula(id),revision_id uuid REFERENCES pay_formula_revision(id),test_id uuid REFERENCES pay_formula_test(id),component_id uuid REFERENCES pay_component(id),kind text NOT NULL CHECK(kind IN ('created','saved','tested','activated','deactivated','deleted','linked')),detail jsonb NOT NULL DEFAULT '{}',actor_id uuid NOT NULL REFERENCES app_user(id),sequence bigserial NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE pay_formula_evaluation(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),formula_id uuid NOT NULL REFERENCES pay_formula(id),revision_id uuid NOT NULL REFERENCES pay_formula_revision(id),company_id uuid NOT NULL REFERENCES company(id),employment_id uuid NOT NULL REFERENCES employment(id),batch_id uuid NOT NULL REFERENCES payroll_batch(id),component_code text NOT NULL,period text NOT NULL,amount text NOT NULL,payload jsonb NOT NULL,read_requirements jsonb NOT NULL,actor_id uuid NOT NULL REFERENCES app_user(id),created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE pay_formula_accumulation(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),code text NOT NULL CHECK(code~'^[A-Z][A-Z0-9_]{0,63}$'),ordinal integer NOT NULL CHECK(ordinal>0),members jsonb NOT NULL CHECK(jsonb_typeof(members)='array'),created_by uuid NOT NULL REFERENCES app_user(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,code,ordinal));
CREATE INDEX pay_formula_event_latest ON pay_formula_event(tenant_id,formula_id,sequence DESC);
CREATE INDEX pay_formula_test_revision ON pay_formula_test(tenant_id,revision_id,created_at DESC);
CREATE INDEX pay_formula_evaluation_source ON pay_formula_evaluation(tenant_id,batch_id,employment_id);
--> statement-breakpoint
CREATE FUNCTION app.pay_formula_catalog_access() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT app.current_user_id() IS NOT NULL AND app.principal_snapshot_current() AND app.is_admin()
$$;
CREATE FUNCTION app.pay_formula_definition_read() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT app.current_user_id() IS NOT NULL AND app.principal_snapshot_current() AND (app.is_admin() OR EXISTS(SELECT 1 FROM public.company c WHERE c.tenant_id=app.current_tenant_id() AND app.can_admin_payroll_for(c.id)))
$$;
-- Same override-set semantics as the report category permission owner; no default grants change.
CREATE FUNCTION app.pay_formula_category(p_company uuid,p_category text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app SET row_security=off AS $$
 WITH candidates AS (SELECT DISTINCT g.role FROM jsonb_to_recordset(coalesce(nullif(current_setting('app.grants',true),''),'[]')::jsonb) g(role text,"companyId" uuid)
 WHERE (g."companyId" IS NULL OR g."companyId"=p_company OR app.is_company_descendant(p_company,g."companyId")) AND app.has_role_for(g.role,p_company)),
 overrides AS (SELECT role,allowed,company_id FROM public.payroll_permission_grant WHERE tenant_id=app.current_tenant_id() AND permission_key='report.read.'||p_category AND (company_id IS NULL OR company_id=p_company)),
 selected AS (SELECT * FROM overrides WHERE (company_id=p_company) OR (company_id IS NULL AND NOT EXISTS(SELECT 1 FROM overrides WHERE company_id=p_company)))
 SELECT app.principal_snapshot_current() AND p_category IN ('personnel','compensation','identity','bank','statutory','confidential_hr') AND EXISTS(SELECT 1 FROM candidates c WHERE
 CASE WHEN EXISTS(SELECT 1 FROM selected) THEN EXISTS(SELECT 1 FROM selected s WHERE s.role=c.role AND s.allowed) AND NOT EXISTS(SELECT 1 FROM selected s WHERE s.role=c.role AND NOT s.allowed)
 ELSE c.role IN ('hr_admin','super_admin') END)
$$;
CREATE FUNCTION app.pay_formula_trace_access(p_company uuid,p_employment uuid,p_required jsonb) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT app.principal_snapshot_current() AND app.can_admin_payroll_for(p_company) AND app.access_workforce_employment(p_employment,'workforce.view')
 AND jsonb_typeof(p_required->'categories')='array' AND jsonb_typeof(p_required->'fieldIds')='array'
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(p_required->'categories') c WHERE NOT app.pay_formula_category(p_company,c))
$$;
REVOKE ALL ON FUNCTION app.pay_formula_catalog_access(),app.pay_formula_definition_read(),app.pay_formula_category(uuid,text),app.pay_formula_trace_access(uuid,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.pay_formula_catalog_access(),app.pay_formula_definition_read(),app.pay_formula_category(uuid,text),app.pay_formula_trace_access(uuid,uuid,jsonb) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.pay_formula_bind() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE f uuid; r uuid;
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NOT app.principal_snapshot_current() THEN RAISE EXCEPTION 'Formula identity unavailable'; END IF;
 IF TG_TABLE_NAME IN ('pay_formula','pay_formula_revision','pay_formula_accumulation') THEN
  IF NEW.created_by IS DISTINCT FROM app.current_user_id() THEN RAISE EXCEPTION 'Formula actor mismatch'; END IF;
 ELSE IF NEW.actor_id IS DISTINCT FROM app.current_user_id() THEN RAISE EXCEPTION 'Formula actor mismatch'; END IF; END IF;
 IF TG_TABLE_NAME='pay_formula_revision' THEN
  PERFORM 1 FROM public.pay_formula WHERE id=NEW.formula_id AND tenant_id=NEW.tenant_id FOR UPDATE;
  IF NOT FOUND OR NEW.ordinal<>(SELECT coalesce(max(ordinal),0)+1 FROM public.pay_formula_revision WHERE formula_id=NEW.formula_id) THEN RAISE EXCEPTION 'Formula revision changed'; END IF;
 ELSIF TG_TABLE_NAME='pay_formula_event' THEN
  IF NOT EXISTS(SELECT 1 FROM public.pay_formula WHERE id=NEW.formula_id AND tenant_id=NEW.tenant_id) THEN RAISE EXCEPTION 'Formula event identity mismatch'; END IF;
  IF NEW.revision_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.pay_formula_revision WHERE id=NEW.revision_id AND formula_id=NEW.formula_id AND tenant_id=NEW.tenant_id) THEN RAISE EXCEPTION 'Formula revision identity mismatch'; END IF;
  IF NEW.kind='activated' AND NOT EXISTS(SELECT 1 FROM public.pay_formula_test t JOIN public.pay_formula_revision r ON r.id=t.revision_id WHERE t.id=NEW.test_id AND t.revision_id=NEW.revision_id AND r.formula_id=NEW.formula_id AND t.tenant_id=NEW.tenant_id AND t.passed) THEN RAISE EXCEPTION 'A matching successful formula test is required'; END IF;
 ELSIF TG_TABLE_NAME IN ('pay_formula_test','pay_formula_evaluation') THEN
  IF NOT EXISTS(SELECT 1 FROM public.pay_formula_revision WHERE id=NEW.revision_id AND tenant_id=NEW.tenant_id) OR NOT EXISTS(SELECT 1 FROM public.employment WHERE id=NEW.employment_id AND tenant_id=NEW.tenant_id) OR NOT EXISTS(SELECT 1 FROM public.company WHERE id=NEW.company_id AND tenant_id=NEW.tenant_id) THEN RAISE EXCEPTION 'Formula source identity mismatch'; END IF;
  IF TG_TABLE_NAME='pay_formula_evaluation' THEN
   IF NOT EXISTS(SELECT 1 FROM public.pay_formula_revision WHERE id=NEW.revision_id AND formula_id=NEW.formula_id AND tenant_id=NEW.tenant_id) THEN RAISE EXCEPTION 'Formula evaluation revision mismatch'; END IF;
   IF NOT EXISTS(SELECT 1 FROM public.payroll_batch WHERE id=NEW.batch_id AND tenant_id=NEW.tenant_id AND company_id=NEW.company_id AND pay_period=NEW.period) THEN RAISE EXCEPTION 'Formula payroll source mismatch'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION app.pay_formula_keep_identity() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN RAISE EXCEPTION 'Formula identity is immutable'; END IF;
 IF NEW.formula_id IS DISTINCT FROM OLD.formula_id AND (EXISTS(SELECT 1 FROM public.pay_formula_event WHERE formula_id=OLD.id AND kind IN ('linked','activated')) OR EXISTS(SELECT 1 FROM public.pay_component WHERE tenant_id=OLD.tenant_id AND rule->>'kind'='formula_builder' AND rule->>'formulaId'=OLD.formula_id)) THEN RAISE EXCEPTION 'A referenced Formula ID cannot be renamed'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pay_formula_identity BEFORE UPDATE ON pay_formula FOR EACH ROW EXECUTE FUNCTION app.pay_formula_keep_identity();
--> statement-breakpoint
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['pay_formula','pay_formula_revision','pay_formula_test','pay_formula_event','pay_formula_evaluation','pay_formula_accumulation'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  IF t IN ('pay_formula_test','pay_formula_evaluation') THEN
   EXECUTE format('CREATE POLICY formula_private_read ON %I FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.pay_formula_trace_access(company_id,employment_id,read_requirements))',t);
   EXECUTE format('CREATE POLICY formula_private_insert ON %I FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.pay_formula_trace_access(company_id,employment_id,read_requirements))',t);
  ELSE
   EXECUTE format('CREATE POLICY formula_read ON %I FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.pay_formula_definition_read())',t);
   EXECUTE format('CREATE POLICY formula_insert ON %I FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.pay_formula_catalog_access())',t);
  END IF;
  EXECUTE format('CREATE TRIGGER formula_binding BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION app.pay_formula_bind()',t);
  IF t<>'pay_formula' THEN EXECUTE format('CREATE TRIGGER formula_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION app.payroll_history_immutable()',t); END IF;
  EXECUTE format('GRANT SELECT,INSERT ON %I TO ai_hr_app',t);EXECUTE format('REVOKE UPDATE,DELETE,TRUNCATE ON %I FROM ai_hr_app',t);
 END LOOP;
END $$;
GRANT UPDATE(formula_id) ON pay_formula TO ai_hr_app;
CREATE POLICY formula_update ON pay_formula FOR UPDATE USING(tenant_id=app.current_tenant_id() AND app.pay_formula_catalog_access()) WITH CHECK(tenant_id=app.current_tenant_id() AND app.pay_formula_catalog_access());
GRANT USAGE,SELECT ON SEQUENCE pay_formula_event_sequence_seq TO ai_hr_app;
--> statement-breakpoint
-- Safe activation metadata for computation. Test context, private reads and explanation text never leave this accessor.
CREATE FUNCTION app.pay_formula_active(p_code text) RETURNS TABLE(id uuid,code text,revision_id uuid,ordinal integer,program jsonb,content_hash text,dependencies jsonb,test_id uuid,dependency_fingerprint text,evaluator_version text,registry_version text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app SET row_security=off AS $$
 SELECT f.id,f.formula_id,r.id,r.ordinal,r.program,r.content_hash,r.dependencies,t.id,t.dependency_fingerprint,t.evaluator_version,t.registry_version
 FROM public.pay_formula f JOIN LATERAL(SELECT * FROM public.pay_formula_event e WHERE e.formula_id=f.id AND e.kind IN ('activated','deactivated','deleted') ORDER BY e.sequence DESC LIMIT 1) e ON e.kind='activated'
 JOIN public.pay_formula_revision r ON r.id=e.revision_id AND r.formula_id=f.id AND r.tenant_id=f.tenant_id
 JOIN public.pay_formula_test t ON t.id=e.test_id AND t.revision_id=r.id AND t.tenant_id=f.tenant_id AND t.passed
 WHERE f.tenant_id=app.current_tenant_id() AND f.formula_id=p_code AND app.pay_formula_definition_read()
$$;
REVOKE ALL ON FUNCTION app.pay_formula_active(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.pay_formula_active(text) TO ai_hr_app;
-- Direct SQL cannot invent a materialized graph when linking a reusable formula.
CREATE FUNCTION app.pay_formula_bind_pay_item() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE a record;
BEGIN
 IF NEW.rule->>'kind'='formula_builder' AND (TG_OP='INSERT' OR NEW.rule IS DISTINCT FROM OLD.rule) THEN
  SELECT * INTO a FROM app.pay_formula_active(NEW.rule->>'formulaId');
  IF a.id IS NULL OR NEW.rule->'dependencies' IS DISTINCT FROM a.dependencies THEN RAISE EXCEPTION 'Only an active tested formula and its recorded dependencies may be linked'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pay_formula_pay_item_binding BEFORE INSERT OR UPDATE OF rule ON pay_component FOR EACH ROW EXECUTE FUNCTION app.pay_formula_bind_pay_item();

-- ADR 0181 payroll read addendum, change F (section 9 step 7; section 7 as revised by 11.5): a per-run summary of
-- imported-history runs, projected by the worker, so the Payroll list stops deriving every imported run's totals per
-- request. Installed inert on the 7460 switch: the view is swapped only by app.payroll_read_access_set_mode.
--
-- payroll_history_effective_batch (6693) derives an imported run's employee_count and totals per row: for a session
-- with row security and the tax-basis reader, app.payroll_history_batch_visible_totals(run), the viewer's own share
-- (the run's effective payslips of the employer companies the viewer administers, plus their own payslips of other
-- companies). About 7 ms a run on staging. Native runs keep reading payroll_batch.employee_count and totals, and are
-- not part of F.
--
--   * public.payroll_batch_summary: per imported run, the totals of all its effective payslips and the distinct
--     current companies of their employments (the employer companies), stamped with the tenant's summary version it
--     was projected at. Owner only: it is read through app.payroll_batch_summary_served.
--   * public.payroll_batch_summary_state: per tenant, the summary version and the version last fully projected. The
--     version moves, in the writer's transaction, once per transaction that writes the four history tables (an import,
--     adoption, reversal, a native capture; every such write also writes these tables), at the commit-time step 7490
--     already runs for them (its recompute is extended here to move this version too), and on an employment company
--     change of an employment with imported payslips (one indexed probe on that save). Payslip and payroll_batch money
--     writes never touch it. While a transaction has 7490's notes pending, the state below is NULL for it.
--   * app.payroll_batch_summary_project(tenant): the worker's sweep (core/payroll-batch-summary.ts, a singleton tick on
--     the existing lane). It skips a tenant with a stage in flight, reads the version first, then computes every
--     imported run with 6661's admin-totals statement for a viewer who administers every employer company, and stamps
--     that version. A write committed meanwhile has moved the version, so the stamp is never newer than the data.
--   * app.payroll_batch_summary_served(run, state): the summary's totals only when all hold (section 7.3):
--       1. its stamp equals the tenant's current version (the state carries it, read once per statement);
--       2. the tenant has no stage in flight, and P2 and P4 serve the tenant (else the state is NULL);
--       3. the viewer administers every employer company of the run (P2's company map, once per statement).
--     Then admin totals count every effective payslip and the own-payslip extra adds none, so the viewer's visible
--     totals equal the summary's. Otherwise NULL, and the view derives as today. No money is computed from the
--     summary: it is a copy of what the deterministic statement returns from source rows, or not used.
--   * The view's restated text (stored, swapped by the mode setter, guarded by PostgreSQL's deparse of the expected
--     text) asks the summary first: coalesce(served, visible_totals). 'legacy' and 'shadow' keep the installed view.
--   * app.payroll_batch_summary_verify(tenant) recomputes every current summary and compares; a difference marks the
--     tenant's step untrusted (section 8.3, 11.7). The nightly check runs it.
DO $payroll_read_f_predecessor$
DECLARE body text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.payroll_read_access_control WHERE step='p4_history_filter') THEN
  RAISE EXCEPTION 'The 7490 payroll read step P4 is missing' USING ERRCODE='55000';
 END IF;
 IF md5((SELECT p.prosrc FROM pg_catalog.pg_proc p WHERE p.oid='app.payroll_read_access_set_mode(text,text)'::regprocedure)) IS DISTINCT FROM '498fcb1489e13c02d5c0761ea4833d9e' THEN
  RAISE EXCEPTION 'Unexpected payroll_read_access_set_mode predecessor' USING ERRCODE='55000';
 END IF;
 SELECT pg_get_viewdef('public.payroll_history_effective_batch'::regclass,true) INTO body;
 IF (length(body)-length(replace(body,'THEN app.payroll_history_batch_visible_totals(b.id)','')))/length('THEN app.payroll_history_batch_visible_totals(b.id)')<>1
  OR position('payroll_batch_summary' in body)>0 THEN
  RAISE EXCEPTION 'Unexpected payroll_history_effective_batch predecessor' USING ERRCODE='55000';
 END IF;
END;
$payroll_read_f_predecessor$;
--> statement-breakpoint
CREATE TABLE public.payroll_batch_summary_state(
 tenant_id uuid PRIMARY KEY REFERENCES public.tenant(id) ON DELETE CASCADE,
 version bigint NOT NULL DEFAULT 1,
 projected_version bigint NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE public.payroll_batch_summary(
 batch_id uuid PRIMARY KEY REFERENCES public.payroll_batch(id) ON DELETE CASCADE,
 tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
 effective_totals jsonb NOT NULL,
 employer_company_ids uuid[] NOT NULL,
 source_version bigint NOT NULL,
 projected_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX payroll_batch_summary_tenant_idx ON public.payroll_batch_summary(tenant_id);
--> statement-breakpoint
-- The views a step swaps, with their legacy and restated text (pg_get_viewdef form) and options.
CREATE TABLE public.payroll_read_access_view(
 view_name text PRIMARY KEY CHECK(view_name ~ '^[a-z][a-z0-9_]{0,62}$'),
 step text NOT NULL REFERENCES public.payroll_read_access_control(step),
 legacy_text text NOT NULL,
 restated_text text NOT NULL,
 options text NOT NULL
);
--> statement-breakpoint
ALTER TABLE public.payroll_batch_summary_state ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.payroll_batch_summary_state FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.payroll_batch_summary ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.payroll_batch_summary FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.payroll_read_access_view ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.payroll_read_access_view FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY payroll_batch_summary_state_owner ON public.payroll_batch_summary_state FOR ALL USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
--> statement-breakpoint
CREATE POLICY payroll_batch_summary_owner ON public.payroll_batch_summary FOR ALL USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
--> statement-breakpoint
CREATE POLICY payroll_read_access_view_owner ON public.payroll_read_access_view FOR ALL USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
--> statement-breakpoint
REVOKE ALL ON public.payroll_batch_summary_state,public.payroll_batch_summary,public.payroll_read_access_view FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.payroll_batch_summary_bump(p_tenants uuid[]) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 INSERT INTO public.payroll_batch_summary_state AS s(tenant_id,version) SELECT DISTINCT t,2 FROM unnest(p_tenants) t WHERE t IS NOT NULL ORDER BY 1
 ON CONFLICT(tenant_id) DO UPDATE SET version=s.version+1;
$$;
--> statement-breakpoint
CREATE FUNCTION app.payroll_batch_summary_employment_moved() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.payslip p JOIN public.payroll_batch b ON b.id=p.batch_id
  WHERE p.employment_id=NEW.id AND b.history_import_attempt_id IS NOT NULL) THEN
  PERFORM app.payroll_batch_summary_bump(ARRAY[NEW.tenant_id]);
 END IF;
 RETURN NULL;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_batch_summary_bump(uuid[]),app.payroll_batch_summary_employment_moved() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- 7490's commit-time recompute, extended to move the summary version of every tenant it recomputed; otherwise word for
-- word (guarded by its 7490 body).
DO $payroll_read_f_commit_predecessor$
BEGIN
 IF md5((SELECT p.prosrc FROM pg_catalog.pg_proc p WHERE p.oid='app.payroll_history_ineffective_commit()'::regprocedure)) IS DISTINCT FROM 'a5bbc7962cd4f37ab165ce0024134bde' THEN
  RAISE EXCEPTION 'Unexpected payroll_history_ineffective_commit predecessor' USING ERRCODE='55000';
 END IF;
END;
$payroll_read_f_commit_predecessor$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.payroll_history_ineffective_commit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE pending text:=coalesce(current_setting('app.payroll_history_pending',true),'');r record;
BEGIN
 IF pending<>'' THEN
  FOR r IN WITH note AS (SELECT split_part(x,'|',1)::uuid AS t,split_part(x,'|',2) AS k,split_part(x,'|',3)::uuid AS id
    FROM regexp_split_to_table(pending,E'\n') x WHERE x<>'')
   SELECT n.t,coalesce(array_agg(DISTINCT n.id) FILTER (WHERE n.k='p'),'{}') AS p,coalesce(array_agg(DISTINCT n.id) FILTER (WHERE n.k='r'),'{}') AS rec,
    coalesce(array_agg(DISTINCT n.id) FILTER (WHERE n.k='b'),'{}') AS runs FROM note n GROUP BY n.t ORDER BY n.t LOOP
   PERFORM app.payroll_history_ineffective_refresh(r.t,r.p||app.payroll_history_ineffective_record_payslips(r.t,r.rec)||app.payroll_history_ineffective_batch_payslips(r.t,r.runs));
   PERFORM app.payroll_batch_summary_bump(ARRAY[r.t]);
  END LOOP;
  PERFORM set_config('app.payroll_history_pending','',true);
 END IF;
 DELETE FROM public.payroll_history_ineffective_commit c WHERE c.txid=txid_current();
 RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER payroll_batch_summary_employment_moved AFTER UPDATE OF company_id ON public.employment
 FOR EACH ROW WHEN (OLD.company_id IS DISTINCT FROM NEW.company_id) EXECUTE FUNCTION app.payroll_batch_summary_employment_moved();
--> statement-breakpoint
-- Every imported run of the tenant: 6661's admin-totals statement for a viewer who administers every employer company
-- (so every effective payslip counts), with no stage in flight (so no row is hidden). The caller sets the tenant.
CREATE FUNCTION app.payroll_batch_summary_compute(p_tenant uuid) RETURNS TABLE(batch_id uuid,effective_totals jsonb,employer_company_ids uuid[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
 WITH run AS MATERIALIZED(SELECT b.id FROM public.payroll_batch b WHERE b.tenant_id=p_tenant AND b.history_import_attempt_id IS NOT NULL),
 slip AS MATERIALIZED(
  SELECT p.id,p.batch_id,p.gross_pay,p.net_pay,p.statutory,e.company_id
  FROM public.payslip p JOIN run r ON r.id=p.batch_id JOIN public.employment e ON e.id=p.employment_id AND e.tenant_id=p.tenant_id
  WHERE p.tenant_id=p_tenant
 ), effective AS MATERIALIZED(SELECT DISTINCT x.id FROM app.payroll_history_effective_ids(ARRAY(SELECT s.id FROM slip s)) AS x(id) WHERE x.id IS NOT NULL),
 counted AS MATERIALIZED(SELECT s.* FROM slip s WHERE s.id IN (SELECT e.id FROM effective e))
 SELECT r.id,
  (SELECT jsonb_build_object('employeeCount',count(*),'gross',coalesce(sum(c.gross_pay),0),'net',coalesce(sum(c.net_pay),0),
   'epfEmployee',coalesce(sum((c.statutory->>'epfEmployee')::numeric),0),'epfEmployer',coalesce(sum((c.statutory->>'epfEmployer')::numeric),0),
   'socsoEmployee',coalesce(sum((c.statutory->>'socsoEmployee')::numeric),0),'socsoEmployer',coalesce(sum((c.statutory->>'socsoEmployer')::numeric),0),
   'eisEmployee',coalesce(sum((c.statutory->>'eisEmployee')::numeric),0),'eisEmployer',coalesce(sum((c.statutory->>'eisEmployer')::numeric),0),'pcb',coalesce(sum((c.statutory->>'pcb')::numeric),0))
   FROM counted c WHERE c.batch_id=r.id),
  coalesce((SELECT array_agg(DISTINCT s.company_id ORDER BY s.company_id) FROM slip s WHERE s.batch_id=r.id),'{}'::uuid[])
 FROM run r;
$$;
--> statement-breakpoint
-- The worker's sweep for one tenant; returns the runs projected, or -1 when a stage is in flight.
CREATE FUNCTION app.payroll_batch_summary_project(p_tenant uuid) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v bigint;n integer;prior text:=current_setting('app.tenant_id',true);
BEGIN
 IF EXISTS(SELECT 1 FROM app.payroll_history_stage s WHERE s.tenant_id=p_tenant AND s.state='staged') THEN RETURN -1; END IF;
 INSERT INTO public.payroll_batch_summary_state(tenant_id) VALUES(p_tenant) ON CONFLICT(tenant_id) DO NOTHING;
 SELECT s.version INTO v FROM public.payroll_batch_summary_state s WHERE s.tenant_id=p_tenant;
 PERFORM set_config('app.tenant_id',p_tenant::text,true);
 DELETE FROM public.payroll_batch_summary x WHERE x.tenant_id=p_tenant AND NOT EXISTS(SELECT 1 FROM public.payroll_batch b WHERE b.id=x.batch_id AND b.history_import_attempt_id IS NOT NULL);
 INSERT INTO public.payroll_batch_summary AS x(batch_id,tenant_id,effective_totals,employer_company_ids,source_version,projected_at)
  SELECT c.batch_id,p_tenant,c.effective_totals,c.employer_company_ids,v,now() FROM app.payroll_batch_summary_compute(p_tenant) c
  ON CONFLICT(batch_id) DO UPDATE SET effective_totals=excluded.effective_totals,employer_company_ids=excluded.employer_company_ids,
   source_version=excluded.source_version,projected_at=excluded.projected_at;
 GET DIAGNOSTICS n=ROW_COUNT;
 UPDATE public.payroll_batch_summary_state s SET projected_version=greatest(s.projected_version,v) WHERE s.tenant_id=p_tenant;
 PERFORM set_config('app.tenant_id',coalesce(prior,''),true);
 RETURN n;
END;
$$;
--> statement-breakpoint
-- Operator only (section 7.4 and 8.3): recompute every current summary and compare it; a difference marks the step
-- untrusted for the tenant. Counts only.
CREATE FUNCTION app.payroll_batch_summary_verify(p_tenant uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v bigint;differ bigint:=0;checked bigint:=0;prior text:=current_setting('app.tenant_id',true);
BEGIN
 IF EXISTS(SELECT 1 FROM app.payroll_history_stage s WHERE s.tenant_id=p_tenant AND s.state='staged') THEN
  RETURN jsonb_build_object('checked',0,'differ',0,'skipped','stage');
 END IF;
 SELECT s.version INTO v FROM public.payroll_batch_summary_state s WHERE s.tenant_id=p_tenant;
 PERFORM set_config('app.tenant_id',p_tenant::text,true);
 SELECT count(*),count(*) FILTER (WHERE c.batch_id IS NULL OR c.effective_totals IS DISTINCT FROM x.effective_totals OR c.employer_company_ids IS DISTINCT FROM x.employer_company_ids)
  INTO checked,differ
 FROM public.payroll_batch_summary x LEFT JOIN app.payroll_batch_summary_compute(p_tenant) c ON c.batch_id=x.batch_id
 WHERE x.tenant_id=p_tenant AND x.source_version=v;
 PERFORM set_config('app.tenant_id',coalesce(prior,''),true);
 IF differ>0 THEN
  INSERT INTO public.payroll_read_access_tenant AS t(tenant_id,step,trusted,last_difference_count) VALUES(p_tenant,'f_history_summary',false,differ)
   ON CONFLICT(tenant_id,step) DO UPDATE SET trusted=false,last_difference_count=excluded.last_difference_count;
  RAISE LOG 'payroll_read_access verify step=f_history_summary checked=% differ=%',checked,differ;
 END IF;
 RETURN jsonb_build_object('checked',checked,'differ',differ,
  'trusted',coalesce((SELECT t.trusted FROM public.payroll_read_access_tenant t WHERE t.tenant_id=p_tenant AND t.step='f_history_summary'),true));
END;
$$;
--> statement-breakpoint
-- Once per statement: NULL unless P2 and P4 serve the tenant, no stage is in flight and this transaction has no
-- history maintenance pending; otherwise P2's company map
-- with the tenant's current summary version under the key "v".
CREATE FUNCTION app.payroll_batch_summary_state() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();v bigint;
BEGIN
 IF NOT (app.payroll_read_access_on('p2_admin_companies') AND app.payroll_read_access_on('p4_history_filter')) THEN RETURN NULL; END IF;
 IF coalesce(current_setting('app.payroll_history_pending',true),'')<>'' THEN RETURN NULL; END IF;
 IF EXISTS(SELECT 1 FROM app.payroll_history_stage s WHERE s.tenant_id=t AND s.state='staged') THEN RETURN NULL; END IF;
 SELECT s.version INTO v FROM public.payroll_batch_summary_state s WHERE s.tenant_id=t;
 IF NOT FOUND THEN RETURN NULL; END IF;
 RETURN app.payroll_admin_company_set()||jsonb_build_object('v',v);
END;
$$;
--> statement-breakpoint
CREATE FUNCTION app.payroll_batch_summary_served(p_batch uuid,p_state jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE s record;
BEGIN
 IF p_state IS NULL OR p_batch IS NULL OR p_state ? 'none' THEN RETURN NULL; END IF;
 SELECT x.effective_totals,x.employer_company_ids,x.source_version INTO s FROM public.payroll_batch_summary x
 WHERE x.batch_id=p_batch AND x.tenant_id=app.current_tenant_id();
 IF NOT FOUND OR s.source_version IS DISTINCT FROM (p_state->>'v')::bigint THEN RETURN NULL; END IF;
 IF EXISTS(SELECT 1 FROM unnest(s.employer_company_ids) c(id) WHERE (p_state->>c.id::text) IS DISTINCT FROM 'true') THEN RETURN NULL; END IF;
 RETURN s.effective_totals;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_batch_summary_compute(uuid),app.payroll_batch_summary_project(uuid),app.payroll_batch_summary_verify(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_batch_summary_state(),app.payroll_batch_summary_served(uuid,jsonb) FROM PUBLIC;
--> statement-breakpoint
-- The view is security_invoker, so every role reading it evaluates these: the same roles that may execute the
-- function they wrap (app.payroll_history_batch_visible_totals).
DO $payroll_read_f_grants$
DECLARE x record;
BEGIN
 FOR x IN SELECT DISTINCT a.grantee FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
  WHERE p.oid='app.payroll_history_batch_visible_totals(uuid)'::regprocedure AND a.privilege_type='EXECUTE' AND a.grantee<>0 AND a.grantee<>p.proowner
 LOOP
  EXECUTE format('GRANT EXECUTE ON FUNCTION app.payroll_read_access_on(text),app.payroll_batch_summary_state(),app.payroll_batch_summary_served(uuid,jsonb) TO %I',pg_catalog.pg_get_userbyid(x.grantee));
 END LOOP;
 EXECUTE 'GRANT EXECUTE ON FUNCTION app.payroll_read_access_on(text),app.payroll_batch_summary_state(),app.payroll_batch_summary_served(uuid,jsonb) TO ai_hr_app';
END;
$payroll_read_f_grants$;
--> statement-breakpoint
INSERT INTO public.payroll_read_access_control(step,mode) VALUES('f_history_summary','legacy');
--> statement-breakpoint
INSERT INTO public.payroll_read_access_view(view_name,step,legacy_text,restated_text,options)
 SELECT 'payroll_history_effective_batch','f_history_summary',d,
  replace(d,'THEN app.payroll_history_batch_visible_totals(b.id)',
   $q$THEN coalesce(app.payroll_batch_summary_served(b.id, (SELECT CASE WHEN app.payroll_read_access_on('f_history_summary') THEN app.payroll_batch_summary_state() END)), app.payroll_history_batch_visible_totals(b.id))$q$),
  coalesce((SELECT array_to_string(c.reloptions,',') FROM pg_catalog.pg_class c WHERE c.oid='public.payroll_history_effective_batch'::regclass),'')
 FROM pg_get_viewdef('public.payroll_history_effective_batch'::regclass,true) d;
--> statement-breakpoint
-- Whether a view is installed exactly as the given text, as PostgreSQL deparses both (a scratch temporary view).
CREATE FUNCTION app.payroll_read_access_view_installed_as(p_view text,p_text text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE installed text;expected text;
BEGIN
 installed:=pg_get_viewdef(to_regclass(format('public.%I',p_view)),true);
 EXECUTE format('CREATE TEMPORARY VIEW payroll_read_access_scratch_view AS %s',p_text);
 expected:=pg_get_viewdef('pg_temp.payroll_read_access_scratch_view'::regclass,true);
 DROP VIEW pg_temp.payroll_read_access_scratch_view;
 RETURN installed IS NOT DISTINCT FROM expected;
END;
$$;
--> statement-breakpoint
-- Swap a step's views from one mode's text to another's ('precomputed' takes the restated text), each guarded.
CREATE FUNCTION app.payroll_read_access_swap_views(p_step text,p_from text,p_to text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v record;cur text;next text;
BEGIN
 FOR v IN SELECT * FROM public.payroll_read_access_view x WHERE x.step=p_step ORDER BY x.view_name LOOP
  cur:=CASE WHEN p_from='precomputed' THEN v.restated_text ELSE v.legacy_text END;
  next:=CASE WHEN p_to='precomputed' THEN v.restated_text ELSE v.legacy_text END;
  IF NOT app.payroll_read_access_view_installed_as(v.view_name,cur) THEN
   RAISE EXCEPTION 'View % differs from its recorded text; review before switching',v.view_name USING ERRCODE='55000';
  END IF;
  IF next IS DISTINCT FROM cur THEN
   EXECUTE format('CREATE OR REPLACE VIEW public.%I %s AS %s',v.view_name,CASE WHEN v.options='' THEN '' ELSE 'WITH ('||v.options||')' END,next);
  END IF;
 END LOOP;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_read_access_view_installed_as(text,text),app.payroll_read_access_swap_views(text,text,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
DO $payroll_read_f_view$
BEGIN
 IF (SELECT count(*) FROM public.payroll_read_access_view WHERE restated_text<>legacy_text)<>1
  OR NOT app.payroll_read_access_view_installed_as('payroll_history_effective_batch',(SELECT legacy_text FROM public.payroll_read_access_view WHERE view_name='payroll_history_effective_batch')) THEN
  RAISE EXCEPTION 'payroll_history_effective_batch could not be recorded' USING ERRCODE='55000';
 END IF;
END;
$payroll_read_f_view$;
--> statement-breakpoint
-- The 7460 mode setter, extended to swap a step's views after its policies; otherwise word for word.
CREATE OR REPLACE FUNCTION app.payroll_read_access_set_mode(p_step text,p_mode text) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET lock_timeout='5s' AS $$
DECLARE cur text;p record;next text;
BEGIN
 IF p_mode IS NULL OR p_mode NOT IN ('legacy','shadow','precomputed') THEN RAISE EXCEPTION 'Unknown payroll read access mode' USING ERRCODE='22023'; END IF;
 SELECT c.mode INTO cur FROM public.payroll_read_access_control c WHERE c.step=p_step FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Unknown payroll read access step' USING ERRCODE='22023'; END IF;
 FOR p IN SELECT DISTINCT f.table_name,f.policy_name FROM public.payroll_read_access_fragment f WHERE f.step=p_step ORDER BY 1,2 LOOP
  IF NOT app.payroll_read_access_installed_as(p.table_name,p.policy_name,app.payroll_read_access_policy_text(p.table_name,p.policy_name,NULL)) THEN
   RAISE EXCEPTION 'Policy %.% differs from its recorded text; review before switching',p.table_name,p.policy_name USING ERRCODE='55000';
  END IF;
  next:=app.payroll_read_access_policy_text(p.table_name,p.policy_name,jsonb_build_object(p_step,p_mode));
  EXECUTE format('ALTER POLICY %I ON public.%I USING (%s)',p.policy_name,p.table_name,next);
 END LOOP;
 PERFORM app.payroll_read_access_swap_views(p_step,cur,p_mode);
 UPDATE public.payroll_read_access_control SET mode=p_mode,updated_at=now() WHERE step=p_step;
 RAISE LOG 'payroll_read_access mode step=% from=% to=%',p_step,cur,p_mode;
 RETURN p_mode;
END;
$$;
--> statement-breakpoint
-- Every existing tenant starts at version 1, unprojected: nothing is served until the worker projects it.
INSERT INTO public.payroll_batch_summary_state(tenant_id) SELECT t.id FROM public.tenant t ORDER BY 1;

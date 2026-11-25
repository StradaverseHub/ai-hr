-- ADR 0181 payroll read addendum (docs/adr/0181-addendum-payroll-read-access-and-read-model.md), step P1 (section 9
-- step 3, as revised by section 11), started at the owner's request on 25 November 2026 ("Read models + standard").
--
-- This installs, inert, the switch every payroll read step uses, and P1's own restatement:
--   * public.payroll_read_access_control: one mode per step ('legacy', 'shadow', 'precomputed'), installation wide,
--     owner only. Every step starts as 'legacy'.
--   * public.payroll_read_access_fragment: each restated policy's USING text as an ordered list of pieces. A piece with
--     no step is constant; a step's piece has its legacy text and its restated text. The installed USING of a policy
--     is always the pieces joined under the current modes ('precomputed' takes the restated text, 'legacy' and
--     'shadow' the legacy text). Installing a step adds pieces and changes no policy.
--   * public.payroll_read_access_tenant: per tenant and step, whether the restated text may serve that tenant. A
--     comparison difference marks it untrusted, and the restated arms then call the legacy function for that tenant.
--     The fallback is the legacy answer, never a denial.
--   * app.payroll_read_access_set_mode(step, mode): operator only. In one transaction it checks that every policy the
--     step touches is installed exactly as the pieces say under the current modes (PostgreSQL's own deparse of both),
--     then ALTER POLICY to the pieces under the new mode. Rollback is the same call with 'legacy'.
--   * app.payroll_read_access_compare(step, tenant): operator only. For every user of the tenant, under that user's
--     own role assignments (the claims a sign-in would carry), with and without the payroll reader settings, it
--     evaluates each of the step's legacy and restated pieces on every distinct input the piece reads, and counts
--     differences in value and in raising. Counts only. A difference marks the tenant's step untrusted.
--   * app.payroll_read_access_retrust(step, tenant): operator only; compares again and trusts only a clean result.
--
-- P1 (section 4, "Reader settings"): the two restrictive payslip guards call a SECURITY DEFINER function with SET per
-- row, and each returns true at its first line because every tenant transaction sets its reader setting to '1'
-- (db/client.ts bootstrapTenantTx). P1's restated pieces call a plain PL/pgSQL arm with the same cost, volatility and
-- parallel safety, so the planner's estimates do not move (the 7280 lesson). The arm returns true at once when the step
-- serves this tenant and the setting is '1', which is when the legacy function returns true at once; otherwise it
-- calls the legacy function, which still raises exactly where it raises today. Whether the step serves the tenant is
-- read once per statement (an InitPlan). No policy changes on install.
DO $payroll_read_p1_predecessor$
DECLARE p pg_catalog.pg_proc%ROWTYPE;
BEGIN
 SELECT * INTO p FROM pg_catalog.pg_proc WHERE oid=to_regprocedure('app.payroll_tax_basis_reader_compatible(uuid,uuid)');
 IF NOT FOUND OR md5(p.prosrc) IS DISTINCT FROM 'c0f37ea5eb18e058d480b6449f245a12' OR p.prosecdef IS DISTINCT FROM true
  OR p.provolatile<>'s' OR p.proretset OR p.prorettype IS DISTINCT FROM ('boolean'::regtype)::oid OR p.procost<>100 OR p.proparallel<>'u' THEN
  RAISE EXCEPTION 'Unexpected payroll_tax_basis_reader_compatible predecessor; review before restating it' USING ERRCODE='55000';
 END IF;
 SELECT * INTO p FROM pg_catalog.pg_proc WHERE oid=to_regprocedure('app.payroll_import_tax_reader_compatible(uuid,uuid,jsonb)');
 IF NOT FOUND OR md5(p.prosrc) IS DISTINCT FROM 'b4002416af85088868a9d1b9c86e1f9c' OR p.prosecdef IS DISTINCT FROM true
  OR p.provolatile<>'s' OR p.proretset OR p.prorettype IS DISTINCT FROM ('boolean'::regtype)::oid OR p.procost<>100 OR p.proparallel<>'u' THEN
  RAISE EXCEPTION 'Unexpected payroll_import_tax_reader_compatible predecessor; review before restating it' USING ERRCODE='55000';
 END IF;
 IF to_regclass('public.payroll_read_access_control') IS NOT NULL THEN
  RAISE EXCEPTION 'Payroll read access switch already exists' USING ERRCODE='55000';
 END IF;
END;
$payroll_read_p1_predecessor$;
--> statement-breakpoint
CREATE TABLE public.payroll_read_access_control(
 step text PRIMARY KEY CHECK(step ~ '^[a-z][a-z0-9_]{0,62}$'),
 mode text NOT NULL DEFAULT 'legacy' CHECK(mode IN ('legacy','shadow','precomputed')),
 -- Set only when an operator changes the mode, so the migration's own rows hold no wall-clock value.
 updated_at timestamptz
);
--> statement-breakpoint
CREATE TABLE public.payroll_read_access_fragment(
 table_name text NOT NULL CHECK(table_name ~ '^[a-z][a-z0-9_]{0,62}$'),
 policy_name text NOT NULL CHECK(policy_name ~ '^[a-z][a-z0-9_]{0,62}$'),
 ordinal integer NOT NULL,
 step text REFERENCES public.payroll_read_access_control(step),
 legacy_text text NOT NULL,
 restated_text text,
 -- The row columns a step's piece reads: the comparison evaluates the piece once per distinct value of them.
 inputs text[],
 PRIMARY KEY(table_name,policy_name,ordinal),
 CHECK((step IS NULL)=(restated_text IS NULL) AND (step IS NULL)=(inputs IS NULL))
);
--> statement-breakpoint
CREATE TABLE public.payroll_read_access_tenant(
 tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
 step text NOT NULL REFERENCES public.payroll_read_access_control(step),
 trusted boolean NOT NULL DEFAULT true,
 last_compared_at timestamptz,
 last_users integer NOT NULL DEFAULT 0,
 last_difference_count bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(tenant_id,step)
);
--> statement-breakpoint
INSERT INTO public.payroll_read_access_control(step,mode) VALUES('p1_tax_reader_guards','legacy');
--> statement-breakpoint
INSERT INTO public.payroll_read_access_fragment(table_name,policy_name,ordinal,step,legacy_text,restated_text,inputs) VALUES
 ('payslip','payroll_tax_basis_reader_guard',1,'p1_tax_reader_guards',
  $q$app.payroll_tax_basis_reader_compatible(employment_id, batch_id)$q$,
  $q$app.payroll_tax_basis_reader_arm(employment_id, batch_id, (SELECT app.payroll_read_access_on('p1_tax_reader_guards')))$q$,
  ARRAY['employment_id','batch_id']),
 ('payslip','payroll_import_tax_basis_reader_guard',1,'p1_tax_reader_guards',
  $q$app.payroll_import_tax_reader_compatible(employment_id, batch_id, (statutory -> 'importedTaxBasis'::text))$q$,
  $q$app.payroll_import_tax_reader_arm(employment_id, batch_id, (statutory -> 'importedTaxBasis'::text), (SELECT app.payroll_read_access_on('p1_tax_reader_guards')))$q$,
  ARRAY['employment_id','batch_id','statutory']);
--> statement-breakpoint
ALTER TABLE public.payroll_read_access_control ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.payroll_read_access_control FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.payroll_read_access_fragment ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.payroll_read_access_fragment FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.payroll_read_access_tenant ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.payroll_read_access_tenant FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY payroll_read_access_control_owner ON public.payroll_read_access_control FOR ALL USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
--> statement-breakpoint
CREATE POLICY payroll_read_access_fragment_owner ON public.payroll_read_access_fragment FOR ALL USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
--> statement-breakpoint
CREATE POLICY payroll_read_access_tenant_owner ON public.payroll_read_access_tenant FOR ALL USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
--> statement-breakpoint
REVOKE ALL ON public.payroll_read_access_control,public.payroll_read_access_fragment,public.payroll_read_access_tenant FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Whether a step serves the caller's tenant: its mode is 'precomputed' and the tenant is not marked untrusted. Read
-- once per statement by the restated pieces. A tenant without a row is trusted.
CREATE FUNCTION app.payroll_read_access_on(p_step text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 RETURN coalesce((SELECT c.mode='precomputed' FROM public.payroll_read_access_control c WHERE c.step=p_step),false)
  AND NOT EXISTS(SELECT 1 FROM public.payroll_read_access_tenant t WHERE t.tenant_id=app.current_tenant_id() AND t.step=p_step AND NOT t.trusted);
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_read_access_on(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payroll_read_access_on(text) TO ai_hr_app;
--> statement-breakpoint
-- Operator only: what the comparison substitutes for app.payroll_read_access_on, so it evaluates a step's restated
-- pieces as if the step served the tenant, whatever its mode.
CREATE FUNCTION app.payroll_read_access_forced(p_step text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.payroll_read_access_control c WHERE c.step=p_step);
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_read_access_forced(text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- P1's arms. Not SECURITY DEFINER and without SET, so a call costs a plain PL/pgSQL entry, not the definer function's
-- setting save and restore. Same cost (100), volatility (STABLE) and parallel safety (unsafe) as the functions they
-- stand for. The setting is read per row, exactly as the legacy function reads it.
CREATE FUNCTION app.payroll_tax_basis_reader_arm(subject_employment uuid,source_batch uuid,serves boolean) RETURNS boolean
LANGUAGE plpgsql STABLE COST 100 AS $$
BEGIN
 IF serves AND current_setting('app.payroll_tax_basis_reader',true)='1' THEN RETURN true; END IF;
 RETURN app.payroll_tax_basis_reader_compatible(subject_employment,source_batch);
END;
$$;
--> statement-breakpoint
CREATE FUNCTION app.payroll_import_tax_reader_arm(subject_employment uuid,source_batch uuid,stamp jsonb,serves boolean) RETURNS boolean
LANGUAGE plpgsql STABLE COST 100 AS $$
BEGIN
 IF serves AND (stamp IS NULL OR current_setting('app.payroll_import_tax_basis_reader',true)='1') THEN RETURN true; END IF;
 RETURN app.payroll_import_tax_reader_compatible(subject_employment,source_batch,stamp);
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_tax_basis_reader_arm(uuid,uuid,boolean),app.payroll_import_tax_reader_arm(uuid,uuid,jsonb,boolean) FROM PUBLIC;
--> statement-breakpoint
-- The guards are policies TO ai_hr_app, so only that role evaluates the arms.
GRANT EXECUTE ON FUNCTION app.payroll_tax_basis_reader_arm(uuid,uuid,boolean),app.payroll_import_tax_reader_arm(uuid,uuid,jsonb,boolean) TO ai_hr_app;
--> statement-breakpoint
-- A policy's USING text from its pieces: the current modes, with p_modes ({"step": "mode"}) overriding some of them.
CREATE FUNCTION app.payroll_read_access_policy_text(p_table text,p_policy text,p_modes jsonb) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT string_agg(CASE WHEN f.step IS NULL THEN f.legacy_text
   WHEN coalesce(p_modes->>f.step,c.mode)='precomputed' THEN f.restated_text ELSE f.legacy_text END,'' ORDER BY f.ordinal)
 FROM public.payroll_read_access_fragment f LEFT JOIN public.payroll_read_access_control c ON c.step=f.step
 WHERE f.table_name=p_table AND f.policy_name=p_policy;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_read_access_policy_text(text,text,jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Whether a policy's installed USING is exactly the given text, as PostgreSQL deparses both: the text is attached to a
-- scratch policy on the same table inside the caller's transaction, read back and dropped.
CREATE FUNCTION app.payroll_read_access_installed_as(p_table text,p_policy text,p_text text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE installed text;expected text;rel regclass:=to_regclass(format('public.%I',p_table));
BEGIN
 IF rel IS NULL OR p_text IS NULL THEN RETURN false; END IF;
 SELECT pg_get_expr(p.polqual,p.polrelid) INTO installed FROM pg_catalog.pg_policy p WHERE p.polrelid=rel AND p.polname=p_policy;
 IF NOT FOUND THEN RETURN false; END IF;
 EXECUTE format('CREATE POLICY payroll_read_access_scratch ON %s AS RESTRICTIVE FOR SELECT TO ai_hr_app USING (%s)',rel,p_text);
 SELECT pg_get_expr(p.polqual,p.polrelid) INTO expected FROM pg_catalog.pg_policy p WHERE p.polrelid=rel AND p.polname='payroll_read_access_scratch';
 EXECUTE format('DROP POLICY payroll_read_access_scratch ON %s',rel);
 RETURN installed IS NOT DISTINCT FROM expected;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_read_access_installed_as(text,text,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Every policy with pieces must be installed as its pieces say under the current modes (all 'legacy' here).
DO $payroll_read_p1_policies$
DECLARE p record;
BEGIN
 FOR p IN SELECT DISTINCT f.table_name,f.policy_name FROM public.payroll_read_access_fragment f ORDER BY 1,2 LOOP
  IF NOT app.payroll_read_access_installed_as(p.table_name,p.policy_name,app.payroll_read_access_policy_text(p.table_name,p.policy_name,NULL)) THEN
   RAISE EXCEPTION 'Policy %.% differs from the reviewed predecessor',p.table_name,p.policy_name USING ERRCODE='55000';
  END IF;
 END LOOP;
END;
$payroll_read_p1_policies$;
--> statement-breakpoint
-- Operator only, installation wide. Swaps every policy the step touches in one transaction, each guarded by the text
-- its pieces give under the current modes. Waits at most five seconds for the table locks ALTER POLICY needs.
CREATE FUNCTION app.payroll_read_access_set_mode(p_step text,p_mode text) RETURNS text
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
 UPDATE public.payroll_read_access_control SET mode=p_mode,updated_at=now() WHERE step=p_step;
 RAISE LOG 'payroll_read_access mode step=% from=% to=%',p_step,cur,p_mode;
 RETURN p_mode;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_read_access_set_mode(text,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Operator only: the every-user comparison of one step on one tenant (section 11.2). For each user of the tenant,
-- under that user's own role assignments, and for each reader setting value ('1' as every tenant transaction sets
-- it, and unset), each of the step's pieces is evaluated legacy and restated (the restated one as if the step served
-- the tenant) on every distinct value of the row columns it reads. A piece that raises is compared by whether, and
-- with which SQLSTATE, each side raises. Counts only, in the result and in one log line. Any difference marks the
-- tenant's step untrusted; a clean run records the time and leaves the trust as it was. The caller's settings are
-- restored before it returns.
CREATE FUNCTION app.payroll_read_access_compare(p_step text,p_tenant uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
 u record;f record;reader text;legacy_sql text;restated_sql text;inputs text;
 users integer:=0;evaluations bigint:=0;values_differ bigint:=0;raises_differ bigint:=0;n bigint;m bigint;
 legacy_state text;restated_state text;
 prior_tenant text:=current_setting('app.tenant_id',true);prior_user text:=current_setting('app.user_id',true);
 prior_roles text:=current_setting('app.roles',true);prior_grants text:=current_setting('app.grants',true);
 prior_agent text:=current_setting('app.agent_principal_id',true);
 prior_reader text:=current_setting('app.payroll_tax_basis_reader',true);prior_import text:=current_setting('app.payroll_import_tax_basis_reader',true);
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.payroll_read_access_control c WHERE c.step=p_step) THEN RAISE EXCEPTION 'Unknown payroll read access step' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.tenant t WHERE t.id=p_tenant) THEN RAISE EXCEPTION 'Unknown tenant' USING ERRCODE='22023'; END IF;
 FOR u IN SELECT au.id,
   coalesce((SELECT string_agg(DISTINCT r.role::text,',') FROM public.role_assignment r WHERE r.app_user_id=au.id),'') AS roles,
   coalesce((SELECT json_agg(json_build_object('role',r.role,'companyId',r.company_id) ORDER BY r.role,r.company_id)::text FROM public.role_assignment r WHERE r.app_user_id=au.id),'[]') AS grants
  FROM public.app_user au WHERE au.tenant_id=p_tenant ORDER BY au.id LOOP
  users:=users+1;
  FOREACH reader IN ARRAY ARRAY['1',''] LOOP
   PERFORM set_config('app.tenant_id',p_tenant::text,true),set_config('app.user_id',u.id::text,true),set_config('app.roles',u.roles,true),
    set_config('app.grants',u.grants,true),set_config('app.agent_principal_id','',true),
    set_config('app.payroll_tax_basis_reader',reader,true),set_config('app.payroll_import_tax_basis_reader',reader,true);
   FOR f IN SELECT x.table_name,x.legacy_text,x.restated_text,x.inputs FROM public.payroll_read_access_fragment x WHERE x.step=p_step ORDER BY x.table_name,x.policy_name,x.ordinal LOOP
    inputs:=(SELECT string_agg(format('%I',c),',') FROM unnest(f.inputs) c);
    legacy_sql:=f.legacy_text;
    restated_sql:=replace(f.restated_text,'app.payroll_read_access_on(','app.payroll_read_access_forced(');
    BEGIN
     EXECUTE format('SELECT count(*) FILTER (WHERE (%1$s) IS DISTINCT FROM (%2$s)),count(*) FROM (SELECT DISTINCT %3$s FROM public.%4$I WHERE tenant_id=$1) %4$I',
      legacy_sql,restated_sql,inputs,f.table_name) INTO n,m USING p_tenant;
     values_differ:=values_differ+n;evaluations:=evaluations+m;
    EXCEPTION WHEN OTHERS THEN
     -- At least one side raised: compare each side's outcome on its own.
     legacy_state:=NULL;restated_state:=NULL;
     BEGIN
      EXECUTE format('SELECT count(*) FILTER (WHERE %1$s) FROM (SELECT DISTINCT %2$s FROM public.%3$I WHERE tenant_id=$1) %3$I',legacy_sql,inputs,f.table_name) USING p_tenant;
     EXCEPTION WHEN OTHERS THEN legacy_state:=SQLSTATE;
     END;
     BEGIN
      EXECUTE format('SELECT count(*) FILTER (WHERE %1$s) FROM (SELECT DISTINCT %2$s FROM public.%3$I WHERE tenant_id=$1) %3$I',restated_sql,inputs,f.table_name) USING p_tenant;
     EXCEPTION WHEN OTHERS THEN restated_state:=SQLSTATE;
     END;
     IF legacy_state IS DISTINCT FROM restated_state THEN raises_differ:=raises_differ+1; END IF;
    END;
   END LOOP;
  END LOOP;
 END LOOP;
 PERFORM set_config('app.tenant_id',coalesce(prior_tenant,''),true),set_config('app.user_id',coalesce(prior_user,''),true),set_config('app.roles',coalesce(prior_roles,''),true),
  set_config('app.grants',coalesce(prior_grants,''),true),set_config('app.agent_principal_id',coalesce(prior_agent,''),true),
  set_config('app.payroll_tax_basis_reader',coalesce(prior_reader,''),true),set_config('app.payroll_import_tax_basis_reader',coalesce(prior_import,''),true);
 INSERT INTO public.payroll_read_access_tenant AS t(tenant_id,step,trusted,last_compared_at,last_users,last_difference_count)
  VALUES(p_tenant,p_step,values_differ+raises_differ=0,now(),users,values_differ+raises_differ)
  ON CONFLICT(tenant_id,step) DO UPDATE SET trusted=t.trusted AND excluded.trusted,last_compared_at=excluded.last_compared_at,
   last_users=excluded.last_users,last_difference_count=excluded.last_difference_count;
 RAISE LOG 'payroll_read_access compare step=% users=% evaluations=% values_differ=% raises_differ=%',p_step,users,evaluations,values_differ,raises_differ;
 RETURN jsonb_build_object('step',p_step,'users',users,'evaluations',evaluations,'valuesDiffer',values_differ,'raisesDiffer',raises_differ,
  'trusted',(SELECT t.trusted FROM public.payroll_read_access_tenant t WHERE t.tenant_id=p_tenant AND t.step=p_step));
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_read_access_compare(text,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Operator only (7210 decision 2): after the cause of a difference is fixed, compare again and trust the tenant's step
-- only when that comparison is clean.
CREATE FUNCTION app.payroll_read_access_retrust(p_step text,p_tenant uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r jsonb;
BEGIN
 r:=app.payroll_read_access_compare(p_step,p_tenant);
 IF (r->>'valuesDiffer')::bigint=0 AND (r->>'raisesDiffer')::bigint=0 THEN
  UPDATE public.payroll_read_access_tenant t SET trusted=true WHERE t.tenant_id=p_tenant AND t.step=p_step;
  r:=r||jsonb_build_object('trusted',true);
 END IF;
 RETURN r;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_read_access_retrust(text,uuid) FROM PUBLIC,ai_hr_app;

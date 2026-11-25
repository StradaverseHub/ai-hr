-- ADR 0181 payroll read addendum, step P2 (section 9 step 4, as revised by section 11): payroll administration asked
-- once per statement instead of once per row, on the three policies that ask it. The owner confirmed on 25 November
-- 2026 that the payslip admin arm stays on the employment's current company (decision 4), so every answer below is the
-- current rule, evaluated in a different place. Installed inert on the 7460 switch: no policy changes here.
--
--   payroll_batch_rls                 app.can_admin_payroll_for(company_id)            per batch
--   payslip_rls (admin arm)           app.can_admin_payroll_employment(employment_id)  per payslip: a definer reading
--                                     the employment's company, then app.can_admin_payroll_for on it
--   payslip_original_employer_read    app.payroll_tax_basis_original_employer_read(batch_id)  per payslip: a definer
--                                     reading the batch's company, principal_snapshot_current and the tax-basis view
--                                     permission on it
--
-- Each restated piece passes a map built once per statement (an InitPlan) to a plain PL/pgSQL arm:
--   * app.payroll_admin_company_set(): {company id: can_admin_payroll_for(company)} for the tenant's companies, or
--     {"none": true} when the session holds no hr_admin, super_admin or payroll_partner grant (then
--     can_admin_payroll_for is false for every company, whatever it is).
--   * app.payroll_admin_employment_set(): {employment id: can_admin_payroll_employment(employment)} for the tenant's
--     employments, read without row security exactly as the legacy definer reads them, or {"none": true} as above.
--     An employment outside the tenant is absent and false, which is what the legacy definer returns for it.
--   * app.payroll_original_employer_set(): {batch id: payroll_tax_basis_original_employer_read(batch)} for the tenant's
--     batches, the permission asked once per company, or {"none": true} when principal_snapshot_current() is false or
--     the session holds no payroll administration grant (payroll_tax_basis_permission requires both).
-- An arm answers from the map; a key the map does not hold (a company outside the tenant, for instance) calls the
-- legacy function, as does a statement where the step does not serve the tenant (the map is then NULL). STABLE
-- functions are fixed within a statement, so asking them once per company, employment or batch instead of per row
-- changes no answer.
--
-- Planner view (the 7280 lesson, and the 7240/7245 regression): the payslip arms are plain PL/pgSQL functions with
-- the cost (100), volatility and parallel safety of the definers they stand for, so the payslip estimates do not move.
-- can_admin_payroll_for is an inlinable SQL function, so the legacy batch piece is planned as an EXISTS sub-plan
-- (selectivity 0.5); the restated batch piece wraps its arm in CASE, which is estimated the same way.
DO $payroll_read_p2_predecessor$
DECLARE r record;p pg_catalog.pg_proc%ROWTYPE;
BEGIN
 IF to_regclass('public.payroll_read_access_control') IS NULL THEN
  RAISE EXCEPTION 'The 7460 payroll read switch is missing' USING ERRCODE='55000';
 END IF;
 FOR r IN SELECT * FROM (VALUES
  ('app.can_admin_payroll_employment(uuid)','490f40691fc126a8763085c9e331d60f',true,'plpgsql'),
  ('app.can_admin_payroll_for(uuid)','fc01a7300d64de6a324c63d973b98fd5',false,'sql'),
  ('app.payroll_tax_basis_original_employer_read(uuid)','3d04a05a8a19cead4acb27915e969e0b',true,'sql')) v(fn,body,definer,lang) LOOP
  SELECT * INTO p FROM pg_catalog.pg_proc WHERE oid=to_regprocedure(r.fn);
  IF NOT FOUND OR md5(p.prosrc) IS DISTINCT FROM r.body OR p.prosecdef IS DISTINCT FROM r.definer OR p.provolatile<>'s' OR p.proretset
   OR p.prorettype IS DISTINCT FROM ('boolean'::regtype)::oid OR p.procost<>100 OR p.proparallel<>'u'
   OR p.prolang IS DISTINCT FROM (SELECT l.oid FROM pg_catalog.pg_language l WHERE l.lanname=r.lang) THEN
   RAISE EXCEPTION 'Unexpected % predecessor; review before restating it',r.fn USING ERRCODE='55000';
  END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.payroll_read_access_control WHERE step='p2_admin_companies')
  OR EXISTS(SELECT 1 FROM public.payroll_read_access_fragment WHERE (table_name,policy_name) IN (('payroll_batch','payroll_batch_rls'),('payslip','payslip_rls'),('payslip','payslip_original_employer_read'))) THEN
  RAISE EXCEPTION 'Payroll read step P2 already exists' USING ERRCODE='55000';
 END IF;
END;
$payroll_read_p2_predecessor$;
--> statement-breakpoint
CREATE FUNCTION app.payroll_admin_claimed() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app.current_grants() g WHERE g.role IN ('hr_admin','super_admin','payroll_partner'));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_admin_claimed() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.payroll_admin_company_set() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT app.payroll_admin_claimed() THEN RETURN '{"none":true}'::jsonb; END IF;
 RETURN coalesce((SELECT jsonb_object_agg(c.id::text,app.can_admin_payroll_for(c.id)) FROM public.company c WHERE c.tenant_id=app.current_tenant_id()),'{}'::jsonb);
END;
$$;
--> statement-breakpoint
-- The legacy definer (5129) reads the employment by id within the tenant, as its owner; so does this.
CREATE FUNCTION app.payroll_admin_employment_set() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE companies jsonb;
BEGIN
 IF NOT app.payroll_admin_claimed() THEN RETURN '{"none":true}'::jsonb; END IF;
 companies:=app.payroll_admin_company_set();
 RETURN coalesce((SELECT jsonb_object_agg(e.id::text,coalesce((companies->>e.company_id::text)::boolean,app.can_admin_payroll_for(e.company_id)))
  FROM public.employment e WHERE e.tenant_id=app.current_tenant_id()),'{}'::jsonb);
END;
$$;
--> statement-breakpoint
-- The legacy function (6661, row_security on since 7040) reads the batch within the tenant and asks the principal and
-- the tax-basis view permission on its company; this asks them once.
CREATE FUNCTION app.payroll_original_employer_set() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app SET row_security=on AS $$
BEGIN
 IF NOT app.payroll_admin_claimed() OR NOT coalesce(app.principal_snapshot_current(),false) THEN RETURN '{"none":true}'::jsonb; END IF;
 RETURN coalesce((SELECT jsonb_object_agg(b.id::text,coalesce(k.allowed,false))
  FROM public.payroll_batch b
  JOIN (SELECT x.company_id,app.payroll_tax_basis_permission(x.company_id,'payroll.tax-basis.view') AS allowed
        FROM (SELECT DISTINCT b2.company_id FROM public.payroll_batch b2 WHERE b2.tenant_id=app.current_tenant_id()) x) k ON k.company_id IS NOT DISTINCT FROM b.company_id
  WHERE b.tenant_id=app.current_tenant_id()),'{}'::jsonb);
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_admin_company_set(),app.payroll_admin_employment_set(),app.payroll_original_employer_set() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION app.payroll_admin_company_arm(p_company uuid,p_set jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE COST 100 AS $$
DECLARE v text;
BEGIN
 IF p_set IS NOT NULL THEN
  IF p_set ? 'none' THEN RETURN false; END IF;
  v:=p_set->>p_company::text;
  IF v IS NOT NULL THEN RETURN v::boolean; END IF;
 END IF;
 RETURN app.can_admin_payroll_for(p_company);
END;
$$;
--> statement-breakpoint
CREATE FUNCTION app.payroll_admin_employment_arm(p_employment uuid,p_set jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE COST 100 AS $$
BEGIN
 IF p_set IS NULL THEN RETURN app.can_admin_payroll_employment(p_employment); END IF;
 IF p_set ? 'none' OR p_employment IS NULL THEN RETURN false; END IF;
 RETURN coalesce((p_set->>p_employment::text)::boolean,false);
END;
$$;
--> statement-breakpoint
CREATE FUNCTION app.payroll_original_employer_arm(p_batch uuid,p_set jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE COST 100 AS $$
BEGIN
 IF p_set IS NULL THEN RETURN app.payroll_tax_basis_original_employer_read(p_batch); END IF;
 IF p_set ? 'none' OR p_batch IS NULL THEN RETURN false; END IF;
 RETURN coalesce((p_set->>p_batch::text)::boolean,false);
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_admin_company_arm(uuid,jsonb),app.payroll_admin_employment_arm(uuid,jsonb),app.payroll_original_employer_arm(uuid,jsonb) FROM PUBLIC;
--> statement-breakpoint
INSERT INTO public.payroll_read_access_control(step,mode) VALUES('p2_admin_companies','legacy');
--> statement-breakpoint
INSERT INTO public.payroll_read_access_fragment(table_name,policy_name,ordinal,step,legacy_text,restated_text,inputs) VALUES
 ('payroll_batch','payroll_batch_rls',1,NULL,$q$(tenant_id = app.current_tenant_id()) AND ($q$,NULL,NULL),
 ('payroll_batch','payroll_batch_rls',2,'p2_admin_companies',
  $q$app.can_admin_payroll_for(company_id)$q$,
  $q$CASE WHEN app.payroll_admin_company_arm(company_id, (SELECT CASE WHEN app.payroll_read_access_on('p2_admin_companies') THEN app.payroll_admin_company_set() END)) THEN true ELSE false END$q$,
  ARRAY['company_id']),
 ('payroll_batch','payroll_batch_rls',3,NULL,$q$ OR (EXISTS ( SELECT 1 FROM payslip ps WHERE ((ps.batch_id = payroll_batch.id) AND (ps.employment_id = ANY (( SELECT app.visible_employment_ids() AS visible_employment_ids)::uuid[]))))))$q$,NULL,NULL),
 ('payslip','payslip_rls',1,NULL,$q$(tenant_id = app.current_tenant_id()) AND ($q$,NULL,NULL),
 ('payslip','payslip_rls',2,'p2_admin_companies',
  $q$app.can_admin_payroll_employment(employment_id)$q$,
  $q$app.payroll_admin_employment_arm(employment_id, (SELECT CASE WHEN app.payroll_read_access_on('p2_admin_companies') THEN app.payroll_admin_employment_set() END))$q$,
  ARRAY['employment_id']),
 ('payslip','payslip_rls',3,NULL,$q$ OR (EXISTS ( SELECT 1 FROM employment e WHERE ((e.id = payslip.employment_id) AND app.is_self_person(e.person_id)))))$q$,NULL,NULL),
 ('payslip','payslip_original_employer_read',1,NULL,$q$(tenant_id = app.current_tenant_id()) AND $q$,NULL,NULL),
 ('payslip','payslip_original_employer_read',2,'p2_admin_companies',
  $q$app.payroll_tax_basis_original_employer_read(batch_id)$q$,
  $q$app.payroll_original_employer_arm(batch_id, (SELECT CASE WHEN app.payroll_read_access_on('p2_admin_companies') THEN app.payroll_original_employer_set() END))$q$,
  ARRAY['batch_id']);
--> statement-breakpoint
-- The three policies must be installed exactly as their pieces say (all 'legacy').
DO $payroll_read_p2_policies$
DECLARE p record;
BEGIN
 FOR p IN SELECT DISTINCT f.table_name,f.policy_name FROM public.payroll_read_access_fragment f WHERE f.step='p2_admin_companies' ORDER BY 1,2 LOOP
  IF NOT app.payroll_read_access_installed_as(p.table_name,p.policy_name,app.payroll_read_access_policy_text(p.table_name,p.policy_name,NULL)) THEN
   RAISE EXCEPTION 'Policy %.% differs from the reviewed predecessor',p.table_name,p.policy_name USING ERRCODE='55000';
  END IF;
 END LOOP;
END;
$payroll_read_p2_policies$;
--> statement-breakpoint
-- The readers are evaluated by row security under whichever role a policy applies to. payslip_original_employer_read
-- is TO ai_hr_app; payroll_batch_rls and payslip_rls are TO PUBLIC, so (as 7240 derived it) every role holding a
-- privilege on payroll_batch or payslip needs them, and the table owner where row security is forced. A role granted
-- these tables later needs this grant too; without it a switched policy fails closed (permission denied), never open.
DO $payroll_read_p2_grants$
DECLARE r record;
BEGIN
 FOR r IN
  SELECT DISTINCT g.grantee FROM (
   SELECT a.grantee FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
    WHERE c.oid IN ('public.payroll_batch'::regclass,'public.payslip'::regclass) AND (a.grantee<>c.relowner OR c.relforcerowsecurity)
   UNION ALL
   SELECT a.grantee FROM pg_catalog.pg_attribute att JOIN pg_catalog.pg_class c ON c.oid=att.attrelid CROSS JOIN LATERAL pg_catalog.aclexplode(att.attacl) a
    WHERE c.oid IN ('public.payroll_batch'::regclass,'public.payslip'::regclass) AND att.attacl IS NOT NULL AND (a.grantee<>c.relowner OR c.relforcerowsecurity)
   UNION ALL
   SELECT (SELECT oid FROM pg_catalog.pg_roles WHERE rolname='ai_hr_app')
  ) g WHERE g.grantee<>0 AND g.grantee IS NOT NULL
 LOOP
  EXECUTE format('GRANT EXECUTE ON FUNCTION app.payroll_read_access_on(text),app.payroll_admin_company_set(),app.payroll_admin_employment_set(),app.payroll_original_employer_set(),app.payroll_admin_company_arm(uuid,jsonb),app.payroll_admin_employment_arm(uuid,jsonb),app.payroll_original_employer_arm(uuid,jsonb) TO %I',
   pg_catalog.pg_get_userbyid(r.grantee));
 END LOOP;
END;
$payroll_read_p2_grants$;

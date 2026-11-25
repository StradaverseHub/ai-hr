-- ADR 0181 payroll read addendum, step P3 (section 9 step 5, as revised by section 11): the payslip_rls own-payslip arm
-- asked once per statement instead of once per row. Installed inert on the 7460 switch: no policy changes here.
--
-- The legacy arm is EXISTS(SELECT 1 FROM employment e WHERE e.id = payslip.employment_id AND
-- app.is_self_person(e.person_id)), evaluated per payslip as the caller, so employment's own policies apply to the
-- employment it probes. app.is_self_person(p) (0029, a SQL definer with SET, so a call per probe) is: an app_user of the
-- session's tenant with id = the session's user has person_id = p.
--   * app.payroll_self_person_ids(): those person ids, read as app.is_self_person reads them (a definer); at most one.
--   * app.payroll_self_person_arm(person, ids): person = ANY(ids); when the step does not serve the tenant (ids NULL)
--     it calls app.is_self_person(person) itself.
-- The restated piece keeps the legacy EXISTS over employment word for word and replaces only the is_self_person call
-- inside it by the arm with the ids read once per statement. The first build replaced the whole EXISTS by a plain
-- arm; at 70 companies / 1,000 employments the planner then judged the payslip filter cheap and scanned every payslip
-- first instead of reaching the reader's own payslips through person and employment (a partner's History read went
-- from 0.11 s to 2.5 s, CI run 45610901713). Keeping the sub-plan keeps its cost and selectivity, so the plan stays.
-- The arm has is_self_person's cost (100), volatility and parallel safety.
--
-- The every-user comparison (7460) evaluates both pieces as the owner, without employment's row security, so it
-- compares the self predicate itself; the database tests compare the full answers as the application role.
DO $payroll_read_p3_predecessor$
DECLARE p pg_catalog.pg_proc%ROWTYPE;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.payroll_read_access_control WHERE step='p2_admin_companies') THEN
  RAISE EXCEPTION 'The 7470 payroll read step P2 is missing' USING ERRCODE='55000';
 END IF;
 SELECT * INTO p FROM pg_catalog.pg_proc WHERE oid=to_regprocedure('app.is_self_person(uuid)');
 IF NOT FOUND OR md5(p.prosrc) IS DISTINCT FROM '3ede48808cf91f9a23f58dc504068fe9' OR p.prosecdef IS DISTINCT FROM true OR p.provolatile<>'s' THEN
  RAISE EXCEPTION 'Unexpected is_self_person predecessor; review before restating it' USING ERRCODE='55000';
 END IF;
 IF EXISTS(SELECT 1 FROM public.payroll_read_access_control WHERE step='p3_own_payslips')
  OR (SELECT string_agg(ordinal||':'||coalesce(step,'-')||':'||legacy_text,'|' ORDER BY ordinal) FROM public.payroll_read_access_fragment WHERE table_name='payslip' AND policy_name='payslip_rls')
   IS DISTINCT FROM '1:-:(tenant_id = app.current_tenant_id()) AND (|2:p2_admin_companies:app.can_admin_payroll_employment(employment_id)|3:-: OR (EXISTS ( SELECT 1 FROM employment e WHERE ((e.id = payslip.employment_id) AND app.is_self_person(e.person_id)))))' THEN
  RAISE EXCEPTION 'payslip_rls pieces differ from those 7470 recorded' USING ERRCODE='55000';
 END IF;
END;
$payroll_read_p3_predecessor$;
--> statement-breakpoint
CREATE FUNCTION app.payroll_self_person_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(array_agg(u.person_id) FILTER (WHERE u.person_id IS NOT NULL),'{}'::uuid[]) FROM public.app_user u
 WHERE u.id = app.current_user_id() AND u.tenant_id = app.current_tenant_id();
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_self_person_ids() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION app.payroll_self_person_arm(p_person uuid,p_ids uuid[]) RETURNS boolean
LANGUAGE plpgsql STABLE COST 100 AS $$
BEGIN
 IF p_ids IS NULL THEN RETURN app.is_self_person(p_person); END IF;
 RETURN coalesce(p_person = ANY(p_ids),false);
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_self_person_arm(uuid,uuid[]) FROM PUBLIC;
--> statement-breakpoint
INSERT INTO public.payroll_read_access_control(step,mode) VALUES('p3_own_payslips','legacy');
--> statement-breakpoint
-- Split 7470's constant third piece into the own-payslip arm and its surrounding text; the joined text is unchanged.
DELETE FROM public.payroll_read_access_fragment WHERE table_name='payslip' AND policy_name='payslip_rls' AND ordinal=3;
--> statement-breakpoint
INSERT INTO public.payroll_read_access_fragment(table_name,policy_name,ordinal,step,legacy_text,restated_text,inputs) VALUES
 ('payslip','payslip_rls',3,NULL,$q$ OR $q$,NULL,NULL),
 ('payslip','payslip_rls',4,'p3_own_payslips',
  $q$(EXISTS ( SELECT 1 FROM employment e WHERE ((e.id = payslip.employment_id) AND app.is_self_person(e.person_id))))$q$,
  $q$(EXISTS ( SELECT 1 FROM employment e WHERE ((e.id = payslip.employment_id) AND app.payroll_self_person_arm(e.person_id, (SELECT CASE WHEN app.payroll_read_access_on('p3_own_payslips') THEN app.payroll_self_person_ids() END)))))$q$,
  ARRAY['employment_id']),
 ('payslip','payslip_rls',5,NULL,$q$)$q$,NULL,NULL);
--> statement-breakpoint
DO $payroll_read_p3_policy$
BEGIN
 IF NOT app.payroll_read_access_installed_as('payslip','payslip_rls',app.payroll_read_access_policy_text('payslip','payslip_rls',NULL)) THEN
  RAISE EXCEPTION 'payslip_rls differs from its recorded pieces' USING ERRCODE='55000';
 END IF;
END;
$payroll_read_p3_policy$;
--> statement-breakpoint
-- payslip_rls is TO PUBLIC: every role holding a privilege on payslip evaluates it (the 7470 derivation).
DO $payroll_read_p3_grants$
DECLARE r record;
BEGIN
 FOR r IN
  SELECT DISTINCT g.grantee FROM (
   SELECT a.grantee FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
    WHERE c.oid='public.payslip'::regclass AND (a.grantee<>c.relowner OR c.relforcerowsecurity)
   UNION ALL
   SELECT a.grantee FROM pg_catalog.pg_attribute att JOIN pg_catalog.pg_class c ON c.oid=att.attrelid CROSS JOIN LATERAL pg_catalog.aclexplode(att.attacl) a
    WHERE c.oid='public.payslip'::regclass AND att.attacl IS NOT NULL AND (a.grantee<>c.relowner OR c.relforcerowsecurity)
   UNION ALL
   SELECT (SELECT oid FROM pg_catalog.pg_roles WHERE rolname='ai_hr_app')
  ) g WHERE g.grantee<>0 AND g.grantee IS NOT NULL
 LOOP
  EXECUTE format('GRANT EXECUTE ON FUNCTION app.payroll_read_access_on(text),app.payroll_self_person_ids(),app.payroll_self_person_arm(uuid,uuid[]) TO %I',
   pg_catalog.pg_get_userbyid(r.grantee));
 END LOOP;
END;
$payroll_read_p3_grants$;

-- Plan reuse for the 7240 readers (ADR 0181 employment visibility), 25 November 2026.
-- 7240 defined six read-path functions as LANGUAGE sql SECURITY DEFINER with SET search_path. PostgreSQL cannot inline
-- such a function, and plans its body again on every call: the recursive relationship walk, the person reader and the two
-- company readers were re-planned for every statement that reads employment or person (release 6's gate:
-- test/transaction-view-history-scale-db.test.ts History rows 23 s -> 169 s). 2105 made app.visible_employment_ids
-- PL/pgSQL for exactly this reason: a PL/pgSQL statement without parameters is planned once per connection and reused.
-- Each function below keeps its signature, result type, owner, volatility, SECURITY DEFINER, search_path and EXECUTE
-- grants (CREATE OR REPLACE keeps them); its query is the 7240 query character for character, returned by PL/pgSQL.
-- Each predecessor is guarded by the exact 7240 body.
--> statement-breakpoint
DO $guard$
BEGIN
 IF md5((SELECT p.prosrc FROM pg_proc p WHERE p.oid='app.access_visible_employment_unusable()'::regprocedure))<>'ae08b0ed3774905b68b5284a03af89b6'
  OR (SELECT p.prolang FROM pg_proc p WHERE p.oid='app.access_visible_employment_unusable()'::regprocedure)<>(SELECT l.oid FROM pg_language l WHERE l.lanname='sql') THEN
  RAISE EXCEPTION 'Unexpected access_visible_employment_unusable predecessor' USING ERRCODE='55000';
 END IF;
END;
$guard$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.access_visible_employment_unusable() RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 RETURN (
SELECT CASE WHEN app.current_user_id() IS NULL THEN 'no_user'
  WHEN current_date<>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date THEN 'clock'
  WHEN s.tenant_id IS NULL THEN 'no_state'
  WHEN NOT s.trusted THEN 'untrusted'
  WHEN s.stale THEN 'stale'
  WHEN s.computed_for IS NULL OR s.computed_for>current_date OR (s.valid_until IS NOT NULL AND current_date>=s.valid_until) THEN 'outside_window'
  WHEN c.tenant_id IS NULL OR c.computed_for IS NULL OR c.computed_for>current_date OR (c.valid_until IS NOT NULL AND current_date>=c.valid_until) THEN 'company_window'
 END
 FROM (SELECT 1) one
 LEFT JOIN public.access_employment_state s ON s.tenant_id=app.current_tenant_id()
 LEFT JOIN public.access_company_state c ON c.tenant_id=app.current_tenant_id()
 );
END;
$$;
--> statement-breakpoint
DO $guard$
BEGIN
 IF md5((SELECT p.prosrc FROM pg_proc p WHERE p.oid='app.access_visible_employment_legacy()'::regprocedure))<>'edfc03ae71101425a1b0169ded1fdc51'
  OR (SELECT p.prolang FROM pg_proc p WHERE p.oid='app.access_visible_employment_legacy()'::regprocedure)<>(SELECT l.oid FROM pg_language l WHERE l.lanname='sql') THEN
  RAISE EXCEPTION 'Unexpected access_visible_employment_legacy predecessor' USING ERRCODE='55000';
 END IF;
END;
$guard$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.access_visible_employment_legacy() RETURNS uuid[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 RETURN (
WITH RECURSIVE
 me AS (
   SELECT e.id, e.company_id
   FROM employment e
   JOIN app_user u ON u.person_id = e.person_id
   WHERE u.id = app.current_user_id()
     AND e.tenant_id = app.current_tenant_id()
     AND e.terminated_on IS NULL
 ),
 down AS (
   SELECT m.company_id AS root_company, rl.subordinate_employment_id AS emp, 1 AS depth
   FROM me m
   JOIN reporting_line rl ON rl.manager_employment_id = m.id
   JOIN employment sub ON sub.id = rl.subordinate_employment_id
   WHERE rl.line_type = 'administrative'
     AND rl.superseded_at IS NULL
     AND rl.valid_from <= current_date AND (rl.valid_to IS NULL OR rl.valid_to > current_date)
     AND sub.terminated_on IS NULL
     AND app.is_company_descendant(sub.company_id, m.company_id)
   UNION
   SELECT d.root_company, rl.subordinate_employment_id, d.depth + 1
   FROM down d
   JOIN reporting_line rl ON rl.manager_employment_id = d.emp
   JOIN employment mid ON mid.id = rl.manager_employment_id
   JOIN employment sub ON sub.id = rl.subordinate_employment_id
   WHERE rl.line_type = 'administrative'
     AND rl.superseded_at IS NULL
     AND rl.valid_from <= current_date AND (rl.valid_to IS NULL OR rl.valid_to > current_date)
     AND mid.terminated_on IS NULL
     AND sub.terminated_on IS NULL
     AND d.depth < 64
     AND app.is_company_descendant(sub.company_id, d.root_company)
 ),
 caller_dept AS (
   SELECT m.id AS caller, a.department_id AS dept, d.company_id AS company
   FROM me m
   JOIN assignment a ON a.employment_id = m.id
   JOIN department d ON d.id = a.department_id
   WHERE a.valid_to IS NULL AND a.superseded_at IS NULL
     AND a.department_id IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM reporting_line rl
       WHERE rl.manager_employment_id = m.id
         AND rl.line_type = 'administrative'
         AND rl.superseded_at IS NULL
         AND rl.valid_from <= current_date AND (rl.valid_to IS NULL OR rl.valid_to > current_date)
     )
 ),
 dept_down AS (
   SELECT cd.caller, cd.dept AS id, 0 AS depth
   FROM caller_dept cd
   UNION
   SELECT dd.caller, d.id, dd.depth + 1
   FROM dept_down dd
   JOIN department d ON d.parent_department_id = dd.id
   JOIN caller_dept cd ON cd.caller = dd.caller
   WHERE app.is_company_descendant(d.company_id, cd.company)
     AND dd.depth < 64
 ),
 hod AS (
   SELECT a.employment_id
   FROM assignment a
   WHERE a.valid_to IS NULL AND a.superseded_at IS NULL
     AND a.department_id IS NOT NULL
     AND a.department_id IN (SELECT dd.id FROM dept_down dd)
 ),
 visible AS (
   SELECT e.id
   FROM employment e
   JOIN app_user u ON u.person_id = e.person_id
   WHERE e.tenant_id = app.current_tenant_id()
     AND u.id = app.current_user_id()
   UNION
   SELECT d.emp FROM down d
   UNION
   SELECT h.employment_id FROM hod h
 )
 SELECT coalesce(array_agg(v.id ORDER BY v.id), '{}'::uuid[]) FROM visible v WHERE v.id IS NOT NULL
 );
END;
$$;
--> statement-breakpoint
DO $guard$
BEGIN
 IF md5((SELECT p.prosrc FROM pg_proc p WHERE p.oid='app.access_visible_employment_stored()'::regprocedure))<>'073aeb0c983056ea2d65ec49a33b68e7'
  OR (SELECT p.prolang FROM pg_proc p WHERE p.oid='app.access_visible_employment_stored()'::regprocedure)<>(SELECT l.oid FROM pg_language l WHERE l.lanname='sql') THEN
  RAISE EXCEPTION 'Unexpected access_visible_employment_stored predecessor' USING ERRCODE='55000';
 END IF;
END;
$guard$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.access_visible_employment_stored() RETURNS uuid[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 RETURN (
WITH me AS MATERIALIZED (
   SELECT e.id
   FROM public.employment e
   JOIN public.app_user u ON u.person_id = e.person_id
   WHERE u.id = app.current_user_id()
     AND e.tenant_id = app.current_tenant_id()
     AND e.terminated_on IS NULL
 ),
 caller_dept AS MATERIALIZED (
   SELECT a.department_id AS dept
   FROM me m
   JOIN public.assignment a ON a.employment_id = m.id
   JOIN public.department d ON d.id = a.department_id
   WHERE a.valid_to IS NULL AND a.superseded_at IS NULL
     AND a.department_id IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM public.reporting_line rl
       WHERE rl.manager_employment_id = m.id
         AND rl.line_type = 'administrative'
         AND rl.superseded_at IS NULL
         AND rl.valid_from <= current_date AND (rl.valid_to IS NULL OR rl.valid_to > current_date)
     )
 ),
 departments AS MATERIALIZED (
   SELECT cd.dept AS id FROM caller_dept cd
   UNION
   SELECT k.descendant_department_id FROM public.access_department_closure k JOIN caller_dept cd ON k.ancestor_department_id = cd.dept
 ),
 visible AS (
   SELECT e.id
   FROM public.employment e
   JOIN public.app_user u ON u.person_id = e.person_id
   WHERE e.tenant_id = app.current_tenant_id()
     AND u.id = app.current_user_id()
   UNION
   SELECT r.subject_employment_id FROM public.access_reporting_reach r JOIN me m ON r.root_employment_id = m.id
   UNION
   SELECT a.employment_id
   FROM public.assignment a JOIN departments x ON a.department_id = x.id
   WHERE a.valid_to IS NULL AND a.superseded_at IS NULL AND a.department_id IS NOT NULL
 )
 SELECT coalesce(array_agg(v.id ORDER BY v.id), '{}'::uuid[]) FROM visible v WHERE v.id IS NOT NULL
 );
END;
$$;
--> statement-breakpoint
DO $guard$
BEGIN
 IF md5((SELECT p.prosrc FROM pg_proc p WHERE p.oid='app.access_visible_person_ids()'::regprocedure))<>'2f2bcb585d98413cbe3e502c8bf89df9'
  OR (SELECT p.prolang FROM pg_proc p WHERE p.oid='app.access_visible_person_ids()'::regprocedure)<>(SELECT l.oid FROM pg_language l WHERE l.lanname='sql') THEN
  RAISE EXCEPTION 'Unexpected access_visible_person_ids predecessor' USING ERRCODE='55000';
 END IF;
END;
$guard$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.access_visible_person_ids() RETURNS uuid[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 RETURN (
WITH visible AS (
   SELECT u.person_id AS id FROM public.app_user u
   WHERE u.id = app.current_user_id() AND u.tenant_id = app.current_tenant_id()
   UNION
   SELECT e.person_id FROM public.employment e
   WHERE e.tenant_id = app.current_tenant_id() AND e.id IN (SELECT unnest(app.access_visible_employment_ids()))
 )
 SELECT coalesce(array_agg(v.id ORDER BY v.id), '{}'::uuid[]) FROM visible v WHERE v.id IS NOT NULL
 );
END;
$$;
--> statement-breakpoint
DO $guard$
BEGIN
 IF md5((SELECT p.prosrc FROM pg_proc p WHERE p.oid='app.employment_read_companies()'::regprocedure))<>'12931ad7588965d2c84d859288c09e36'
  OR (SELECT p.prolang FROM pg_proc p WHERE p.oid='app.employment_read_companies()'::regprocedure)<>(SELECT l.oid FROM pg_language l WHERE l.lanname='sql') THEN
  RAISE EXCEPTION 'Unexpected employment_read_companies predecessor' USING ERRCODE='55000';
 END IF;
END;
$guard$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.employment_read_companies() RETURNS uuid[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 RETURN (
SELECT coalesce(array_agg(c.id ORDER BY c.id),'{}'::uuid[]) FROM public.company c
 WHERE c.tenant_id=app.current_tenant_id()
  AND (app.is_admin_for(c.id) OR app.can_admin_payroll_for(c.id) OR app.can_admin_perfcomp_for(c.id))
 );
END;
$$;
--> statement-breakpoint
DO $guard$
BEGIN
 IF md5((SELECT p.prosrc FROM pg_proc p WHERE p.oid='app.employment_partner_companies()'::regprocedure))<>'ddd355a8d3ede78f1822dd92dbb7a035'
  OR (SELECT p.prolang FROM pg_proc p WHERE p.oid='app.employment_partner_companies()'::regprocedure)<>(SELECT l.oid FROM pg_language l WHERE l.lanname='sql') THEN
  RAISE EXCEPTION 'Unexpected employment_partner_companies predecessor' USING ERRCODE='55000';
 END IF;
END;
$guard$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.employment_partner_companies() RETURNS uuid[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 RETURN (
SELECT coalesce(array_agg(c.id ORDER BY c.id),'{}'::uuid[]) FROM public.company c
 WHERE c.tenant_id=app.current_tenant_id()
  AND (app.can_admin_payroll_for(c.id) OR app.can_admin_perfcomp_for(c.id))
 );
END;
$$;

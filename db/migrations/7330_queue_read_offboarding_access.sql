-- ADR 0181 live work queues addendum, step Q1 (owner approved 25 November 2026): the offboarding posting queue access
-- that the app frame asks on every page, once per statement instead of once per company and posting.
--
-- app.offboarding_posting_queue_access() (6302) is LANGUAGE sql SECURITY DEFINER with SET, so it is re-planned on every
-- call. It calls personnel_posting_visible per offboarding posting and offboarding_posting_ops / _group per company.
-- Each of those repeats principal_snapshot_current() and offboarding_posting_group_members(), which scans every active
-- user of the tenant with login_blocked per user only to test whether the caller is in one group. On staging (fictional
-- data) it costs about 0.1 s per page for every user even with no posting to review.
--
-- This installs, inert:
--   * public.queue_read_control: one mode per restated reader ('legacy', 'shadow', 'v2'), installation wide, no tenant
--     data, owner only. Every mode starts as 'legacy', so installing changes nothing but one indexed control read.
--   * app.offboarding_posting_queue_access_legacy(): the 6302 function, renamed, unchanged (guarded by its exact body).
--   * app.offboarding_posting_queue_access_v2(): the same answer evaluated once per statement (below).
--   * app.offboarding_posting_queue_access(): a PL/pgSQL dispatcher at the original name and grants. 'legacy' serves the
--     legacy body; 'v2' the new one; 'shadow' computes both, serves legacy and logs one line with no values:
--     queue_read shadow fn=offboarding_posting_queue_access reason=compared differs=<0|1>.
--   * app.queue_read_set_mode(fn, mode) and app.queue_read_compare(fn, tenant): operator only. The comparison evaluates
--     a reader's legacy and restated bodies for every user of the tenant under that user's own grants, counts only.
--
-- How v2 equals the legacy body, for the caller U of tenant T, with principal_snapshot_current() true (otherwise both
-- are false):
--   * member(g) = U = ANY(offboarding_posting_group_members(g)): U's own row of T, not archived, not login blocked, named
--     in group g of coalesce(lc_onboarding_config.groups, lc_v9_config.groups, []). Evaluated for U alone, the same JSON
--     test, once per distinct group, and only when U's row is usable (the legacy scan evaluates the JSON per usable user).
--   * ops(c) = lc_v9_off_access(c) AND member(peopleOpsGroup) = U not null AND NOT login_blocked(U) AND is_admin_for(c)
--     AND U in lc_onboarding_config.access.offboarding AND member(peopleOpsGroup). Only is_admin_for depends on c.
--   * group(c, g) = member(g) AND access_workforce_company(c, 'workforce.maintain'). The same per-company function as
--     before, called only when member(g) holds and stopping at the first company that answers.
--   * The posting arm: an offboarding posting of T whose employment row (by id, any state, as before) is not U's own
--     person, with ops(company) OR group(company, approver group), asked once per distinct (company, approver group).
--   * The company arm needs the tenant's lc_v9_config row (its primary key is the tenant), exactly as the legacy join.
-- STABLE functions are fixed within a statement, so evaluating them once instead of per row changes no answer.
-- PL/pgSQL keeps each inner statement's plan for the life of the connection (the 7245 lesson: never LANGUAGE sql
-- SECURITY DEFINER with SET on a hot reader).
DO $offboarding_queue_predecessor$
DECLARE p pg_catalog.pg_proc%ROWTYPE; app_role oid;
BEGIN
 SELECT oid INTO app_role FROM pg_catalog.pg_roles WHERE rolname='ai_hr_app';
 SELECT * INTO p FROM pg_catalog.pg_proc WHERE oid=to_regprocedure('app.offboarding_posting_queue_access()');
 IF NOT FOUND OR md5(p.prosrc) IS DISTINCT FROM '0b244f4aa1621807d85b8bc27d5dc41e'
  OR app_role IS NULL OR p.prosecdef IS DISTINCT FROM true OR p.provolatile<>'s' OR p.prokind<>'f' OR p.proretset
  OR p.prorettype IS DISTINCT FROM ('boolean'::regtype)::oid OR p.pronargs<>0
  OR p.prolang IS DISTINCT FROM (SELECT oid FROM pg_catalog.pg_language WHERE lanname='sql')
  OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']::text[] THEN
  RAISE EXCEPTION 'Unexpected offboarding posting queue access predecessor; review before restating it' USING ERRCODE='55000';
 END IF;
 IF to_regprocedure('app.offboarding_posting_queue_access_legacy()') IS NOT NULL OR to_regclass('public.queue_read_control') IS NOT NULL THEN
  RAISE EXCEPTION 'Queue read restatement objects already exist' USING ERRCODE='55000';
 END IF;
END;
$offboarding_queue_predecessor$;
--> statement-breakpoint
CREATE TABLE public.queue_read_control(
 -- Each restated reader's migration adds its row; the dispatcher of a reader without a row serves its legacy body.
 function_name text PRIMARY KEY CHECK(function_name ~ '^[a-z][a-z0-9_]{0,62}$'),
 mode text NOT NULL DEFAULT 'legacy' CHECK(mode IN ('legacy','shadow','v2')),
 -- Set only when an operator changes the mode, so the migration's own rows hold no wall-clock value.
 updated_at timestamptz
);
--> statement-breakpoint
INSERT INTO public.queue_read_control(function_name,mode) VALUES('offboarding_posting_queue_access','legacy');
--> statement-breakpoint
ALTER TABLE public.queue_read_control ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.queue_read_control FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY queue_read_control_owner ON public.queue_read_control FOR ALL USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
--> statement-breakpoint
REVOKE ALL ON public.queue_read_control FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
ALTER FUNCTION app.offboarding_posting_queue_access() RENAME TO offboarding_posting_queue_access_legacy;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.offboarding_posting_queue_access_legacy() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.offboarding_posting_queue_access_v2() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
 t uuid:=app.current_tenant_id();me uuid:=app.current_user_id();
 my_person uuid;usable boolean;groups jsonb;off_access boolean;ops_ok boolean;cfg jsonb;approver text;
BEGIN
 IF app.principal_snapshot_current() IS NOT TRUE THEN RETURN false; END IF;
 SELECT u.person_id,(u.archived_at IS NULL AND NOT app.login_blocked(u.id)) INTO my_person,usable FROM public.app_user u WHERE u.id=me AND u.tenant_id=t;
 usable:=coalesce(usable,false);
 groups:=CASE WHEN usable THEN coalesce((SELECT c.data->'groups' FROM public.lc_onboarding_config c WHERE c.tenant_id=t),(SELECT c.data->'groups' FROM public.lc_v9_config c WHERE c.tenant_id=t),'[]'::jsonb) END;
 off_access:=me IS NOT NULL AND NOT app.login_blocked(me) AND EXISTS(SELECT 1 FROM public.lc_onboarding_config c WHERE c.tenant_id=t AND c.data->'access'->'offboarding' ? me::text);
 ops_ok:=coalesce(off_access AND usable AND EXISTS(SELECT 1 FROM jsonb_array_elements(groups) g WHERE g->>'id'=(SELECT v.data->>'peopleOpsGroup' FROM public.lc_v9_config v WHERE v.tenant_id=t) AND g->'members' ? me::text),false);
 -- The posting arm, once per distinct (company, approver group) of the tenant's offboarding postings.
 IF EXISTS(SELECT 1 FROM (SELECT DISTINCT e.company_id,p.approver_group_id FROM public.personnel_posting p
     JOIN public.employment e ON e.tenant_id=t AND e.id=p.employment_id
     WHERE p.tenant_id=t AND p.source='offboarding' AND (my_person IS NULL OR e.person_id IS DISTINCT FROM my_person)) x
    WHERE (ops_ok AND app.is_admin_for(x.company_id))
     OR (usable AND EXISTS(SELECT 1 FROM jsonb_array_elements(groups) g WHERE g->>'id'=x.approver_group_id AND g->'members' ? me::text)
         AND app.access_workforce_company(x.company_id,'workforce.maintain'))) THEN
  RETURN true;
 END IF;
 -- The company arm: the tenant's configured posting approver group (or People Ops), on any company of the tenant.
 SELECT v.data INTO cfg FROM public.lc_v9_config v WHERE v.tenant_id=t;
 IF NOT FOUND THEN RETURN false; END IF;
 approver:=CASE WHEN cfg->'offboarding' ? 'postingApproverGroupId' THEN cfg->'offboarding'->>'postingApproverGroupId' ELSE cfg->>'peopleOpsGroup' END;
 RETURN EXISTS(SELECT 1 FROM public.company c WHERE c.tenant_id=t AND (
   (ops_ok AND app.is_admin_for(c.id))
   OR (usable AND EXISTS(SELECT 1 FROM jsonb_array_elements(groups) g WHERE g->>'id'=approver AND g->'members' ? me::text)
       AND app.access_workforce_company(c.id,'workforce.maintain'))));
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.offboarding_posting_queue_access_v2() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.offboarding_posting_queue_access() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_mode text;legacy boolean;restated boolean;
BEGIN
 SELECT c.mode INTO v_mode FROM public.queue_read_control c WHERE c.function_name='offboarding_posting_queue_access';
 IF v_mode='v2' THEN RETURN app.offboarding_posting_queue_access_v2(); END IF;
 legacy:=app.offboarding_posting_queue_access_legacy();
 IF v_mode='shadow' THEN
  restated:=app.offboarding_posting_queue_access_v2();
  RAISE LOG 'queue_read shadow fn=offboarding_posting_queue_access reason=compared differs=%',CASE WHEN legacy IS DISTINCT FROM restated THEN 1 ELSE 0 END;
 END IF;
 RETURN legacy;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.offboarding_posting_queue_access() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.offboarding_posting_queue_access() TO ai_hr_app;
--> statement-breakpoint
-- Operator only, installation wide.
CREATE FUNCTION app.queue_read_set_mode(p_function text,p_mode text) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v text;
BEGIN
 UPDATE public.queue_read_control SET mode=p_mode,updated_at=now() WHERE function_name=p_function RETURNING mode INTO v;
 IF v IS NULL THEN RAISE EXCEPTION 'Unknown queue reader' USING ERRCODE='22023'; END IF;
 RETURN v;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.queue_read_set_mode(text,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Operator only: a registered reader's legacy and restated bodies (app.<fn>_legacy() and app.<fn>_v2(), both without
-- arguments) for every user of the tenant, each under that user's own role assignments (the claims a sign-in would
-- carry), counts only. The caller's settings are restored before it returns.
CREATE FUNCTION app.queue_read_compare(p_function text,p_tenant uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
 u record;users integer:=0;differs integer:=0;differ boolean;probe text;
 prior_tenant text:=current_setting('app.tenant_id',true);prior_user text:=current_setting('app.user_id',true);
 prior_roles text:=current_setting('app.roles',true);prior_grants text:=current_setting('app.grants',true);
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.queue_read_control c WHERE c.function_name=p_function)
  OR to_regprocedure(format('app.%I()',p_function||'_legacy')) IS NULL OR to_regprocedure(format('app.%I()',p_function||'_v2')) IS NULL THEN
  RAISE EXCEPTION 'Unknown queue reader' USING ERRCODE='22023';
 END IF;
 probe:=format('SELECT app.%I() IS DISTINCT FROM app.%I()',p_function||'_legacy',p_function||'_v2');
 FOR u IN SELECT au.id,
   coalesce((SELECT string_agg(DISTINCT r.role::text,',') FROM public.role_assignment r WHERE r.app_user_id=au.id),'') AS roles,
   coalesce((SELECT json_agg(json_build_object('role',r.role,'companyId',r.company_id) ORDER BY r.role,r.company_id)::text FROM public.role_assignment r WHERE r.app_user_id=au.id),'[]') AS grants
  FROM public.app_user au WHERE au.tenant_id=p_tenant ORDER BY au.id LOOP
  PERFORM set_config('app.tenant_id',p_tenant::text,true),set_config('app.user_id',u.id::text,true),set_config('app.roles',u.roles,true),set_config('app.grants',u.grants,true);
  EXECUTE probe INTO differ;
  users:=users+1;IF differ THEN differs:=differs+1; END IF;
 END LOOP;
 PERFORM set_config('app.tenant_id',coalesce(prior_tenant,''),true),set_config('app.user_id',coalesce(prior_user,''),true),set_config('app.roles',coalesce(prior_roles,''),true),set_config('app.grants',coalesce(prior_grants,''),true);
 RAISE LOG 'queue_read compare fn=% users=% differs=%',p_function,users,differs;
 RETURN jsonb_build_object('function',p_function,'users',users,'differs',differs);
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.queue_read_compare(text,uuid) FROM PUBLIC,ai_hr_app;

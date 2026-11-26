-- ADR 0181 live work queues addendum, step Q1 (owner approved 25 November 2026): the Contract menu access the app frame
-- asks on every page, with the contract_staff automation arm asked once per statement.
--
-- app.contract_shared_navigation_access() (6432) answers five menu booleans. On staging (fictional data) it costs a
-- non-administrator about 0.18 s per page, 0.13 s of it in app.automation_can_configure('contract_staff') (6435): up to
-- three app.contract_shared_permitted calls per company of the tenant, each repeating contract_verified_human (and so
-- login_blocked), entitlement, contract_hr_admin's ancestry walk and contract_configure.
--
-- This installs, inert, exactly as 7330 does for the offboarding queue access:
--   * a queue_read_control row ('legacy');
--   * app.contract_shared_navigation_access_legacy(): the 6432 function, renamed, unchanged (guarded by its exact body);
--   * app.contract_staff_automation_v2() and app.contract_shared_navigation_access_v2(): the 6432 statement word for
--     word, with only its automation arm replaced by the once-per-statement form below;
--   * a PL/pgSQL dispatcher at the original name and grant (legacy / shadow / v2, shadow logging counts only).
--
-- Why the automation arm is unchanged, for the caller U of tenant T (6435 and 6308):
--   automation_can_configure('contract_staff') = T not null AND contract_verified_human(U) AND EXISTS a non-archived
--   company c of T with contract_shared_permitted(p, c) for p in workflows, templates, groups. For those three
--   permissions and no employment, contract_shared_permitted(p, c) is
--     coalesce(verified(U) AND entitled(c) AND (contract_hr_admin(c) OR contract_configure(c) OR member(p)), false),
--   where member(p) ignores the company: a current contract_access_member row of U whose role lists p. So the OR over
--   the three is entitled(c) AND (hr_admin(c) OR configure(c) OR member_any), with member_any one probe.
--   contract_hr_admin(c) and contract_configure(c) (2104) both return false for every company unless U holds an
--   hr_admin or super_admin role assignment, or (configure) a gbs contract role. For a caller with neither, the arm is
--   member_any AND EXISTS an entitled non-archived company; for the others the per-company functions are kept as they
--   are. The navigation uses the arm as coalesce(automation, false), so a NULL from either form reads as false.
DO $contract_navigation_predecessor$
DECLARE p pg_catalog.pg_proc%ROWTYPE;
BEGIN
 SELECT * INTO p FROM pg_catalog.pg_proc WHERE oid=to_regprocedure('app.contract_shared_navigation_access()');
 IF NOT FOUND OR md5(p.prosrc) IS DISTINCT FROM 'b423edc7f3e2d239160f548aecdc4f0b'
  OR p.prosecdef IS DISTINCT FROM true OR p.provolatile<>'s' OR p.prokind<>'f' OR p.proretset
  OR p.prorettype IS DISTINCT FROM ('jsonb'::regtype)::oid OR p.pronargs<>0
  OR p.prolang IS DISTINCT FROM (SELECT oid FROM pg_catalog.pg_language WHERE lanname='sql')
  OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']::text[] THEN
  RAISE EXCEPTION 'Unexpected Contract navigation access predecessor; review before restating it' USING ERRCODE='55000';
 END IF;
 IF (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid=to_regprocedure('app.automation_can_configure(text)')) IS DISTINCT FROM '996d8dc2508f1e99ffaa6085f6a8ff8a' THEN
  RAISE EXCEPTION 'Unexpected automation configure predecessor; review before restating the Contract automation arm' USING ERRCODE='55000';
 END IF;
 IF to_regprocedure('app.contract_shared_navigation_access_legacy()') IS NOT NULL OR to_regclass('public.queue_read_control') IS NULL THEN
  RAISE EXCEPTION 'Queue read restatement prerequisites differ' USING ERRCODE='55000';
 END IF;
END;
$contract_navigation_predecessor$;
--> statement-breakpoint
INSERT INTO public.queue_read_control(function_name,mode) VALUES('contract_shared_navigation_access','legacy');
--> statement-breakpoint
ALTER FUNCTION app.contract_shared_navigation_access() RENAME TO contract_shared_navigation_access_legacy;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.contract_shared_navigation_access_legacy() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_staff_automation_v2() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();me uuid:=app.current_user_id();member_any boolean;
BEGIN
 IF t IS NULL THEN RETURN false; END IF;
 IF app.contract_verified_human(me) IS NOT TRUE THEN RETURN app.contract_verified_human(me) AND false; END IF;
 member_any:=EXISTS(SELECT 1 FROM public.contract_access_member m JOIN public.contract_access_role r ON r.tenant_id=m.tenant_id AND r.id=m.role_id
  WHERE m.tenant_id=t AND m.user_id=me AND m.revoked_at IS NULL
  AND m.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (m.valid_to IS NULL OR m.valid_to>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
  AND r.permissions && ARRAY['workflows','templates','groups']::text[]);
 IF NOT EXISTS(SELECT 1 FROM public.role_assignment a WHERE a.tenant_id=t AND a.app_user_id=me AND a.role::text IN('hr_admin','super_admin'))
  AND NOT EXISTS(SELECT 1 FROM public.contract_role_assignment a WHERE a.tenant_id=t AND a.user_id=me AND a.role='gbs') THEN
  RETURN member_any AND EXISTS(SELECT 1 FROM public.company c WHERE c.tenant_id=t AND c.archived_at IS NULL AND coalesce(app.contract_company_entitled(c.id),false));
 END IF;
 RETURN EXISTS(SELECT 1 FROM public.company c WHERE c.tenant_id=t AND c.archived_at IS NULL
  AND coalesce(app.contract_company_entitled(c.id) AND (member_any OR app.contract_hr_admin(c.id) OR app.contract_configure(c.id)),false));
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.contract_staff_automation_v2() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_navigation_access_v2() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
-- The legacy configure/intake expressions are copied exactly, retaining their native capability owners.
 -- Do not call the old JSON projection: it eagerly evaluates an unused per-case page fallback.
 -- Retain the exact legacy named-role clause from 0950; do not inherit its generic
 -- case_access fallback, which also admits task-only approvers and employee recipients.
 RETURN (WITH legacy AS MATERIALIZED(SELECT jsonb_build_object('intake',EXISTS(SELECT 1 FROM public.company co WHERE co.tenant_id=app.current_tenant_id() AND co.archived_at IS NULL AND app.contract_company_entitled(co.id) AND (app.contract_gbs_company_scope(co.id) OR EXISTS(SELECT 1 FROM public.contract_role_assignment a WHERE a.company_id=co.id AND a.tenant_id=co.tenant_id AND a.user_id=app.current_user_id() AND app.contract_verified_human(a.user_id) AND a.revoked_at IS NULL AND a.role='pbp' AND app.contract_canonical_role(co.id,a.business_unit_id,a.user_id,'pbp') AND a.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (a.valid_to IS NULL OR a.valid_to>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)))),'configure',EXISTS(SELECT 1 FROM public.company co WHERE co.tenant_id=app.current_tenant_id() AND app.contract_configure(co.id))) AS facts),
 legacy_role AS MATERIALIZED(SELECT app.contract_active_user(app.current_user_id()) AND EXISTS(
  SELECT 1 FROM public.contract_role_assignment a WHERE a.tenant_id=app.current_tenant_id()
  AND a.user_id=app.current_user_id() AND app.contract_verified_human(a.user_id)
  AND a.role IN('pbp','gbs','legal','template_approver') AND a.revoked_at IS NULL
  AND (a.role NOT IN('pbp','gbs') OR app.contract_canonical_role(a.company_id,a.business_unit_id,a.user_id,a.role))
  AND a.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
  AND (a.valid_to IS NULL OR a.valid_to>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
  AND app.contract_company_entitled(a.company_id)) AS page),
 clock AS MATERIALIZED(SELECT (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AS today),
 company_rights AS MATERIALIZED(SELECT * FROM app.contract_shared_tracker_company_scope()),
 managed_rights AS MATERIALIZED(SELECT * FROM app.contract_shared_tracker_managed_subjects() WHERE can_view),
 placement AS MATERIALIZED(SELECT DISTINCT ON(a.employment_id) a.employment_id,a.employment_type
  FROM public.assignment a JOIN managed_rights r ON r.employment_id=a.employment_id CROSS JOIN clock
  WHERE a.tenant_id=app.current_tenant_id() AND a.superseded_at IS NULL AND a.valid_from<=today
  AND (a.valid_to IS NULL OR a.valid_to>today) ORDER BY a.employment_id,a.valid_from DESC,a.id),
 shared AS MATERIALIZED(SELECT
  app.contract_shared_access_admin() OR EXISTS(SELECT 1 FROM app.contract_shared_configuration_company_scope()) AS configure,
  app.contract_staff_automation_v2() AS automation,
  EXISTS(SELECT 1 FROM app.contract_shared_posting_scope()) AS postings)
 SELECT facts||jsonb_build_object('page',CASE
  WHEN coalesce((facts->>'configure')::boolean,false) OR coalesce((facts->>'intake')::boolean,false) OR legacy_role.page OR shared.configure THEN true
  WHEN EXISTS(SELECT 1 FROM company_rights WHERE is_admin OR named_view) THEN true
  ELSE EXISTS(SELECT 1 FROM managed_rights r JOIN public.employment e ON e.tenant_id=app.current_tenant_id() AND e.id=r.employment_id
   JOIN company_rights allowed_company ON allowed_company.company_id=e.company_id
   JOIN public.company co ON co.tenant_id=e.tenant_id AND co.id=e.company_id
   LEFT JOIN placement a ON a.employment_id=e.id CROSS JOIN clock
   WHERE coalesce(a.employment_type='contract' AND e.hired_on<=today AND e.voided_at IS NULL AND e.blacklisted_at IS NULL
    AND co.archived_at IS NULL AND (least(e.terminated_on,e.resignation_date,e.last_working_date) IS NULL
     OR least(e.terminated_on,e.resignation_date,e.last_working_date)>today),false)
    OR EXISTS(SELECT 1 FROM public.contract_case c WHERE c.tenant_id=e.tenant_id AND c.employment_id=e.id AND c.company_id=e.company_id)) END,
  'configure',coalesce((facts->>'configure')::boolean,false) OR shared.configure,
  'automation',coalesce(shared.automation,false),'postings',shared.postings) FROM legacy CROSS JOIN legacy_role CROSS JOIN shared);
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.contract_shared_navigation_access_v2() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_navigation_access() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_mode text;legacy jsonb;restated jsonb;
BEGIN
 SELECT c.mode INTO v_mode FROM public.queue_read_control c WHERE c.function_name='contract_shared_navigation_access';
 IF v_mode='v2' THEN RETURN app.contract_shared_navigation_access_v2(); END IF;
 legacy:=app.contract_shared_navigation_access_legacy();
 IF v_mode='shadow' THEN
  restated:=app.contract_shared_navigation_access_v2();
  RAISE LOG 'queue_read shadow fn=contract_shared_navigation_access reason=compared differs=%',CASE WHEN legacy IS DISTINCT FROM restated THEN 1 ELSE 0 END;
 END IF;
 RETURN legacy;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.contract_shared_navigation_access() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.contract_shared_navigation_access() TO ai_hr_app;

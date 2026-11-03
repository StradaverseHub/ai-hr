-- Provisional source reservation after foreign0952_teras_chats. No installation authority.
-- Fixed subject owners must prove a protected current-transaction intent and exact OLD/NEW values.
CREATE FUNCTION app.lifecycle_service_info_intent_allowed(p_old jsonb,p_new jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE allowed boolean:=false;
BEGIN
 IF jsonb_typeof(p_old) IS DISTINCT FROM 'object' OR jsonb_typeof(p_new) IS DISTINCT FROM 'object'
 OR app.current_tenant_id() IS NULL OR p_old->>'tenant_id' IS DISTINCT FROM app.current_tenant_id()::text
 OR p_new->>'tenant_id' IS DISTINCT FROM p_old->>'tenant_id' OR p_new->>'id' IS DISTINCT FROM p_old->>'id'
 OR p_new->>'company_id' IS DISTINCT FROM p_old->>'company_id' OR app.current_user_id() IS NULL
 OR app.principal_snapshot_current() IS NOT TRUE OR app.login_blocked(app.current_user_id()) THEN RETURN false;END IF;
 IF to_regprocedure('app.probation_service_info_intent_allowed(jsonb,jsonb)') IS NOT NULL THEN
  EXECUTE 'SELECT app.probation_service_info_intent_allowed($1,$2)' INTO allowed USING p_old,p_new;
  IF allowed IS TRUE THEN RETURN true;END IF;
 END IF;
 IF to_regprocedure('app.contract_service_info_intent_allowed(jsonb,jsonb)') IS NOT NULL THEN
  EXECUTE 'SELECT app.contract_service_info_intent_allowed($1,$2)' INTO allowed USING p_old,p_new;
  IF allowed IS TRUE THEN RETURN true;END IF;
 END IF;
 RETURN false;
END $$;
REVOKE ALL ON FUNCTION app.lifecycle_service_info_intent_allowed(jsonb,jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.access_workforce_service_info_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM jsonb_each(to_jsonb(NEW)) d WHERE d.key=ANY(app.access_workforce_service_info_columns()) AND d.value IS DISTINCT FROM to_jsonb(OLD)->d.key)
 OR app.access_workforce_storage_owner() THEN RETURN NEW;END IF;
 IF OLD.id IS DISTINCT FROM NEW.id OR OLD.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
  RAISE EXCEPTION 'Workforce service information maintenance unavailable' USING ERRCODE='42501';END IF;
 IF NOT app.access_workforce_company(OLD.company_id,'workforce.maintain') OR NOT app.access_workforce_company(NEW.company_id,'workforce.maintain') THEN
  IF app.lifecycle_service_info_intent_allowed(to_jsonb(OLD),to_jsonb(NEW)) IS NOT TRUE THEN
   RAISE EXCEPTION 'Workforce service information maintenance unavailable' USING ERRCODE='42501';END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.access_workforce_service_info_update() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Shared read-only ownership: existing V9 PBP rules and shared People Ops group.
-- Module opt-in rows may narrow these results; they must never replace them.
CREATE FUNCTION app.lifecycle_canonical_people_ops_member(wanted_company uuid,wanted_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.company co
 JOIN public.app_user u ON u.tenant_id=co.tenant_id AND u.id=wanted_user
 JOIN public.lc_v9_config v ON v.tenant_id=co.tenant_id
 JOIN public.lc_onboarding_config shared ON shared.tenant_id=co.tenant_id
 CROSS JOIN LATERAL jsonb_array_elements(coalesce(shared.data->'groups','[]'::jsonb)) g
 WHERE co.id=wanted_company AND co.tenant_id=app.current_tenant_id()
 AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
 AND g->>'id'=v.data->>'peopleOpsGroup' AND g->'members' ? u.id::text);
$$;
CREATE FUNCTION app.lifecycle_canonical_pbp_scope(wanted_company uuid,wanted_unit uuid,wanted_user uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 RETURN EXISTS(SELECT 1 FROM public.company co
 JOIN public.app_user u ON u.tenant_id=co.tenant_id AND u.id=wanted_user
 JOIN public.lc_v9_config v ON v.tenant_id=co.tenant_id
 CROSS JOIN LATERAL jsonb_array_elements(coalesce(v.data->'bpRules','[]'::jsonb)) r
 WHERE co.id=wanted_company AND co.tenant_id=app.current_tenant_id()
 AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) AND r->>'userId'=u.id::text
 AND (coalesce(jsonb_array_length(r->'rules'->'company'),0)=0 OR r->'rules'->'company' ? co.id::text)
 AND (wanted_unit IS NULL OR coalesce(jsonb_array_length(r->'rules'->'businessGroup'),0)=0 OR r->'rules'->'businessGroup' ? wanted_unit::text));
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
CREATE FUNCTION app.lifecycle_canonical_pbp_user(wanted_employment uuid,wanted_case uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result uuid;override_user text;
BEGIN
 IF wanted_case IS NOT NULL THEN
  SELECT c.data->'facts'->>'pbpUserId' INTO override_user FROM public.lc_v9_case c JOIN public.employment e ON e.id=c.employment_id AND e.tenant_id=c.tenant_id WHERE c.id=wanted_case AND c.employment_id=wanted_employment AND c.company_id=e.company_id AND c.tenant_id=app.current_tenant_id();
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF nullif(override_user,'') IS NOT NULL THEN
   result:=override_user::uuid;
   IF EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=result AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)) THEN RETURN result; END IF;
   RETURN NULL;
  END IF;
 END IF;
 WITH facts AS (
  SELECT e.company_id,a.business_unit_id,a.department_id,e.tenant_id
  FROM public.employment e
  LEFT JOIN LATERAL(SELECT x.business_unit_id,x.department_id FROM public.assignment x
   WHERE x.employment_id=e.id AND x.tenant_id=e.tenant_id AND x.superseded_at IS NULL
   AND x.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
   AND (x.valid_to IS NULL OR x.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
   ORDER BY x.valid_from DESC,x.id LIMIT 1) a ON true
  WHERE e.id=wanted_employment AND e.tenant_id=app.current_tenant_id()
 ), candidates AS (
  SELECT r->>'userId' AS user_id,
   (CASE WHEN coalesce(jsonb_array_length(r->'rules'->'businessGroup'),0)>0 THEN 4 ELSE 0 END
    +CASE WHEN coalesce(jsonb_array_length(r->'rules'->'company'),0)>0 THEN 2 ELSE 0 END
    +CASE WHEN coalesce(jsonb_array_length(r->'rules'->'department'),0)>0 THEN 1 ELSE 0 END) AS score
  FROM facts f JOIN public.lc_v9_config v ON v.tenant_id=f.tenant_id
  CROSS JOIN LATERAL jsonb_array_elements(coalesce(v.data->'bpRules','[]'::jsonb)) r
  WHERE (coalesce(jsonb_array_length(r->'rules'->'company'),0)=0 OR r->'rules'->'company' ? f.company_id::text)
   AND (coalesce(jsonb_array_length(r->'rules'->'businessGroup'),0)=0 OR r->'rules'->'businessGroup' ? f.business_unit_id::text)
   AND (coalesce(jsonb_array_length(r->'rules'->'department'),0)=0 OR r->'rules'->'department' ? f.department_id::text)
   AND NOT EXISTS(SELECT 1 FROM jsonb_each(coalesce(r->'rules','{}'::jsonb)) extra
    WHERE extra.key NOT IN('company','businessGroup','department') AND extra.value<>'[]'::jsonb)
 ), highest AS (SELECT DISTINCT user_id FROM candidates WHERE score=(SELECT max(score) FROM candidates))
 SELECT (min(h.user_id))::uuid INTO result FROM highest h HAVING count(*)=1;
 IF result IS NULL OR NOT EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=result AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)) THEN RETURN NULL; END IF;
 RETURN result;
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.lifecycle_canonical_people_ops_member(uuid,uuid),app.lifecycle_canonical_pbp_scope(uuid,uuid,uuid),app.lifecycle_canonical_pbp_user(uuid,uuid) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
-- Keep private records out of the company deletion projection. Expose only a scoped retention flag.
CREATE FUNCTION app.replan_retained_company_in_use(wanted_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT COALESCE(app.principal_snapshot_current() AND app.is_admin_for(wanted_company)
  AND EXISTS(SELECT 1 FROM public.company c WHERE c.id=wanted_company AND c.tenant_id=app.current_tenant_id()),false)
  AND (
   EXISTS(SELECT 1 FROM public.contract_case h WHERE h.tenant_id=app.current_tenant_id() AND h.company_id=wanted_company)
   OR EXISTS(SELECT 1 FROM public.contract_configuration h WHERE h.tenant_id=app.current_tenant_id() AND h.company_id=wanted_company)
   OR EXISTS(SELECT 1 FROM public.contract_retirement_custody h WHERE h.tenant_id=app.current_tenant_id() AND h.company_id=wanted_company)
   OR EXISTS(SELECT 1 FROM public.contract_role_assignment h WHERE h.tenant_id=app.current_tenant_id() AND h.company_id=wanted_company)
   OR EXISTS(SELECT 1 FROM public.contract_template h WHERE h.tenant_id=app.current_tenant_id() AND h.company_id=wanted_company)
   OR EXISTS(SELECT 1 FROM public.contract_term h WHERE h.tenant_id=app.current_tenant_id() AND h.company_id=wanted_company)
   OR EXISTS(SELECT 1 FROM public.contract_workflow h WHERE h.tenant_id=app.current_tenant_id() AND h.company_id=wanted_company)
   OR EXISTS(SELECT 1 FROM public.document_signing_document h WHERE h.tenant_id=app.current_tenant_id() AND h.company_id=wanted_company)
   OR EXISTS(SELECT 1 FROM public.payroll_tax_basis_replacement h WHERE h.tenant_id=app.current_tenant_id() AND h.company_id=wanted_company)
   OR EXISTS(SELECT 1 FROM public.probation_access h WHERE h.tenant_id=app.current_tenant_id() AND h.company_id=wanted_company)
   OR EXISTS(SELECT 1 FROM public.probation_activation h WHERE h.tenant_id=app.current_tenant_id() AND h.company_id=wanted_company)
   OR EXISTS(SELECT 1 FROM public.probation_builder_definition h WHERE h.tenant_id=app.current_tenant_id() AND h.company_id=wanted_company)
   OR EXISTS(SELECT 1 FROM public.probation_case h WHERE h.tenant_id=app.current_tenant_id() AND h.company_id=wanted_company)
   OR EXISTS(SELECT 1 FROM public.probation_configuration h WHERE h.tenant_id=app.current_tenant_id() AND h.company_id=wanted_company)
   OR EXISTS(SELECT 1 FROM public.probation_cutover h WHERE h.tenant_id=app.current_tenant_id() AND h.company_id=wanted_company)
   OR EXISTS(SELECT 1 FROM public.probation_intake_entry h WHERE h.tenant_id=app.current_tenant_id() AND h.company_id=wanted_company)
   OR EXISTS(SELECT 1 FROM public.probation_intake_evidence h WHERE h.tenant_id=app.current_tenant_id() AND h.company_id=wanted_company)
   OR EXISTS(SELECT 1 FROM public.probation_offline_final_proposal h WHERE h.tenant_id=app.current_tenant_id() AND h.company_id=wanted_company)
   OR EXISTS(SELECT 1 FROM public.contract_role_assignment h JOIN public.business_unit source ON source.id=h.business_unit_id AND source.tenant_id=h.tenant_id WHERE source.tenant_id=app.current_tenant_id() AND source.company_id=wanted_company)
   OR EXISTS(SELECT 1 FROM public.probation_access h JOIN public.business_unit source ON source.id=h.business_unit_id AND source.tenant_id=h.tenant_id WHERE source.tenant_id=app.current_tenant_id() AND source.company_id=wanted_company)
   OR EXISTS(SELECT 1 FROM public.probation_access h JOIN public.department source ON source.id=h.department_id AND source.tenant_id=h.tenant_id WHERE source.tenant_id=app.current_tenant_id() AND source.company_id=wanted_company)
  );
$$;
REVOKE ALL ON FUNCTION app.replan_retained_company_in_use(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.replan_retained_company_in_use(uuid) TO ai_hr_app;

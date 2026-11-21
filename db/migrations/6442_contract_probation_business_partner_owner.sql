-- UNALLOCATED REVIEW SOURCE. No journal/installation authority. Initial state is EMPTY.
-- Only Contract/Probation business responsibility; removed On/Off PBP remains removed.
CREATE TABLE public.automation_business_partner_config(
 tenant_id uuid PRIMARY KEY REFERENCES public.tenant(id),revision integer NOT NULL CHECK(revision>0),
 rules jsonb NOT NULL CHECK(jsonb_typeof(rules)='array' AND jsonb_array_length(rules)<=500)
);
CREATE TABLE public.automation_business_partner_config_revision(
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),revision integer NOT NULL CHECK(revision>0),rules jsonb NOT NULL,
 actor_user_id uuid NOT NULL REFERENCES public.app_user(id),actor_person_id uuid NOT NULL REFERENCES public.person(id),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 20 AND 5000),event_id uuid NOT NULL UNIQUE REFERENCES public.domain_event(id),
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,revision)
);
ALTER TABLE public.automation_business_partner_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_business_partner_config FORCE ROW LEVEL SECURITY;
ALTER TABLE public.automation_business_partner_config_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_business_partner_config_revision FORCE ROW LEVEL SECURITY;
CREATE POLICY automation_business_partner_config_owner ON public.automation_business_partner_config FOR ALL TO ai_hr_owner USING(tenant_id=app.current_tenant_id() AND app.acting_as_owner()) WITH CHECK(tenant_id=app.current_tenant_id() AND app.acting_as_owner());
CREATE POLICY automation_business_partner_revision_owner ON public.automation_business_partner_config_revision FOR ALL TO ai_hr_owner USING(tenant_id=app.current_tenant_id() AND app.acting_as_owner()) WITH CHECK(tenant_id=app.current_tenant_id() AND app.acting_as_owner());
REVOKE ALL ON public.automation_business_partner_config,public.automation_business_partner_config_revision FROM PUBLIC,ai_hr_app;
GRANT SELECT,INSERT,UPDATE ON public.automation_business_partner_config TO ai_hr_owner;
GRANT SELECT,INSERT ON public.automation_business_partner_config_revision TO ai_hr_owner;
--> statement-breakpoint
CREATE FUNCTION app.automation_business_partner_history_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN RAISE EXCEPTION 'Business Partner configuration history is immutable' USING ERRCODE='55000';END $$;
REVOKE ALL ON FUNCTION app.automation_business_partner_history_immutable() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER automation_business_partner_history_immutable BEFORE UPDATE OR DELETE ON public.automation_business_partner_config_revision FOR EACH ROW EXECUTE FUNCTION app.automation_business_partner_history_immutable();
--> statement-breakpoint
-- NULL company selects only the tenant-wide lifecycle entitlement, as withLifecycleTenant does.
CREATE FUNCTION app.automation_business_partner_can_manage() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(app.current_tenant_id() IS NOT NULL AND app.current_user_id() IS NOT NULL
  AND app.principal_snapshot_current() AND app.is_group_admin() AND app.probation_company_entitled(NULL::uuid)
  AND EXISTS(SELECT 1 FROM public.app_user u JOIN public.person p ON p.tenant_id=u.tenant_id AND p.id=u.person_id
   WHERE u.tenant_id=app.current_tenant_id() AND u.id=app.current_user_id() AND u.archived_at IS NULL
    AND NOT app.login_blocked(u.id) AND length(btrim(p.full_name))>0),false)
$$;
REVOKE ALL ON FUNCTION app.automation_business_partner_can_manage() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.automation_business_partner_can_manage() TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.automation_business_partner_workspace() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF app.automation_business_partner_can_manage() IS NOT TRUE THEN RAISE EXCEPTION 'Business Partner configuration is unavailable' USING ERRCODE='42501';END IF;
 WITH config AS MATERIALIZED(SELECT coalesce((SELECT revision FROM public.automation_business_partner_config WHERE tenant_id=app.current_tenant_id()),0) revision,
  coalesce((SELECT rules FROM public.automation_business_partner_config WHERE tenant_id=app.current_tenant_id()),'[]'::jsonb) rules),
 selected_people AS MATERIALIZED(SELECT DISTINCT rule->>'userId' id FROM config CROSS JOIN LATERAL jsonb_array_elements(rules) rule),
 people AS MATERIALIZED(SELECT u.id,btrim(p.full_name) name FROM selected_people s JOIN public.app_user u ON u.id::text=s.id JOIN public.person p ON p.tenant_id=u.tenant_id AND p.id=u.person_id
  WHERE u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) AND length(btrim(p.full_name))>0),
 selected_scopes AS MATERIALIZED(SELECT DISTINCT dimension.kind,value.id FROM config CROSS JOIN LATERAL jsonb_array_elements(rules) rule
  CROSS JOIN (VALUES('businessGroup'),('company'),('department')) dimension(kind)
  CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(rule->'rules'->dimension.kind,'[]'::jsonb)) value(id)),
 labels AS MATERIALIZED(
  SELECT s.kind,b.id,coalesce(nullif(btrim(b.name),''),'Unavailable business unit')||' · '||coalesce(nullif(btrim(co.legal_name),''),CASE WHEN b.company_id IS NULL THEN 'Global' ELSE 'Unavailable company' END) name FROM selected_scopes s JOIN public.business_unit b ON b.id::text=s.id LEFT JOIN public.company co ON co.tenant_id=b.tenant_id AND co.id=b.company_id WHERE s.kind='businessGroup' AND b.tenant_id=app.current_tenant_id() AND b.archived_at IS NULL
  UNION ALL SELECT s.kind,c.id,coalesce(nullif(btrim(c.legal_name),''),'Unavailable company') FROM selected_scopes s JOIN public.company c ON c.id::text=s.id WHERE s.kind='company' AND c.tenant_id=app.current_tenant_id() AND c.archived_at IS NULL
  UNION ALL SELECT s.kind,d.id,coalesce(nullif(btrim(d.name),''),'Unavailable department')||' · '||coalesce(nullif(btrim(co.legal_name),''),CASE WHEN d.company_id IS NULL THEN 'Global' ELSE 'Unavailable company' END) FROM selected_scopes s JOIN public.department d ON d.id::text=s.id LEFT JOIN public.company co ON co.tenant_id=d.tenant_id AND co.id=d.company_id WHERE s.kind='department' AND d.tenant_id=app.current_tenant_id() AND d.archived_at IS NULL)
 SELECT jsonb_build_object('revision',config.revision,'rules',config.rules,
  'people',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'name',name) ORDER BY lower(name),id) FROM people),'[]'::jsonb),
  'scopeLabels',jsonb_build_object(
   'businessGroup',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'name',name) ORDER BY lower(name),id) FROM labels WHERE kind='businessGroup'),'[]'::jsonb),
   'company',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'name',name) ORDER BY lower(name),id) FROM labels WHERE kind='company'),'[]'::jsonb),
   'department',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'name',name) ORDER BY lower(name),id) FROM labels WHERE kind='department'),'[]'::jsonb))) INTO result FROM config;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.automation_business_partner_workspace() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.automation_business_partner_workspace() TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.automation_business_partner_people(p_search text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.automation_business_partner_can_manage() IS NOT TRUE THEN RAISE EXCEPTION 'Business Partner configuration is unavailable' USING ERRCODE='42501';END IF;
 IF p_search IS NULL OR length(p_search)>100 THEN RAISE EXCEPTION 'Check the account search' USING ERRCODE='22023';END IF;
 IF length(btrim(p_search))<2 THEN RETURN '[]'::jsonb;END IF;
 RETURN(SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name) ORDER BY lower(name),id),'[]'::jsonb) FROM(
  SELECT u.id,btrim(p.full_name) name FROM public.app_user u JOIN public.person p ON p.tenant_id=u.tenant_id AND p.id=u.person_id
  WHERE u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) AND length(btrim(p.full_name))>0
   AND position(lower(btrim(p_search)) IN lower(p.full_name))>0 ORDER BY lower(btrim(p.full_name)),u.id LIMIT 20) found);
END $$;
REVOKE ALL ON FUNCTION app.automation_business_partner_people(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.automation_business_partner_people(text) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.automation_business_partner_scope_options(p_dimension text,p_search text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.automation_business_partner_can_manage() IS NOT TRUE THEN RAISE EXCEPTION 'Business Partner configuration is unavailable' USING ERRCODE='42501';END IF;
 IF p_dimension IS NULL OR p_dimension NOT IN('businessGroup','company','department') OR p_search IS NULL OR length(p_search)>100 THEN RAISE EXCEPTION 'Check the responsibility scope search' USING ERRCODE='22023';END IF;
 IF length(btrim(p_search))<2 THEN RETURN '[]'::jsonb;END IF;
 RETURN(SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name) ORDER BY lower(name),id),'[]'::jsonb) FROM(
  SELECT * FROM(
   SELECT b.id,coalesce(nullif(btrim(b.name),''),'Unavailable business unit')||' · '||coalesce(nullif(btrim(co.legal_name),''),CASE WHEN b.company_id IS NULL THEN 'Global' ELSE 'Unavailable company' END) name FROM public.business_unit b LEFT JOIN public.company co ON co.tenant_id=b.tenant_id AND co.id=b.company_id WHERE p_dimension='businessGroup' AND b.tenant_id=app.current_tenant_id() AND b.archived_at IS NULL
   UNION ALL SELECT c.id,coalesce(nullif(btrim(c.legal_name),''),'Unavailable company') FROM public.company c WHERE p_dimension='company' AND c.tenant_id=app.current_tenant_id() AND c.archived_at IS NULL
   UNION ALL SELECT d.id,coalesce(nullif(btrim(d.name),''),'Unavailable department')||' · '||coalesce(nullif(btrim(co.legal_name),''),CASE WHEN d.company_id IS NULL THEN 'Global' ELSE 'Unavailable company' END) FROM public.department d LEFT JOIN public.company co ON co.tenant_id=d.tenant_id AND co.id=d.company_id WHERE p_dimension='department' AND d.tenant_id=app.current_tenant_id() AND d.archived_at IS NULL) scoped
  WHERE position(lower(btrim(p_search)) IN lower(name))>0 ORDER BY lower(name),id LIMIT 20) found);
END $$;
REVOKE ALL ON FUNCTION app.automation_business_partner_scope_options(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.automation_business_partner_scope_options(text,text) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.automation_business_partner_save(p_expected integer,p_rules jsonb,p_reason text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();prior public.automation_business_partner_config;next_revision integer;actual_person uuid;event_id uuid:=gen_random_uuid();
BEGIN
 PERFORM app.access_workforce_write_lock();
 IF app.automation_business_partner_can_manage() IS NOT TRUE THEN RAISE EXCEPTION 'Business Partner configuration is unavailable' USING ERRCODE='42501';END IF;
 IF p_expected IS NULL OR p_expected<0 OR length(btrim(coalesce(p_reason,''))) NOT BETWEEN 20 AND 5000 OR jsonb_typeof(p_rules) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Check the responsibility rules and change reason' USING ERRCODE='22023';END IF;
 IF jsonb_array_length(p_rules)>500 THEN RAISE EXCEPTION 'At most 500 responsibility rules are allowed' USING ERRCODE='22023';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(t::text||':onboarding',0));
 PERFORM pg_advisory_xact_lock(hashtextextended('lifecycle-v9:'||t::text,0));
 SELECT * INTO prior FROM public.automation_business_partner_config WHERE tenant_id=t FOR UPDATE;
 IF coalesce(prior.revision,0) IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'Business Partner configuration changed; reload before saving' USING ERRCODE='40001';END IF;
 -- Validate the entire authored input as sets: constant statement count, no per-rule/tenant scope query loop.
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_rules) entry(rule) WHERE jsonb_typeof(rule) IS DISTINCT FROM 'object'
  OR rule-ARRAY['userId','rules']<>'{}'::jsonb OR jsonb_typeof(rule->'userId') IS DISTINCT FROM 'string'
  OR coalesce(rule->>'userId','')!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  OR jsonb_typeof(rule->'rules') IS DISTINCT FROM 'object' OR (rule->'rules')-ARRAY['businessGroup','company','department']<>'{}'::jsonb) THEN RAISE EXCEPTION 'Check the responsibility rule shape' USING ERRCODE='22023';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_rules) entry(rule) CROSS JOIN(VALUES('businessGroup'),('company'),('department')) dimension(kind)
  WHERE (rule->'rules') ? kind AND jsonb_typeof(rule->'rules'->kind) IS DISTINCT FROM 'array') THEN RAISE EXCEPTION 'Responsibility scopes must be UUID arrays' USING ERRCODE='22023';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_rules) entry(rule) CROSS JOIN(VALUES('businessGroup'),('company'),('department')) dimension(kind)
  CROSS JOIN LATERAL jsonb_array_elements(coalesce(rule->'rules'->kind,'[]'::jsonb)) item(value)
  WHERE jsonb_typeof(value) IS DISTINCT FROM 'string' OR (value#>>'{}')!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN RAISE EXCEPTION 'Responsibility scopes must be UUID arrays' USING ERRCODE='22023';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_rules) rule WHERE NOT EXISTS(SELECT 1 FROM public.app_user u JOIN public.person p ON p.tenant_id=u.tenant_id AND p.id=u.person_id
  WHERE u.tenant_id=t AND u.id::text=rule->>'userId' AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) AND length(btrim(p.full_name))>0)) THEN RAISE EXCEPTION 'Choose an available account with its actual verified Person' USING ERRCODE='22023';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_rules) rule CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(rule->'rules'->'company','[]'::jsonb)) target(id)
  WHERE NOT EXISTS(SELECT 1 FROM public.company c WHERE c.tenant_id=t AND c.id::text=target.id AND c.archived_at IS NULL))
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_rules) rule CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(rule->'rules'->'businessGroup','[]'::jsonb)) target(id)
  WHERE NOT EXISTS(SELECT 1 FROM public.business_unit b WHERE b.tenant_id=t AND b.id::text=target.id AND b.archived_at IS NULL))
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_rules) rule CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(rule->'rules'->'department','[]'::jsonb)) target(id)
  WHERE NOT EXISTS(SELECT 1 FROM public.department d WHERE d.tenant_id=t AND d.id::text=target.id AND d.archived_at IS NULL)) THEN RAISE EXCEPTION 'Choose current responsibility scopes in this tenant' USING ERRCODE='22023';END IF;
 next_revision:=coalesce(prior.revision,0)+1;
 SELECT person_id INTO actual_person FROM public.app_user WHERE tenant_id=t AND id=app.current_user_id();
 INSERT INTO public.domain_event(id,tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
 VALUES(event_id,t,'automation-business-partner-config',t,'automation.businessPartners.saved','user',app.current_user_id(),jsonb_build_object('revision',next_revision,'reason',btrim(p_reason),'ruleCount',jsonb_array_length(p_rules)));
 INSERT INTO public.automation_business_partner_config_revision(tenant_id,revision,rules,actor_user_id,actor_person_id,reason,event_id) VALUES(t,next_revision,p_rules,app.current_user_id(),actual_person,btrim(p_reason),event_id);
 INSERT INTO public.automation_business_partner_config(tenant_id,revision,rules) VALUES(t,next_revision,p_rules) ON CONFLICT(tenant_id) DO UPDATE SET revision=excluded.revision,rules=excluded.rules;
 RETURN app.automation_business_partner_workspace();
END $$;
REVOKE ALL ON FUNCTION app.automation_business_partner_save(integer,jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.automation_business_partner_save(integer,jsonb,text) TO ai_hr_app;

--> statement-breakpoint
-- Exact current effective owner 0953_lifecycle_service_info_intents.sql; same OID, owner and existing ACL.
DO $bp_owner$
DECLARE definition text;source text;
BEGIN
 SELECT prosrc,pg_get_functiondef(oid) INTO source,definition FROM pg_proc WHERE oid='app.lifecycle_canonical_pbp_scope(uuid,uuid,uuid)'::regprocedure;
 IF encode(sha256(convert_to(source,'UTF8')),'hex') IS DISTINCT FROM '88a63fcd4da4e790aed6c3920c134904030903171a29204757ac779e087c4722' THEN RAISE EXCEPTION 'Unexpected native lifecycle_canonical_pbp_scope before Business Partner source replacement';END IF;
 IF position($old_bp$
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
END $old_bp$ IN definition)=0 THEN RAISE EXCEPTION 'Native lifecycle_canonical_pbp_scope declaration/source changed';END IF;
 definition:=replace(definition,$old_bp$
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
END $old_bp$,$new_bp$
BEGIN
 RETURN EXISTS(SELECT 1 FROM public.company co
 JOIN public.app_user u ON u.tenant_id=co.tenant_id AND u.id=wanted_user
 JOIN public.automation_business_partner_config v ON v.tenant_id=co.tenant_id
 CROSS JOIN LATERAL jsonb_array_elements(coalesce(v.rules,'[]'::jsonb)) r
 WHERE co.id=wanted_company AND co.tenant_id=app.current_tenant_id()
 AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) AND r->>'userId'=u.id::text
 AND (coalesce(jsonb_array_length(r->'rules'->'company'),0)=0 OR r->'rules'->'company' ? co.id::text)
 AND (wanted_unit IS NULL OR coalesce(jsonb_array_length(r->'rules'->'businessGroup'),0)=0 OR r->'rules'->'businessGroup' ? wanted_unit::text));
EXCEPTION WHEN OTHERS THEN RETURN false;
END $new_bp$);
 EXECUTE definition;
END $bp_owner$;

--> statement-breakpoint
-- Exact current effective owner 0953_lifecycle_service_info_intents.sql; same OID, owner and existing ACL.
DO $bp_owner$
DECLARE definition text;source text;
BEGIN
 SELECT prosrc,pg_get_functiondef(oid) INTO source,definition FROM pg_proc WHERE oid='app.lifecycle_canonical_pbp_user(uuid,uuid)'::regprocedure;
 IF encode(sha256(convert_to(source,'UTF8')),'hex') IS DISTINCT FROM '0630edd8b6d65e4026068f5feaf1de738cc28b8181ddc599755de02b81c91af1' THEN RAISE EXCEPTION 'Unexpected native lifecycle_canonical_pbp_user before Business Partner source replacement';END IF;
 IF position($old_bp$
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
END $old_bp$ IN definition)=0 THEN RAISE EXCEPTION 'Native lifecycle_canonical_pbp_user declaration/source changed';END IF;
 definition:=replace(definition,$old_bp$
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
END $old_bp$,$new_bp$
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
  FROM facts f JOIN public.automation_business_partner_config v ON v.tenant_id=f.tenant_id
  CROSS JOIN LATERAL jsonb_array_elements(coalesce(v.rules,'[]'::jsonb)) r
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
END $new_bp$);
 EXECUTE definition;
END $bp_owner$;

--> statement-breakpoint
-- Exact current effective owner 6432_contract_shared_navigation_access.sql; same OID, owner and existing ACL.
DO $bp_owner$
DECLARE definition text;source text;
BEGIN
 SELECT prosrc,pg_get_functiondef(oid) INTO source,definition FROM pg_proc WHERE oid='app.contract_shared_tracker_subjects()'::regprocedure;
 IF encode(sha256(convert_to(source,'UTF8')),'hex') IS DISTINCT FROM 'ecb7c7755b4ae74b8aa87af9864fceb94a1a62de77d6c51933c512cd96447a3a' THEN RAISE EXCEPTION 'Unexpected native contract_shared_tracker_subjects before Business Partner source replacement';END IF;
 IF position($old_bp$
 WITH RECURSIVE clock AS MATERIALIZED(SELECT (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AS today),
 actor AS MATERIALIZED(SELECT u.id,u.person_id,app.contract_verified_human(u.id) AS verified FROM public.app_user u WHERE u.tenant_id=app.current_tenant_id() AND u.id=app.current_user_id()),
 companies AS MATERIALIZED(SELECT * FROM app.contract_shared_tracker_company_scope()),
 legacy_roles AS MATERIALIZED(SELECT r.* FROM public.contract_role_assignment r CROSS JOIN clock WHERE r.tenant_id=app.current_tenant_id() AND r.user_id=app.current_user_id() AND r.revoked_at IS NULL AND r.valid_from<=today AND (r.valid_to IS NULL OR r.valid_to>=today)),
 placement AS MATERIALIZED(SELECT DISTINCT ON(a.employment_id) a.employment_id,a.business_unit_id,a.department_id FROM public.assignment a CROSS JOIN clock WHERE a.tenant_id=app.current_tenant_id() AND a.superseded_at IS NULL AND a.valid_from<=today AND (a.valid_to IS NULL OR a.valid_to>today) ORDER BY a.employment_id,a.valid_from DESC,a.id),
 bp_rules AS MATERIALIZED(SELECT r->>'userId' AS user_id,coalesce(r->'rules','{}'::jsonb) AS rules,
  (CASE WHEN coalesce(jsonb_array_length(r->'rules'->'businessGroup'),0)>0 THEN 4 ELSE 0 END+CASE WHEN coalesce(jsonb_array_length(r->'rules'->'company'),0)>0 THEN 2 ELSE 0 END+CASE WHEN coalesce(jsonb_array_length(r->'rules'->'department'),0)>0 THEN 1 ELSE 0 END) AS score
  FROM public.lc_v9_config v CROSS JOIN LATERAL jsonb_array_elements(coalesce(v.data->'bpRules','[]'::jsonb)) r WHERE v.tenant_id=app.current_tenant_id()),
 bp_matches AS MATERIALIZED(SELECT e.id,r.user_id,r.score,max(r.score) OVER(PARTITION BY e.id) AS top_score FROM public.employment e LEFT JOIN placement a ON a.employment_id=e.id JOIN bp_rules r ON
  (coalesce(jsonb_array_length(r.rules->'company'),0)=0 OR r.rules->'company' ? e.company_id::text)
  AND (coalesce(jsonb_array_length(r.rules->'businessGroup'),0)=0 OR r.rules->'businessGroup' ? a.business_unit_id::text)
  AND (coalesce(jsonb_array_length(r.rules->'department'),0)=0 OR r.rules->'department' ? a.department_id::text)
  AND NOT EXISTS(SELECT 1 FROM jsonb_each(r.rules) extra WHERE extra.key NOT IN('company','businessGroup','department') AND extra.value<>'[]'::jsonb)
  WHERE e.tenant_id=app.current_tenant_id()),
 pbp AS MATERIALIZED(SELECT id FROM bp_matches WHERE score=top_score GROUP BY id HAVING count(DISTINCT user_id)=1 AND min(user_id)=app.current_user_id()::text),
 managed AS MATERIALIZED(SELECT * FROM app.contract_shared_tracker_managed_subjects()),
 rights AS MATERIALIZED(SELECT e.id,c.is_admin AS admin,c.named_view,c.named_decide,
  CASE WHEN managed.employment_id IS NOT NULL THEN managed.can_view ELSE false END AS superior_view,CASE WHEN managed.employment_id IS NOT NULL THEN managed.can_decide ELSE false END AS superior_decide,
  EXISTS(SELECT 1 FROM pbp WHERE id=e.id) AND e.person_id IS DISTINCT FROM u.person_id AND EXISTS(SELECT 1 FROM legacy_roles r WHERE r.company_id=c.company_id AND r.role='pbp' AND (r.business_unit_id IS NULL OR r.business_unit_id=a.business_unit_id)) AS bp
  FROM public.employment e JOIN companies c ON c.company_id=e.company_id CROSS JOIN actor u LEFT JOIN placement a ON a.employment_id=e.id
  LEFT JOIN managed ON managed.employment_id=e.id
  WHERE e.tenant_id=app.current_tenant_id() AND u.verified)
 SELECT id,admin OR named_view OR superior_view OR bp,admin OR named_decide OR superior_decide OR bp FROM rights
$old_bp$ IN definition)=0 THEN RAISE EXCEPTION 'Native contract_shared_tracker_subjects declaration/source changed';END IF;
 definition:=replace(definition,$old_bp$
 WITH RECURSIVE clock AS MATERIALIZED(SELECT (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AS today),
 actor AS MATERIALIZED(SELECT u.id,u.person_id,app.contract_verified_human(u.id) AS verified FROM public.app_user u WHERE u.tenant_id=app.current_tenant_id() AND u.id=app.current_user_id()),
 companies AS MATERIALIZED(SELECT * FROM app.contract_shared_tracker_company_scope()),
 legacy_roles AS MATERIALIZED(SELECT r.* FROM public.contract_role_assignment r CROSS JOIN clock WHERE r.tenant_id=app.current_tenant_id() AND r.user_id=app.current_user_id() AND r.revoked_at IS NULL AND r.valid_from<=today AND (r.valid_to IS NULL OR r.valid_to>=today)),
 placement AS MATERIALIZED(SELECT DISTINCT ON(a.employment_id) a.employment_id,a.business_unit_id,a.department_id FROM public.assignment a CROSS JOIN clock WHERE a.tenant_id=app.current_tenant_id() AND a.superseded_at IS NULL AND a.valid_from<=today AND (a.valid_to IS NULL OR a.valid_to>today) ORDER BY a.employment_id,a.valid_from DESC,a.id),
 bp_rules AS MATERIALIZED(SELECT r->>'userId' AS user_id,coalesce(r->'rules','{}'::jsonb) AS rules,
  (CASE WHEN coalesce(jsonb_array_length(r->'rules'->'businessGroup'),0)>0 THEN 4 ELSE 0 END+CASE WHEN coalesce(jsonb_array_length(r->'rules'->'company'),0)>0 THEN 2 ELSE 0 END+CASE WHEN coalesce(jsonb_array_length(r->'rules'->'department'),0)>0 THEN 1 ELSE 0 END) AS score
  FROM public.lc_v9_config v CROSS JOIN LATERAL jsonb_array_elements(coalesce(v.data->'bpRules','[]'::jsonb)) r WHERE v.tenant_id=app.current_tenant_id()),
 bp_matches AS MATERIALIZED(SELECT e.id,r.user_id,r.score,max(r.score) OVER(PARTITION BY e.id) AS top_score FROM public.employment e LEFT JOIN placement a ON a.employment_id=e.id JOIN bp_rules r ON
  (coalesce(jsonb_array_length(r.rules->'company'),0)=0 OR r.rules->'company' ? e.company_id::text)
  AND (coalesce(jsonb_array_length(r.rules->'businessGroup'),0)=0 OR r.rules->'businessGroup' ? a.business_unit_id::text)
  AND (coalesce(jsonb_array_length(r.rules->'department'),0)=0 OR r.rules->'department' ? a.department_id::text)
  AND NOT EXISTS(SELECT 1 FROM jsonb_each(r.rules) extra WHERE extra.key NOT IN('company','businessGroup','department') AND extra.value<>'[]'::jsonb)
  WHERE e.tenant_id=app.current_tenant_id()),
 pbp AS MATERIALIZED(SELECT id FROM bp_matches WHERE score=top_score GROUP BY id HAVING count(DISTINCT user_id)=1 AND min(user_id)=app.current_user_id()::text),
 managed AS MATERIALIZED(SELECT * FROM app.contract_shared_tracker_managed_subjects()),
 rights AS MATERIALIZED(SELECT e.id,c.is_admin AS admin,c.named_view,c.named_decide,
  CASE WHEN managed.employment_id IS NOT NULL THEN managed.can_view ELSE false END AS superior_view,CASE WHEN managed.employment_id IS NOT NULL THEN managed.can_decide ELSE false END AS superior_decide,
  EXISTS(SELECT 1 FROM pbp WHERE id=e.id) AND e.person_id IS DISTINCT FROM u.person_id AND EXISTS(SELECT 1 FROM legacy_roles r WHERE r.company_id=c.company_id AND r.role='pbp' AND (r.business_unit_id IS NULL OR r.business_unit_id=a.business_unit_id)) AS bp
  FROM public.employment e JOIN companies c ON c.company_id=e.company_id CROSS JOIN actor u LEFT JOIN placement a ON a.employment_id=e.id
  LEFT JOIN managed ON managed.employment_id=e.id
  WHERE e.tenant_id=app.current_tenant_id() AND u.verified)
 SELECT id,admin OR named_view OR superior_view OR bp,admin OR named_decide OR superior_decide OR bp FROM rights
$old_bp$,$new_bp$
 WITH RECURSIVE clock AS MATERIALIZED(SELECT (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AS today),
 actor AS MATERIALIZED(SELECT u.id,u.person_id,app.contract_verified_human(u.id) AS verified FROM public.app_user u WHERE u.tenant_id=app.current_tenant_id() AND u.id=app.current_user_id()),
 companies AS MATERIALIZED(SELECT * FROM app.contract_shared_tracker_company_scope()),
 legacy_roles AS MATERIALIZED(SELECT r.* FROM public.contract_role_assignment r CROSS JOIN clock WHERE r.tenant_id=app.current_tenant_id() AND r.user_id=app.current_user_id() AND r.revoked_at IS NULL AND r.valid_from<=today AND (r.valid_to IS NULL OR r.valid_to>=today)),
 placement AS MATERIALIZED(SELECT DISTINCT ON(a.employment_id) a.employment_id,a.business_unit_id,a.department_id FROM public.assignment a CROSS JOIN clock WHERE a.tenant_id=app.current_tenant_id() AND a.superseded_at IS NULL AND a.valid_from<=today AND (a.valid_to IS NULL OR a.valid_to>today) ORDER BY a.employment_id,a.valid_from DESC,a.id),
 bp_rules AS MATERIALIZED(SELECT r->>'userId' AS user_id,coalesce(r->'rules','{}'::jsonb) AS rules,
  (CASE WHEN coalesce(jsonb_array_length(r->'rules'->'businessGroup'),0)>0 THEN 4 ELSE 0 END+CASE WHEN coalesce(jsonb_array_length(r->'rules'->'company'),0)>0 THEN 2 ELSE 0 END+CASE WHEN coalesce(jsonb_array_length(r->'rules'->'department'),0)>0 THEN 1 ELSE 0 END) AS score
  FROM public.automation_business_partner_config v CROSS JOIN LATERAL jsonb_array_elements(coalesce(v.rules,'[]'::jsonb)) r WHERE v.tenant_id=app.current_tenant_id()),
 bp_matches AS MATERIALIZED(SELECT e.id,r.user_id,r.score,max(r.score) OVER(PARTITION BY e.id) AS top_score FROM public.employment e LEFT JOIN placement a ON a.employment_id=e.id JOIN bp_rules r ON
  (coalesce(jsonb_array_length(r.rules->'company'),0)=0 OR r.rules->'company' ? e.company_id::text)
  AND (coalesce(jsonb_array_length(r.rules->'businessGroup'),0)=0 OR r.rules->'businessGroup' ? a.business_unit_id::text)
  AND (coalesce(jsonb_array_length(r.rules->'department'),0)=0 OR r.rules->'department' ? a.department_id::text)
  AND NOT EXISTS(SELECT 1 FROM jsonb_each(r.rules) extra WHERE extra.key NOT IN('company','businessGroup','department') AND extra.value<>'[]'::jsonb)
  WHERE e.tenant_id=app.current_tenant_id()),
 pbp AS MATERIALIZED(SELECT id FROM bp_matches WHERE score=top_score GROUP BY id HAVING count(DISTINCT user_id)=1 AND min(user_id)=app.current_user_id()::text),
 managed AS MATERIALIZED(SELECT * FROM app.contract_shared_tracker_managed_subjects()),
 rights AS MATERIALIZED(SELECT e.id,c.is_admin AS admin,c.named_view,c.named_decide,
  CASE WHEN managed.employment_id IS NOT NULL THEN managed.can_view ELSE false END AS superior_view,CASE WHEN managed.employment_id IS NOT NULL THEN managed.can_decide ELSE false END AS superior_decide,
  EXISTS(SELECT 1 FROM pbp WHERE id=e.id) AND e.person_id IS DISTINCT FROM u.person_id AND EXISTS(SELECT 1 FROM legacy_roles r WHERE r.company_id=c.company_id AND r.role='pbp' AND (r.business_unit_id IS NULL OR r.business_unit_id=a.business_unit_id)) AS bp
  FROM public.employment e JOIN companies c ON c.company_id=e.company_id CROSS JOIN actor u LEFT JOIN placement a ON a.employment_id=e.id
  LEFT JOIN managed ON managed.employment_id=e.id
  WHERE e.tenant_id=app.current_tenant_id() AND u.verified)
 SELECT id,admin OR named_view OR superior_view OR bp,admin OR named_decide OR superior_decide OR bp FROM rights
$new_bp$);
 EXECUTE definition;
END $bp_owner$;

--> statement-breakpoint
-- Exact current effective owner 6404_contract_intake_paged_read.sql; same OID, owner and existing ACL.
DO $bp_owner$
DECLARE definition text;source text;
BEGIN
 SELECT prosrc,pg_get_functiondef(oid) INTO source,definition FROM pg_proc WHERE oid='app.contract_admission_page(text,uuid,integer,integer)'::regprocedure;
 IF encode(sha256(convert_to(source,'UTF8')),'hex') IS DISTINCT FROM 'd6ebd34d783b49c1ad2b1e56b5a742aff2e6b2b9263416d36ef25ad2167b5824' THEN RAISE EXCEPTION 'Unexpected native contract_admission_page before Business Partner source replacement';END IF;
 IF position($old_bp$
BEGIN
 IF p_search IS NULL OR length(p_search)>100 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR p_offset IS NULL OR p_offset NOT BETWEEN 0 AND 100000 THEN RAISE EXCEPTION 'Invalid Contract intake page' USING ERRCODE='22023';END IF;
 RETURN (WITH RECURSIVE clock AS MATERIALIZED(SELECT (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date today),
 actor AS MATERIALIZED(SELECT u.id,u.person_id,app.contract_active_user(u.id) active,app.contract_verified_human(u.id) verified FROM public.app_user u WHERE u.tenant_id=app.current_tenant_id() AND u.id=app.current_user_id()),
 companies AS MATERIALIZED(SELECT c.* FROM public.company c JOIN public.tenant t ON t.id=c.tenant_id WHERE c.tenant_id=app.current_tenant_id() AND c.archived_at IS NULL AND t.status IN('active','trial') AND EXISTS(SELECT 1 FROM public.tenant_module m WHERE m.tenant_id=c.tenant_id AND m.module_code='lifecycle' AND m.status IN('active','trial') AND (m.expires_at IS NULL OR m.expires_at>now()) AND (m.company_id IS NULL OR m.company_id=c.id))),
 hierarchy AS(SELECT id child,id ancestor FROM public.company WHERE tenant_id=app.current_tenant_id() UNION SELECT h.child,c.parent_company_id FROM hierarchy h JOIN public.company c ON c.id=h.ancestor AND c.tenant_id=app.current_tenant_id() WHERE c.parent_company_id IS NOT NULL),
 hr AS MATERIALIZED(SELECT DISTINCT c.id FROM companies c JOIN public.role_assignment r ON r.tenant_id=c.tenant_id AND r.app_user_id=app.current_user_id() AND r.role::text IN('hr_admin','super_admin') WHERE r.company_id IS NULL OR EXISTS(SELECT 1 FROM hierarchy h WHERE h.child=c.id AND h.ancestor=r.company_id)),
 roles AS MATERIALIZED(SELECT r.* FROM public.contract_role_assignment r CROSS JOIN clock WHERE r.tenant_id=app.current_tenant_id() AND r.user_id=app.current_user_id() AND r.revoked_at IS NULL AND r.valid_from<=today AND (r.valid_to IS NULL OR r.valid_to>=today)),
 people_ops AS MATERIALIZED(SELECT 1 FROM public.lc_v9_config v JOIN public.lc_onboarding_config shared ON shared.tenant_id=v.tenant_id CROSS JOIN LATERAL jsonb_array_elements(coalesce(shared.data->'groups','[]'::jsonb)) g WHERE v.tenant_id=app.current_tenant_id() AND g->>'id'=v.data->>'peopleOpsGroup' AND g->'members' ? app.current_user_id()::text LIMIT 1),
 bp_rules AS MATERIALIZED(SELECT r->>'userId' user_id,coalesce(r->'rules','{}'::jsonb) rules,(CASE WHEN coalesce(jsonb_array_length(r->'rules'->'businessGroup'),0)>0 THEN 4 ELSE 0 END+CASE WHEN coalesce(jsonb_array_length(r->'rules'->'company'),0)>0 THEN 2 ELSE 0 END+CASE WHEN coalesce(jsonb_array_length(r->'rules'->'department'),0)>0 THEN 1 ELSE 0 END) score FROM public.lc_v9_config v CROSS JOIN LATERAL jsonb_array_elements(coalesce(v.data->'bpRules','[]'::jsonb)) r WHERE v.tenant_id=app.current_tenant_id()),
 company_flags AS MATERIALIZED(SELECT c.id,c.legal_name name,
  u.verified AND EXISTS(SELECT 1 FROM people_ops) AND EXISTS(SELECT 1 FROM roles r WHERE r.company_id=c.id AND r.role='gbs' AND r.business_unit_id IS NULL) gbs,
  u.verified AND EXISTS(SELECT 1 FROM people_ops) AND EXISTS(SELECT 1 FROM roles r WHERE r.company_id=c.id AND r.role='gbs') AS "canIntake",
  EXISTS(SELECT 1 FROM roles r JOIN bp_rules bp ON bp.user_id=r.user_id::text WHERE r.company_id=c.id AND r.role='pbp' AND (coalesce(jsonb_array_length(bp.rules->'company'),0)=0 OR bp.rules->'company' ? c.id::text) AND (r.business_unit_id IS NULL OR coalesce(jsonb_array_length(bp.rules->'businessGroup'),0)=0 OR bp.rules->'businessGroup' ? r.business_unit_id::text)) AS "canCapturePbp",
  EXISTS(SELECT 1 FROM hr WHERE id=c.id) hr FROM companies c CROSS JOIN actor u WHERE u.active),
 choices AS MATERIALIZED(SELECT id,name,hr OR gbs configure,gbs,"canCapturePbp" pbp,"canIntake","canCapturePbp" FROM company_flags WHERE "canIntake" OR "canCapturePbp"),
 placement AS MATERIALIZED(SELECT DISTINCT ON(a.employment_id) a.employment_id,a.business_unit_id,a.department_id FROM public.assignment a CROSS JOIN clock WHERE a.tenant_id=app.current_tenant_id() AND a.superseded_at IS NULL AND a.valid_from<=today AND (a.valid_to IS NULL OR a.valid_to>today) ORDER BY a.employment_id,a.valid_from DESC,a.id),
 candidates AS MATERIALIZED(SELECT e.*,p.full_name,a.business_unit_id,a.department_id,c.name company FROM public.employment e JOIN public.person p ON p.tenant_id=e.tenant_id AND p.id=e.person_id JOIN choices c ON c.id=e.company_id LEFT JOIN placement a ON a.employment_id=e.id CROSS JOIN clock WHERE e.tenant_id=app.current_tenant_id() AND e.voided_at IS NULL AND e.import_pending_attempt_id IS NULL AND e.blacklisted_at IS NULL AND EXISTS(SELECT 1 FROM public.assignment x WHERE x.tenant_id=e.tenant_id AND x.employment_id=e.id AND x.superseded_at IS NULL AND x.employment_type='contract' AND x.valid_from<=today AND (x.valid_to IS NULL OR x.valid_to>today))),
 bp_matches AS MATERIALIZED(SELECT e.id,r.user_id,r.score,max(r.score) OVER(PARTITION BY e.id) top_score FROM candidates e JOIN bp_rules r ON (coalesce(jsonb_array_length(r.rules->'company'),0)=0 OR r.rules->'company' ? e.company_id::text) AND (coalesce(jsonb_array_length(r.rules->'businessGroup'),0)=0 OR r.rules->'businessGroup' ? e.business_unit_id::text) AND (coalesce(jsonb_array_length(r.rules->'department'),0)=0 OR r.rules->'department' ? e.department_id::text) AND NOT EXISTS(SELECT 1 FROM jsonb_each(r.rules) extra WHERE extra.key NOT IN('company','businessGroup','department') AND extra.value<>'[]'::jsonb)),
 pbp AS MATERIALIZED(SELECT id FROM bp_matches WHERE score=top_score GROUP BY id HAVING count(DISTINCT user_id)=1 AND min(user_id)=app.current_user_id()::text),
 permitted AS MATERIALIZED(SELECT e.*,row_number() OVER(PARTITION BY e.company_id ORDER BY e.full_name,e.id) ordinal FROM candidates e CROSS JOIN actor u WHERE u.verified AND (
  EXISTS(SELECT 1 FROM people_ops) AND EXISTS(SELECT 1 FROM roles r WHERE r.company_id=e.company_id AND r.role='gbs' AND (r.business_unit_id IS NULL OR r.business_unit_id=e.business_unit_id))
  OR e.person_id IS DISTINCT FROM u.person_id AND EXISTS(SELECT 1 FROM pbp WHERE id=e.id) AND EXISTS(SELECT 1 FROM roles r WHERE r.company_id=e.company_id AND r.role='pbp' AND (r.business_unit_id IS NULL OR r.business_unit_id=e.business_unit_id)))),
 visible AS MATERIALIZED(SELECT * FROM permitted WHERE ordinal<=2000 AND (p_company IS NULL OR company_id=p_company) AND (p_search='' OR full_name ILIKE '%'||p_search||'%' OR employee_code ILIKE '%'||p_search||'%')),
 page AS MATERIALIZED(SELECT * FROM visible ORDER BY company,company_id,full_name,id LIMIT p_limit OFFSET p_offset)
 SELECT jsonb_build_object('companies',coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY name,id) FROM choices c),'[]'::jsonb),'total',(SELECT count(*) FROM visible),'limit',p_limit,'offset',p_offset,'rows',coalesce((SELECT jsonb_agg(jsonb_build_object('companyId',company_id,'id',id,'name',full_name,'employeeId',employee_code,'startOn',contract_start_date::text,'endOn',contract_end_date::text) ORDER BY company,company_id,full_name,id) FROM page),'[]'::jsonb)));
END $old_bp$ IN definition)=0 THEN RAISE EXCEPTION 'Native contract_admission_page declaration/source changed';END IF;
 definition:=replace(definition,$old_bp$
BEGIN
 IF p_search IS NULL OR length(p_search)>100 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR p_offset IS NULL OR p_offset NOT BETWEEN 0 AND 100000 THEN RAISE EXCEPTION 'Invalid Contract intake page' USING ERRCODE='22023';END IF;
 RETURN (WITH RECURSIVE clock AS MATERIALIZED(SELECT (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date today),
 actor AS MATERIALIZED(SELECT u.id,u.person_id,app.contract_active_user(u.id) active,app.contract_verified_human(u.id) verified FROM public.app_user u WHERE u.tenant_id=app.current_tenant_id() AND u.id=app.current_user_id()),
 companies AS MATERIALIZED(SELECT c.* FROM public.company c JOIN public.tenant t ON t.id=c.tenant_id WHERE c.tenant_id=app.current_tenant_id() AND c.archived_at IS NULL AND t.status IN('active','trial') AND EXISTS(SELECT 1 FROM public.tenant_module m WHERE m.tenant_id=c.tenant_id AND m.module_code='lifecycle' AND m.status IN('active','trial') AND (m.expires_at IS NULL OR m.expires_at>now()) AND (m.company_id IS NULL OR m.company_id=c.id))),
 hierarchy AS(SELECT id child,id ancestor FROM public.company WHERE tenant_id=app.current_tenant_id() UNION SELECT h.child,c.parent_company_id FROM hierarchy h JOIN public.company c ON c.id=h.ancestor AND c.tenant_id=app.current_tenant_id() WHERE c.parent_company_id IS NOT NULL),
 hr AS MATERIALIZED(SELECT DISTINCT c.id FROM companies c JOIN public.role_assignment r ON r.tenant_id=c.tenant_id AND r.app_user_id=app.current_user_id() AND r.role::text IN('hr_admin','super_admin') WHERE r.company_id IS NULL OR EXISTS(SELECT 1 FROM hierarchy h WHERE h.child=c.id AND h.ancestor=r.company_id)),
 roles AS MATERIALIZED(SELECT r.* FROM public.contract_role_assignment r CROSS JOIN clock WHERE r.tenant_id=app.current_tenant_id() AND r.user_id=app.current_user_id() AND r.revoked_at IS NULL AND r.valid_from<=today AND (r.valid_to IS NULL OR r.valid_to>=today)),
 people_ops AS MATERIALIZED(SELECT 1 FROM public.lc_v9_config v JOIN public.lc_onboarding_config shared ON shared.tenant_id=v.tenant_id CROSS JOIN LATERAL jsonb_array_elements(coalesce(shared.data->'groups','[]'::jsonb)) g WHERE v.tenant_id=app.current_tenant_id() AND g->>'id'=v.data->>'peopleOpsGroup' AND g->'members' ? app.current_user_id()::text LIMIT 1),
 bp_rules AS MATERIALIZED(SELECT r->>'userId' user_id,coalesce(r->'rules','{}'::jsonb) rules,(CASE WHEN coalesce(jsonb_array_length(r->'rules'->'businessGroup'),0)>0 THEN 4 ELSE 0 END+CASE WHEN coalesce(jsonb_array_length(r->'rules'->'company'),0)>0 THEN 2 ELSE 0 END+CASE WHEN coalesce(jsonb_array_length(r->'rules'->'department'),0)>0 THEN 1 ELSE 0 END) score FROM public.lc_v9_config v CROSS JOIN LATERAL jsonb_array_elements(coalesce(v.data->'bpRules','[]'::jsonb)) r WHERE v.tenant_id=app.current_tenant_id()),
 company_flags AS MATERIALIZED(SELECT c.id,c.legal_name name,
  u.verified AND EXISTS(SELECT 1 FROM people_ops) AND EXISTS(SELECT 1 FROM roles r WHERE r.company_id=c.id AND r.role='gbs' AND r.business_unit_id IS NULL) gbs,
  u.verified AND EXISTS(SELECT 1 FROM people_ops) AND EXISTS(SELECT 1 FROM roles r WHERE r.company_id=c.id AND r.role='gbs') AS "canIntake",
  EXISTS(SELECT 1 FROM roles r JOIN bp_rules bp ON bp.user_id=r.user_id::text WHERE r.company_id=c.id AND r.role='pbp' AND (coalesce(jsonb_array_length(bp.rules->'company'),0)=0 OR bp.rules->'company' ? c.id::text) AND (r.business_unit_id IS NULL OR coalesce(jsonb_array_length(bp.rules->'businessGroup'),0)=0 OR bp.rules->'businessGroup' ? r.business_unit_id::text)) AS "canCapturePbp",
  EXISTS(SELECT 1 FROM hr WHERE id=c.id) hr FROM companies c CROSS JOIN actor u WHERE u.active),
 choices AS MATERIALIZED(SELECT id,name,hr OR gbs configure,gbs,"canCapturePbp" pbp,"canIntake","canCapturePbp" FROM company_flags WHERE "canIntake" OR "canCapturePbp"),
 placement AS MATERIALIZED(SELECT DISTINCT ON(a.employment_id) a.employment_id,a.business_unit_id,a.department_id FROM public.assignment a CROSS JOIN clock WHERE a.tenant_id=app.current_tenant_id() AND a.superseded_at IS NULL AND a.valid_from<=today AND (a.valid_to IS NULL OR a.valid_to>today) ORDER BY a.employment_id,a.valid_from DESC,a.id),
 candidates AS MATERIALIZED(SELECT e.*,p.full_name,a.business_unit_id,a.department_id,c.name company FROM public.employment e JOIN public.person p ON p.tenant_id=e.tenant_id AND p.id=e.person_id JOIN choices c ON c.id=e.company_id LEFT JOIN placement a ON a.employment_id=e.id CROSS JOIN clock WHERE e.tenant_id=app.current_tenant_id() AND e.voided_at IS NULL AND e.import_pending_attempt_id IS NULL AND e.blacklisted_at IS NULL AND EXISTS(SELECT 1 FROM public.assignment x WHERE x.tenant_id=e.tenant_id AND x.employment_id=e.id AND x.superseded_at IS NULL AND x.employment_type='contract' AND x.valid_from<=today AND (x.valid_to IS NULL OR x.valid_to>today))),
 bp_matches AS MATERIALIZED(SELECT e.id,r.user_id,r.score,max(r.score) OVER(PARTITION BY e.id) top_score FROM candidates e JOIN bp_rules r ON (coalesce(jsonb_array_length(r.rules->'company'),0)=0 OR r.rules->'company' ? e.company_id::text) AND (coalesce(jsonb_array_length(r.rules->'businessGroup'),0)=0 OR r.rules->'businessGroup' ? e.business_unit_id::text) AND (coalesce(jsonb_array_length(r.rules->'department'),0)=0 OR r.rules->'department' ? e.department_id::text) AND NOT EXISTS(SELECT 1 FROM jsonb_each(r.rules) extra WHERE extra.key NOT IN('company','businessGroup','department') AND extra.value<>'[]'::jsonb)),
 pbp AS MATERIALIZED(SELECT id FROM bp_matches WHERE score=top_score GROUP BY id HAVING count(DISTINCT user_id)=1 AND min(user_id)=app.current_user_id()::text),
 permitted AS MATERIALIZED(SELECT e.*,row_number() OVER(PARTITION BY e.company_id ORDER BY e.full_name,e.id) ordinal FROM candidates e CROSS JOIN actor u WHERE u.verified AND (
  EXISTS(SELECT 1 FROM people_ops) AND EXISTS(SELECT 1 FROM roles r WHERE r.company_id=e.company_id AND r.role='gbs' AND (r.business_unit_id IS NULL OR r.business_unit_id=e.business_unit_id))
  OR e.person_id IS DISTINCT FROM u.person_id AND EXISTS(SELECT 1 FROM pbp WHERE id=e.id) AND EXISTS(SELECT 1 FROM roles r WHERE r.company_id=e.company_id AND r.role='pbp' AND (r.business_unit_id IS NULL OR r.business_unit_id=e.business_unit_id)))),
 visible AS MATERIALIZED(SELECT * FROM permitted WHERE ordinal<=2000 AND (p_company IS NULL OR company_id=p_company) AND (p_search='' OR full_name ILIKE '%'||p_search||'%' OR employee_code ILIKE '%'||p_search||'%')),
 page AS MATERIALIZED(SELECT * FROM visible ORDER BY company,company_id,full_name,id LIMIT p_limit OFFSET p_offset)
 SELECT jsonb_build_object('companies',coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY name,id) FROM choices c),'[]'::jsonb),'total',(SELECT count(*) FROM visible),'limit',p_limit,'offset',p_offset,'rows',coalesce((SELECT jsonb_agg(jsonb_build_object('companyId',company_id,'id',id,'name',full_name,'employeeId',employee_code,'startOn',contract_start_date::text,'endOn',contract_end_date::text) ORDER BY company,company_id,full_name,id) FROM page),'[]'::jsonb)));
END $old_bp$,$new_bp$
BEGIN
 IF p_search IS NULL OR length(p_search)>100 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR p_offset IS NULL OR p_offset NOT BETWEEN 0 AND 100000 THEN RAISE EXCEPTION 'Invalid Contract intake page' USING ERRCODE='22023';END IF;
 RETURN (WITH RECURSIVE clock AS MATERIALIZED(SELECT (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date today),
 actor AS MATERIALIZED(SELECT u.id,u.person_id,app.contract_active_user(u.id) active,app.contract_verified_human(u.id) verified FROM public.app_user u WHERE u.tenant_id=app.current_tenant_id() AND u.id=app.current_user_id()),
 companies AS MATERIALIZED(SELECT c.* FROM public.company c JOIN public.tenant t ON t.id=c.tenant_id WHERE c.tenant_id=app.current_tenant_id() AND c.archived_at IS NULL AND t.status IN('active','trial') AND EXISTS(SELECT 1 FROM public.tenant_module m WHERE m.tenant_id=c.tenant_id AND m.module_code='lifecycle' AND m.status IN('active','trial') AND (m.expires_at IS NULL OR m.expires_at>now()) AND (m.company_id IS NULL OR m.company_id=c.id))),
 hierarchy AS(SELECT id child,id ancestor FROM public.company WHERE tenant_id=app.current_tenant_id() UNION SELECT h.child,c.parent_company_id FROM hierarchy h JOIN public.company c ON c.id=h.ancestor AND c.tenant_id=app.current_tenant_id() WHERE c.parent_company_id IS NOT NULL),
 hr AS MATERIALIZED(SELECT DISTINCT c.id FROM companies c JOIN public.role_assignment r ON r.tenant_id=c.tenant_id AND r.app_user_id=app.current_user_id() AND r.role::text IN('hr_admin','super_admin') WHERE r.company_id IS NULL OR EXISTS(SELECT 1 FROM hierarchy h WHERE h.child=c.id AND h.ancestor=r.company_id)),
 roles AS MATERIALIZED(SELECT r.* FROM public.contract_role_assignment r CROSS JOIN clock WHERE r.tenant_id=app.current_tenant_id() AND r.user_id=app.current_user_id() AND r.revoked_at IS NULL AND r.valid_from<=today AND (r.valid_to IS NULL OR r.valid_to>=today)),
 people_ops AS MATERIALIZED(SELECT 1 FROM public.lc_v9_config v JOIN public.lc_onboarding_config shared ON shared.tenant_id=v.tenant_id CROSS JOIN LATERAL jsonb_array_elements(coalesce(shared.data->'groups','[]'::jsonb)) g WHERE v.tenant_id=app.current_tenant_id() AND g->>'id'=v.data->>'peopleOpsGroup' AND g->'members' ? app.current_user_id()::text LIMIT 1),
 bp_rules AS MATERIALIZED(SELECT r->>'userId' user_id,coalesce(r->'rules','{}'::jsonb) rules,(CASE WHEN coalesce(jsonb_array_length(r->'rules'->'businessGroup'),0)>0 THEN 4 ELSE 0 END+CASE WHEN coalesce(jsonb_array_length(r->'rules'->'company'),0)>0 THEN 2 ELSE 0 END+CASE WHEN coalesce(jsonb_array_length(r->'rules'->'department'),0)>0 THEN 1 ELSE 0 END) score FROM public.automation_business_partner_config v CROSS JOIN LATERAL jsonb_array_elements(coalesce(v.rules,'[]'::jsonb)) r WHERE v.tenant_id=app.current_tenant_id()),
 company_flags AS MATERIALIZED(SELECT c.id,c.legal_name name,
  u.verified AND EXISTS(SELECT 1 FROM people_ops) AND EXISTS(SELECT 1 FROM roles r WHERE r.company_id=c.id AND r.role='gbs' AND r.business_unit_id IS NULL) gbs,
  u.verified AND EXISTS(SELECT 1 FROM people_ops) AND EXISTS(SELECT 1 FROM roles r WHERE r.company_id=c.id AND r.role='gbs') AS "canIntake",
  EXISTS(SELECT 1 FROM roles r JOIN bp_rules bp ON bp.user_id=r.user_id::text WHERE r.company_id=c.id AND r.role='pbp' AND (coalesce(jsonb_array_length(bp.rules->'company'),0)=0 OR bp.rules->'company' ? c.id::text) AND (r.business_unit_id IS NULL OR coalesce(jsonb_array_length(bp.rules->'businessGroup'),0)=0 OR bp.rules->'businessGroup' ? r.business_unit_id::text)) AS "canCapturePbp",
  EXISTS(SELECT 1 FROM hr WHERE id=c.id) hr FROM companies c CROSS JOIN actor u WHERE u.active),
 choices AS MATERIALIZED(SELECT id,name,hr OR gbs configure,gbs,"canCapturePbp" pbp,"canIntake","canCapturePbp" FROM company_flags WHERE "canIntake" OR "canCapturePbp"),
 placement AS MATERIALIZED(SELECT DISTINCT ON(a.employment_id) a.employment_id,a.business_unit_id,a.department_id FROM public.assignment a CROSS JOIN clock WHERE a.tenant_id=app.current_tenant_id() AND a.superseded_at IS NULL AND a.valid_from<=today AND (a.valid_to IS NULL OR a.valid_to>today) ORDER BY a.employment_id,a.valid_from DESC,a.id),
 candidates AS MATERIALIZED(SELECT e.*,p.full_name,a.business_unit_id,a.department_id,c.name company FROM public.employment e JOIN public.person p ON p.tenant_id=e.tenant_id AND p.id=e.person_id JOIN choices c ON c.id=e.company_id LEFT JOIN placement a ON a.employment_id=e.id CROSS JOIN clock WHERE e.tenant_id=app.current_tenant_id() AND e.voided_at IS NULL AND e.import_pending_attempt_id IS NULL AND e.blacklisted_at IS NULL AND EXISTS(SELECT 1 FROM public.assignment x WHERE x.tenant_id=e.tenant_id AND x.employment_id=e.id AND x.superseded_at IS NULL AND x.employment_type='contract' AND x.valid_from<=today AND (x.valid_to IS NULL OR x.valid_to>today))),
 bp_matches AS MATERIALIZED(SELECT e.id,r.user_id,r.score,max(r.score) OVER(PARTITION BY e.id) top_score FROM candidates e JOIN bp_rules r ON (coalesce(jsonb_array_length(r.rules->'company'),0)=0 OR r.rules->'company' ? e.company_id::text) AND (coalesce(jsonb_array_length(r.rules->'businessGroup'),0)=0 OR r.rules->'businessGroup' ? e.business_unit_id::text) AND (coalesce(jsonb_array_length(r.rules->'department'),0)=0 OR r.rules->'department' ? e.department_id::text) AND NOT EXISTS(SELECT 1 FROM jsonb_each(r.rules) extra WHERE extra.key NOT IN('company','businessGroup','department') AND extra.value<>'[]'::jsonb)),
 pbp AS MATERIALIZED(SELECT id FROM bp_matches WHERE score=top_score GROUP BY id HAVING count(DISTINCT user_id)=1 AND min(user_id)=app.current_user_id()::text),
 permitted AS MATERIALIZED(SELECT e.*,row_number() OVER(PARTITION BY e.company_id ORDER BY e.full_name,e.id) ordinal FROM candidates e CROSS JOIN actor u WHERE u.verified AND (
  EXISTS(SELECT 1 FROM people_ops) AND EXISTS(SELECT 1 FROM roles r WHERE r.company_id=e.company_id AND r.role='gbs' AND (r.business_unit_id IS NULL OR r.business_unit_id=e.business_unit_id))
  OR e.person_id IS DISTINCT FROM u.person_id AND EXISTS(SELECT 1 FROM pbp WHERE id=e.id) AND EXISTS(SELECT 1 FROM roles r WHERE r.company_id=e.company_id AND r.role='pbp' AND (r.business_unit_id IS NULL OR r.business_unit_id=e.business_unit_id)))),
 visible AS MATERIALIZED(SELECT * FROM permitted WHERE ordinal<=2000 AND (p_company IS NULL OR company_id=p_company) AND (p_search='' OR full_name ILIKE '%'||p_search||'%' OR employee_code ILIKE '%'||p_search||'%')),
 page AS MATERIALIZED(SELECT * FROM visible ORDER BY company,company_id,full_name,id LIMIT p_limit OFFSET p_offset)
 SELECT jsonb_build_object('companies',coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY name,id) FROM choices c),'[]'::jsonb),'total',(SELECT count(*) FROM visible),'limit',p_limit,'offset',p_offset,'rows',coalesce((SELECT jsonb_agg(jsonb_build_object('companyId',company_id,'id',id,'name',full_name,'employeeId',employee_code,'startOn',contract_start_date::text,'endOn',contract_end_date::text) ORDER BY company,company_id,full_name,id) FROM page),'[]'::jsonb)));
END $new_bp$);
 EXECUTE definition;
END $bp_owner$;

--> statement-breakpoint
-- Exact current effective owner 5764_probation_routed_holders.sql; same OID, owner and existing ACL.
DO $bp_owner$
DECLARE definition text;source text;
BEGIN
 SELECT prosrc,pg_get_functiondef(oid) INTO source,definition FROM pg_proc WHERE oid='app.probation_routed_holders(uuid[])'::regprocedure;
 IF encode(sha256(convert_to(source,'UTF8')),'hex') IS DISTINCT FROM '969847bb69e9cbd779f87050d365e89225d7592c75475bf3f4927bf9382c767b' THEN RAISE EXCEPTION 'Unexpected native probation_routed_holders before Business Partner source replacement';END IF;
 IF position($old_bp$
#variable_conflict use_column
DECLARE t uuid:=app.current_tenant_id();day date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;rules_ok boolean:=true;v9 jsonb;bp_rows jsonb;hod_rows jsonb;bp_retired boolean;hod_retired boolean;
BEGIN
 IF t IS NULL OR coalesce(cardinality(p_employments),0)=0 THEN RETURN;END IF;
 SELECT v.data INTO v9 FROM public.lc_v9_config v WHERE v.tenant_id=t LIMIT 1;
 SELECT v.routing_rows,v.retired INTO bp_rows,bp_retired FROM public.automation_routing_version v WHERE v.tenant_id=t AND v.routing_id='a0700000-0000-4000-8000-000000001001'::uuid ORDER BY v.revision DESC LIMIT 1;
 SELECT v.routing_rows,v.retired INTO hod_rows,hod_retired FROM public.automation_routing_version v WHERE v.tenant_id=t AND v.routing_id='a0700000-0000-4000-8000-000000001002'::uuid ORDER BY v.revision DESC LIMIT 1;
 -- A routing answers once it has rows and is not retired; until then its adapter does.
 IF bp_retired IS NOT FALSE OR jsonb_typeof(bp_rows) IS DISTINCT FROM 'array' THEN bp_rows:=NULL;ELSIF jsonb_array_length(bp_rows)=0 THEN bp_rows:=NULL;END IF;
 IF hod_retired IS NOT FALSE OR jsonb_typeof(hod_rows) IS DISTINCT FROM 'array' THEN hod_rows:=NULL;ELSIF jsonb_array_length(hod_rows)=0 THEN hod_rows:=NULL;END IF;
 IF bp_rows IS NULL THEN
  IF jsonb_typeof(v9->'bpRules') IS NOT NULL AND jsonb_typeof(v9->'bpRules')<>'array' THEN rules_ok:=false;END IF;
  IF rules_ok THEN
   SELECT coalesce(bool_and((r->'rules' IS NULL OR jsonb_typeof(r->'rules')='object')
    AND (r->'rules'->'company' IS NULL OR jsonb_typeof(r->'rules'->'company')='array')
    AND (r->'rules'->'businessGroup' IS NULL OR jsonb_typeof(r->'rules'->'businessGroup')='array')
    AND (r->'rules'->'department' IS NULL OR jsonb_typeof(r->'rules'->'department')='array')),true) INTO rules_ok
   FROM jsonb_array_elements(coalesce(v9->'bpRules','[]'::jsonb)) r;
  END IF;
 END IF;
 RETURN QUERY
 WITH emp AS MATERIALIZED (
  SELECT e.id,e.person_id,e.company_id,x.department_id,x.business_unit_id,x.title,coalesce(co.parent_company_id,co.id) AS group_company,
   (SELECT r.manager_employment_id FROM public.reporting_line r WHERE r.tenant_id=t AND r.subordinate_employment_id=e.id AND r.line_type='administrative'
     AND r.valid_from<=current_date AND (r.valid_to IS NULL OR r.valid_to>current_date) AND r.superseded_at IS NULL LIMIT 1) AS manager_id,
   (SELECT d.head_employment_id FROM public.department d WHERE d.id=x.department_id AND d.tenant_id=e.tenant_id) AS head_id
  FROM public.employment e
  LEFT JOIN public.company co ON co.id=e.company_id AND co.tenant_id=e.tenant_id
  LEFT JOIN LATERAL (SELECT a.department_id,a.business_unit_id,btrim(pos.title) AS title FROM public.assignment a
   LEFT JOIN public.position pos ON pos.id=a.position_id AND pos.tenant_id=a.tenant_id
   WHERE a.employment_id=e.id AND a.tenant_id=e.tenant_id AND a.superseded_at IS NULL
   AND a.valid_from<=day AND (a.valid_to IS NULL OR a.valid_to>day) ORDER BY a.valid_from DESC,a.id LIMIT 1) x ON true
  WHERE e.tenant_id=t AND e.id=ANY(p_employments)),
 linked AS MATERIALIZED (
  SELECT l.id,l.person_id FROM public.employment l
  WHERE l.tenant_id=t AND l.id=ANY(ARRAY(SELECT emp.id FROM emp UNION SELECT emp.manager_id FROM emp WHERE emp.manager_id IS NOT NULL UNION SELECT emp.head_id FROM emp WHERE emp.head_id IS NOT NULL))),
 -- A holder is the person's only usable login: person -> login, or JSON null when the person has more than one.
 logins AS MATERIALIZED (
  SELECT coalesce(jsonb_object_agg(x.person_id::text,x.user_id),'{}'::jsonb) AS m FROM (
   SELECT u.person_id,CASE WHEN count(*)=1 THEN (array_agg(u.id))[1] END AS user_id FROM public.app_user u
   WHERE u.tenant_id=t AND u.person_id=ANY(ARRAY(SELECT DISTINCT linked.person_id FROM linked WHERE linked.person_id IS NOT NULL)) AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
   GROUP BY u.person_id) x),
 user_for AS MATERIALIZED (
  SELECT coalesce(jsonb_object_agg(linked.id::text,logins.m->(linked.person_id::text)) FILTER(WHERE logins.m ? linked.person_id::text),'{}'::jsonb) AS m
  FROM linked CROSS JOIN logins),
 -- The V9 bpRules adapter, exactly as 5750 resolved the PBP (only while the BP routing has no rows).
 rules AS MATERIALIZED (SELECT r.value AS r FROM jsonb_array_elements(CASE WHEN bp_rows IS NULL AND rules_ok THEN coalesce(v9->'bpRules','[]'::jsonb) ELSE '[]'::jsonb END) r),
 bp AS MATERIALIZED (
  SELECT emp.id,emp.company_id,emp.department_id,emp.business_unit_id,rules.r->>'userId' AS user_id,
   (CASE WHEN coalesce(jsonb_array_length(rules.r->'rules'->'businessGroup'),0)>0 THEN 4 ELSE 0 END+CASE WHEN coalesce(jsonb_array_length(rules.r->'rules'->'company'),0)>0 THEN 2 ELSE 0 END+CASE WHEN coalesce(jsonb_array_length(rules.r->'rules'->'department'),0)>0 THEN 1 ELSE 0 END) AS score
  FROM emp CROSS JOIN rules
  WHERE (coalesce(jsonb_array_length(rules.r->'rules'->'company'),0)=0 OR rules.r->'rules'->'company' ? emp.company_id::text)
   AND (coalesce(jsonb_array_length(rules.r->'rules'->'businessGroup'),0)=0 OR rules.r->'rules'->'businessGroup' ? emp.business_unit_id::text)
   AND (coalesce(jsonb_array_length(rules.r->'rules'->'department'),0)=0 OR rules.r->'rules'->'department' ? emp.department_id::text)
   AND NOT EXISTS(SELECT 1 FROM jsonb_each(coalesce(rules.r->'rules','{}'::jsonb)) extra WHERE extra.key NOT IN('company','businessGroup','department') AND extra.value<>'[]'::jsonb)),
 bp_pick AS MATERIALIZED (
  SELECT ranked.id,ranked.company_id,ranked.department_id,ranked.business_unit_id,min(ranked.user_id) AS user_id
  FROM (SELECT bp.*,max(bp.score) OVER(PARTITION BY bp.id) AS top FROM bp) ranked WHERE ranked.score=ranked.top
  GROUP BY ranked.id,ranked.company_id,ranked.department_id,ranked.business_unit_id HAVING count(DISTINCT coalesce(ranked.user_id,chr(1)))=1),
 bp_user AS MATERIALIZED (
  SELECT bp_pick.id,bp_pick.company_id,bp_pick.department_id,bp_pick.business_unit_id,u.id AS user_id FROM bp_pick
  JOIN public.app_user u ON u.id=CASE WHEN bp_pick.user_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN bp_pick.user_id::uuid END
   AND u.tenant_id=t AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
  JOIN public.person n ON n.id=u.person_id AND n.tenant_id=u.tenant_id AND length(btrim(n.full_name))>0),
 pbp_maps AS MATERIALIZED (SELECT m.* FROM public.probation_access m WHERE m.tenant_id=t AND m.role='pbp' AND m.user_id=ANY(ARRAY(SELECT DISTINCT bp_user.user_id FROM bp_user)) AND m.valid_from<=day AND (m.valid_to IS NULL OR m.valid_to>=day)),
 anc AS MATERIALIZED (SELECT * FROM app.probation_company_ancestors(ARRAY(SELECT DISTINCT bp_user.company_id FROM bp_user))),
 adapter_pbp AS MATERIALIZED (
  SELECT bp_user.id,bp_user.user_id FROM bp_user
  WHERE EXISTS(SELECT 1 FROM pbp_maps m JOIN anc ON anc.ancestor_id=m.company_id
   WHERE anc.company_id=bp_user.company_id AND m.user_id=bp_user.user_id AND (m.department_id IS NULL OR m.department_id=bp_user.department_id) AND (m.business_unit_id IS NULL OR m.business_unit_id=bp_user.business_unit_id))),
 -- The shared routing rule for the routings that have rows: one winning row per employee and routing.
rrows AS MATERIALIZED (
  SELECT 'pbp'::text AS kind,r.value AS rrow,r.ord FROM jsonb_array_elements(coalesce(bp_rows,'[]'::jsonb)) WITH ORDINALITY r(value,ord)
  UNION ALL SELECT 'hod',r.value,r.ord FROM jsonb_array_elements(coalesce(hod_rows,'[]'::jsonb)) WITH ORDINALITY r(value,ord)),
 scored AS MATERIALIZED (
  SELECT emp.id,rrows.kind,rrows.rrow,rrows.ord,
   app.probation_routing_weight(rrows.rrow->'match'->'businessGroup',8)+app.probation_routing_weight(rrows.rrow->'match'->'company',4)
    +app.probation_routing_weight(rrows.rrow->'match'->'department',2)+app.probation_routing_weight(rrows.rrow->'match'->'jobTitle',1) AS score
  FROM emp CROSS JOIN rrows
  WHERE app.probation_routing_dimension(rrows.rrow->'match'->'businessGroup',ARRAY[emp.business_unit_id::text,emp.group_company::text])
   AND app.probation_routing_dimension(rrows.rrow->'match'->'company',ARRAY[emp.company_id::text])
   AND app.probation_routing_dimension(rrows.rrow->'match'->'department',ARRAY[emp.department_id::text])
   AND app.probation_routing_dimension(rrows.rrow->'match'->'jobTitle',ARRAY[coalesce(emp.title,'')])),
 winner AS MATERIALIZED (SELECT DISTINCT ON (scored.id,scored.kind) scored.id,scored.kind,scored.rrow FROM scored ORDER BY scored.id,scored.kind,scored.score DESC,scored.ord),
 groups AS MATERIALIZED (
  SELECT g->>'id' AS id,coalesce((SELECT array_agg(u.id ORDER BY m.n) FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(g->'members')='array' THEN g->'members' ELSE '[]'::jsonb END) WITH ORDINALITY m(id,n)
    JOIN public.app_user u ON u.id::text=m.id AND u.tenant_id=t AND u.person_id IS NOT NULL AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) WHERE m.n<=500),'{}'::uuid[]) AS members
  FROM jsonb_array_elements(CASE WHEN (bp_rows IS NOT NULL OR hod_rows IS NOT NULL) AND jsonb_typeof(v9->'groups')='array' THEN v9->'groups' ELSE '[]'::jsonb END) g),
 chosen AS MATERIALIZED (
  SELECT winner.id,winner.kind,CASE WHEN winner.rrow->'assignTo'->>'kind'='group' THEN winner.rrow->'assignTo'->>'groupId' END AS group_id,
   CASE WHEN winner.rrow->'assignTo'->>'kind'='group' THEN coalesce((SELECT groups.members FROM groups WHERE groups.id=winner.rrow->'assignTo'->>'groupId' LIMIT 1),'{}'::uuid[])
    ELSE coalesce((SELECT array_agg(u.id ORDER BY p.n) FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(winner.rrow->'assignTo'->'userIds')='array' THEN winner.rrow->'assignTo'->'userIds' ELSE '[]'::jsonb END) WITH ORDINALITY p(id,n)
     JOIN public.app_user u ON u.id::text=p.id AND u.tenant_id=t AND u.person_id IS NOT NULL AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) WHERE p.n<=50),'{}'::uuid[]) END AS users
  FROM winner),
 -- The fallback group for an employee no row matches (or whose row reaches nobody active), per company.
 fallback AS MATERIALIZED (
  SELECT co.company_id,coalesce(nullif((SELECT s.data->>'fallbackGroupId' FROM public.probation_configuration s WHERE s.tenant_id=t AND s.company_id=co.company_id AND s.kind='settings' AND s.state='published' ORDER BY s.version DESC LIMIT 1),''),nullif(v9->>'peopleOpsGroup','')) AS group_id
  FROM (SELECT DISTINCT emp.company_id FROM emp WHERE bp_rows IS NOT NULL OR hod_rows IS NOT NULL) co),
 fallback_members AS MATERIALIZED (
  SELECT fallback.company_id,fallback.group_id,coalesce((SELECT groups.members FROM groups WHERE groups.id=fallback.group_id LIMIT 1),'{}'::uuid[]) AS users FROM fallback),
 resolved AS MATERIALIZED (
  SELECT emp.id,k.kind,
   CASE WHEN chosen.id IS NOT NULL AND cardinality(chosen.users)>0 THEN chosen.group_id ELSE fm.group_id END AS group_id,
   CASE WHEN chosen.id IS NOT NULL AND cardinality(chosen.users)>0 THEN chosen.users ELSE coalesce(fm.users,'{}'::uuid[]) END AS users,
   CASE WHEN chosen.id IS NOT NULL AND cardinality(chosen.users)>0 THEN 'routing' ELSE 'fallback' END AS source
  FROM emp CROSS JOIN (SELECT 'pbp'::text AS kind WHERE bp_rows IS NOT NULL UNION ALL SELECT 'hod' WHERE hod_rows IS NOT NULL) k
  LEFT JOIN chosen ON chosen.id=emp.id AND chosen.kind=k.kind
  LEFT JOIN fallback_members fm ON fm.company_id=emp.company_id)
 SELECT emp.id,emp.company_id,emp.department_id,emp.business_unit_id,
  (user_for.m->>(emp.id::text))::uuid,(user_for.m->>(emp.manager_id::text))::uuid,
  -- Head of Department
  CASE WHEN hod_rows IS NULL THEN (user_for.m->>(emp.head_id::text))::uuid WHEN rh.group_id IS NULL AND cardinality(rh.users)=1 THEN rh.users[1] END,
  CASE WHEN hod_rows IS NULL THEN array_remove(ARRAY[(user_for.m->>(emp.head_id::text))::uuid],NULL) ELSE coalesce(rh.users,'{}'::uuid[]) END,
  CASE WHEN hod_rows IS NULL THEN NULL ELSE rh.group_id END,
  CASE WHEN hod_rows IS NULL THEN 'department' ELSE rh.source END,
  -- People Business Partner
  CASE WHEN bp_rows IS NULL THEN ap.user_id WHEN rp.group_id IS NULL AND rp.source='routing' AND cardinality(rp.users)=1 THEN rp.users[1] END,
  CASE WHEN bp_rows IS NULL THEN array_remove(ARRAY[ap.user_id],NULL) ELSE coalesce(rp.users,'{}'::uuid[]) END,
  CASE WHEN bp_rows IS NULL THEN NULL ELSE rp.group_id END,
  CASE WHEN bp_rows IS NULL THEN 'bpRules' ELSE rp.source END
 FROM emp CROSS JOIN user_for
 LEFT JOIN adapter_pbp ap ON ap.id=emp.id
 LEFT JOIN resolved rp ON rp.id=emp.id AND rp.kind='pbp'
 LEFT JOIN resolved rh ON rh.id=emp.id AND rh.kind='hod';
END $old_bp$ IN definition)=0 THEN RAISE EXCEPTION 'Native probation_routed_holders declaration/source changed';END IF;
 definition:=replace(definition,$old_bp$
#variable_conflict use_column
DECLARE t uuid:=app.current_tenant_id();day date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;rules_ok boolean:=true;v9 jsonb;bp_rows jsonb;hod_rows jsonb;bp_retired boolean;hod_retired boolean;
BEGIN
 IF t IS NULL OR coalesce(cardinality(p_employments),0)=0 THEN RETURN;END IF;
 SELECT v.data INTO v9 FROM public.lc_v9_config v WHERE v.tenant_id=t LIMIT 1;
 SELECT v.routing_rows,v.retired INTO bp_rows,bp_retired FROM public.automation_routing_version v WHERE v.tenant_id=t AND v.routing_id='a0700000-0000-4000-8000-000000001001'::uuid ORDER BY v.revision DESC LIMIT 1;
 SELECT v.routing_rows,v.retired INTO hod_rows,hod_retired FROM public.automation_routing_version v WHERE v.tenant_id=t AND v.routing_id='a0700000-0000-4000-8000-000000001002'::uuid ORDER BY v.revision DESC LIMIT 1;
 -- A routing answers once it has rows and is not retired; until then its adapter does.
 IF bp_retired IS NOT FALSE OR jsonb_typeof(bp_rows) IS DISTINCT FROM 'array' THEN bp_rows:=NULL;ELSIF jsonb_array_length(bp_rows)=0 THEN bp_rows:=NULL;END IF;
 IF hod_retired IS NOT FALSE OR jsonb_typeof(hod_rows) IS DISTINCT FROM 'array' THEN hod_rows:=NULL;ELSIF jsonb_array_length(hod_rows)=0 THEN hod_rows:=NULL;END IF;
 IF bp_rows IS NULL THEN
  IF jsonb_typeof(v9->'bpRules') IS NOT NULL AND jsonb_typeof(v9->'bpRules')<>'array' THEN rules_ok:=false;END IF;
  IF rules_ok THEN
   SELECT coalesce(bool_and((r->'rules' IS NULL OR jsonb_typeof(r->'rules')='object')
    AND (r->'rules'->'company' IS NULL OR jsonb_typeof(r->'rules'->'company')='array')
    AND (r->'rules'->'businessGroup' IS NULL OR jsonb_typeof(r->'rules'->'businessGroup')='array')
    AND (r->'rules'->'department' IS NULL OR jsonb_typeof(r->'rules'->'department')='array')),true) INTO rules_ok
   FROM jsonb_array_elements(coalesce(v9->'bpRules','[]'::jsonb)) r;
  END IF;
 END IF;
 RETURN QUERY
 WITH emp AS MATERIALIZED (
  SELECT e.id,e.person_id,e.company_id,x.department_id,x.business_unit_id,x.title,coalesce(co.parent_company_id,co.id) AS group_company,
   (SELECT r.manager_employment_id FROM public.reporting_line r WHERE r.tenant_id=t AND r.subordinate_employment_id=e.id AND r.line_type='administrative'
     AND r.valid_from<=current_date AND (r.valid_to IS NULL OR r.valid_to>current_date) AND r.superseded_at IS NULL LIMIT 1) AS manager_id,
   (SELECT d.head_employment_id FROM public.department d WHERE d.id=x.department_id AND d.tenant_id=e.tenant_id) AS head_id
  FROM public.employment e
  LEFT JOIN public.company co ON co.id=e.company_id AND co.tenant_id=e.tenant_id
  LEFT JOIN LATERAL (SELECT a.department_id,a.business_unit_id,btrim(pos.title) AS title FROM public.assignment a
   LEFT JOIN public.position pos ON pos.id=a.position_id AND pos.tenant_id=a.tenant_id
   WHERE a.employment_id=e.id AND a.tenant_id=e.tenant_id AND a.superseded_at IS NULL
   AND a.valid_from<=day AND (a.valid_to IS NULL OR a.valid_to>day) ORDER BY a.valid_from DESC,a.id LIMIT 1) x ON true
  WHERE e.tenant_id=t AND e.id=ANY(p_employments)),
 linked AS MATERIALIZED (
  SELECT l.id,l.person_id FROM public.employment l
  WHERE l.tenant_id=t AND l.id=ANY(ARRAY(SELECT emp.id FROM emp UNION SELECT emp.manager_id FROM emp WHERE emp.manager_id IS NOT NULL UNION SELECT emp.head_id FROM emp WHERE emp.head_id IS NOT NULL))),
 -- A holder is the person's only usable login: person -> login, or JSON null when the person has more than one.
 logins AS MATERIALIZED (
  SELECT coalesce(jsonb_object_agg(x.person_id::text,x.user_id),'{}'::jsonb) AS m FROM (
   SELECT u.person_id,CASE WHEN count(*)=1 THEN (array_agg(u.id))[1] END AS user_id FROM public.app_user u
   WHERE u.tenant_id=t AND u.person_id=ANY(ARRAY(SELECT DISTINCT linked.person_id FROM linked WHERE linked.person_id IS NOT NULL)) AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
   GROUP BY u.person_id) x),
 user_for AS MATERIALIZED (
  SELECT coalesce(jsonb_object_agg(linked.id::text,logins.m->(linked.person_id::text)) FILTER(WHERE logins.m ? linked.person_id::text),'{}'::jsonb) AS m
  FROM linked CROSS JOIN logins),
 -- The V9 bpRules adapter, exactly as 5750 resolved the PBP (only while the BP routing has no rows).
 rules AS MATERIALIZED (SELECT r.value AS r FROM jsonb_array_elements(CASE WHEN bp_rows IS NULL AND rules_ok THEN coalesce(v9->'bpRules','[]'::jsonb) ELSE '[]'::jsonb END) r),
 bp AS MATERIALIZED (
  SELECT emp.id,emp.company_id,emp.department_id,emp.business_unit_id,rules.r->>'userId' AS user_id,
   (CASE WHEN coalesce(jsonb_array_length(rules.r->'rules'->'businessGroup'),0)>0 THEN 4 ELSE 0 END+CASE WHEN coalesce(jsonb_array_length(rules.r->'rules'->'company'),0)>0 THEN 2 ELSE 0 END+CASE WHEN coalesce(jsonb_array_length(rules.r->'rules'->'department'),0)>0 THEN 1 ELSE 0 END) AS score
  FROM emp CROSS JOIN rules
  WHERE (coalesce(jsonb_array_length(rules.r->'rules'->'company'),0)=0 OR rules.r->'rules'->'company' ? emp.company_id::text)
   AND (coalesce(jsonb_array_length(rules.r->'rules'->'businessGroup'),0)=0 OR rules.r->'rules'->'businessGroup' ? emp.business_unit_id::text)
   AND (coalesce(jsonb_array_length(rules.r->'rules'->'department'),0)=0 OR rules.r->'rules'->'department' ? emp.department_id::text)
   AND NOT EXISTS(SELECT 1 FROM jsonb_each(coalesce(rules.r->'rules','{}'::jsonb)) extra WHERE extra.key NOT IN('company','businessGroup','department') AND extra.value<>'[]'::jsonb)),
 bp_pick AS MATERIALIZED (
  SELECT ranked.id,ranked.company_id,ranked.department_id,ranked.business_unit_id,min(ranked.user_id) AS user_id
  FROM (SELECT bp.*,max(bp.score) OVER(PARTITION BY bp.id) AS top FROM bp) ranked WHERE ranked.score=ranked.top
  GROUP BY ranked.id,ranked.company_id,ranked.department_id,ranked.business_unit_id HAVING count(DISTINCT coalesce(ranked.user_id,chr(1)))=1),
 bp_user AS MATERIALIZED (
  SELECT bp_pick.id,bp_pick.company_id,bp_pick.department_id,bp_pick.business_unit_id,u.id AS user_id FROM bp_pick
  JOIN public.app_user u ON u.id=CASE WHEN bp_pick.user_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN bp_pick.user_id::uuid END
   AND u.tenant_id=t AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
  JOIN public.person n ON n.id=u.person_id AND n.tenant_id=u.tenant_id AND length(btrim(n.full_name))>0),
 pbp_maps AS MATERIALIZED (SELECT m.* FROM public.probation_access m WHERE m.tenant_id=t AND m.role='pbp' AND m.user_id=ANY(ARRAY(SELECT DISTINCT bp_user.user_id FROM bp_user)) AND m.valid_from<=day AND (m.valid_to IS NULL OR m.valid_to>=day)),
 anc AS MATERIALIZED (SELECT * FROM app.probation_company_ancestors(ARRAY(SELECT DISTINCT bp_user.company_id FROM bp_user))),
 adapter_pbp AS MATERIALIZED (
  SELECT bp_user.id,bp_user.user_id FROM bp_user
  WHERE EXISTS(SELECT 1 FROM pbp_maps m JOIN anc ON anc.ancestor_id=m.company_id
   WHERE anc.company_id=bp_user.company_id AND m.user_id=bp_user.user_id AND (m.department_id IS NULL OR m.department_id=bp_user.department_id) AND (m.business_unit_id IS NULL OR m.business_unit_id=bp_user.business_unit_id))),
 -- The shared routing rule for the routings that have rows: one winning row per employee and routing.
rrows AS MATERIALIZED (
  SELECT 'pbp'::text AS kind,r.value AS rrow,r.ord FROM jsonb_array_elements(coalesce(bp_rows,'[]'::jsonb)) WITH ORDINALITY r(value,ord)
  UNION ALL SELECT 'hod',r.value,r.ord FROM jsonb_array_elements(coalesce(hod_rows,'[]'::jsonb)) WITH ORDINALITY r(value,ord)),
 scored AS MATERIALIZED (
  SELECT emp.id,rrows.kind,rrows.rrow,rrows.ord,
   app.probation_routing_weight(rrows.rrow->'match'->'businessGroup',8)+app.probation_routing_weight(rrows.rrow->'match'->'company',4)
    +app.probation_routing_weight(rrows.rrow->'match'->'department',2)+app.probation_routing_weight(rrows.rrow->'match'->'jobTitle',1) AS score
  FROM emp CROSS JOIN rrows
  WHERE app.probation_routing_dimension(rrows.rrow->'match'->'businessGroup',ARRAY[emp.business_unit_id::text,emp.group_company::text])
   AND app.probation_routing_dimension(rrows.rrow->'match'->'company',ARRAY[emp.company_id::text])
   AND app.probation_routing_dimension(rrows.rrow->'match'->'department',ARRAY[emp.department_id::text])
   AND app.probation_routing_dimension(rrows.rrow->'match'->'jobTitle',ARRAY[coalesce(emp.title,'')])),
 winner AS MATERIALIZED (SELECT DISTINCT ON (scored.id,scored.kind) scored.id,scored.kind,scored.rrow FROM scored ORDER BY scored.id,scored.kind,scored.score DESC,scored.ord),
 groups AS MATERIALIZED (
  SELECT g->>'id' AS id,coalesce((SELECT array_agg(u.id ORDER BY m.n) FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(g->'members')='array' THEN g->'members' ELSE '[]'::jsonb END) WITH ORDINALITY m(id,n)
    JOIN public.app_user u ON u.id::text=m.id AND u.tenant_id=t AND u.person_id IS NOT NULL AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) WHERE m.n<=500),'{}'::uuid[]) AS members
  FROM jsonb_array_elements(CASE WHEN (bp_rows IS NOT NULL OR hod_rows IS NOT NULL) AND jsonb_typeof(v9->'groups')='array' THEN v9->'groups' ELSE '[]'::jsonb END) g),
 chosen AS MATERIALIZED (
  SELECT winner.id,winner.kind,CASE WHEN winner.rrow->'assignTo'->>'kind'='group' THEN winner.rrow->'assignTo'->>'groupId' END AS group_id,
   CASE WHEN winner.rrow->'assignTo'->>'kind'='group' THEN coalesce((SELECT groups.members FROM groups WHERE groups.id=winner.rrow->'assignTo'->>'groupId' LIMIT 1),'{}'::uuid[])
    ELSE coalesce((SELECT array_agg(u.id ORDER BY p.n) FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(winner.rrow->'assignTo'->'userIds')='array' THEN winner.rrow->'assignTo'->'userIds' ELSE '[]'::jsonb END) WITH ORDINALITY p(id,n)
     JOIN public.app_user u ON u.id::text=p.id AND u.tenant_id=t AND u.person_id IS NOT NULL AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) WHERE p.n<=50),'{}'::uuid[]) END AS users
  FROM winner),
 -- The fallback group for an employee no row matches (or whose row reaches nobody active), per company.
 fallback AS MATERIALIZED (
  SELECT co.company_id,coalesce(nullif((SELECT s.data->>'fallbackGroupId' FROM public.probation_configuration s WHERE s.tenant_id=t AND s.company_id=co.company_id AND s.kind='settings' AND s.state='published' ORDER BY s.version DESC LIMIT 1),''),nullif(v9->>'peopleOpsGroup','')) AS group_id
  FROM (SELECT DISTINCT emp.company_id FROM emp WHERE bp_rows IS NOT NULL OR hod_rows IS NOT NULL) co),
 fallback_members AS MATERIALIZED (
  SELECT fallback.company_id,fallback.group_id,coalesce((SELECT groups.members FROM groups WHERE groups.id=fallback.group_id LIMIT 1),'{}'::uuid[]) AS users FROM fallback),
 resolved AS MATERIALIZED (
  SELECT emp.id,k.kind,
   CASE WHEN chosen.id IS NOT NULL AND cardinality(chosen.users)>0 THEN chosen.group_id ELSE fm.group_id END AS group_id,
   CASE WHEN chosen.id IS NOT NULL AND cardinality(chosen.users)>0 THEN chosen.users ELSE coalesce(fm.users,'{}'::uuid[]) END AS users,
   CASE WHEN chosen.id IS NOT NULL AND cardinality(chosen.users)>0 THEN 'routing' ELSE 'fallback' END AS source
  FROM emp CROSS JOIN (SELECT 'pbp'::text AS kind WHERE bp_rows IS NOT NULL UNION ALL SELECT 'hod' WHERE hod_rows IS NOT NULL) k
  LEFT JOIN chosen ON chosen.id=emp.id AND chosen.kind=k.kind
  LEFT JOIN fallback_members fm ON fm.company_id=emp.company_id)
 SELECT emp.id,emp.company_id,emp.department_id,emp.business_unit_id,
  (user_for.m->>(emp.id::text))::uuid,(user_for.m->>(emp.manager_id::text))::uuid,
  -- Head of Department
  CASE WHEN hod_rows IS NULL THEN (user_for.m->>(emp.head_id::text))::uuid WHEN rh.group_id IS NULL AND cardinality(rh.users)=1 THEN rh.users[1] END,
  CASE WHEN hod_rows IS NULL THEN array_remove(ARRAY[(user_for.m->>(emp.head_id::text))::uuid],NULL) ELSE coalesce(rh.users,'{}'::uuid[]) END,
  CASE WHEN hod_rows IS NULL THEN NULL ELSE rh.group_id END,
  CASE WHEN hod_rows IS NULL THEN 'department' ELSE rh.source END,
  -- People Business Partner
  CASE WHEN bp_rows IS NULL THEN ap.user_id WHEN rp.group_id IS NULL AND rp.source='routing' AND cardinality(rp.users)=1 THEN rp.users[1] END,
  CASE WHEN bp_rows IS NULL THEN array_remove(ARRAY[ap.user_id],NULL) ELSE coalesce(rp.users,'{}'::uuid[]) END,
  CASE WHEN bp_rows IS NULL THEN NULL ELSE rp.group_id END,
  CASE WHEN bp_rows IS NULL THEN 'bpRules' ELSE rp.source END
 FROM emp CROSS JOIN user_for
 LEFT JOIN adapter_pbp ap ON ap.id=emp.id
 LEFT JOIN resolved rp ON rp.id=emp.id AND rp.kind='pbp'
 LEFT JOIN resolved rh ON rh.id=emp.id AND rh.kind='hod';
END $old_bp$,$new_bp$
#variable_conflict use_column
DECLARE t uuid:=app.current_tenant_id();day date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;rules_ok boolean:=true;v9 jsonb;business_pbp_rules jsonb;bp_rows jsonb;hod_rows jsonb;bp_retired boolean;hod_retired boolean;
BEGIN
 IF t IS NULL OR coalesce(cardinality(p_employments),0)=0 THEN RETURN;END IF;
 SELECT v.data INTO v9 FROM public.lc_v9_config v WHERE v.tenant_id=t LIMIT 1;
 SELECT c.rules INTO business_pbp_rules FROM public.automation_business_partner_config c WHERE c.tenant_id=t;
 SELECT v.routing_rows,v.retired INTO bp_rows,bp_retired FROM public.automation_routing_version v WHERE v.tenant_id=t AND v.routing_id='a0700000-0000-4000-8000-000000001001'::uuid ORDER BY v.revision DESC LIMIT 1;
 SELECT v.routing_rows,v.retired INTO hod_rows,hod_retired FROM public.automation_routing_version v WHERE v.tenant_id=t AND v.routing_id='a0700000-0000-4000-8000-000000001002'::uuid ORDER BY v.revision DESC LIMIT 1;
 -- A routing answers once it has rows and is not retired; until then its adapter does.
 IF bp_retired IS NOT FALSE OR jsonb_typeof(bp_rows) IS DISTINCT FROM 'array' THEN bp_rows:=NULL;ELSIF jsonb_array_length(bp_rows)=0 THEN bp_rows:=NULL;END IF;
 IF hod_retired IS NOT FALSE OR jsonb_typeof(hod_rows) IS DISTINCT FROM 'array' THEN hod_rows:=NULL;ELSIF jsonb_array_length(hod_rows)=0 THEN hod_rows:=NULL;END IF;
 IF bp_rows IS NULL THEN
  IF jsonb_typeof(business_pbp_rules) IS NOT NULL AND jsonb_typeof(business_pbp_rules)<>'array' THEN rules_ok:=false;END IF;
  IF rules_ok THEN
   SELECT coalesce(bool_and((r->'rules' IS NULL OR jsonb_typeof(r->'rules')='object')
    AND (r->'rules'->'company' IS NULL OR jsonb_typeof(r->'rules'->'company')='array')
    AND (r->'rules'->'businessGroup' IS NULL OR jsonb_typeof(r->'rules'->'businessGroup')='array')
    AND (r->'rules'->'department' IS NULL OR jsonb_typeof(r->'rules'->'department')='array')),true) INTO rules_ok
   FROM jsonb_array_elements(coalesce(business_pbp_rules,'[]'::jsonb)) r;
  END IF;
 END IF;
 RETURN QUERY
 WITH emp AS MATERIALIZED (
  SELECT e.id,e.person_id,e.company_id,x.department_id,x.business_unit_id,x.title,coalesce(co.parent_company_id,co.id) AS group_company,
   (SELECT r.manager_employment_id FROM public.reporting_line r WHERE r.tenant_id=t AND r.subordinate_employment_id=e.id AND r.line_type='administrative'
     AND r.valid_from<=current_date AND (r.valid_to IS NULL OR r.valid_to>current_date) AND r.superseded_at IS NULL LIMIT 1) AS manager_id,
   (SELECT d.head_employment_id FROM public.department d WHERE d.id=x.department_id AND d.tenant_id=e.tenant_id) AS head_id
  FROM public.employment e
  LEFT JOIN public.company co ON co.id=e.company_id AND co.tenant_id=e.tenant_id
  LEFT JOIN LATERAL (SELECT a.department_id,a.business_unit_id,btrim(pos.title) AS title FROM public.assignment a
   LEFT JOIN public.position pos ON pos.id=a.position_id AND pos.tenant_id=a.tenant_id
   WHERE a.employment_id=e.id AND a.tenant_id=e.tenant_id AND a.superseded_at IS NULL
   AND a.valid_from<=day AND (a.valid_to IS NULL OR a.valid_to>day) ORDER BY a.valid_from DESC,a.id LIMIT 1) x ON true
  WHERE e.tenant_id=t AND e.id=ANY(p_employments)),
 linked AS MATERIALIZED (
  SELECT l.id,l.person_id FROM public.employment l
  WHERE l.tenant_id=t AND l.id=ANY(ARRAY(SELECT emp.id FROM emp UNION SELECT emp.manager_id FROM emp WHERE emp.manager_id IS NOT NULL UNION SELECT emp.head_id FROM emp WHERE emp.head_id IS NOT NULL))),
 -- A holder is the person's only usable login: person -> login, or JSON null when the person has more than one.
 logins AS MATERIALIZED (
  SELECT coalesce(jsonb_object_agg(x.person_id::text,x.user_id),'{}'::jsonb) AS m FROM (
   SELECT u.person_id,CASE WHEN count(*)=1 THEN (array_agg(u.id))[1] END AS user_id FROM public.app_user u
   WHERE u.tenant_id=t AND u.person_id=ANY(ARRAY(SELECT DISTINCT linked.person_id FROM linked WHERE linked.person_id IS NOT NULL)) AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
   GROUP BY u.person_id) x),
 user_for AS MATERIALIZED (
  SELECT coalesce(jsonb_object_agg(linked.id::text,logins.m->(linked.person_id::text)) FILTER(WHERE logins.m ? linked.person_id::text),'{}'::jsonb) AS m
  FROM linked CROSS JOIN logins),
 -- The V9 bpRules adapter, exactly as 5750 resolved the PBP (only while the BP routing has no rows).
 rules AS MATERIALIZED (SELECT r.value AS r FROM jsonb_array_elements(CASE WHEN bp_rows IS NULL AND rules_ok THEN coalesce(business_pbp_rules,'[]'::jsonb) ELSE '[]'::jsonb END) r),
 bp AS MATERIALIZED (
  SELECT emp.id,emp.company_id,emp.department_id,emp.business_unit_id,rules.r->>'userId' AS user_id,
   (CASE WHEN coalesce(jsonb_array_length(rules.r->'rules'->'businessGroup'),0)>0 THEN 4 ELSE 0 END+CASE WHEN coalesce(jsonb_array_length(rules.r->'rules'->'company'),0)>0 THEN 2 ELSE 0 END+CASE WHEN coalesce(jsonb_array_length(rules.r->'rules'->'department'),0)>0 THEN 1 ELSE 0 END) AS score
  FROM emp CROSS JOIN rules
  WHERE (coalesce(jsonb_array_length(rules.r->'rules'->'company'),0)=0 OR rules.r->'rules'->'company' ? emp.company_id::text)
   AND (coalesce(jsonb_array_length(rules.r->'rules'->'businessGroup'),0)=0 OR rules.r->'rules'->'businessGroup' ? emp.business_unit_id::text)
   AND (coalesce(jsonb_array_length(rules.r->'rules'->'department'),0)=0 OR rules.r->'rules'->'department' ? emp.department_id::text)
   AND NOT EXISTS(SELECT 1 FROM jsonb_each(coalesce(rules.r->'rules','{}'::jsonb)) extra WHERE extra.key NOT IN('company','businessGroup','department') AND extra.value<>'[]'::jsonb)),
 bp_pick AS MATERIALIZED (
  SELECT ranked.id,ranked.company_id,ranked.department_id,ranked.business_unit_id,min(ranked.user_id) AS user_id
  FROM (SELECT bp.*,max(bp.score) OVER(PARTITION BY bp.id) AS top FROM bp) ranked WHERE ranked.score=ranked.top
  GROUP BY ranked.id,ranked.company_id,ranked.department_id,ranked.business_unit_id HAVING count(DISTINCT coalesce(ranked.user_id,chr(1)))=1),
 bp_user AS MATERIALIZED (
  SELECT bp_pick.id,bp_pick.company_id,bp_pick.department_id,bp_pick.business_unit_id,u.id AS user_id FROM bp_pick
  JOIN public.app_user u ON u.id=CASE WHEN bp_pick.user_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN bp_pick.user_id::uuid END
   AND u.tenant_id=t AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
  JOIN public.person n ON n.id=u.person_id AND n.tenant_id=u.tenant_id AND length(btrim(n.full_name))>0),
 pbp_maps AS MATERIALIZED (SELECT m.* FROM public.probation_access m WHERE m.tenant_id=t AND m.role='pbp' AND m.user_id=ANY(ARRAY(SELECT DISTINCT bp_user.user_id FROM bp_user)) AND m.valid_from<=day AND (m.valid_to IS NULL OR m.valid_to>=day)),
 anc AS MATERIALIZED (SELECT * FROM app.probation_company_ancestors(ARRAY(SELECT DISTINCT bp_user.company_id FROM bp_user))),
 adapter_pbp AS MATERIALIZED (
  SELECT bp_user.id,bp_user.user_id FROM bp_user
  WHERE EXISTS(SELECT 1 FROM pbp_maps m JOIN anc ON anc.ancestor_id=m.company_id
   WHERE anc.company_id=bp_user.company_id AND m.user_id=bp_user.user_id AND (m.department_id IS NULL OR m.department_id=bp_user.department_id) AND (m.business_unit_id IS NULL OR m.business_unit_id=bp_user.business_unit_id))),
 -- The shared routing rule for the routings that have rows: one winning row per employee and routing.
rrows AS MATERIALIZED (
  SELECT 'pbp'::text AS kind,r.value AS rrow,r.ord FROM jsonb_array_elements(coalesce(bp_rows,'[]'::jsonb)) WITH ORDINALITY r(value,ord)
  UNION ALL SELECT 'hod',r.value,r.ord FROM jsonb_array_elements(coalesce(hod_rows,'[]'::jsonb)) WITH ORDINALITY r(value,ord)),
 scored AS MATERIALIZED (
  SELECT emp.id,rrows.kind,rrows.rrow,rrows.ord,
   app.probation_routing_weight(rrows.rrow->'match'->'businessGroup',8)+app.probation_routing_weight(rrows.rrow->'match'->'company',4)
    +app.probation_routing_weight(rrows.rrow->'match'->'department',2)+app.probation_routing_weight(rrows.rrow->'match'->'jobTitle',1) AS score
  FROM emp CROSS JOIN rrows
  WHERE app.probation_routing_dimension(rrows.rrow->'match'->'businessGroup',ARRAY[emp.business_unit_id::text,emp.group_company::text])
   AND app.probation_routing_dimension(rrows.rrow->'match'->'company',ARRAY[emp.company_id::text])
   AND app.probation_routing_dimension(rrows.rrow->'match'->'department',ARRAY[emp.department_id::text])
   AND app.probation_routing_dimension(rrows.rrow->'match'->'jobTitle',ARRAY[coalesce(emp.title,'')])),
 winner AS MATERIALIZED (SELECT DISTINCT ON (scored.id,scored.kind) scored.id,scored.kind,scored.rrow FROM scored ORDER BY scored.id,scored.kind,scored.score DESC,scored.ord),
 groups AS MATERIALIZED (
  SELECT g->>'id' AS id,coalesce((SELECT array_agg(u.id ORDER BY m.n) FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(g->'members')='array' THEN g->'members' ELSE '[]'::jsonb END) WITH ORDINALITY m(id,n)
    JOIN public.app_user u ON u.id::text=m.id AND u.tenant_id=t AND u.person_id IS NOT NULL AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) WHERE m.n<=500),'{}'::uuid[]) AS members
  FROM jsonb_array_elements(CASE WHEN (bp_rows IS NOT NULL OR hod_rows IS NOT NULL) AND jsonb_typeof(v9->'groups')='array' THEN v9->'groups' ELSE '[]'::jsonb END) g),
 chosen AS MATERIALIZED (
  SELECT winner.id,winner.kind,CASE WHEN winner.rrow->'assignTo'->>'kind'='group' THEN winner.rrow->'assignTo'->>'groupId' END AS group_id,
   CASE WHEN winner.rrow->'assignTo'->>'kind'='group' THEN coalesce((SELECT groups.members FROM groups WHERE groups.id=winner.rrow->'assignTo'->>'groupId' LIMIT 1),'{}'::uuid[])
    ELSE coalesce((SELECT array_agg(u.id ORDER BY p.n) FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(winner.rrow->'assignTo'->'userIds')='array' THEN winner.rrow->'assignTo'->'userIds' ELSE '[]'::jsonb END) WITH ORDINALITY p(id,n)
     JOIN public.app_user u ON u.id::text=p.id AND u.tenant_id=t AND u.person_id IS NOT NULL AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) WHERE p.n<=50),'{}'::uuid[]) END AS users
  FROM winner),
 -- The fallback group for an employee no row matches (or whose row reaches nobody active), per company.
 fallback AS MATERIALIZED (
  SELECT co.company_id,coalesce(nullif((SELECT s.data->>'fallbackGroupId' FROM public.probation_configuration s WHERE s.tenant_id=t AND s.company_id=co.company_id AND s.kind='settings' AND s.state='published' ORDER BY s.version DESC LIMIT 1),''),nullif(v9->>'peopleOpsGroup','')) AS group_id
  FROM (SELECT DISTINCT emp.company_id FROM emp WHERE bp_rows IS NOT NULL OR hod_rows IS NOT NULL) co),
 fallback_members AS MATERIALIZED (
  SELECT fallback.company_id,fallback.group_id,coalesce((SELECT groups.members FROM groups WHERE groups.id=fallback.group_id LIMIT 1),'{}'::uuid[]) AS users FROM fallback),
 resolved AS MATERIALIZED (
  SELECT emp.id,k.kind,
   CASE WHEN chosen.id IS NOT NULL AND cardinality(chosen.users)>0 THEN chosen.group_id ELSE fm.group_id END AS group_id,
   CASE WHEN chosen.id IS NOT NULL AND cardinality(chosen.users)>0 THEN chosen.users ELSE coalesce(fm.users,'{}'::uuid[]) END AS users,
   CASE WHEN chosen.id IS NOT NULL AND cardinality(chosen.users)>0 THEN 'routing' ELSE 'fallback' END AS source
  FROM emp CROSS JOIN (SELECT 'pbp'::text AS kind WHERE bp_rows IS NOT NULL UNION ALL SELECT 'hod' WHERE hod_rows IS NOT NULL) k
  LEFT JOIN chosen ON chosen.id=emp.id AND chosen.kind=k.kind
  LEFT JOIN fallback_members fm ON fm.company_id=emp.company_id)
 SELECT emp.id,emp.company_id,emp.department_id,emp.business_unit_id,
  (user_for.m->>(emp.id::text))::uuid,(user_for.m->>(emp.manager_id::text))::uuid,
  -- Head of Department
  CASE WHEN hod_rows IS NULL THEN (user_for.m->>(emp.head_id::text))::uuid WHEN rh.group_id IS NULL AND cardinality(rh.users)=1 THEN rh.users[1] END,
  CASE WHEN hod_rows IS NULL THEN array_remove(ARRAY[(user_for.m->>(emp.head_id::text))::uuid],NULL) ELSE coalesce(rh.users,'{}'::uuid[]) END,
  CASE WHEN hod_rows IS NULL THEN NULL ELSE rh.group_id END,
  CASE WHEN hod_rows IS NULL THEN 'department' ELSE rh.source END,
  -- People Business Partner
  CASE WHEN bp_rows IS NULL THEN ap.user_id WHEN rp.group_id IS NULL AND rp.source='routing' AND cardinality(rp.users)=1 THEN rp.users[1] END,
  CASE WHEN bp_rows IS NULL THEN array_remove(ARRAY[ap.user_id],NULL) ELSE coalesce(rp.users,'{}'::uuid[]) END,
  CASE WHEN bp_rows IS NULL THEN NULL ELSE rp.group_id END,
  CASE WHEN bp_rows IS NULL THEN 'bpRules' ELSE rp.source END
 FROM emp CROSS JOIN user_for
 LEFT JOIN adapter_pbp ap ON ap.id=emp.id
 LEFT JOIN resolved rp ON rp.id=emp.id AND rp.kind='pbp'
 LEFT JOIN resolved rh ON rh.id=emp.id AND rh.kind='hod';
END $new_bp$);
 EXECUTE definition;
END $bp_owner$;

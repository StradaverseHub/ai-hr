-- Probation settings scope: one group standard plus company settings with field-level overrides
-- (ADR docs/adr/2026-11-15-probation-shared-automation.md, decision 3). Tag 5742 / idx 5142 / when 1793330005442.
--
-- 1. probation_settings_scope_version is APPEND-ONLY. A save inserts the next version of one logical setting
--    (setting_key): the tenant's single group standard, which sets every field, or a company setting, which applies to
--    a chosen list of companies and stores only the fields it overrides.
-- 2. probation_settings_scope_member holds the current published company setting of each company. Its primary key
--    (tenant_id, company_id) is the database guarantee that a company is in at most one company setting; publishing
--    an overlapping setting is refused with the company named.
-- 3. Resolution: when a group standard is published, standard ⊕ the company's override is written as an ordinary
--    published company settings version in probation_configuration (kind 'settings'), with data.scope naming the
--    standard and override versions and the overridden fields. Every existing reader (admission, intake, cut-over,
--    exclusion, setup) keeps reading one pinned company version, and probation_case.settings_id plus the case's
--    data.config pin the resolved values, so a later standard change never moves a running case.
-- 4. Populated installations: nothing is rewritten. The group standard starts absent and every company keeps its
--    current per-company published version until an administrator publishes a standard (the settings page offers
--    "Create group standard from <company>" with a difference view). Company settings may be published before the
--    standard; they take effect with it. Once a standard exists, a direct company settings version is refused; form
--    and route versions stay per company.
-- 5. Writes go only through SECURITY DEFINER functions that take the probation write barrier (the shared workforce
--    Access lock plus the tenant's probation advisory lock), check the tenant-level Probation module permission and
--    record a domain_event in the same transaction. No purpose-role object is created or replaced.
CREATE TABLE public.probation_settings_scope_version (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 setting_key uuid NOT NULL,
 scope text NOT NULL CHECK (scope IN ('standard','company')),
 version integer NOT NULL CHECK (version BETWEEN 1 AND 100000),
 state text NOT NULL CHECK (state IN ('draft','published','retired')),
 name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
 company_ids uuid[] NOT NULL DEFAULT '{}'::uuid[] CHECK (cardinality(company_ids) <= 500),
 data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
 reason text CHECK (reason IS NULL OR length(reason) <= 2000),
 created_by uuid NOT NULL REFERENCES public.app_user(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 published_by uuid REFERENCES public.app_user(id),
 published_at timestamptz,
 UNIQUE (tenant_id, setting_key, version),
 UNIQUE (tenant_id, id),
 CHECK (scope = 'company' OR cardinality(company_ids) = 0),
 CHECK ((state = 'published') = (published_at IS NOT NULL) OR state = 'retired')
);
--> statement-breakpoint
-- One standard key per tenant: only one setting_key may ever hold a standard version 1.
CREATE UNIQUE INDEX probation_settings_scope_one_standard ON public.probation_settings_scope_version (tenant_id) WHERE scope = 'standard' AND version = 1;
--> statement-breakpoint
CREATE INDEX probation_settings_scope_latest ON public.probation_settings_scope_version (tenant_id, scope, setting_key, version DESC);
--> statement-breakpoint
CREATE TABLE public.probation_settings_scope_member (
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL REFERENCES public.company(id),
 setting_key uuid NOT NULL,
 version_id uuid NOT NULL,
 PRIMARY KEY (tenant_id, company_id),
 FOREIGN KEY (company_id, tenant_id) REFERENCES public.company(id, tenant_id),
 FOREIGN KEY (tenant_id, version_id) REFERENCES public.probation_settings_scope_version(tenant_id, id)
);
--> statement-breakpoint
CREATE INDEX probation_settings_scope_member_key ON public.probation_settings_scope_member (tenant_id, setting_key);
--> statement-breakpoint
ALTER TABLE public.probation_settings_scope_version ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.probation_settings_scope_version FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.probation_settings_scope_member ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.probation_settings_scope_member FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY probation_settings_scope_version_owner ON public.probation_settings_scope_version FOR ALL TO ai_hr_owner USING (app.acting_as_owner()) WITH CHECK (app.acting_as_owner());
--> statement-breakpoint
CREATE POLICY probation_settings_scope_member_owner ON public.probation_settings_scope_member FOR ALL TO ai_hr_owner USING (app.acting_as_owner()) WITH CHECK (app.acting_as_owner());
--> statement-breakpoint
-- Tenant-level authority: the same Probation module permission (migration 2107) that configures any company.
CREATE FUNCTION app.probation_settings_scope_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(app.current_tenant_id() IS NOT NULL AND app.probation_active_user() AND app.access_capability_allowed('probation.module',NULL),false);
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.probation_settings_scope_admin() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.probation_settings_scope_admin() TO ai_hr_app;
--> statement-breakpoint
CREATE POLICY probation_settings_scope_version_read ON public.probation_settings_scope_version FOR SELECT TO ai_hr_app
 USING (tenant_id = app.current_tenant_id() AND app.probation_settings_scope_admin());
--> statement-breakpoint
CREATE POLICY probation_settings_scope_member_read ON public.probation_settings_scope_member FOR SELECT TO ai_hr_app
 USING (tenant_id = app.current_tenant_id() AND app.probation_settings_scope_admin());
--> statement-breakpoint
REVOKE ALL ON public.probation_settings_scope_version, public.probation_settings_scope_member FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
GRANT SELECT ON public.probation_settings_scope_version, public.probation_settings_scope_member TO ai_hr_app;
--> statement-breakpoint
-- Writes standard ⊕ override as the next published company settings version for each listed, entitled, live company
-- whose resolved values differ from its current published version. One set-based statement; internal only.
CREATE FUNCTION app.probation_settings_materialize(p_companies uuid[]) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();std public.probation_settings_scope_version;v_count integer;blocked text;
BEGIN
 IF t IS NULL OR app.current_user_id() IS NULL THEN RAISE EXCEPTION 'A signed-in tenant user is required' USING ERRCODE='42501';END IF;
 SELECT * INTO std FROM public.probation_settings_scope_version WHERE tenant_id=t AND scope='standard' AND state='published' ORDER BY version DESC LIMIT 1;
 IF std.id IS NULL OR coalesce(cardinality(p_companies),0)=0 THEN RETURN 0;END IF;
 SELECT string_agg(c.legal_name,', ' ORDER BY c.legal_name) INTO blocked
 FROM public.company c
 LEFT JOIN public.probation_settings_scope_member m ON m.tenant_id=c.tenant_id AND m.company_id=c.id
 LEFT JOIN public.probation_settings_scope_version o ON o.tenant_id=m.tenant_id AND o.id=m.version_id
 WHERE c.tenant_id=t AND c.id=ANY(p_companies) AND c.archived_at IS NULL AND app.probation_company_entitled(c.id)
  AND coalesce(o.data->'gradeHEnabled',std.data->'gradeHEnabled')='true'::jsonb
  AND NOT EXISTS(SELECT 1 FROM public.probation_configuration f WHERE f.tenant_id=t AND f.company_id=c.id AND f.kind='form' AND f.state='published' AND app.probation_is_current_publication('form',f.id) AND f.data->'targetGrades'?'H');
 IF blocked IS NOT NULL THEN RAISE EXCEPTION 'Grade H is switched on for companies without a published Grade H form: %',left(blocked,500) USING ERRCODE='22023';END IF;
 WITH target AS (
  SELECT c.id AS company_id,m.version_id,o.version AS o_version,o.setting_key AS o_key,o.name AS o_name,coalesce(o.data,'{}'::jsonb) AS o_data
  FROM public.company c
  LEFT JOIN public.probation_settings_scope_member m ON m.tenant_id=c.tenant_id AND m.company_id=c.id
  LEFT JOIN public.probation_settings_scope_version o ON o.tenant_id=m.tenant_id AND o.id=m.version_id
  WHERE c.tenant_id=t AND c.id=ANY(p_companies) AND c.archived_at IS NULL AND app.probation_company_entitled(c.id)
 ),resolved AS (
  SELECT tg.company_id,((std.data-'version'-'scope'-'gradeHFormPublished')||tg.o_data)||jsonb_build_object(
   'gradeHFormPublished',EXISTS(SELECT 1 FROM public.probation_configuration f WHERE f.tenant_id=t AND f.company_id=tg.company_id AND f.kind='form' AND f.state='published' AND app.probation_is_current_publication('form',f.id) AND f.data->'targetGrades'?'H'),
   'organisationMapping',coalesce(std.data->>'organisationMapping',app.probation_organisation_mapping()),
   'scope',jsonb_build_object('standardId',std.id,'standardVersion',std.version,'overrideId',tg.version_id,'overrideVersion',tg.o_version,'overrideKey',tg.o_key,'overrideName',tg.o_name,
    'fields',coalesce((SELECT jsonb_agg(k ORDER BY k) FROM jsonb_object_keys(tg.o_data) k),'[]'::jsonb))) AS data
  FROM target tg
 ),latest AS (
  SELECT company_id,max(version) AS version FROM public.probation_configuration WHERE tenant_id=t AND kind='settings' AND company_id=ANY(p_companies) GROUP BY company_id
 ),current_version AS (
  SELECT DISTINCT ON (company_id) company_id,data FROM public.probation_configuration WHERE tenant_id=t AND kind='settings' AND state='published' AND company_id=ANY(p_companies) ORDER BY company_id,version DESC
 ),inserted AS (
  INSERT INTO public.probation_configuration(tenant_id,company_id,kind,version,state,data,created_by,published_by,published_at)
  SELECT t,r.company_id,'settings',coalesce(l.version,0)+1,'published',r.data||jsonb_build_object('version',coalesce(l.version,0)+1),app.current_user_id(),app.current_user_id(),now()
  FROM resolved r LEFT JOIN latest l ON l.company_id=r.company_id LEFT JOIN current_version cur ON cur.company_id=r.company_id
  WHERE cur.data IS NULL OR (cur.data-'version') IS DISTINCT FROM (r.data-'version')
  RETURNING 1
 )
 SELECT count(*)::integer INTO v_count FROM inserted;
 RETURN v_count;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.probation_settings_materialize(uuid[]) FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
-- Bounded shape checks; the service validates meaning (validateProbationConfig) before the call. Each jsonb type is
-- checked in its own statement before anything that would fail on another type.
CREATE FUNCTION app.probation_settings_scope_check(p_scope text,p_data jsonb) RETURNS void LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE k text;v jsonb;
BEGIN
 IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' OR pg_column_size(p_data)>262144 THEN RAISE EXCEPTION 'Probation settings are incomplete or too large' USING ERRCODE='22023';END IF;
 IF p_scope='standard' THEN
  IF EXISTS(SELECT 1 FROM unnest(ARRAY['eligibleGrades','gradeHEnabled','defaultMonths','plans','kpiGate','kpiDueWorkingDays','kpiReminderWorkingDay','issueLeadDays','firstReminderDays','dailyReminderDays','lowBand','lmWaitsForEmployee','maxExtensions','extensionMonths']) f WHERE NOT p_data?f) THEN RAISE EXCEPTION 'The group standard must set every field' USING ERRCODE='22023';END IF;
  IF p_data->'extensionMonths' IS DISTINCT FROM '[3,6]'::jsonb THEN RAISE EXCEPTION 'Extension options stay 3 or 6 months' USING ERRCODE='22023';END IF;
  IF p_data?'overrides' AND p_data->'overrides' IS DISTINCT FROM '[]'::jsonb THEN RAISE EXCEPTION 'Narrow KPI gate rules belong in a company setting' USING ERRCODE='22023';END IF;
 ELSIF EXISTS(SELECT 1 FROM jsonb_object_keys(p_data) key WHERE key NOT IN('eligibleGrades','gradeHEnabled','defaultMonths','plans','kpiGate','issueLeadDays','nonWorkingDayRule','fallbackGroupId','postingApproverGroupId','maxExtensions','kpiDueWorkingDays','kpiReminderWorkingDay','firstReminderDays','dailyReminderDays','lowBand','lmWaitsForEmployee','overrides')) THEN
  RAISE EXCEPTION 'A company setting may override only probation settings fields' USING ERRCODE='22023';
 END IF;
 FOR k,v IN SELECT key,value FROM jsonb_each(p_data) LOOP
  IF k IN('defaultMonths','kpiDueWorkingDays','kpiReminderWorkingDay','issueLeadDays','firstReminderDays','dailyReminderDays','lowBand') THEN
   IF jsonb_typeof(v) IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'Probation timings must be whole numbers' USING ERRCODE='22023';END IF;
   IF (v#>>'{}')!~'^[0-9]{1,3}$' THEN RAISE EXCEPTION 'Probation timings must be whole numbers' USING ERRCODE='22023';END IF;
   IF (v#>>'{}')::integer<1 OR (v#>>'{}')::integer>(CASE WHEN k='lowBand' THEN 5 ELSE 366 END) THEN RAISE EXCEPTION 'Probation timings are out of range' USING ERRCODE='22023';END IF;
  ELSIF k='maxExtensions' THEN
   IF jsonb_typeof(v) IS DISTINCT FROM 'number' OR (v#>>'{}') NOT IN('0','1','2') THEN RAISE EXCEPTION 'Choose a maximum of 0, 1 or 2 extensions' USING ERRCODE='22023';END IF;
  ELSIF k='kpiGate' THEN
   IF coalesce(v#>>'{}','') NOT IN('block','warn','off') OR jsonb_typeof(v) IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'Choose a KPI acknowledgement gate' USING ERRCODE='22023';END IF;
  ELSIF k='nonWorkingDayRule' THEN
   IF jsonb_typeof(v) IS DISTINCT FROM 'string' OR v#>>'{}' NOT IN('previous','next') THEN RAISE EXCEPTION 'Choose how a due date on a non-working day moves' USING ERRCODE='22023';END IF;
  ELSIF k IN('fallbackGroupId','postingApproverGroupId') THEN
   IF jsonb_typeof(v) NOT IN('null','string') THEN RAISE EXCEPTION 'Choose an assignment group' USING ERRCODE='22023';END IF;
   IF jsonb_typeof(v)='string' AND length(btrim(v#>>'{}')) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'Choose an assignment group' USING ERRCODE='22023';END IF;
  ELSIF k IN('gradeHEnabled','lmWaitsForEmployee') THEN
   IF jsonb_typeof(v) IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'Probation switches must be on or off' USING ERRCODE='22023';END IF;
  ELSIF k='eligibleGrades' THEN
   IF jsonb_typeof(v) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Choose distinct eligible grades 12 through 23' USING ERRCODE='22023';END IF;
   IF jsonb_array_length(v)=0 OR EXISTS(SELECT 1 FROM jsonb_array_elements(v) g WHERE jsonb_typeof(g) IS DISTINCT FROM 'string') THEN RAISE EXCEPTION 'Choose distinct eligible grades 12 through 23' USING ERRCODE='22023';END IF;
   IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(v) g WHERE g!~'^(1[2-9]|2[0-3])$') OR (SELECT count(DISTINCT g) FROM jsonb_array_elements_text(v) g)<>jsonb_array_length(v) THEN RAISE EXCEPTION 'Choose distinct eligible grades 12 through 23' USING ERRCODE='22023';END IF;
  ELSIF k IN('plans','overrides') THEN
   IF jsonb_typeof(v) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Review plans and rules must be lists' USING ERRCODE='22023';END IF;
   IF jsonb_array_length(v)>100 OR EXISTS(SELECT 1 FROM jsonb_array_elements(v) item WHERE jsonb_typeof(item) IS DISTINCT FROM 'object') THEN RAISE EXCEPTION 'Review plans and rules must be lists' USING ERRCODE='22023';END IF;
  END IF;
 END LOOP;
 IF p_scope='standard' AND jsonb_array_length(p_data->'plans')=0 THEN RAISE EXCEPTION 'Add at least one review plan' USING ERRCODE='22023';END IF;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.probation_settings_scope_check(text,jsonb) FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.probation_settings_scope_save(p_key uuid,p_scope text,p_name text,p_companies uuid[],p_data jsonb,p_publish boolean,p_expected integer,p_reason text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();prior public.probation_settings_scope_version;standard_key uuid;v_id uuid;v_version integer;companies uuid[]:=coalesce(p_companies,'{}'::uuid[]);
 previous_members uuid[]:='{}'::uuid[];affected uuid[];clash text;mapping text;rule jsonb;v_company uuid;materialized integer:=0;
BEGIN
 IF t IS NULL OR app.current_user_id() IS NULL THEN RAISE EXCEPTION 'A signed-in tenant user is required' USING ERRCODE='42501';END IF;
 PERFORM app.probation_write_lock();
 IF app.probation_settings_scope_admin() IS NOT TRUE THEN RAISE EXCEPTION 'Probation module permission is required' USING ERRCODE='42501';END IF;
 IF p_key IS NULL OR coalesce(p_scope,'') NOT IN('standard','company') OR p_publish IS NULL OR length(btrim(coalesce(p_name,''))) NOT BETWEEN 1 AND 200 OR length(coalesce(p_reason,''))>2000 THEN
  RAISE EXCEPTION 'Name the setting and choose its scope' USING ERRCODE='22023';END IF;
 IF p_scope='standard' THEN
  SELECT setting_key INTO standard_key FROM public.probation_settings_scope_version WHERE tenant_id=t AND scope='standard' LIMIT 1;
  IF standard_key IS NOT NULL AND standard_key<>p_key THEN RAISE EXCEPTION 'This tenant already has a group standard; edit it instead' USING ERRCODE='23505';END IF;
  IF cardinality(companies)<>0 THEN RAISE EXCEPTION 'The group standard applies to every company' USING ERRCODE='22023';END IF;
 ELSE
  IF cardinality(companies) NOT BETWEEN 1 AND 500 OR (SELECT count(DISTINCT c) FROM unnest(companies) c)<>cardinality(companies) THEN RAISE EXCEPTION 'Choose the companies this setting applies to' USING ERRCODE='22023';END IF;
  IF (SELECT count(*) FROM public.company c WHERE c.tenant_id=t AND c.id=ANY(companies) AND c.archived_at IS NULL AND app.probation_company_entitled(c.id))<>cardinality(companies) THEN
   RAISE EXCEPTION 'Choose active companies with Probation in this tenant' USING ERRCODE='22023';END IF;
 END IF;
 PERFORM app.probation_settings_scope_check(p_scope,p_data);
 SELECT * INTO prior FROM public.probation_settings_scope_version WHERE tenant_id=t AND setting_key=p_key ORDER BY version DESC LIMIT 1;
 IF coalesce(prior.version,0) IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'These probation settings changed; reload before saving' USING ERRCODE='40001';END IF;
 IF prior.id IS NOT NULL AND prior.scope<>p_scope THEN RAISE EXCEPTION 'A setting cannot change between group standard and company setting' USING ERRCODE='22023';END IF;
 IF prior.state='retired' THEN RAISE EXCEPTION 'A retired company setting cannot change' USING ERRCODE='22023';END IF;
 IF p_publish AND p_scope='company' THEN
  IF NOT EXISTS(SELECT 1 FROM jsonb_object_keys(p_data)) THEN RAISE EXCEPTION 'Override at least one field, or apply the group standard' USING ERRCODE='22023';END IF;
  SELECT string_agg(c.legal_name||' ('||coalesce(other.name,'another company setting')||')',', ' ORDER BY c.legal_name) INTO clash
  FROM public.probation_settings_scope_member m JOIN public.company c ON c.id=m.company_id AND c.tenant_id=m.tenant_id
  LEFT JOIN public.probation_settings_scope_version other ON other.tenant_id=m.tenant_id AND other.id=m.version_id
  WHERE m.tenant_id=t AND m.company_id=ANY(companies) AND m.setting_key<>p_key;
  IF clash IS NOT NULL THEN RAISE EXCEPTION 'A company can be in only one company setting. Already in another setting: %',left(clash,500) USING ERRCODE='23505';END IF;
  mapping:=coalesce((SELECT data->>'organisationMapping' FROM public.probation_settings_scope_version WHERE tenant_id=t AND scope='standard' AND state='published' ORDER BY version DESC LIMIT 1),app.probation_organisation_mapping());
  FOR rule IN SELECT value FROM jsonb_array_elements(coalesce(p_data->'overrides','[]'::jsonb)) LOOP
   FOREACH v_company IN ARRAY companies LOOP PERFORM app.probation_assert_organisation_scope(rule,mapping,v_company);END LOOP;
  END LOOP;
 END IF;
 v_version:=coalesce(prior.version,0)+1;
 INSERT INTO public.probation_settings_scope_version(tenant_id,setting_key,scope,version,state,name,company_ids,data,reason,created_by,published_by,published_at)
 VALUES(t,p_key,p_scope,v_version,CASE WHEN p_publish THEN 'published' ELSE 'draft' END,btrim(p_name),companies,
  CASE WHEN p_scope='standard' THEN (p_data-'version'-'scope'-'gradeHFormPublished')||jsonb_build_object('organisationMapping',coalesce(p_data->>'organisationMapping',app.probation_organisation_mapping())) ELSE p_data END,
  nullif(btrim(coalesce(p_reason,'')),''),app.current_user_id(),CASE WHEN p_publish THEN app.current_user_id() END,CASE WHEN p_publish THEN now() END)
 RETURNING id INTO v_id;
 IF p_publish THEN
  IF p_scope='company' THEN
   SELECT coalesce(array_agg(m.company_id),'{}'::uuid[]) INTO previous_members FROM public.probation_settings_scope_member m WHERE m.tenant_id=t AND m.setting_key=p_key;
   DELETE FROM public.probation_settings_scope_member m WHERE m.tenant_id=t AND m.setting_key=p_key;
   INSERT INTO public.probation_settings_scope_member(tenant_id,company_id,setting_key,version_id) SELECT t,c,p_key,v_id FROM unnest(companies) c;
   affected:=ARRAY(SELECT DISTINCT c FROM unnest(previous_members||companies) c);
  ELSE
   affected:=ARRAY(SELECT c.id FROM public.company c WHERE c.tenant_id=t AND c.archived_at IS NULL AND app.probation_company_entitled(c.id));
  END IF;
  materialized:=app.probation_settings_materialize(affected);
 END IF;
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
 VALUES(t,'probation_settings',p_key,CASE WHEN p_publish THEN 'probation.settings_scope.published' ELSE 'probation.settings_scope.saved' END,'user'::actor_type,app.current_user_id(),
  jsonb_build_object('scope',p_scope,'versionId',v_id,'version',v_version,'companies',to_jsonb(companies),'previousCompanies',to_jsonb(previous_members),
   'fields',CASE WHEN p_scope='company' THEN (SELECT coalesce(jsonb_agg(k ORDER BY k),'[]'::jsonb) FROM jsonb_object_keys(p_data) k) ELSE '[]'::jsonb END,'resolvedVersions',materialized,'reason',nullif(btrim(coalesce(p_reason,'')),'')));
 RETURN jsonb_build_object('id',v_id,'settingKey',p_key,'version',v_version,'resolvedVersions',materialized);
END $$;
--> statement-breakpoint
CREATE FUNCTION app.probation_settings_scope_retire(p_key uuid,p_expected integer,p_reason text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();prior public.probation_settings_scope_version;members uuid[];v_id uuid;materialized integer;
BEGIN
 IF t IS NULL OR app.current_user_id() IS NULL THEN RAISE EXCEPTION 'A signed-in tenant user is required' USING ERRCODE='42501';END IF;
 PERFORM app.probation_write_lock();
 IF app.probation_settings_scope_admin() IS NOT TRUE THEN RAISE EXCEPTION 'Probation module permission is required' USING ERRCODE='42501';END IF;
 IF length(btrim(coalesce(p_reason,''))) NOT BETWEEN 3 AND 2000 THEN RAISE EXCEPTION 'Give a reason' USING ERRCODE='22023';END IF;
 SELECT * INTO prior FROM public.probation_settings_scope_version WHERE tenant_id=t AND setting_key=p_key ORDER BY version DESC LIMIT 1;
 IF prior.id IS NULL OR prior.scope<>'company' OR prior.state='retired' THEN RAISE EXCEPTION 'Only a current company setting can be retired' USING ERRCODE='22023';END IF;
 IF prior.version IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'These probation settings changed; reload before saving' USING ERRCODE='40001';END IF;
 SELECT coalesce(array_agg(company_id),'{}'::uuid[]) INTO members FROM public.probation_settings_scope_member WHERE tenant_id=t AND setting_key=p_key;
 DELETE FROM public.probation_settings_scope_member WHERE tenant_id=t AND setting_key=p_key;
 INSERT INTO public.probation_settings_scope_version(tenant_id,setting_key,scope,version,state,name,company_ids,data,reason,created_by)
 VALUES(t,p_key,'company',prior.version+1,'retired',prior.name,prior.company_ids,prior.data,btrim(p_reason),app.current_user_id()) RETURNING id INTO v_id;
 materialized:=app.probation_settings_materialize(members);
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
 VALUES(t,'probation_settings',p_key,'probation.settings_scope.retired','user'::actor_type,app.current_user_id(),
  jsonb_build_object('scope','company','versionId',v_id,'version',prior.version+1,'previousCompanies',to_jsonb(members),'resolvedVersions',materialized,'reason',btrim(p_reason)));
 RETURN jsonb_build_object('id',v_id,'settingKey',p_key,'version',prior.version+1,'resolvedVersions',materialized);
END $$;
--> statement-breakpoint
-- A company entitled after the standard was published picks it up here (the settings page offers it).
CREATE FUNCTION app.probation_settings_scope_refresh(p_company uuid) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();materialized integer;
BEGIN
 IF t IS NULL OR app.current_user_id() IS NULL THEN RAISE EXCEPTION 'A signed-in tenant user is required' USING ERRCODE='42501';END IF;
 PERFORM app.probation_write_lock();
 IF app.probation_config_admin(p_company) IS NOT TRUE OR app.probation_settings_scope_admin() IS NOT TRUE THEN RAISE EXCEPTION 'Probation module permission is required' USING ERRCODE='42501';END IF;
 materialized:=app.probation_settings_materialize(ARRAY[p_company]);
 IF materialized>0 THEN
  INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
  VALUES(t,'probation_settings',p_company,'probation.settings_scope.refreshed','user'::actor_type,app.current_user_id(),jsonb_build_object('companyId',p_company,'resolvedVersions',materialized));
 END IF;
 RETURN materialized;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.probation_settings_scope_save(uuid,text,text,uuid[],jsonb,boolean,integer,text),app.probation_settings_scope_retire(uuid,integer,text),app.probation_settings_scope_refresh(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.probation_settings_scope_save(uuid,text,text,uuid[],jsonb,boolean,integer,text),app.probation_settings_scope_retire(uuid,integer,text),app.probation_settings_scope_refresh(uuid) TO ai_hr_app;
--> statement-breakpoint
-- Once a group standard is published, company settings versions come only from the standard and company settings.
-- Form and route versions stay per company (unchanged).
ALTER FUNCTION app.probation_config_write(uuid,text,jsonb,boolean,integer) RENAME TO probation_config_write_company;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.probation_config_write_company(uuid,text,jsonb,boolean,integer) FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.probation_config_write(p_company uuid,p_kind text,p_data jsonb,p_publish boolean,p_expected integer) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM app.probation_write_lock();
 IF p_kind='settings' AND EXISTS(SELECT 1 FROM public.probation_settings_scope_version WHERE tenant_id=app.current_tenant_id() AND scope='standard' AND state='published') THEN
  RAISE EXCEPTION 'Probation settings now come from the group standard and company settings' USING ERRCODE='22023';
 END IF;
 RETURN app.probation_config_write_company(p_company,p_kind,p_data,p_publish,p_expected);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.probation_config_write(uuid,text,jsonb,boolean,integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.probation_config_write(uuid,text,jsonb,boolean,integer) TO ai_hr_app;

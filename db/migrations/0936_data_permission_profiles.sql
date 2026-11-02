-- Versioned administrative data scope. Absence of assignment preserves installed company behavior.
CREATE TABLE data_permission_profile (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 100 AND name=btrim(name)),
 revision uuid NOT NULL DEFAULT gen_random_uuid(),active_revision_id uuid,enabled boolean NOT NULL DEFAULT false,
 retired_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,id)
);
CREATE UNIQUE INDEX data_permission_profile_name ON data_permission_profile(tenant_id,lower(name)) WHERE retired_at IS NULL;
CREATE TABLE data_permission_revision (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,profile_id uuid NOT NULL,
 rules jsonb NOT NULL,created_by uuid NOT NULL REFERENCES app_user(id),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,profile_id,id),FOREIGN KEY(tenant_id,profile_id) REFERENCES data_permission_profile(tenant_id,id)
);
ALTER TABLE data_permission_profile ADD CONSTRAINT data_permission_active_revision
 FOREIGN KEY(tenant_id,id,active_revision_id) REFERENCES data_permission_revision(tenant_id,profile_id,id);
CREATE TABLE user_data_permission_assignment (
 tenant_id uuid NOT NULL,user_id uuid NOT NULL REFERENCES app_user(id),profile_id uuid NOT NULL,
 revision uuid NOT NULL DEFAULT gen_random_uuid(),assigned_by uuid NOT NULL REFERENCES app_user(id),assigned_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,user_id),FOREIGN KEY(tenant_id,profile_id) REFERENCES data_permission_profile(tenant_id,id)
);
ALTER TABLE data_permission_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_permission_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_data_permission_assignment ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON data_permission_profile,data_permission_revision,user_data_permission_assignment FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.data_permission_rules_valid(rules jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE rule jsonb; val jsonb; fields text[]:=ARRAY[]::text[]; key text;
BEGIN
 IF rules IS NULL OR jsonb_typeof(rules)<>'object' OR NOT app.access_command_keys(rules,ARRAY['legacyCompany','predicates'])
  OR jsonb_typeof(rules->'legacyCompany')<>'boolean' OR jsonb_typeof(rules->'predicates')<>'array'
  OR jsonb_array_length(rules->'predicates')>17 THEN RETURN false;END IF;
 IF (rules->>'legacyCompany')::boolean THEN RETURN jsonb_array_length(rules->'predicates')=0;END IF;
 IF jsonb_array_length(rules->'predicates')=0 THEN RETURN false;END IF;
 FOR rule IN SELECT value FROM jsonb_array_elements(rules->'predicates') LOOP
  IF jsonb_typeof(rule)<>'object' OR NOT app.access_command_keys(rule,ARRAY['field','values']) OR jsonb_typeof(rule->'field')<>'string'
   OR jsonb_typeof(rule->'values')<>'array' OR jsonb_array_length(rule->'values') NOT BETWEEN 1 AND 100 THEN RETURN false;END IF;
  key:=rule->>'field';
  IF key<>ALL(ARRAY['company','businessUnit','division','branch','department','section','team','position','grade','employmentType','employmentStatus','costCentre','nationality','gender','maritalStatus','category','employeeId']) OR key=ANY(fields) THEN RETURN false;END IF;
  fields:=array_append(fields,key);
  IF (SELECT count(*)<>count(DISTINCT value) FROM jsonb_array_elements(rule->'values')) THEN RETURN false;END IF;
  FOR val IN SELECT value FROM jsonb_array_elements(rule->'values') LOOP
   IF jsonb_typeof(val)<>'string' OR length(val#>>'{}') NOT BETWEEN 1 AND 255 OR val#>>'{}'<>btrim(val#>>'{}') OR val#>>'{}' ~ '[[:cntrl:]]' THEN RETURN false;END IF;
   IF key=ANY(ARRAY['company','businessUnit','department','position','grade','costCentre']) AND val#>>'{}' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN false;END IF;
  END LOOP;
 END LOOP;
 RETURN true;
END;
$$;
ALTER TABLE data_permission_revision ADD CONSTRAINT data_permission_rules_valid CHECK(app.data_permission_rules_valid(rules));
--> statement-breakpoint
-- Code-owned typed projection. It deliberately returns no unknown or encrypted field.
CREATE FUNCTION app.data_permission_subject_for(p_tenant uuid,p_employment uuid,p_date date DEFAULT current_date) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('tenant',e.tenant_id::text,'company',e.company_id::text,'businessUnit',a.business_unit_id::text,
 'division',e.org_division,'branch',e.org_branch,'department',a.department_id::text,'section',e.org_section,
 'team',e.org_team,'position',a.position_id::text,'grade',e.grade_id::text,'employmentType',a.employment_type::text,
 'employmentStatus',app.employment_status_on(e.blacklisted_at,e.resignation_date,e.last_working_date,e.terminated_on,
 e.final_confirmation_date,e.confirmation_date,e.probation_end_date,e.provisional_end_on,p_date),
 'costCentre',a.cost_center_id::text,'nationality',p.nationality,'gender',p.gender,'maritalStatus',p.marital_status,
 'category',e.employment_category,'employeeId',e.employee_code)
 FROM public.employment e JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
 LEFT JOIN LATERAL(SELECT a.* FROM public.assignment a WHERE a.employment_id=e.id AND a.tenant_id=e.tenant_id
  AND a.superseded_at IS NULL AND a.valid_from<=p_date AND (a.valid_to IS NULL OR a.valid_to>p_date)
  ORDER BY a.valid_from DESC,a.id LIMIT 1)a ON true
 WHERE e.id=p_employment AND e.tenant_id=p_tenant AND e.voided_at IS NULL AND p.voided_at IS NULL;
$$;
REVOKE ALL ON FUNCTION app.data_permission_subject_for(uuid,uuid,date) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.data_permission_subject(p_employment uuid,p_date date DEFAULT current_date) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.data_permission_subject_for(app.current_tenant_id(),p_employment,p_date);
$$;
REVOKE ALL ON FUNCTION app.data_permission_subject(uuid,date) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.data_permission_rules_match(rules jsonb,subject jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE rule jsonb; matched boolean;
BEGIN
 IF NOT app.data_permission_rules_valid(rules) OR subject IS NULL THEN RETURN false;END IF;
 IF (rules->>'legacyCompany')::boolean THEN RETURN true;END IF;
 FOR rule IN SELECT value FROM jsonb_array_elements(rules->'predicates') LOOP
  IF subject->>(rule->>'field') IS NULL THEN RETURN false;END IF;
  IF rule->>'field'='company' THEN
   SELECT EXISTS(SELECT 1 FROM jsonb_array_elements_text(rule->'values')v WHERE app.access_scope_covers(v::uuid,(subject->>'company')::uuid,(subject->>'tenant')::uuid)) INTO matched;
  ELSE SELECT EXISTS(SELECT 1 FROM jsonb_array_elements_text(rule->'values')v WHERE v=subject->>(rule->>'field')) INTO matched;END IF;
  IF NOT matched THEN RETURN false;END IF;
 END LOOP;RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION app.data_permission_rules_match(jsonb,jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.data_permission_matches_for(p_user uuid,p_tenant uuid,p_employment uuid,p_date date DEFAULT current_date) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.data_permission_profile; rules jsonb; subject jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.app_user u
  WHERE u.id=p_user AND u.tenant_id=p_tenant AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)) THEN RETURN false;END IF;
 subject:=app.data_permission_subject_for(p_tenant,p_employment,p_date);
 IF subject IS NULL THEN RETURN false;END IF;
 SELECT profile.* INTO p FROM public.user_data_permission_assignment a LEFT JOIN public.data_permission_profile profile
  ON profile.id=a.profile_id AND profile.tenant_id=a.tenant_id
  WHERE a.tenant_id=p_tenant AND a.user_id=p_user;
 IF NOT FOUND THEN RETURN true;END IF;
 IF p.id IS NULL OR NOT p.enabled OR p.retired_at IS NOT NULL OR p.active_revision_id IS NULL THEN RETURN false;END IF;
 SELECT r.rules INTO rules FROM public.data_permission_revision r WHERE r.id=p.active_revision_id AND r.profile_id=p.id AND r.tenant_id=p.tenant_id;
 RETURN app.data_permission_rules_match(rules,subject);
END;
$$;
REVOKE ALL ON FUNCTION app.data_permission_matches_for(uuid,uuid,uuid,date) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.data_permission_matches(p_employment uuid,p_date date DEFAULT current_date) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND app.data_permission_matches_for(app.current_user_id(),app.current_tenant_id(),p_employment,p_date);
$$;
REVOKE ALL ON FUNCTION app.data_permission_matches(uuid,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.data_permission_matches(uuid,date) TO ai_hr_app;
--> statement-breakpoint
-- Customer writers cannot append revisions or reassign a profile through table grants.
CREATE FUNCTION app.data_permission_admin_lock() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'changed' USING ERRCODE='40001';END IF;
 IF app.current_tenant_id() IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||app.current_tenant_id()::text,0));
 IF NOT app.principal_snapshot_current() OR NOT app.access_capability_allowed('access.configure',NULL) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
END;
$$;
REVOKE ALL ON FUNCTION app.data_permission_admin_lock() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.data_permission_delegate(rules jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE held jsonb; bound jsonb; proposed jsonb; entry text;
BEGIN
 IF NOT app.data_permission_rules_valid(rules) THEN RETURN false;END IF;
 -- A company predicate proves the ceiling only when every listed subtree is held. A predicate-free
 -- company preset additionally covers future companies, requiring an existing tenant-wide role.
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(rules->'predicates')r WHERE r->>'field'='company') THEN
  FOR entry IN SELECT jsonb_array_elements_text(r->'values') FROM jsonb_array_elements(rules->'predicates')r WHERE r->>'field'='company' LOOP
   IF NOT app.access_workforce_company(entry::uuid,'workforce.view') THEN RETURN false;END IF;
  END LOOP;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM public.role_assignment r WHERE r.app_user_id=app.current_user_id() AND r.tenant_id=app.current_tenant_id()
    AND r.company_id IS NULL AND r.role::text IN ('hr_admin','super_admin')) OR NOT app.access_can_delegate('workforce.view',NULL) THEN RETURN false;END IF;
 END IF;
 SELECT rev.rules INTO held FROM public.user_data_permission_assignment a JOIN public.data_permission_profile p ON p.id=a.profile_id AND p.tenant_id=a.tenant_id
 JOIN public.data_permission_revision rev ON rev.id=p.active_revision_id AND rev.tenant_id=p.tenant_id AND rev.profile_id=p.id
 WHERE a.user_id=app.current_user_id() AND a.tenant_id=app.current_tenant_id() AND p.enabled AND p.retired_at IS NULL;
 IF NOT FOUND THEN RETURN NOT EXISTS(SELECT 1 FROM public.user_data_permission_assignment a WHERE a.user_id=app.current_user_id() AND a.tenant_id=app.current_tenant_id());END IF;
 IF NOT app.data_permission_rules_valid(held) THEN RETURN false;END IF;
 IF (held->>'legacyCompany')::boolean THEN RETURN true;END IF;
 FOR bound IN SELECT value FROM jsonb_array_elements(held->'predicates') LOOP
  SELECT value INTO proposed FROM jsonb_array_elements(rules->'predicates')r WHERE r->>'field'=bound->>'field';
  IF proposed IS NULL THEN RETURN false;END IF;
  IF bound->>'field'='company' THEN
   IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(proposed->'values')v WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(bound->'values')h WHERE app.access_scope_covers(h::uuid,v::uuid,app.current_tenant_id()))) THEN RETURN false;END IF;
  ELSIF EXISTS(SELECT 1 FROM jsonb_array_elements_text(proposed->'values')v WHERE NOT (bound->'values' ? v)) THEN RETURN false;END IF;
 END LOOP;RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION app.data_permission_delegate(jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.data_permission_fingerprint() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT encode(sha256(convert_to(jsonb_build_object('access',app.access_scope_fingerprint(),
 'configuration',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.tenant_id),'[]'::jsonb) FROM public.access_configuration c WHERE c.tenant_id=app.current_tenant_id()),
 'groups',(SELECT coalesce(jsonb_agg(to_jsonb(g) ORDER BY g.id),'[]'::jsonb) FROM public.access_group g WHERE g.tenant_id=app.current_tenant_id()),
 'grants',(SELECT coalesce(jsonb_agg(to_jsonb(g) ORDER BY g.id),'[]'::jsonb) FROM public.access_group_grant g WHERE g.tenant_id=app.current_tenant_id()),
 'memberships',(SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.id),'[]'::jsonb) FROM public.access_membership m WHERE m.tenant_id=app.current_tenant_id()),
 'overrides',(SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY o.id),'[]'::jsonb) FROM public.access_user_override o WHERE o.tenant_id=app.current_tenant_id()),
 'profiles',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.id),'[]'::jsonb) FROM public.data_permission_profile p WHERE p.tenant_id=app.current_tenant_id()),
 'revisions',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]'::jsonb) FROM public.data_permission_revision r WHERE r.tenant_id=app.current_tenant_id()),
 'assignments',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.user_id),'[]'::jsonb) FROM public.user_data_permission_assignment a WHERE a.tenant_id=app.current_tenant_id()),
 'subjects',(SELECT coalesce(jsonb_agg(app.data_permission_subject(e.id) ORDER BY e.id),'[]'::jsonb) FROM public.employment e WHERE e.tenant_id=app.current_tenant_id())
 )::text,'UTF8')),'hex');
$$;
REVOKE ALL ON FUNCTION app.data_permission_fingerprint() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.data_permission_inspect(rules jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.data_permission_delegate(rules) AND NOT EXISTS(
  SELECT 1 FROM jsonb_array_elements(rules->'predicates')rule CROSS JOIN LATERAL jsonb_array_elements_text(rule->'values')value
  WHERE rule->>'field'='employeeId' AND NOT EXISTS(SELECT 1 FROM public.employment e
   WHERE e.tenant_id=app.current_tenant_id() AND e.employee_code=value
    AND app.access_workforce_employment(e.id,'workforce.view') AND app.data_permission_matches(e.id)));
$$;
REVOKE ALL ON FUNCTION app.data_permission_inspect(jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.data_permission_option_label(field text,value text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(CASE field
 WHEN 'company' THEN (SELECT legal_name FROM public.company WHERE id=value::uuid AND tenant_id=app.current_tenant_id())
 WHEN 'businessUnit' THEN (SELECT coalesce(nullif(label,''),name) FROM public.business_unit WHERE id=value::uuid AND tenant_id=app.current_tenant_id())
 WHEN 'department' THEN (SELECT coalesce(nullif(label,''),name) FROM public.department WHERE id=value::uuid AND tenant_id=app.current_tenant_id())
 WHEN 'position' THEN (SELECT coalesce(nullif(label,''),title) FROM public.position WHERE id=value::uuid AND tenant_id=app.current_tenant_id())
 WHEN 'grade' THEN (SELECT name FROM public.job_grade WHERE id=value::uuid AND tenant_id=app.current_tenant_id())
 WHEN 'costCentre' THEN (SELECT name FROM public.cost_center WHERE id=value::uuid AND tenant_id=app.current_tenant_id())
 ELSE value END,value);
$$;
REVOKE ALL ON FUNCTION app.data_permission_option_label(text,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.data_permission_state() RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 PERFORM app.data_permission_admin_lock();
 SELECT jsonb_build_object('revision',app.data_permission_fingerprint(),
 'profiles',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'revision',p.revision,'enabled',p.enabled,
   'rules',CASE WHEN app.data_permission_inspect(r.rules) THEN r.rules ELSE NULL END,'editable',app.data_permission_inspect(r.rules),'assignedCount',(SELECT count(*) FROM public.user_data_permission_assignment a WHERE a.profile_id=p.id AND a.tenant_id=p.tenant_id)) ORDER BY p.name,p.id),'[]'::jsonb)
  FROM public.data_permission_profile p LEFT JOIN public.data_permission_revision r ON r.id=p.active_revision_id AND r.profile_id=p.id AND r.tenant_id=p.tenant_id
  WHERE p.tenant_id=app.current_tenant_id() AND p.retired_at IS NULL),
 'assignments',(SELECT coalesce(jsonb_agg(jsonb_build_object('userId',a.user_id,'profileId',a.profile_id) ORDER BY a.user_id),'[]'::jsonb) FROM public.user_data_permission_assignment a WHERE a.tenant_id=app.current_tenant_id()),
 'options',(SELECT coalesce(jsonb_agg(jsonb_build_object('field',field,'value',value,'label',app.data_permission_option_label(field,value)) ORDER BY field,value),'[]'::jsonb) FROM (
   SELECT DISTINCT entry.key AS field,entry.value FROM public.employment e
   CROSS JOIN LATERAL jsonb_each_text(app.data_permission_subject(e.id))entry
   WHERE e.tenant_id=app.current_tenant_id() AND app.access_workforce_employment(e.id,'workforce.view')
    AND app.data_permission_matches(e.id) AND entry.value IS NOT NULL AND entry.key<>'tenant')options)
 ) INTO result;RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION app.data_permission_state() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.data_permission_state() TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.data_permission_target_ceiling(p_user uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE scope uuid;held jsonb;
BEGIN
 -- Existing function and company authority of the edited account must fit the actor's ceiling too.
 FOR scope IN SELECT r.company_id FROM public.role_assignment r WHERE r.app_user_id=p_user AND r.tenant_id=app.current_tenant_id()
  AND r.role::text IN ('hr_admin','super_admin','payroll_partner','performance_comp_partner')
 UNION SELECT CASE WHEN g.company_id IS NULL THEN m.company_id WHEN m.company_id IS NULL THEN g.company_id
   WHEN app.access_scope_covers(g.company_id,m.company_id,m.tenant_id) THEN m.company_id ELSE g.company_id END
 FROM public.access_effective_membership m JOIN public.access_group_grant g ON g.group_id=m.group_id AND g.tenant_id=m.tenant_id AND g.retired_at IS NULL
 WHERE m.user_id=p_user AND m.tenant_id=app.current_tenant_id() AND g.capability_id IN ('workforce.view','workforce.maintain')
 UNION SELECT o.company_id FROM public.access_user_override o WHERE o.user_id=p_user AND o.tenant_id=app.current_tenant_id()
  AND o.effect='allow' AND o.retired_at IS NULL AND o.capability_id IN ('workforce.view','workforce.maintain') LOOP
  IF NOT app.access_can_delegate('workforce.view',scope) THEN RETURN false;END IF;
 END LOOP;
 SELECT r.rules INTO held FROM public.user_data_permission_assignment a JOIN public.data_permission_profile p ON p.id=a.profile_id AND p.tenant_id=a.tenant_id
  JOIN public.data_permission_revision r ON r.id=p.active_revision_id AND r.profile_id=p.id AND r.tenant_id=p.tenant_id
  WHERE a.user_id=p_user AND a.tenant_id=app.current_tenant_id() AND p.enabled AND p.retired_at IS NULL;
 IF FOUND THEN RETURN app.data_permission_delegate(held);END IF;
 RETURN NOT EXISTS(SELECT 1 FROM public.user_data_permission_assignment a WHERE a.user_id=p_user AND a.tenant_id=app.current_tenant_id());
END;
$$;
REVOKE ALL ON FUNCTION app.data_permission_target_ceiling(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.data_permission_protected(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.access_effective_membership m JOIN public.access_group g ON g.id=m.group_id AND g.tenant_id=m.tenant_id
 WHERE m.user_id=p_user AND m.tenant_id=app.current_tenant_id() AND g.system_administrator AND g.retired_at IS NULL);
$$;
REVOKE ALL ON FUNCTION app.data_permission_protected(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.data_permission_transition(command jsonb,expected_revision text,commit_change boolean DEFAULT false,expected_preview text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();p public.data_permission_profile;
 kind text:=command->>'kind';pid uuid;uid uuid;rules jsonb;fingerprint text;revision_id uuid:=gen_random_uuid();affected integer;matched integer;
BEGIN
 PERFORM app.data_permission_admin_lock();
 IF jsonb_typeof(command)<>'object' OR length(command::text)>100000 OR expected_revision IS DISTINCT FROM app.data_permission_fingerprint() THEN RAISE EXCEPTION 'changed' USING ERRCODE='40001';END IF;
 IF kind IN ('create','edit') THEN
  IF NOT app.access_command_keys(command,ARRAY['kind','profileId','name','enabled','rules'])
   OR jsonb_typeof(command->'name')<>'string' OR length(btrim(command->>'name')) NOT BETWEEN 1 AND 100
   OR command->>'name'<>btrim(command->>'name') OR command->>'name' ~ '[[:cntrl:]]'
   OR jsonb_typeof(command->'enabled')<>'boolean' OR NOT app.data_permission_rules_valid(command->'rules') THEN RAISE EXCEPTION 'invalid' USING ERRCODE='23514';END IF;
  pid:=(command->>'profileId')::uuid;rules:=command->'rules';
  IF pid IS NULL THEN RAISE EXCEPTION 'invalid' USING ERRCODE='23514';END IF;
  IF NOT app.data_permission_delegate(rules) THEN RAISE EXCEPTION 'ceiling' USING ERRCODE='42501';END IF;
  SELECT * INTO p FROM public.data_permission_profile WHERE tenant_id=t AND id=pid AND retired_at IS NULL FOR UPDATE;
  IF kind='edit' AND NOT app.data_permission_delegate((SELECT r.rules FROM public.data_permission_revision r WHERE r.id=p.active_revision_id AND r.profile_id=p.id AND r.tenant_id=t)) THEN RAISE EXCEPTION 'ceiling' USING ERRCODE='42501';END IF;
  IF kind='create' AND p.id IS NOT NULL OR kind='edit' AND p.id IS NULL THEN RAISE EXCEPTION 'invalid' USING ERRCODE='23514';END IF;
  IF kind='edit' AND EXISTS(SELECT 1 FROM public.user_data_permission_assignment a WHERE a.profile_id=pid AND a.tenant_id=t
    AND (NOT app.data_permission_target_ceiling(a.user_id) OR app.data_permission_protected(a.user_id) AND (NOT (command->>'enabled')::boolean OR NOT (rules->>'legacyCompany')::boolean))) THEN RAISE EXCEPTION 'ceiling' USING ERRCODE='42501';END IF;
  IF kind='create' AND (SELECT count(*) FROM public.data_permission_profile WHERE tenant_id=t AND retired_at IS NULL)>=256 THEN RAISE EXCEPTION 'invalid' USING ERRCODE='23514';END IF;
 ELSIF kind='retire' THEN
  IF NOT app.access_command_keys(command,ARRAY['kind','profileId']) THEN RAISE EXCEPTION 'invalid' USING ERRCODE='23514';END IF;
  pid:=(command->>'profileId')::uuid;
  IF pid IS NULL THEN RAISE EXCEPTION 'invalid' USING ERRCODE='23514';END IF;
  SELECT * INTO p FROM public.data_permission_profile WHERE tenant_id=t AND id=pid AND retired_at IS NULL FOR UPDATE;
  IF p.id IS NULL THEN RAISE EXCEPTION 'invalid' USING ERRCODE='23514';END IF;
  IF NOT app.data_permission_delegate((SELECT r.rules FROM public.data_permission_revision r WHERE r.id=p.active_revision_id AND r.profile_id=p.id AND r.tenant_id=t)) THEN RAISE EXCEPTION 'ceiling' USING ERRCODE='42501';END IF;
  IF EXISTS(SELECT 1 FROM public.user_data_permission_assignment a WHERE a.profile_id=p.id AND a.tenant_id=t) THEN RAISE EXCEPTION 'assigned' USING ERRCODE='23514';END IF;
 ELSIF kind='assign' THEN
  IF NOT app.access_command_keys(command,ARRAY['kind','userId','profileId']) OR jsonb_typeof(command->'profileId') NOT IN ('string','null') THEN RAISE EXCEPTION 'invalid' USING ERRCODE='23514';END IF;
  uid:=(command->>'userId')::uuid;pid:=(command->>'profileId')::uuid;
  IF NOT EXISTS(SELECT 1 FROM public.app_user a WHERE a.id=uid AND a.tenant_id=t AND a.archived_at IS NULL AND NOT app.login_blocked(a.id)) THEN RAISE EXCEPTION 'invalid' USING ERRCODE='23514';END IF;
  IF pid IS NULL THEN rules:='{"legacyCompany":true,"predicates":[]}'::jsonb;
  ELSE
   SELECT * INTO p FROM public.data_permission_profile WHERE tenant_id=t AND id=pid AND retired_at IS NULL AND enabled FOR UPDATE;
   IF p.id IS NULL THEN RAISE EXCEPTION 'invalid' USING ERRCODE='23514';END IF;
   SELECT r.rules INTO rules FROM public.data_permission_revision r WHERE r.id=p.active_revision_id AND r.profile_id=p.id AND r.tenant_id=t;
  END IF;
  IF NOT app.data_permission_delegate(rules) OR NOT app.data_permission_target_ceiling(uid)
   OR pid IS NOT NULL AND app.data_permission_protected(uid) AND NOT (rules->>'legacyCompany')::boolean THEN RAISE EXCEPTION 'ceiling' USING ERRCODE='42501';END IF;
 ELSE RAISE EXCEPTION 'invalid' USING ERRCODE='23514';END IF;
 fingerprint:=encode(sha256(convert_to(expected_revision||':'||u::text||':'||command::text,'UTF8')),'hex');
 SELECT count(*) INTO affected FROM public.user_data_permission_assignment a WHERE a.tenant_id=t AND a.profile_id=pid;
 -- Only count subjects the acting administrator can already inspect; no hidden employee totals.
 SELECT count(*) INTO matched FROM public.employment e WHERE e.tenant_id=t AND app.access_workforce_employment(e.id,'workforce.view')
  AND app.data_permission_matches(e.id) AND rules IS NOT NULL AND app.data_permission_rules_match(rules,app.data_permission_subject(e.id));
 IF NOT commit_change THEN RETURN jsonb_build_object('fingerprint',fingerprint,'affectedUsers',CASE WHEN kind='assign' THEN 1 ELSE affected END,'matchingRecords',matched);END IF;
 IF fingerprint IS DISTINCT FROM expected_preview THEN RAISE EXCEPTION 'changed' USING ERRCODE='40001';END IF;
 IF kind='create' THEN
  INSERT INTO public.data_permission_profile(id,tenant_id,name) VALUES(pid,t,command->>'name');
 END IF;
 IF kind IN ('create','edit') THEN
  INSERT INTO public.data_permission_revision(id,tenant_id,profile_id,rules,created_by) VALUES(revision_id,t,pid,rules,u);
  UPDATE public.data_permission_profile SET name=command->>'name',enabled=(command->>'enabled')::boolean,active_revision_id=revision_id,revision=gen_random_uuid() WHERE id=pid AND tenant_id=t;
 ELSIF kind='retire' THEN UPDATE public.data_permission_profile SET retired_at=now(),enabled=false,revision=gen_random_uuid() WHERE id=pid AND tenant_id=t;
 ELSIF kind='assign' THEN
  IF pid IS NULL THEN DELETE FROM public.user_data_permission_assignment WHERE user_id=uid AND tenant_id=t;
  ELSE INSERT INTO public.user_data_permission_assignment(tenant_id,user_id,profile_id,assigned_by) VALUES(t,uid,pid,u)
   ON CONFLICT(tenant_id,user_id) DO UPDATE SET profile_id=excluded.profile_id,assigned_by=u,assigned_at=now(),revision=gen_random_uuid();END IF;
 END IF;
 PERFORM app.append_auth_event(t,'data-permission',coalesce(pid,uid),CASE kind WHEN 'assign' THEN 'data-permission.assigned' ELSE 'data-permission.'||kind END,'user',u,jsonb_build_object('affectedUsers',affected,'predicateFields',CASE WHEN rules IS NOT NULL THEN jsonb_array_length(rules->'predicates') ELSE 0 END));
 RETURN jsonb_build_object('revision',app.data_permission_fingerprint());
END;
$$;
REVOKE ALL ON FUNCTION app.data_permission_transition(jsonb,text,boolean,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.data_permission_transition(jsonb,text,boolean,text) TO ai_hr_app;

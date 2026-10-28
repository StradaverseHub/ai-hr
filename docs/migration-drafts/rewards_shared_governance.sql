-- Approved c087a302 / df0eb31a. Source draft only; coordinator must allocate journal position and timestamp.
-- Match JavaScript String.trim's whitespace set at the native write boundary as well.
CREATE FUNCTION app.reward_exclusion_reason_trim(value text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT btrim(value,chr(9)||chr(10)||chr(11)||chr(12)||chr(13)||chr(32)||chr(160)||chr(5760)||
 chr(8192)||chr(8193)||chr(8194)||chr(8195)||chr(8196)||chr(8197)||chr(8198)||chr(8199)||chr(8200)||chr(8201)||chr(8202)||
 chr(8232)||chr(8233)||chr(8239)||chr(8287)||chr(12288)||chr(65279))
$$;
REVOKE ALL ON FUNCTION app.reward_exclusion_reason_trim(text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE TABLE reward_company_exclusion (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id),
 company_id uuid NOT NULL REFERENCES company(id), year integer NOT NULL CHECK(year BETWEEN 2000 AND 2200),
 reason text NOT NULL CHECK(length(app.reward_exclusion_reason_trim(reason)) BETWEEN 10 AND 2000),
 created_by uuid NOT NULL REFERENCES app_user(id), created_at timestamptz NOT NULL DEFAULT now(),
 ended_by uuid REFERENCES app_user(id), ended_at timestamptz, end_reason text,
 CHECK((ended_at IS NULL AND ended_by IS NULL AND end_reason IS NULL) OR
 (ended_at IS NOT NULL AND ended_by IS NOT NULL AND end_reason IS NOT NULL AND length(app.reward_exclusion_reason_trim(end_reason)) BETWEEN 10 AND 2000))
);
--> statement-breakpoint
CREATE UNIQUE INDEX reward_company_exclusion_active ON reward_company_exclusion(tenant_id,company_id,year) WHERE ended_at IS NULL;
--> statement-breakpoint
ALTER TABLE reward_company_exclusion ENABLE ROW LEVEL SECURITY;
ALTER TABLE reward_company_exclusion FORCE ROW LEVEL SECURITY;
REVOKE ALL ON reward_company_exclusion FROM PUBLIC,ai_hr_app;
GRANT SELECT ON reward_company_exclusion TO ai_hr_app;
CREATE POLICY reward_company_exclusion_read ON reward_company_exclusion FOR SELECT USING (
 tenant_id=app.current_tenant_id() AND (current_user<>'ai_hr_app' OR app.reward_admin(company_id)));
CREATE POLICY reward_company_exclusion_insert ON reward_company_exclusion FOR INSERT WITH CHECK (
 tenant_id=app.current_tenant_id() AND current_user<>'ai_hr_app' AND app.reward_admin(company_id));
CREATE POLICY reward_company_exclusion_update ON reward_company_exclusion FOR UPDATE USING (
 tenant_id=app.current_tenant_id() AND current_user<>'ai_hr_app' AND app.reward_admin(company_id)) WITH CHECK (
 tenant_id=app.current_tenant_id() AND current_user<>'ai_hr_app' AND app.reward_admin(company_id));
--> statement-breakpoint
CREATE FUNCTION app.reward_company_available(p_company uuid,p_year integer) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT p_year IS NOT NULL AND p_year BETWEEN 2000 AND 2200 AND EXISTS(SELECT 1 FROM public.company c WHERE c.id=p_company AND c.tenant_id=app.current_tenant_id() AND c.archived_at IS NULL)
 AND NOT EXISTS(SELECT 1 FROM public.reward_company_exclusion e WHERE e.tenant_id=app.current_tenant_id() AND e.company_id=p_company AND e.year=p_year AND e.ended_at IS NULL)
$$;
REVOKE ALL ON FUNCTION app.reward_company_available(uuid,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.reward_company_available(uuid,integer) FROM ai_hr_app;
--> statement-breakpoint
-- The application may ask about a company it administers; native guards use the private predicate.
CREATE FUNCTION app.reward_company_admin_available(p_company uuid,p_year integer) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.reward_admin(p_company) AND app.reward_company_available(p_company,p_year)
$$;
REVOKE ALL ON FUNCTION app.reward_company_admin_available(uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_company_admin_available(uuid,integer) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.reward_company_exclusion_change(p_company uuid,p_year integer,p_reason text,p_end_id uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id(); actor uuid:=app.current_user_id(); result uuid; event_name text;
BEGIN
 PERFORM app.access_workforce_write_lock();
 IF actor IS NULL OR NOT app.reward_admin(p_company) OR NOT EXISTS(SELECT 1 FROM public.company c WHERE c.id=p_company AND c.tenant_id=t)
 THEN RAISE EXCEPTION 'Rewards company permission required' USING ERRCODE='42501'; END IF;
 IF p_year IS NULL OR p_year NOT BETWEEN 2000 AND 2200 OR p_reason IS NULL OR length(app.reward_exclusion_reason_trim(p_reason)) NOT BETWEEN 10 AND 2000
 THEN RAISE EXCEPTION 'A reward year and reason of 10 to 2000 characters are required' USING ERRCODE='23514'; END IF;
 IF p_end_id IS NULL THEN
  INSERT INTO public.reward_company_exclusion(tenant_id,company_id,year,reason,created_by) VALUES(t,p_company,p_year,app.reward_exclusion_reason_trim(p_reason),actor) RETURNING id INTO result;
  event_name:='reward.company-excluded';
 ELSE
  UPDATE public.reward_company_exclusion SET ended_by=actor,ended_at=now(),end_reason=app.reward_exclusion_reason_trim(p_reason)
   WHERE id=p_end_id AND tenant_id=t AND company_id=p_company AND year=p_year AND ended_at IS NULL RETURNING id INTO result;
  IF result IS NULL THEN RAISE EXCEPTION 'Company exclusion changed' USING ERRCODE='40001'; END IF;
  event_name:='reward.company-exclusion-ended';
 END IF;
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
 VALUES(t,'reward-company-exclusion',result,event_name,'user',actor,jsonb_build_object('companyId',p_company,'year',p_year,'reason',app.reward_exclusion_reason_trim(p_reason)));
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.reward_company_exclusion_change(uuid,integer,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_company_exclusion_change(uuid,integer,text,uuid) TO ai_hr_app;
--> statement-breakpoint
-- A final native check covers direct SQL writers as well as both service entry points. It serializes
-- with exclusions and shared-policy saves. Existing review updates and historical targets are preserved.
CREATE FUNCTION app.reward_company_new_assignment_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE wanted_year integer; wanted_company uuid;
BEGIN
 PERFORM app.access_workforce_write_lock();
 IF TG_TABLE_NAME='reward_unit' THEN
  wanted_company:=NEW.company_id;wanted_year:=(NEW.policy->>'year')::integer;
 ELSE
  wanted_company:=NEW.company_id;
  SELECT (v.policy->>'year')::integer INTO wanted_year FROM public.reward_policy_group_version v WHERE v.id=NEW.version_id AND v.tenant_id=NEW.tenant_id;
 END IF;
 IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NOT app.reward_company_available(wanted_company,wanted_year)
 THEN RAISE EXCEPTION 'Company is archived or excluded from this reward year' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.reward_company_new_assignment_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER reward_unit_company_available BEFORE INSERT ON reward_unit FOR EACH ROW EXECUTE FUNCTION app.reward_company_new_assignment_guard();
CREATE TRIGGER reward_policy_target_company_available BEFORE INSERT ON reward_policy_group_target FOR EACH ROW EXECUTE FUNCTION app.reward_company_new_assignment_guard();
--> statement-breakpoint
-- Current group authority never licenses reading a historical version containing a company the actor
-- no longer administers. Empty archived versions inherit the group's non-vacuous current authority.
CREATE FUNCTION app.reward_policy_group_versions(p_group uuid) RETURNS SETOF jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('version',app.reward_policy_group_version_json(v.id),'savedAt',v.created_at,
 'savedBy',p.full_name,'current',g.current_version_id=v.id,
 'locked',EXISTS(SELECT 1 FROM public.reward_unit r WHERE r.tenant_id=v.tenant_id AND r.policy_group_version_id=v.id AND r.status<>'draft' AND r.deleted_at IS NULL),
 'usageCount',(SELECT count(*) FROM public.reward_unit r WHERE r.tenant_id=v.tenant_id AND r.policy_group_version_id=v.id AND r.deleted_at IS NULL))
 FROM public.reward_policy_group g JOIN public.reward_policy_group_version v ON v.group_id=g.id AND v.tenant_id=g.tenant_id
 LEFT JOIN public.app_user u ON u.id=v.created_by AND u.tenant_id=v.tenant_id
 LEFT JOIN public.person p ON p.id=u.person_id AND p.tenant_id=v.tenant_id AND app.access_workforce_person(p.id,'workforce.view')
 WHERE g.id=p_group AND g.tenant_id=app.current_tenant_id() AND app.reward_policy_group_authorised(g.id)
 AND NOT EXISTS(SELECT 1 FROM public.reward_policy_group_target x WHERE x.version_id=v.id AND x.tenant_id=v.tenant_id AND NOT app.reward_admin(x.company_id))
 ORDER BY v.revision DESC
$$;
REVOKE ALL ON FUNCTION app.reward_policy_group_versions(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_policy_group_versions(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.reward_policy_group_hidden_count() RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN EXISTS(SELECT 1 FROM public.company c WHERE c.tenant_id=app.current_tenant_id() AND app.reward_admin(c.id))
 THEN (SELECT count(*)::integer FROM public.reward_policy_group g WHERE g.tenant_id=app.current_tenant_id() AND NOT app.reward_policy_group_authorised(g.id)) ELSE 0 END
$$;
REVOKE ALL ON FUNCTION app.reward_policy_group_hidden_count() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_policy_group_hidden_count() TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.reward_company_exclusion_audit_owner() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF (NEW.aggregate_type='reward-company-exclusion' OR NEW.event_type IN ('reward.company-excluded','reward.company-exclusion-ended')) AND NOT app.acting_as_owner()
 THEN RAISE EXCEPTION 'Reward exclusion audit requires its native writer' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.reward_company_exclusion_audit_owner() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER reward_company_exclusion_audit_owner BEFORE INSERT ON domain_event FOR EACH ROW EXECUTE FUNCTION app.reward_company_exclusion_audit_owner();

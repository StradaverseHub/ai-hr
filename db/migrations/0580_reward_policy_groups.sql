-- SOURCE DRAFT. Reserved0580@1791900000060, not journalled/applied before verified0576–0579 arrival.
-- Sharing configuration never shares a reward unit, roster, salary snapshot, budget or approval.
CREATE TABLE reward_policy_group (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),
 name text NOT NULL CHECK(name=btrim(name) AND length(name) BETWEEN 1 AND 100),
 revision integer NOT NULL CHECK(revision>0),current_version_id uuid NOT NULL,
 created_by uuid NOT NULL REFERENCES app_user(id),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX reward_policy_group_name_uq ON reward_policy_group(tenant_id,lower(name));
--> statement-breakpoint
CREATE TABLE reward_policy_group_version (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),group_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0),name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
 policy jsonb NOT NULL CHECK(jsonb_typeof(policy)='object' AND octet_length(policy::text)<=100000),
 policy_digest text NOT NULL CHECK(policy_digest ~ '^[a-f0-9]{64}$'),
 created_by uuid NOT NULL REFERENCES app_user(id),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,group_id,id),UNIQUE(group_id,revision),
 FOREIGN KEY(tenant_id,group_id) REFERENCES reward_policy_group(tenant_id,id) DEFERRABLE INITIALLY DEFERRED
);
--> statement-breakpoint
ALTER TABLE reward_policy_group ADD CONSTRAINT reward_policy_group_head_fk
 FOREIGN KEY(tenant_id,id,current_version_id) REFERENCES reward_policy_group_version(tenant_id,group_id,id) DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
CREATE TABLE reward_policy_group_target (
 tenant_id uuid NOT NULL REFERENCES tenant(id),version_id uuid NOT NULL,
 company_id uuid NOT NULL REFERENCES company(id),business_unit_id uuid NOT NULL REFERENCES business_unit(id),
 PRIMARY KEY(version_id,company_id,business_unit_id),
 FOREIGN KEY(tenant_id,version_id) REFERENCES reward_policy_group_version(tenant_id,id)
);
--> statement-breakpoint
ALTER TABLE reward_unit ADD COLUMN policy_group_version_id uuid;
--> statement-breakpoint
ALTER TABLE reward_unit ADD CONSTRAINT reward_unit_policy_group_version_fk
 FOREIGN KEY(tenant_id,policy_group_version_id) REFERENCES reward_policy_group_version(tenant_id,id);
--> statement-breakpoint
ALTER TABLE reward_policy_group ENABLE ROW LEVEL SECURITY;
ALTER TABLE reward_policy_group FORCE ROW LEVEL SECURITY;
ALTER TABLE reward_policy_group_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE reward_policy_group_version FORCE ROW LEVEL SECURITY;
ALTER TABLE reward_policy_group_target ENABLE ROW LEVEL SECURITY;
ALTER TABLE reward_policy_group_target FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY reward_policy_group_owner ON reward_policy_group FOR ALL USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
CREATE POLICY reward_policy_group_version_owner ON reward_policy_group_version FOR ALL USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
CREATE POLICY reward_policy_group_target_owner ON reward_policy_group_target FOR ALL USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
--> statement-breakpoint
REVOKE ALL ON reward_policy_group,reward_policy_group_version,reward_policy_group_target FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- The same compatibility predicate as0524's reward_unit link guard. It is deliberately about a pair,
-- not all selected companies multiplied by all selected units. Shared/global units remain explicit.
CREATE FUNCTION app.reward_policy_pair_valid(t uuid,c uuid,b uuid,p_shared boolean DEFAULT true) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.company x JOIN public.business_unit u ON u.tenant_id=x.tenant_id
  WHERE x.id=c AND x.tenant_id=t AND u.id=b AND u.archived_at IS NULL AND (u.company_id=x.id OR u.is_global)
   AND (NOT p_shared OR x.currency='MYR'));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.reward_policy_pair_valid(uuid,uuid,uuid,boolean) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.reward_policy_version_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN RAISE EXCEPTION 'reward policy versions are immutable' USING ERRCODE='23514'; END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.reward_policy_version_immutable() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE TRIGGER reward_policy_version_immutable BEFORE UPDATE OR DELETE ON reward_policy_group_version FOR EACH ROW EXECUTE FUNCTION app.reward_policy_version_immutable();
CREATE TRIGGER reward_policy_target_immutable BEFORE UPDATE OR DELETE ON reward_policy_group_target FOR EACH ROW EXECUTE FUNCTION app.reward_policy_version_immutable();
--> statement-breakpoint
CREATE FUNCTION app.reward_policy_group_version_json(p_version uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('groupId',v.group_id,'versionId',v.id,'revision',v.revision,'name',v.name,'policy',v.policy,
  'targets',COALESCE((SELECT jsonb_agg(jsonb_build_object('companyId',t.company_id,'businessUnitId',t.business_unit_id) ORDER BY t.company_id,t.business_unit_id)
   FROM public.reward_policy_group_target t WHERE t.tenant_id=v.tenant_id AND t.version_id=v.id),'[]'::jsonb))
 FROM public.reward_policy_group_version v WHERE v.id=p_version AND v.tenant_id=app.current_tenant_id();
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.reward_policy_group_version_json(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- An empty head archives future assignment. The latest non-empty version retains the authority
-- needed to read/edit that archived configuration; an empty set never creates a vacuous permission.
CREATE FUNCTION app.reward_policy_group_authorised(p_group uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH scope_version AS (
  SELECT v.id FROM public.reward_policy_group_version v WHERE v.group_id=p_group AND v.tenant_id=app.current_tenant_id()
   AND EXISTS(SELECT 1 FROM public.reward_policy_group_target x WHERE x.version_id=v.id AND x.tenant_id=v.tenant_id)
  ORDER BY v.revision DESC LIMIT 1
 ) SELECT EXISTS(SELECT 1 FROM scope_version)
  AND NOT EXISTS(SELECT 1 FROM public.reward_policy_group_target x JOIN scope_version v ON v.id=x.version_id
   WHERE x.tenant_id=app.current_tenant_id() AND NOT app.reward_admin(x.company_id));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.reward_policy_group_authorised(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Zod RewardPolicy is the semantic content owner before this write and on every app consumption.
-- SQL independently binds actual authority, references, revision, immutable storage and atomic audit.
CREATE FUNCTION app.reward_policy_group_commit(p_group uuid,p_expected integer,p_name text,p_policy jsonb,p_targets jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();actor uuid:=app.current_user_id();g public.reward_policy_group%ROWTYPE;
 version_id uuid:=gen_random_uuid();next_revision integer;target jsonb;c uuid;b uuid;group_id uuid;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0));
 IF actor IS NULL OR p_expected IS NULL OR p_expected<0 OR p_name IS NULL OR p_name<>btrim(p_name) OR length(p_name) NOT BETWEEN 1 AND 100
  OR p_policy IS NULL OR jsonb_typeof(p_policy)<>'object' OR octet_length(p_policy::text)>100000
  OR COALESCE(p_policy->>'year','') !~ '^(20[0-9]{2}|21[0-9]{2}|2200)$'
  OR p_policy->>'seniorMembershipMode' IS DISTINCT FROM 'named-members' OR p_policy->'seniorGrades' IS DISTINCT FROM '[]'::jsonb
  OR p_policy->'lumpUnitCents' IS DISTINCT FROM 'null'::jsonb
  OR p_targets IS NULL OR jsonb_typeof(p_targets)<>'array' OR jsonb_array_length(p_targets)>500 OR (p_group IS NULL AND jsonb_array_length(p_targets)=0) THEN
  RAISE EXCEPTION 'reward policy group invalid' USING ERRCODE='23514'; END IF;
 IF p_group IS NULL THEN
  IF p_expected<>0 THEN RAISE EXCEPTION 'reward policy group changed' USING ERRCODE='40001'; END IF;
  group_id:=gen_random_uuid();next_revision:=1;
 ELSE
  SELECT * INTO g FROM public.reward_policy_group x WHERE x.id=p_group AND x.tenant_id=t FOR UPDATE;
  IF NOT FOUND OR g.revision<>p_expected THEN RAISE EXCEPTION 'reward policy group changed' USING ERRCODE='40001'; END IF;
  IF NOT app.reward_policy_group_authorised(g.id) THEN
   RAISE EXCEPTION 'reward policy group scope' USING ERRCODE='42501'; END IF;
  group_id:=g.id;next_revision:=g.revision+1;
 END IF;
 FOR target IN SELECT value FROM jsonb_array_elements(p_targets) LOOP
  IF jsonb_typeof(target)<>'object' OR NOT (target ?& ARRAY['companyId','businessUnitId']) OR (target-ARRAY['companyId','businessUnitId'])<>'{}'::jsonb THEN
   RAISE EXCEPTION 'reward policy group invalid' USING ERRCODE='23514'; END IF;
  c:=(target->>'companyId')::uuid;b:=(target->>'businessUnitId')::uuid;
  IF c IS NULL OR b IS NULL OR NOT app.reward_policy_pair_valid(t,c,b) OR NOT app.reward_admin(c) THEN
   RAISE EXCEPTION 'reward policy group scope' USING ERRCODE='42501'; END IF;
  IF EXISTS(SELECT 1 FROM public.reward_policy_group other_group
   JOIN public.reward_policy_group_version other_version ON other_version.id=other_group.current_version_id AND other_version.tenant_id=other_group.tenant_id
   JOIN public.reward_policy_group_target other_target ON other_target.version_id=other_version.id AND other_target.tenant_id=other_version.tenant_id
   WHERE other_group.tenant_id=t AND other_group.id IS DISTINCT FROM p_group AND other_target.company_id=c AND other_target.business_unit_id=b
    AND other_version.policy->>'year'=p_policy->>'year') THEN
   RAISE EXCEPTION 'reward policy group overlaps another current configuration' USING ERRCODE='23514'; END IF;
 END LOOP;
 IF (SELECT count(*) FROM jsonb_array_elements(p_targets))<>(SELECT count(DISTINCT jsonb_build_array(value->>'companyId',value->>'businessUnitId')) FROM jsonb_array_elements(p_targets)) THEN
  RAISE EXCEPTION 'reward policy group invalid' USING ERRCODE='23514'; END IF;
 IF p_group IS NULL THEN
  INSERT INTO public.reward_policy_group(id,tenant_id,name,revision,current_version_id,created_by) VALUES(group_id,t,p_name,next_revision,version_id,actor);
 END IF;
 INSERT INTO public.reward_policy_group_version(id,tenant_id,group_id,revision,name,policy,policy_digest,created_by)
  VALUES(version_id,t,group_id,next_revision,p_name,p_policy,encode(sha256(convert_to(p_policy::text,'UTF8')),'hex'),actor);
 INSERT INTO public.reward_policy_group_target(tenant_id,version_id,company_id,business_unit_id)
  SELECT t,version_id,(value->>'companyId')::uuid,(value->>'businessUnitId')::uuid FROM jsonb_array_elements(p_targets);
 IF p_group IS NOT NULL THEN UPDATE public.reward_policy_group SET name=p_name,revision=next_revision,current_version_id=version_id WHERE id=group_id AND tenant_id=t; END IF;
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
  VALUES(t,'reward-policy-group',group_id,'reward-policy-group.version-saved','user',actor,
   jsonb_build_object('beforeRevision',p_expected,'revision',next_revision,'versionId',version_id,'targets',p_targets,
    'policyDigest',encode(sha256(convert_to(p_policy::text,'UTF8')),'hex')));
 RETURN app.reward_policy_group_version_json(version_id);
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.reward_policy_group_commit(uuid,integer,text,jsonb,jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.reward_policy_group_commit(uuid,integer,text,jsonb,jsonb) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.reward_policy_groups() RETURNS SETOF jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.reward_policy_group_version_json(g.current_version_id) FROM public.reward_policy_group g
 WHERE g.tenant_id=app.current_tenant_id()
  AND app.reward_policy_group_authorised(g.id)
 ORDER BY lower(g.name),g.id LIMIT 1000;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.reward_policy_groups() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.reward_policy_groups() TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.reward_policy_choices(p_company uuid) RETURNS TABLE(group_id uuid,version_id uuid,revision integer,name text,year integer,business_unit_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT g.id,v.id,v.revision,v.name,(v.policy->>'year')::integer,x.business_unit_id
 FROM public.reward_policy_group g JOIN public.reward_policy_group_version v ON v.id=g.current_version_id AND v.tenant_id=g.tenant_id
 JOIN public.reward_policy_group_target x ON x.version_id=v.id AND x.tenant_id=v.tenant_id
 WHERE g.tenant_id=app.current_tenant_id() AND x.company_id=p_company AND app.reward_admin(p_company)
  AND app.reward_policy_pair_valid(g.tenant_id,p_company,x.business_unit_id)
 ORDER BY lower(v.name),v.id,x.business_unit_id;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.reward_policy_choices(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.reward_policy_choices(uuid) TO ai_hr_app;
--> statement-breakpoint
-- A creation holds the head stable for its whole transaction. A stale selected version refuses;
-- historical bindings remain readable on the already-created individual unit without a live fan-out.
CREATE FUNCTION app.reward_policy_for_new_unit(p_version uuid,p_company uuid,p_bu uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE g public.reward_policy_group%ROWTYPE;v public.reward_policy_group_version%ROWTYPE;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||app.current_tenant_id()::text,0));
 SELECT x.* INTO g FROM public.reward_policy_group x WHERE x.tenant_id=app.current_tenant_id() AND x.current_version_id=p_version FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'reward policy group changed' USING ERRCODE='40001'; END IF;
 SELECT * INTO v FROM public.reward_policy_group_version x WHERE x.id=p_version AND x.tenant_id=g.tenant_id;
 IF NOT app.reward_admin(p_company) OR NOT app.reward_policy_pair_valid(g.tenant_id,p_company,p_bu)
  OR NOT EXISTS(SELECT 1 FROM public.reward_policy_group_target x WHERE x.tenant_id=g.tenant_id AND x.version_id=v.id AND x.company_id=p_company AND x.business_unit_id=p_bu) THEN
  RAISE EXCEPTION 'reward policy group scope' USING ERRCODE='42501'; END IF;
 RETURN jsonb_build_object('groupId',g.id,'versionId',v.id,'revision',v.revision,'name',v.name,'policy',v.policy);
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.reward_policy_for_new_unit(uuid,uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.reward_policy_for_new_unit(uuid,uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
-- Each future annual company/unit/year has one shared policy owner. Omitting the selected version
-- cannot bypass the assignment, and an update after the creator's preview requires a reload.
CREATE FUNCTION app.reward_policy_for_review(p_version uuid,p_company uuid,p_bu uuid,p_year integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actual uuid;matches integer;binding jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||app.current_tenant_id()::text,0));
 IF NOT app.reward_admin(p_company) OR NOT app.reward_policy_pair_valid(app.current_tenant_id(),p_company,p_bu,false) THEN
  RAISE EXCEPTION 'reward policy group scope' USING ERRCODE='42501'; END IF;
 SELECT count(*),(array_agg(v.id ORDER BY v.id))[1] INTO matches,actual
  FROM public.reward_policy_group g JOIN public.reward_policy_group_version v ON v.id=g.current_version_id AND v.tenant_id=g.tenant_id
  JOIN public.reward_policy_group_target x ON x.version_id=v.id AND x.tenant_id=v.tenant_id
  WHERE g.tenant_id=app.current_tenant_id() AND x.company_id=p_company AND x.business_unit_id=p_bu AND (v.policy->>'year')::integer=p_year;
 IF matches>1 THEN RAISE EXCEPTION 'reward policy group invalid' USING ERRCODE='23514'; END IF;
 IF actual IS DISTINCT FROM p_version THEN RAISE EXCEPTION 'reward policy group changed' USING ERRCODE='40001'; END IF;
 IF actual IS NULL THEN RETURN NULL; END IF;
 binding:=app.reward_policy_for_new_unit(actual,p_company,p_bu);
 RETURN binding;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.reward_policy_for_review(uuid,uuid,uuid,integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.reward_policy_for_review(uuid,uuid,uuid,integer) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.reward_policy_binding_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE binding jsonb;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.policy_group_version_id IS DISTINCT FROM OLD.policy_group_version_id THEN RAISE EXCEPTION 'reward policy lineage is immutable' USING ERRCODE='23514'; END IF;
 ELSIF NEW.kind='annual' THEN
  IF COALESCE(NEW.policy->>'year','') !~ '^(20[0-9]{2}|21[0-9]{2}|2200)$' THEN RAISE EXCEPTION 'reward policy year is invalid' USING ERRCODE='23514'; END IF;
  binding:=app.reward_policy_for_review(NEW.policy_group_version_id,NEW.company_id,NEW.business_unit_id,(NEW.policy->>'year')::integer);
  IF binding IS NOT NULL AND NEW.policy IS DISTINCT FROM binding->'policy' THEN RAISE EXCEPTION 'reward policy snapshot does not match selected version' USING ERRCODE='23514'; END IF;
 ELSIF NEW.policy_group_version_id IS NOT NULL THEN RAISE EXCEPTION 'shared policy binds only a future annual review' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.reward_policy_binding_guard() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE TRIGGER reward_policy_binding_guard BEFORE INSERT OR UPDATE ON reward_unit FOR EACH ROW EXECUTE FUNCTION app.reward_policy_binding_guard();
--> statement-breakpoint
CREATE FUNCTION app.reward_policy_group_company_in_use(p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.reward_admin(p_company) AND EXISTS(SELECT 1 FROM public.reward_policy_group_target x WHERE x.tenant_id=app.current_tenant_id() AND x.company_id=p_company);
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.reward_policy_group_company_in_use(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.reward_policy_group_company_in_use(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.reward_policy_group_source_company_in_use(p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.reward_admin(p_company) AND EXISTS(SELECT 1 FROM public.reward_policy_group_target x
  JOIN public.business_unit b ON b.id=x.business_unit_id AND b.tenant_id=x.tenant_id
  WHERE x.tenant_id=app.current_tenant_id() AND b.company_id=p_company);
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.reward_policy_group_source_company_in_use(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.reward_policy_group_source_company_in_use(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.reward_policy_group_usage(p_group uuid) RETURNS TABLE(unit_id uuid,cycle text,company text,business_unit text,status text,revision integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT r.id,c.name,co.legal_name,COALESCE(NULLIF(btrim(b.label),''),b.code),r.status,v.revision
 FROM public.reward_unit r JOIN public.reward_policy_group_version v ON v.id=r.policy_group_version_id AND v.tenant_id=r.tenant_id
 JOIN public.reward_cycle c ON c.id=r.cycle_id AND c.tenant_id=r.tenant_id
 JOIN public.company co ON co.id=r.company_id AND co.tenant_id=r.tenant_id
 JOIN public.business_unit b ON b.id=r.business_unit_id AND b.tenant_id=r.tenant_id
 WHERE r.tenant_id=app.current_tenant_id() AND v.group_id=p_group AND app.reward_admin(r.company_id)
  AND app.reward_policy_group_authorised(p_group)
 ORDER BY c.year DESC,c.name,r.id LIMIT 500;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.reward_policy_group_usage(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.reward_policy_group_usage(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.reward_policy_unit_origin(p_unit uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('versionId',v.id,'revision',v.revision,'name',v.name,'changed',r.policy IS DISTINCT FROM v.policy)
 FROM public.reward_unit r JOIN public.reward_policy_group_version v ON v.id=r.policy_group_version_id AND v.tenant_id=r.tenant_id
 WHERE r.id=p_unit AND r.tenant_id=app.current_tenant_id() AND app.reward_access(r.id);
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.reward_policy_unit_origin(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.reward_policy_unit_origin(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.reward_policy_audit_owner() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF (NEW.aggregate_type='reward-policy-group' OR NEW.event_type LIKE 'reward-policy-group.%') AND NOT app.acting_as_owner() THEN
  RAISE EXCEPTION 'reward policy audit owner required' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.reward_policy_audit_owner() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE TRIGGER reward_policy_audit_owner BEFORE INSERT ON domain_event FOR EACH ROW EXECUTE FUNCTION app.reward_policy_audit_owner();

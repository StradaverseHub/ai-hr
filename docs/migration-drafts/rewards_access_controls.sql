-- UNALLOCATED SOURCE DRAFT. Do not journal or apply until coordinated allocation.
ALTER TABLE reward_member ADD COLUMN valid_from date NOT NULL DEFAULT ((now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date);
ALTER TABLE reward_member ADD COLUMN valid_to date;
ALTER TABLE reward_member ADD COLUMN covers_user_id uuid REFERENCES app_user(id);
ALTER TABLE reward_member ADD COLUMN restored_reason text;
ALTER TABLE reward_member ADD COLUMN restored_fingerprint text;
ALTER TABLE reward_member ADD CONSTRAINT reward_member_window CHECK(valid_to IS NULL OR valid_to>=valid_from);
ALTER TABLE reward_member ADD CONSTRAINT reward_member_proxy_window CHECK(covers_user_id IS NULL OR (covers_user_id<>user_id AND valid_to IS NOT NULL));
ALTER TABLE reward_member ADD CONSTRAINT reward_member_restore_pair CHECK((restored_reason IS NULL)=(restored_fingerprint IS NULL));
--> statement-breakpoint
CREATE TABLE reward_access_request(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),
 changes jsonb NOT NULL CHECK(jsonb_typeof(changes)='array' AND jsonb_array_length(changes) BETWEEN 1 AND 500),
 unit_revisions jsonb NOT NULL,before_members jsonb NOT NULL,people_fingerprints jsonb NOT NULL,
 requested_by uuid NOT NULL REFERENCES app_user(id),requested_at timestamptz NOT NULL DEFAULT now(),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','lapsed')),
 decided_by uuid REFERENCES app_user(id),decided_at timestamptz,reason text,
 CHECK((status='pending')=(decided_at IS NULL)),CHECK(status<>'rejected' OR length(btrim(reason))>=10)
);
CREATE INDEX reward_access_request_pending_idx ON reward_access_request(tenant_id,requested_at) WHERE status='pending';
ALTER TABLE reward_access_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE reward_access_request FORCE ROW LEVEL SECURITY;
CREATE POLICY reward_access_request_owner ON reward_access_request FOR ALL USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
REVOKE ALL ON reward_access_request FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- The fingerprint is custody of the relevant People facts, not a timestamp that another writer can omit.
CREATE FUNCTION app.reward_member_people_fingerprint(wanted_user uuid,wanted_unit uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT encode(sha256(convert_to(jsonb_build_object('user',jsonb_build_array(u.id,u.person_id,u.archived_at),'scope',jsonb_build_array(r.company_id,r.business_unit_id),
 'employment',COALESCE((SELECT jsonb_agg(jsonb_build_array(e.id,e.company_id,e.tender_resignation_date,e.resignation_date,e.last_working_date,e.terminated_on,e.blacklisted_at,
 COALESCE((SELECT jsonb_agg(jsonb_build_array(a.id,a.business_unit_id,a.valid_from,a.valid_to,a.superseded_at) ORDER BY a.id) FROM public.assignment a WHERE a.employment_id=e.id AND a.tenant_id=e.tenant_id),'[]'::jsonb)) ORDER BY e.id)
 FROM public.employment e WHERE e.person_id=u.person_id AND e.tenant_id=u.tenant_id),'[]'::jsonb))::text,'UTF8')),'hex')
 FROM public.app_user u JOIN public.reward_unit r ON r.tenant_id=u.tenant_id
 WHERE u.id=wanted_user AND r.id=wanted_unit AND u.tenant_id=app.current_tenant_id();
$$;
REVOKE ALL ON FUNCTION app.reward_member_people_fingerprint(uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.reward_member_state(wanted_member uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE m public.reward_member;u public.app_user;r public.reward_unit;day date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;changed date;
BEGIN
 SELECT * INTO m FROM public.reward_member WHERE id=wanted_member AND tenant_id=app.current_tenant_id();
 IF m.id IS NULL THEN RETURN jsonb_build_object('reason','unavailable','on',day); END IF;
 SELECT * INTO u FROM public.app_user WHERE id=m.user_id AND tenant_id=m.tenant_id;
 SELECT * INTO r FROM public.reward_unit WHERE id=m.unit_id AND tenant_id=m.tenant_id;
 IF u.id IS NULL OR u.archived_at IS NOT NULL OR app.login_blocked(u.id) THEN
 SELECT least(min((e.blacklisted_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date),min(least(e.resignation_date,e.last_working_date,e.terminated_on))) INTO changed FROM public.employment e WHERE e.tenant_id=m.tenant_id AND e.person_id=u.person_id;
 RETURN jsonb_build_object('reason','login','on',COALESCE((u.archived_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date,changed,m.valid_from)); END IF;
 IF m.valid_from>day THEN RETURN jsonb_build_object('reason','future','on',m.valid_from); END IF;
 IF m.valid_to<day THEN RETURN jsonb_build_object('reason','expired','on',m.valid_to); END IF;
 -- A restore never overrides a disabled login or an access window. It expires on any People change.
 IF m.restored_fingerprint=app.reward_member_people_fingerprint(m.user_id,m.unit_id) THEN RETURN NULL; END IF;
 SELECT min(e.tender_resignation_date) INTO changed FROM public.employment e WHERE e.tenant_id=m.tenant_id AND e.person_id=u.person_id AND e.tender_resignation_date<=day
 AND (least(e.resignation_date,e.last_working_date,e.terminated_on) IS NULL OR day<=least(e.resignation_date,e.last_working_date,e.terminated_on));
 IF changed IS NOT NULL THEN RETURN jsonb_build_object('reason','notice','on',changed); END IF;
 -- BU authority follows the current employment and effective assignment. Group seats are not BU-bound.
 IF m.role='bu' AND NOT EXISTS(SELECT 1 FROM public.employment e JOIN public.assignment a ON a.employment_id=e.id AND a.tenant_id=e.tenant_id
 WHERE e.tenant_id=m.tenant_id AND e.person_id=u.person_id AND e.company_id=r.company_id AND e.hired_on<=day
 AND e.blacklisted_at IS NULL AND (least(e.resignation_date,e.last_working_date,e.terminated_on) IS NULL OR day<=least(e.resignation_date,e.last_working_date,e.terminated_on))
 AND a.business_unit_id=r.business_unit_id AND a.superseded_at IS NULL AND a.valid_from<=day AND (a.valid_to IS NULL OR day<a.valid_to)) THEN
 SELECT max(a.valid_from) INTO changed FROM public.employment e JOIN public.assignment a ON a.employment_id=e.id AND a.tenant_id=e.tenant_id
 WHERE e.tenant_id=m.tenant_id AND e.person_id=u.person_id AND a.superseded_at IS NULL AND a.valid_from<=day;
 RETURN jsonb_build_object('reason','assignment','on',COALESCE(changed,m.valid_from)); END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.reward_member_state(uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.reward_member_suspension(wanted_member uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.reward_member_state(m.id) FROM public.reward_member m JOIN public.reward_unit r ON r.id=m.unit_id AND r.tenant_id=m.tenant_id
 WHERE m.id=wanted_member AND m.tenant_id=app.current_tenant_id() AND (m.user_id=app.current_user_id() OR app.reward_admin(r.company_id));
$$;
REVOKE ALL ON FUNCTION app.reward_member_suspension(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_member_suspension(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.reward_member_eligible(wanted_member uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.reward_member m WHERE m.id=wanted_member AND m.tenant_id=app.current_tenant_id() AND app.reward_member_state(m.id) IS NULL);
$$;
REVOKE ALL ON FUNCTION app.reward_member_eligible(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_member_eligible(uuid) TO ai_hr_app;
CREATE OR REPLACE FUNCTION app.reward_roles(wanted_unit uuid) RETURNS SETOF text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT m.role FROM public.reward_member m JOIN public.reward_unit r ON r.id=m.unit_id AND r.tenant_id=m.tenant_id AND r.deleted_at IS NULL
 WHERE m.unit_id=wanted_unit AND m.tenant_id=app.current_tenant_id() AND m.user_id=app.current_user_id() AND app.reward_member_eligible(m.id);
$$;
--> statement-breakpoint
CREATE FUNCTION app.reward_access_members_snapshot(wanted_unit uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT COALESCE(jsonb_agg(to_jsonb(m) ORDER BY m.id),'[]'::jsonb) FROM public.reward_member m WHERE unit_id=wanted_unit AND tenant_id=app.current_tenant_id();
$$;
REVOKE ALL ON FUNCTION app.reward_access_members_snapshot(uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.reward_access_request_authorised(wanted_request uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.reward_access_request q WHERE q.id=wanted_request AND q.tenant_id=app.current_tenant_id()
 AND NOT EXISTS(SELECT 1 FROM jsonb_each(q.unit_revisions) k LEFT JOIN public.reward_unit r ON r.id=k.key::uuid AND r.tenant_id=q.tenant_id WHERE r.id IS NULL OR NOT app.reward_admin(r.company_id)));
$$;
REVOKE ALL ON FUNCTION app.reward_access_request_authorised(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_access_request_authorised(uuid) TO ai_hr_app;
CREATE POLICY reward_access_request_read ON reward_access_request FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.reward_access_request_authorised(id));
GRANT SELECT ON reward_access_request TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.reward_access_request_create(p_changes jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();actor uuid:=app.current_user_id();c jsonb;u public.reward_unit;k uuid;revisions jsonb:='{}';snapshots jsonb:='{}';fingerprints jsonb:='{}';request_id uuid:=gen_random_uuid();
BEGIN
 PERFORM app.access_workforce_write_lock();
 IF actor IS NULL OR jsonb_typeof(p_changes)<>'array' OR jsonb_array_length(p_changes) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'invalid access request' USING ERRCODE='23514'; END IF;
 FOR k IN SELECT DISTINCT (value->>'unitId')::uuid FROM jsonb_array_elements(p_changes) ORDER BY 1 LOOP
 SELECT * INTO u FROM public.reward_unit WHERE id=k AND tenant_id=t FOR UPDATE;
 IF u.id IS NULL OR u.deleted_at IS NOT NULL OR NOT app.reward_admin(u.company_id) THEN RAISE EXCEPTION 'access request scope' USING ERRCODE='42501'; END IF;
 IF u.status<>'draft' THEN RAISE EXCEPTION 'access request locked' USING ERRCODE='40001'; END IF;
 revisions:=revisions||jsonb_build_object(k::text,u.revision);snapshots:=snapshots||jsonb_build_object(k::text,app.reward_access_members_snapshot(k));
 END LOOP;
 FOR c IN SELECT value FROM jsonb_array_elements(p_changes) LOOP
 IF (c->>'revision')::int IS DISTINCT FROM (revisions->>(c->>'unitId'))::int THEN RAISE EXCEPTION 'access request changed' USING ERRCODE='40001'; END IF;
 IF c->'after'->>'restoreReason' IS NOT NULL AND (c->'before'='null'::jsonb OR c->'before'->>'userId' IS DISTINCT FROM c->'after'->>'userId' OR c->'before'->>'role' IS DISTINCT FROM c->'after'->>'role' OR NOT EXISTS(SELECT 1 FROM public.reward_member m WHERE m.unit_id=(c->>'unitId')::uuid AND m.tenant_id=t AND m.user_id=(c->'before'->>'userId')::uuid AND m.role=c->'before'->>'role' AND app.reward_member_state(m.id)->>'reason' IN('notice','assignment'))) THEN RAISE EXCEPTION 'only a suspended existing assignment can be restored' USING ERRCODE='23514'; END IF;
 IF c->'after'->>'restoreReason' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app.reward_roles((c->>'unitId')::uuid) role WHERE role='gr') THEN RAISE EXCEPTION 'Group Rewards restore required' USING ERRCODE='42501'; END IF;
 IF c->'after'<>'null'::jsonb AND NOT EXISTS(SELECT 1 FROM public.app_user x WHERE x.id=(c->'after'->>'userId')::uuid AND x.tenant_id=t AND x.archived_at IS NULL AND NOT app.login_blocked(x.id)) THEN RAISE EXCEPTION 'access account unavailable' USING ERRCODE='42501'; END IF;
 END LOOP;
 SELECT jsonb_agg(CASE WHEN value->'after'->>'restoreReason' IS NULL THEN value ELSE jsonb_set(value,'{after,restoreFingerprint}',to_jsonb(app.reward_member_people_fingerprint((value->'after'->>'userId')::uuid,(value->>'unitId')::uuid))) END ORDER BY ord) INTO p_changes FROM jsonb_array_elements(p_changes) WITH ORDINALITY x(value,ord);
 SELECT COALESCE(jsonb_object_agg(x.unit_id||':'||x.user_id,app.reward_member_people_fingerprint(x.user_id::uuid,x.unit_id::uuid)),'{}'::jsonb) INTO fingerprints FROM (SELECT DISTINCT value->>'unitId' as unit_id,member->>'userId' as user_id FROM jsonb_array_elements(p_changes) c(value) CROSS JOIN LATERAL (VALUES(value->'before'),(value->'after')) m(member) WHERE member<>'null'::jsonb) x;
 INSERT INTO public.reward_access_request(id,tenant_id,changes,unit_revisions,before_members,people_fingerprints,requested_by) VALUES(request_id,t,p_changes,revisions,snapshots,fingerprints,actor);
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload) VALUES(t,'reward-access-request',request_id,'reward-access.requested','user',actor,jsonb_build_object('changes',p_changes));
 RETURN request_id;
END $$;
REVOKE ALL ON FUNCTION app.reward_access_request_create(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_access_request_create(jsonb) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.reward_required_access_roles(wanted_unit uuid) RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN r.kind='annual' THEN ARRAY['bu','bg','gr','ctro','ec','payroll'] WHEN r.kind='midyear' THEN ARRAY['bu','bg','gr','payroll'] ELSE ARRAY['bg','gr','ctro','payroll']||CASE WHEN r.offcycle->>'bgOrigin'='true' THEN ARRAY[]::text[] ELSE ARRAY['bu'] END||CASE WHEN COALESCE(r.offcycle->>'exceptionReason','')<>'' THEN ARRAY['ec'] ELSE ARRAY[]::text[] END END FROM public.reward_unit r WHERE r.id=wanted_unit AND r.tenant_id=app.current_tenant_id();
$$;
REVOKE ALL ON FUNCTION app.reward_required_access_roles(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Canonical reporting-line floor projection, reused by snapshot readers and access enactment.
CREATE FUNCTION app.reward_confidentiality_floors(wanted_unit uuid,wanted_employments uuid[],as_of date)
 RETURNS TABLE(employment_id uuid,level text,manager_employment_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT DISTINCT ON (line.subordinate_employment_id) line.subordinate_employment_id,m.role,line.manager_employment_id
 FROM public.reward_unit r JOIN public.reward_member m ON m.unit_id=r.id AND m.tenant_id=r.tenant_id AND m.role IN('bg','ec')
 JOIN public.app_user u ON u.id=m.user_id AND u.tenant_id=m.tenant_id
 JOIN public.employment manager ON manager.person_id=u.person_id AND manager.tenant_id=u.tenant_id AND manager.hired_on<=as_of AND (manager.terminated_on IS NULL OR as_of<manager.terminated_on)
 JOIN public.reporting_line line ON line.manager_employment_id=manager.id AND line.tenant_id=manager.tenant_id AND line.line_type='administrative' AND line.superseded_at IS NULL AND line.valid_from<=as_of AND (line.valid_to IS NULL OR as_of<line.valid_to)
 JOIN public.employment subject ON subject.id=line.subordinate_employment_id AND subject.tenant_id=r.tenant_id AND subject.company_id=r.company_id
 WHERE r.id=wanted_unit AND r.tenant_id=app.current_tenant_id() AND r.deleted_at IS NULL AND line.subordinate_employment_id=ANY(wanted_employments) AND app.reward_access(r.id)
 ORDER BY line.subordinate_employment_id,CASE m.role WHEN 'ec' THEN 0 ELSE 1 END,line.manager_employment_id;
$$;
REVOKE ALL ON FUNCTION app.reward_confidentiality_floors(uuid,uuid[],date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_confidentiality_floors(uuid,uuid[],date) TO ai_hr_app;
CREATE FUNCTION app.reward_access_refresh_confidentiality(wanted_unit uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE u public.reward_unit;e public.reward_entry;floor record;next_source jsonb;next_facts jsonb;current_rank int;old_rank int;new_rank int;next_conf text;
BEGIN
 SELECT * INTO u FROM public.reward_unit WHERE id=wanted_unit AND tenant_id=app.current_tenant_id();
 IF u.id IS NULL OR u.status<>'draft' OR NOT app.reward_admin(u.company_id) THEN RAISE EXCEPTION 'Rewards confidentiality owner denied' USING ERRCODE='42501'; END IF;
 FOR e IN SELECT * FROM public.reward_entry x WHERE x.unit_id=u.id AND x.tenant_id=u.tenant_id AND COALESCE(x.source->>'leftOn','')='' LOOP
 SELECT * INTO floor FROM app.reward_confidentiality_floors(u.id,ARRAY[e.employment_id],u.snapshot_date);
 IF e.source->>'confidentialityFloor' IS NOT DISTINCT FROM floor.level AND e.source->'confidentialityReason'->>'managerEmploymentId' IS NOT DISTINCT FROM floor.manager_employment_id::text THEN CONTINUE; END IF;
 next_source:=e.source-ARRAY['confidentialityFloor','confidentialityReason'];
 IF floor.level IS NOT NULL THEN next_source:=next_source||jsonb_build_object('confidentialityFloor',floor.level,'confidentialityReason',jsonb_build_object('seat',floor.level,'managerEmploymentId',floor.manager_employment_id)); END IF;
 current_rank:=CASE e.facts->>'confidentiality' WHEN 'ec' THEN 2 WHEN 'bg' THEN 1 ELSE 0 END;
 old_rank:=CASE e.source->>'confidentialityFloor' WHEN 'ec' THEN 2 WHEN 'bg' THEN 1 ELSE 0 END;
 new_rank:=CASE floor.level WHEN 'ec' THEN 2 WHEN 'bg' THEN 1 ELSE 0 END;
 next_conf:=CASE greatest(CASE WHEN current_rank>old_rank THEN current_rank ELSE 0 END,new_rank) WHEN 2 THEN 'ec' WHEN 1 THEN 'bg' ELSE 'standard' END;
 next_facts:=jsonb_set(e.facts,'{confidentiality}',to_jsonb(next_conf));
 IF next_conf IS DISTINCT FROM e.facts->>'confidentiality' THEN next_facts:=jsonb_set(next_facts,'{reviewed}','false'::jsonb); END IF;
 UPDATE public.reward_entry SET source=next_source,facts=next_facts,updated_at=now() WHERE id=e.id;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION app.reward_access_refresh_confidentiality(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.reward_access_request_decide(wanted_request uuid,p_approve boolean,p_reason text DEFAULT '') RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE q public.reward_access_request;t uuid:=app.current_tenant_id();actor uuid:=app.current_user_id();u public.reward_unit;c jsonb;target jsonb;k uuid;member_id uuid;before_coverage jsonb:='{}';outcome text;day date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
BEGIN
 PERFORM app.access_workforce_write_lock();
 SELECT * INTO q FROM public.reward_access_request WHERE id=wanted_request AND tenant_id=t;
 IF q.id IS NULL OR NOT app.reward_access_request_authorised(q.id) THEN RAISE EXCEPTION 'access request scope' USING ERRCODE='42501'; END IF;
 IF q.status<>'pending' THEN RAISE EXCEPTION 'access request already decided' USING ERRCODE='40001'; END IF;
 IF actor IS NULL OR actor=q.requested_by OR EXISTS(SELECT 1 FROM jsonb_array_elements(q.changes) c WHERE actor::text IN(c->'before'->>'userId',c->'after'->>'userId')) THEN RAISE EXCEPTION 'second independent administrator required' USING ERRCODE='42501'; END IF;
 outcome:=CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END;
 IF NOT p_approve AND length(btrim(p_reason))<10 THEN RAISE EXCEPTION 'rejection reason required' USING ERRCODE='23514'; END IF;
 FOR k IN SELECT key::uuid FROM jsonb_each(q.unit_revisions) ORDER BY 1 LOOP
 SELECT * INTO u FROM public.reward_unit WHERE id=k AND tenant_id=t FOR UPDATE;
 IF u.id IS NULL OR u.deleted_at IS NOT NULL OR u.status<>'draft' OR u.revision IS DISTINCT FROM (q.unit_revisions->>k::text)::int OR app.reward_access_members_snapshot(k) IS DISTINCT FROM q.before_members->k::text THEN outcome:='lapsed'; END IF;
 before_coverage:=before_coverage||jsonb_build_object(k::text,COALESCE((SELECT jsonb_agg(DISTINCT m.role) FROM public.reward_member m WHERE m.unit_id=k AND m.tenant_id=t AND app.reward_member_eligible(m.id) AND (m.role='gr' OR m.role=ANY(app.reward_required_access_roles(k)))),'[]'::jsonb));
 END LOOP;
 SELECT * INTO q FROM public.reward_access_request WHERE id=wanted_request AND tenant_id=t FOR UPDATE;
 IF q.status<>'pending' THEN RAISE EXCEPTION 'access request already decided' USING ERRCODE='40001'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_each_text(q.people_fingerprints) p WHERE p.value IS DISTINCT FROM app.reward_member_people_fingerprint(split_part(p.key,':',2)::uuid,split_part(p.key,':',1)::uuid)) THEN outcome:='lapsed'; END IF;
 IF outcome='approved' THEN
 -- Add replacements before removing the previous holders, preserving existing coverage guards.
 FOR c IN SELECT value FROM jsonb_array_elements(q.changes) LOOP
 target:=c->'after';
 IF target IS NOT NULL AND target<>'null'::jsonb THEN
 IF NOT EXISTS(SELECT 1 FROM public.app_user x WHERE x.id=(target->>'userId')::uuid AND x.tenant_id=t AND x.archived_at IS NULL AND NOT app.login_blocked(x.id)) THEN RAISE EXCEPTION 'access account unavailable' USING ERRCODE='42501'; END IF;
 IF (target->>'restoreReason') IS NOT NULL AND (length(btrim(target->>'restoreReason'))<10 OR target->>'restoreFingerprint' IS DISTINCT FROM app.reward_member_people_fingerprint((target->>'userId')::uuid,(c->>'unitId')::uuid)) THEN RAISE EXCEPTION 'Group Rewards restore required' USING ERRCODE='42501'; END IF;
 INSERT INTO public.reward_member(tenant_id,unit_id,user_id,role,valid_from,valid_to,covers_user_id,restored_reason,restored_fingerprint)
 VALUES(t,(c->>'unitId')::uuid,(target->>'userId')::uuid,target->>'role',COALESCE((target->>'validFrom')::date,day),(target->>'validTo')::date,(target->>'coversUserId')::uuid,target->>'restoreReason',CASE WHEN target->>'restoreReason' IS NOT NULL THEN app.reward_member_people_fingerprint((target->>'userId')::uuid,(c->>'unitId')::uuid) END)
 ON CONFLICT(unit_id,user_id,role) DO UPDATE SET valid_from=EXCLUDED.valid_from,valid_to=EXCLUDED.valid_to,covers_user_id=EXCLUDED.covers_user_id,restored_reason=EXCLUDED.restored_reason,restored_fingerprint=EXCLUDED.restored_fingerprint;
 END IF;
 END LOOP;
 FOR c IN SELECT value FROM jsonb_array_elements(q.changes) LOOP
 IF c->'before'<>'null'::jsonb AND (c->'after'='null'::jsonb OR c->'before'->>'userId' IS DISTINCT FROM c->'after'->>'userId' OR c->'before'->>'role' IS DISTINCT FROM c->'after'->>'role') THEN
 DELETE FROM public.reward_member WHERE tenant_id=t AND unit_id=(c->>'unitId')::uuid AND user_id=(c->'before'->>'userId')::uuid AND role=c->'before'->>'role';
 END IF;
 END LOOP;
 FOR k IN SELECT key::uuid FROM jsonb_each(q.unit_revisions) ORDER BY 1 LOOP
 IF NOT EXISTS(SELECT 1 FROM public.reward_member m WHERE m.unit_id=k AND m.tenant_id=t AND m.role='gr' AND app.reward_member_eligible(m.id)) OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(before_coverage->k::text) old_role(role) WHERE NOT EXISTS(SELECT 1 FROM public.reward_member m WHERE m.unit_id=k AND m.tenant_id=t AND m.role=old_role.role AND app.reward_member_eligible(m.id))) THEN RAISE EXCEPTION 'required Rewards role must remain covered' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(q.changes) change WHERE change->>'unitId'=k::text AND (change->'before'->>'role' IN('bg','ec') OR change->'after'->>'role' IN('bg','ec'))) THEN PERFORM app.reward_access_refresh_confidentiality(k); END IF;
 PERFORM set_config('app.reward_approving_request',q.id::text,true);
 UPDATE public.reward_unit SET revision=revision+1,approved_digest=NULL,updated_at=now() WHERE id=k AND tenant_id=t;
 FOR c IN SELECT value FROM jsonb_array_elements(q.changes) WHERE value->>'unitId'=k::text LOOP
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload) VALUES(t,'reward-unit',k,'reward-unit.access-changed','user',actor,jsonb_build_object('before',c->'before','after',c->'after','revision',(q.unit_revisions->>k::text)::int+1,'batchId',q.id,'requestId',q.id,'requestedBy',q.requested_by));
 END LOOP;
 END LOOP;
 END IF;
 UPDATE public.reward_access_request SET status=outcome,decided_by=actor,decided_at=now(),reason=nullif(btrim(p_reason),'') WHERE id=q.id;
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload) VALUES(t,'reward-access-request',q.id,'reward-access.'||outcome,'user',actor,jsonb_build_object('requestedBy',q.requested_by,'changes',q.changes,'reason',nullif(btrim(p_reason),'')));
 RETURN outcome;
END $$;
REVOKE ALL ON FUNCTION app.reward_access_request_decide(uuid,boolean,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_access_request_decide(uuid,boolean,text) TO ai_hr_app;
--> statement-breakpoint
-- All later changes go through the checker-owned SECURITY DEFINER. Bootstrap is restricted to the
-- just-created review in this transaction: creator GR, or exact inherited parent seats for an offcycle.
DROP POLICY reward_member_write ON reward_member;
CREATE POLICY reward_member_bootstrap ON reward_member FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND EXISTS(
 SELECT 1 FROM reward_unit r WHERE r.id=unit_id AND r.tenant_id=reward_member.tenant_id AND r.created_by=app.current_user_id() AND r.revision=1 AND r.created_at>=transaction_timestamp()
 AND ((user_id=app.current_user_id() AND role='gr' AND app.reward_admin(r.company_id)) OR (r.parent_unit_id IS NOT NULL AND EXISTS(SELECT 1 FROM reward_member p WHERE p.unit_id=r.parent_unit_id AND p.user_id=reward_member.user_id AND p.role=reward_member.role AND p.valid_from=reward_member.valid_from AND p.valid_to IS NOT DISTINCT FROM reward_member.valid_to AND p.covers_user_id IS NOT DISTINCT FROM reward_member.covers_user_id AND p.restored_reason IS NOT DISTINCT FROM reward_member.restored_reason AND p.restored_fingerprint IS NOT DISTINCT FROM reward_member.restored_fingerprint AND app.reward_member_eligible(p.id))))));

--> statement-breakpoint
CREATE FUNCTION app.reward_access_candidate_eligible(wanted_unit uuid,wanted_user uuid,wanted_role text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.reward_unit r JOIN public.app_user u ON u.tenant_id=r.tenant_id
 WHERE r.id=wanted_unit AND r.tenant_id=app.current_tenant_id() AND u.id=wanted_user AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
 AND app.reward_admin(r.company_id)
 AND NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.person_id=u.person_id AND e.tenant_id=u.tenant_id AND e.tender_resignation_date<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (least(e.resignation_date,e.last_working_date,e.terminated_on) IS NULL OR (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date<=least(e.resignation_date,e.last_working_date,e.terminated_on)))
 AND (wanted_role<>'bu' OR EXISTS(SELECT 1 FROM public.employment e JOIN public.assignment a ON a.employment_id=e.id AND a.tenant_id=e.tenant_id
 WHERE e.person_id=u.person_id AND e.tenant_id=u.tenant_id AND e.company_id=r.company_id AND e.hired_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
 AND e.blacklisted_at IS NULL AND (least(e.resignation_date,e.last_working_date,e.terminated_on) IS NULL OR (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date<=least(e.resignation_date,e.last_working_date,e.terminated_on))
 AND a.business_unit_id=r.business_unit_id AND a.superseded_at IS NULL AND a.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (a.valid_to IS NULL OR (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date<a.valid_to))));
$$;
REVOKE ALL ON FUNCTION app.reward_access_candidate_eligible(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_access_candidate_eligible(uuid,uuid,text) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.reward_access_request_stale(wanted_request uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.reward_access_request q CROSS JOIN LATERAL jsonb_each(q.unit_revisions) k LEFT JOIN public.reward_unit r ON r.id=k.key::uuid AND r.tenant_id=q.tenant_id
 WHERE q.id=wanted_request AND q.tenant_id=app.current_tenant_id() AND app.reward_access_request_authorised(q.id)
 AND (r.id IS NULL OR r.deleted_at IS NOT NULL OR r.status<>'draft' OR r.revision<>k.value::text::int OR app.reward_access_members_snapshot(r.id) IS DISTINCT FROM q.before_members->k.key))
 OR EXISTS(SELECT 1 FROM public.reward_access_request q CROSS JOIN LATERAL jsonb_each_text(q.people_fingerprints) p WHERE q.id=wanted_request AND q.tenant_id=app.current_tenant_id() AND app.reward_access_request_authorised(q.id) AND p.value IS DISTINCT FROM app.reward_member_people_fingerprint(split_part(p.key,':',2)::uuid,split_part(p.key,':',1)::uuid));
$$;
REVOKE ALL ON FUNCTION app.reward_access_request_stale(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_access_request_stale(uuid) TO ai_hr_app;
CREATE FUNCTION app.reward_access_lapse_requests() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE q public.reward_access_request;
BEGIN
 FOR q IN SELECT * FROM public.reward_access_request x WHERE x.tenant_id=app.current_tenant_id() AND x.status='pending' AND app.reward_access_request_authorised(x.id) AND app.reward_access_request_stale(x.id) FOR UPDATE LOOP
 UPDATE public.reward_access_request SET status='lapsed',decided_by=app.current_user_id(),decided_at=now(),reason='Review or access changed' WHERE id=q.id;
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload) VALUES(q.tenant_id,'reward-access-request',q.id,'reward-access.lapsed','user',app.current_user_id(),jsonb_build_object('requestedBy',q.requested_by,'changes',q.changes));
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION app.reward_access_lapse_requests() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_access_lapse_requests() TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.reward_access_revision_lapse() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE q public.reward_access_request;
BEGIN
 IF NEW.revision=OLD.revision AND NEW.status=OLD.status AND NEW.deleted_at IS NOT DISTINCT FROM OLD.deleted_at THEN RETURN NEW; END IF;
 FOR q IN SELECT * FROM public.reward_access_request x WHERE x.tenant_id=NEW.tenant_id AND x.status='pending' AND x.unit_revisions ? NEW.id::text AND x.id::text IS DISTINCT FROM current_setting('app.reward_approving_request',true) FOR UPDATE LOOP
 UPDATE public.reward_access_request SET status='lapsed',decided_by=app.current_user_id(),decided_at=now(),reason='Review or access changed' WHERE id=q.id;
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload) VALUES(q.tenant_id,'reward-access-request',q.id,'reward-access.lapsed','user',app.current_user_id(),jsonb_build_object('requestedBy',q.requested_by,'changes',q.changes));
 END LOOP;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.reward_access_revision_lapse() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER reward_access_revision_lapse AFTER UPDATE ON reward_unit FOR EACH ROW EXECUTE FUNCTION app.reward_access_revision_lapse();
--> statement-breakpoint
CREATE TABLE reward_access_observation(tenant_id uuid NOT NULL REFERENCES tenant(id),member_id uuid NOT NULL REFERENCES reward_member(id) ON DELETE CASCADE,state_key text NOT NULL,observed_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,member_id,state_key));
ALTER TABLE reward_access_observation ENABLE ROW LEVEL SECURITY;
ALTER TABLE reward_access_observation FORCE ROW LEVEL SECURITY;
CREATE POLICY reward_access_observation_owner ON reward_access_observation FOR ALL USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
REVOKE ALL ON reward_access_observation FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.reward_access_observe(wanted_unit uuid DEFAULT NULL) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE m public.reward_member;state jsonb;recorded uuid;
BEGIN
 FOR m IN SELECT x.* FROM public.reward_member x JOIN public.reward_unit r ON r.id=x.unit_id AND r.tenant_id=x.tenant_id
 WHERE x.tenant_id=app.current_tenant_id() AND r.deleted_at IS NULL AND (wanted_unit IS NULL OR r.id=wanted_unit)
 AND (app.reward_admin(r.company_id) OR EXISTS(SELECT 1 FROM public.reward_member own WHERE own.unit_id=r.id AND own.tenant_id=r.tenant_id AND own.user_id=app.current_user_id())) LOOP
 state:=app.reward_member_state(m.id);
 IF state IS NOT NULL AND state->>'reason' IN('login','notice','assignment') THEN
 recorded:=NULL;
 INSERT INTO public.reward_access_observation(tenant_id,member_id,state_key) VALUES(m.tenant_id,m.id,state::text||':'||app.reward_member_people_fingerprint(m.user_id,m.unit_id)) ON CONFLICT DO NOTHING RETURNING member_id INTO recorded;
 IF recorded IS NOT NULL THEN
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload) VALUES(m.tenant_id,'reward-unit',m.unit_id,'reward-access.suspended','system',NULL,jsonb_build_object('memberId',m.id,'userId',m.user_id,'role',m.role,'reason',state->>'reason','on',state->>'on'));
 END IF;
 END IF;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION app.reward_access_observe(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_access_observe(uuid) TO ai_hr_app;
CREATE FUNCTION app.reward_access_suspension_recipients(wanted_unit uuid) RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT DISTINCT e.id FROM public.reward_member m JOIN public.reward_unit r ON r.id=m.unit_id AND r.tenant_id=m.tenant_id
 JOIN public.app_user u ON u.id=m.user_id AND u.tenant_id=m.tenant_id JOIN public.employment e ON e.person_id=u.person_id AND e.tenant_id=u.tenant_id AND e.company_id=r.company_id
 WHERE m.unit_id=wanted_unit AND m.tenant_id=app.current_tenant_id() AND m.role='gr' AND app.reward_member_eligible(m.id)
 AND app.is_admin() AND (app.current_user_id() IS NULL OR app.reward_admin(r.company_id));
$$;
REVOKE ALL ON FUNCTION app.reward_access_suspension_recipients(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_access_suspension_recipients(uuid) TO ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.reward_access_admin_count(wanted_company uuid) RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT count(DISTINCT u.id) FROM public.app_user u JOIN public.role_assignment a ON a.app_user_id=u.id AND a.tenant_id=u.tenant_id
 WHERE u.tenant_id=app.current_tenant_id() AND app.reward_admin(wanted_company) AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
 AND a.role::text IN('hr_admin','super_admin') AND (a.company_id IS NULL OR a.company_id=wanted_company OR app.is_company_descendant(wanted_company,a.company_id));
$$;
REVOKE ALL ON FUNCTION app.reward_access_admin_count(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_access_admin_count(uuid) TO ai_hr_app;

-- Provisional source reservation 0947 / when1793330000347. No installation authority.
-- Authority is derived from current login, scoped HR grants and effective reward_member assignments.
CREATE FUNCTION app.reward_access_scope(wanted_unit uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.reward_unit r WHERE r.id=wanted_unit AND r.tenant_id=app.current_tenant_id() AND r.deleted_at IS NULL
 AND (app.reward_admin(r.company_id) OR EXISTS(SELECT 1 FROM app.reward_roles(r.id) role WHERE role IN('gr','ctro','bu','bg','pbp'))));
$$;
CREATE FUNCTION app.reward_access_manage(wanted_unit uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.reward_unit r WHERE r.id=wanted_unit AND r.tenant_id=app.current_tenant_id() AND r.deleted_at IS NULL
 AND (app.reward_admin(r.company_id) OR EXISTS(SELECT 1 FROM app.reward_roles(r.id) role WHERE role IN('gr','ctro'))));
$$;
CREATE FUNCTION app.reward_access_exemption(wanted_unit uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN EXISTS(SELECT 1 FROM app.reward_roles(r.id) role WHERE role='gr') THEN 'gr'
 WHEN EXISTS(SELECT 1 FROM app.reward_roles(r.id) role WHERE role='ctro') THEN 'ctro'
 WHEN EXISTS(SELECT 1 FROM public.app_user u JOIN public.role_assignment a ON a.app_user_id=u.id AND a.tenant_id=u.tenant_id
 WHERE u.id=app.current_user_id() AND u.tenant_id=r.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
 AND a.role::text='hr_admin' AND app.has_role_for('hr_admin',r.company_id)
 AND (a.company_id IS NULL OR a.company_id=r.company_id OR app.is_company_descendant(r.company_id,a.company_id))) THEN 'hr_admin' END
 FROM public.reward_unit r WHERE r.id=wanted_unit AND r.tenant_id=app.current_tenant_id() AND r.deleted_at IS NULL AND app.reward_access_manage(r.id);
$$;
CREATE FUNCTION app.reward_access_change_allowed(change jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE k uuid:=(change->>'unitId')::uuid;actor uuid:=app.current_user_id();target jsonb;old public.reward_member;
BEGIN
 IF NOT app.reward_access_scope(k) THEN RETURN false; END IF;
 IF app.reward_access_manage(k) THEN RETURN true; END IF;
 -- CEOs may nominate/maintain only a dated proxy covering their own currently eligible seat.
 -- PBPs may request their own view seat; neither path confers membership-mutation authority.
 FOR target IN SELECT x FROM (VALUES(change->'before'),(change->'after')) v(x) WHERE x IS NOT NULL AND x<>'null'::jsonb LOOP
 IF target ? 'restoreReason' OR target ? 'restoreFingerprint' THEN RETURN false; END IF;
 IF target=change->'before' THEN
 SELECT * INTO old FROM public.reward_member m WHERE m.tenant_id=app.current_tenant_id() AND m.unit_id=k AND m.user_id=(target->>'userId')::uuid AND m.role=target->>'role';
 IF old.id IS NULL THEN RETURN false; END IF;
 target:=jsonb_build_object('userId',old.user_id,'role',old.role,'coversUserId',old.covers_user_id,'validTo',old.valid_to);
 END IF;
 IF target->>'role'='pbp' AND target->>'userId'=actor::text AND EXISTS(SELECT 1 FROM app.reward_roles(k) role WHERE role='pbp') THEN CONTINUE; END IF;
 IF target->>'role' NOT IN('bu','bg') OR target->>'coversUserId' IS DISTINCT FROM actor::text OR target->>'validTo' IS NULL OR NOT EXISTS(SELECT 1 FROM app.reward_roles(k) role WHERE role=target->>'role') THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION app.reward_access_scope(uuid),app.reward_access_manage(uuid),app.reward_access_exemption(uuid),app.reward_access_change_allowed(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_access_scope(uuid),app.reward_access_manage(uuid),app.reward_access_exemption(uuid),app.reward_access_change_allowed(jsonb) TO ai_hr_app;
--> statement-breakpoint
-- Separate narrow access-directory facts from general workforce/person access and pay data.
CREATE FUNCTION app.reward_access_candidate_visible(wanted_unit uuid,wanted_user uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.reward_unit r JOIN public.app_user u ON u.tenant_id=r.tenant_id WHERE r.id=wanted_unit AND u.id=wanted_user
 AND r.tenant_id=app.current_tenant_id() AND app.reward_access_scope(r.id) AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
 AND (app.access_workforce_person(u.person_id,'workforce.view') OR u.id=app.current_user_id()
 OR (NOT app.reward_admin(r.company_id) AND (NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.tenant_id=r.tenant_id AND e.person_id=u.person_id)
 OR EXISTS(SELECT 1 FROM public.employment e WHERE e.tenant_id=r.tenant_id AND e.person_id=u.person_id AND e.company_id=r.company_id)))));
$$;
CREATE FUNCTION app.reward_access_directory(wanted_units uuid[]) RETURNS TABLE(id uuid,name text,email text,person_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT DISTINCT u.id,p.full_name,p.primary_email,u.person_id FROM public.app_user u JOIN public.person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id
 WHERE u.tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM unnest(wanted_units) k WHERE app.reward_access_candidate_visible(k,u.id)) ORDER BY u.id;
$$;
REVOKE ALL ON FUNCTION app.reward_access_candidate_visible(uuid,uuid),app.reward_access_directory(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_access_candidate_visible(uuid,uuid),app.reward_access_directory(uuid[]) TO ai_hr_app;
--> statement-breakpoint
ALTER TABLE reward_access_request ADD COLUMN request_reason text;
ALTER TABLE reward_access_request ADD COLUMN requester_authority jsonb;
ALTER TABLE reward_access_request ADD COLUMN exemption_basis jsonb;
ALTER TABLE reward_access_request DROP CONSTRAINT reward_access_request_status_check;
ALTER TABLE reward_access_request ADD CONSTRAINT reward_access_request_status_check CHECK(status IN('pending','approved','rejected','lapsed','applied_no_second_approval'));
CREATE OR REPLACE FUNCTION app.reward_access_request_authorised(wanted_request uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.reward_access_request q WHERE q.id=wanted_request AND q.tenant_id=app.current_tenant_id()
 AND (q.requested_by=app.current_user_id() OR NOT EXISTS(SELECT 1 FROM jsonb_each(q.unit_revisions) k WHERE NOT app.reward_access_manage(k.key::uuid))));
$$;
CREATE FUNCTION app.reward_access_request_can_decide(wanted_request uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.reward_access_request q WHERE q.id=wanted_request AND q.tenant_id=app.current_tenant_id() AND q.status='pending'
 AND app.current_user_id() IS NOT NULL AND q.requested_by<>app.current_user_id()
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(q.changes) c WHERE app.current_user_id()::text IN(c->'before'->>'userId',c->'after'->>'userId'))
 AND NOT EXISTS(SELECT 1 FROM jsonb_each(q.unit_revisions) k WHERE NOT EXISTS(SELECT 1 FROM app.reward_roles(k.key::uuid) role WHERE role='gr')));
$$;
REVOKE ALL ON FUNCTION app.reward_access_request_can_decide(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_access_request_can_decide(uuid) TO ai_hr_app;
CREATE FUNCTION app.reward_access_request_actor_name(wanted_request uuid,wanted_user uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT p.full_name FROM public.reward_access_request q JOIN public.app_user u ON u.id=wanted_user AND u.tenant_id=q.tenant_id JOIN public.person p ON p.id=u.person_id AND p.tenant_id=q.tenant_id
 WHERE q.id=wanted_request AND q.tenant_id=app.current_tenant_id() AND wanted_user IN(q.requested_by,q.decided_by) AND app.reward_access_request_authorised(q.id);
$$;
REVOKE ALL ON FUNCTION app.reward_access_request_actor_name(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_access_request_actor_name(uuid,uuid) TO ai_hr_app;
-- Retain the ai_hr_app-only read policy installed by 0875; do not reopen FORCE-RLS recursion.
--> statement-breakpoint
-- Custody includes the requester authority, not only affected accounts. Revoked/suspended requesters cannot leave executable stale proposals.
CREATE FUNCTION app.reward_access_requester_fingerprint(wanted_user uuid,wanted_unit uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT encode(sha256(convert_to(jsonb_build_object('people',app.reward_member_people_fingerprint(u.id,r.id),
 'grants',COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM public.role_assignment a WHERE a.tenant_id=u.tenant_id AND a.app_user_id=u.id AND a.role::text IN('hr_admin','super_admin') AND (a.company_id IS NULL OR a.company_id=r.company_id OR app.is_company_descendant(r.company_id,a.company_id))),'[]'::jsonb),
 'seats',COALESCE((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.id) FROM public.reward_member m WHERE m.tenant_id=u.tenant_id AND m.unit_id=r.id AND m.user_id=u.id AND m.role IN('gr','ctro','bu','bg','pbp') AND app.reward_member_eligible_internal(m.id)),'[]'::jsonb))::text,'UTF8')),'hex')
 FROM public.app_user u JOIN public.reward_unit r ON r.tenant_id=u.tenant_id WHERE u.id=wanted_user AND r.id=wanted_unit AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
 AND (EXISTS(SELECT 1 FROM public.role_assignment a WHERE a.tenant_id=u.tenant_id AND a.app_user_id=u.id AND a.role::text IN('hr_admin','super_admin') AND (a.company_id IS NULL OR a.company_id=r.company_id OR app.is_company_descendant(r.company_id,a.company_id)))
 OR EXISTS(SELECT 1 FROM public.reward_member m WHERE m.tenant_id=u.tenant_id AND m.unit_id=r.id AND m.user_id=u.id AND m.role IN('gr','ctro','bu','bg','pbp') AND app.reward_member_eligible_internal(m.id)));
$$;
REVOKE ALL ON FUNCTION app.reward_access_requester_fingerprint(uuid,uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.reward_access_requester_stale(wanted_request uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.reward_access_request q CROSS JOIN LATERAL jsonb_each(q.unit_revisions) k WHERE q.id=wanted_request AND q.tenant_id=app.current_tenant_id()
 AND (app.reward_access_requester_fingerprint(q.requested_by,k.key::uuid) IS NULL OR (q.requester_authority IS NOT NULL AND q.requester_authority->>k.key IS DISTINCT FROM app.reward_access_requester_fingerprint(q.requested_by,k.key::uuid))));
$$;
REVOKE ALL ON FUNCTION app.reward_access_requester_stale(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.reward_access_request_prepare(p_changes jsonb,p_reason text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();actor uuid:=app.current_user_id();c jsonb;target jsonb;u public.reward_unit;k uuid;revisions jsonb:='{}';snapshots jsonb:='{}';fingerprints jsonb:='{}';request_id uuid:=gen_random_uuid();
BEGIN
 PERFORM app.access_workforce_write_lock();
 IF actor IS NULL OR jsonb_typeof(p_changes)<>'array' OR jsonb_array_length(p_changes) NOT BETWEEN 1 AND 500 OR octet_length(p_changes::text)>2000000 THEN RAISE EXCEPTION 'invalid access request' USING ERRCODE='23514'; END IF;
 IF COALESCE(length(app.reward_access_reason_trim(p_reason)),0)<10 OR length(p_reason)>2000 THEN RAISE EXCEPTION 'access request reason required' USING ERRCODE='23514'; END IF;
 FOR c IN SELECT value FROM jsonb_array_elements(p_changes) LOOP
 IF jsonb_typeof(c)<>'object' OR NOT (c ?& ARRAY['unitId','revision','before','after']) OR c-ARRAY['unitId','revision','before','after']<>'{}'::jsonb OR jsonb_typeof(c->'before') NOT IN('object','null') OR jsonb_typeof(c->'after') NOT IN('object','null') OR (c->'before'='null'::jsonb AND c->'after'='null'::jsonb) THEN RAISE EXCEPTION 'invalid access change shape' USING ERRCODE='23514'; END IF;
 FOR target IN SELECT member FROM (VALUES(c->'before'),(c->'after')) x(member) WHERE member<>'null'::jsonb LOOP
 IF NOT (target ?& ARRAY['userId','role']) OR target->>'role' NOT IN('bu','bg','gr','ctro','ec','pbp','payroll') OR target-ARRAY['userId','role','validFrom','validTo','coversUserId','restoreReason','restoreFingerprint']<>'{}'::jsonb THEN RAISE EXCEPTION 'invalid access assignment shape' USING ERRCODE='23514'; END IF;
 END LOOP;
 END LOOP;
 FOR k IN SELECT DISTINCT (value->>'unitId')::uuid FROM jsonb_array_elements(p_changes) ORDER BY 1 LOOP
 SELECT * INTO u FROM public.reward_unit WHERE id=k AND tenant_id=t FOR UPDATE;
 IF u.id IS NULL OR u.deleted_at IS NOT NULL OR NOT app.reward_access_scope(u.id) THEN RAISE EXCEPTION 'access request scope' USING ERRCODE='42501'; END IF;
 IF u.status<>'draft' THEN RAISE EXCEPTION 'access request locked' USING ERRCODE='40001'; END IF;
 revisions:=revisions||jsonb_build_object(k::text,u.revision);snapshots:=snapshots||jsonb_build_object(k::text,app.reward_access_members_snapshot(k));
 END LOOP;
 FOR c IN SELECT value FROM jsonb_array_elements(p_changes) LOOP
 IF NOT app.reward_access_change_allowed(c) THEN RAISE EXCEPTION 'bounded access request scope' USING ERRCODE='42501'; END IF;
 IF c->'before'<>'null'::jsonb AND NOT EXISTS(SELECT 1 FROM public.reward_member m WHERE m.unit_id=(c->>'unitId')::uuid AND m.tenant_id=t AND m.user_id=(c->'before'->>'userId')::uuid AND m.role=c->'before'->>'role') THEN RAISE EXCEPTION 'access membership changed' USING ERRCODE='40001'; END IF;
 IF (c->>'revision')::int IS DISTINCT FROM (revisions->>(c->>'unitId'))::int THEN RAISE EXCEPTION 'access request changed' USING ERRCODE='40001'; END IF;
 IF c->'after'->>'coversUserId' IS NOT NULL AND (c->'after'->>'validTo' IS NULL OR c->'after'->>'coversUserId'=c->'after'->>'userId' OR NOT EXISTS(SELECT 1 FROM public.reward_member m WHERE m.tenant_id=t AND m.unit_id=(c->>'unitId')::uuid AND m.user_id=(c->'after'->>'coversUserId')::uuid AND m.role=c->'after'->>'role')) THEN RAISE EXCEPTION 'a proxy needs an existing holder and an end date' USING ERRCODE='23514'; END IF;
 IF c->'after'->>'restoreReason' IS NOT NULL AND (c->'before'='null'::jsonb OR c->'before'->>'userId' IS DISTINCT FROM c->'after'->>'userId' OR c->'before'->>'role' IS DISTINCT FROM c->'after'->>'role' OR NOT EXISTS(SELECT 1 FROM public.reward_member m WHERE m.unit_id=(c->>'unitId')::uuid AND m.tenant_id=t AND m.user_id=(c->'before'->>'userId')::uuid AND m.role=c->'before'->>'role' AND app.reward_member_state(m.id)->>'reason' IN('notice','assignment'))) THEN RAISE EXCEPTION 'only a suspended existing assignment can be restored' USING ERRCODE='23514'; END IF;
 IF c->'after'->>'restoreReason' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app.reward_roles((c->>'unitId')::uuid) role WHERE role='gr') THEN RAISE EXCEPTION 'Group Rewards restore required' USING ERRCODE='42501'; END IF;
 IF c->'after'<>'null'::jsonb AND c->'after'->>'restoreReason' IS NULL AND NOT app.reward_access_candidate_eligible((c->>'unitId')::uuid,(c->'after'->>'userId')::uuid,c->'after'->>'role') THEN RAISE EXCEPTION 'access account eligibility changed' USING ERRCODE='42501'; END IF;
 IF c->'after'<>'null'::jsonb AND NOT EXISTS(SELECT 1 FROM public.app_user x WHERE x.id=(c->'after'->>'userId')::uuid AND x.tenant_id=t AND x.archived_at IS NULL AND NOT app.login_blocked(x.id) AND app.reward_access_candidate_visible((c->>'unitId')::uuid,x.id)) THEN RAISE EXCEPTION 'access account unavailable' USING ERRCODE='42501'; END IF;
 END LOOP;
 SELECT jsonb_agg(
 jsonb_set(jsonb_set(value,'{before}',CASE WHEN value->'before'='null'::jsonb THEN 'null'::jsonb ELSE (SELECT jsonb_build_object('userId',m.user_id,'role',m.role,'validFrom',m.valid_from,'validTo',m.valid_to,'coversUserId',m.covers_user_id) FROM public.reward_member m WHERE m.tenant_id=t AND m.unit_id=(value->>'unitId')::uuid AND m.user_id=(value->'before'->>'userId')::uuid AND m.role=value->'before'->>'role') END),'{after}',CASE WHEN value->'after'='null'::jsonb THEN 'null'::jsonb ELSE jsonb_build_object('validFrom',COALESCE(value->'after'->>'validFrom',(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date::text),'validTo',NULL,'coversUserId',NULL)||value->'after' END)
 ORDER BY ord) INTO p_changes FROM jsonb_array_elements(p_changes) WITH ORDINALITY x(value,ord);
 SELECT jsonb_agg(CASE WHEN value->'after'->>'restoreReason' IS NULL THEN value ELSE jsonb_set(value,'{after,restoreFingerprint}',to_jsonb(app.reward_member_people_fingerprint((value->'after'->>'userId')::uuid,(value->>'unitId')::uuid))) END ORDER BY ord) INTO p_changes FROM jsonb_array_elements(p_changes) WITH ORDINALITY x(value,ord);
 SELECT COALESCE(jsonb_object_agg(x.unit_id||':'||x.user_id,app.reward_member_people_fingerprint(x.user_id::uuid,x.unit_id::uuid)),'{}'::jsonb) INTO fingerprints FROM (SELECT DISTINCT value->>'unitId' as unit_id,member->>'userId' as user_id FROM jsonb_array_elements(p_changes) c(value) CROSS JOIN LATERAL (VALUES(value->'before'),(value->'after')) m(member) WHERE member<>'null'::jsonb) x;
 INSERT INTO public.reward_access_request(id,tenant_id,changes,unit_revisions,before_members,people_fingerprints,requested_by,request_reason,requester_authority) VALUES(request_id,t,p_changes,revisions,snapshots,fingerprints,actor,app.reward_access_reason_trim(p_reason),(SELECT jsonb_object_agg(k.key,app.reward_access_requester_fingerprint(actor,k.key::uuid)) FROM jsonb_each(revisions) k));
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload) VALUES(t,'reward-access-request',request_id,'reward-access.requested','user',actor,jsonb_build_object('changes',p_changes,'reason',app.reward_access_reason_trim(p_reason)));
 RETURN request_id;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.reward_access_request_apply(wanted_request uuid,p_approve boolean,p_reason text,p_immediate boolean) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE q public.reward_access_request;t uuid:=app.current_tenant_id();actor uuid:=app.current_user_id();u public.reward_unit;c jsonb;target jsonb;k uuid;member_id uuid;before_coverage jsonb:='{}';exemptions jsonb;outcome text;day date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
BEGIN
 PERFORM app.access_workforce_write_lock();
 SELECT * INTO q FROM public.reward_access_request WHERE id=wanted_request AND tenant_id=t;
 IF q.id IS NULL OR NOT app.reward_access_request_authorised(q.id) THEN RAISE EXCEPTION 'access request scope' USING ERRCODE='42501'; END IF;
 IF q.status<>'pending' THEN RAISE EXCEPTION 'access request already decided' USING ERRCODE='40001'; END IF;
 IF NOT p_immediate AND (actor IS NULL OR actor=q.requested_by OR EXISTS(SELECT 1 FROM jsonb_array_elements(q.changes) assignments(change) WHERE actor::text IN(assignments.change->'before'->>'userId',assignments.change->'after'->>'userId'))) THEN RAISE EXCEPTION 'second independent administrator required' USING ERRCODE='42501'; END IF;
 IF p_immediate THEN
 SELECT jsonb_object_agg(k.key,app.reward_access_exemption(k.key::uuid)) INTO exemptions FROM jsonb_each(q.unit_revisions) k;
 IF actor IS DISTINCT FROM q.requested_by OR EXISTS(SELECT 1 FROM jsonb_each(q.unit_revisions) k WHERE app.reward_access_exemption(k.key::uuid) IS NULL) THEN RAISE EXCEPTION 'immediate access authority changed' USING ERRCODE='42501'; END IF;
 ELSIF NOT app.reward_access_request_can_decide(q.id) THEN RAISE EXCEPTION 'independent Group Rewards checker required' USING ERRCODE='42501'; END IF;
 p_reason:=app.reward_access_reason_trim(p_reason);
 IF p_approve IS NULL OR COALESCE(length(p_reason),0)>2000 THEN RAISE EXCEPTION 'invalid access decision' USING ERRCODE='23514'; END IF;
 outcome:=CASE WHEN p_immediate THEN 'applied_no_second_approval' WHEN p_approve THEN 'approved' ELSE 'rejected' END;
 IF NOT p_approve AND COALESCE(length(app.reward_access_reason_trim(p_reason)),0)<10 THEN RAISE EXCEPTION 'rejection reason required' USING ERRCODE='23514'; END IF;
 FOR k IN SELECT key::uuid FROM jsonb_each(q.unit_revisions) ORDER BY 1 LOOP
 SELECT * INTO u FROM public.reward_unit WHERE id=k AND tenant_id=t FOR UPDATE;
 IF u.id IS NULL OR u.deleted_at IS NOT NULL OR u.status<>'draft' OR u.revision IS DISTINCT FROM (q.unit_revisions->>k::text)::int OR app.reward_access_members_snapshot(k) IS DISTINCT FROM q.before_members->k::text THEN outcome:='lapsed'; END IF;
 before_coverage:=before_coverage||jsonb_build_object(k::text,COALESCE((SELECT jsonb_agg(DISTINCT m.role) FROM public.reward_member m WHERE m.unit_id=k AND m.tenant_id=t AND app.reward_member_eligible_internal(m.id) AND (m.role='gr' OR m.role=ANY(app.reward_required_access_roles(k)))),'[]'::jsonb));
 END LOOP;
 SELECT * INTO q FROM public.reward_access_request WHERE id=wanted_request AND tenant_id=t FOR UPDATE;
 IF q.status<>'pending' THEN RAISE EXCEPTION 'access request already decided' USING ERRCODE='40001'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_each_text(q.people_fingerprints) p WHERE p.value IS DISTINCT FROM app.reward_member_people_fingerprint(split_part(p.key,':',2)::uuid,split_part(p.key,':',1)::uuid)) THEN outcome:='lapsed'; END IF;
 IF app.reward_access_requester_stale(q.id) THEN outcome:='lapsed'; END IF;
 IF outcome IN('approved','applied_no_second_approval') THEN
 -- Add replacements before removing the previous holders, preserving existing coverage guards.
 FOR c IN SELECT value FROM jsonb_array_elements(q.changes) LOOP
 target:=c->'after';
 IF target IS NOT NULL AND target<>'null'::jsonb THEN
 IF NOT EXISTS(SELECT 1 FROM public.app_user x WHERE x.id=(target->>'userId')::uuid AND x.tenant_id=t AND x.archived_at IS NULL AND NOT app.login_blocked(x.id)) THEN RAISE EXCEPTION 'access account unavailable' USING ERRCODE='42501'; END IF;
 IF (target->>'restoreReason') IS NOT NULL AND (length(app.reward_access_reason_trim(target->>'restoreReason'))<10 OR target->>'restoreFingerprint' IS DISTINCT FROM app.reward_member_people_fingerprint((target->>'userId')::uuid,(c->>'unitId')::uuid)) THEN RAISE EXCEPTION 'Group Rewards restore required' USING ERRCODE='42501'; END IF;
 INSERT INTO public.reward_member(tenant_id,unit_id,user_id,role,valid_from,valid_to,covers_user_id,restored_reason,restored_fingerprint)
 VALUES(t,(c->>'unitId')::uuid,(target->>'userId')::uuid,target->>'role',COALESCE((target->>'validFrom')::date,day),(target->>'validTo')::date,(target->>'coversUserId')::uuid,target->>'restoreReason',CASE WHEN target->>'restoreReason' IS NOT NULL THEN app.reward_member_people_fingerprint((target->>'userId')::uuid,(c->>'unitId')::uuid) END)
 ON CONFLICT(unit_id,user_id,role) DO UPDATE SET valid_from=EXCLUDED.valid_from,valid_to=EXCLUDED.valid_to,covers_user_id=EXCLUDED.covers_user_id,restored_reason=COALESCE(EXCLUDED.restored_reason,reward_member.restored_reason),restored_fingerprint=COALESCE(EXCLUDED.restored_fingerprint,reward_member.restored_fingerprint);
 END IF;
 END LOOP;
 FOR c IN SELECT value FROM jsonb_array_elements(q.changes) LOOP
 IF c->'before'<>'null'::jsonb AND (c->'after'='null'::jsonb OR c->'before'->>'userId' IS DISTINCT FROM c->'after'->>'userId' OR c->'before'->>'role' IS DISTINCT FROM c->'after'->>'role') THEN
 DELETE FROM public.reward_member WHERE tenant_id=t AND unit_id=(c->>'unitId')::uuid AND user_id=(c->'before'->>'userId')::uuid AND role=c->'before'->>'role';
 END IF;
 END LOOP;
 FOR k IN SELECT key::uuid FROM jsonb_each(q.unit_revisions) ORDER BY 1 LOOP
 IF NOT EXISTS(SELECT 1 FROM public.reward_member m WHERE m.unit_id=k AND m.tenant_id=t AND m.role='gr' AND app.reward_member_eligible_internal(m.id)) OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(before_coverage->k::text) old_role(role) WHERE NOT EXISTS(SELECT 1 FROM public.reward_member m WHERE m.unit_id=k AND m.tenant_id=t AND m.role=old_role.role AND app.reward_member_eligible_internal(m.id))) THEN RAISE EXCEPTION 'required Rewards role must remain covered' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(q.changes) change WHERE change->>'unitId'=k::text AND (change->'before'->>'role' IN('bg','ec') OR change->'after'->>'role' IN('bg','ec'))) THEN PERFORM app.reward_access_refresh_confidentiality(k); END IF;
 PERFORM set_config('app.reward_approving_request',q.id::text,true);
 UPDATE public.reward_unit SET revision=revision+1,approved_digest=NULL,updated_at=now() WHERE id=k AND tenant_id=t;
 FOR c IN SELECT value FROM jsonb_array_elements(q.changes) WHERE value->>'unitId'=k::text LOOP
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload) VALUES(t,'reward-unit',k,'reward-unit.access-changed','user',actor,jsonb_build_object('before',c->'before','after',c->'after','revision',(q.unit_revisions->>k::text)::int+1,'batchId',q.id,'requestId',q.id,'requestedBy',q.requested_by,'reason',q.request_reason,'disposition',outcome));
 END LOOP;
 END LOOP;
 END IF;
 UPDATE public.reward_access_request SET status=outcome,decided_by=CASE WHEN p_immediate THEN NULL ELSE actor END,decided_at=now(),exemption_basis=CASE WHEN p_immediate THEN exemptions ELSE NULL END,reason=nullif(btrim(p_reason),'') WHERE id=q.id;
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload) VALUES(t,'reward-access-request',q.id,'reward-access.'||outcome,'user',actor,jsonb_build_object('requestedBy',q.requested_by,'changes',q.changes,'reason',nullif(btrim(p_reason),''),'exemptionBasis',CASE WHEN p_immediate THEN exemptions ELSE NULL END));
 RETURN outcome;
END $$;

REVOKE ALL ON FUNCTION app.reward_access_request_prepare(jsonb,text),app.reward_access_request_apply(uuid,boolean,text,boolean) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.reward_access_request_create(p_changes jsonb,p_reason text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE request_id uuid;
BEGIN
 request_id:=app.reward_access_request_prepare(p_changes,p_reason);
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_changes) c WHERE app.reward_access_exemption((c->>'unitId')::uuid) IS NULL) THEN
 PERFORM app.reward_access_request_apply(request_id,true,p_reason,true);
 END IF;
 RETURN request_id;
END $$;
CREATE OR REPLACE FUNCTION app.reward_access_request_create(p_changes jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN RAISE EXCEPTION 'access request reason required' USING ERRCODE='23514'; END $$;
CREATE OR REPLACE FUNCTION app.reward_access_request_decide(wanted_request uuid,p_approve boolean,p_reason text DEFAULT '') RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN RETURN app.reward_access_request_apply(wanted_request,p_approve,p_reason,false); END $$;
REVOKE ALL ON FUNCTION app.reward_access_request_create(jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_access_request_create(jsonb,text) TO ai_hr_app;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.reward_access_candidate_eligible(wanted_unit uuid,wanted_user uuid,wanted_role text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.reward_unit r JOIN public.app_user u ON u.tenant_id=r.tenant_id
 WHERE r.id=wanted_unit AND r.tenant_id=app.current_tenant_id() AND u.id=wanted_user AND u.archived_at IS NULL AND NOT app.login_blocked_on(u.id,(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
 AND app.reward_access_scope(r.id) AND app.reward_access_candidate_visible(r.id,u.id)
 AND NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.person_id=u.person_id AND e.tenant_id=u.tenant_id AND e.tender_resignation_date<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (least(e.resignation_date,e.last_working_date,e.terminated_on) IS NULL OR (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date<=least(e.resignation_date,e.last_working_date,e.terminated_on)))
 AND (wanted_role<>'bu' OR EXISTS(SELECT 1 FROM public.employment e JOIN public.assignment a ON a.employment_id=e.id AND a.tenant_id=e.tenant_id
 WHERE e.person_id=u.person_id AND e.tenant_id=u.tenant_id AND e.company_id=r.company_id AND e.hired_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
 AND e.blacklisted_at IS NULL AND (least(e.resignation_date,e.last_working_date,e.terminated_on) IS NULL OR (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date<=least(e.resignation_date,e.last_working_date,e.terminated_on))
 AND a.business_unit_id=r.business_unit_id AND a.superseded_at IS NULL AND a.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (a.valid_to IS NULL OR (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date<a.valid_to))));
$$;
CREATE OR REPLACE FUNCTION app.reward_member_suspension(wanted_member uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.reward_member_state(m.id) FROM public.reward_member m JOIN public.reward_unit r ON r.id=m.unit_id AND r.tenant_id=m.tenant_id
 WHERE m.id=wanted_member AND m.tenant_id=app.current_tenant_id() AND (m.user_id=app.current_user_id() OR app.reward_access_scope(r.id));
$$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.reward_access_request_stale(wanted_request uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.reward_access_requester_stale(wanted_request) OR EXISTS(SELECT 1 FROM public.reward_access_request q CROSS JOIN LATERAL jsonb_each(q.unit_revisions) k LEFT JOIN public.reward_unit r ON r.id=k.key::uuid AND r.tenant_id=q.tenant_id
 WHERE q.id=wanted_request AND q.tenant_id=app.current_tenant_id() AND app.reward_access_request_authorised(q.id)
 AND (r.id IS NULL OR r.deleted_at IS NOT NULL OR r.status<>'draft' OR r.revision<>k.value::text::int OR app.reward_access_members_snapshot(r.id) IS DISTINCT FROM q.before_members->k.key))
 OR EXISTS(SELECT 1 FROM public.reward_access_request q CROSS JOIN LATERAL jsonb_each_text(q.people_fingerprints) p WHERE q.id=wanted_request AND q.tenant_id=app.current_tenant_id() AND app.reward_access_request_authorised(q.id) AND p.value IS DISTINCT FROM app.reward_member_people_fingerprint(split_part(p.key,':',2)::uuid,split_part(p.key,':',1)::uuid));
$$;

--> statement-breakpoint
-- A proposal holder can take the existing access-write lock without acquiring general UPDATE privilege on a reward review.
CREATE FUNCTION app.reward_access_lock_unit(wanted_unit uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM app.access_workforce_write_lock();
 PERFORM 1 FROM public.reward_unit r WHERE r.id=wanted_unit AND r.tenant_id=app.current_tenant_id() AND r.deleted_at IS NULL AND app.reward_access_scope(r.id) FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'access request scope' USING ERRCODE='42501'; END IF;
END $$;
REVOKE ALL ON FUNCTION app.reward_access_lock_unit(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_access_lock_unit(uuid) TO ai_hr_app;

-- Preserve shared memberships in the new Contract groups port. The existing native lifecycle owner is unchanged.
CREATE OR REPLACE FUNCTION app.automation_assignment_groups_save(p_expected integer,p_v9_expected integer,p_groups jsonb,p_reason text) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id(); n public.lc_onboarding_config; v public.lc_v9_config; next_data jsonb;
BEGIN
 PERFORM app.access_workforce_write_lock();
 IF t IS NULL OR app.automation_can_manage('contract_staff','groups') IS NOT TRUE THEN RAISE EXCEPTION 'Shared group management is unavailable' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(t::text||':onboarding',0));
 PERFORM pg_advisory_xact_lock(hashtextextended('lifecycle-v9:'||t::text,0));
 SELECT * INTO n FROM public.lc_onboarding_config WHERE tenant_id=t FOR UPDATE;
 SELECT * INTO v FROM public.lc_v9_config WHERE tenant_id=t FOR UPDATE;
 IF n.tenant_id IS NULL OR n.revision IS DISTINCT FROM p_expected OR v.revision IS DISTINCT FROM p_v9_expected THEN RAISE EXCEPTION 'Assignment groups or lifecycle settings changed' USING ERRCODE='40001';END IF;
 IF jsonb_typeof(p_groups) IS DISTINCT FROM 'array' OR jsonb_array_length(p_groups)>100 OR length(btrim(coalesce(p_reason,''))) NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'Check the group list and save reason' USING ERRCODE='22023';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_groups) g WHERE jsonb_typeof(g) IS DISTINCT FROM 'object' OR g-ARRAY['id','name','members','limit']<>'{}'::jsonb OR coalesce(g->>'id','')!~'^[A-Za-z0-9_-]{1,100}$' OR length(btrim(coalesce(g->>'name',''))) NOT BETWEEN 1 AND 200 OR jsonb_typeof(g->'members') IS DISTINCT FROM 'array' OR jsonb_array_length(g->'members')>500 OR coalesce(g->>'limit','')!~'^[0-9]{1,4}$' OR (g->>'limit')::integer>1000)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_groups) g GROUP BY g->>'id' HAVING count(*)>1)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_groups) g GROUP BY lower(btrim(g->>'name')) HAVING count(*)>1)
 OR (SELECT sum(jsonb_array_length(g->'members')) FROM jsonb_array_elements(p_groups) g)>5000
 THEN RAISE EXCEPTION 'Use unique group names and IDs, and valid member lists and task limits' USING ERRCODE='22023';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(n.data->'groups') old WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_groups) fresh WHERE fresh->>'id'=old->>'id'))
 THEN RAISE EXCEPTION 'Use the existing assignment group replacement flow before deleting a shared group' USING ERRCODE='22023';END IF;
 -- Shared-group deletion and member-removal redesign remain KIV in this handoff. Keep the existing native flow.
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(n.data->'groups') old CROSS JOIN LATERAL jsonb_array_elements_text(old->'members') member(id)
 WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_groups) fresh WHERE fresh->>'id'=old->>'id' AND fresh->'members' ? member.id))
 THEN RAISE EXCEPTION 'Existing members are retained here. Use the existing authorized lifecycle group flow to remove a member' USING ERRCODE='22023';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_groups) g CROSS JOIN LATERAL jsonb_array_elements_text(g->'members') m(id)
 WHERE id!~'^[0-9a-fA-F-]{36}$' OR (NOT EXISTS(SELECT 1 FROM public.app_user u WHERE u.tenant_id=t AND u.id::text=id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id))
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(n.data->'groups') old WHERE old->>'id'=g->>'id' AND old->'members' ? m.id)))
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_groups) g CROSS JOIN LATERAL jsonb_array_elements_text(g->'members') m(id) GROUP BY g->>'id',id HAVING count(*)>1)
 THEN RAISE EXCEPTION 'Choose each available tenant account once per group' USING ERRCODE='22023';END IF;
 next_data:=jsonb_set(n.data,'{groups}',p_groups);
 UPDATE public.lc_onboarding_config SET data=next_data,revision=n.revision+1,updated_at=now() WHERE tenant_id=t;
 INSERT INTO public.lc_onboarding_config_history(tenant_id,revision,data,actor_user_id) VALUES(t,n.revision+1,next_data,app.current_user_id());
 IF v.tenant_id IS NOT NULL THEN
  INSERT INTO public.lc_v9_config_revision(tenant_id,revision,data,actor_user_id) VALUES(t,v.revision,v.data,app.current_user_id());
  UPDATE public.lc_v9_config SET data=jsonb_set(jsonb_set(jsonb_set(v.data,'{groups}',p_groups),'{groupsRevision}',to_jsonb(n.revision+1)),'{revision}',to_jsonb(v.revision+1)),revision=v.revision+1,updated_at=now() WHERE tenant_id=t;
 END IF;
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload) VALUES(t,'onboarding-config',t,'automation.assignmentGroups.saved','user',app.current_user_id(),jsonb_build_object('revision',n.revision+1,'reason',btrim(p_reason),'groups',jsonb_array_length(p_groups)));
 RETURN n.revision+1;
END $$;

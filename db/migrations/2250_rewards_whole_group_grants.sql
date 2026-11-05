-- Explicit review-role grants. Setup grants and individual review seats remain separate.
CREATE TABLE public.reward_group_role_grant (
  tenant_id uuid NOT NULL REFERENCES public.tenant(id),
  user_id uuid NOT NULL REFERENCES public.app_user(id),
  role text NOT NULL CHECK (role IN ('gr', 'ctro', 'ec')),
  active boolean NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  PRIMARY KEY (tenant_id, user_id, role)
);
ALTER TABLE public.reward_group_role_grant ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reward_group_role_grant FORCE ROW LEVEL SECURITY;
CREATE POLICY reward_group_role_owner ON public.reward_group_role_grant TO ai_hr_owner
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
REVOKE ALL ON public.reward_group_role_grant FROM PUBLIC, ai_hr_app;
--> statement-breakpoint

-- A grant alone cannot override current login or People eligibility. Only the owner
-- can ask about another person; the caller-facing function below is self-only.
CREATE FUNCTION app.reward_group_person_eligible(wanted_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.app_user u
    CROSS JOIN (SELECT (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AS today) d
    WHERE u.id = wanted_user AND u.tenant_id = app.current_tenant_id()
      AND u.person_id IS NOT NULL AND u.archived_at IS NULL
      AND NOT app.login_blocked_on(u.id, d.today)
      AND EXISTS (
        SELECT 1 FROM public.employment e
        WHERE e.tenant_id = u.tenant_id AND e.person_id = u.person_id
          AND e.hired_on <= d.today AND e.blacklisted_at IS NULL
          AND (least(e.resignation_date, e.last_working_date, e.terminated_on) IS NULL
               OR d.today <= least(e.resignation_date, e.last_working_date, e.terminated_on))
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.employment e
        WHERE e.tenant_id = u.tenant_id AND e.person_id = u.person_id
          AND e.tender_resignation_date <= d.today
          AND (least(e.resignation_date, e.last_working_date, e.terminated_on) IS NULL
               OR d.today <= least(e.resignation_date, e.last_working_date, e.terminated_on))
      )
  );
$$;
REVOKE ALL ON FUNCTION app.reward_group_person_eligible(uuid) FROM PUBLIC, ai_hr_app;
--> statement-breakpoint

CREATE FUNCTION app.reward_current_group_roles() RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT g.role FROM public.reward_group_role_grant g
  WHERE g.tenant_id = app.current_tenant_id() AND g.user_id = app.current_user_id()
    AND g.active AND app.principal_snapshot_current()
    AND app.reward_not_viewing_as() AND app.reward_group_person_eligible(g.user_id);
$$;
REVOKE ALL ON FUNCTION app.reward_current_group_roles() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_current_group_roles() TO ai_hr_app;
--> statement-breakpoint

-- Keep the grant and its audit event in the same transaction. Expected revision zero
-- means no existing grant. A concurrent edit must be reviewed before retrying.
CREATE FUNCTION app.reward_save_group_role(
  wanted_user uuid, wanted_role text, wanted_active boolean, expected_revision integer, reason text
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  tenant uuid := app.current_tenant_id();
  actor uuid := app.current_user_id();
  previous public.reward_group_role_grant;
  new_revision integer;
  explanation text := btrim(reason);
BEGIN
  IF tenant IS NULL OR actor IS NULL OR NOT coalesce(app.principal_snapshot_current(), false)
     OR NOT coalesce(app.is_group_admin(), false) OR NOT coalesce(app.reward_not_viewing_as(), false)
     OR wanted_user = actor THEN
    RAISE EXCEPTION 'An independent group administrator is required' USING ERRCODE = '42501';
  END IF;
  IF wanted_user IS NULL OR wanted_role IS NULL OR wanted_role NOT IN ('gr', 'ctro', 'ec')
     OR wanted_active IS NULL OR expected_revision IS NULL OR expected_revision < 0
     OR explanation IS NULL OR char_length(explanation) NOT BETWEEN 10 AND 2000 THEN
    RAISE EXCEPTION 'Select a valid role and provide a reason' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(tenant::text || ':' || wanted_user::text || ':' || wanted_role, 2250));
  SELECT * INTO previous FROM public.reward_group_role_grant
    WHERE tenant_id = tenant AND user_id = wanted_user AND role = wanted_role FOR UPDATE;

  IF coalesce(previous.revision, 0) <> expected_revision THEN
    RAISE EXCEPTION 'This Rewards grant changed. Reload before saving.' USING ERRCODE = '40001';
  END IF;
  IF wanted_active AND NOT app.reward_group_person_eligible(wanted_user) THEN
    RAISE EXCEPTION 'Select an eligible employee in this group' USING ERRCODE = '22023';
  END IF;
  IF coalesce(previous.active, false) = wanted_active THEN RETURN expected_revision; END IF;

  new_revision := expected_revision + 1;
  INSERT INTO public.reward_group_role_grant (tenant_id, user_id, role, active, revision)
    VALUES (tenant, wanted_user, wanted_role, wanted_active, new_revision)
    ON CONFLICT (tenant_id, user_id, role) DO UPDATE
      SET active = excluded.active, revision = excluded.revision;
  INSERT INTO public.domain_event (tenant_id, aggregate_type, aggregate_id, event_type, actor_type, actor_id, payload)
    VALUES (tenant, 'reward-access', wanted_user, 'reward-access.whole-group-role.changed', 'user', actor,
      jsonb_build_object('role', wanted_role, 'before', previous.active, 'after', wanted_active,
                         'revision', new_revision, 'reason', explanation));
  RETURN new_revision;
END;
$$;
REVOKE ALL ON FUNCTION app.reward_save_group_role(uuid, text, boolean, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_save_group_role(uuid, text, boolean, integer, text) TO ai_hr_app;
--> statement-breakpoint

CREATE FUNCTION app.reward_group_role_directory()
RETURNS TABLE(user_id uuid, name text, role text, active boolean, eligible boolean, revision integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT g.user_id, p.full_name, g.role, g.active,
         app.reward_group_person_eligible(g.user_id), g.revision
  FROM public.reward_group_role_grant g
  JOIN public.app_user u ON u.id = g.user_id AND u.tenant_id = g.tenant_id
  JOIN public.person p ON p.id = u.person_id AND p.tenant_id = g.tenant_id
  WHERE g.tenant_id = app.current_tenant_id()
    AND app.principal_snapshot_current() AND app.is_group_admin() AND app.reward_not_viewing_as()
  ORDER BY p.full_name, g.user_id, g.role;
$$;
REVOKE ALL ON FUNCTION app.reward_group_role_directory() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_group_role_directory() TO ai_hr_app;
--> statement-breakpoint

-- Native unit access resolves explicit group grants on demand, including units
-- added after a grant. Scoped review seats still have their own eligibility.
CREATE OR REPLACE FUNCTION app.reward_roles(wanted_unit uuid) RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT m.role
  FROM public.reward_member m
  JOIN public.reward_unit r ON r.id = m.unit_id AND r.tenant_id = m.tenant_id AND r.deleted_at IS NULL
  WHERE m.unit_id = wanted_unit AND m.tenant_id = app.current_tenant_id()
    AND m.user_id = app.current_user_id() AND app.reward_member_eligible_internal(m.id)
  UNION
  SELECT g.role FROM app.reward_current_group_roles() AS g(role)
  WHERE EXISTS (
    SELECT 1 FROM public.reward_unit r
    WHERE r.id = wanted_unit AND r.tenant_id = app.current_tenant_id() AND r.deleted_at IS NULL
  );
$$;
--> statement-breakpoint

-- Returning roles rather than identities avoids exposing the group role directory
-- to an ordinary reviewer checking coverage before a decision.
CREATE FUNCTION app.reward_group_coverage_roles(wanted_unit uuid) RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT DISTINCT g.role FROM public.reward_group_role_grant g
  WHERE g.tenant_id = app.current_tenant_id() AND g.active
    AND app.reward_access(wanted_unit) AND app.principal_snapshot_current()
    AND app.reward_group_person_eligible(g.user_id);
$$;
REVOKE ALL ON FUNCTION app.reward_group_coverage_roles(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_group_coverage_roles(uuid) TO ai_hr_app;
--> statement-breakpoint

-- Group visibility does not open a new figures-edit window. Legacy scoped roles
-- retain their existing policy, while explicit group grants must match the step.
CREATE FUNCTION app.reward_group_figures_stage_allowed(wanted_unit uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.reward_unit r
    WHERE r.id = wanted_unit AND r.tenant_id = app.current_tenant_id() AND r.deleted_at IS NULL
      AND (
        EXISTS (
          SELECT 1 FROM public.reward_member m
          WHERE m.tenant_id = r.tenant_id AND m.unit_id = r.id AND m.user_id = app.current_user_id()
            AND m.role NOT IN ('pbp', 'payroll') AND app.reward_member_eligible_internal(m.id)
        )
        OR r.status IN ('gr', 'ctro', 'ec') AND r.status IN (SELECT app.reward_current_group_roles())
      )
  );
$$;
REVOKE ALL ON FUNCTION app.reward_group_figures_stage_allowed(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_group_figures_stage_allowed(uuid) TO ai_hr_app;

CREATE POLICY reward_entry_group_stage_update ON public.reward_entry AS RESTRICTIVE FOR UPDATE TO ai_hr_app
USING (NOT EXISTS (SELECT 1 FROM app.reward_current_group_roles()) OR app.reward_group_figures_stage_allowed(unit_id))
WITH CHECK (NOT EXISTS (SELECT 1 FROM app.reward_current_group_roles()) OR app.reward_group_figures_stage_allowed(unit_id));
--> statement-breakpoint

-- Group Rewards may maintain setup. CTRO receives library view only, and
-- Executive Chairman receives no configuration authority from this grant.
GRANT EXECUTE ON FUNCTION app.reward_current_group_roles() TO ai_hr_reward_setup_reader;
CREATE OR REPLACE FUNCTION app.reward_setup_allowed(wanted_company uuid,wanted_operation text) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public,app AS $$
 SELECT wanted_operation IN('library_view','manage')
 AND EXISTS(SELECT 1 FROM app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id))
 AND (wanted_company IS NULL OR EXISTS(SELECT 1 FROM company c WHERE c.id=wanted_company AND c.tenant_id=app.current_tenant_id()))
 AND (EXISTS(SELECT 1 FROM app.reward_current_group_roles() role
              WHERE role='gr' OR wanted_operation='library_view' AND role='ctro')
 OR EXISTS(SELECT 1 FROM reward_setup_grant g WHERE g.tenant_id=app.current_tenant_id() AND g.user_id=app.current_user_id() AND g.active
  AND g.valid_from<=timezone('Asia/Kuala_Lumpur',now())::date AND(g.valid_to IS NULL OR g.valid_to>=timezone('Asia/Kuala_Lumpur',now())::date)
  AND((wanted_company IS NULL AND g.company_id IS NULL) OR (wanted_company IS NOT NULL AND(g.company_id IS NULL OR g.company_id=wanted_company))) AND(g.role='gr' OR wanted_operation='library_view' AND g.role='ctro'))
 OR EXISTS(SELECT 1 FROM reward_unit u WHERE u.tenant_id=app.current_tenant_id() AND u.deleted_at IS NULL AND wanted_company IS NOT NULL AND u.company_id=wanted_company
  AND EXISTS(SELECT 1 FROM app.reward_roles(u.id) r WHERE r='gr' OR wanted_operation='library_view' AND r='ctro')))
$$;
--> statement-breakpoint

-- A narrow catalogue keeps plan review separate from configuration authority.
CREATE POLICY reward_plan_whole_group_catalogue ON public.reward_plan_setup FOR SELECT TO ai_hr_owner
USING (tenant_id = app.current_tenant_id() AND EXISTS (SELECT 1 FROM app.reward_current_group_roles()));
CREATE FUNCTION app.reward_whole_group_plan_catalogue()
RETURNS TABLE(plan_id uuid, cycle_name text, year integer, snapshot_date date, state text, companies text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT r.version_id, r.cycle_name, r.year, r.snapshot_date, r.state,
    ARRAY(SELECT c.legal_name FROM public.company c
      WHERE c.tenant_id = r.tenant_id AND c.id = ANY(r.company_ids) ORDER BY c.legal_name, c.id)
  FROM public.reward_plan_setup r
  WHERE r.tenant_id = app.current_tenant_id() AND EXISTS (SELECT 1 FROM app.reward_current_group_roles())
  ORDER BY r.year DESC, r.cycle_name, r.version_id;
$$;
REVOKE ALL ON FUNCTION app.reward_whole_group_plan_catalogue() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_whole_group_plan_catalogue() TO ai_hr_app;

--> statement-breakpoint

-- An eligible group grant can keep a required role covered when a scoped seat is removed.
CREATE OR REPLACE FUNCTION app.reward_access_request_apply(wanted_request uuid,p_approve boolean,p_reason text,p_immediate boolean) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE q public.reward_access_request;t uuid:=app.current_tenant_id();actor uuid:=app.current_user_id();u public.reward_unit;c jsonb;target jsonb;k uuid;member_id uuid;before_coverage jsonb:='{}';exemptions jsonb;outcome text;day date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
BEGIN
 PERFORM app.access_workforce_write_lock();
 SELECT * INTO q FROM public.reward_access_request WHERE id=wanted_request AND tenant_id=t;
 IF q.id IS NULL OR NOT app.reward_access_request_authorised(q.id) THEN RAISE EXCEPTION 'access request scope' USING ERRCODE='42501'; END IF;
 IF q.status<>'pending' THEN RAISE EXCEPTION 'access request already decided' USING ERRCODE='40001'; END IF;
 -- Identity/archival writers join this canonical access barrier (0579); tuple locks here
 -- would reverse their tuple-before-trigger ordering and deadlock an in-flight archive.
 IF NOT p_immediate AND NOT app.reward_access_request_independent(q.id,actor) THEN RAISE EXCEPTION 'independent Group Rewards checker required' USING ERRCODE='42501'; END IF;
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
 IF (NOT EXISTS(SELECT 1 FROM public.reward_member m WHERE m.unit_id=k AND m.tenant_id=t AND m.role='gr' AND app.reward_member_eligible_internal(m.id))
     AND NOT EXISTS(SELECT 1 FROM app.reward_group_coverage_roles(k) role WHERE role='gr')) OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(before_coverage->k::text) old_role(role) WHERE NOT EXISTS(SELECT 1 FROM public.reward_member m WHERE m.unit_id=k AND m.tenant_id=t AND m.role=old_role.role AND app.reward_member_eligible_internal(m.id))
     AND NOT EXISTS(SELECT 1 FROM app.reward_group_coverage_roles(k) role WHERE role=old_role.role)) THEN RAISE EXCEPTION 'required Rewards role must remain covered' USING ERRCODE='23514'; END IF;
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
--> statement-breakpoint

-- The group grant does not let the caller fabricate a decision at another step.
CREATE FUNCTION app.reward_group_decision_stage_allowed(wanted_unit uuid, from_step text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.reward_unit r
    WHERE r.id = wanted_unit AND r.tenant_id = app.current_tenant_id() AND r.deleted_at IS NULL
      AND r.status = from_step
      AND (
        EXISTS (
          SELECT 1 FROM public.reward_member m
          WHERE m.tenant_id = r.tenant_id AND m.unit_id = r.id AND m.user_id = app.current_user_id()
            AND m.role <> 'pbp' AND app.reward_member_eligible_internal(m.id)
        )
        OR r.status IN ('gr', 'ctro', 'ec') AND r.status IN (SELECT app.reward_current_group_roles())
      )
  );
$$;
REVOKE ALL ON FUNCTION app.reward_group_decision_stage_allowed(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_group_decision_stage_allowed(uuid, text) TO ai_hr_app;

CREATE POLICY reward_decision_group_stage_insert ON public.reward_decision AS RESTRICTIVE FOR INSERT TO ai_hr_app
WITH CHECK (NOT EXISTS (SELECT 1 FROM app.reward_current_group_roles())
  OR app.reward_group_decision_stage_allowed(unit_id, from_stage));
--> statement-breakpoint

-- Reuse the review snapshot date for group EC direct reports. This read-time
-- restriction does not rewrite a submitted review or its approved digest.
CREATE FUNCTION app.reward_group_ec_direct_reports(wanted_unit uuid) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT DISTINCT line.subordinate_employment_id
  FROM public.reward_unit r
  JOIN public.reward_group_role_grant g ON g.tenant_id = r.tenant_id AND g.role = 'ec' AND g.active
  JOIN public.app_user u ON u.id = g.user_id AND u.tenant_id = g.tenant_id
  JOIN public.employment manager ON manager.person_id = u.person_id AND manager.tenant_id = u.tenant_id
    AND manager.hired_on <= r.snapshot_date
    AND (manager.terminated_on IS NULL OR r.snapshot_date < manager.terminated_on)
  JOIN public.reporting_line line ON line.manager_employment_id = manager.id AND line.tenant_id = manager.tenant_id
    AND line.line_type = 'administrative' AND line.superseded_at IS NULL
    AND line.valid_from <= r.snapshot_date AND (line.valid_to IS NULL OR r.snapshot_date < line.valid_to)
  JOIN public.reward_entry e ON e.employment_id = line.subordinate_employment_id AND e.unit_id = r.id AND e.tenant_id = r.tenant_id
  WHERE r.id = wanted_unit AND r.tenant_id = app.current_tenant_id() AND r.deleted_at IS NULL
    AND app.reward_access(r.id) AND app.reward_group_person_eligible(g.user_id);
$$;
REVOKE ALL ON FUNCTION app.reward_group_ec_direct_reports(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_group_ec_direct_reports(uuid) TO ai_hr_app, ai_hr_reward_setup_reader, ai_hr_reward_upload_reader;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.reward_private_entry_visible(wanted_unit uuid,wanted_entry uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public,app AS $$
 SELECT EXISTS(SELECT 1 FROM reward_entry e WHERE e.id=wanted_entry AND e.unit_id=wanted_unit AND e.tenant_id=app.current_tenant_id()
  AND EXISTS(SELECT 1 FROM app.reward_roles(e.unit_id))
  AND NOT EXISTS(SELECT 1 FROM app_user me WHERE me.id=app.current_user_id() AND me.tenant_id=e.tenant_id AND me.person_id::text=e.source->>'personId')
  AND (e.facts->>'reviewed'='true' OR 'gr'=ANY(ARRAY(SELECT app.reward_roles(e.unit_id))))
  AND (e.employment_id NOT IN (SELECT app.reward_group_ec_direct_reports(e.unit_id))
       OR ARRAY(SELECT app.reward_roles(e.unit_id)) && ARRAY['gr','ctro','ec'])
  AND (e.facts->>'confidentiality'<>'ec' OR ARRAY(SELECT app.reward_roles(e.unit_id)) && ARRAY['gr','ctro','ec'])
  AND (NOT(coalesce((e.facts->>'seniorPlan')::boolean,false) OR EXISTS(SELECT 1 FROM reward_unit u WHERE u.id=e.unit_id AND coalesce(u.policy->>'seniorMembershipMode','legacy-grades')<>'named-members' AND u.policy->'seniorGrades' ? (e.source->>'grade'))) OR ARRAY(SELECT app.reward_roles(e.unit_id)) && ARRAY['gr','ctro','ec'])
  AND (e.facts->>'confidentiality'<>'bg' OR ARRAY(SELECT app.reward_roles(e.unit_id)) && ARRAY['bg','gr','ctro','ec','payroll']))
$$;

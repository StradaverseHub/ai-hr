-- UNALLOCATED / UNAPPLIED. Source-reviewed lifecycle acknowledgement only; no role or table grants.
-- One native owner retains the original validation, DAA/step/history body. Ordinary API passes no
-- expectations; reviewed callers must bind the actual own source versions before effects.
CREATE FUNCTION app.lc_my_daa_submit_owner(p_data jsonb,p_expected_case uuid,p_expected_revision text,p_expected_distribution text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_id uuid; v_name text;
BEGIN
  v_id := app.lc_my_case_id();
  IF p_expected_case IS NOT NULL AND v_id IS DISTINCT FROM p_expected_case THEN RAISE EXCEPTION 'Reviewed acknowledgement changed' USING ERRCODE='P0001'; END IF;
  IF p_expected_case IS NOT NULL THEN
    PERFORM 1 FROM public.lc_case WHERE id=v_id AND tenant_id=app.current_tenant_id() FOR UPDATE NOWAIT;
  END IF;
  IF v_id IS NULL THEN RAISE EXCEPTION 'No onboarding case is linked to your account.' USING ERRCODE = '42501'; END IF;
  PERFORM 1 FROM lc_case WHERE id = v_id AND status = 'in_progress' AND laptop_required AND daa_submitted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'The acknowledgement is not available for this case.' USING ERRCODE = 'P0001'; END IF;
  PERFORM 1 FROM lc_case_step WHERE case_id = v_id AND step_key = 'laptop_dist' AND done;
  IF NOT FOUND THEN RAISE EXCEPTION 'Your laptop has not been marked as handed over yet.' USING ERRCODE = 'P0001'; END IF;
  IF p_expected_case IS NOT NULL THEN
    IF NOT EXISTS(SELECT 1 FROM public.lc_case WHERE id=v_id AND tenant_id=app.current_tenant_id() AND xmin::text=p_expected_revision) THEN RAISE EXCEPTION 'Reviewed acknowledgement changed' USING ERRCODE='P0001'; END IF;
    PERFORM 1 FROM public.lc_case_step WHERE case_id=v_id AND tenant_id=app.current_tenant_id() AND step_key='laptop_dist' AND done AND xmin::text=p_expected_distribution FOR SHARE NOWAIT;
    IF NOT FOUND THEN RAISE EXCEPTION 'Reviewed acknowledgement changed' USING ERRCODE='P0001'; END IF;
  END IF;
  UPDATE lc_case SET daa = p_data, daa_submitted_at = now() WHERE id = v_id;
  INSERT INTO lc_case_step (case_id, tenant_id, step_key, done, done_by, done_at)
    VALUES (v_id, app.current_tenant_id(), 'daa_ack', true, app.current_user_id(), now())
    ON CONFLICT (case_id, step_key) DO UPDATE SET done = true, done_by = app.current_user_id(), done_at = now();
  SELECT p.full_name INTO v_name FROM app_user u JOIN person p ON p.id = u.person_id WHERE u.id = app.current_user_id();
  INSERT INTO lc_history (tenant_id, ref_type, ref_id, action, detail, actor_user_id, actor_name)
    VALUES (app.current_tenant_id(), 'case', v_id, 'daa.submitted', '{}'::jsonb, app.current_user_id(), v_name);
  RETURN v_id;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.lc_my_daa_submit_owner(jsonb,uuid,text,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.lc_my_daa_submit(p_data jsonb) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.lc_my_daa_submit_owner(p_data,NULL,NULL,NULL)
$$;
--> statement-breakpoint
CREATE FUNCTION app.lc_my_daa_submit_reviewed(p_data jsonb,p_case uuid,p_revision text,p_distribution text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF p_case IS NULL OR p_revision IS NULL OR p_distribution IS NULL THEN RAISE EXCEPTION 'Reviewed acknowledgement unavailable' USING ERRCODE='42501'; END IF;
 RETURN app.lc_my_daa_submit_owner(p_data,p_case,p_revision,p_distribution);
END $$;
--> statement-breakpoint
CREATE FUNCTION app.lc_my_daa_review_source() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c public.lc_case; d text; selected uuid;
BEGIN
 selected:=app.lc_my_case_id();
 SELECT * INTO c FROM public.lc_case WHERE id=selected AND tenant_id=app.current_tenant_id() FOR UPDATE NOWAIT;
 IF NOT FOUND OR c.status<>'in_progress' OR NOT c.laptop_required OR c.daa_submitted_at IS NOT NULL OR selected IS DISTINCT FROM app.lc_my_case_id() THEN RAISE EXCEPTION 'Reviewed acknowledgement unavailable' USING ERRCODE='42501'; END IF;
 SELECT xmin::text INTO d FROM public.lc_case_step WHERE tenant_id=c.tenant_id AND case_id=c.id AND step_key='laptop_dist' AND done FOR SHARE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'Reviewed acknowledgement unavailable' USING ERRCODE='42501'; END IF;
 RETURN (SELECT jsonb_build_object('caseId',c.id,'caseNumber',c.number,'caseRevision',xmin::text,'distributionRevision',d) FROM public.lc_case WHERE id=c.id AND tenant_id=c.tenant_id);
END $$;
--> statement-breakpoint
CREATE FUNCTION app.lc_my_daa_reference(p_case uuid,p_event uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('caseId',c.id,'caseNumber',c.number,'submittedEventId',e.id,'submittedAt',to_char(c.daa_submitted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'currentStatus',c.status)
 FROM public.lc_case c JOIN public.domain_event e ON e.tenant_id=c.tenant_id AND e.aggregate_id=c.id
 WHERE c.id=p_case AND c.tenant_id=app.current_tenant_id() AND c.id=app.lc_my_case_id() AND c.daa_submitted_at IS NOT NULL
 AND e.id=p_event AND e.aggregate_type='lifecycle-case' AND e.event_type='lifecycle-case.daa-submitted' AND e.actor_type='user' AND e.actor_id=app.current_user_id()
 -- Both native writes use the SAME top-level SQL transaction clock (not the human JSON timestamp).
 AND e.occurred_at=c.daa_submitted_at AND e.subject_employment_id IS NULL AND e.payload='{"action":"daa.submitted"}'::jsonb
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.lc_my_daa_submit_reviewed(jsonb,uuid,text,text),app.lc_my_daa_review_source(),app.lc_my_daa_reference(uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.lc_my_daa_submit_reviewed(jsonb,uuid,text,text),app.lc_my_daa_review_source(),app.lc_my_daa_reference(uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
-- The SAME native email/person owner, including unlinked prehire cases. No fabricated employment.
-- Case→distribution-step ownership is available both before submission and for completed retries.
CREATE FUNCTION app.lc_my_daa_custody_source(p_case uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c public.lc_case;selected uuid;
BEGIN
 IF p_case IS NULL OR current_setting('transaction_isolation')<>'read committed' OR current_setting('transaction_read_only')<>'off' OR app.principal_snapshot_current() IS NOT TRUE OR NOT EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)) THEN RAISE EXCEPTION 'Acknowledgement unavailable' USING ERRCODE='42501';END IF;
 selected:=app.lc_my_case_id();IF selected IS DISTINCT FROM p_case THEN RAISE EXCEPTION 'Acknowledgement unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO c FROM public.lc_case WHERE id=selected AND tenant_id=app.current_tenant_id() FOR UPDATE NOWAIT;
 IF NOT FOUND OR c.status NOT IN ('in_progress','completed') OR NOT c.laptop_required OR selected IS DISTINCT FROM app.lc_my_case_id() THEN RAISE EXCEPTION 'Acknowledgement unavailable' USING ERRCODE='42501';END IF;
 IF c.person_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.person p WHERE p.id=c.person_id AND p.tenant_id=c.tenant_id) THEN RAISE EXCEPTION 'Acknowledgement unavailable' USING ERRCODE='42501';END IF;
 IF c.employment_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.id=c.employment_id AND e.tenant_id=c.tenant_id AND e.company_id=c.company_id AND (c.person_id IS NULL OR e.person_id=c.person_id)) THEN RAISE EXCEPTION 'Acknowledgement unavailable' USING ERRCODE='42501';END IF;
 PERFORM 1 FROM public.lc_case_step WHERE case_id=c.id AND tenant_id=c.tenant_id AND step_key='laptop_dist' AND done FOR SHARE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'Acknowledgement unavailable' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('caseId',c.id,'caseNumber',c.number,'casePersonId',c.person_id,'employmentId',c.employment_id,'companyId',c.company_id);
END $$;
REVOKE ALL ON FUNCTION app.lc_my_daa_custody_source(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lc_my_daa_custody_source(uuid) TO ai_hr_app;

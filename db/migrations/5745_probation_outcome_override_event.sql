-- Suggestion overridden (mockup screens 4-5; handoff "If the Line Manager chooses something else, the case is flagged as
-- an override"). Tag 5745 / idx 5145 / when 1793330005445.
--
-- The override flag itself already exists: app.probation_part_command('submit_manager') stores data.override when the
-- manager's choice differs from the band's suggestion, and app.probation_submission_ready requires a written
-- justification for it. This adds the audited event the shared automation engine's "The suggested outcome is
-- overridden" trigger (lib/automation/catalogues/probation.ts, outcomeOverridden) listens for: one
-- 'probation.outcome_overridden' domain_event per manager submission, recorded in the submitting transaction by the
-- current scoped Line Manager, carrying no rater text. Idempotent per (part, submission). No table, row, grant or
-- purpose-owned object changes.
CREATE FUNCTION app.probation_record_override(p_part uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.probation_part;c public.probation_case;v jsonb;
BEGIN
 PERFORM app.probation_write_lock();
 SELECT * INTO p FROM public.probation_part WHERE id=p_part AND tenant_id=app.current_tenant_id();
 IF NOT FOUND THEN RAISE EXCEPTION 'Probation review unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO c FROM public.probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;
 IF app.probation_active_user() IS NOT TRUE OR app.probation_part_role(p.id,'lm') IS NOT TRUE THEN RAISE EXCEPTION 'Only the current Line Manager records an override' USING ERRCODE='42501';END IF;
 IF p.data->>'override' IS DISTINCT FROM 'true' OR p.data->>'managerSubmittedAt' IS NULL THEN RETURN false;END IF;
 IF EXISTS(SELECT 1 FROM public.domain_event WHERE tenant_id=c.tenant_id AND aggregate_type='probation' AND aggregate_id=c.id AND event_type='probation.outcome_overridden'
  AND payload->>'partId'=p.id::text AND payload->>'submittedAt'=p.data->>'managerSubmittedAt') THEN RETURN false;END IF;
 SELECT data INTO v FROM public.probation_rater_draft WHERE part_id=p.id AND tenant_id=p.tenant_id AND rater='lm';
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload)
 VALUES(c.tenant_id,'probation',c.id,'probation.outcome_overridden','user'::actor_type,app.current_user_id(),c.employment_id,
  jsonb_build_object('caseId',c.id,'partId',p.id,'part',(p.data->>'type')::integer,'cycle',(p.data->>'cycle')::integer,'scoreBand',p.data->'scoreBand',
   'chosen',coalesce(v->>'midpointStatus',v->>'outcome'),'submittedAt',p.data->>'managerSubmittedAt','justified',length(btrim(coalesce(v->>'justification','')))>0));
 RETURN true;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.probation_record_override(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.probation_record_override(uuid) TO ai_hr_app;

-- Retire incompatible HR allocation revisions through their owner after a proven hire-company
-- correction. Amounts, percentage rows and issued documents remain intact. The existing company
-- invariant is unchanged: no nonempty live allocation may apply to another employer.
CREATE FUNCTION app.cost_allocations_after_hire_company_correction(p_employment uuid,p_correction uuid,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE e public.employment;c public.domain_event;v_from date;v_company uuid;v_old_company uuid;
 v_revision integer;v_ids uuid[];v_review boolean;v_new uuid;v_kind text;
BEGIN
 PERFORM app.access_workforce_write_lock();
 FOREACH v_kind IN ARRAY ARRAY['department','position','cost_center','business_unit'] LOOP
  PERFORM app.lock_system_label_criteria(app.current_tenant_id(),v_kind);
 END LOOP;
 SELECT * INTO e FROM public.employment WHERE id=p_employment AND tenant_id=app.current_tenant_id() FOR UPDATE;
 SELECT * INTO c FROM public.domain_event WHERE id=p_correction AND tenant_id=e.tenant_id
  AND subject_employment_id=e.id AND event_type='employment.information.corrected';
 IF e.id IS NULL OR c.id IS NULL OR app.principal_snapshot_current() IS NOT TRUE OR app.current_user_id() IS NULL
  OR c.actor_type<>'user' OR c.actor_id IS DISTINCT FROM app.current_user_id()
  OR c.payload->>'source' IS DISTINCT FROM 'original-hire' OR coalesce(c.payload->'fields' ? 'companyId',false) IS NOT TRUE
  OR app.access_workforce_employment(e.id,'workforce.maintain') IS NOT TRUE OR nullif(trim(p_reason),'') IS NULL
  THEN RAISE EXCEPTION 'Hire allocation correction unavailable' USING ERRCODE='42501';END IF;
 v_from:=(c.payload->>'effectiveOn')::date;
 v_company:=(c.payload->'after'->>'companyId')::uuid;
 v_old_company:=(c.payload->'before'->>'companyId')::uuid;
 IF v_from IS NULL OR v_company IS NULL OR v_old_company IS NULL OR v_company=v_old_company
  OR app.is_admin_for(v_old_company) IS NOT TRUE OR app.access_workforce_company(v_old_company,'workforce.maintain') IS NOT TRUE
  OR app.is_admin_for(v_company) IS NOT TRUE OR app.access_workforce_company(v_company,'workforce.maintain') IS NOT TRUE
  THEN RAISE EXCEPTION 'Hire allocation company scope unavailable' USING ERRCODE='42501';END IF;
 SELECT revision INTO v_revision FROM public.employment_cost_allocation_head WHERE employment_id=e.id AND tenant_id=e.tenant_id FOR UPDATE;
 SELECT array_agg(locked.id ORDER BY locked.id) INTO v_ids FROM (
  SELECT s.id FROM public.employment_cost_allocation_set s
  WHERE s.employment_id=e.id AND s.tenant_id=e.tenant_id AND s.superseded_at IS NULL AND s.company_id=v_old_company
   AND EXISTS(SELECT 1 FROM public.assignment a
    JOIN jsonb_array_elements(coalesce(c.payload->'assignment','[]'::jsonb)) proof ON proof->>'replacementId'=a.id::text
    WHERE a.employment_id=e.id AND a.tenant_id=e.tenant_id AND a.superseded_at IS NULL AND a.company_id=v_company
     AND proof->'fields' ? 'companyId' AND daterange(s.valid_from,s.valid_to,'[)') && daterange(a.valid_from,a.valid_to,'[)'))
  ORDER BY s.id FOR UPDATE
 ) locked;
 IF coalesce(cardinality(v_ids),0)=0 THEN RETURN jsonb_build_object('changed',false);END IF;
 IF v_revision IS NULL THEN RAISE EXCEPTION 'Allocation revision unavailable' USING ERRCODE='40001';END IF;
 -- Independently require the canonical preservation baseline before changing any HR revision status.
 IF EXISTS(SELECT 1 FROM public.payslip p JOIN public.payroll_batch b ON b.id=p.batch_id AND b.tenant_id=p.tenant_id
  WHERE p.tenant_id=e.tenant_id AND p.employment_id=e.id AND b.status='closed'
   AND NOT EXISTS(SELECT 1 FROM public.information_payslip_snapshot s WHERE s.payslip_id=p.id AND s.tenant_id=p.tenant_id))
  THEN RAISE EXCEPTION 'Preserve issued documents before correcting hire allocations' USING ERRCODE='42501';END IF;
 SELECT EXISTS(SELECT 1 FROM public.employment_cost_allocation_row r WHERE r.tenant_id=e.tenant_id AND r.set_id=ANY(v_ids)) INTO v_review;
 UPDATE public.employment_cost_allocation_set SET superseded_at=now() WHERE id=ANY(v_ids) AND tenant_id=e.tenant_id;
 -- The normal owner validates the final company spine, CAS, dates and exact empty-set operation.
 v_new:=app.employment_cost_allocation_commit(e.id,v_company,v_from,v_revision,'clear','[]'::jsonb,'manual');
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload)
 VALUES(e.tenant_id,'employment',e.id,'employment.cost-allocations.company-corrected','user',app.current_user_id(),e.id,
  jsonb_build_object('correctionId',c.id,'effectiveDate',v_from,'retiredSetIds',to_jsonb(v_ids),
   'reviewSetId',v_new,'requiresReview',v_review,'reason',trim(p_reason),'originalRowsRetained',true));
 RETURN jsonb_build_object('changed',true,'retiredSetIds',to_jsonb(v_ids),'reviewSetId',v_new,'requiresReview',v_review);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.cost_allocations_after_hire_company_correction(uuid,uuid,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.cost_allocations_after_hire_company_correction(uuid,uuid,text) TO ai_hr_app;

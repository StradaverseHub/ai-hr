-- Generic fixed-term employment is a real native carrier kind, not a fabricated legacy project contract.
ALTER TABLE public.contract_term DROP CONSTRAINT contract_term_kind_check;
ALTER TABLE public.contract_term ADD CONSTRAINT contract_term_kind_check CHECK(kind IN('maternity_cover','project','post_retirement','fixed_term'));
--> statement-breakpoint
CREATE INDEX contract_case_period_lookup ON public.contract_case(tenant_id,employment_id,company_id,created_at DESC);
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_period_open(p_employment uuid,p_source text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE e public.employment;existing public.contract_case;new_case uuid:=gen_random_uuid();new_term uuid:=gen_random_uuid();term_version integer;flow jsonb;source jsonb;period text;queued jsonb;actor uuid:=app.current_user_id();
BEGIN
 PERFORM app.access_workforce_write_lock();
 IF app.contract_verified_human(actor) IS NOT TRUE THEN RAISE EXCEPTION 'Verified Contract principal required' USING ERRCODE='42501';END IF;
 SELECT * INTO e FROM public.employment WHERE tenant_id=app.current_tenant_id() AND id=p_employment FOR UPDATE;
 IF e.id IS NULL OR app.contract_shared_permitted('view',e.company_id,NULL,e.id) IS NOT TRUE OR app.contract_shared_permitted('decide',e.company_id,NULL,e.id) IS NOT TRUE THEN RAISE EXCEPTION 'Contract case opening unavailable' USING ERRCODE='42501';END IF;
 IF e.contract_number IS NULL OR e.contract_start_date IS NULL OR e.contract_end_date IS NULL OR e.contract_end_date<e.contract_start_date
 OR e.hired_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date OR e.voided_at IS NOT NULL OR e.blacklisted_at IS NOT NULL
 OR least(e.terminated_on,e.resignation_date,e.last_working_date)<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
 OR NOT EXISTS(SELECT 1 FROM public.company c WHERE c.tenant_id=e.tenant_id AND c.id=e.company_id AND c.archived_at IS NULL)
 OR (SELECT a.employment_type FROM public.assignment a WHERE a.tenant_id=e.tenant_id AND a.employment_id=e.id AND a.superseded_at IS NULL AND a.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (a.valid_to IS NULL OR a.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) ORDER BY a.valid_from DESC,a.id LIMIT 1) IS DISTINCT FROM 'contract'
 THEN RAISE EXCEPTION 'Verify the active fixed-term Personnel period before opening a case' USING ERRCODE='22023';END IF;
 period:=app.contract_shared_period_revision(e.id);
 IF p_source IS DISTINCT FROM period THEN RAISE EXCEPTION 'Personnel period changed; reload' USING ERRCODE='40001';END IF;
 SELECT * INTO existing FROM public.contract_case c WHERE c.tenant_id=e.tenant_id AND c.employment_id=e.id AND c.company_id=e.company_id
 AND c.data->'term'->>'startOn'=e.contract_start_date::text AND c.data->'term'->>'endOn'=e.contract_end_date::text ORDER BY c.created_at DESC,c.id LIMIT 1 FOR UPDATE;
 IF existing.id IS NOT NULL THEN
  IF existing.data->'sourceSnapshot'->>'personId' IS NOT NULL AND existing.data->'sourceSnapshot'->>'personId' IS DISTINCT FROM e.person_id::text
   OR EXISTS(SELECT 1 FROM public.contract_shared_case f WHERE f.tenant_id=e.tenant_id AND f.case_id=existing.id AND f.data->'period'->>'sourceRevision' IS DISTINCT FROM period)
  THEN RAISE EXCEPTION 'The existing period source changed; reconcile it before continuing' USING ERRCODE='40001';END IF;
  -- Opening never adopts, rewrites or restarts a legacy case. Its pinned WIP remains on the legacy route.
  RETURN jsonb_build_object('caseId',existing.id,'legacy',NOT EXISTS(SELECT 1 FROM public.contract_shared_case f WHERE f.tenant_id=e.tenant_id AND f.case_id=existing.id));
 END IF;
 -- Never bypass unfinished work for a prior period by manufacturing a second active case.
 IF EXISTS(SELECT 1 FROM public.contract_case c LEFT JOIN public.contract_shared_case f ON f.tenant_id=c.tenant_id AND f.case_id=c.id WHERE c.tenant_id=e.tenant_id AND c.employment_id=e.id AND c.company_id=e.company_id
  AND (f.case_id IS NULL AND c.data->>'state' NOT IN('renewed','handed_off','cancelled') OR f.case_id IS NOT NULL AND f.data->>'stage' NOT IN('renewed','converted','offboarding','superseded','pay')))
 THEN RAISE EXCEPTION 'Finish or reconcile the prior Contract case before opening the new Personnel period' USING ERRCODE='40001';END IF;
 source:=app.contract_source(e.id);
 SELECT coalesce(max(version),0)+1 INTO term_version FROM public.contract_term WHERE tenant_id=e.tenant_id AND employment_id=e.id;
 INSERT INTO public.contract_term(id,tenant_id,company_id,employment_id,version,kind,start_on,end_on,source_revision)
 VALUES(new_term,e.tenant_id,e.company_id,e.id,term_version,'fixed_term',e.contract_start_date,e.contract_end_date,period);
 INSERT INTO public.contract_case(id,tenant_id,company_id,employment_id,term_id,number,revision,data)
 VALUES(new_case,e.tenant_id,e.company_id,e.id,new_term,'CT-'||upper(replace(new_case::text,'-','')),1,
  jsonb_build_object('id',new_case,'revision',1,'state','upcoming','term',jsonb_build_object('id',new_term,'kind','fixed_term','startOn',e.contract_start_date,'endOn',e.contract_end_date,'sourceRevision',period),'sourceSnapshot',source,'decision',NULL,'decisionDraft',NULL));
 flow:=jsonb_build_object('version',2,'revision',1,'stage','open','period',jsonb_build_object('id',new_term,'startOn',e.contract_start_date,'endOn',e.contract_end_date,'number',e.contract_number::text,'sourceRevision',period),
  'decision',NULL,'decisionHistory','[]'::jsonb,'flags','[]'::jsonb,'lastActivityAt',now(),'posting',NULL,'payConfirmation',NULL,'offboardingId',NULL,'declined',NULL);
 INSERT INTO public.contract_shared_case(tenant_id,case_id,revision,data) VALUES(e.tenant_id,new_case,1,flow);
 PERFORM app.contract_audit(new_case,'shared.opened',jsonb_build_object('periodId',new_term,'contractNumber',e.contract_number));
 queued:=app.contract_shared_enqueue_event(new_case,'caseOpened','period:'||new_term::text,jsonb_build_object('period',flow->'period'));
 RETURN queued||jsonb_build_object('caseId',new_case,'legacy',false);
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_period_open(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_period_open(uuid,text) TO ai_hr_app;

-- Combined release allocation, 11 November 2026 (docs/MIGRATION-ALLOCATION.md): 5002_access_reader_writer_profile_values, idx 4402, when 1793330004702.
-- Draft name on its branch: 4702_access_reader_writer_profile_values. Any draft note below describes that unallocated branch position.
-- Reader/writer Access lock: profile value writers (wave 3).
-- The family child-relief sync runs inside the dependent writer's transaction. Register writers now
-- hold the shared profile-policy lock, so an exclusive request here would upgrade and could deadlock.
CREATE OR REPLACE FUNCTION app.my_sync_family_child_relief(p_person uuid, p_at timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE t uuid:=app.current_tenant_id();stat public.employee_statutory_my%ROWTYPE;derived integer;categorised integer;grid jsonb;old_grid jsonb;
 as_of date:=(p_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date;period text:=to_char(p_at AT TIME ZONE 'UTC','YYYY-MM');batches integer;
 subject uuid;country text;countries integer;before_values jsonb;after_values jsonb;
 no_sync jsonb:=jsonb_build_object('changed',false,'before',NULL,'after',NULL,'payrollAlert',NULL);
BEGIN
 IF p_at IS NULL OR NOT isfinite(p_at) THEN RAISE EXCEPTION 'Family derivation clock invalid' USING ERRCODE='22023'; END IF;
 -- Value writer: the person row below serialises it. Only policy editors take the policy lock exclusively.
 PERFORM app.access_profile_policy_value_lock();
 PERFORM 1 FROM public.person WHERE id=p_person AND tenant_id=t FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Family subject unavailable' USING ERRCODE='42501'; END IF;
 SELECT * INTO stat FROM public.employee_statutory_my WHERE tenant_id=t AND person_id=p_person FOR UPDATE;
 IF NOT FOUND THEN RETURN no_sync||jsonb_build_object('skipped','no_statutory_row'); END IF;
 IF stat.child_relief_mode IS DISTINCT FROM 'auto' THEN RETURN no_sync||jsonb_build_object('skipped','manual_mode'); END IF;
 SELECT count(*)::integer,count(*) FILTER(WHERE d.child_relief_category IN ('under_18','study_preu','study_tertiary','disabled','disabled_study'))::integer
  INTO derived,categorised FROM public.employee_dependent d
  WHERE d.tenant_id=t AND d.person_id=p_person AND app.my_family_child_relief_eligible(d,as_of);
 SELECT COALESCE(jsonb_object_agg(category,jsonb_build_object('full',full_count,'half',half_count)),'{}'::jsonb) INTO grid FROM (
  SELECT d.child_relief_category category,count(*) FILTER(WHERE d.child_relief_percentage IS DISTINCT FROM 50) full_count,
   count(*) FILTER(WHERE d.child_relief_percentage=50) half_count FROM public.employee_dependent d
  WHERE d.tenant_id=t AND d.person_id=p_person AND app.my_family_child_relief_eligible(d,as_of)
   AND d.child_relief_category IN ('under_18','study_preu','study_tertiary','disabled','disabled_study') GROUP BY d.child_relief_category
 ) counts;
 IF NOT app.my_family_grid_complete(derived,categorised) THEN grid:=NULL; END IF;
 -- Match the existing canonical grid comparison: absent/zero cells are equivalent, key order is not meaning.
 SELECT COALESCE(jsonb_object_agg(key,jsonb_build_object('full',COALESCE(value->>'full','0')::numeric,'half',COALESCE(value->>'half','0')::numeric)),'{}'::jsonb)
  INTO old_grid FROM jsonb_each(COALESCE(stat.child_relief_table,'{}'::jsonb))
  WHERE COALESCE(value->>'full','0')::numeric<>0 OR COALESCE(value->>'half','0')::numeric<>0;
 IF stat.num_children=derived AND old_grid=COALESCE(grid,'{}'::jsonb) THEN RETURN no_sync||jsonb_build_object('skipped','unchanged'); END IF;
 SELECT count(DISTINCT c.country)::integer,min(c.country) INTO countries,country FROM public.employment e JOIN public.company c ON c.id=e.company_id AND c.tenant_id=e.tenant_id WHERE e.tenant_id=t AND e.person_id=p_person;
 -- No invented jurisdiction when retained employments disagree. The ordinary non-enclosing caller
 -- retains its established NO_SYNC(error); an enclosing activation/command rolls back on this refusal.
 IF countries<>1 OR country IS DISTINCT FROM 'MY' OR EXISTS(SELECT 1 FROM public.employment e JOIN public.company c ON c.id=e.company_id AND c.tenant_id=e.tenant_id WHERE e.tenant_id=t AND e.person_id=p_person AND c.country IS NULL) THEN
  RAISE EXCEPTION 'Family automatic relief jurisdiction unavailable' USING ERRCODE='0A000'; END IF;
 SELECT e.id INTO subject FROM public.employment e WHERE e.tenant_id=t AND e.person_id=p_person ORDER BY (e.terminated_on IS NOT NULL),e.hired_on,e.id LIMIT 1;
 SELECT count(*)::integer INTO batches FROM public.payroll_batch p WHERE p.tenant_id=t AND p.pay_period=period AND p.status<>'closed'
  AND EXISTS(SELECT 1 FROM public.employment e WHERE e.tenant_id=t AND e.person_id=p_person AND e.company_id=p.company_id);
 before_values:=jsonb_build_object('numChildren',stat.num_children,'childReliefMode',stat.child_relief_mode,'childReliefTable',stat.child_relief_table);
 after_values:=jsonb_build_object('numChildren',derived,'childReliefMode',stat.child_relief_mode,'childReliefTable',grid);
 UPDATE public.employee_statutory_my SET num_children=derived,child_relief_table=grid,updated_at=now() WHERE id=stat.id AND tenant_id=t;
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload)
  VALUES(t,'employee-statutory',stat.id,'employee.tax.updated',CASE WHEN app.current_user_id() IS NULL THEN 'system'::public.actor_type ELSE 'user'::public.actor_type END,app.current_user_id(),subject,
   jsonb_build_object('personId',p_person,'before',before_values,'after',after_values,'auto',true,'provenance','auto_child_relief','derivedOn',as_of,'payrollAlert',CASE WHEN batches>0 THEN jsonb_build_object('period',period,'batches',batches) ELSE NULL END));
 RETURN jsonb_build_object('changed',true,'before',stat.num_children,'after',derived,'payrollAlert',CASE WHEN batches>0 THEN jsonb_build_object('period',period,'batches',batches) ELSE NULL END,'skipped',NULL);
END; $function$;

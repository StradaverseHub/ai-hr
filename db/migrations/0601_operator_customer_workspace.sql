-- Operator metadata and intent APIs. Customer data/table privileges are unchanged.
ALTER TABLE tenant_provision_request ADD COLUMN organization_code text
 CHECK (organization_code ~ '^[a-z0-9][a-z0-9-]{1,63}$');
--> statement-breakpoint
GRANT SELECT(organization_code) ON tenant_provision_request TO ai_hr_app;
--> statement-breakpoint
CREATE UNIQUE INDEX provision_organization_code_reserved ON tenant_provision_request(organization_code)
 WHERE organization_code IS NOT NULL AND status <> 'failed';
--> statement-breakpoint
-- Canonical work-in-flight counts, shared by the worker and operator preview. Invoker rights mean
-- a direct customer call still obeys RLS. Only the gated metadata wrapper below elevates reads.
CREATE FUNCTION app.module_deactivation_blockers(p_tenant uuid,p_module text,p_company uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb := '[]'; n integer; company_ids uuid[];
BEGIN
 SELECT coalesce(array_agg(c.id ORDER BY c.id),'{}'::uuid[]) INTO company_ids FROM public.company c
  WHERE c.tenant_id=p_tenant AND (p_company IS NULL OR c.id=p_company);
 IF cardinality(company_ids)=0 THEN RETURN result; END IF;
 IF p_module='performance' THEN
  SELECT count(*) INTO n FROM public.review_cycle c WHERE c.tenant_id=p_tenant
   AND c.company_id=ANY(company_ids) AND c.status IN ('open','calibration');
  IF n>0 THEN result:=result||jsonb_build_array(jsonb_build_object('kind','open_review_cycle','count',n,'detail',
   n||' review cycle(s) are open or in calibration and could not be closed once this module is off')); END IF;
  SELECT count(*) INTO n FROM public.performance_review r JOIN public.review_cycle c ON c.id=r.cycle_id
   WHERE c.tenant_id=p_tenant AND c.company_id=ANY(company_ids) AND r.enacted_at IS NULL
   AND (r.recommended_merit_pct IS NOT NULL OR r.recommended_bonus IS NOT NULL);
  IF n>0 THEN result:=result||jsonb_build_array(jsonb_build_object('kind','unenacted_recommendation','count',n,'detail',
   n||' pay recommendation(s) have been made and not yet enacted — a promise to an employee')); END IF;
 END IF;
 IF p_module='toil' THEN
  SELECT count(*) INTO n FROM public.toil_accrual a JOIN public.employment e ON e.id=a.employment_id
   WHERE a.tenant_id=p_tenant AND e.company_id=ANY(company_ids) AND a.status='active';
  IF n>0 THEN result:=result||jsonb_build_array(jsonb_build_object('kind','active_toil_accrual','count',n,'detail',
   n||' banked TOIL credit(s) are still active — earned time the employee has not taken or been paid for')); END IF;
 END IF;
 IF p_module IN ('payroll','multi_cycle_payroll','typed_pay_components') THEN
  SELECT count(*) INTO n FROM public.payroll_batch b WHERE b.tenant_id=p_tenant
   AND b.company_id=ANY(company_ids) AND b.status='draft';
  IF n>0 THEN result:=result||jsonb_build_array(jsonb_build_object('kind','draft_payroll_batch','count',n,'detail',
   n||' payroll batch(es) are still in draft and would become unprocessable')); END IF;
 END IF;
 RETURN result;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.module_deactivation_blockers(uuid,text,uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.module_deactivation_blockers(uuid,text,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assert_customer_operator() RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT app.is_operator() OR app.login_blocked(app.current_user_id()) OR NOT EXISTS(SELECT 1 FROM public.role_assignment r
  WHERE r.tenant_id=app.current_tenant_id() AND r.app_user_id=app.current_user_id() AND r.role::text='operator')
 THEN RAISE EXCEPTION 'OPERATOR_REQUIRED' USING ERRCODE='42501'; END IF;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.assert_customer_operator() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.operator_customer_data(p_tenant uuid DEFAULT NULL)
RETURNS TABLE(tenant_id uuid,customer_name text,customer_status text,request_id uuid,admin_email text,country text,modules jsonb,changes jsonb,blockers jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM app.assert_customer_operator();
 RETURN QUERY SELECT t.id,t.name,t.status,r.id,r.admin_email,r.country,
  coalesce((SELECT jsonb_agg(jsonb_build_object('code',m.module_code,'status',CASE WHEN m.status IN ('active','trial') AND m.expires_at<=now() THEN 'expired' ELSE m.status END,'companyId',m.company_id) ORDER BY m.module_code,m.company_id)
   FROM public.tenant_module m WHERE m.tenant_id=t.id),'[]'::jsonb),
  coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.created_at DESC,c.id DESC) FROM
   (SELECT x.id,x.module_code,x.action,x.status,x.error,x.created_at,x.decided_at
    FROM public.module_change_request x WHERE x.tenant_id=t.id ORDER BY x.created_at DESC,x.id DESC LIMIT 20) c),'[]'::jsonb),
  CASE WHEN p_tenant IS NULL THEN '{}'::jsonb ELSE
   coalesce((SELECT jsonb_object_agg(m.code,app.module_deactivation_blockers(t.id,m.code,NULL)) FROM public.module m WHERE NOT m.is_core),'{}'::jsonb) END
 FROM public.tenant t LEFT JOIN LATERAL
  (SELECT q.id,q.admin_email,q.country FROM public.tenant_provision_request q WHERE q.tenant_id=t.id AND q.status='done'
   ORDER BY q.created_at DESC,q.id DESC LIMIT 1) r ON true
 WHERE t.id<>'00000000-0000-0000-0000-000000000000'::uuid AND (p_tenant IS NULL OR t.id=p_tenant)
 ORDER BY t.name,t.id;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.operator_customer_data(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.operator_customer_data(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.operator_rename_customer(p_tenant uuid,p_name text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE old_name text;
BEGIN
 PERFORM app.assert_customer_operator();
 IF coalesce(length(btrim(p_name)),0) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'OPERATOR_NAME_INVALID'; END IF;
 SELECT name INTO old_name FROM public.tenant WHERE id=p_tenant AND id<>'00000000-0000-0000-0000-000000000000'::uuid FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'OPERATOR_CUSTOMER_MISSING'; END IF;
 IF old_name=btrim(p_name) THEN RETURN; END IF;
 UPDATE public.tenant SET name=btrim(p_name) WHERE id=p_tenant;
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
 VALUES(p_tenant,'tenant',p_tenant,'tenant.renamed','user',app.current_user_id(),jsonb_build_object('before',old_name,'after',btrim(p_name)));
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.operator_rename_customer(uuid,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.operator_rename_customer(uuid,text) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.operator_request_module_change(p_tenant uuid,p_module text,p_action text,p_purchase text DEFAULT NULL,p_disposition jsonb DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result uuid; billable boolean; current_status text; blocker jsonb;
BEGIN
 PERFORM app.assert_customer_operator();
 PERFORM pg_advisory_xact_lock(hashtextextended('operator-modules:'||p_tenant::text,0));
 IF NOT EXISTS(SELECT 1 FROM public.tenant WHERE id=p_tenant AND id<>'00000000-0000-0000-0000-000000000000'::uuid)
 THEN RAISE EXCEPTION 'OPERATOR_CUSTOMER_MISSING'; END IF;
 IF p_action NOT IN ('activate','deactivate') OR p_action IS NULL THEN RAISE EXCEPTION 'OPERATOR_ACTION_INVALID'; END IF;
 SELECT m.billable INTO billable FROM public.module m WHERE m.code=p_module AND NOT m.is_core;
 IF NOT FOUND THEN RAISE EXCEPTION 'OPERATOR_MODULE_INVALID'; END IF;
 IF EXISTS(SELECT 1 FROM public.module_change_request WHERE tenant_id=p_tenant AND status IN ('pending','running'))
 THEN RAISE EXCEPTION 'OPERATOR_CHANGE_PENDING'; END IF;
 -- This console manages tenant-wide grants. Never silently replace an existing company contract.
 IF EXISTS(SELECT 1 FROM public.tenant_module WHERE tenant_id=p_tenant AND module_code=p_module AND company_id IS NOT NULL)
 THEN RAISE EXCEPTION 'OPERATOR_SCOPED_MODULE'; END IF;
 SELECT CASE WHEN status IN ('active','trial') AND expires_at<=now() THEN 'expired' ELSE status END INTO current_status FROM public.tenant_module WHERE tenant_id=p_tenant AND module_code=p_module AND company_id IS NULL;
 IF (p_action='activate' AND current_status IN ('active','trial')) OR
    (p_action='deactivate' AND coalesce(current_status,'disabled') NOT IN ('active','trial'))
 THEN RAISE EXCEPTION 'OPERATOR_STATE_CHANGED'; END IF;
 IF p_action='activate' THEN
  IF EXISTS(SELECT 1 FROM public.module m CROSS JOIN LATERAL jsonb_array_elements_text(m.depends_on) d(code)
   JOIN public.module dep ON dep.code=d.code WHERE m.code=p_module AND NOT dep.is_core AND NOT EXISTS(
    SELECT 1 FROM public.tenant_module tm WHERE tm.tenant_id=p_tenant AND tm.module_code=dep.code
     AND tm.company_id IS NULL AND tm.status IN ('active','trial') AND (tm.expires_at IS NULL OR tm.expires_at>now())))
  THEN RAISE EXCEPTION 'OPERATOR_DEPENDENCIES'; END IF;
  IF billable THEN
   IF length(btrim(coalesce(p_purchase,''))) NOT BETWEEN 3 AND 500 THEN RAISE EXCEPTION 'OPERATOR_PURCHASE_REQUIRED'; END IF;
   INSERT INTO public.subscription_line(tenant_id,module_code,scope_note)
    SELECT p_tenant,p_module,btrim(p_purchase) WHERE NOT EXISTS(SELECT 1 FROM public.subscription_line
     WHERE tenant_id=p_tenant AND module_code=p_module AND scope_note=btrim(p_purchase));
  END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM public.tenant_module tm JOIN public.module m ON m.code=tm.module_code
   WHERE tm.tenant_id=p_tenant AND tm.status IN ('active','trial') AND (tm.expires_at IS NULL OR tm.expires_at>now()) AND m.depends_on ? p_module)
  THEN RAISE EXCEPTION 'OPERATOR_DEPENDENTS'; END IF;
  FOR blocker IN SELECT value FROM jsonb_array_elements(app.module_deactivation_blockers(p_tenant,p_module,NULL)) LOOP
   IF jsonb_typeof(p_disposition->(blocker->>'kind')) IS DISTINCT FROM 'string'
      OR length(btrim(coalesce(p_disposition->>(blocker->>'kind'),''))) NOT BETWEEN 3 AND 1000
   THEN RAISE EXCEPTION 'OPERATOR_DISPOSITION_REQUIRED'; END IF;
  END LOOP;
 END IF;
 INSERT INTO public.module_change_request(tenant_id,module_code,action,requested_by,disposition)
 VALUES(p_tenant,p_module,p_action,app.current_user_id()::text,p_disposition) RETURNING id INTO result;
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
 VALUES(p_tenant,'tenant-module',result,'module.change-requested','user',app.current_user_id(),jsonb_build_object('moduleCode',p_module,'action',p_action));
 RETURN result;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.operator_request_module_change(uuid,text,text,text,jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.operator_request_module_change(uuid,text,text,text,jsonb) TO ai_hr_app;

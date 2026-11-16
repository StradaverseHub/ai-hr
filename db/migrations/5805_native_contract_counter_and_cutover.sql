-- Native Personnel owns the ordinal, including contracts made before this system.
-- Unknown historical numbers remain unknown until People Ops verifies them. Never infer from case references.
ALTER TABLE public.employment ADD COLUMN contract_number integer CHECK(contract_number BETWEEN 1 AND 100000);
--> statement-breakpoint
-- The period revision excludes live names and pay. Those may change before a letter's first signature.
CREATE FUNCTION app.contract_shared_period_revision(p_employment uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT encode(sha256(convert_to(jsonb_build_array(e.id,e.company_id,e.contract_start_date,e.contract_end_date,e.contract_number,a.employment_type,e.voided_at,e.blacklisted_at,e.resignation_date,e.last_working_date,e.terminated_on)::text,'UTF8')),'hex')
 FROM public.employment e LEFT JOIN LATERAL(SELECT employment_type FROM public.assignment a WHERE a.tenant_id=e.tenant_id AND a.employment_id=e.id AND a.superseded_at IS NULL AND a.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (a.valid_to IS NULL OR a.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) ORDER BY a.valid_from DESC,a.id LIMIT 1) a ON true
 WHERE e.tenant_id=app.current_tenant_id() AND e.id=p_employment
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.contract_shared_period_revision(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
ALTER FUNCTION app.contract_shared_adopt(uuid) RENAME TO contract_shared_adopt_before_number;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_adopt(p_case uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c public.contract_case;e public.employment;f jsonb;
BEGIN
 PERFORM app.access_workforce_write_lock();
 SELECT * INTO c FROM public.contract_case WHERE tenant_id=app.current_tenant_id() AND id=p_case FOR UPDATE;
 IF c.id IS NULL OR app.contract_shared_case_permitted(p_case,'decide') IS NOT TRUE THEN RAISE EXCEPTION 'Contract case is unavailable' USING ERRCODE='42501';END IF;
 SELECT data INTO f FROM public.contract_shared_case WHERE tenant_id=c.tenant_id AND case_id=c.id;
 IF f IS NOT NULL THEN RETURN f;END IF;
 SELECT * INTO e FROM public.employment WHERE tenant_id=c.tenant_id AND id=c.employment_id FOR UPDATE;
 IF e.contract_number IS NULL OR e.contract_start_date IS NULL OR e.contract_end_date IS NULL THEN RAISE EXCEPTION 'Verify contract number and dates in Personnel Management before starting shared workflows' USING ERRCODE='22023';END IF;
 IF c.source_conflict IS NOT NULL OR e.contract_start_date::text IS DISTINCT FROM c.data->'term'->>'startOn' OR e.contract_end_date::text IS DISTINCT FROM c.data->'term'->>'endOn' THEN RAISE EXCEPTION 'Personnel dates changed; reconcile the current period before cutover' USING ERRCODE='40001';END IF;
 f:=app.contract_shared_adopt_before_number(p_case);
 f:=jsonb_set(f,'{period,number}',to_jsonb(e.contract_number::text));
 f:=jsonb_set(f,'{period,sourceRevision}',to_jsonb(app.contract_shared_period_revision(c.employment_id)));
 UPDATE public.contract_shared_case SET data=f WHERE tenant_id=c.tenant_id AND case_id=c.id;
 RETURN f;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.contract_shared_adopt_before_number(uuid),app.contract_shared_adopt(uuid) FROM PUBLIC,ai_hr_app;
GRANT EXECUTE ON FUNCTION app.contract_shared_adopt(uuid) TO ai_hr_app;
--> statement-breakpoint
-- All legacy record/document effects share this admission. An adopted case cannot execute two owners.
ALTER FUNCTION app.contract_effect_company_authorised(uuid) RENAME TO contract_effect_company_authorised_before_shared;
--> statement-breakpoint
CREATE FUNCTION app.contract_effect_company_authorised(wanted_case uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT NOT EXISTS(SELECT 1 FROM public.contract_shared_case s WHERE s.tenant_id=app.current_tenant_id() AND s.case_id=wanted_case)
 AND app.contract_effect_company_authorised_before_shared(wanted_case)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.contract_effect_company_authorised_before_shared(uuid),app.contract_effect_company_authorised(uuid) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.contract_shared_number_locked(p_employment uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.contract_case c LEFT JOIN public.contract_shared_case s ON s.tenant_id=c.tenant_id AND s.case_id=c.id
 WHERE c.tenant_id=app.current_tenant_id() AND c.employment_id=p_employment
 AND (s.case_id IS NOT NULL AND s.data->>'stage' NOT IN('renewed','converted','offboarding')
 OR s.case_id IS NULL AND c.data->'decision' IS DISTINCT FROM 'null'::jsonb AND c.data->>'state' NOT IN('renewed','handed_off','cancelled')))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.contract_shared_number_locked(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_number_locked(uuid) TO ai_hr_app;

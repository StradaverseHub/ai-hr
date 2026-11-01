-- Reuse this selection plan while all native table RLS evaluates as the actual caller.
-- SECURITY INVOKER; no permission result cache, source mutation or broader read scope.
CREATE FUNCTION app.overtime_formula_candidate_for_day(p_tenant uuid,p_employment text,p_date date,p_company uuid) RETURNS uuid LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $fn$
 DECLARE answer uuid;
 BEGIN
 SELECT a.id INTO answer FROM public.overtime_pattern_assignment a
 JOIN public.overtime_pattern_version v ON v.id=a.version_id
 JOIN public.overtime_pattern pat ON pat.id=v.pattern_id
 WHERE a.tenant_id=p_tenant AND v.kind='formula' AND pat.archived_at IS NULL
 AND a.superseded_at IS NULL AND a.valid_from<=p_date AND (a.valid_to IS NULL OR a.valid_to>p_date)
 AND (a.target->>'type'='group' OR a.target->'employmentIds' ? p_employment)
 AND (p_company IS NULL OR EXISTS(SELECT 1 FROM public.overtime_pattern_version_company co WHERE co.version_id=v.id AND co.company_id=p_company))
 AND (SELECT st.state FROM public.overtime_pattern_version_state st WHERE st.version_id=v.id AND st.effective_from<=p_date ORDER BY st.effective_from DESC,st.sequence DESC LIMIT 1)='active'
 ORDER BY a.id LIMIT 1;
 RETURN answer;
 END $fn$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.overtime_formula_candidate_for_day(uuid,text,date,uuid) FROM PUBLIC,ai_hr_app;
GRANT EXECUTE ON FUNCTION app.overtime_formula_candidate_for_day(uuid,text,date,uuid) TO ai_hr_app;

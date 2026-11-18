-- Bounded own-work preparation projection; task and sent-document semantics stay unchanged.
ALTER FUNCTION app.lc_v9_work(uuid) RENAME TO lc_v9_work_before_personnel_completion_6684;
REVOKE ALL ON FUNCTION app.lc_v9_work_before_personnel_completion_6684(uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.lc_v9_work(p_id uuid DEFAULT NULL) RETURNS SETOF jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT original||jsonb_build_object('documents',coalesce(original->'documents','[]'::jsonb)||coalesce((SELECT jsonb_agg(app.personnel_completion_preparation_projection(d) ORDER BY d->>'createdAt',d->>'id') FROM lc_v9_case c CROSS JOIN LATERAL jsonb_array_elements(c.data->'documents') d
 WHERE c.id::text=original->>'id' AND c.tenant_id=app.current_tenant_id() AND original->>'own'='true' AND app.probation_company_entitled(c.company_id)
 AND d->'personnelCompletion'?'preparation' AND d->>'sentAt' IS NULL AND d->>'status'='draft'
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(original->'documents','[]'::jsonb)) prior WHERE prior->>'id'=d->>'id')),'[]'::jsonb))
 FROM app.lc_v9_work_before_personnel_completion_6684(p_id) original
$$;
ALTER FUNCTION app.onboarding_v9_work() RENAME TO onboarding_v9_work_before_personnel_completion_6684;
REVOKE ALL ON FUNCTION app.onboarding_v9_work_before_personnel_completion_6684() FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.onboarding_v9_work() RETURNS SETOF jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT original||jsonb_build_object('documents',coalesce(original->'documents','[]'::jsonb)||coalesce((SELECT jsonb_agg(app.personnel_completion_preparation_projection(d) ORDER BY d->>'createdAt',d->>'id') FROM lc_onboarding_case c JOIN lc_onboarding_private p ON p.case_id=c.id AND p.tenant_id=c.tenant_id
 CROSS JOIN LATERAL jsonb_array_elements(coalesce(p.data->'lifecycleV9'->'documents','[]'::jsonb)) d
 WHERE c.id::text=original->>'id' AND c.tenant_id=app.current_tenant_id() AND original->>'own'='true' AND app.probation_company_entitled(c.company_id)
 AND d->'personnelCompletion'?'preparation' AND d->>'sentAt' IS NULL AND d->>'status'='draft'
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(original->'documents','[]'::jsonb)) prior WHERE prior->>'id'=d->>'id')),'[]'::jsonb))
 FROM app.onboarding_v9_work_before_personnel_completion_6684() original
$$;
REVOKE ALL ON FUNCTION app.lc_v9_work(uuid),app.onboarding_v9_work() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lc_v9_work(uuid),app.onboarding_v9_work() TO ai_hr_app;

-- Company deletion must account for private Architecture and Rewards retention without reading their records as the caller.
DO $$
DECLARE relation text;
BEGIN
  IF pg_has_role('ai_hr_app', current_user, 'MEMBER') THEN
    RAISE EXCEPTION 'Company retention owner must be distinct from the application role';
  END IF;
  FOREACH relation IN ARRAY ARRAY[
    'job_architecture_import_preview', 'job_architecture_jd_publication',
    'job_architecture_jd_publication_history', 'job_architecture_outlier',
    'job_architecture_position_revision', 'job_architecture_proposal',
    'job_architecture_seat', 'job_architecture_suggestion',
    'reward_company_year_review', 'reward_page_grant', 'reward_pat_version',
    'reward_plan_company', 'reward_plan_setup', 'reward_setup_grant',
    'company_registration_classification'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY company_retention_2211 ON public.%I FOR SELECT TO %I USING (tenant_id = app.current_tenant_id())',
      relation, current_user
    );
  END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.expansion_reward_company_in_use(wanted_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT CASE WHEN app.principal_snapshot_current() AND app.is_admin() AND EXISTS (
    SELECT 1 FROM public.company c
    WHERE c.tenant_id = app.current_tenant_id() AND c.id = wanted_company
      AND app.is_admin_for(coalesce(app.company_org_current_parent(c.id), c.id))
  ) THEN EXISTS (
    SELECT 1 FROM public.reward_company_year_review r
    WHERE r.tenant_id = app.current_tenant_id() AND r.company_id = wanted_company
  ) ELSE false END;
$$;
REVOKE ALL ON FUNCTION app.expansion_reward_company_in_use(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.expansion_reward_company_in_use(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.expansion_other_company_in_use(wanted_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT CASE WHEN app.principal_snapshot_current() AND app.is_admin() AND EXISTS (
    SELECT 1 FROM public.company c
    WHERE c.tenant_id = app.current_tenant_id() AND c.id = wanted_company
      AND app.is_admin_for(coalesce(app.company_org_current_parent(c.id), c.id))
  ) THEN (
    EXISTS (SELECT 1 FROM public.company_registration_classification r WHERE r.tenant_id = app.current_tenant_id() AND r.company_id = wanted_company)
    OR EXISTS (SELECT 1 FROM public.job_architecture_import_preview r WHERE r.tenant_id = app.current_tenant_id() AND r.company_id = wanted_company)
    OR EXISTS (SELECT 1 FROM public.job_architecture_jd_publication r WHERE r.tenant_id = app.current_tenant_id() AND r.variant_company_id = wanted_company)
    OR EXISTS (SELECT 1 FROM public.job_architecture_jd_publication_history r WHERE r.tenant_id = app.current_tenant_id() AND r.variant_company_id = wanted_company)
    OR EXISTS (
      SELECT 1 FROM public.job_architecture_position_revision r LEFT JOIN public.position p ON p.tenant_id = r.tenant_id AND p.id = r.position_id
      WHERE r.tenant_id = app.current_tenant_id() AND (r.company_id = wanted_company OR p.company_id = wanted_company)
    )
    OR EXISTS (SELECT 1 FROM public.job_architecture_proposal r WHERE r.tenant_id = app.current_tenant_id() AND (r.company_id = wanted_company OR wanted_company = ANY(r.affected_company_ids)))
    OR EXISTS (SELECT 1 FROM public.job_architecture_seat r WHERE r.tenant_id = app.current_tenant_id() AND r.company_id = wanted_company)
    OR EXISTS (SELECT 1 FROM public.job_architecture_suggestion r WHERE r.tenant_id = app.current_tenant_id() AND r.company_id = wanted_company)
    OR EXISTS (
      SELECT 1 FROM public.job_architecture_outlier r LEFT JOIN public.business_unit b ON b.tenant_id = r.tenant_id AND b.id = r.business_unit_id
      WHERE r.tenant_id = app.current_tenant_id() AND (wanted_company = ANY(r.company_ids) OR b.company_id = wanted_company)
    )
    OR EXISTS (SELECT 1 FROM public.reward_page_grant r WHERE r.tenant_id = app.current_tenant_id() AND r.company_id = wanted_company)
    OR EXISTS (SELECT 1 FROM public.reward_pat_version r WHERE r.tenant_id = app.current_tenant_id() AND r.company_id = wanted_company)
    OR EXISTS (SELECT 1 FROM public.reward_plan_company r WHERE r.tenant_id = app.current_tenant_id() AND r.company_id = wanted_company)
    OR EXISTS (SELECT 1 FROM public.reward_plan_setup r WHERE r.tenant_id = app.current_tenant_id() AND wanted_company = ANY(r.company_ids))
    OR EXISTS (SELECT 1 FROM public.reward_setup_grant r WHERE r.tenant_id = app.current_tenant_id() AND r.company_id = wanted_company)
  ) ELSE false END;
$$;
REVOKE ALL ON FUNCTION app.expansion_other_company_in_use(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.expansion_other_company_in_use(uuid) TO ai_hr_app;
--> statement-breakpoint
-- Preserve each single-column key's NO ACTION behavior and add the tenant match beside it.
-- These expansion tables are new to this release. Validation refuses any inconsistent rows without rewriting them.
DO $$
DECLARE relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY[
    'company_registration_classification', 'job_architecture_import_preview',
    'job_architecture_position_revision', 'job_architecture_proposal', 'job_architecture_seat',
    'job_architecture_suggestion', 'reward_company_year_review', 'reward_page_grant',
    'reward_pat_version', 'reward_plan_company', 'reward_setup_grant'
  ] LOOP
    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID',
      relation, relation || '_company_tenant_fk'
    );
    EXECUTE format('ALTER TABLE public.%I VALIDATE CONSTRAINT %I', relation, relation || '_company_tenant_fk');
  END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE public.job_architecture_jd_publication
  ADD CONSTRAINT job_architecture_jd_publication_company_tenant_fk
  FOREIGN KEY (variant_company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
ALTER TABLE public.job_architecture_jd_publication
  VALIDATE CONSTRAINT job_architecture_jd_publication_company_tenant_fk;

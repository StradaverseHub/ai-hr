-- Offboarding administration retains its existing company and module membership.
-- Employee and assigned work use their own subject-bound entry points.
ALTER POLICY v9_case_read ON public.lc_v9_case USING (
 tenant_id=app.current_tenant_id()
 AND app.lc_v9_off_access(company_id)
 AND app.lifecycle_reward_notice_action('lifecycle','view',company_id)
);
ALTER POLICY v9_case_revision_read ON public.lc_v9_case_revision USING (
 tenant_id=app.current_tenant_id()
 AND app.lc_v9_off_access(company_id)
 AND app.lifecycle_reward_notice_action('lifecycle','view',company_id)
);
ALTER POLICY v9_file_read ON public.lc_v9_file USING (
 tenant_id=app.current_tenant_id()
 AND app.lifecycle_reward_notice_action('lifecycle','view',company_id)
 AND (
  case_id IS NOT NULL AND app.lc_v9_off_access(company_id)
  OR onboarding_case_id IS NOT NULL AND app.is_admin_for(company_id)
   AND (app.onboarding_page_access() OR app.onboarding_v9_case_actor() OR app.is_group_admin())
 )
);

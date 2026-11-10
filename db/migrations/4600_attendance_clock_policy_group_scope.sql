-- c03670cc Schedule Group configuration. Installing this migration rewrites no Schedule Group,
-- punch, attendance result, payroll input or payslip. Existing company revisions keep their bytes,
-- ordinals and dates.
--
-- Group-wide clock settings: a revision whose company_id is NULL applies to every company in the
--    tenant (including companies created later) unless that company has its own revision effective on
--    the date. Group-wide rows keep their own append-only ordinal and date chain per Schedule Group.
ALTER TABLE public.attendance_clock_policy_revision ALTER COLUMN company_id DROP NOT NULL;
CREATE UNIQUE INDEX attendance_clock_policy_group_ordinal_uq
 ON public.attendance_clock_policy_revision(tenant_id,rule_id,ordinal) WHERE company_id IS NULL;
CREATE UNIQUE INDEX attendance_clock_policy_group_date_uq
 ON public.attendance_clock_policy_revision(tenant_id,rule_id,effective_from) WHERE company_id IS NULL;
--> statement-breakpoint

-- A group-wide setting is tenant configuration with no amounts, read by every dated clock resolution in
-- the tenant (as the tenant-wide Schedule Group library is). Company rows keep their existing scope.
DROP POLICY attendance_clock_policy_read ON public.attendance_clock_policy_revision;
CREATE POLICY attendance_clock_policy_read ON public.attendance_clock_policy_revision FOR SELECT
 USING(tenant_id=app.current_tenant_id() AND (SELECT app.attendance_policy_principal_current()) AND (
  company_id IS NULL
  OR app.is_admin_for(company_id)
  OR app.can_admin_payroll_for(company_id)
  OR EXISTS(SELECT 1 FROM public.employment e WHERE e.tenant_id=attendance_clock_policy_revision.tenant_id
   AND e.company_id=attendance_clock_policy_revision.company_id AND e.id=ANY((SELECT app.visible_employment_ids())::uuid[]))
  OR EXISTS(SELECT 1 FROM public.assignment a WHERE a.tenant_id=attendance_clock_policy_revision.tenant_id
   AND a.company_id=attendance_clock_policy_revision.company_id AND a.superseded_at IS NULL
   AND a.employment_id=ANY((SELECT app.visible_employment_ids())::uuid[]))
 ));
-- Only a group administrator may write a group-wide row; a company administrator writes their companies.
DROP POLICY attendance_clock_policy_insert ON public.attendance_clock_policy_revision;
CREATE POLICY attendance_clock_policy_insert ON public.attendance_clock_policy_revision FOR INSERT
 WITH CHECK(tenant_id=app.current_tenant_id() AND (SELECT app.attendance_policy_principal_current())
  AND (CASE WHEN company_id IS NULL THEN app.is_group_admin() ELSE app.is_admin_for(company_id) END) IS TRUE
  AND created_by_user_id=app.current_user_id());
-- Table grants are unchanged (4202: SELECT, INSERT to ai_hr_app). They are deliberately not re-granted
-- here so that a column-scoped SELECT grant applied by another migration is never widened again.
--> statement-breakpoint

-- The guard reads only the prior ordinal and date (compatible with column-scoped SELECT grants) and
-- chains each scope independently: one company, or the group-wide (NULL) scope.
CREATE OR REPLACE FUNCTION app.guard_attendance_clock_policy_revision() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE previous_ordinal integer; previous_effective_from date;
BEGIN
 IF TG_OP<>'INSERT' THEN
  RAISE EXCEPTION 'Retain immutable Attendance clock policy history' USING ERRCODE='23514';
 END IF;
 PERFORM app.lock_attendance_clock_policy_configuration(NEW.tenant_id);
 IF app.attendance_policy_principal_current() IS NOT TRUE
  OR (CASE WHEN NEW.company_id IS NULL THEN app.is_group_admin() ELSE app.is_admin_for(NEW.company_id) END) IS NOT TRUE
  OR NEW.created_by_user_id IS DISTINCT FROM app.current_user_id() THEN
  RAISE EXCEPTION 'Attendance clock policy is outside company administrator scope' USING ERRCODE='42501';
 END IF;
 IF (NEW.company_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.company
   WHERE id=NEW.company_id AND tenant_id=NEW.tenant_id AND archived_at IS NULL))
  OR NOT EXISTS(SELECT 1 FROM public.attendance_rule WHERE id=NEW.rule_id AND tenant_id=NEW.tenant_id AND status='active') THEN
  RAISE EXCEPTION 'Choose an active company and Schedule Group in this tenant' USING ERRCODE='23514';
 END IF;
 NEW.created_at:=clock_timestamp();
 IF NEW.effective_from<=(NEW.created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date THEN
  RAISE EXCEPTION 'Choose a future date for Attendance clock settings' USING ERRCODE='23514';
 END IF;
 IF NEW.company_id IS NULL THEN
  SELECT ordinal,effective_from INTO previous_ordinal,previous_effective_from FROM public.attendance_clock_policy_revision
  WHERE tenant_id=NEW.tenant_id AND company_id IS NULL AND rule_id=NEW.rule_id
  ORDER BY ordinal DESC LIMIT 1;
 ELSE
  SELECT ordinal,effective_from INTO previous_ordinal,previous_effective_from FROM public.attendance_clock_policy_revision
  WHERE tenant_id=NEW.tenant_id AND company_id=NEW.company_id AND rule_id=NEW.rule_id
  ORDER BY ordinal DESC LIMIT 1;
 END IF;
 IF NEW.ordinal<>coalesce(previous_ordinal,0)+1 OR previous_effective_from>=NEW.effective_from THEN
  RAISE EXCEPTION 'Attendance clock policy history changed. Reload before scheduling.' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.guard_attendance_clock_policy_revision() FROM PUBLIC,ai_hr_app;

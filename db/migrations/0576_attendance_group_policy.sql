-- Centrally reserved 0576. No existing group, attendance, approval or paid result is changed.
-- The shift/group library stays tenant-wide. A dated execution policy is company-specific so that
-- a shared group can reference that employer's currency-scoped central formula versions.
CREATE TABLE public.attendance_group_policy_revision (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL REFERENCES public.company(id) ON DELETE RESTRICT,
 rule_id uuid NOT NULL REFERENCES public.attendance_rule(id) ON DELETE RESTRICT,
 ordinal integer NOT NULL CHECK(ordinal>0),effective_from date NOT NULL,
 policy jsonb NOT NULL CHECK(jsonb_typeof(policy)='object' AND octet_length(policy::text)<=65536
  AND policy ?& ARRAY['version','clock','overtime'] AND policy->'version'='1'::jsonb
  AND jsonb_typeof(policy->'clock')='object' AND jsonb_typeof(policy->'overtime')='object'),
 reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 500),
 created_by_user_id uuid NOT NULL REFERENCES public.app_user(id),created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT attendance_group_policy_revision_ordinal_uq UNIQUE(tenant_id,company_id,rule_id,ordinal),
 CONSTRAINT attendance_group_policy_revision_date_uq UNIQUE(tenant_id,company_id,rule_id,effective_from)
);
--> statement-breakpoint
ALTER TABLE public.attendance_group_policy_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_group_policy_revision FORCE ROW LEVEL SECURITY;
-- Configuration contains no salary, personal subject or formula amounts. Canonical attendance can
-- read its policy under the employee context; configuration screens separately require scoped admin.
CREATE POLICY attendance_group_policy_read ON public.attendance_group_policy_revision FOR SELECT
 USING(tenant_id=app.current_tenant_id());
CREATE POLICY attendance_group_policy_insert ON public.attendance_group_policy_revision FOR INSERT
 WITH CHECK(tenant_id=app.current_tenant_id() AND app.is_admin_for(company_id)
  AND created_by_user_id=app.current_user_id());
GRANT SELECT,INSERT ON public.attendance_group_policy_revision TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.guard_attendance_group_policy_revision() RETURNS trigger LANGUAGE plpgsql
 SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE previous public.attendance_group_policy_revision;kind text;day jsonb;ref text;
 version public.overtime_pattern_version;state text;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Retain immutable attendance policy history' USING ERRCODE='23514';END IF;
 PERFORM app.lock_overtime_configuration(NEW.tenant_id);
 IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NOT app.is_admin_for(NEW.company_id)
  OR NEW.created_by_user_id IS DISTINCT FROM app.current_user_id() THEN
  RAISE EXCEPTION 'Attendance policy is outside company administrator scope' USING ERRCODE='42501';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.company WHERE id=NEW.company_id AND tenant_id=NEW.tenant_id AND archived_at IS NULL)
  OR NOT EXISTS(SELECT 1 FROM public.attendance_rule WHERE id=NEW.rule_id AND tenant_id=NEW.tenant_id AND status='active') THEN
  RAISE EXCEPTION 'Choose an active company and Schedule Group in this tenant' USING ERRCODE='23514';END IF;
 IF NEW.effective_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date THEN
  RAISE EXCEPTION 'Activate attendance policies on an explicit future date' USING ERRCODE='23514';END IF;
 SELECT * INTO previous FROM public.attendance_group_policy_revision
  WHERE tenant_id=NEW.tenant_id AND company_id=NEW.company_id AND rule_id=NEW.rule_id ORDER BY ordinal DESC LIMIT 1;
 IF NEW.ordinal<>coalesce(previous.ordinal,0)+1 OR previous.effective_from>=NEW.effective_from THEN
  RAISE EXCEPTION 'Attendance policy history changed; reload before scheduling a new version' USING ERRCODE='23514';END IF;
 IF jsonb_typeof(NEW.policy->'overtime'->'enabled') IS DISTINCT FROM 'boolean'
  OR jsonb_typeof(NEW.policy->'overtime'->'days') IS DISTINCT FROM 'object' THEN
  RAISE EXCEPTION 'Incomplete overtime policy' USING ERRCODE='23514';END IF;
 FOREACH kind IN ARRAY ARRAY['normal','off','rest','publicHoliday','replacementHoliday'] LOOP
  day:=NEW.policy->'overtime'->'days'->kind;
  IF jsonb_typeof(day) IS DISTINCT FROM 'object' OR NOT day ? 'patternVersionId' THEN
   RAISE EXCEPTION 'Retain all five day-specific policy bindings' USING ERRCODE='23514';END IF;
  ref:=day->>'patternVersionId';
  IF ref IS NULL THEN
   IF NEW.policy->'overtime'->'enabled'='true'::jsonb THEN
    RAISE EXCEPTION 'Enabled overtime needs all five central patterns' USING ERRCODE='23514';END IF;
   CONTINUE;
  END IF;
  SELECT v.* INTO version FROM public.overtime_pattern_version v
   JOIN public.overtime_pattern p ON p.id=v.pattern_id AND p.tenant_id=v.tenant_id
   WHERE v.id=ref::uuid AND v.tenant_id=NEW.tenant_id AND v.kind='formula' AND v.activated_at IS NOT NULL
    AND p.archived_at IS NULL AND EXISTS(SELECT 1 FROM public.overtime_pattern_version_company c
     WHERE c.version_id=v.id AND c.tenant_id=NEW.tenant_id AND c.company_id=NEW.company_id);
  IF NOT FOUND THEN RAISE EXCEPTION 'Choose a central pattern available for this company' USING ERRCODE='23514';END IF;
  SELECT s.state INTO state FROM public.overtime_pattern_version_state s
   WHERE s.version_id=version.id AND s.tenant_id=NEW.tenant_id AND s.effective_from<=NEW.effective_from
   ORDER BY s.effective_from DESC,s.sequence DESC LIMIT 1;
  IF state IS DISTINCT FROM 'active' THEN RAISE EXCEPTION 'Central pattern is inactive on the policy start date' USING ERRCODE='23514';END IF;
 END LOOP;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.guard_attendance_group_policy_revision() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER attendance_group_policy_revision_guard BEFORE INSERT OR UPDATE OR DELETE
 ON public.attendance_group_policy_revision FOR EACH ROW EXECUTE FUNCTION app.guard_attendance_group_policy_revision();

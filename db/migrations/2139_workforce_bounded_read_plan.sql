-- Preserve the private Workforce projection and both public wrappers; split only its employment access plan.
DO $bounded_predecessor$
DECLARE p pg_catalog.pg_proc%ROWTYPE;
BEGIN
 SELECT * INTO p FROM pg_catalog.pg_proc WHERE oid=to_regprocedure('app._access_workforce_list_rows(uuid[])');
 IF NOT FOUND OR md5(p.prosrc) IS DISTINCT FROM '6eb8420b5274d67f7d53207771bb1c3e'
  OR p.prosecdef IS DISTINCT FROM true OR p.proisstrict OR p.proleakproof
  OR p.provolatile<>'s' OR p.proparallel<>'u' OR p.prokind<>'f'
  OR p.proretset IS DISTINCT FROM true OR p.prorettype IS DISTINCT FROM ('jsonb'::regtype)::oid
  OR p.pronargs<>1 OR p.proargtypes[0] IS DISTINCT FROM ('uuid[]'::regtype)::oid
  OR p.proargnames IS DISTINCT FROM ARRAY['subject_ids']::text[]
  OR p.proallargtypes IS NOT NULL OR p.proargmodes IS NOT NULL OR p.pronargdefaults<>0 OR p.proargdefaults IS NOT NULL
  OR p.procost<>100 OR p.prorows<>1000
  OR p.prolang IS DISTINCT FROM (SELECT oid FROM pg_catalog.pg_language WHERE lanname='sql')
  OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']::text[] THEN
  RAISE EXCEPTION 'Unexpected private Workforce projection; review before changing its plan' USING ERRCODE='55000';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
    WHERE a.grantee<>p.proowner OR a.privilege_type<>'EXECUTE')
  OR NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
    WHERE a.grantee=p.proowner AND a.privilege_type='EXECUTE') THEN
  RAISE EXCEPTION 'Unexpected private Workforce privileges; review before changing its plan' USING ERRCODE='55000';
 END IF;
END;
$bounded_predecessor$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app._access_workforce_list_rows(subject_ids uuid[]) RETURNS SETOF jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
WITH permitted AS MATERIALIZED (
  SELECT c.id FROM public.company c WHERE c.tenant_id=app.current_tenant_id() AND app.access_workforce_projection_company(c.id)
 )
 SELECT jsonb_build_object(
  'employmentId',e.id,'name',p.full_name,'email',p.primary_email,'employeeCode',e.employee_code,
  'department',COALESCE(NULLIF(btrim(d.label),''),d.name),'departmentId',a.department_id,
  'position',COALESCE(NULLIF(btrim(pos.label),''),pos.title),'company',co.legal_name,'companyId',e.company_id,
  'hiredOn',e.hired_on,'terminatedOn',e.terminated_on,'confirmationDate',e.confirmation_date,
  'finalConfirmationDate',e.final_confirmation_date,'probationEndDate',e.probation_end_date,
  'provisionalEndOn',e.provisional_end_on,'resignationDate',e.resignation_date,'lastWorkingDate',e.last_working_date,
  'blacklistedAt',e.blacklisted_at,'jobGrade',g.name,'employmentType',a.employment_type,
  'businessUnit',COALESCE(NULLIF(btrim(bu.label),''),bu.code),'costCenter',cc.name,'workLocation',loc.name,
  'joinDate',e.join_date,'reportingTo',(
   SELECT mp.full_name FROM public.reporting_line rl
   JOIN public.employment me ON me.id=rl.manager_employment_id AND me.tenant_id=rl.tenant_id AND me.voided_at IS NULL
   JOIN permitted manager_scope ON manager_scope.id=me.company_id
   JOIN public.person mp ON mp.id=me.person_id AND mp.tenant_id=me.tenant_id
   WHERE rl.tenant_id=e.tenant_id AND rl.subordinate_employment_id=e.id AND rl.line_type='administrative'
    AND rl.valid_to IS NULL AND rl.superseded_at IS NULL ORDER BY rl.valid_from DESC,rl.id LIMIT 1))
 FROM (
    SELECT * FROM public.employment WHERE subject_ids IS NULL
    UNION ALL
    SELECT * FROM public.employment WHERE subject_ids IS NOT NULL AND id=ANY(subject_ids)
   )e JOIN permitted allowed ON allowed.id=e.company_id
 JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
 JOIN public.company co ON co.id=e.company_id AND co.tenant_id=e.tenant_id
 LEFT JOIN public.assignment a ON a.employment_id=e.id AND a.tenant_id=e.tenant_id AND a.valid_to IS NULL AND a.superseded_at IS NULL
 LEFT JOIN public.department d ON d.id=a.department_id AND d.tenant_id=e.tenant_id
 LEFT JOIN public.position pos ON pos.id=a.position_id AND pos.tenant_id=e.tenant_id
 LEFT JOIN public.job_grade g ON g.id=e.grade_id AND g.tenant_id=e.tenant_id
 LEFT JOIN public.business_unit bu ON bu.id=a.business_unit_id AND bu.tenant_id=e.tenant_id
 LEFT JOIN public.cost_center cc ON cc.id=a.cost_center_id AND cc.tenant_id=e.tenant_id
 LEFT JOIN public.location loc ON loc.id=a.location_id AND loc.tenant_id=e.tenant_id
 WHERE e.tenant_id=app.current_tenant_id() AND e.voided_at IS NULL AND (subject_ids IS NULL OR e.id=ANY(subject_ids));
$$;

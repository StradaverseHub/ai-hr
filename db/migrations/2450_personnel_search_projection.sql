-- Search only needs native names, email, employee codes and permitted identity fields.
CREATE OR REPLACE FUNCTION app.personnel_search_rows(p_scope uuid[]) RETURNS SETOF jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 WITH permitted_companies AS MATERIALIZED (
   SELECT c.id
   FROM public.company c
   WHERE c.tenant_id=app.current_tenant_id()
     AND c.id=ANY(p_scope)
     AND app.access_workforce_projection_company(c.id)
 ),
 -- Fence the scoped candidates before the dated resolver, which can raise for hidden rows.
 candidates AS MATERIALIZED (
   SELECT e.id,e.person_id,e.tenant_id,e.company_id,e.employee_code,e.xmin::text employment_revision,
          p.full_name,p.primary_email,p.xmin::text person_revision
   FROM public.employment e
   JOIN permitted_companies allowed ON allowed.id=e.company_id
   JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
   WHERE e.tenant_id=app.current_tenant_id() AND e.voided_at IS NULL
 ),
 tagged AS MATERIALIZED (
   SELECT c.*,COALESCE((app.employment_organisation_tags(c.id,(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)->>'companyId')::uuid,c.company_id) dated_company_id
   FROM candidates c
 ),
 admitted AS MATERIALIZED (
   SELECT t.* FROM tagged t JOIN permitted_companies allowed ON allowed.id=t.dated_company_id
 ),
 identity_companies AS MATERIALIZED (
   SELECT d.dated_company_id
   FROM (SELECT DISTINCT dated_company_id FROM admitted) d
   WHERE app.personnel_identity_search_permitted(d.dated_company_id)
 )
 SELECT jsonb_build_object('employmentId',a.id,'companyId',a.dated_company_id,
   'name',a.full_name,'email',a.primary_email,'employeeCode',a.employee_code,
   'personRevision',a.person_revision,'employmentRevision',a.employment_revision,
   'identityRevision',s.xmin::text,'icNumber',s.ic_number,'passportNumber',s.passport_number)
 FROM admitted a
 LEFT JOIN identity_companies allowed ON allowed.dated_company_id=a.dated_company_id
 LEFT JOIN public.employee_statutory_my s ON s.person_id=a.person_id AND s.tenant_id=a.tenant_id
   AND allowed.dated_company_id IS NOT NULL
$$;

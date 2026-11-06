-- Resolve hierarchy once per selected company. Check each referenced label once,
-- including visible parents and groups outside the selected company scope.
CREATE OR REPLACE FUNCTION app.personnel_filter_companies(p_scope uuid[],p_as_of date)
RETURNS TABLE(id uuid,name text,"parentCompanyId" uuid,"parentCompany" text,"businessGroupId" uuid,"businessGroup" text,"businessUnitId" uuid,"businessUnit" text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 WITH admitted AS MATERIALIZED (
   SELECT c.id,c.tenant_id,c.legal_name
   FROM public.company c
   WHERE c.tenant_id=app.current_tenant_id() AND c.id=ANY(p_scope)
     AND app.access_workforce_projection_company(c.id)
 ),
 tagged AS MATERIALIZED (
   SELECT c.*, app.company_organisation_tags(c.id,p_as_of) AS tags
   FROM admitted c
 ),
 related_ids AS MATERIALIZED (
   SELECT (tags->>'parentCompanyId')::uuid AS id FROM tagged
   UNION
   SELECT (tags->>'businessGroupId')::uuid AS id FROM tagged
 ),
 visible_labels AS MATERIALIZED (
   SELECT id,legal_name FROM admitted
   UNION ALL
   SELECT c.id,c.legal_name
   FROM related_ids r JOIN public.company c ON c.id=r.id
   WHERE c.tenant_id=app.current_tenant_id()
     AND NOT EXISTS (SELECT 1 FROM admitted a WHERE a.id=c.id)
     AND app.access_workforce_projection_company(c.id)
 )
 SELECT c.id,c.legal_name,pc.id,pc.legal_name,bg.id,bg.legal_name,bu.id,bu.name
 FROM tagged c
 LEFT JOIN visible_labels pc ON pc.id=(c.tags->>'parentCompanyId')::uuid
 LEFT JOIN visible_labels bg ON bg.id=(c.tags->>'businessGroupId')::uuid
 LEFT JOIN public.business_unit bu ON bu.id=(c.tags->>'businessUnitId')::uuid AND bu.tenant_id=c.tenant_id
 ORDER BY c.legal_name,c.id
$$;

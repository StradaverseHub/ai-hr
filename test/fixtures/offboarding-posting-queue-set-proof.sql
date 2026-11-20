-- Hosted test proof only. The canonical production queue and command owners are unchanged.
CREATE FUNCTION app.offboarding_posting_queue_access_set_proof() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH RECURSIVE actor AS MATERIALIZED (
  SELECT u.id,u.tenant_id,u.person_id
  FROM public.app_user u
  WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id()
    AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) AND app.principal_snapshot_current()
 ), configuration AS MATERIALIZED (
  SELECT a.*,v.data IS NOT NULL AS has_v9,v.data->>'peopleOpsGroup' AS ops_group,
    CASE WHEN v.data->'offboarding' ? 'postingApproverGroupId'
      THEN v.data->'offboarding'->>'postingApproverGroupId' ELSE v.data->>'peopleOpsGroup' END AS queue_group,
    coalesce(o.data->'access'->'offboarding' ? a.id::text,false) AS offboarding_enabled,
    coalesce(o.data->'groups',v.data->'groups','[]'::jsonb) AS groups
  FROM actor a LEFT JOIN public.lc_onboarding_config o ON o.tenant_id=a.tenant_id
  LEFT JOIN public.lc_v9_config v ON v.tenant_id=a.tenant_id
 ), member_groups AS MATERIALIZED (
  SELECT DISTINCT group_entry->>'id' AS id
  FROM configuration c CROSS JOIN LATERAL jsonb_array_elements(c.groups) group_entry
  WHERE group_entry->'members' ? c.id::text
 ), session_grants AS MATERIALIZED (
  SELECT role,company_id FROM app.current_grants()
  WHERE role IN ('hr_admin','super_admin')
 ), published_parents AS MATERIALIZED (
  SELECT DISTINCT ON (m.company_id) m.company_id,m.parent_company_id
  FROM public.company_organisation_mapping m
  JOIN public.company_organisation_run r ON r.tenant_id=m.tenant_id AND r.id=m.run_id
  JOIN actor a ON a.tenant_id=m.tenant_id
  WHERE r.state='published' AND r.effective_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
   AND EXISTS(SELECT 1 FROM member_groups) AND EXISTS(SELECT 1 FROM session_grants)
  ORDER BY m.company_id,r.effective_on DESC,r.published_at DESC,r.id DESC
 ), parents AS MATERIALIZED (
  SELECT c.id,CASE WHEN p.company_id IS NOT NULL THEN p.parent_company_id ELSE c.parent_company_id END AS parent_id
  FROM public.company c JOIN actor a ON a.tenant_id=c.tenant_id
  LEFT JOIN published_parents p ON p.company_id=c.id
  WHERE EXISTS(SELECT 1 FROM member_groups) AND EXISTS(SELECT 1 FROM session_grants)
 ), lineage(company_id,ancestor_id,path) AS (
  SELECT id,id,ARRAY[id] FROM parents
  UNION ALL
  SELECT l.company_id,parent.id,l.path||parent.id
  FROM lineage l JOIN parents child ON child.id=l.ancestor_id
  JOIN parents parent ON parent.id=child.parent_id
  WHERE NOT(parent.id=ANY(l.path))
 ), company_grants AS MATERIALIZED (
  SELECT DISTINCT p.id AS company_id,g.role
  FROM parents p JOIN session_grants g ON g.company_id IS NULL
   OR EXISTS(SELECT 1 FROM lineage l WHERE l.company_id=p.id AND l.ancestor_id=g.company_id)
 ), workforce_roles AS MATERIALIZED (
  SELECT DISTINCT g.company_id
  FROM actor a JOIN public.role_assignment r ON r.tenant_id=a.tenant_id AND r.app_user_id=a.id
  JOIN company_grants g ON g.role=r.role::text
  WHERE r.company_id IS NULL
   OR EXISTS(SELECT 1 FROM lineage l WHERE l.company_id=g.company_id AND l.ancestor_id=r.company_id)
 ), allowed_workforce_companies AS MATERIALIZED (
  SELECT w.company_id
  FROM workforce_roles w CROSS JOIN actor a CROSS JOIN LATERAL app.access_capability_effective(a.tenant_id) capability
  WHERE capability.id='workforce.maintain' AND (
   NOT capability.supported OR (
    capability.scope='company' AND jsonb_array_length(capability.bindings)>0
    AND EXISTS(SELECT 1 FROM public.access_configuration s WHERE s.tenant_id=a.tenant_id AND s.initialized)
    AND NOT EXISTS(
     SELECT 1 FROM public.access_user_override o
     WHERE o.tenant_id=a.tenant_id AND o.user_id=a.id AND o.capability_id=capability.id
      AND o.effect='deny' AND o.retired_at IS NULL
      AND (o.company_id IS NULL OR EXISTS(SELECT 1 FROM lineage l WHERE l.company_id=w.company_id AND l.ancestor_id=o.company_id))
    )
    AND (EXISTS(
     SELECT 1 FROM public.access_user_override o
     WHERE o.tenant_id=a.tenant_id AND o.user_id=a.id AND o.capability_id=capability.id
      AND o.effect='allow' AND o.retired_at IS NULL
      AND (o.company_id IS NULL OR EXISTS(SELECT 1 FROM lineage l WHERE l.company_id=w.company_id AND l.ancestor_id=o.company_id))
    ) OR EXISTS(
     SELECT 1 FROM public.access_effective_membership m
     JOIN public.access_group g ON g.tenant_id=m.tenant_id AND g.id=m.group_id AND g.retired_at IS NULL
     JOIN public.access_group_grant r ON r.tenant_id=g.tenant_id AND r.group_id=g.id
     WHERE m.tenant_id=a.tenant_id AND m.user_id=a.id AND r.capability_id=capability.id AND r.retired_at IS NULL
      AND (m.company_id IS NULL OR EXISTS(SELECT 1 FROM lineage l WHERE l.company_id=w.company_id AND l.ancestor_id=m.company_id))
      AND (r.company_id IS NULL OR EXISTS(SELECT 1 FROM lineage l WHERE l.company_id=w.company_id AND l.ancestor_id=r.company_id))
    ))
   )
  )
 ), ops_companies AS MATERIALIZED (
  SELECT DISTINCT g.company_id
  FROM company_grants g CROSS JOIN configuration c JOIN member_groups m ON m.id=c.ops_group
  WHERE c.offboarding_enabled
 )
 SELECT EXISTS(
  SELECT 1 FROM configuration c
  WHERE c.has_v9 AND (
   EXISTS(SELECT 1 FROM ops_companies)
   OR EXISTS(SELECT 1 FROM allowed_workforce_companies CROSS JOIN member_groups WHERE member_groups.id=c.queue_group)
  )
 ) OR EXISTS(
  SELECT 1 FROM actor a JOIN public.personnel_posting p ON p.tenant_id=a.tenant_id AND p.source='offboarding'
  JOIN public.employment e ON e.tenant_id=p.tenant_id AND e.id=p.employment_id
  JOIN allowed_workforce_companies w ON w.company_id=e.company_id
  JOIN member_groups m ON m.id=p.approver_group_id
  WHERE NOT coalesce(a.person_id=e.person_id,false)
 );
$$;
REVOKE ALL ON FUNCTION app.offboarding_posting_queue_access_set_proof() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.offboarding_posting_queue_access_set_proof() TO ai_hr_app;

-- Reuse the live principal query PLAN per database connection, never its rows or grants.
-- Keep the complete0016 query, SECURITY DEFINER, STABLE and public search path.
-- CREATE OR REPLACE preserves the existing owner and execute ACL.
CREATE OR REPLACE FUNCTION app.principal(p_user_id uuid)
  RETURNS TABLE (tenant_id uuid, person_id uuid, grants jsonb)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $principal_plan$
BEGIN
 RETURN QUERY
SELECT u.tenant_id, u.person_id,
         COALESCE(
           jsonb_agg(jsonb_build_object('role', ra.role, 'companyId', ra.company_id))
             FILTER (WHERE ra.role IS NOT NULL),
           '[]'::jsonb
         )
  FROM app_user u
  LEFT JOIN role_assignment ra ON ra.app_user_id = u.id
  WHERE u.id = p_user_id
  GROUP BY u.tenant_id, u.person_id;
END;
$principal_plan$;

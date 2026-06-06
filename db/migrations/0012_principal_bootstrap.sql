-- Principal bootstrap (ADR-0004 auth seam).
-- Resolving "who is this session" must happen BEFORE any tenant/RLS context is set, so it
-- can't go through RLS. These SECURITY DEFINER functions are that seam: given a verified
-- app_user id, return its tenant, person, and granted roles. In production WorkOS verifies
-- the user and we look them up by workos_user_id; the shape is identical.

CREATE OR REPLACE FUNCTION app.principal(p_user_id uuid)
  RETURNS TABLE (tenant_id uuid, person_id uuid, roles text[])
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT u.tenant_id,
         u.person_id,
         COALESCE(array_remove(array_agg(ra.role::text), NULL), '{}')
  FROM app_user u
  LEFT JOIN role_assignment ra ON ra.app_user_id = u.id
  WHERE u.id = p_user_id
  GROUP BY u.tenant_id, u.person_id;
$$;
--> statement-breakpoint
-- Dev-only: list selectable identities for the dev identity switcher. Returns every app_user
-- with its person name and roles, so you can "act as" anyone regardless of the current role.
CREATE OR REPLACE FUNCTION app.dev_principals()
  RETURNS TABLE (user_id uuid, name text, roles text[])
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT u.id,
         COALESCE(p.full_name, 'Admin'),
         COALESCE(array_remove(array_agg(ra.role::text), NULL), '{}')
  FROM app_user u
  LEFT JOIN person p ON p.id = u.person_id
  LEFT JOIN role_assignment ra ON ra.app_user_id = u.id
  GROUP BY u.id, p.full_name;
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.principal(uuid) TO ai_hr_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.dev_principals() TO ai_hr_app;

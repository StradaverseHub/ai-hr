-- Reuse the SQL expression plan, never a decision, caller or input value.
CREATE OR REPLACE FUNCTION app.login_blocked_on(p_user_id uuid,p_as_of date) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 RETURN (
SELECT CASE WHEN p_as_of IS NULL THEN true ELSE EXISTS(
  SELECT 1 FROM public.app_user u WHERE u.id=p_user_id AND (
   u.archived_at IS NOT NULL OR (
    u.person_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.employment e WHERE e.person_id=u.person_id)
    AND NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.person_id=u.person_id AND e.blacklisted_at IS NULL
     AND (LEAST(e.resignation_date,e.last_working_date,e.terminated_on) IS NULL
      OR p_as_of<=LEAST(e.resignation_date,e.last_working_date,e.terminated_on)))
   )
  )
 ) END
 );
END;
$$;

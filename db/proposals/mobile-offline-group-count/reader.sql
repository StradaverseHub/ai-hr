-- UNALLOCATED proposal: append to the migration journal only after fresh installation watermarks and peer claims.
-- Prerequisite: the DBA creates the inert purpose role and temporarily grants owner membership/schema CREATE.
-- Run as ai_hr_owner. The original actor-private table policies remain unchanged.
GRANT USAGE ON SCHEMA public,app TO ai_hr_mobile_offline_counter;
GRANT SELECT (tenant_id,company_id,closed_at,expires_at) ON public.mobile_offline_context TO ai_hr_mobile_offline_counter;
GRANT SELECT (id,tenant_id) ON public.company TO ai_hr_mobile_offline_counter;
CREATE POLICY mobile_offline_context_counter_read ON public.mobile_offline_context FOR SELECT TO ai_hr_mobile_offline_counter
 USING (tenant_id=app.current_tenant_id());
CREATE POLICY mobile_offline_counter_company_read ON public.company FOR SELECT TO ai_hr_mobile_offline_counter
 USING (tenant_id=app.current_tenant_id());
CREATE FUNCTION app.mobile_offline_open_context_counts(wanted_companies uuid[])
RETURNS TABLE(company_id uuid,open_count integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $function$
 WITH requested AS MATERIALIZED (SELECT DISTINCT id FROM unnest(wanted_companies) requested(id)),
 permitted AS MATERIALIZED (
  SELECT r.id FROM requested r JOIN public.company co ON co.id=r.id AND co.tenant_id=app.current_tenant_id()
  WHERE coalesce(app.can_admin_payroll_for(r.id),false)
 ), counts AS MATERIALIZED (
  SELECT c.company_id,count(*)::integer AS n FROM public.mobile_offline_context c
  JOIN permitted p ON p.id=c.company_id
  WHERE c.tenant_id=app.current_tenant_id() AND c.closed_at IS NULL AND c.expires_at>clock_timestamp()
  GROUP BY c.company_id
 )
 SELECT r.id,CASE WHEN p.id IS NOT NULL THEN coalesce(c.n,0) END
 FROM requested r LEFT JOIN permitted p ON p.id=r.id LEFT JOIN counts c ON c.company_id=r.id;
$function$;
ALTER FUNCTION app.mobile_offline_open_context_counts(uuid[]) OWNER TO ai_hr_mobile_offline_counter;
REVOKE ALL ON FUNCTION app.mobile_offline_open_context_counts(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.mobile_offline_open_context_counts(uuid[]) TO ai_hr_app,ai_hr_owner;

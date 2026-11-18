-- Same exact shared-groups authority as the existing bounded people picker; no Workforce or case grant is fabricated.
CREATE FUNCTION app.automation_routing_check_names(p_users uuid[]) RETURNS TABLE(id uuid,name text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT u.id,p.full_name FROM app.automation_active_users(p_users) permitted(id)
 JOIN public.app_user u ON u.id=permitted.id AND u.tenant_id=app.current_tenant_id()
 JOIN public.person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id
 WHERE app.automation_can_manage('contract_staff','groups') AND cardinality(p_users) BETWEEN 1 AND 50
 ORDER BY u.id LIMIT 50
$$;
REVOKE ALL ON FUNCTION app.automation_routing_check_names(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.automation_routing_check_names(uuid[]) TO ai_hr_app;

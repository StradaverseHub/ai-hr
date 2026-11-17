-- Approved 4a60b3ec: a case-authorized, bounded account directory. Credentials remain sealed in SQL;
-- only the authentication owner decrypts them, and only addresses leave the server-side adapter.
CREATE FUNCTION app.lifecycle_recipient_case_allowed(p_case uuid,p_edit boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.current_user_id() IS NOT NULL
 AND EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id))
 AND (EXISTS(SELECT 1 FROM public.lc_onboarding_case c WHERE c.id=p_case AND c.tenant_id=app.current_tenant_id()
   AND app.is_admin_for(c.company_id) AND app.onboarding_v9_case_actor() AND app.onboarding_v9_sections()->>'hr'='view')
 OR NOT p_edit AND EXISTS(SELECT 1 FROM public.lc_v9_case c WHERE c.id=p_case AND c.tenant_id=app.current_tenant_id()
   AND c.module='off' AND app.lc_v9_off_access(c.company_id)))
$$;
REVOKE ALL ON FUNCTION app.lifecycle_recipient_case_allowed(uuid,boolean) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.lifecycle_recipient_accounts(p_case uuid,p_issuer text,p_ids uuid[],p_query text DEFAULT NULL)
RETURNS TABLE(user_id uuid,tenant_id uuid,name text,department text,subject text,issuer text,sealed text,policy_sealed text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE is_search boolean := p_query IS NOT NULL;
BEGIN
 IF NOT app.lifecycle_recipient_case_allowed(p_case,is_search) THEN RAISE EXCEPTION 'Full lifecycle case access is required' USING ERRCODE='insufficient_privilege'; END IF;
 IF p_issuer IS NULL OR length(p_issuer)>500 OR p_ids IS NULL AND NOT is_search OR cardinality(p_ids)>1024 THEN
  RAISE EXCEPTION 'Invalid recipient directory request' USING ERRCODE='invalid_parameter_value';
 END IF;
 IF is_search AND (length(btrim(p_query))<2 OR length(p_query)>100) THEN RETURN; END IF;
 RETURN QUERY
 WITH wanted AS MATERIALIZED (
  SELECT u.id,u.person_id,coalesce(p.full_name,'User') AS name
  FROM public.app_user u LEFT JOIN public.person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id
  WHERE u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL
   AND CASE WHEN is_search THEN strpos(lower(coalesce(p.full_name,'User')),lower(btrim(p_query)))>0 ELSE u.id=ANY(p_ids) END
 ), employment_state AS (
  -- Set-wise equivalent of app.login_blocked_on: accounts with no employment remain available;
  -- otherwise at least one non-blacklisted, not-ended employment must remain. The actor check above
  -- calls the canonical scalar owner once; this batched recipient path never calls it per person.
  SELECT e.person_id,bool_or(e.blacklisted_at IS NULL AND (LEAST(e.resignation_date,e.last_working_date,e.terminated_on) IS NULL
    OR current_date<=LEAST(e.resignation_date,e.last_working_date,e.terminated_on))) AS available
  FROM public.employment e JOIN wanted w ON w.person_id=e.person_id WHERE e.tenant_id=app.current_tenant_id() GROUP BY e.person_id
 ), active AS MATERIALIZED (
  SELECT w.* FROM wanted w LEFT JOIN employment_state e ON e.person_id=w.person_id WHERE coalesce(e.available,true)
 ), bound AS MATERIALIZED (
  SELECT w.id,w.person_id,w.name,i.subject,i.issuer,r.sealed,count(*) OVER(PARTITION BY w.id) AS bindings
  FROM active w JOIN public.app_external_identity i ON i.app_user_id=w.id AND i.issuer=p_issuer AND i.revoked_at IS NULL
  LEFT JOIN public.app_internal_auth_record r ON r.record_key='credential:'||i.subject AND r.owner_id::text=i.subject AND (r.expires_at IS NULL OR r.expires_at>now())
 ), selected AS MATERIALIZED (
  SELECT b.* FROM bound b WHERE b.bindings=1 AND b.sealed IS NOT NULL ORDER BY lower(b.name),b.id LIMIT CASE WHEN is_search THEN 20 ELSE 1024 END
 ), departments AS (
  SELECT s.id,string_agg(DISTINCT d.name,', ' ORDER BY d.name) AS label
  FROM selected s JOIN public.employment e ON e.person_id=s.person_id AND e.tenant_id=app.current_tenant_id()
   AND e.hired_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (e.terminated_on IS NULL OR e.terminated_on>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
  JOIN public.assignment a ON a.employment_id=e.id AND a.tenant_id=e.tenant_id
   AND a.superseded_at IS NULL AND a.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (a.valid_to IS NULL OR a.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
  JOIN public.department d ON d.id=a.department_id AND d.tenant_id=a.tenant_id GROUP BY s.id
 )
 SELECT s.id,app.current_tenant_id(),s.name,coalesce(d.label,''),s.subject,s.issuer,s.sealed,pol.sealed
 FROM selected s LEFT JOIN departments d ON d.id=s.id LEFT JOIN public.app_internal_auth_record pol
  ON pol.record_key='password-policy:'||app.current_tenant_id()::text AND (pol.expires_at IS NULL OR pol.expires_at>now())
 ORDER BY lower(s.name),s.id;
END;
$$;
REVOKE ALL ON FUNCTION app.lifecycle_recipient_accounts(uuid,text,uuid[],text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lifecycle_recipient_accounts(uuid,text,uuid[],text) TO ai_hr_app;

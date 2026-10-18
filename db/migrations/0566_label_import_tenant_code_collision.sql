-- 0566: importing adds only new category codes, even outside the caller's visible companies.
-- This read-only oracle reveals only existence for caller-supplied keys; manual Criteria rules stay intact.
-- Reserved idx566/when1791900000046; the integrator appends the journal after 0565.
CREATE FUNCTION app.existing_system_label_import_keys(p_tenant uuid,p_rows jsonb)
RETURNS TABLE(key text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF p_tenant IS NULL OR p_tenant IS DISTINCT FROM app.current_tenant_id() OR app.is_admin() IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'Only an administrator may check import codes' USING ERRCODE='42501';
 END IF;
 IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR jsonb_array_length(p_rows)>7000
  OR octet_length(p_rows::text)>8000000 THEN
  RAISE EXCEPTION 'Invalid import code request' USING ERRCODE='22023';
 END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_rows) r
   WHERE jsonb_typeof(r) IS DISTINCT FROM 'object'
    OR jsonb_typeof(r->'key') IS DISTINCT FROM 'string' OR length(r->>'key') NOT BETWEEN 1 AND 200
    OR jsonb_typeof(r->'kind') IS DISTINCT FROM 'string' OR r->>'kind' NOT IN ('department','position','cost_center','business_unit')
    OR jsonb_typeof(r->'code') IS DISTINCT FROM 'string' OR length(r->>'code') NOT BETWEEN 1 AND 1000 OR length(trim(r->>'code'))=0)
  OR (SELECT count(*) FROM jsonb_array_elements(p_rows))<>(SELECT count(DISTINCT r->>'key') FROM jsonb_array_elements(p_rows) r) THEN
  RAISE EXCEPTION 'Invalid import code request' USING ERRCODE='22023';
 END IF;
 RETURN QUERY
 SELECT p.key FROM jsonb_to_recordset(p_rows) AS p(key text,kind text,code text)
 WHERE CASE p.kind
  WHEN 'department' THEN EXISTS(SELECT 1 FROM public.department d WHERE d.tenant_id=p_tenant AND lower(trim(d.name))=lower(trim(p.code)))
  WHEN 'position' THEN EXISTS(SELECT 1 FROM public.position d WHERE d.tenant_id=p_tenant AND lower(trim(d.title))=lower(trim(p.code)))
  WHEN 'cost_center' THEN EXISTS(SELECT 1 FROM public.cost_center d WHERE d.tenant_id=p_tenant AND lower(trim(d.code))=lower(trim(p.code)))
  WHEN 'business_unit' THEN EXISTS(SELECT 1 FROM public.business_unit d WHERE d.tenant_id=p_tenant AND lower(trim(d.code))=lower(trim(p.code)))
  ELSE false END
 ORDER BY p.key;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.existing_system_label_import_keys(uuid,jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.existing_system_label_import_keys(uuid,jsonb) TO ai_hr_app;

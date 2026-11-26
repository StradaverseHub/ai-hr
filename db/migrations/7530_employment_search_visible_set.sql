-- ADR 0181 decision 5 (Phase 4) follow-up, 26 November 2026: employee search no slower than before 7320.
--
-- 7320's app.employment_search_candidates narrowed its trigram matches to the caller's visible set by materialising
-- app.visible_employment_ids() and app.employment_read_companies() on every call. For an administrator the first is
-- every employment of their companies (sorted and aggregated) plus the relationship statements, and the caller's own
-- employment_rls computes visible_employment_ids() again in the same statement. The People directory runs two
-- statements per search (rows and count), so a search paid for the whole visible set four times: with identical
-- answers, a median search became slower than before 7320, and the owner held the production release for this
-- (26 November 2026).
--
-- This replaces only the function body, guarded by the 7320 body it replaces. The answer set is unchanged:
--   7320: matches AND (id IN visible_employment_ids() OR company_id IN employment_read_companies()), where
--         visible_employment_ids() = employments of the companies app.is_admin_for admits (7240's admin arm)
--                                    UNION app.access_visible_employment_ids() (the relationship part, 7240);
--   7530: matches AND (company_id IN employment_read_companies() OR id IN access_visible_employment_ids()).
-- The admin arm's companies are a subset of employment_read_companies() (both ask app.is_admin_for per company of the
-- tenant), so the two are equal. 7530 asks the cheap company question first, inside the search statement, and asks
-- for the relationship part only when some match lies outside those companies: an administrator whose companies hold
-- every match never builds a visible set inside the function, and anyone else builds only the relationship part
-- (which 7320 also built, inside visible_employment_ids). Signature, volatility, owner, search_path, grants, the
-- NULL answer for unnarrowed terms and the sorted result are unchanged. The single statement between the $search$
-- markers is the one test/employment-search-trigram explains, now with the read companies as $4.
DO $guard$
BEGIN
 IF md5((SELECT p.prosrc FROM pg_catalog.pg_proc p WHERE p.oid='app.employment_search_candidates(text,uuid[],boolean)'::regprocedure)) IS DISTINCT FROM '4181f6a8d4facb0b3ff2c724a78e208f' THEN
  RAISE EXCEPTION 'Unexpected employment_search_candidates predecessor (7320)' USING ERRCODE='55000';
 END IF;
END;
$guard$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.employment_search_candidates(p_query text, p_companies uuid[], p_email boolean)
 RETURNS uuid[]
 LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
 v_search constant text := $search$
  WITH matched AS (
   SELECT e.id FROM public.person p JOIN public.employment e ON e.person_id = p.id AND e.tenant_id = p.tenant_id
    WHERE p.tenant_id = app.current_tenant_id() AND lower(p.full_name COLLATE "C") LIKE $1
   UNION
   SELECT e.id FROM public.employment e
    WHERE e.tenant_id = app.current_tenant_id() AND lower(coalesce(e.employee_code, '') COLLATE "C") LIKE $1
   UNION
   SELECT e.id FROM public.person p JOIN public.employment e ON e.person_id = p.id AND e.tenant_id = p.tenant_id
    WHERE $3 AND p.tenant_id = app.current_tenant_id() AND lower(coalesce(p.primary_email, '') COLLATE "C") LIKE $1
   UNION
   SELECT e.id FROM public.person p JOIN public.employment e ON e.person_id = p.id AND e.tenant_id = p.tenant_id
    WHERE p.tenant_id = app.current_tenant_id() AND (p.full_name COLLATE "C") ~ '[^ -~]'
   UNION
   SELECT e.id FROM public.employment e
    WHERE e.tenant_id = app.current_tenant_id() AND (coalesce(e.employee_code, '') COLLATE "C") ~ '[^ -~]'
   UNION
   SELECT e.id FROM public.person p JOIN public.employment e ON e.person_id = p.id AND e.tenant_id = p.tenant_id
    WHERE $3 AND p.tenant_id = app.current_tenant_id() AND (coalesce(p.primary_email, '') COLLATE "C") ~ '[^ -~]'
  )
  SELECT coalesce(array_agg(e.id ORDER BY e.id) FILTER (WHERE e.company_id = ANY ($4)), '{}'::uuid[]),
   coalesce(array_agg(e.id ORDER BY e.id) FILTER (WHERE NOT (e.company_id = ANY ($4))), '{}'::uuid[])
  FROM matched m JOIN public.employment e ON e.id = m.id
  WHERE e.tenant_id = app.current_tenant_id() AND e.voided_at IS NULL
   AND ($2 IS NULL OR e.company_id = ANY ($2))
 $search$;
 v_inside uuid[];
 v_outside uuid[];
 v_relationship uuid[];
 v_pattern text;
BEGIN
 IF p_query IS NULL OR p_query !~ '^[ -~]{3,200}$' OR app.current_tenant_id() IS NULL THEN
  RETURN NULL;
 END IF;
 -- The callers' own pattern: lower case, with \, % and _ matched literally (LIKE's default escape is \).
 v_pattern := '%' || replace(replace(replace(lower(p_query COLLATE "C"), '\', '\\'), '%', '\%'), '_', '\_') || '%';
 EXECUTE v_search INTO v_inside, v_outside USING v_pattern, p_companies, coalesce(p_email, false), app.employment_read_companies();
 IF cardinality(v_outside) = 0 THEN
  RETURN v_inside;
 END IF;
 -- Only matches outside the caller's administrator and partner companies need the relationship part of visibility.
 v_relationship := app.access_visible_employment_ids();
 RETURN (SELECT coalesce(array_agg(x ORDER BY x), '{}'::uuid[])
  FROM (SELECT unnest(v_inside) AS x UNION ALL SELECT o FROM unnest(v_outside) o WHERE o IN (SELECT unnest(v_relationship))) t);
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.employment_search_candidates(text, uuid[], boolean) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.employment_search_candidates(text, uuid[], boolean) TO ai_hr_app;

-- ADR 0181 decision 5 (Phase 4) follow-up, 26 November 2026: employee search no slower than before 7320.
--
-- 7320's app.employment_search_candidates narrowed every 3+ character search: it searched the tenant by trigram and
-- materialised app.visible_employment_ids() (for an administrator every employment of their companies, sorted and
-- aggregated, plus the relationship statements) and app.employment_read_companies() (three authority questions for
-- every company of the tenant) on every call, while the caller's employment_rls computed visible_employment_ids()
-- again. Narrowing only pays where the caller's own read is costly: row security asks the partner questions and the
-- relationship set for every row outside the companies the caller administers or partners, so a company-scoped
-- administrator reading the whole group is slow, while a group administrator, or anyone reading a small scope, reads
-- quickly without candidates. With identical answers, searches that were already fast became slower, and the owner
-- held the production release for this (26 November 2026).
--
-- This replaces only the function body, guarded by the 7320 body it replaces:
--   * The caller's administrator and partner companies are asked only among the companies in scope (p_companies, or
--     the tenant's when NULL): app.is_admin_for, app.can_admin_payroll_for, app.can_admin_perfcomp_for, the predicate
--     of app.employment_read_companies (7240).
--   * When at most 1,000 employments in scope lie outside those companies, the function answers NULL: do not narrow,
--     and core/employment-search.ts reads exactly as before 7320. The application does not ask at all for a
--     group-wide administrator, whose row security admits every row through the company question.
--   * Otherwise it searches as 7320 did and keeps matches in those companies, and asks the relationship part of
--     visibility (app.access_visible_employment_ids, 7240) only for matches outside them. The answer set equals 7320's:
--     matches AND (company_id IN those companies OR id IN the relationship part), because 7240's admin arm of
--     visible_employment_ids admits only companies app.is_admin_for admits.
-- Signature, volatility, owner, search_path, grants, the NULL answer for unnarrowed terms and the sorted result are
-- unchanged. The single statement between the $search$ markers is the one test/employment-search-trigram explains,
-- now with the caller's companies in scope as $4. From 7530 the application asks once per search, in its own
-- statement, and passes the ids to its statements as a list.
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
 -- Employments in scope outside the caller's administrator and partner companies, counted up to this bound: at most
 -- this many, and the caller's own read (as before 7320) costs less than narrowing.
 v_outside_limit constant integer := 1000;
 v_read uuid[];
 v_out_companies uuid[];
 v_scope_outside integer;
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
 v_read := ARRAY(SELECT c.id FROM public.company c WHERE c.tenant_id = app.current_tenant_id()
  AND (p_companies IS NULL OR c.id = ANY (p_companies))
  AND (app.is_admin_for(c.id) OR app.can_admin_payroll_for(c.id) OR app.can_admin_perfcomp_for(c.id)) ORDER BY c.id);
 v_out_companies := ARRAY(SELECT c.id FROM public.company c WHERE c.tenant_id = app.current_tenant_id()
  AND (p_companies IS NULL OR c.id = ANY (p_companies)) AND NOT (c.id = ANY (v_read)));
 SELECT count(*) INTO v_scope_outside FROM (SELECT 1 FROM public.employment e
  WHERE e.tenant_id = app.current_tenant_id() AND e.company_id = ANY (v_out_companies) AND e.voided_at IS NULL
  LIMIT v_outside_limit + 1) s;
 IF v_scope_outside <= v_outside_limit THEN
  RETURN NULL;
 END IF;
 EXECUTE v_search INTO v_inside, v_outside USING v_pattern, p_companies, coalesce(p_email, false), v_read;
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

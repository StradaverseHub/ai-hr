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
-- (which 7320 also built, inside visible_employment_ids).
--
-- It also answers NULL (do not narrow; core/employment-search.ts then reads exactly as before 7320) in two cases
-- where narrowing costs more than that read, both only when at most 100 employments in scope lie outside the
-- companies the caller administers or partners (elsewhere row security is costly per row, and the read before 7320
-- checked it on every row in scope): the caller names companies holding at most 1,000 employments (the tenant-wide
-- trigram search costs more than reading them), or the term is broad: more than 2,000 name or code matches in the
-- tenant (a bounded count before the search), or more than 2,000 matches all in companies the caller administers or
-- partners (fetching thousands by key costs more than the read). From 7530 the application asks the
-- function once per search and passes the ids as a list. Signature, volatility, owner, search_path, grants, the
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
 -- At most a few more than v_match_limit name or code matches in the tenant, counted before the search itself.
 v_broad constant text := $broad$
  SELECT count(*) FROM (
   (SELECT 1 FROM public.person p WHERE p.tenant_id = app.current_tenant_id() AND lower(p.full_name COLLATE "C") LIKE $1 LIMIT $2)
   UNION ALL
   (SELECT 1 FROM public.employment e WHERE e.tenant_id = app.current_tenant_id() AND lower(coalesce(e.employee_code, '') COLLATE "C") LIKE $1 LIMIT $2)
  ) m
 $broad$;
 v_matches integer;
 -- The read before 7320 is cheaper than narrowing only where the caller's row security is cheap per row: at most this
 -- many employments in scope lie outside the companies the caller administers or partners (each of those rows asks
 -- the per-row partner questions and the relationship set).
 v_outside_limit constant integer := 100;
 -- Then, up to this many employments in the named companies, reading them costs less than the tenant-wide search.
 v_scope_limit constant integer := 1000;
 -- Or more matches than this, all in administered or partner companies: fetching them by key costs more than the read.
 v_match_limit constant integer := 2000;
 v_out_companies uuid[];
 v_scope_outside integer;
 v_scope integer;
 v_read uuid[];
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
 v_read := app.employment_read_companies();
 -- Companies in scope the caller neither administers nor partners, and (bounded) how many employments they hold.
 v_out_companies := ARRAY(SELECT c.id FROM public.company c WHERE c.tenant_id = app.current_tenant_id()
  AND (p_companies IS NULL OR c.id = ANY (p_companies)) AND NOT (c.id = ANY (v_read)));
 SELECT count(*) INTO v_scope_outside FROM (SELECT 1 FROM public.employment e
  WHERE e.tenant_id = app.current_tenant_id() AND e.company_id = ANY (v_out_companies) AND e.voided_at IS NULL
  LIMIT v_outside_limit + 1) s;
 IF p_companies IS NOT NULL AND v_scope_outside <= v_outside_limit THEN
  SELECT count(*) INTO v_scope FROM (SELECT 1 FROM public.employment e
   WHERE e.tenant_id = app.current_tenant_id() AND e.company_id = ANY (p_companies) AND e.voided_at IS NULL
   LIMIT v_scope_limit + 1) s;
  IF v_scope <= v_scope_limit THEN
   RETURN NULL;
  END IF;
 END IF;
 IF v_scope_outside <= v_outside_limit THEN
  -- A broad term for a caller with cheap row security: decide before paying for the search.
  EXECUTE v_broad INTO v_matches USING v_pattern, v_match_limit + 1;
  IF v_matches > v_match_limit THEN
   RETURN NULL;
  END IF;
 END IF;
 EXECUTE v_search INTO v_inside, v_outside USING v_pattern, p_companies, coalesce(p_email, false), v_read;
 IF cardinality(v_outside) = 0 THEN
  IF cardinality(v_inside) > v_match_limit AND v_scope_outside <= v_outside_limit THEN
   RETURN NULL;
  END IF;
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

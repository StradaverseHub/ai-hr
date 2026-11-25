-- ADR 0181 decision 5 (Phase 4): tenant-led trigram indexes for the names and numbers people search.
--
-- The employee picker and the People directory search with `ilike '%term%'` / `lower(.. collate "C") like '%term%'`
-- under row security. Neither operator is LEAKPROOF, so PostgreSQL may not evaluate it as an index condition ahead
-- of the employment and person policies (restriction_is_securely_promotable): an index on the searched text is never
-- used by an ai_hr_app read, and every search reads every visible employment. LEAKPROOF cannot be granted by the
-- restricted migration owner.
--
-- This migration therefore searches inside one SECURITY DEFINER candidate function, as the table owner, where the
-- trigram indexes are usable, and narrows the answer to the caller's visible set before it leaves the function:
--   * the employments app.visible_employment_ids() returns (7240's body with its stored relationship answer), and
--   * the employments of companies app.employment_read_companies() returns (administrator, Payroll partner and
--     performance-and-compensation partner companies, 7240).
-- Together they cover every employment employment_rls admits (its point-read branch admits administrator and
-- Payroll partner companies, its normal branch the visible set and the two partner arms). The function returns
-- employment ids only. Callers add `employment.id = any(candidates)` to their own row-secured read, so row security
-- still decides every row shown, and the candidate set is only ever a superset of the matches: it includes every
-- employment whose name, code or e-mail is non-ASCII, which the callers' exact matching then decides as before.
-- The function answers NULL (no narrowing) for a query that is not 3 to 200 printable ASCII characters, where a
-- trigram index cannot help; callers then read exactly as before.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS btree_gin;
--> statement-breakpoint
-- Tenant-led: (tenant_id, text) GIN indexes, so a search reads only its own tenant's entries.
CREATE INDEX person_full_name_search_trgm ON public.person USING gin (tenant_id, lower(full_name COLLATE "C") gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX person_primary_email_search_trgm ON public.person USING gin (tenant_id, lower(coalesce(primary_email, '') COLLATE "C") gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX employment_code_search_trgm ON public.employment USING gin (tenant_id, lower(coalesce(employee_code, '') COLLATE "C") gin_trgm_ops);
--> statement-breakpoint
-- The always-included non-ASCII rows, read through small partial indexes rather than a scan.
CREATE INDEX person_full_name_non_ascii_idx ON public.person (tenant_id) WHERE (full_name COLLATE "C") ~ '[^ -~]';
--> statement-breakpoint
CREATE INDEX person_primary_email_non_ascii_idx ON public.person (tenant_id) WHERE (coalesce(primary_email, '') COLLATE "C") ~ '[^ -~]';
--> statement-breakpoint
CREATE INDEX employment_code_non_ascii_idx ON public.employment (tenant_id) WHERE (coalesce(employee_code, '') COLLATE "C") ~ '[^ -~]';
--> statement-breakpoint
-- RETURN QUERY EXECUTE ... USING plans the search with its values (a generic plan cannot choose a trigram index for
-- an unknown pattern). The statement text between the $search$ markers is the one test/employment-search-trigram
-- explains; keep it a single statement.
CREATE FUNCTION app.employment_search_candidates(p_query text, p_companies uuid[], p_email boolean)
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
  ), visible AS MATERIALIZED (
   SELECT unnest(app.visible_employment_ids()) AS id
  ), read_companies AS MATERIALIZED (
   SELECT unnest(app.employment_read_companies()) AS id
  )
  SELECT coalesce(array_agg(e.id ORDER BY e.id), '{}'::uuid[])
  FROM matched m JOIN public.employment e ON e.id = m.id
  WHERE e.tenant_id = app.current_tenant_id() AND e.voided_at IS NULL
   AND ($2 IS NULL OR e.company_id = ANY ($2))
   AND (e.id IN (SELECT v.id FROM visible v) OR e.company_id IN (SELECT c.id FROM read_companies c))
 $search$;
 v_ids uuid[];
 v_pattern text;
BEGIN
 IF p_query IS NULL OR p_query !~ '^[ -~]{3,200}$' OR app.current_tenant_id() IS NULL THEN
  RETURN NULL;
 END IF;
 -- The callers' own pattern: lower case, with \, % and _ matched literally (LIKE's default escape is \).
 v_pattern := '%' || replace(replace(replace(lower(p_query COLLATE "C"), '\', '\\'), '%', '\%'), '_', '\_') || '%';
 EXECUTE v_search INTO v_ids USING v_pattern, p_companies, coalesce(p_email, false);
 RETURN v_ids;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.employment_search_candidates(text, uuid[], boolean) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.employment_search_candidates(text, uuid[], boolean) TO ai_hr_app;

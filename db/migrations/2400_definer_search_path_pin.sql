-- Tenant-isolation defence in depth, ADR-0174 follow-up part 1 of 3. Not an exploitable gap today: these
-- functions are reached through policies and services that already carry a tenant conjunct. This makes each
-- one safe on its own.
--
-- A function's own SET search_path that does not name pg_temp still searches the session's temporary schema
-- FIRST for relation AND type names (functions and operators are never looked up there). Any role that may
-- create TEMP tables (PUBLIC by default, so ai_hr_app) can therefore put a TEMP `employment` in front of
-- public.employment, or a TEMP table named `uuid` in front of the uuid type, inside a SECURITY DEFINER body,
-- even when pg_catalog is listed first and every relation is schema-qualified. Naming pg_temp LAST closes it.
--
-- 1. app.can_see_employment, app.can_see_person and the two definer walks they call are re-issued with
--    `pg_catalog, public, pg_temp` and schema-qualified relations (the 0312/2100 rule). Bodies are 0109/0121/
--    0001 verbatim apart from the qualification and, in the two walks, a session-tenant pin on every row they
--    read: both are EXECUTE-able by ai_hr_app with arbitrary ids and read past RLS, so they now answer only
--    inside the session tenant, as 2100 did for the employment admin helpers. Every caller runs in withTenant.
-- 2. Every other SECURITY DEFINER function, and every invoker function that carries its own search_path,
--    keeps its path and gains pg_temp as the last entry (a bare `public` becomes `pg_catalog, public, pg_temp`,
--    which resolves identically). ALTER FUNCTION ... SET changes only that setting: body, owner, ACL,
--    volatility, OID and dependent policies are untouched, other settings (TimeZone) are kept. No body creates
--    or reads a TEMP relation of its own (catalog checks, 4 to 6 November 2026). Invokers are included because a
--    definer that calls one runs it with the definer's privileges under the invoker's own path.
--    The set is read from the catalog when this runs, not listed here, so a function another migration re-issued
--    earlier in the same upgrade keeps that migration's path with pg_temp added. On main's 697-entry journal it
--    is 259 functions besides the four above (6 November 2026).
-- 3. About sixty of them are owned by dedicated NOLOGIN roles (ai_hr_rewards_post_reader from 0689, and the
--    Architecture and Rewards readers and guard from 2200 onwards). Each owning migration gave its functions to
--    that role with ALTER FUNCTION ... OWNER TO, which PostgreSQL 16 allows only to a superuser or a member with
--    SET, so this migration assumes the owner for each such function and resets.
-- 4. app.is_company_descendant is not touched: 2126 already re-issued it pinned to the session tenant.
--
-- Anything the sweep cannot pin stops the migration with its name: a definer without its own search_path, a
-- path that already names pg_temp before its end, or an owner the migrator cannot assume.
-- test/definer-search-path-pin.test.ts fails on any future definer, or function with its own path, that does
-- not end its search_path with pg_temp. No table, column, policy or function grant changes.
CREATE OR REPLACE FUNCTION app.is_admin_report_of(subject_emp uuid, manager_emp uuid)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  WITH RECURSIVE mgr AS (
    SELECT company_id AS root_company FROM public.employment
    WHERE id = manager_emp AND tenant_id = app.current_tenant_id()
  ),
  down AS (
    -- Seed: direct reports of the manager (depth 1).
    SELECT rl.subordinate_employment_id AS emp, 1 AS depth
    FROM public.reporting_line rl
    JOIN public.employment sub ON sub.id = rl.subordinate_employment_id
    JOIN mgr ON true
    WHERE rl.manager_employment_id = manager_emp
      AND rl.tenant_id = app.current_tenant_id() AND sub.tenant_id = app.current_tenant_id()
      AND rl.line_type = 'administrative'
      AND rl.superseded_at IS NULL
      AND rl.valid_from <= current_date AND (rl.valid_to IS NULL OR rl.valid_to > current_date)
      AND sub.terminated_on IS NULL
      AND app.is_company_descendant(sub.company_id, mgr.root_company)
    UNION
    -- Recurse: reports of any reachable (non-terminated) intermediate manager.
    SELECT rl.subordinate_employment_id, d.depth + 1
    FROM public.reporting_line rl
    JOIN public.employment mid ON mid.id = rl.manager_employment_id
    JOIN public.employment sub ON sub.id = rl.subordinate_employment_id
    JOIN down d ON d.emp = rl.manager_employment_id
    JOIN mgr ON true
    WHERE rl.line_type = 'administrative'
      AND rl.tenant_id = app.current_tenant_id() AND mid.tenant_id = app.current_tenant_id()
      AND sub.tenant_id = app.current_tenant_id()
      AND rl.superseded_at IS NULL
      AND rl.valid_from <= current_date AND (rl.valid_to IS NULL OR rl.valid_to > current_date)
      AND mid.terminated_on IS NULL
      AND sub.terminated_on IS NULL
      AND d.depth < 64
      AND app.is_company_descendant(sub.company_id, mgr.root_company)
  )
  SELECT EXISTS (SELECT 1 FROM down WHERE emp = subject_emp);
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.heads_department_of(subject_emp uuid, caller_emp uuid)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  WITH caller_dept AS (
    SELECT a.department_id AS dept, d.company_id AS company
    FROM public.assignment a
    JOIN public.employment e ON e.id = a.employment_id
    JOIN public.department d ON d.id = a.department_id
    WHERE a.employment_id = caller_emp
      AND a.tenant_id = app.current_tenant_id() AND e.tenant_id = app.current_tenant_id()
      AND d.tenant_id = app.current_tenant_id()
      AND a.valid_to IS NULL AND a.superseded_at IS NULL
      AND a.department_id IS NOT NULL
      AND e.terminated_on IS NULL
  ),
  subject_dept AS (
    SELECT a.department_id AS dept
    FROM public.assignment a
    WHERE a.employment_id = subject_emp
      AND a.tenant_id = app.current_tenant_id()
      AND a.valid_to IS NULL AND a.superseded_at IS NULL
      AND a.department_id IS NOT NULL
  ),
  -- All departments in the subtree rooted at the caller's department (inclusive), clamped so every hop
  -- stays within the caller's company subtree (mirrors the manager branch's app.is_company_descendant clamp).
  subtree AS (
    WITH RECURSIVE down AS (
      SELECT cd.dept AS id, 0 AS depth FROM caller_dept cd
      UNION ALL
      SELECT d.id, down.depth + 1
      FROM public.department d
      JOIN down ON d.parent_department_id = down.id
      JOIN caller_dept cd ON true
      -- Audit #35: depth cap (mirrors app.is_admin_report_of's d.depth < 64) so a cyclic or pathologically
      -- deep department chain cannot loop unbounded inside this SECURITY DEFINER fn on every visibility check.
      WHERE app.is_company_descendant(d.company_id, cd.company) AND down.depth < 64
        AND d.tenant_id = app.current_tenant_id()
    )
    SELECT id FROM down
  )
  SELECT EXISTS (
    SELECT 1
    FROM subject_dept sd
    JOIN subtree st ON st.id = sd.dept
    WHERE EXISTS (SELECT 1 FROM caller_dept)
      AND EXISTS (
        SELECT 1 FROM public.reporting_line rl
        WHERE rl.manager_employment_id = caller_emp
          AND rl.tenant_id = app.current_tenant_id()
          AND rl.line_type = 'administrative'
          AND rl.superseded_at IS NULL
          AND rl.valid_from <= current_date AND (rl.valid_to IS NULL OR rl.valid_to > current_date)
      )
  );
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.can_see_employment(emp_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (
      SELECT 1 FROM public.employment e
      WHERE e.id = emp_id AND e.tenant_id = app.current_tenant_id() AND app.is_admin_for(e.company_id)
    )
    OR EXISTS (
      SELECT 1 FROM public.employment e JOIN public.app_user u ON u.person_id = e.person_id
      WHERE e.id = emp_id AND e.tenant_id = app.current_tenant_id() AND u.id = app.current_user_id()
    )
    OR EXISTS (
      -- Recursive administrative-manager branch (direct + indirect reports), over all caller employments.
      SELECT 1 FROM public.employment me
        JOIN public.app_user u ON u.person_id = me.person_id
      WHERE u.id = app.current_user_id()
        AND me.tenant_id = app.current_tenant_id()
        AND me.terminated_on IS NULL
        AND app.is_admin_report_of(emp_id, me.id)
    )
    OR EXISTS (
      -- HOD department-tree branch, over all caller employments.
      SELECT 1 FROM public.employment me
        JOIN public.app_user u ON u.person_id = me.person_id
      WHERE u.id = app.current_user_id()
        AND me.tenant_id = app.current_tenant_id()
        AND me.terminated_on IS NULL
        AND app.heads_department_of(emp_id, me.id)
    );
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.can_see_person(p_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT app.is_admin()
    OR EXISTS (
      SELECT 1 FROM public.app_user u
      WHERE u.id = app.current_user_id() AND u.person_id = p_id AND u.tenant_id = app.current_tenant_id()
    )
    OR EXISTS (
      SELECT 1 FROM public.employment e
      WHERE e.person_id = p_id AND e.tenant_id = app.current_tenant_id() AND app.can_see_employment(e.id)
    );
$$;
--> statement-breakpoint
DO $definer_search_path_pin$
DECLARE
  f record;
  pinned_path text;
  pinned integer := 0;
  remaining text;
  switched boolean;
BEGIN
  FOR f IN
    SELECT p.oid::pg_catalog.regprocedure::text AS fn, pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer,
           (SELECT pg_catalog.substr(c, 13) FROM pg_catalog.unnest(p.proconfig) c WHERE c LIKE 'search_path=%') AS path
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\_temp\_%' AND n.nspname NOT LIKE 'pg\_toast%'
      AND (p.prosecdef OR EXISTS (SELECT 1 FROM pg_catalog.unnest(p.proconfig) c WHERE c LIKE 'search_path=%'))
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                      WHERE d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass AND d.objid = p.oid AND d.deptype = 'e')
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.unnest(p.proconfig) c
                      WHERE c LIKE 'search_path=%' AND pg_catalog.replace(c, ' ', '') LIKE '%,pg\_temp')
    ORDER BY 2, 1
  LOOP
    IF f.path IS NULL THEN
      RAISE EXCEPTION 'SECURITY DEFINER % has no search_path of its own; pin it explicitly', f.fn;
    END IF;
    IF pg_catalog.replace(f.path, ' ', '') ~ '(^|,)pg_temp(,|$)' THEN
      RAISE EXCEPTION '% names pg_temp before the end of its search_path (%); pin it explicitly', f.fn, f.path;
    END IF;
    pinned_path := CASE WHEN pg_catalog.btrim(f.path) = 'public' THEN 'pg_catalog, public, pg_temp' ELSE f.path || ', pg_temp' END;
    switched := f.owner <> current_user;
    IF switched THEN
      EXECUTE pg_catalog.format('SET LOCAL ROLE %I', f.owner);
    END IF;
    EXECUTE pg_catalog.format('ALTER FUNCTION %s SET search_path = %s', f.fn, pinned_path);
    IF switched THEN
      RESET ROLE;
    END IF;
    pinned := pinned + 1;
  END LOOP;
  SELECT pg_catalog.string_agg(p.oid::pg_catalog.regprocedure::text, ', ') INTO remaining
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\_temp\_%' AND n.nspname NOT LIKE 'pg\_toast%'
    AND (p.prosecdef OR EXISTS (SELECT 1 FROM pg_catalog.unnest(p.proconfig) c WHERE c LIKE 'search_path=%'))
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                    WHERE d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass AND d.objid = p.oid AND d.deptype = 'e')
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.unnest(p.proconfig) c
                    WHERE c LIKE 'search_path=%' AND pg_catalog.replace(c, ' ', '') LIKE '%,pg\_temp');
  IF remaining IS NOT NULL THEN
    RAISE EXCEPTION 'Functions still lack a trailing pg_temp: %', remaining;
  END IF;
  RAISE NOTICE '2400 pinned % function search paths', pinned;
END $definer_search_path_pin$;

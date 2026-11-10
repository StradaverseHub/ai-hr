-- UNALLOCATED DRAFT on branch claude/bulkjob-leave-20261110: not a reservation, not an installation allocation. The
-- journal position (idx 9905, when 1793330099905) exists only so this branch's schema is executable and reviewable;
-- the integration owner assigns the final tag/idx/when, per docs/MIGRATION-ALLOCATION.md. Requires 9901.
--
-- The digests a staged leave job compares at release (core/leave-stage.ts). Read through the app role's row
-- security they cost about 0.2 ms per employee (every scanned ledger and assignment row was tested against the
-- caller's whole visible-employment array): 500-700 ms for 3,000 employees inside the release transaction, which
-- holds every subject's lock. Here the visible set is read once and hashed, the job's own stages and other jobs'
-- unreleased stages are excluded exactly as the policies exclude them, and only a digest per employment leaves the
-- function. Same rows, same visibility: administrators only (the only callers are administrator-authorised jobs).
--  p_full true:  hire/termination/company/grade/void, assignment row versions, ledger rows other than the caller's
--                own stages, frozen encashment balances (what the cohort engines read for the employee).
--  p_full false: the employment row version and assignment row versions (what the template resolver matches on).
CREATE FUNCTION app.leave_stage_digests(p_ids uuid[],p_own uuid[],p_full boolean) RETURNS TABLE(employment_id uuid,digest text)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH visible AS (SELECT DISTINCT v.id FROM unnest(app.visible_employment_ids()) v(id) WHERE app.is_admin()),
 released AS (SELECT r.stage_id FROM app.leave_stage_release r WHERE r.tenant_id=app.current_tenant_id()),
 subject AS (SELECT e.id,e.tenant_id,e.xmin::text AS version,e.hired_on,e.terminated_on,e.company_id,e.grade_id,e.voided_at
  FROM public.employment e JOIN (SELECT DISTINCT s.id FROM unnest(p_ids) s(id)) s ON s.id=e.id JOIN visible v ON v.id=e.id
  WHERE e.tenant_id=app.current_tenant_id())
 SELECT e.id, CASE WHEN p_full THEN md5(concat_ws('|',e.hired_on,e.terminated_on,e.company_id,e.grade_id,e.voided_at,a.d,l.d,f.d))
  ELSE md5(concat_ws('|',e.version,a.d)) END
 FROM subject e
 LEFT JOIN LATERAL (SELECT string_agg(x.xmin::text,',' ORDER BY x.id) AS d FROM public.assignment x WHERE x.employment_id=e.id AND x.tenant_id=e.tenant_id) a ON true
 LEFT JOIN LATERAL (SELECT string_agg(x.id::text||':'||x.days::text||':'||x.effective_on::text||':'||x.entry_type::text,',' ORDER BY x.id) AS d
  FROM public.leave_ledger x WHERE p_full AND x.employment_id=e.id AND x.tenant_id=e.tenant_id
   AND (x.stage_id IS NULL OR (x.stage_id IN (SELECT stage_id FROM released) AND x.stage_id <> ALL(p_own)))) l ON true
 LEFT JOIN LATERAL (SELECT string_agg(x.id::text||':'||x.leave_type_id::text,',' ORDER BY x.id) AS d
  FROM public.leave_encashment_snapshot x WHERE p_full AND x.employment_id=e.id AND x.tenant_id=e.tenant_id AND x.status='frozen') f ON true;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.leave_stage_digests(uuid[],uuid[],boolean) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.leave_stage_digests(uuid[],uuid[],boolean) TO ai_hr_app;

-- WP-C (APR-022): the head-of-department (HOD) department view. Read-only.
--
-- Population: the people whose LIVE performance_hod_assignment (0663; [valid_from, valid_to) in Malaysia
-- time) names one of the caller's active employments as HOD, in one OneHR-native rated cycle that is open
-- or in calibration, who take part in it (participation eligibility only, app.assessment_review_eligible:
-- never whether the caller could otherwise see them) and have KPI lines. Never
-- department.head_employment_id, never the caller's own person, never 360 panel or rater rows. The person and
-- the HOD share a business group (the 0663 assignment rule, restated here so forced data cannot widen it).
--
-- Overall: the stored KPI-weighted overall of the moderated values (performance_onehr_review
-- manager_performance / manager_score, written by the service from scorecard(..., manager=true)). It is
-- returned only once every KPI line is locked; until then the row is pending and carries no value. No value
-- is computed here and no calibration decision changes it.
--
-- Only the declared columns leave these functions: identity for display, the live administrative manager
-- when that manager is in the same population (for the row order), Direct/Indirect, and the overall.

-- ── 1. Participation eligibility only (internal) ──────────────────────────────────────────────────────
-- The eligibility half of app.assessment_review_participates (latest definition 0540:40-50): the person is
-- not terminated (unless the cycle is closed), then the per-person override, then the opening snapshot. Its
-- caller-visibility arm is deliberately absent: in the department view the live HOD assignment is the
-- authorization, so who the HOD could otherwise see never changes the population. Reached only from the
-- definer projection below; no app privilege.
CREATE FUNCTION app.assessment_review_eligible(wanted_review uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM performance_review r JOIN review_cycle c ON c.id=r.cycle_id AND c.tenant_id=r.tenant_id
  JOIN employment e ON e.id=r.employment_id AND e.tenant_id=r.tenant_id
  JOIN performance_assessment_participation p ON p.cycle_id=r.cycle_id AND p.employment_id=r.employment_id AND p.tenant_id=r.tenant_id
  WHERE r.id=wanted_review AND r.tenant_id=app.current_tenant_id()
   AND (c.status='closed' OR e.terminated_on IS NULL OR e.terminated_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
   AND CASE WHEN p.override='add' THEN true WHEN p.override='remove' THEN false ELSE p.eligible_at_open END)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.assessment_review_eligible(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- ── 2. One cycle: the people the caller heads ─────────────────────────────────────────────────────────
CREATE FUNCTION app.onehr_department_view(wanted_cycle uuid)
 RETURNS TABLE(employment_id uuid, parent_employment_id uuid, full_name text, department_name text, job_title text,
               direct boolean, finalized boolean, overall_band text, overall_score numeric, mechanism text)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH today AS (SELECT (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AS d),
 me AS MATERIALIZED (
  SELECT e.id FROM employment e JOIN app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id CROSS JOIN today
  WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
   AND (e.terminated_on IS NULL OR e.terminated_on>today.d)
 ),
 pop AS MATERIALIZED (
  SELECT r.tenant_id,r.employment_id,e.person_id,h.hod_employment_id,r.manager_performance,r.manager_score,r.kpis
  FROM review_cycle c CROSS JOIN today
  JOIN performance_onehr_cycle cfg ON cfg.cycle_id=c.id AND cfg.tenant_id=c.tenant_id
  JOIN performance_onehr_review r ON r.cycle_id=c.id AND r.tenant_id=c.tenant_id
  JOIN employment e ON e.id=r.employment_id AND e.tenant_id=r.tenant_id
  JOIN performance_hod_assignment h ON h.tenant_id=r.tenant_id AND h.subject_employment_id=r.employment_id
   AND h.valid_from<=today.d AND (h.valid_to IS NULL OR h.valid_to>today.d)
  JOIN employment he ON he.id=h.hod_employment_id AND he.tenant_id=h.tenant_id
  WHERE c.id=wanted_cycle AND c.tenant_id=app.current_tenant_id() AND c.status IN ('open','calibration')
   AND h.hod_employment_id IN (SELECT id FROM me)
   AND app.onehr_business_group_node(e.company_id)=app.onehr_business_group_node(he.company_id)
   AND coalesce((cfg.policy->'modules'->>'pm')::boolean,false) AND coalesce(cfg.policy->>'kind','')<>'quarterly'
   AND jsonb_array_length(r.kpis)>0
   AND NOT app.is_self_person(e.person_id)
   AND app.assessment_review_eligible(r.review_id)
 ),
 facts AS (
  SELECT p.*,
   NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.kpis) k WHERE coalesce((k->>'locked')::boolean,false)=false) AND p.manager_performance IS NOT NULL AS done,
   (SELECT l.manager_employment_id FROM reporting_line l CROSS JOIN today
    WHERE l.tenant_id=p.tenant_id AND l.subordinate_employment_id=p.employment_id AND l.line_type='administrative' AND l.superseded_at IS NULL
     AND l.valid_from<=today.d AND (l.valid_to IS NULL OR l.valid_to>today.d)
    ORDER BY l.valid_from DESC,l.id LIMIT 1) AS line_manager
  FROM pop p
 )
 SELECT f.employment_id,
  CASE WHEN f.line_manager IN (SELECT pop.employment_id FROM pop) THEN f.line_manager END,
  person.full_name,
  a.department_name,
  a.job_title,
  coalesce(f.line_manager=f.hod_employment_id,false),
  f.done,
  CASE WHEN f.done THEN f.manager_performance END,
  CASE WHEN f.done THEN f.manager_score END,
  CASE WHEN f.done THEN f.kpis->0->'scoring'->>'mechanism' END
 FROM facts f
 JOIN person ON person.id=f.person_id AND person.tenant_id=f.tenant_id
 LEFT JOIN LATERAL (
  SELECT d.name AS department_name,pos.title AS job_title FROM assignment x CROSS JOIN today
  LEFT JOIN department d ON d.id=x.department_id AND d.tenant_id=x.tenant_id
  LEFT JOIN position pos ON pos.id=x.position_id AND pos.tenant_id=x.tenant_id
  WHERE x.employment_id=f.employment_id AND x.tenant_id=f.tenant_id AND x.superseded_at IS NULL
   AND x.valid_from<=today.d AND (x.valid_to IS NULL OR x.valid_to>today.d)
  ORDER BY x.valid_from DESC,x.id LIMIT 1
 ) a ON true
 ORDER BY person.full_name,f.employment_id
$$;
--> statement-breakpoint
-- ── 3. The cycles the caller heads someone in: the cycle choice and the navigation gate ───────────────
-- Open cycles first, then cycles in calibration; newest period end first inside each. Counts only.
CREATE FUNCTION app.onehr_department_cycles()
 RETURNS TABLE(cycle_id uuid, cycle_name text, period_end date, people integer, finalized integer)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT c.id,c.name,c.period_end,count(*)::integer,(count(*) FILTER (WHERE v.finalized))::integer
 FROM review_cycle c CROSS JOIN LATERAL app.onehr_department_view(c.id) v
 WHERE c.tenant_id=app.current_tenant_id() AND c.status IN ('open','calibration')
 GROUP BY c.id,c.name,c.period_end,c.status
 ORDER BY (c.status='open') DESC,c.period_end DESC,c.name,c.id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.onehr_department_view(uuid),app.onehr_department_cycles() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.onehr_department_view(uuid),app.onehr_department_cycles() TO ai_hr_app;

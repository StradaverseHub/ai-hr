-- TASK-030 (CF-26 / AC-10) — a Career Plan is read and written by its subject, its assigned reviewer and the
-- OneHR administrator of its cycle; department-tree visibility no longer reaches it.
--
-- Latest definitions restated here: USING 0611:192, WITH CHECK 0540:360. Both admitted
-- `employment_id = ANY(app.visible_employment_ids())` / `app.can_see_employment(employment_id)` — the whole
-- department tree (0515:219: skip-level managers through the administrative chain, heads of department through
-- the department subtree) read every non-draft plan of everyone below them and could write it. OneHR
-- (_idp_is_reviewer_of, app.py:29236) gives a plan to the subject's KPI approvers and line manager only.
--
-- After this file, one row is admitted when ANY of:
--   self      the subject (app.is_self_person on the plan's employment)              — any status;
--   admin     app.onehr_admin(employment company) AND app.onehr_cycle_admin(cycle of the plan's review) — any
--             status; the ADR-0142 pattern of 0611:192's draft arm, so a performance partner is admitted only
--             for a OneHR-native cycle it administers (VF-06), and app.onehr_employment answers for it (VF-07);
--   reviewer  app.assessment_plan_reviewer(id) (0540:355: the line manager or a KPI approver/moderator of a review
--             whose cycle owns the plan year)                                         — non-draft only.
-- USING is exactly 0611's `(visible OR reviewer) AND (status<>'draft' OR self OR admin)` with `visible` replaced
-- by `self OR admin`; it simplifies to `self OR admin OR (status<>'draft' AND reviewer)`, written that way below.
-- The draft rule is therefore unchanged: a draft is read by its subject and its administrator only.
-- WITH CHECK takes the same three arms (no status condition: a reviewer's UPDATE keeps the row shared/closed,
-- which the 0529 onehr_validate_links trigger already enforces). There is no visibility-only writer left.
--
-- Untouched, deliberately:
--   assessment_plan_dispatch_read (0540:1409) — SELECT only, and only when app.current_user_id() IS NULL AND
--     app.is_group_admin(): the scheduled dispatcher with no human user. No person can satisfy it.
--   assessment_career_profile_access (0540:553) — app.assessment_career_access (0540:523) is already self, OneHR
--     admin, or the manager/moderator of an open/calibration review: no department-tree arm.
-- Readers inside SECURITY DEFINER functions (0540:1483 reminder work, 0540:1756 calibration sources) run as the
-- table owner; performance_onehr_plan has RLS enabled, not forced, so they are unaffected.
ALTER POLICY onehr_plan_access ON performance_onehr_plan
 USING(tenant_id=app.current_tenant_id() AND (
  EXISTS(SELECT 1 FROM app.onehr_employment e WHERE e.id=performance_onehr_plan.employment_id AND e.tenant_id=performance_onehr_plan.tenant_id AND (app.is_self_person(e.person_id) OR app.onehr_admin(e.company_id) AND EXISTS(SELECT 1 FROM performance_onehr_review r WHERE r.review_id=performance_onehr_plan.review_id AND r.tenant_id=e.tenant_id AND app.onehr_cycle_admin(r.cycle_id))))
  OR status<>'draft' AND app.assessment_plan_reviewer(id)))
 WITH CHECK(tenant_id=app.current_tenant_id() AND (
  EXISTS(SELECT 1 FROM app.onehr_employment e WHERE e.id=performance_onehr_plan.employment_id AND e.tenant_id=performance_onehr_plan.tenant_id AND (app.is_self_person(e.person_id) OR app.onehr_admin(e.company_id) AND EXISTS(SELECT 1 FROM performance_onehr_review r WHERE r.review_id=performance_onehr_plan.review_id AND r.tenant_id=e.tenant_id AND app.onehr_cycle_admin(r.cycle_id))))
  OR app.assessment_plan_reviewer(id)));

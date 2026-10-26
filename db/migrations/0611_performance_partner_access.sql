-- ADR-0142 — OneHR performance partner: performance administration without compensation.
--
-- 0610 added the enum value. This file gives it exactly the authority ADR-0142 §2-§5 describes and
-- nothing else. The label is referenced ONLY as text (r.role::text, text CHECK constraints): drizzle runs
-- every pending migration in ONE transaction, so 0610's ADD VALUE has not committed when this file runs
-- and a 'performance_partner'::role literal here would fail with "unsafe use of new value".
--
-- What the role gets (all of it OneHR-native-cycle scoped, company + descendants, live grant):
--   1. app.assessment_admin_for admits it  → onehr_admin / onehr_cycle_admin / calibration access and every
--      OneHR satellite policy follow (ADR-0142 §2).
--   2. NO read of an employment or assignment row beyond the self/relationship visibility every employee has
--      (VF-07, APR-017): a row carries termination and blacklist reasons, cost allocation, payroll policy and
--      the like. OneHR administration reads the few columns it needs through ONE definer projection per table
--      (app.onehr_employment_facts / app.onehr_assignment_facts), exposed as the invoker views
--      app.onehr_employment / app.onehr_assignment: the row the caller can read wins, the projection only
--      fills in the partner's companies. SELECT-only reads of performance_review rows of OneHR-native cycles
--      (§3). No write policy on any of those tables changes.
--   3. review_cycle: an UPDATE policy for OneHR-native cycles in scope, solely so the existing
--      `SELECT … FOR UPDATE` locks in the OneHR services succeed, plus a BEFORE UPDATE trigger that refuses
--      any actual change made with no authority but this role (§3). Row locks do not fire UPDATE triggers.
--   4. app.onehr_person_labels — the ONE projection of person labels (name, preferred name, employee code)
--      OneHR administration reads. person RLS is NOT widened: a person row carries DOB, address, gender and
--      marital status (§3).
--   5. Role allow-lists in the existing SQL owners admit it so it can be assigned, invited, enrolled and
--      revoked (§5): 0312's app_invitation CHECK, 0526's manual-enrollment CHECK + reserve + consume, and
--      0579's legacy role authority floor.
--
-- What it does NOT get: compensation_rls, payroll_*, rewards, person_rls, can_admin_perfcomp_*, is_admin*,
-- has_role_for('performance_comp_partner') — none of those are touched. Generic (non-OneHR) cycles stay
-- behind canAdminPerfCtx / review_cycle_write / performance_review_rls exactly as before.

-- ── 1. The one admission change (latest definition: 0540:1414-1419) ───────────────────────────────────
CREATE OR REPLACE FUNCTION app.assessment_admin_for(wanted_user uuid,wanted_company uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app_user u JOIN role_assignment r ON r.app_user_id=u.id AND r.tenant_id=u.tenant_id
 WHERE u.id=wanted_user AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
 AND r.role::text IN ('hr_admin','super_admin','performance_comp_partner','performance_partner') AND (r.company_id IS NULL OR wanted_company IS NOT NULL AND (r.company_id=wanted_company OR app.is_company_descendant(wanted_company,r.company_id))))
$$;
REVOKE ALL ON FUNCTION app.assessment_admin_for(uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint

-- ── 2. Partner-only scope helpers ──────────────────────────────────────────────────────────────────────
-- TRUE only when the CURRENT live user holds performance_partner covering wanted_company. Same live-grant,
-- archive, login-block and company/descendant semantics as app.assessment_admin_for; a group-wide grant
-- (company_id NULL) covers every company and the group-wide (NULL) scope, a company grant never covers NULL.
-- It answers "is this actor a OneHR performance partner here", never "may this actor administer HR".
CREATE FUNCTION app.onehr_partner_for(wanted_company uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app_user u JOIN role_assignment r ON r.app_user_id=u.id AND r.tenant_id=u.tenant_id
 WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
 AND r.role::text='performance_partner' AND (r.company_id IS NULL OR wanted_company IS NOT NULL AND (r.company_id=wanted_company OR app.is_company_descendant(wanted_company,r.company_id))))
$$;
REVOKE ALL ON FUNCTION app.onehr_partner_for(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onehr_partner_for(uuid) TO ai_hr_app;
--> statement-breakpoint
-- The same scope as a set, for the kernel read policies below. employment / assignment / performance_review
-- are read by every screen for every actor, so a per-row function call in a permissive policy would tax all
-- of them; `= ANY((SELECT …)::uuid[])` is planned as one InitPlan per statement (the 0515 pattern), and an
-- actor holding no performance_partner grant short-circuits to an empty array without walking companies.
CREATE FUNCTION app.onehr_partner_company_ids() RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM app_user u JOIN role_assignment r ON r.app_user_id=u.id AND r.tenant_id=u.tenant_id
   WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND r.role::text='performance_partner')
  THEN '{}'::uuid[]
  ELSE (SELECT coalesce(array_agg(c.id ORDER BY c.id),'{}'::uuid[]) FROM company c WHERE c.tenant_id=app.current_tenant_id() AND app.onehr_partner_for(c.id))
 END
$$;
REVOKE ALL ON FUNCTION app.onehr_partner_company_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onehr_partner_company_ids() TO ai_hr_app;
--> statement-breakpoint

-- Panel-request scope for the partner (used by the peer_feedback_request policies in §3).
CREATE FUNCTION app.onehr_partner_panel_request(wanted_review uuid, wanted_subject uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT cardinality(app.onehr_partner_company_ids()) > 0 AND EXISTS(
  SELECT 1 FROM performance_onehr_review r JOIN employment e ON e.id=r.employment_id AND e.tenant_id=r.tenant_id
  WHERE r.review_id=wanted_review AND r.employment_id=wanted_subject AND r.tenant_id=app.current_tenant_id()
   AND e.company_id = ANY(app.onehr_partner_company_ids()) AND app.onehr_partner_for(r.company_id)
   AND NOT app.is_self_person(e.person_id))
$$;
REVOKE ALL ON FUNCTION app.onehr_partner_panel_request(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onehr_partner_panel_request(uuid,uuid) TO ai_hr_app;
--> statement-breakpoint

-- ── 3. Kernel reads: a column projection, never the employment / assignment row (VF-07, APR-017) ──────
-- The partner gets NO policy on employment or assignment. Those rows carry termination type, reason and
-- code, notice and blacklist details, cost allocation, payroll policy, card and schedule settings: none of
-- it is OneHR administration's business. What OneHR administration does read is listed column by column,
-- with its consumer, and nothing else leaves these functions:
--   employment: id + tenant_id (keys and tenant pins), person_id (labels via app.onehr_person_labels, login
--     and self checks), company_id (OneHR scope and grouping), employee_code (lists, reports, KPI import and
--     reminder preview matching), grade_id (panel eligibility, career grade), hired_on + confirmation_date
--     (participation eligibility), terminated_on (active-employee filters; the date, never the reason).
--   assignment: id + tenant_id + employment_id (keys), department_id (department labels and filters,
--     catalogue profile and KPI library matching), position_id (catalogue profile title matching),
--     valid_from + valid_to + superseded_at (the current-assignment pick).
-- Scope is exactly the rows the retired employment_onehr_partner_read / assignment_onehr_partner_read
-- policies admitted: employments in the partner's companies (app.onehr_partner_company_ids: live grant,
-- descendants, archive and login block), current tenant only. Any other actor gets an empty set from a
-- one-time filter, without walking employment.
CREATE FUNCTION app.onehr_employment_facts() RETURNS TABLE(id uuid, tenant_id uuid, person_id uuid, company_id uuid, employee_code text, grade_id uuid, hired_on date, confirmation_date date, terminated_on date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT e.id, e.tenant_id, e.person_id, e.company_id, e.employee_code, e.grade_id, e.hired_on, e.confirmation_date, e.terminated_on
 FROM employment e
 WHERE cardinality((SELECT app.onehr_partner_company_ids())) > 0
  AND e.tenant_id = app.current_tenant_id() AND e.company_id = ANY ((SELECT app.onehr_partner_company_ids())::uuid[])
$$;
REVOKE ALL ON FUNCTION app.onehr_employment_facts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onehr_employment_facts() TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.onehr_assignment_facts() RETURNS TABLE(id uuid, tenant_id uuid, employment_id uuid, department_id uuid, position_id uuid, valid_from date, valid_to date, superseded_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT a.id, a.tenant_id, a.employment_id, a.department_id, a.position_id, a.valid_from, a.valid_to, a.superseded_at
 FROM assignment a JOIN employment e ON e.id = a.employment_id AND e.tenant_id = a.tenant_id
 WHERE cardinality((SELECT app.onehr_partner_company_ids())) > 0
  AND a.tenant_id = app.current_tenant_id() AND e.company_id = ANY ((SELECT app.onehr_partner_company_ids())::uuid[])
$$;
REVOKE ALL ON FUNCTION app.onehr_assignment_facts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onehr_assignment_facts() TO ai_hr_app;
--> statement-breakpoint
-- What OneHR administration reads in place of employment / assignment (packs/performance/onehr/
-- employment-projection.ts). security_invoker: the first arm is the caller's own RLS-filtered row, so every
-- actor who is not a performance partner reads exactly the rows it read before; the second arm adds only the
-- projection rows the caller cannot read itself. The readable row wins; both arms carry the same columns.
CREATE VIEW app.onehr_employment WITH (security_invoker = true) AS
 SELECT e.id, e.tenant_id, e.person_id, e.company_id, e.employee_code, e.grade_id, e.hired_on, e.confirmation_date, e.terminated_on
 FROM public.employment e
 UNION ALL
 SELECT f.id, f.tenant_id, f.person_id, f.company_id, f.employee_code, f.grade_id, f.hired_on, f.confirmation_date, f.terminated_on
 FROM app.onehr_employment_facts() f WHERE NOT EXISTS (SELECT 1 FROM public.employment v WHERE v.id = f.id);
REVOKE ALL ON app.onehr_employment FROM PUBLIC;
GRANT SELECT ON app.onehr_employment TO ai_hr_app;
--> statement-breakpoint
CREATE VIEW app.onehr_assignment WITH (security_invoker = true) AS
 SELECT a.id, a.tenant_id, a.employment_id, a.department_id, a.position_id, a.valid_from, a.valid_to, a.superseded_at
 FROM public.assignment a
 UNION ALL
 SELECT f.id, f.tenant_id, f.employment_id, f.department_id, f.position_id, f.valid_from, f.valid_to, f.superseded_at
 FROM app.onehr_assignment_facts() f WHERE NOT EXISTS (SELECT 1 FROM public.assignment v WHERE v.id = f.id);
REVOKE ALL ON app.onehr_assignment FROM PUBLIC;
GRANT SELECT ON app.onehr_assignment TO ai_hr_app;
--> statement-breakpoint
-- OneHR-native cycles only: a generic cycle's performance_review row carries the merit/bonus recommendation
-- (ADR-0049 §3), which is exactly what this role must never read.
CREATE POLICY performance_review_onehr_partner_read ON performance_review FOR SELECT
 USING (tenant_id = app.current_tenant_id()
  AND cardinality((SELECT app.onehr_partner_company_ids())) > 0
  AND EXISTS (SELECT 1 FROM performance_onehr_cycle oc JOIN review_cycle c ON c.id = oc.cycle_id AND c.tenant_id = oc.tenant_id
   WHERE oc.cycle_id = performance_review.cycle_id AND oc.tenant_id = performance_review.tenant_id
    -- The cycle must be one the partner administers too, not only the subject's employer (VF-04): a company-A
    -- partner never reads a company-X or group-wide cycle's rows because the subject happens to work in A.
    AND (c.company_id = ANY ((SELECT app.onehr_partner_company_ids())::uuid[]) OR (c.company_id IS NULL AND app.onehr_partner_for(NULL))))
  -- The subject works in a partner company, which is exactly the projection's set (VF-07).
  AND EXISTS (SELECT 1 FROM app.onehr_employment_facts() e WHERE e.id = performance_review.employment_id));
--> statement-breakpoint

-- peer_feedback_request is a performance-pack satellite (packs/performance/index.ts) that OneHR panel
-- administration writes beside performance_onehr_panel (assignOnehrPanelTx, changeAssessmentPanelStateTx).
-- ADR-0142's verification contract has the partner administer panels, and §4 does not exclude this table,
-- so it gets the OneHR-scoped rows HR already reaches: OneHR-native reviews whose subject is employed in a
-- partner company, never the partner's OWN panel (0054's anonymity rule). SELECT, INSERT and UPDATE only;
-- no DELETE. The row carries the subject/peer/cycle names and a status, no rating or pay.
CREATE POLICY peer_feedback_request_onehr_partner_read ON peer_feedback_request FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND cardinality((SELECT app.onehr_partner_company_ids())) > 0 AND app.onehr_partner_panel_request(review_id, subject_employment_id));
--> statement-breakpoint
-- VF-05: a partner's row names the partner as requester and a peer it can see in this tenant (the read below
-- is app.onehr_employment: the caller's own RLS-bound rows plus the partner-company projection, so a peer
-- outside the partner's companies is refused). UPDATE cannot pin the requester (a policy has no OLD), so it
-- re-checks the peer and the review scope only.
CREATE POLICY peer_feedback_request_onehr_partner_insert ON peer_feedback_request FOR INSERT
 WITH CHECK (tenant_id = app.current_tenant_id() AND cardinality((SELECT app.onehr_partner_company_ids())) > 0 AND app.onehr_partner_panel_request(review_id, subject_employment_id)
  AND requested_by_user_id = app.current_user_id()
  AND EXISTS (SELECT 1 FROM app.onehr_employment p WHERE p.id = peer_feedback_request.peer_employment_id AND p.tenant_id = peer_feedback_request.tenant_id));
--> statement-breakpoint
CREATE POLICY peer_feedback_request_onehr_partner_update ON peer_feedback_request FOR UPDATE
 USING (tenant_id = app.current_tenant_id() AND cardinality((SELECT app.onehr_partner_company_ids())) > 0 AND app.onehr_partner_panel_request(review_id, subject_employment_id))
 WITH CHECK (tenant_id = app.current_tenant_id() AND cardinality((SELECT app.onehr_partner_company_ids())) > 0 AND app.onehr_partner_panel_request(review_id, subject_employment_id)
  AND EXISTS (SELECT 1 FROM app.onehr_employment p WHERE p.id = peer_feedback_request.peer_employment_id AND p.tenant_id = peer_feedback_request.tenant_id));
--> statement-breakpoint

-- ── 3a. OneHR satellite policies that read employment for ADMINISTRATION scope (VF-07) ──────────────────
-- 0540 wrote these against `employment` under the caller's RLS, which HR (and perf-comp partners) can read
-- in scope and the performance partner now cannot. Each is restated byte-for-byte from its latest definition
-- except `employment` -> app.onehr_employment, so HR's answer is unchanged (the readable row wins) and the
-- partner's admin answer is what it was with the retired employment policy. Deliberately untouched: reads
-- that are a SELF test (`… is_self_person`: the partner's own employment stays readable, so they answer as
-- before), reads bound to app.visible_employment_ids() (kpi_library_read: the retired policy never changed
-- that set), and the manager / moderator arms of onehr_evidence_insert / _update, which never served
-- administration and now answer for a partner exactly as for any other manager or moderator.
-- 0540:31-33 — participation overrides (setAssessmentParticipation).
ALTER POLICY assessment_participation_admin ON performance_assessment_participation
 USING(tenant_id=app.current_tenant_id() AND app.onehr_cycle_admin(cycle_id) AND EXISTS(SELECT 1 FROM app.onehr_employment e WHERE e.id=employment_id AND e.tenant_id=performance_assessment_participation.tenant_id AND app.onehr_admin(e.company_id)))
 WITH CHECK(tenant_id=app.current_tenant_id() AND app.onehr_cycle_admin(cycle_id) AND EXISTS(SELECT 1 FROM app.onehr_employment e JOIN review_cycle c ON c.id=cycle_id WHERE e.id=employment_id AND e.tenant_id=performance_assessment_participation.tenant_id AND app.onehr_admin(e.company_id) AND (c.company_id IS NULL OR c.company_id=e.company_id)));
--> statement-breakpoint
-- 0540:360 — the administrator arm of a draft plan's visibility (the plan reviewer who also administers it).
ALTER POLICY onehr_plan_access ON performance_onehr_plan USING(tenant_id=app.current_tenant_id() AND (employment_id=ANY((SELECT app.visible_employment_ids())::uuid[]) OR app.assessment_plan_reviewer(id)) AND (status<>'draft' OR EXISTS(SELECT 1 FROM app.onehr_employment e WHERE e.id=performance_onehr_plan.employment_id AND e.tenant_id=performance_onehr_plan.tenant_id AND (app.is_self_person(e.person_id) OR app.onehr_admin(e.company_id) AND EXISTS(SELECT 1 FROM performance_onehr_review r WHERE r.review_id=performance_onehr_plan.review_id AND r.tenant_id=e.tenant_id AND app.onehr_cycle_admin(r.cycle_id))))));
--> statement-breakpoint
-- 0540:571-573 — release records.
ALTER POLICY assessment_release_admin ON performance_assessment_release
 USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM performance_onehr_review r JOIN app.onehr_employment e ON e.id=r.employment_id AND e.tenant_id=r.tenant_id WHERE r.review_id=performance_assessment_release.review_id AND r.tenant_id=performance_assessment_release.tenant_id AND app.onehr_cycle_admin(r.cycle_id) AND app.onehr_admin(e.company_id) AND NOT app.is_self_person(e.person_id)))
 WITH CHECK(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM performance_onehr_review r JOIN app.onehr_employment e ON e.id=r.employment_id AND e.tenant_id=r.tenant_id WHERE r.review_id=performance_assessment_release.review_id AND r.tenant_id=performance_assessment_release.tenant_id AND app.onehr_cycle_admin(r.cycle_id) AND app.onehr_admin(e.company_id) AND NOT app.is_self_person(e.person_id)));
--> statement-breakpoint
-- 0540:708-711 — rating records.
ALTER POLICY assessment_rating_record_read ON performance_assessment_rating_record USING(
 tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM performance_onehr_review r JOIN app.onehr_employment e ON e.id=r.employment_id AND e.tenant_id=r.tenant_id
 WHERE r.review_id=performance_assessment_rating_record.review_id AND r.tenant_id=performance_assessment_rating_record.tenant_id
 AND app.onehr_cycle_admin(r.cycle_id) AND app.onehr_admin(r.company_id) AND app.onehr_admin(e.company_id) AND NOT app.is_self_person(e.person_id)));
--> statement-breakpoint
-- 0540:1522 — a queued reminder's employment must be the recipient's own (queueAssessmentReminders).
ALTER POLICY assessment_reminder_recipient_admin ON performance_assessment_reminder_recipient WITH CHECK(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM performance_assessment_reminder_run r JOIN app_user u ON u.id=user_id AND u.tenant_id=r.tenant_id WHERE r.id=run_id AND r.tenant_id=performance_assessment_reminder_recipient.tenant_id AND (employment_id IS NULL OR EXISTS(SELECT 1 FROM app.onehr_employment e WHERE e.id=employment_id AND e.person_id=u.person_id AND e.tenant_id=u.tenant_id))) AND (source_event_id IS NULL OR EXISTS(SELECT 1 FROM domain_event ev WHERE ev.id=source_event_id AND ev.tenant_id=performance_assessment_reminder_recipient.tenant_id AND ev.aggregate_id=performance_assessment_reminder_recipient.id AND ev.event_type='assessment.reminder-queued')));
--> statement-breakpoint

-- ── 3b. onehr_cycle_admin: OneHR-native only for the partner (VF-06) ──────────────────────────────────
-- 0529's onehr_cycle_admin (59 call sites) never asked whether the cycle is OneHR-native; that was harmless
-- while every admitted actor also held generic performance authority. The partner does not, so for an actor
-- whose only qualifying grant is performance_partner the cycle must be OneHR-native. Everyone the pre-0611
-- set admitted (hr_admin, super_admin, performance_comp_partner — same live-grant and company/descendant
-- semantics) gets exactly the old answer.
CREATE FUNCTION app.onehr_admin_nonpartner(wanted_company uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app_user u JOIN role_assignment r ON r.app_user_id=u.id AND r.tenant_id=u.tenant_id
 WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
 AND r.role::text IN ('hr_admin','super_admin','performance_comp_partner') AND (r.company_id IS NULL OR wanted_company IS NOT NULL AND (r.company_id=wanted_company OR app.is_company_descendant(wanted_company,r.company_id))))
$$;
REVOKE ALL ON FUNCTION app.onehr_admin_nonpartner(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.onehr_cycle_admin(wanted_cycle uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM review_cycle c WHERE c.id=wanted_cycle AND c.tenant_id=app.current_tenant_id() AND app.onehr_admin(c.company_id)
  AND (app.onehr_admin_nonpartner(c.company_id)
   OR EXISTS(SELECT 1 FROM performance_onehr_cycle oc WHERE oc.cycle_id=c.id AND oc.tenant_id=c.tenant_id)))
$$;
--> statement-breakpoint

-- ── 4. review_cycle: lockable, never writable ─────────────────────────────────────────────────────────
-- review_cycle_read (0035) is already tenant-wide, so reads need nothing. The OneHR services take
-- `SELECT … FOR UPDATE` / `FOR NO KEY UPDATE` on the cycle row (admin-context.ts, participation-service.ts,
-- service.ts configureOnehrCycle), which requires the row to pass an UPDATE policy's USING; without this
-- policy the lock silently filters the row and every partner action reads "cycle not found". Limited to
-- OneHR-native cycles: a generic cycle is never lockable by this role, which also stops the partner from
-- converting a generic draft cycle into a OneHR one (configureOnehrCycle locks before it inserts).
CREATE POLICY review_cycle_onehr_partner_lock ON review_cycle FOR UPDATE
 USING (tenant_id = app.current_tenant_id() AND app.onehr_partner_for(company_id)
  AND EXISTS (SELECT 1 FROM performance_onehr_cycle oc WHERE oc.cycle_id = review_cycle.id AND oc.tenant_id = review_cycle.tenant_id))
 WITH CHECK (tenant_id = app.current_tenant_id() AND app.onehr_partner_for(company_id)
  AND EXISTS (SELECT 1 FROM performance_onehr_cycle oc WHERE oc.cycle_id = review_cycle.id AND oc.tenant_id = review_cycle.tenant_id));
--> statement-breakpoint
-- The policy above makes an UPDATE pass RLS; this trigger makes it fail. It refuses any ACTUAL change
-- (NEW IS DISTINCT FROM OLD) when the actor is a performance partner for the row and lacks the authority
-- review_cycle_write (0099) already demands — i.e. when the only reason the write passed RLS is this role.
-- HR administrators, perf-comp partners, owner-side scripts and session-less dispatchers are unaffected:
-- app.onehr_partner_for is false for them or the real authority holds. Row locks never fire it.
CREATE FUNCTION app.review_cycle_partner_write_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW IS DISTINCT FROM OLD
  AND (app.onehr_partner_for(OLD.company_id) OR app.onehr_partner_for(NEW.company_id))
  AND NOT (
   (CASE WHEN OLD.company_id IS NULL THEN app.is_group_admin() ELSE app.can_admin_perfcomp_for(OLD.company_id) END)
   AND (CASE WHEN NEW.company_id IS NULL THEN app.is_group_admin() ELSE app.can_admin_perfcomp_for(NEW.company_id) END)
  ) THEN
  RAISE EXCEPTION 'review cycle refused: a performance partner administers OneHR assessments but cannot change the review cycle (cycle %)', OLD.id
   USING ERRCODE = 'insufficient_privilege';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.review_cycle_partner_write_guard() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE TRIGGER review_cycle_partner_write_guard BEFORE UPDATE ON review_cycle FOR EACH ROW EXECUTE FUNCTION app.review_cycle_partner_write_guard();
--> statement-breakpoint
-- Creating a OneHR cycle stays with HR (ADR-0142 §4). onehr_cycle_insert (0529) admits any onehr_cycle_admin,
-- which now includes the partner; this RESTRICTIVE policy re-imposes review_cycle_write's own authority on
-- the INSERT that turns a cycle into a OneHR-native one. For every role that could already insert here the
-- predicate is the one review_cycle_write applied to the same row, so nothing they could do changes.
CREATE POLICY onehr_cycle_create_authority ON performance_onehr_cycle AS RESTRICTIVE FOR INSERT
 WITH CHECK (EXISTS (SELECT 1 FROM review_cycle c WHERE c.id = performance_onehr_cycle.cycle_id AND c.tenant_id = performance_onehr_cycle.tenant_id
  AND CASE WHEN c.company_id IS NULL THEN app.is_group_admin() ELSE app.can_admin_perfcomp_for(c.company_id) END));
--> statement-breakpoint

-- ── 5. Person labels: one projection, label columns only ──────────────────────────────────────────────
-- Returns ONLY full_name, preferred_name and employee_code (plus the ids that key them) for the requested
-- employments in the current tenant whose company the caller administers for OneHR (app.onehr_admin — HR
-- administrators, perf-comp partners and performance partners alike, live grant). Never DOB, address,
-- gender, marital status, contact details or anything else on person. OneHR administration readers use it
-- wherever the caller cannot read the person row (packs/performance/onehr/person-labels.ts); where the caller
-- can (HR), both sources are the same person row, so HR sees exactly the labels it saw before.
CREATE FUNCTION app.onehr_person_labels(employment_ids uuid[]) RETURNS TABLE(employment_id uuid, person_id uuid, full_name text, preferred_name text, employee_code text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT e.id, p.id, p.full_name, p.preferred_name, e.employee_code
 FROM employment e JOIN person p ON p.id = e.person_id AND p.tenant_id = e.tenant_id
 WHERE e.id = ANY(employment_ids) AND e.tenant_id = app.current_tenant_id() AND app.onehr_admin(e.company_id)
$$;
REVOKE ALL ON FUNCTION app.onehr_person_labels(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onehr_person_labels(uuid[]) TO ai_hr_app;
--> statement-breakpoint

-- ── 6. Role allow-lists (ADR-0142 §5) ─────────────────────────────────────────────────────────────────
-- 0312 layer 2: the invitable customer set. test/invitation-privesc.test.ts pins it to core/auth.ts ROLES.
ALTER TABLE app_invitation DROP CONSTRAINT app_invitation_role_customer_set;
--> statement-breakpoint
ALTER TABLE app_invitation
  ADD CONSTRAINT app_invitation_role_customer_set
  CHECK (role IN ('employee', 'manager', 'hr_admin', 'super_admin', 'payroll_partner', 'performance_comp_partner', 'performance_partner'));
--> statement-breakpoint
-- 0526: the manual-enrollment table's inline (unnamed) role CHECK. Its generated name is not something to
-- guess, so find the one CHECK that enumerates the roles and refuse unless there is exactly one.
DO $$
DECLARE n int; c text;
BEGIN
 SELECT count(*), min(conname) INTO n, c FROM pg_constraint
  WHERE conrelid = 'public.app_manual_identity_enrollment'::regclass AND contype = 'c'
   AND pg_get_constraintdef(oid) LIKE '%performance_comp_partner%';
 IF n <> 1 THEN RAISE EXCEPTION 'expected one role CHECK on app_manual_identity_enrollment, found %', n; END IF;
 EXECUTE format('ALTER TABLE public.app_manual_identity_enrollment DROP CONSTRAINT %I', c);
END;
$$;
--> statement-breakpoint
ALTER TABLE app_manual_identity_enrollment
  ADD CONSTRAINT app_manual_identity_enrollment_role_check
  CHECK (role IN ('employee','manager','hr_admin','super_admin','payroll_partner','performance_comp_partner','performance_partner'));
--> statement-breakpoint
-- 0526 manual_identity_reserve (latest definition: 0526:62-87), byte-for-byte except the role list.
CREATE OR REPLACE FUNCTION app.manual_identity_reserve(p_id uuid,p_issuer text,p_person uuid,p_username text,p_email text,p_role text,p_company uuid)
RETURNS SETOF public.app_manual_identity_enrollment
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v public.app_manual_identity_enrollment%ROWTYPE;
BEGIN
 IF NOT app.manual_identity_authorized(p_issuer) THEN RAISE EXCEPTION 'manual_identity_forbidden' USING ERRCODE='insufficient_privilege'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('manual-enrollment:'||p_id::text,0));
 SELECT * INTO v FROM public.app_manual_identity_enrollment e WHERE e.id=p_id FOR UPDATE;
 IF FOUND THEN
  IF (v.tenant_id,v.issuer,v.person_id,v.username,v.email,v.role,v.company_id)
   IS DISTINCT FROM (app.current_tenant_id(),p_issuer,p_person,p_username,p_email,p_role,p_company)
   OR v.status='cancelled' THEN RAISE EXCEPTION 'manual_identity_conflict'; END IF;
  RETURN NEXT v; RETURN;
 END IF;
 IF p_username !~ '^[a-z0-9][a-z0-9._@+-]{2,63}$' OR p_username LIKE 'service-account-%'
 OR length(p_email)>255 OR p_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
 OR p_email<>lower(p_email) OR p_role NOT IN ('employee','manager','hr_admin','super_admin','payroll_partner','performance_comp_partner','performance_partner')
 OR (p_role='super_admin' AND p_company IS NOT NULL) THEN RAISE EXCEPTION 'manual_identity_invalid'; END IF;
 PERFORM app.manual_identity_target(p_person,p_role,p_company);
 INSERT INTO public.app_manual_identity_enrollment(id,tenant_id,person_id,created_by,issuer,username,email,role,company_id)
 VALUES(p_id,app.current_tenant_id(),p_person,app.current_user_id(),p_issuer,p_username,p_email,p_role,p_company) RETURNING * INTO v;
 PERFORM app.append_auth_event(v.tenant_id,'app-user',v.id,'app-user.manual-enrollment-requested','user',app.current_user_id(),
  jsonb_build_object('personId',v.person_id,'role',v.role,'companyId',v.company_id,'ownershipAttested',true));
 RETURN NEXT v;
END;
$$;
REVOKE ALL ON FUNCTION app.manual_identity_reserve(uuid,text,uuid,text,text,text,uuid) FROM PUBLIC,ai_hr_app;
GRANT EXECUTE ON FUNCTION app.manual_identity_reserve(uuid,text,uuid,text,text,text,uuid) TO ai_hr_app;
--> statement-breakpoint
-- 0526 consume_invitation (latest definition: 0526:190-324), byte-for-byte except guard A's role list.
CREATE OR REPLACE FUNCTION app.consume_invitation(p_raw_token text, p_subject text)
  RETURNS TABLE (app_user_id uuid, tenant_id uuid)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_hash text := encode(sha256(convert_to(p_raw_token, 'UTF8')), 'hex');
  v_inv  public.app_invitation%ROWTYPE;
  v_user_id uuid;
  v_bound_subject text;
  v_logins int;
BEGIN
  -- Atomic single-use claim: only a still-pending, unexpired invitation flips to accepted; a concurrent
  -- second consume of the same token affects 0 rows and drops through to the NOT FOUND branch.
  UPDATE public.app_invitation
     SET status = 'accepted', accepted_at = now()
   WHERE token_hash = v_hash AND status = 'pending' AND expires_at > now()
  RETURNING * INTO v_inv;

  IF NOT FOUND THEN
    RETURN; -- unknown / already-consumed / expired token → 0 rows (caller throws InvalidInvitation)
  END IF;

  -- ── SLICE-0 GUARD A: the row's own shape ───────────────────────────────────────────────────────
  -- The last line of defence for a row that predates the WITH CHECK and the CHECK constraints above.
  -- ROW facts only (see this file's header for why inviter-context conjuncts cannot be re-checked
  -- here). Every RAISE aborts the transaction, so the `status = 'accepted'` flip above is rolled back
  -- too — a refused invitation is left pending rather than silently burned, and the refusal is
  -- visible in the log instead of manifesting as a mysterious missing grant.
  IF v_inv.role = 'operator' THEN
    RAISE EXCEPTION 'invitation refused: the operator role is not grantable by invitation (invitation %)', v_inv.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_inv.role NOT IN ('employee', 'manager', 'hr_admin', 'super_admin', 'payroll_partner', 'performance_comp_partner', 'performance_partner') THEN
    RAISE EXCEPTION 'invitation refused: % is not a valid customer role (invitation %)', v_inv.role, v_inv.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Mirrors 0020's role_assignment_super_admin_group_wide. Without this the row would still be refused
  -- — but 40 lines later, by that constraint, as an opaque 23514 from inside a definer function.
  IF v_inv.role = 'super_admin' AND v_inv.company_id IS NOT NULL THEN
    RAISE EXCEPTION 'invitation refused: super_admin is group-wide only, it cannot be scoped to a company (invitation %)', v_inv.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- The FK payloads must live in the invitation's own tenant (see 1a′). Still a pure ROW fact — it is a
  -- property of the rows this row points at, not of anybody's session — so it belongs in guard A.
  IF NOT app.invitation_refs_in_tenant(v_inv.tenant_id, v_inv.company_id, v_inv.person_id) THEN
    RAISE EXCEPTION 'invitation refused: it names a company or person outside its own tenant (invitation %)', v_inv.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Create or link the app_user for this subject. If a person was targeted and already has an app_user,
  -- attach the subject to it; otherwise insert a new one. workos_user_id is globally unique, so a subject
  -- already bound to another user makes this fail loudly (correct: one subject = one user).
  --
  -- WHICH LOGIN, EXACTLY. Nothing enforces one app_user per person — there is no unique index on
  -- (tenant_id, person_id) — and app_user's policy lets any group admin INSERT more. The original
  -- `LIMIT 1` with no ORDER BY therefore let an arbitrary row decide guard B's whole verdict
  -- (placeholder-or-not, grants-or-not), and a planted grant-less `seed:` twin could be made to win it.
  -- Two logins for one person is a state nobody should silently pick a winner in, so it is refused
  -- outright; the ORDER BY makes the single-row case deterministic rather than plan-dependent.
  IF v_inv.person_id IS NOT NULL THEN
    PERFORM 1 FROM public.person p WHERE p.id=v_inv.person_id AND p.tenant_id=v_inv.tenant_id FOR UPDATE;
    SELECT count(*) INTO v_logins
      FROM public.app_user u
     WHERE u.tenant_id = v_inv.tenant_id AND u.person_id = v_inv.person_id;
    IF v_logins > 1 THEN
      RAISE EXCEPTION 'invitation refused: that person has % logins, so there is no single login to activate (invitation %)', v_logins, v_inv.id
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- Aliased (u.) — an unqualified tenant_id here collides with the RETURNS TABLE OUT parameter.
    SELECT u.id, u.workos_user_id INTO v_user_id, v_bound_subject
      FROM public.app_user u
     WHERE u.tenant_id = v_inv.tenant_id AND u.person_id = v_inv.person_id
     ORDER BY u.created_at, u.id
     LIMIT 1;
  END IF;

  IF v_user_id IS NULL THEN
    INSERT INTO public.app_user (tenant_id, workos_user_id, person_id)
    VALUES (v_inv.tenant_id, p_subject, v_inv.person_id)
    RETURNING id INTO v_user_id;
  ELSIF v_bound_subject IS DISTINCT FROM p_subject THEN
    -- ── SLICE-0 GUARD B: the rebind is an ACTIVATION, never a takeover ───────────────────────────
    -- This branch re-points an existing login at whoever is holding the token. That is legitimate for
    -- a login created ahead of its human (provisioning, seed, bootstrap-invite) and it is an identity
    -- theft for any other. It is what closes hole (3) for EVERY inviter, including a group admin and
    -- including a row forged before layer 1 existed — the person-scope conjunct in the WITH CHECK
    -- narrows who can aim at whom, this decides whether the shot lands at all.
    --
    -- The ELSIF is the no-false-positive half: when the bound subject IS the accepter's, the UPDATE
    -- below would set the column to the value it already holds. Nothing is taken over, so nothing is
    -- refused — re-inviting an existing user (to add a second grant) is a live UI path and it worked
    -- before this migration. See this file's header.
    --
    -- TWO questions have to be asked, because "activated" and "carries authority" are NOT the same
    -- question and only the second one is about privilege:
    IF NOT app.is_placeholder_subject(v_bound_subject) THEN
      -- (i) IDENTITY. A non-placeholder subject means a real human has authenticated as this login;
      -- re-pointing it steals their identity and locks them out (their old subject then resolves to
      -- no row at all).
      RAISE EXCEPTION 'invitation refused: that person already has an activated login, which an invitation may not re-bind (invitation %)', v_inv.id
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.role_assignment ra
       WHERE ra.app_user_id = v_user_id
         AND NOT app.invitation_confers(v_inv.role, v_inv.company_id, ra.role::text, ra.company_id)
    ) THEN
      -- (ii) AUTHORITY, and this is the one a placeholder check alone gets WRONG. The grants are
      -- attached to the app_user BEFORE anyone authenticates as it, so "nobody has logged in yet"
      -- does not mean "there is nothing to steal": db/seed.ts:167 and test/operator-provision.test.ts
      -- both build `provision:<uuid>`/`user_dev_admin` logins that already carry a group-wide hr_admin.
      -- Without this conjunct a company-scoped hr_admin could write a wholly LEGITIMATE-looking
      -- invitation (role hr_admin, its own company, a person it administers — every layer-1 conjunct
      -- satisfied), consume it from a fresh subject, land on that pending admin's login and inherit
      -- its group-wide grant.
      --
      -- SUBSET, NOT EQUALITY — see app.invitation_confers above. The rebind is refused only when the
      -- login carries authority this invitation does not itself confer, which is a question about the
      -- ROLE LADDER and the SCOPE, not about tuple identity. "No grants at all" was rejected because it
      -- breaks scripts/auth/bootstrap-invite.ts, whose entire job is to rebind a SEEDED placeholder, and
      -- seeded placeholders carry grants (db/seed.ts:167 withRoleAssignment: true, :262-268, :493-499).
      -- Tuple EQUALITY was the same mistake one step smaller: it refused a login whose only grant was
      -- strictly weaker than the invitation's, which is precisely what those seeded logins carry.
      -- Anything the invitation confers, layer 1 already proved the inviter was allowed to write.
      RAISE EXCEPTION 'invitation refused: that login already carries a grant this invitation does not confer, so re-binding it would hand the accepter authority the inviter never had (invitation %)', v_inv.id
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    UPDATE public.app_user SET workos_user_id = p_subject WHERE id = v_user_id;
  END IF;

  INSERT INTO public.role_assignment (tenant_id, app_user_id, company_id, role)
  VALUES (v_inv.tenant_id, v_user_id, v_inv.company_id, v_inv.role::public.role);

  RETURN QUERY SELECT v_user_id, v_inv.tenant_id;
END;
$$;
--> statement-breakpoint
-- 0579 access_legacy_role_authority (latest definition: 0579:692-704), byte-for-byte except the role list.
-- It is the floor every role_assignment INSERT/UPDATE/DELETE and invitation acceptance re-checks, so
-- without the new label the role could be neither granted nor revoked from a session.
CREATE OR REPLACE FUNCTION app.access_legacy_role_authority(t uuid,u uuid,p_role text,p_company uuid,p_person uuid DEFAULT NULL) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.app_user a JOIN public.role_assignment r ON r.app_user_id=a.id AND r.tenant_id=a.tenant_id
  WHERE a.id=u AND a.tenant_id=t AND NOT app.login_blocked(a.id) AND NOT app.access_configuration_denied_for(t,u)
   AND (p_role IS NULL OR p_role IN ('employee','manager','hr_admin','super_admin','payroll_partner','performance_comp_partner','performance_partner'))
   AND (p_role IS DISTINCT FROM 'super_admin' OR p_company IS NULL)
   AND (r.role::text='super_admin' OR (r.role::text='hr_admin' AND r.company_id IS NULL)
    OR (r.role::text='hr_admin' AND p_role='hr_admin' AND p_company IS NOT NULL
     AND app.access_scope_covers(r.company_id,p_company,t)
     AND (p_person IS NULL OR EXISTS(SELECT 1 FROM public.employment e WHERE e.tenant_id=t AND e.person_id=p_person
      AND app.access_scope_covers(r.company_id,e.company_id,t)))))
 );
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_legacy_role_authority(uuid,uuid,text,uuid,uuid) FROM PUBLIC,ai_hr_app;

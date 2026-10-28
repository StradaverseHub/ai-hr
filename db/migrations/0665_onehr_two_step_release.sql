-- WP-E (CF-08, APR-021 / APR-022): two-step result release and the leader read.
--
-- Step 1 releases a person's final results to their leaders (line manager, HOD and business unit CEO) for
-- performance, potential and talent. Step 2 releases them to the person, and only for a component already
-- released to leaders. The 360 report stays a single step to the person. Business group CEOs and group
-- chiefs read the final result at once, as the source does.
--
-- One owner: performance_assessment_release keeps every release fact. Its only application writer stays the
-- release service (packs/performance/onehr/release-service.ts), which also mirrors the employee columns into
-- performance_onehr_result. Leader columns are never mirrored. The ordering rule (an employee release implies
-- a leader release, and step 1 cannot be revoked while step 2 stands) is enforced in that service under the
-- review lock (E-4); there is deliberately no CHECK.
--
-- Writers of performance_assessment_release reviewed: the release service (this package); the 0540 panel
-- trigger that clears feedback_released_at (feedback only, no leader column); the 0540 one-time copy (already
-- applied). No other writer exists.
--
-- Leader helpers B2 (0663) does not provide are added here: the viewer's leader role over a review, the step-1
-- reach of a review, and the read projections. Every helper takes the actor from app.current_user_id(),
-- checks tenant and a live login, and decides from explicit predicates. Seats, HOD assignments and calibration
-- group memberships are live on the Malaysia calendar day: valid_from <= today < valid_to.

-- ── 1. The leader step on the one release owner ────────────────────────────────────────────────────────
ALTER TABLE performance_assessment_release
 ADD COLUMN performance_leader_released_at timestamptz,
 ADD COLUMN potential_leader_released_at timestamptz,
 ADD COLUMN talent_leader_released_at timestamptz;
--> statement-breakpoint
-- Legacy rule (the source's): a release recorded before the leader step also counts as released to leaders.
-- The validation trigger re-checks updated_by against today's logins, which an archived releaser would fail;
-- this one-time backfill touches no identity or actor column, so the trigger is held for its duration only.
ALTER TABLE performance_assessment_release DISABLE TRIGGER assessment_release_validate;
--> statement-breakpoint
UPDATE performance_assessment_release SET
 performance_leader_released_at=coalesce(performance_leader_released_at,performance_released_at),
 potential_leader_released_at=coalesce(potential_leader_released_at,potential_released_at),
 talent_leader_released_at=coalesce(talent_leader_released_at,talent_released_at)
WHERE performance_released_at IS NOT NULL OR potential_released_at IS NOT NULL OR talent_released_at IS NOT NULL;
--> statement-breakpoint
ALTER TABLE performance_assessment_release ENABLE TRIGGER assessment_release_validate;
--> statement-breakpoint

-- ── 2. Release administration predicate (the assessment_release_admin policy, callable) ─────────────────
CREATE FUNCTION app.onehr_release_admin(wanted_review uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM performance_onehr_review r JOIN employment e ON e.id=r.employment_id AND e.tenant_id=r.tenant_id
  WHERE r.review_id=wanted_review AND r.tenant_id=app.current_tenant_id()
   AND app.onehr_cycle_admin(r.cycle_id) AND app.onehr_admin(e.company_id) AND NOT app.is_self_person(e.person_id))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.onehr_release_admin(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.onehr_release_admin(uuid) TO ai_hr_app;
--> statement-breakpoint

-- ── 3. Release notice ledger: who was told about which component at which step. Append-only ────────────
-- A (review, component, step, recipient) is told once, ever: the row survives a revoke, so a revoke and
-- re-release tells nobody again (the source's release-email ledger). The row carries no band.
CREATE TABLE performance_assessment_release_notice (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenant(id),
 review_id uuid NOT NULL REFERENCES performance_onehr_review(review_id),
 component text NOT NULL CHECK (component IN ('performance','potential','talent','feedback')),
 step text NOT NULL CHECK (step IN ('leaders','person')),
 recipient_employment_id uuid NOT NULL REFERENCES employment(id),
 event_id uuid NOT NULL,
 notified_by uuid NOT NULL REFERENCES app_user(id),
 notified_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT performance_assessment_release_notice_once UNIQUE (review_id, component, step, recipient_employment_id),
 CONSTRAINT performance_assessment_release_notice_feedback CHECK (step='person' OR component<>'feedback')
);
--> statement-breakpoint
CREATE INDEX performance_assessment_release_notice_recipient_idx ON performance_assessment_release_notice (recipient_employment_id);
--> statement-breakpoint
ALTER TABLE performance_assessment_release_notice ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE performance_assessment_release_notice FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON performance_assessment_release_notice FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON performance_assessment_release_notice TO ai_hr_app;
--> statement-breakpoint
CREATE POLICY assessment_release_notice_read ON performance_assessment_release_notice FOR SELECT
 USING (tenant_id=app.current_tenant_id() AND app.onehr_release_admin(review_id));
--> statement-breakpoint
CREATE POLICY assessment_release_notice_insert ON performance_assessment_release_notice FOR INSERT
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.onehr_release_admin(review_id));
--> statement-breakpoint
CREATE FUNCTION app.assessment_release_notice_validate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Release notices are append-only'; END IF;
 IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NEW.notified_by IS DISTINCT FROM app.current_user_id()
  OR NOT EXISTS(SELECT 1 FROM performance_onehr_review r WHERE r.review_id=NEW.review_id AND r.tenant_id=NEW.tenant_id)
  OR NOT EXISTS(SELECT 1 FROM employment e WHERE e.id=NEW.recipient_employment_id AND e.tenant_id=NEW.tenant_id) THEN
  RAISE EXCEPTION 'Invalid release notice'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER assessment_release_notice_validate BEFORE INSERT OR UPDATE OR DELETE ON performance_assessment_release_notice FOR EACH ROW EXECUTE FUNCTION app.assessment_release_notice_validate();
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.assessment_release_notice_validate() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint

-- ── 4. Who leads a person: the viewer's leader role over one review ─────────────────────────────────────
-- Strongest first, as the source resolves it: business group CEO, group chief, business unit CEO, HOD, line
-- manager. Seats anchor on the review's company (B2: a unit is a company, a business group is its group node,
-- a group chief anchors on the person's live calibration group). Never the person themself. An administrator
-- is not a leader by being an administrator: administrators read results through their own projections.
CREATE FUNCTION app.onehr_leader_role(wanted_review uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH today AS (SELECT (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AS d),
 me AS (SELECT u.id,u.person_id,u.tenant_id FROM app_user u
  WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)),
 mine AS (SELECT e.id FROM employment e JOIN me ON e.person_id=me.person_id AND e.tenant_id=me.tenant_id CROSS JOIN today
  WHERE e.terminated_on IS NULL OR e.terminated_on>today.d),
 r AS (SELECT o.review_id,o.employment_id,o.company_id,o.tenant_id FROM performance_onehr_review o
  JOIN employment s ON s.id=o.employment_id AND s.tenant_id=o.tenant_id JOIN me ON me.tenant_id=o.tenant_id
  WHERE o.review_id=wanted_review AND s.person_id<>me.person_id)
 SELECT CASE
  WHEN EXISTS(SELECT 1 FROM r CROSS JOIN today JOIN performance_leader_seat st ON st.tenant_id=r.tenant_id AND st.seat_type='bg_ceo'
   AND st.company_id=app.onehr_business_group_node(r.company_id) AND st.valid_from<=today.d AND (st.valid_to IS NULL OR st.valid_to>today.d)
   WHERE st.holder_employment_id IN (SELECT id FROM mine)) THEN 'bg'
  WHEN EXISTS(SELECT 1 FROM r CROSS JOIN today JOIN performance_calibration_group_member m ON m.tenant_id=r.tenant_id AND m.employment_id=r.employment_id
   AND m.valid_from<=today.d AND (m.valid_to IS NULL OR m.valid_to>today.d)
   JOIN performance_calibration_group g ON g.id=m.group_id AND g.tenant_id=m.tenant_id AND g.retired_at IS NULL
   JOIN performance_leader_seat st ON st.tenant_id=r.tenant_id AND st.seat_type='group_chief' AND st.calibration_group_id=g.id
   AND st.valid_from<=today.d AND (st.valid_to IS NULL OR st.valid_to>today.d)
   WHERE st.holder_employment_id IN (SELECT id FROM mine)) THEN 'group'
  WHEN EXISTS(SELECT 1 FROM r CROSS JOIN today JOIN performance_leader_seat st ON st.tenant_id=r.tenant_id AND st.seat_type='bu_ceo'
   AND st.company_id=r.company_id AND st.valid_from<=today.d AND (st.valid_to IS NULL OR st.valid_to>today.d)
   WHERE st.holder_employment_id IN (SELECT id FROM mine)) THEN 'bu'
  WHEN EXISTS(SELECT 1 FROM r CROSS JOIN today JOIN performance_hod_assignment h ON h.tenant_id=r.tenant_id AND h.subject_employment_id=r.employment_id
   AND h.valid_from<=today.d AND (h.valid_to IS NULL OR h.valid_to>today.d)
   WHERE h.hod_employment_id IN (SELECT id FROM mine)) THEN 'hod'
  WHEN EXISTS(SELECT 1 FROM r) AND app.onehr_manager(wanted_review) THEN 'lm'
 END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.onehr_leader_role(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.onehr_leader_role(uuid) TO ai_hr_app;
--> statement-breakpoint

-- ── 5. Step-1 reach: the leaders release 1 goes to, today ───────────────────────────────────────────────
-- Line manager (the review's reviewer), HOD (live assignment) and business unit CEO (live seat on the review's
-- company). Live employments with a live login only; never the person's own person. Release administrators
-- only (the release page names them and the notices go to them).
CREATE FUNCTION app.onehr_release_leaders(wanted_reviews uuid[]) RETURNS TABLE(review_id uuid, leader_role text, employment_id uuid, full_name text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH today AS (SELECT (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AS d),
 r AS (SELECT o.review_id,o.employment_id,o.company_id,o.tenant_id,s.person_id AS subject_person,p.reviewer_employment_id
  FROM performance_onehr_review o JOIN employment s ON s.id=o.employment_id AND s.tenant_id=o.tenant_id
  JOIN performance_review p ON p.id=o.review_id AND p.tenant_id=o.tenant_id
  WHERE o.review_id=ANY(wanted_reviews) AND o.tenant_id=app.current_tenant_id() AND app.onehr_release_admin(o.review_id)),
 reach AS (
  SELECT r.review_id,'lm'::text AS leader_role,r.reviewer_employment_id AS employment_id,r.subject_person,r.tenant_id FROM r WHERE r.reviewer_employment_id IS NOT NULL
  UNION ALL
  SELECT r.review_id,'hod',h.hod_employment_id,r.subject_person,r.tenant_id FROM r CROSS JOIN today JOIN performance_hod_assignment h ON h.tenant_id=r.tenant_id
   AND h.subject_employment_id=r.employment_id AND h.valid_from<=today.d AND (h.valid_to IS NULL OR h.valid_to>today.d)
  UNION ALL
  SELECT r.review_id,'bu',st.holder_employment_id,r.subject_person,r.tenant_id FROM r CROSS JOIN today JOIN performance_leader_seat st ON st.tenant_id=r.tenant_id
   AND st.seat_type='bu_ceo' AND st.company_id=r.company_id AND st.valid_from<=today.d AND (st.valid_to IS NULL OR st.valid_to>today.d))
 SELECT x.review_id,x.leader_role,x.employment_id,p.full_name FROM reach x CROSS JOIN today JOIN employment e ON e.id=x.employment_id AND e.tenant_id=x.tenant_id
 JOIN person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
 WHERE e.person_id<>x.subject_person AND (e.terminated_on IS NULL OR e.terminated_on>today.d)
  AND EXISTS(SELECT 1 FROM app_user u WHERE u.person_id=e.person_id AND u.tenant_id=e.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id))
 ORDER BY x.review_id,array_position(ARRAY['lm','hod','bu'],x.leader_role),x.employment_id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.onehr_release_leaders(uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.onehr_release_leaders(uuid[]) TO ai_hr_app;
--> statement-breakpoint
-- Step-2 reach: the person, while employed and with a live login (leavers are told nothing).
CREATE FUNCTION app.onehr_release_people(wanted_reviews uuid[]) RETURNS TABLE(review_id uuid, employment_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT o.review_id,o.employment_id FROM performance_onehr_review o JOIN employment e ON e.id=o.employment_id AND e.tenant_id=o.tenant_id
 WHERE o.review_id=ANY(wanted_reviews) AND o.tenant_id=app.current_tenant_id() AND app.onehr_release_admin(o.review_id)
  AND (e.terminated_on IS NULL OR e.terminated_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
  AND EXISTS(SELECT 1 FROM app_user u WHERE u.person_id=e.person_id AND u.tenant_id=e.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id))
 ORDER BY o.review_id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.onehr_release_people(uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.onehr_release_people(uuid[]) TO ai_hr_app;
--> statement-breakpoint
-- The business group CEO's own moves (a non-pinned band changed at the business group tier), for the business
-- unit CEO's notice count. Review ids only; release administrators only.
CREATE FUNCTION app.onehr_bg_moved(wanted_reviews uuid[]) RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT DISTINCT e.review_id FROM performance_onehr_calibration_entry e JOIN performance_onehr_calibration s ON s.id=e.session_id AND s.tenant_id=e.tenant_id
 WHERE e.review_id=ANY(wanted_reviews) AND e.tenant_id=app.current_tenant_id() AND s.tier='bg' AND app.onehr_release_admin(e.review_id)
  AND ((e.performance IS NOT NULL AND NOT e.performance_pinned AND e.performance IS DISTINCT FROM e.original_performance)
   OR (e.potential IS NOT NULL AND NOT e.potential_pinned AND e.potential IS DISTINCT FROM e.original_potential))
 ORDER BY 1
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.onehr_bg_moved(uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.onehr_bg_moved(uuid[]) TO ai_hr_app;
--> statement-breakpoint

-- ── 6. Frozen-result masking for readers outside the person's own projection (E-1) ──────────────────────
-- Which frozen components the caller may read: a cycle administrator every one (as onehr_result_read admits);
-- a leader a component only once it is released to leaders, except business group CEOs and group chiefs, who
-- read it at once. Anyone else, and the person themself, none (the person reads onehr_result_card).
-- onehr_result_read is deliberately unchanged: frozen-guards in the services read the row under the manager's RLS.
CREATE FUNCTION app.onehr_frozen_visible(wanted_review uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH r AS (SELECT o.review_id,o.cycle_id,o.tenant_id,app.is_self_person(e.person_id) AS own FROM performance_onehr_review o
  JOIN employment e ON e.id=o.employment_id AND e.tenant_id=o.tenant_id WHERE o.review_id=wanted_review AND o.tenant_id=app.current_tenant_id()),
 v AS (SELECT r.review_id,r.tenant_id,NOT r.own AND app.onehr_cycle_admin(r.cycle_id) AS admin,CASE WHEN r.own THEN NULL ELSE app.onehr_leader_role(r.review_id) END AS leader FROM r)
 SELECT jsonb_build_object(
  'performance',coalesce(v.admin OR v.leader IN ('bg','group') OR v.leader IS NOT NULL AND rel.performance_leader_released_at IS NOT NULL,false),
  'potential',coalesce(v.admin OR v.leader IN ('bg','group') OR v.leader IS NOT NULL AND rel.potential_leader_released_at IS NOT NULL,false),
  'talent',coalesce(v.admin OR v.leader IN ('bg','group') OR v.leader IS NOT NULL AND rel.talent_leader_released_at IS NOT NULL,false))
 FROM v LEFT JOIN performance_assessment_release rel ON rel.review_id=v.review_id AND rel.tenant_id=v.tenant_id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.onehr_frozen_visible(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.onehr_frozen_visible(uuid) TO ai_hr_app;
--> statement-breakpoint

-- ── 7. The leader read: one person's band movement, cut at the leader's own step until release 1 ────────
-- Per axis, steps self → line manager → HOD → BU CEO → BG CEO → group chief → HR (the last two only where they
-- decided). Before release 1 a line manager, HOD or BU CEO reads up to their own step; later steps come back
-- 'hidden' with no band and no reason, and there is no final band. At Mid-Year the chain ends at the HOD and a
-- BU CEO reads up to it. After release 1, and always for a BG CEO or group chief, the whole chain and the final
-- band. Each visible step from the HOD up carries that tier's recorded reason (E-2, as the source does). An axis
-- with no result has nothing in calibration, so its steps show as they stand. Self and line-manager bands come
-- from the rating record (0540), tiers from confirmed calibration entries, the final band from the frozen result
-- or the working result. Never returned: rater identities, scores, counts or 360 rows.
CREATE FUNCTION app.onehr_leader_result(wanted_review uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE leader text; r performance_onehr_review; mid boolean; rel performance_assessment_release; f performance_onehr_result; snap jsonb; outcome jsonb;
 counted boolean; axis text; axes jsonb:='[]'::jsonb; upto text; fully boolean; hidden boolean; before text; steps jsonb; s record; st text; final_band text;
 released boolean; self_pot text; pct numeric; w numeric; talent_open boolean; all_full boolean:=true;
BEGIN
 leader:=app.onehr_leader_role(wanted_review);
 IF leader IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO r FROM performance_onehr_review WHERE review_id=wanted_review AND tenant_id=app.current_tenant_id();
 SELECT coalesce(c.policy->>'kind','year_end')='mid_year' INTO mid FROM performance_onehr_cycle c WHERE c.cycle_id=r.cycle_id AND c.tenant_id=r.tenant_id;
 SELECT * INTO rel FROM performance_assessment_release WHERE review_id=r.review_id AND tenant_id=r.tenant_id;
 SELECT * INTO f FROM performance_onehr_result WHERE review_id=r.review_id AND tenant_id=r.tenant_id;
 -- The participation snapshot alone (app.assessment_review_participates also asks whether the caller can see
 -- the person, which a seat holder need not): a person taken out of the cycle has no working result to read.
 SELECT EXISTS(SELECT 1 FROM performance_review pr JOIN review_cycle c ON c.id=pr.cycle_id AND c.tenant_id=pr.tenant_id
  JOIN employment e ON e.id=pr.employment_id AND e.tenant_id=pr.tenant_id
  JOIN performance_assessment_participation p ON p.cycle_id=pr.cycle_id AND p.employment_id=pr.employment_id AND p.tenant_id=pr.tenant_id
  WHERE pr.id=r.review_id AND pr.tenant_id=r.tenant_id
   AND (c.status='closed' OR e.terminated_on IS NULL OR e.terminated_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
   AND CASE WHEN p.override='add' THEN true WHEN p.override='remove' THEN false ELSE p.eligible_at_open END) INTO counted;
 IF f.id IS NULL AND NOT counted THEN
  RETURN jsonb_build_object('role',leader,'midYear',mid,'frozen',false,'axes','[]'::jsonb,'talent',NULL);
 END IF;
 SELECT snapshot INTO snap FROM performance_assessment_rating_record WHERE review_id=r.review_id AND tenant_id=r.tenant_id;
 outcome:=CASE WHEN f.id IS NOT NULL THEN f.result ELSE app.assessment_working_result(r.review_id) END;
 -- Self potential, from the recorded 360 percentage and the person's own competency answers (model.potential).
 w:=coalesce((snap->'configuration'->>'weight360')::numeric,10000);
 IF coalesce((snap->>'valid')::boolean,false) AND snap->>'potential360Pct' IS NOT NULL AND snap->>'competencySelf' IS NOT NULL AND coalesce((snap->>'competencyMax')::numeric,0)>0 THEN
  pct:=CASE WHEN w<10000 THEN ((snap->>'potential360Pct')::numeric*w+100*(snap->>'competencySelf')::numeric/(snap->>'competencyMax')::numeric*(10000-w))/10000 ELSE (snap->>'potential360Pct')::numeric END;
  self_pot:=CASE WHEN pct<=(snap->'configuration'->>'lowMaxPct')::numeric THEN 'Low' WHEN pct<=(snap->'configuration'->>'midMaxPct')::numeric THEN 'Mid' ELSE 'High' END;
 END IF;
 upto:=CASE leader WHEN 'lm' THEN 'lm' WHEN 'hod' THEN 'hod' WHEN 'bu' THEN CASE WHEN mid THEN 'hod' ELSE 'bu' END END;
 FOREACH axis IN ARRAY ARRAY['performance','potential'] LOOP
  final_band:=outcome->>axis;
  released:=CASE axis WHEN 'performance' THEN rel.performance_leader_released_at IS NOT NULL ELSE rel.potential_leader_released_at IS NOT NULL END;
  fully:=leader IN ('bg','group') OR coalesce(released,false) OR final_band IS NULL;
  IF final_band IS NOT NULL AND NOT fully THEN all_full:=false; END IF;
  hidden:=false; before:=NULL; steps:='[]'::jsonb;
  FOR s IN
   SELECT q.tier,q.ord,q.band,q.why FROM (
    SELECT 'self'::text AS tier,1 AS ord,CASE axis WHEN 'performance' THEN snap->>'selfBand' ELSE self_pot END AS band,''::text AS why
    UNION ALL
    SELECT 'lm',2,CASE axis WHEN 'performance' THEN r.manager_performance
     ELSE CASE WHEN coalesce((snap->>'valid')::boolean,false) AND coalesce(snap->>'competencyStatus','reviewed')='reviewed' THEN snap->>'computedPotential' END END,''
    UNION ALL
    SELECT t.tier,t.ord,(SELECT CASE axis WHEN 'performance' THEN ce.performance ELSE ce.potential END
      FROM performance_onehr_calibration_entry ce JOIN performance_onehr_calibration cs ON cs.id=ce.session_id AND cs.tenant_id=ce.tenant_id
      WHERE ce.review_id=r.review_id AND ce.tenant_id=r.tenant_id AND cs.tier=t.tier AND NOT (cs.tier='group' AND cs.mode='blend')
       AND (cs.tier='final' OR CASE axis WHEN 'performance' THEN app.assessment_calibration_axis_confirmed(cs.tier,ce.performance_locked_at,cs.performance_locked_at)
        ELSE app.assessment_calibration_axis_confirmed(cs.tier,ce.potential_locked_at,cs.potential_locked_at) END)
      ORDER BY ce.id LIMIT 1),
     coalesce((SELECT CASE axis WHEN 'performance' THEN ce.performance_note ELSE ce.potential_note END
      FROM performance_onehr_calibration_entry ce JOIN performance_onehr_calibration cs ON cs.id=ce.session_id AND cs.tenant_id=ce.tenant_id
      WHERE ce.review_id=r.review_id AND ce.tenant_id=r.tenant_id AND cs.tier=t.tier AND NOT (cs.tier='group' AND cs.mode='blend')
      ORDER BY ce.id LIMIT 1),'')
    FROM (VALUES ('hod',3),('bu',4),('bg',5),('group',6),('final',7)) t(tier,ord)
   ) q ORDER BY q.ord
  LOOP
   IF mid AND s.tier IN ('bu','bg','group') THEN CONTINUE; END IF;
   IF s.tier IN ('group','final') AND (s.band IS NULL OR hidden) THEN CONTINUE; END IF;
   IF hidden THEN
    steps:=steps||jsonb_build_object('tier',s.tier,'band',NULL,'state','hidden','why','');
    CONTINUE;
   END IF;
   st:=CASE WHEN s.band IS NULL THEN 'none' WHEN before IS NULL THEN 'set' WHEN s.band=before THEN 'kept' ELSE 'moved' END;
   steps:=steps||jsonb_build_object('tier',s.tier,'band',s.band,'state',st,'why',CASE WHEN s.tier IN ('self','lm') OR s.band IS NULL THEN '' ELSE btrim(coalesce(s.why,'')) END);
   before:=coalesce(s.band,before);
   IF NOT fully AND upto=s.tier THEN hidden:=true; END IF;
  END LOOP;
  axes:=axes||jsonb_build_array(jsonb_build_object('axis',axis,'steps',steps,'final',CASE WHEN fully THEN final_band END,'full',fully,'hasResult',final_band IS NOT NULL));
 END LOOP;
 talent_open:=leader IN ('bg','group') OR rel.talent_leader_released_at IS NOT NULL OR all_full;
 RETURN jsonb_build_object('role',leader,'midYear',mid,'frozen',f.id IS NOT NULL,'axes',axes,'talent',CASE WHEN talent_open THEN outcome->>'talent' END);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.onehr_leader_result(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.onehr_leader_result(uuid) TO ai_hr_app;
--> statement-breakpoint

-- ── 8. What you led: the people a leader is over in one cycle, one tab per seat ─────────────────────────
-- Tabs, narrowest first: direct reports (line manager), department (HOD), business unit (BU CEO seats),
-- calibration group (group chief seats), business group (BG CEO seat). A person can sit in several tabs; the
-- row's reading is the strongest role (app.onehr_leader_result). Never the viewer and never a leaver.
-- Internal: reached through app.onehr_led_people and app.onehr_led_cycles only.
CREATE FUNCTION app.onehr_led_tabs(wanted_cycle uuid) RETURNS TABLE(review_id uuid, tabs text[]) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH today AS (SELECT (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AS d),
 me AS (SELECT u.id,u.person_id,u.tenant_id FROM app_user u
  WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)),
 mine AS (SELECT e.id FROM employment e JOIN me ON e.person_id=me.person_id AND e.tenant_id=me.tenant_id CROSS JOIN today
  WHERE e.terminated_on IS NULL OR e.terminated_on>today.d),
 r AS (SELECT o.review_id,o.employment_id,o.company_id,o.tenant_id FROM performance_onehr_review o
  JOIN employment s ON s.id=o.employment_id AND s.tenant_id=o.tenant_id JOIN me ON me.tenant_id=o.tenant_id CROSS JOIN today
  WHERE o.cycle_id=wanted_cycle AND s.person_id<>me.person_id AND (s.terminated_on IS NULL OR s.terminated_on>today.d)),
 tabbed AS (
  SELECT r.review_id,'direct'::text AS tab FROM r WHERE app.onehr_manager(r.review_id)
  UNION ALL
  SELECT r.review_id,'dept' FROM r CROSS JOIN today JOIN performance_hod_assignment h ON h.tenant_id=r.tenant_id AND h.subject_employment_id=r.employment_id
   AND h.valid_from<=today.d AND (h.valid_to IS NULL OR h.valid_to>today.d) WHERE h.hod_employment_id IN (SELECT id FROM mine)
  UNION ALL
  SELECT r.review_id,'bu' FROM r CROSS JOIN today JOIN performance_leader_seat st ON st.tenant_id=r.tenant_id AND st.seat_type='bu_ceo' AND st.company_id=r.company_id
   AND st.valid_from<=today.d AND (st.valid_to IS NULL OR st.valid_to>today.d) WHERE st.holder_employment_id IN (SELECT id FROM mine)
  UNION ALL
  SELECT r.review_id,'group' FROM r CROSS JOIN today JOIN performance_calibration_group_member m ON m.tenant_id=r.tenant_id AND m.employment_id=r.employment_id
   AND m.valid_from<=today.d AND (m.valid_to IS NULL OR m.valid_to>today.d)
   JOIN performance_calibration_group g ON g.id=m.group_id AND g.tenant_id=m.tenant_id AND g.retired_at IS NULL
   JOIN performance_leader_seat st ON st.tenant_id=r.tenant_id AND st.seat_type='group_chief' AND st.calibration_group_id=g.id
   AND st.valid_from<=today.d AND (st.valid_to IS NULL OR st.valid_to>today.d) WHERE st.holder_employment_id IN (SELECT id FROM mine)
  UNION ALL
  SELECT r.review_id,'bg' FROM r CROSS JOIN today JOIN performance_leader_seat st ON st.tenant_id=r.tenant_id AND st.seat_type='bg_ceo'
   AND st.company_id=app.onehr_business_group_node(r.company_id) AND st.valid_from<=today.d AND (st.valid_to IS NULL OR st.valid_to>today.d)
   WHERE st.holder_employment_id IN (SELECT id FROM mine))
 SELECT t.review_id,array_agg(DISTINCT t.tab ORDER BY t.tab) FROM tabbed t GROUP BY t.review_id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.onehr_led_tabs(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Each led person with the labels the list shows (name, code, department, grade, company), the release dates
-- and the leader read. Labels are returned only for people the viewer leads.
CREATE FUNCTION app.onehr_led_people(wanted_cycle uuid) RETURNS TABLE(review_id uuid, tabs text[], full_name text, employee_code text, department text, grade text, company text, leaders_at timestamptz, released_at timestamptz, chain jsonb)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT o.review_id,t.tabs,p.full_name,e.employee_code,
  (SELECT d.name FROM assignment a JOIN department d ON d.id=a.department_id AND d.tenant_id=a.tenant_id
   WHERE a.employment_id=e.id AND a.tenant_id=e.tenant_id AND a.superseded_at IS NULL AND a.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
    AND (a.valid_to IS NULL OR a.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
   ORDER BY a.valid_from DESC,a.id LIMIT 1),
  o.grade,c.legal_name,
  LEAST(rel.performance_leader_released_at,rel.potential_leader_released_at,rel.talent_leader_released_at),
  LEAST(rel.performance_released_at,rel.potential_released_at,rel.talent_released_at),
  app.onehr_leader_result(o.review_id)
 FROM app.onehr_led_tabs(wanted_cycle) t JOIN performance_onehr_review o ON o.review_id=t.review_id AND o.tenant_id=app.current_tenant_id()
 JOIN employment e ON e.id=o.employment_id AND e.tenant_id=o.tenant_id JOIN person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
 LEFT JOIN company c ON c.id=o.company_id AND c.tenant_id=o.tenant_id
 LEFT JOIN performance_assessment_release rel ON rel.review_id=o.review_id AND rel.tenant_id=o.tenant_id
 WHERE app.onehr_leader_role(o.review_id) IS NOT NULL
 ORDER BY p.full_name,o.review_id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.onehr_led_people(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.onehr_led_people(uuid) TO ai_hr_app;
--> statement-breakpoint
-- The OneHR cycles (not draft) in which the viewer leads anyone, newest first, with how many.
CREATE FUNCTION app.onehr_led_cycles() RETURNS TABLE(cycle_id uuid, name text, period_end date, status text, people integer)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT c.id,c.name,c.period_end,c.status::text,q.people FROM review_cycle c
 JOIN performance_onehr_cycle oc ON oc.cycle_id=c.id AND oc.tenant_id=c.tenant_id
 CROSS JOIN LATERAL (SELECT count(*)::integer AS people FROM app.onehr_led_tabs(c.id)) q
 WHERE c.tenant_id=app.current_tenant_id() AND c.status<>'draft' AND q.people>0
 ORDER BY c.period_end DESC,c.id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.onehr_led_cycles() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.onehr_led_cycles() TO ai_hr_app;

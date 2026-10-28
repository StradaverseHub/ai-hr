-- WP-A3 (APR-022 (4)): leader status data for the home cards. Data only; the cards are drawn elsewhere.
--
-- app.onehr_leader_status(cycle) answers, for the viewer's highest live seat, where that seat's people stand in
-- one cycle. Counts, states, Malaysia calendar dates and aggregate band counts only: never a review, employment or
-- person id, never a person's name, a per-person band, a score, note or amount. Labels are company and department names.
--
-- Seat precedence (the source's dashboard rule, highest seat wins): business group CEO, then group chief, then
-- business unit CEO, then HOD. Seats (0663) and HOD assignments are live on the Malaysia calendar day:
-- valid_from <= today < valid_to. A person is never counted in their own leader's status.
--
-- While the cycle runs (open, calibration):
--  * BU CEO, per unit seat: people; departments (the distinct live HODs of those people); per axis the unit's
--    BU-tier lock date, else ready (every department review in on that axis), else waiting, with N of M
--    department reviews in; each department's two review dates. Mid-Year: one department-review count.
--  * BG CEO, per business unit of the group node: people; locked (every BG-tier entry of the unit locked, the
--    Talent Box lock), ready (both BU-tier axes locked), else calibrating with N of M department reviews in
--    (both axes). Mid-Year: department reviews in.
--  * Group chief, per batch (the membership segment, else the person's department): people; locked (every
--    member's group-tier call locked), ready (every member has the line manager's confirmed band), else
--    calibrating with n of m confirmed. Mid-Year: department reviews in.
--  * HOD: nothing (the department review stays a task row).
-- Between cycles (closed): per component, people with a final band released to the viewer and still waiting,
-- and the band tally as the source's dashboard counts it: aggregate counts per band over released people only
-- (HOD: performance; BU CEO: performance, potential and talent status). Only a BU CEO or HOD seat is tallied
-- (BU CEO first), also for a viewer who is BG CEO or group chief too; only people already released to leaders
-- (release 1, 0665's *_leader_released_at) are counted, the rest are "waiting" and add to no band count, except
-- people the viewer reads at once (their own business group as BG CEO; as group chief, performance and
-- potential). A BG CEO or group chief with neither seat gets no tally, as in the source: only how many people
-- they led. Never a per-person band or a name-band pair.
--
-- The definer projection is needed because calibration rows are readable only through
-- app.onehr_calibration_access: a seat holder cannot read another tier's sessions under RLS.

-- ── 1. Internal helpers (no app privilege) ─────────────────────────────────────────────────────────────
-- The cycle's counted people, never the caller's own person: a frozen result, or the participation snapshot
-- (as app.onehr_leader_result decides it; a leaver of a running cycle drops out).
CREATE FUNCTION app.onehr_leader_status_people(wanted_cycle uuid) RETURNS TABLE(review_id uuid, employment_id uuid, company_id uuid, manager_performance text)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT o.review_id,o.employment_id,o.company_id,o.manager_performance
 FROM performance_onehr_review o JOIN review_cycle c ON c.id=o.cycle_id AND c.tenant_id=o.tenant_id
 JOIN employment s ON s.id=o.employment_id AND s.tenant_id=o.tenant_id
 WHERE o.cycle_id=wanted_cycle AND o.tenant_id=app.current_tenant_id() AND NOT app.is_self_person(s.person_id)
  AND (EXISTS(SELECT 1 FROM performance_onehr_result f WHERE f.review_id=o.review_id AND f.tenant_id=o.tenant_id)
   OR EXISTS(SELECT 1 FROM performance_assessment_participation p WHERE p.cycle_id=o.cycle_id AND p.employment_id=o.employment_id AND p.tenant_id=o.tenant_id
    AND (c.status='closed' OR s.terminated_on IS NULL OR s.terminated_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
    AND CASE WHEN p.override='add' THEN true WHEN p.override='remove' THEN false ELSE p.eligible_at_open END))
$$;
--> statement-breakpoint
-- An employment's current department name (the label the department list shows).
CREATE FUNCTION app.onehr_leader_status_department(wanted_employment uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT d.name FROM assignment a JOIN department d ON d.id=a.department_id AND d.tenant_id=a.tenant_id
 WHERE a.employment_id=wanted_employment AND a.tenant_id=app.current_tenant_id() AND a.superseded_at IS NULL
  AND a.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (a.valid_to IS NULL OR a.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
 ORDER BY a.valid_from DESC,a.id LIMIT 1
$$;
--> statement-breakpoint
-- The department reviews over some people: one row per distinct live HOD, with the HOD's department name and
-- the dates their anchored HOD-tier review locked each axis in the cycle. The HOD id never leaves the definer.
CREATE FUNCTION app.onehr_leader_status_depts(wanted_cycle uuid, wanted_employments uuid[]) RETURNS TABLE(hod uuid, name text, performance_on date, potential_on date)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH today AS (SELECT (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AS d),
 h AS (SELECT DISTINCT a.hod_employment_id AS hod FROM performance_hod_assignment a CROSS JOIN today
  WHERE a.tenant_id=app.current_tenant_id() AND a.subject_employment_id=ANY(wanted_employments) AND a.valid_from<=today.d AND (a.valid_to IS NULL OR a.valid_to>today.d))
 SELECT h.hod,app.onehr_leader_status_department(h.hod),
  (coalesce(s.performance_locked_at,s.locked_at) AT TIME ZONE 'Asia/Kuala_Lumpur')::date,
  (coalesce(s.potential_locked_at,s.locked_at) AT TIME ZONE 'Asia/Kuala_Lumpur')::date
 FROM h LEFT JOIN LATERAL (SELECT c.performance_locked_at,c.potential_locked_at,c.locked_at FROM performance_onehr_calibration c
  WHERE c.tenant_id=app.current_tenant_id() AND c.cycle_id=wanted_cycle AND c.tier='hod' AND c.anchor_kind='hod' AND c.anchor_employment_id=h.hod
  ORDER BY c.created_at,c.id LIMIT 1) s ON true
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.onehr_leader_status_people(uuid),app.onehr_leader_status_department(uuid),app.onehr_leader_status_depts(uuid,uuid[]) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint

-- ── 2. The leader status ───────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION app.onehr_leader_status(wanted_cycle uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE today date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date; viewer app_user; cyc review_cycle; mid boolean; running boolean;
 mine uuid[]; bg_nodes uuid[]; group_ids uuid[]; unit_ids uuid[]; heads boolean; seat text; scope uuid[]; status_json jsonb;
 u record; n integer; unit_emps uuid[]; lock_pm date; lock_pot date; depts jsonb; n_depts integer; in_pm integer; in_pot integer; in_both integer; cards jsonb:='[]'::jsonb;
BEGIN
 SELECT * INTO viewer FROM app_user WHERE id=app.current_user_id() AND tenant_id=app.current_tenant_id() AND archived_at IS NULL AND NOT app.login_blocked(id);
 IF viewer.id IS NULL OR viewer.person_id IS NULL THEN RETURN NULL; END IF;
 SELECT c.* INTO cyc FROM review_cycle c WHERE c.id=wanted_cycle AND c.tenant_id=viewer.tenant_id AND c.status<>'draft'
  AND EXISTS(SELECT 1 FROM performance_onehr_cycle oc WHERE oc.cycle_id=c.id AND oc.tenant_id=c.tenant_id);
 IF cyc.id IS NULL THEN RETURN NULL; END IF;
 SELECT coalesce(oc.policy->>'kind','year_end')='mid_year' INTO mid FROM performance_onehr_cycle oc WHERE oc.cycle_id=cyc.id AND oc.tenant_id=cyc.tenant_id;
 running:=cyc.status IN ('open','calibration');

 -- The viewer's live employments and live seats, today.
 SELECT coalesce(array_agg(e.id),'{}') INTO mine FROM employment e
 WHERE e.person_id=viewer.person_id AND e.tenant_id=viewer.tenant_id AND (e.terminated_on IS NULL OR e.terminated_on>today);
 SELECT coalesce(array_agg(DISTINCT st.company_id) FILTER (WHERE st.seat_type='bg_ceo'),'{}'),
  coalesce(array_agg(DISTINCT st.calibration_group_id) FILTER (WHERE st.seat_type='group_chief' AND g.id IS NOT NULL),'{}'),
  coalesce(array_agg(DISTINCT st.company_id) FILTER (WHERE st.seat_type='bu_ceo'),'{}')
 INTO bg_nodes,group_ids,unit_ids
 FROM performance_leader_seat st LEFT JOIN performance_calibration_group g ON g.id=st.calibration_group_id AND g.tenant_id=st.tenant_id AND g.retired_at IS NULL
 WHERE st.tenant_id=viewer.tenant_id AND st.holder_employment_id=ANY(mine) AND st.valid_from<=today AND (st.valid_to IS NULL OR st.valid_to>today);
 heads:=EXISTS(SELECT 1 FROM performance_hod_assignment h WHERE h.tenant_id=viewer.tenant_id AND h.hod_employment_id=ANY(mine)
  AND h.valid_from<=today AND (h.valid_to IS NULL OR h.valid_to>today));
 seat:=CASE WHEN cardinality(bg_nodes)>0 THEN 'bg' WHEN cardinality(group_ids)>0 THEN 'group' WHEN cardinality(unit_ids)>0 THEN 'bu' WHEN heads THEN 'hod' END;
 IF seat IS NULL OR running AND seat='hod' THEN RETURN NULL; END IF;
 -- Between cycles the source's "What you led" tallies only a BU CEO or HOD seat (BU CEO first), whatever else the
 -- viewer holds; a BG CEO or group chief with neither gets a record without a tally.
 IF NOT running AND (cardinality(unit_ids)>0 OR heads) THEN seat:=CASE WHEN cardinality(unit_ids)>0 THEN 'bu' ELSE 'hod' END; END IF;

 -- The seat's people in this cycle.
 SELECT coalesce(array_agg(p.review_id ORDER BY p.review_id),'{}') INTO scope FROM app.onehr_leader_status_people(cyc.id) p
 WHERE CASE seat
  WHEN 'bg' THEN app.onehr_business_group_node(p.company_id)=ANY(bg_nodes)
  WHEN 'group' THEN EXISTS(SELECT 1 FROM performance_calibration_group_member m WHERE m.tenant_id=viewer.tenant_id AND m.employment_id=p.employment_id
   AND m.group_id=ANY(group_ids) AND m.valid_from<=today AND (m.valid_to IS NULL OR m.valid_to>today))
  WHEN 'bu' THEN p.company_id=ANY(unit_ids)
  ELSE EXISTS(SELECT 1 FROM performance_hod_assignment h WHERE h.tenant_id=viewer.tenant_id AND h.subject_employment_id=p.employment_id
   AND h.hod_employment_id=ANY(mine) AND h.valid_from<=today AND (h.valid_to IS NULL OR h.valid_to>today)) END;

 -- Between cycles, a BG CEO or group chief without a BU CEO or HOD seat: no tally, only how many they led.
 IF NOT running AND seat IN ('bg','group') THEN
  RETURN jsonb_build_object('seat',seat,'mode','record','cycleId',cyc.id,'midYear',mid,'gated',false,'people',cardinality(scope));
 END IF;

 -- Between cycles: the BU CEO's or HOD's tally. As the source's dash_led and _dash_band_tally: the release gate is
 -- off for people in the viewer's own business group (a BG CEO reads them at once), and a performance or potential
 -- band is also counted at once for a person the viewer calls as group chief. Everyone else counts only once
 -- released to leaders. Band counts are aggregates over the people counted as released only.
 IF NOT running THEN
  WITH p AS (SELECT x.review_id,x.employment_id,x.company_id,
    app.onehr_business_group_node(x.company_id)=ANY(bg_nodes) AS own_group,
    EXISTS(SELECT 1 FROM performance_calibration_group_member m WHERE m.tenant_id=viewer.tenant_id AND m.employment_id=x.employment_id
     AND m.group_id=ANY(group_ids) AND m.valid_from<=today AND (m.valid_to IS NULL OR m.valid_to>today)) AS called
   FROM app.onehr_leader_status_people(cyc.id) x WHERE x.review_id=ANY(scope)),
  r AS (SELECT p.employment_id,p.own_group,coalesce(f.result,app.assessment_working_result(p.review_id)) AS outcome,
    rel.performance_leader_released_at IS NOT NULL OR p.own_group OR p.called AS pm_open,
    rel.potential_leader_released_at IS NOT NULL OR p.own_group OR p.called AS pot_open,
    rel.talent_leader_released_at IS NOT NULL OR p.own_group AS talent_open
   FROM p LEFT JOIN performance_onehr_result f ON f.review_id=p.review_id AND f.tenant_id=viewer.tenant_id
   LEFT JOIN performance_assessment_release rel ON rel.review_id=p.review_id AND rel.tenant_id=viewer.tenant_id)
  SELECT jsonb_build_object('seat',seat,'mode','record','cycleId',cyc.id,'midYear',mid,'gated',NOT CASE WHEN seat='bu' THEN (SELECT bool_and(app.onehr_business_group_node(c.id)=ANY(bg_nodes)) FROM unnest(unit_ids) AS c(id))
    ELSE coalesce(bool_and(r.own_group),false) END,'people',count(*),
   'performance',jsonb_build_object('released',count(*) FILTER (WHERE r.outcome->>'performance' IS NOT NULL AND r.pm_open),'waiting',count(*) FILTER (WHERE r.outcome->>'performance' IS NOT NULL AND NOT r.pm_open),
    'bands',(SELECT jsonb_agg(jsonb_build_object('band',v.band,'n',(SELECT count(*) FROM r q WHERE q.pm_open AND q.outcome->>'performance'=v.band)) ORDER BY v.ord)
     FROM unnest(ARRAY['UA','BE','ME','AE','OU']) WITH ORDINALITY v(band,ord))),
   'potential',jsonb_build_object('released',count(*) FILTER (WHERE r.outcome->>'potential' IS NOT NULL AND r.pot_open),'waiting',count(*) FILTER (WHERE r.outcome->>'potential' IS NOT NULL AND NOT r.pot_open),
    'bands',CASE WHEN seat='bu' THEN (SELECT jsonb_agg(jsonb_build_object('band',v.band,'n',(SELECT count(*) FROM r q WHERE q.pot_open AND q.outcome->>'potential'=v.band)) ORDER BY v.ord)
     FROM unnest(ARRAY['Low','Mid','High']) WITH ORDINALITY v(band,ord)) END),
   'talent',jsonb_build_object('released',count(*) FILTER (WHERE r.outcome->>'talent' IS NOT NULL AND r.talent_open),'waiting',count(*) FILTER (WHERE r.outcome->>'talent' IS NOT NULL AND NOT r.talent_open),
    'bands',CASE WHEN seat='bu' THEN (SELECT coalesce(jsonb_agg(jsonb_build_object('band',t.band,'n',t.n) ORDER BY t.ord),'[]'::jsonb) FROM (
      SELECT v.band,v.ord,(SELECT count(*) FROM r q WHERE q.talent_open AND q.outcome->>'talent'=v.band) AS n
      FROM unnest(ARRAY['Super Star','Star','Solid Core','PIP/Improvement']) WITH ORDINALITY v(band,ord)) t WHERE t.n>0) END),
   'departmentReviews',CASE WHEN seat='bu' THEN (SELECT jsonb_build_object('in',count(*) FILTER (WHERE d.performance_on IS NOT NULL),'of',count(*))
    FROM app.onehr_leader_status_depts(cyc.id,(SELECT coalesce(array_agg(q.employment_id),'{}') FROM p q)) d) END)
  INTO status_json FROM r;
  RETURN status_json;
 END IF;

 -- While the cycle runs: the BU CEO's units, each with its axes and department list.
 IF seat='bu' THEN
  FOR u IN SELECT c.id,c.legal_name FROM company c WHERE c.id=ANY(unit_ids) AND c.tenant_id=viewer.tenant_id ORDER BY lower(c.legal_name),c.id LOOP
   SELECT count(*),coalesce(array_agg(x.employment_id),'{}') INTO n,unit_emps FROM app.onehr_leader_status_people(cyc.id) x WHERE x.review_id=ANY(scope) AND x.company_id=u.id;
   lock_pm:=NULL; lock_pot:=NULL;
   SELECT (coalesce(s.performance_locked_at,s.locked_at) AT TIME ZONE 'Asia/Kuala_Lumpur')::date,(coalesce(s.potential_locked_at,s.locked_at) AT TIME ZONE 'Asia/Kuala_Lumpur')::date
   INTO lock_pm,lock_pot FROM performance_onehr_calibration s
   WHERE s.tenant_id=viewer.tenant_id AND s.cycle_id=cyc.id AND s.tier='bu' AND s.company_id=u.id ORDER BY (s.anchor_kind IS NULL),s.created_at,s.id LIMIT 1;
   SELECT coalesce(jsonb_agg(jsonb_build_object('name',d.name,'performanceInOn',d.performance_on,'potentialInOn',d.potential_on)
     ORDER BY (d.performance_on IS NOT NULL)::int+(d.potential_on IS NOT NULL)::int,lower(coalesce(d.name,'')),d.hod),'[]'::jsonb),
    count(*),count(*) FILTER (WHERE d.performance_on IS NOT NULL),count(*) FILTER (WHERE d.potential_on IS NOT NULL),
    count(*) FILTER (WHERE d.performance_on IS NOT NULL AND d.potential_on IS NOT NULL)
   INTO depts,n_depts,in_pm,in_pot,in_both FROM app.onehr_leader_status_depts(cyc.id,unit_emps) d;
   cards:=cards||jsonb_build_array(jsonb_build_object('companyId',u.id,'label',u.legal_name,'people',n,'departments',n_depts,
    'state',CASE WHEN lock_pm IS NOT NULL AND lock_pot IS NOT NULL THEN 'locked' WHEN lock_pm IS NOT NULL OR lock_pot IS NOT NULL THEN 'part' ELSE 'open' END,
    'axes',CASE WHEN mid THEN jsonb_build_array(jsonb_build_object('axis','departmentReviews','state',CASE WHEN in_both=n_depts THEN 'ready' ELSE 'waiting' END,'lockedOn',NULL,'in',in_both,'of',n_depts))
     ELSE jsonb_build_array(
      jsonb_build_object('axis','performance','state',CASE WHEN lock_pm IS NOT NULL THEN 'locked' WHEN in_pm=n_depts THEN 'ready' ELSE 'waiting' END,'lockedOn',lock_pm,'in',in_pm,'of',n_depts),
      jsonb_build_object('axis','potential','state',CASE WHEN lock_pot IS NOT NULL THEN 'locked' WHEN in_pot=n_depts THEN 'ready' ELSE 'waiting' END,'lockedOn',lock_pot,'in',in_pot,'of',n_depts)) END,
    'depts',depts));
  END LOOP;
  RETURN jsonb_build_object('seat','bu','mode','running','cycleId',cyc.id,'midYear',mid,'units',cards);
 END IF;

 -- The BG CEO's business units, or the group chief's batches: one row each, ready first, then calibrating, then locked.
 IF seat='bg' THEN
  WITH p AS (SELECT x.* FROM app.onehr_leader_status_people(cyc.id) x WHERE x.review_id=ANY(scope)),
  g AS (SELECT p.company_id,count(*)::integer AS people,array_agg(p.employment_id) AS member_emps FROM p GROUP BY p.company_id),
  x AS (SELECT g.company_id,c.legal_name AS label,g.people,coalesce(tb.locked,false) AS tb_locked,tb.locked_on AS tb_on,bu.pm_on,bu.pot_on,dr.in_,dr.of_
   FROM g JOIN company c ON c.id=g.company_id AND c.tenant_id=viewer.tenant_id
   LEFT JOIN LATERAL (SELECT count(*)>0 AND bool_and(e.locked_at IS NOT NULL OR s.locked_at IS NOT NULL) AS locked,
     max((coalesce(e.locked_at,s.locked_at) AT TIME ZONE 'Asia/Kuala_Lumpur')::date) AS locked_on
    FROM performance_onehr_calibration_entry e JOIN performance_onehr_calibration s ON s.id=e.session_id AND s.tenant_id=e.tenant_id
    JOIN performance_onehr_review o ON o.review_id=e.review_id AND o.tenant_id=e.tenant_id
    WHERE s.tenant_id=viewer.tenant_id AND s.cycle_id=cyc.id AND s.tier='bg' AND o.company_id=g.company_id AND e.review_id=ANY(scope)) tb ON true
   LEFT JOIN LATERAL (SELECT (coalesce(s.performance_locked_at,s.locked_at) AT TIME ZONE 'Asia/Kuala_Lumpur')::date AS pm_on,
     (coalesce(s.potential_locked_at,s.locked_at) AT TIME ZONE 'Asia/Kuala_Lumpur')::date AS pot_on
    FROM performance_onehr_calibration s WHERE s.tenant_id=viewer.tenant_id AND s.cycle_id=cyc.id AND s.tier='bu' AND s.company_id=g.company_id
    ORDER BY (s.anchor_kind IS NULL),s.created_at,s.id LIMIT 1) bu ON true
   LEFT JOIN LATERAL (SELECT count(*) FILTER (WHERE d.performance_on IS NOT NULL AND d.potential_on IS NOT NULL)::integer AS in_,count(*)::integer AS of_
    FROM app.onehr_leader_status_depts(cyc.id,g.member_emps) d) dr ON true),
  status_rows AS (SELECT x.company_id,x.label,x.people,x.in_,x.of_,
    CASE WHEN mid THEN CASE WHEN x.in_=x.of_ THEN 'ready' ELSE 'calibrating' END
     WHEN x.tb_locked THEN 'locked' WHEN x.pm_on IS NOT NULL AND x.pot_on IS NOT NULL THEN 'ready' ELSE 'calibrating' END AS state,
    CASE WHEN mid THEN NULL WHEN x.tb_locked THEN x.tb_on WHEN x.pm_on IS NOT NULL AND x.pot_on IS NOT NULL THEN greatest(x.pm_on,x.pot_on) END AS locked_on
   FROM x)
  SELECT jsonb_build_object('seat','bg','mode','running','cycleId',cyc.id,'midYear',mid,
   'ready',count(*) FILTER (WHERE r.state='ready'),'locked',count(*) FILTER (WHERE r.state='locked'),'total',count(*),
   'rows',coalesce(jsonb_agg(jsonb_build_object('companyId',r.company_id,'label',r.label,'people',r.people,'state',r.state,'lockedOn',r.locked_on,'in',r.in_,'of',r.of_)
    ORDER BY array_position(ARRAY['ready','calibrating','locked'],r.state),lower(r.label),r.company_id),'[]'::jsonb))
  INTO status_json FROM status_rows r;
  RETURN status_json;
 END IF;

 WITH p AS (SELECT x.* FROM app.onehr_leader_status_people(cyc.id) x WHERE x.review_id=ANY(scope)),
 m AS (SELECT p.employment_id,p.manager_performance,coalesce(nullif(btrim(gm.segment),''),app.onehr_leader_status_department(p.employment_id)) AS batch,lk.locked_on
  FROM p LEFT JOIN LATERAL (SELECT q.segment FROM performance_calibration_group_member q WHERE q.tenant_id=viewer.tenant_id AND q.employment_id=p.employment_id
    AND q.group_id=ANY(group_ids) AND q.valid_from<=today AND (q.valid_to IS NULL OR q.valid_to>today) ORDER BY q.valid_from DESC,q.id LIMIT 1) gm ON true
  LEFT JOIN LATERAL (SELECT max((coalesce(e.performance_locked_at,s.performance_locked_at,e.locked_at,s.locked_at) AT TIME ZONE 'Asia/Kuala_Lumpur')::date) AS locked_on
    FROM performance_onehr_calibration_entry e JOIN performance_onehr_calibration s ON s.id=e.session_id AND s.tenant_id=e.tenant_id
    WHERE e.review_id=p.review_id AND e.tenant_id=viewer.tenant_id AND s.cycle_id=cyc.id AND s.tier='group'
     AND (e.performance_locked_at IS NOT NULL OR s.performance_locked_at IS NOT NULL OR e.locked_at IS NOT NULL OR s.locked_at IS NOT NULL)) lk ON true),
 b AS (SELECT m.batch,count(*)::integer AS people,count(*) FILTER (WHERE m.manager_performance IS NOT NULL)::integer AS confirmed,
   bool_and(m.locked_on IS NOT NULL) AS all_locked,max(m.locked_on) AS locked_on,array_agg(m.employment_id) AS member_emps FROM m GROUP BY m.batch),
 x AS (SELECT b.*,dr.in_,dr.of_ FROM b LEFT JOIN LATERAL (SELECT count(*) FILTER (WHERE d.performance_on IS NOT NULL AND d.potential_on IS NOT NULL)::integer AS in_,count(*)::integer AS of_
   FROM app.onehr_leader_status_depts(cyc.id,b.member_emps) d WHERE mid) dr ON true),
 status_rows AS (SELECT x.batch,x.people,
   CASE WHEN mid THEN x.in_ ELSE x.confirmed END AS in_,CASE WHEN mid THEN x.of_ ELSE x.people END AS of_,
   CASE WHEN mid THEN CASE WHEN x.in_=x.of_ THEN 'ready' ELSE 'calibrating' END
    WHEN x.all_locked THEN 'locked' WHEN x.confirmed=x.people THEN 'ready' ELSE 'calibrating' END AS state,
   CASE WHEN NOT mid AND x.all_locked THEN x.locked_on END AS locked_on FROM x)
 SELECT jsonb_build_object('seat','group','mode','running','cycleId',cyc.id,'midYear',mid,
  'ready',count(*) FILTER (WHERE r.state='ready'),'locked',count(*) FILTER (WHERE r.state='locked'),'total',count(*),
  'rows',coalesce(jsonb_agg(jsonb_build_object('label',r.batch,'people',r.people,'state',r.state,'lockedOn',r.locked_on,'in',r.in_,'of',r.of_)
   ORDER BY array_position(ARRAY['ready','calibrating','locked'],r.state),lower(coalesce(r.batch,'')),r.batch NULLS LAST),'[]'::jsonb))
 INTO status_json FROM status_rows r;
 RETURN status_json;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.onehr_leader_status(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.onehr_leader_status(uuid) TO ai_hr_app;

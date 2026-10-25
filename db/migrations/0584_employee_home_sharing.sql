-- Shared fact readers for the purpose-bound Home sharing projection. These two functions are
-- INVOKER readers: their normal callers retain exactly the existing table RLS, including an owner's
-- explicit maintenance access. They do not grant peer personnel, leave reason or compensation access.
-- Keep dated-company proof and child-date/whole-span leave presence authoritative in one place.
CREATE FUNCTION app.proven_company_date_points(p_points jsonb)
 RETURNS TABLE(employment_id uuid,on_date date,company_id uuid,reason text)
 LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH requested AS (
  SELECT DISTINCT r."employmentId" AS employment_id,r.date AS on_date
  FROM jsonb_to_recordset(p_points) AS r("employmentId" uuid,date date)
 ), facts AS (
  SELECT r.employment_id,r.on_date,e.id AS visible_employment,e.hired_on,e.terminated_on,
   count(a.id) AS applicable_count,max(a.company_id::text)::uuid AS applicable_company
  FROM requested r LEFT JOIN public.employment e ON e.id=r.employment_id
  LEFT JOIN public.assignment a ON a.employment_id=e.id AND a.superseded_at IS NULL
   AND a.valid_from<=r.on_date AND (a.valid_to IS NULL OR a.valid_to>r.on_date)
  GROUP BY r.employment_id,r.on_date,e.id,e.hired_on,e.terminated_on
 )
 SELECT f.employment_id,f.on_date,
  CASE WHEN f.visible_employment IS NOT NULL AND f.on_date>=f.hired_on
   AND (f.terminated_on IS NULL OR f.on_date<=f.terminated_on)
   AND f.applicable_count=1 THEN f.applicable_company ELSE NULL END,
  CASE WHEN f.visible_employment IS NULL THEN 'employment_unavailable'
   WHEN f.on_date<f.hired_on OR f.on_date>f.terminated_on THEN 'outside_tenure'
   WHEN f.applicable_count>1 THEN 'assignment_ambiguous'
   WHEN f.applicable_count<>1 OR f.applicable_company IS NULL THEN 'assignment_missing'
   ELSE NULL END
 FROM facts f ORDER BY f.employment_id,f.on_date;
$$;
REVOKE ALL ON FUNCTION app.proven_company_date_points(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.proven_company_date_points(jsonb) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.leave_calendar_presence(p_employment_ids jsonb,p_from date,p_to date,p_status text)
 RETURNS TABLE(employment_id uuid,on_date date,presence text)
 LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH requested AS (
  SELECT DISTINCT value::uuid AS employment_id FROM jsonb_array_elements_text(p_employment_ids) AS ids(value)
 ), dates AS (
  -- Per-date status is authoritative whenever a request has child dates. A parent header must not
  -- restore a cancelled child, or hide an individually approved child behind a different header state.
  SELECT r.employment_id,d.leave_date AS on_date,r.duration_type::text='full_day' AS full_day
  FROM public.leave_request_date d JOIN public.leave_request r ON r.id=d.leave_request_id
  JOIN requested wanted ON wanted.employment_id=r.employment_id
  WHERE d.status::text=p_status AND d.leave_date BETWEEN p_from AND p_to
   AND p_status IN ('approved','pending')
  UNION ALL
  -- Only requests with no child rows use the legacy whole-span contract.
  SELECT r.employment_id,day.value::date AS on_date,r.duration_type::text='full_day' AS full_day
  FROM public.leave_request r JOIN requested wanted ON wanted.employment_id=r.employment_id
  CROSS JOIN LATERAL generate_series(greatest(r.start_date,p_from)::timestamp,
   least(r.end_date,p_to)::timestamp,interval '1 day') AS day(value)
  WHERE r.status::text=p_status AND r.start_date<=p_to AND r.end_date>=p_from
   AND p_status IN ('approved','pending')
   AND NOT EXISTS(SELECT 1 FROM public.leave_request_date child WHERE child.leave_request_id=r.id)
 )
 SELECT d.employment_id,d.on_date,CASE WHEN bool_or(d.full_day) THEN 'full_day' ELSE 'part_day' END
 FROM dates d GROUP BY d.employment_id,d.on_date ORDER BY d.employment_id,d.on_date;
$$;
REVOKE ALL ON FUNCTION app.leave_calendar_presence(jsonb,date,date,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.leave_calendar_presence(jsonb,date,date,text) TO ai_hr_app;
--> statement-breakpoint
-- One Home role resolver, shared by the shell and the purpose-bound readers below. The explicit
-- visibility predicates preserve the existing reports projection even inside a definer call; merely
-- switching to its owner must not turn a future/unreadable reporting edge into a Manager policy.
CREATE FUNCTION app.own_home_dashboard_role(p_employment uuid) RETURNS text
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN app.is_admin_for(proof.company_id) THEN 'hr_admin'
  WHEN app.has_role_for('manager',proof.company_id) OR EXISTS(
   SELECT 1 FROM public.reporting_line r JOIN public.employment report ON report.id=r.subordinate_employment_id
    JOIN public.person subject ON subject.id=report.person_id
   WHERE r.manager_employment_id=e.id AND r.tenant_id=e.tenant_id AND report.tenant_id=e.tenant_id
    AND subject.tenant_id=e.tenant_id AND r.valid_to IS NULL AND r.superseded_at IS NULL
    AND r.line_type::text<>'delegate' AND app.can_see_employment(report.id) AND app.can_see_person(subject.id)
  ) THEN 'manager' ELSE 'employee' END
 FROM public.employment e JOIN public.app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id
 CROSS JOIN LATERAL app.proven_company_date_points(jsonb_build_array(jsonb_build_object(
  'employmentId',e.id,'date',(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date))) proof
 WHERE e.id=p_employment AND e.tenant_id=app.current_tenant_id() AND u.id=app.current_user_id()
  AND app.principal_snapshot_current() AND app.is_self_person(e.person_id);
$$;
REVOKE ALL ON FUNCTION app.own_home_dashboard_role(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.own_home_dashboard_role(uuid) TO ai_hr_app;
--> statement-breakpoint
-- Private authority facts: no posted company, role, department or sharing scope can choose a policy.
-- A missing/bad sharing field stays off; no default or schema rollout enables peer disclosure.
CREATE FUNCTION app._home_peer_policy(p_employment uuid,p_purpose text)
 RETURNS TABLE(viewer_person_id uuid,company_id uuid,department_id uuid,sharing_scope text)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT e.person_id,proof.company_id,d.id,
  CASE WHEN p_purpose='team' AND configuration.configuration->>'teamVisibility' IN ('direct','department')
    THEN configuration.configuration->>'teamVisibility'
   WHEN p_purpose='celebration' AND configuration.configuration->'celebrations'->'enabled'='true'::jsonb
    AND configuration.configuration->'celebrations'->>'scope' IN ('direct','department')
    THEN configuration.configuration->'celebrations'->>'scope'
   ELSE 'off' END
 FROM public.employment e JOIN public.app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id
 CROSS JOIN LATERAL app.proven_company_date_points(jsonb_build_array(jsonb_build_object(
  'employmentId',e.id,'date',(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date))) proof
 JOIN public.company c ON c.id=proof.company_id AND c.tenant_id=e.tenant_id AND c.archived_at IS NULL
 JOIN public.assignment a ON a.employment_id=e.id AND a.tenant_id=e.tenant_id AND a.company_id=proof.company_id
  AND a.superseded_at IS NULL AND a.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
  AND (a.valid_to IS NULL OR a.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
 LEFT JOIN public.department d ON d.id=a.department_id AND d.tenant_id=e.tenant_id
  AND d.company_id=proof.company_id AND d.archived_at IS NULL
 LEFT JOIN LATERAL (
  SELECT v.configuration FROM public.employee_home_configuration_revision v
  WHERE v.tenant_id=e.tenant_id AND v.company_id=proof.company_id
   AND v.audience_role=app.own_home_dashboard_role(e.id) AND v.configuration->'version'='1'::jsonb
  ORDER BY v.ordinal DESC LIMIT 1
 ) configuration ON true
 WHERE e.id=p_employment AND e.tenant_id=app.current_tenant_id() AND u.id=app.current_user_id()
  AND app.principal_snapshot_current() AND app.is_self_person(e.person_id) AND proof.reason IS NULL
  AND p_purpose IN ('team','celebration') AND e.blacklisted_at IS NULL
  AND e.hired_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
  AND (LEAST(e.resignation_date,e.last_working_date,e.terminated_on) IS NULL
   OR LEAST(e.resignation_date,e.last_working_date,e.terminated_on)>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date);
$$;
REVOKE ALL ON FUNCTION app._home_peer_policy(uuid,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- This is a current sharing cohort, not Personnel/My Team access or historical org reconstruction.
-- Direct follows the published Home setting: manager, people sharing a manager, and direct reports.
CREATE FUNCTION app._home_peer_cohort(p_employment uuid,p_purpose text)
 RETURNS TABLE(employment_id uuid,person_id uuid,display_name text)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH today AS (SELECT (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AS d),
 policy AS MATERIALIZED (SELECT * FROM app._home_peer_policy(p_employment,p_purpose)),
 lines AS MATERIALIZED (
  SELECT r.subordinate_employment_id,r.manager_employment_id FROM public.reporting_line r,today
  WHERE r.tenant_id=app.current_tenant_id() AND r.line_type='administrative' AND r.superseded_at IS NULL
   AND r.valid_from<=today.d AND (r.valid_to IS NULL OR r.valid_to>today.d)
 ), candidate_ids AS (
  SELECT line.manager_employment_id AS id FROM lines line,policy p
   WHERE p.sharing_scope='direct' AND line.subordinate_employment_id=p_employment
  UNION
  SELECT line.subordinate_employment_id FROM lines line,policy p
   WHERE p.sharing_scope='direct' AND line.manager_employment_id=p_employment
  UNION
  SELECT peer.subordinate_employment_id FROM lines mine JOIN lines peer ON peer.manager_employment_id=mine.manager_employment_id,policy p
   WHERE p.sharing_scope='direct' AND mine.subordinate_employment_id=p_employment
  UNION
  SELECT a.employment_id FROM public.assignment a,policy p,today
   WHERE p.sharing_scope='department' AND p.department_id IS NOT NULL AND a.department_id=p.department_id
    AND a.tenant_id=app.current_tenant_id() AND a.superseded_at IS NULL
    AND a.valid_from<=today.d AND (a.valid_to IS NULL OR a.valid_to>today.d)
 )
 SELECT e.id,e.person_id,coalesce(nullif(btrim(person.preferred_name),''),nullif(btrim(person.first_name),''),nullif(btrim(person.full_name),''))
 FROM candidate_ids candidate JOIN public.employment e ON e.id=candidate.id
 JOIN public.person person ON person.id=e.person_id AND person.tenant_id=e.tenant_id
 CROSS JOIN policy p CROSS JOIN today
 CROSS JOIN LATERAL app.proven_company_date_points(jsonb_build_array(jsonb_build_object('employmentId',e.id,'date',today.d))) proof
 WHERE e.tenant_id=app.current_tenant_id() AND e.person_id<>p.viewer_person_id AND proof.reason IS NULL
  AND proof.company_id=p.company_id AND e.blacklisted_at IS NULL AND e.hired_on<=today.d
  AND (LEAST(e.resignation_date,e.last_working_date,e.terminated_on) IS NULL
   OR LEAST(e.resignation_date,e.last_working_date,e.terminated_on)>=today.d)
 ORDER BY coalesce(nullif(btrim(person.preferred_name),''),nullif(btrim(person.first_name),''),nullif(btrim(person.full_name),'')),e.id;
$$;
REVOKE ALL ON FUNCTION app._home_peer_cohort(uuid,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- FORCE RLS must not hide a peer's opt-out from the restricted migration/function owner. This
-- SELECT-only policy is available to the table owner, never to the application role. The public
-- projections below still prove the actual login, tenant, company, role and current cohort first.
CREATE POLICY employee_home_person_privacy_projection_owner ON public.employee_home_person_privacy_revision FOR SELECT
 USING(tenant_id=app.current_tenant_id() AND (SELECT app.principal_snapshot_current())
  AND current_user=pg_get_userbyid((SELECT relowner FROM pg_class
   WHERE oid='public.employee_home_person_privacy_revision'::regclass)));
--> statement-breakpoint
-- A page of employment presence, not Personnel access. A missing leave fact is unknown; it never
-- asserts that someone is in the office, clocked in or working from home. Counts cover the whole
-- currently allowed cohort rather than the first page. An invalidated cursor requires a fresh read.
CREATE FUNCTION app.home_team_page(p_employment uuid,p_date date,p_after uuid DEFAULT NULL,p_limit integer DEFAULT 20)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE policy_scope text; result jsonb;
BEGIN
 IF p_date IS NULL OR p_limit IS NULL OR p_limit<1 OR p_limit>50 THEN
  RAISE EXCEPTION 'Invalid Home sharing page' USING ERRCODE='22023';
 END IF;
 SELECT sharing_scope INTO policy_scope FROM app._home_peer_policy(p_employment,'team');
 IF NOT FOUND THEN RAISE EXCEPTION 'Home context unavailable' USING ERRCODE='42501';END IF;
 IF policy_scope='off' THEN
  RETURN jsonb_build_object('scope','off','date',p_date::text,'totalEmployments',0,'items','[]'::jsonb,'nextCursor',NULL);
 END IF;
 IF p_after IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app._home_peer_cohort(p_employment,'team') WHERE employment_id=p_after) THEN
  RAISE EXCEPTION 'Home sharing page changed; reload' USING ERRCODE='42501';
 END IF;
 WITH cohort AS MATERIALIZED (
  SELECT c.*,row_number() OVER(ORDER BY c.display_name NULLS LAST,c.employment_id) AS position
   FROM app._home_peer_cohort(p_employment,'team') c
 ), presence AS MATERIALIZED (
  SELECT * FROM app.leave_calendar_presence(coalesce((SELECT jsonb_agg(employment_id ORDER BY employment_id) FROM cohort),'[]'::jsonb),p_date,p_date,'approved')
 ), page AS MATERIALIZED (
  SELECT c.employment_id,c.display_name,c.position,p.presence FROM cohort c
   LEFT JOIN presence p ON p.employment_id=c.employment_id
  WHERE p_after IS NULL OR c.position>(SELECT position FROM cohort WHERE employment_id=p_after)
  ORDER BY c.position LIMIT p_limit+1
 ), shown AS (SELECT * FROM page ORDER BY position LIMIT p_limit)
 SELECT jsonb_build_object('scope',policy_scope,'date',p_date::text,
  'totalEmployments',(SELECT count(*) FROM cohort),
  'items',coalesce((SELECT jsonb_agg(jsonb_build_object('employmentId',employment_id,'name',display_name,'presence',presence) ORDER BY position) FROM shown),'[]'::jsonb),
  'nextCursor',CASE WHEN (SELECT count(*) FROM page)>p_limit THEN (SELECT employment_id FROM shown ORDER BY position DESC LIMIT 1) ELSE NULL END)
 INTO result;
 RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION app.home_team_page(uuid,date,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.home_team_page(uuid,date,uuid,integer) TO ai_hr_app;
--> statement-breakpoint
-- No birth year/date is projected. Month/day is compared in the database, including the literal
-- February 29 contract. Each read checks the newest person-wide choices, across all their logins
-- and employments. Same-person/day anniversaries with differing recorded anchors retain no invented
-- year count. This read creates no greeting, notification, acknowledgement or other side effect.
CREATE FUNCTION app.home_celebration_page(p_employment uuid,p_after text DEFAULT NULL,p_limit integer DEFAULT 20)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE policy_scope text; result jsonb; today date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
BEGIN
 -- An ownership drift must fail closed. Otherwise FORCE RLS could conceal a saved opt-out and
 -- make the absence look like permission to share. No BYPASSRLS or owner membership is granted.
 IF current_user IS DISTINCT FROM pg_get_userbyid((SELECT relowner FROM pg_class
  WHERE oid='public.employee_home_person_privacy_revision'::regclass)) THEN
  RAISE EXCEPTION 'Home privacy context unavailable' USING ERRCODE='42501';
 END IF;
 IF p_limit IS NULL OR p_limit<1 OR p_limit>50 OR (p_after IS NOT NULL AND
  p_after!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}\|(birthday|anniversary)\|[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$') THEN
  RAISE EXCEPTION 'Invalid Home sharing page' USING ERRCODE='22023';
 END IF;
 SELECT sharing_scope INTO policy_scope FROM app._home_peer_policy(p_employment,'celebration');
 IF NOT FOUND THEN RAISE EXCEPTION 'Home context unavailable' USING ERRCODE='42501';END IF;
 IF policy_scope='off' THEN
  RETURN jsonb_build_object('scope','off','from',today::text,'to',(today+7)::text,'total',0,'items','[]'::jsonb,'nextCursor',NULL);
 END IF;
 WITH cohort AS MATERIALIZED (SELECT * FROM app._home_peer_cohort(p_employment,'celebration')),
 days AS (SELECT today+n AS d FROM generate_series(0,7) n),
 candidates AS (
  SELECT c.employment_id,c.person_id,c.display_name,days.d,'birthday'::text AS kind,NULL::integer AS years
  FROM cohort c JOIN public.person p ON p.id=c.person_id AND p.tenant_id=app.current_tenant_id()
  JOIN public.employment e ON e.id=c.employment_id AND e.tenant_id=p.tenant_id CROSS JOIN days
  LEFT JOIN LATERAL (SELECT v.hide_birthday,v.hide_anniversary FROM public.employee_home_person_privacy_revision v
   WHERE v.tenant_id=p.tenant_id AND v.person_id=p.id ORDER BY v.ordinal DESC LIMIT 1) privacy ON true
  WHERE to_char(p.date_of_birth,'MM-DD')=to_char(days.d,'MM-DD') AND NOT coalesce(privacy.hide_birthday,false)
   AND (LEAST(e.resignation_date,e.last_working_date,e.terminated_on) IS NULL
    OR days.d<=LEAST(e.resignation_date,e.last_working_date,e.terminated_on))
  UNION ALL
  SELECT c.employment_id,c.person_id,c.display_name,days.d,'anniversary'::text,
   extract(year FROM days.d)::integer-extract(year FROM e.hired_on)::integer
  FROM cohort c JOIN public.employment e ON e.id=c.employment_id AND e.tenant_id=app.current_tenant_id() CROSS JOIN days
  LEFT JOIN LATERAL (SELECT v.hide_birthday,v.hide_anniversary FROM public.employee_home_person_privacy_revision v
   WHERE v.tenant_id=e.tenant_id AND v.person_id=e.person_id ORDER BY v.ordinal DESC LIMIT 1) privacy ON true
  WHERE to_char(e.hired_on,'MM-DD')=to_char(days.d,'MM-DD') AND extract(year FROM days.d)>extract(year FROM e.hired_on)
   AND NOT coalesce(privacy.hide_anniversary,false)
   AND (LEAST(e.resignation_date,e.last_working_date,e.terminated_on) IS NULL
    OR days.d<=LEAST(e.resignation_date,e.last_working_date,e.terminated_on))
 ), events AS MATERIALIZED (
  SELECT min(employment_id::text)::uuid AS employment_id,min(display_name) AS display_name,d,kind,
   CASE WHEN min(years)=max(years) THEN min(years) ELSE NULL END AS years,
   d::text||'|'||kind||'|'||min(employment_id::text) AS cursor
  FROM candidates GROUP BY person_id,d,kind
 ), page AS MATERIALIZED (
  SELECT * FROM events WHERE p_after IS NULL OR cursor>p_after ORDER BY cursor LIMIT p_limit+1
 ), shown AS (SELECT * FROM page ORDER BY cursor LIMIT p_limit)
 SELECT CASE WHEN p_after IS NOT NULL AND NOT EXISTS(SELECT 1 FROM events WHERE cursor=p_after) THEN NULL
  ELSE jsonb_build_object('scope',policy_scope,'from',today::text,'to',(today+7)::text,'total',(SELECT count(*) FROM events),
   'items',coalesce((SELECT jsonb_agg(jsonb_build_object('employmentId',employment_id,'name',display_name,'date',d::text,'kind',kind,'years',years) ORDER BY cursor) FROM shown),'[]'::jsonb),
   'nextCursor',CASE WHEN (SELECT count(*) FROM page)>p_limit THEN (SELECT cursor FROM shown ORDER BY cursor DESC LIMIT 1) ELSE NULL END) END
 INTO result;
 IF result IS NULL THEN RAISE EXCEPTION 'Home sharing page changed; reload' USING ERRCODE='42501';END IF;
 RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION app.home_celebration_page(uuid,text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.home_celebration_page(uuid,text,integer) TO ai_hr_app;

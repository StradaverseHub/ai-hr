-- Team presence is a person projection within the current, explicitly shared Home cohort. The
-- underlying Leave and dated-company owners remain authoritative. No new presence fact is stored.
CREATE FUNCTION app._home_team_leave_window(p_employment uuid,p_from date,p_to date)
 RETURNS TABLE(person_id uuid,employment_id uuid,on_date date,display_name text)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH policy AS MATERIALIZED (SELECT * FROM app._home_peer_policy(p_employment,'team')),
 cohort AS MATERIALIZED (SELECT * FROM app._home_peer_cohort(p_employment,'team')),
 leave_facts AS MATERIALIZED (
  SELECT * FROM app.leave_calendar_presence(coalesce((SELECT jsonb_agg(c.employment_id ORDER BY c.employment_id) FROM cohort c),'[]'::jsonb),p_from,p_to,'approved')
 ), peer_proof AS MATERIALIZED (
  SELECT * FROM app.proven_company_date_points(coalesce((SELECT jsonb_agg(jsonb_build_object('employmentId',l.employment_id,'date',l.on_date) ORDER BY l.employment_id,l.on_date) FROM leave_facts l),'[]'::jsonb))
 ), viewer_proof AS MATERIALIZED (
  SELECT * FROM app.proven_company_date_points((SELECT jsonb_agg(jsonb_build_object('employmentId',p_employment,'date',d::date) ORDER BY d)
   FROM generate_series(p_from::timestamp,p_to::timestamp,interval '1 day') d))
 ), qualified AS (
 SELECT DISTINCT c.person_id,l.on_date
 FROM cohort c JOIN leave_facts l ON l.employment_id=c.employment_id
 JOIN peer_proof target ON target.employment_id=c.employment_id AND target.on_date=l.on_date
 JOIN viewer_proof viewer ON viewer.on_date=l.on_date CROSS JOIN policy p
 WHERE target.reason IS NULL AND target.company_id=p.company_id
  AND viewer.reason IS NULL AND viewer.company_id=p.company_id
 )
 -- The same representative key is used by team pages and calendar continuation links even when
 -- leave belongs to a different concurrent employment of this person.
 SELECT c.person_id,min(c.employment_id::text)::uuid,q.on_date,min(c.display_name)
 FROM cohort c JOIN qualified q ON q.person_id=c.person_id
 GROUP BY c.person_id,q.on_date ORDER BY q.on_date,min(c.display_name),min(c.employment_id::text);
$$;
REVOKE ALL ON FUNCTION app._home_team_leave_window(uuid,date,date) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Both the ordinary team page and the calendar's narrower on-leave detail use this same owner.
-- A person with multiple employments appears once. "Has approved leave" does not claim that all
-- their employments are absent, nor that a missing fact means office, WFH or attendance.
CREATE FUNCTION app._home_team_page(p_employment uuid,p_date date,p_after uuid,p_limit integer,p_leave_only boolean)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE policy_scope text;viewer_company uuid;viewer_department uuid;result jsonb;
BEGIN
 IF p_date IS NULL OR NOT isfinite(p_date) OR p_limit IS NULL OR p_limit<1 OR p_limit>50 OR p_leave_only IS NULL THEN
  RAISE EXCEPTION 'Invalid Home sharing page' USING ERRCODE='22023';
 END IF;
 SELECT sharing_scope,company_id,department_id INTO policy_scope,viewer_company,viewer_department FROM app._home_peer_policy(p_employment,'team');
 IF NOT FOUND THEN RAISE EXCEPTION 'Home context unavailable' USING ERRCODE='42501';END IF;
 IF policy_scope='off' THEN
  RETURN jsonb_build_object('scope','off','date',p_date::text,'totalPeople',0,'items','[]'::jsonb,'nextCursor',NULL);
 END IF;
 IF policy_scope='department' AND viewer_department IS NULL THEN
  RAISE EXCEPTION 'Home sharing group unavailable' USING ERRCODE='42501';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM app.proven_company_date_points(jsonb_build_array(jsonb_build_object('employmentId',p_employment,'date',p_date)))
  WHERE reason IS NULL AND company_id=viewer_company) THEN
  RAISE EXCEPTION 'Home date context unavailable' USING ERRCODE='42501';
 END IF;
 WITH cohort AS MATERIALIZED (
  SELECT c.person_id,min(c.employment_id::text)::uuid AS employment_id,min(c.display_name) AS display_name
   FROM app._home_peer_cohort(p_employment,'team') c GROUP BY c.person_id
 ), approved AS MATERIALIZED (SELECT * FROM app._home_team_leave_window(p_employment,p_date,p_date)),
 members AS MATERIALIZED (
  SELECT c.employment_id,c.display_name,CASE WHEN a.person_id IS NOT NULL THEN 'leave' ELSE NULL END AS presence
   FROM cohort c LEFT JOIN approved a ON a.person_id=c.person_id
  WHERE NOT p_leave_only OR a.person_id IS NOT NULL
 ), ordered AS MATERIALIZED (
  SELECT m.*,row_number() OVER(ORDER BY m.display_name NULLS LAST,m.employment_id) AS position FROM members m
 ), page AS MATERIALIZED (
  SELECT * FROM ordered WHERE p_after IS NULL OR position>(SELECT position FROM ordered WHERE employment_id=p_after)
  ORDER BY position LIMIT p_limit+1
 ), shown AS (SELECT * FROM page ORDER BY position LIMIT p_limit)
 SELECT CASE WHEN p_after IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ordered WHERE employment_id=p_after) THEN NULL
 ELSE jsonb_build_object('scope',policy_scope,'date',p_date::text,'totalPeople',(SELECT count(*) FROM members),
  'items',coalesce((SELECT jsonb_agg(jsonb_build_object('employmentId',employment_id,'name',display_name,'presence',presence) ORDER BY position) FROM shown),'[]'::jsonb),
  'nextCursor',CASE WHEN (SELECT count(*) FROM page)>p_limit THEN (SELECT employment_id FROM shown ORDER BY position DESC LIMIT 1) ELSE NULL END) END
 INTO result;
 IF result IS NULL THEN RAISE EXCEPTION 'Home sharing page changed; reload' USING ERRCODE='42501';END IF;
 RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION app._home_team_page(uuid,date,uuid,integer,boolean) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.home_team_page(p_employment uuid,p_date date,p_after uuid DEFAULT NULL,p_limit integer DEFAULT 20)
 RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app._home_team_page(p_employment,p_date,p_after,p_limit,false);
$$;
REVOKE ALL ON FUNCTION app.home_team_page(uuid,date,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.home_team_page(uuid,date,uuid,integer) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.home_team_leave_page(p_employment uuid,p_date date,p_after uuid DEFAULT NULL,p_limit integer DEFAULT 20)
 RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app._home_team_page(p_employment,p_date,p_after,p_limit,true);
$$;
REVOKE ALL ON FUNCTION app.home_team_leave_page(uuid,date,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.home_team_leave_page(uuid,date,uuid,integer) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.home_team_calendar(p_employment uuid,p_from date,p_to date)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE policy_scope text;viewer_company uuid;viewer_department uuid;result jsonb;
BEGIN
 IF p_from IS NULL OR p_to IS NULL OR NOT isfinite(p_from) OR NOT isfinite(p_to) OR p_to-p_from NOT BETWEEN 0 AND 61 THEN
  RAISE EXCEPTION 'Invalid Home calendar window' USING ERRCODE='22023';
 END IF;
 IF app.own_home_dashboard_role(p_employment) IS NULL THEN
  RAISE EXCEPTION 'Home context unavailable' USING ERRCODE='42501';
 END IF;
 SELECT sharing_scope,company_id,department_id INTO policy_scope,viewer_company,viewer_department FROM app._home_peer_policy(p_employment,'team');
 IF NOT FOUND OR (policy_scope='department' AND viewer_department IS NULL) THEN
  -- Historical own calendars stay usable when no current sharing context can be established.
  -- This is explicitly unavailable, never an inferred off policy or zero shared-person count.
  SELECT jsonb_build_object('scope','unavailable','from',p_from::text,'to',p_to::text,'days',
   jsonb_agg(jsonb_build_object('date',d::date::text,'available',false,'totalPeople',NULL,'items','[]'::jsonb,'nextCursor',NULL) ORDER BY d))
   INTO result FROM generate_series(p_from::timestamp,p_to::timestamp,interval '1 day') d;
  RETURN result;
 END IF;
 WITH dates AS MATERIALIZED (
  SELECT d::date AS on_date FROM generate_series(p_from::timestamp,p_to::timestamp,interval '1 day') d
 ), coverage AS MATERIALIZED (
  SELECT * FROM app.proven_company_date_points((SELECT jsonb_agg(jsonb_build_object('employmentId',p_employment,'date',on_date) ORDER BY on_date) FROM dates))
 ), present AS MATERIALIZED (
  SELECT f.*,row_number() OVER(PARTITION BY f.on_date ORDER BY f.display_name NULLS LAST,f.employment_id) AS position
   FROM app._home_team_leave_window(p_employment,p_from,p_to) f
 )
 SELECT jsonb_build_object('scope',policy_scope,'from',p_from::text,'to',p_to::text,'days',
  (SELECT jsonb_agg(jsonb_build_object('date',d.on_date::text,
   'available',policy_scope<>'off' AND c.reason IS NULL AND c.company_id=viewer_company,
   'totalPeople',CASE WHEN policy_scope<>'off' AND c.reason IS NULL AND c.company_id=viewer_company
    THEN (SELECT count(*) FROM present f WHERE f.on_date=d.on_date) ELSE NULL END,
   'items',coalesce((SELECT jsonb_agg(jsonb_build_object('employmentId',f.employment_id,'name',f.display_name) ORDER BY f.position)
    FROM present f WHERE f.on_date=d.on_date AND f.position<=5),'[]'::jsonb),
   'nextCursor',CASE WHEN (SELECT count(*) FROM present f WHERE f.on_date=d.on_date)>5
    THEN (SELECT employment_id FROM present f WHERE f.on_date=d.on_date AND f.position=5) ELSE NULL END
  ) ORDER BY d.on_date) FROM dates d JOIN coverage c ON c.on_date=d.on_date)) INTO result;
 RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION app.home_team_calendar(uuid,date,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.home_team_calendar(uuid,date,date) TO ai_hr_app;

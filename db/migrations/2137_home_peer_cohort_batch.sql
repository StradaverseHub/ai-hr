-- Batch the unchanged dated-company proof in bounded groups; audience policy and private ACL remain authoritative.
DO $$
DECLARE p record;
BEGIN
 SELECT prosrc,prosecdef,proisstrict,proleakproof,provolatile,proconfig INTO p
 FROM pg_proc WHERE oid=to_regprocedure('app._home_peer_cohort(uuid,text)');
 IF NOT FOUND OR md5(p.prosrc) IS DISTINCT FROM 'a21648ea684c651dd3d92eb6977e5f46'
  OR NOT p.prosecdef OR p.proisstrict OR p.proleakproof OR p.provolatile<>'s'
  OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp'] THEN
  RAISE EXCEPTION 'Unexpected Home peer cohort; review before batching' USING ERRCODE='55000';
 END IF;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app._home_peer_cohort(p_employment uuid,p_purpose text)
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
 ), eligible AS MATERIALIZED (
 SELECT e.id AS employment_id,e.person_id,p.company_id AS viewer_company,today.d AS on_date,
  coalesce(nullif(btrim(person.preferred_name),''),nullif(btrim(person.first_name),''),nullif(btrim(person.full_name),'')) AS display_name
 FROM candidate_ids candidate JOIN public.employment e ON e.id=candidate.id
 JOIN public.person person ON person.id=e.person_id AND person.tenant_id=e.tenant_id CROSS JOIN policy p CROSS JOIN today
 WHERE e.tenant_id=app.current_tenant_id() AND e.person_id<>p.viewer_person_id
  AND e.blacklisted_at IS NULL AND e.hired_on<=today.d
  AND (LEAST(e.resignation_date,e.last_working_date,e.terminated_on) IS NULL OR LEAST(e.resignation_date,e.last_working_date,e.terminated_on)>=today.d)
 ), ranked_points AS (
 SELECT employment_id,on_date,(row_number() OVER(ORDER BY employment_id)-1)/1000 AS batch FROM eligible
 ), proof_groups AS (
 SELECT batch,jsonb_agg(jsonb_build_object('employmentId',employment_id,'date',on_date) ORDER BY employment_id) AS points FROM ranked_points GROUP BY batch
 ), proofs AS MATERIALIZED (
 SELECT DISTINCT proof.* FROM proof_groups g CROSS JOIN LATERAL app.proven_company_date_points(g.points) proof
 )
 SELECT e.employment_id,e.person_id,e.display_name FROM eligible e JOIN proofs proof
  ON proof.employment_id=e.employment_id AND proof.on_date=e.on_date
 WHERE proof.reason IS NULL AND proof.company_id=e.viewer_company ORDER BY e.display_name,e.employment_id;
$$;

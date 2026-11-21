-- Explicit SQL NULL must not turn a bounded owner page into an unlimited query.
CREATE OR REPLACE FUNCTION app.contract_shared_work_page(p_category text DEFAULT 'all',p_companies uuid[] DEFAULT NULL,p_limit integer DEFAULT 20,p_offset integer DEFAULT 0) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF p_category IS NULL OR p_limit IS NULL OR p_offset IS NULL OR p_category NOT IN('all','approvals','tasks') OR p_limit NOT BETWEEN 1 AND 100 OR p_offset NOT BETWEEN 0 AND 100000 OR cardinality(p_companies)>500 THEN RAISE EXCEPTION 'Invalid Contract work page' USING ERRCODE='22023'; END IF;
 IF NOT app.contract_verified_human(app.current_user_id()) THEN RETURN jsonb_build_object('items','[]'::jsonb,'total',0,'countsByKind','{}'::jsonb,'approvalTotal',0,'taskTotal',0); END IF;
 WITH assigned AS MATERIALIZED(
  SELECT DISTINCT ON(w.kind,w.subject_id) w.*,p.full_name,CASE WHEN w.kind='letter' AND w.action_code='sign' THEN 'tasks' ELSE 'approvals' END AS category
  FROM app.contract_shared_pending_work_page_source(NULL,true) w JOIN public.employment e ON e.tenant_id=app.current_tenant_id() AND e.id=w.employment_id JOIN public.person p ON p.tenant_id=e.tenant_id AND p.id=e.person_id
  WHERE w.eligible AND (p_companies IS NULL OR w.company_id=ANY(p_companies)) ORDER BY w.kind,w.subject_id,w.step_id
 ), filtered AS MATERIALIZED(SELECT * FROM assigned WHERE p_category='all' OR category=p_category),
 page AS(SELECT subject_id::text AS id,CASE kind WHEN 'approval' THEN 'contractApproval' ELSE 'contractLetter' END AS kind,full_name AS "subjectName",updated_at AS "createdAt",action_code AS action,
  '/lifecycle/contracts/'||CASE kind WHEN 'approval' THEN 'approvals/' ELSE 'letters/' END||subject_id::text AS "linkPath"
  FROM filtered ORDER BY updated_at DESC,kind,subject_id LIMIT p_limit OFFSET p_offset),
 kinds AS(SELECT CASE kind WHEN 'approval' THEN 'contractApproval' ELSE 'contractLetter' END AS name,count(*) AS total FROM filtered GROUP BY kind)
 SELECT jsonb_build_object('items',coalesce((SELECT jsonb_agg(to_jsonb(page) ORDER BY "createdAt" DESC,kind,id) FROM page),'[]'::jsonb),'total',(SELECT count(*) FROM filtered),
  'countsByKind',coalesce((SELECT jsonb_object_agg(name,total) FROM kinds),'{}'::jsonb),'approvalTotal',(SELECT count(*) FROM assigned WHERE category='approvals'),'taskTotal',(SELECT count(*) FROM assigned WHERE category='tasks')) INTO result;
 RETURN result;
END $$;

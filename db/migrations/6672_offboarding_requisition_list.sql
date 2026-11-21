-- Bounded all-company RVK register. Authority/configuration is materialized once; SQL owns scope/count/order/page.
CREATE FUNCTION app.offboarding_requisitions(p_company uuid DEFAULT NULL,p_search text DEFAULT '',p_offset integer DEFAULT 0,p_limit integer DEFAULT 50) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;principal_person uuid;uid text:=app.current_user_id()::text;grants jsonb;cfg jsonb;full_off boolean;
BEGIN
 IF p_offset IS NULL OR p_offset<0 OR p_offset>1000000 OR p_limit IS NULL OR p_limit<1 OR p_limit>100 OR p_search IS NULL OR length(p_search)>100 THEN RAISE EXCEPTION 'Invalid requisition page';END IF;
 IF uid IS NULL OR NOT app.principal_snapshot_current() OR NOT EXISTS(SELECT 1 FROM app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)) THEN RETURN jsonb_build_object('items','[]'::jsonb,'total',0);END IF;
 SELECT person_id INTO principal_person FROM app_user WHERE id=app.current_user_id() AND tenant_id=app.current_tenant_id();
 SELECT coalesce(jsonb_agg(jsonb_build_object('role',g.role,'companyId',g.company_id)),'[]') INTO grants FROM app.current_grants() g;
 SELECT data INTO cfg FROM lc_onboarding_config WHERE tenant_id=app.current_tenant_id();full_off:=coalesce(cfg->'access'->'offboarding' ? uid,false);
 WITH companies AS MATERIALIZED (
  SELECT c.id,full_off AND app.grants_admin_for(grants,c.id) AS full_view FROM company c WHERE c.tenant_id=app.current_tenant_id() AND (p_company IS NULL OR c.id=p_company) AND app.probation_company_entitled(c.id)
 ), teams AS MATERIALIZED(SELECT g->>'id' AS id FROM jsonb_array_elements(cfg->'groups') g WHERE g->'members' ? uid),
 cases AS MATERIALIZED (
  SELECT c.id,c.number,c.data->'items' AS items,c.data->'facts'->>'name' AS name,c.data->'facts'->>'lastDay' AS last_day,coalesce(e.person_id=principal_person,false) AS is_subject,c.data->>'state' AS state,c.data->>'itemsClearedAt' AS cleared_at,c.data->>'state'='cleared' AND btrim(coalesce(c.data->>'closeReason',''))<>'' AS exceptions_reviewed,co.full_view FROM lc_v9_case c JOIN companies co ON co.id=c.company_id JOIN employment e ON e.id=c.employment_id AND e.tenant_id=c.tenant_id
  WHERE c.tenant_id=app.current_tenant_id() AND c.module='off' AND c.data->>'state'<>'pending'
   AND position(lower(p_search) IN lower(c.number||' RVK-'||right(c.number,4)||' '||coalesce(c.data->'facts'->>'name','')))>0
 ), rows AS MATERIALIZED (
  SELECT c.id,c.number,c.name,c.last_day,c.state,c.full_view,c.exceptions_reviewed,
   CASE WHEN c.full_view THEN c.cleared_at END AS cleared_at,count(i)::integer AS total,
   count(i) FILTER(WHERE i->>'status' IN('done','notNeeded'))::integer AS done,count(i) FILTER(WHERE i->>'status'='notReturned')::integer AS exceptions
  FROM cases c LEFT JOIN LATERAL jsonb_array_elements(coalesce(c.items,'[]')) i ON c.full_view OR i->>'assignee'=uid AND EXISTS(SELECT 1 FROM teams g WHERE g.id=i->>'group') AND NOT c.is_subject
  GROUP BY c.id,c.number,c.name,c.last_day,c.state,c.cleared_at,c.full_view,c.exceptions_reviewed HAVING c.full_view OR count(i)>0
 ), page AS(SELECT * FROM rows ORDER BY last_day,number,id LIMIT p_limit OFFSET p_offset)
 SELECT jsonb_build_object('items',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'number','RVK-'||right(number,4),'caseNumber',number,'name',name,'lastDay',last_day,'state',state,'total',total,'done',done,'exceptions',exceptions,'clearedAt',cleared_at,'fullView',full_view,'exceptionsReviewed',exceptions_reviewed) ORDER BY last_day,number,id) FROM page),'[]'),'total',(SELECT count(*) FROM rows)) INTO result;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.offboarding_requisitions(uuid,text,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.offboarding_requisitions(uuid,text,integer,integer) TO ai_hr_app;

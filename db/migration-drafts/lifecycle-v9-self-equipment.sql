-- Unallocated V9 draft. Employee declarations never confirm an issuing-record recovery.
CREATE OR REPLACE FUNCTION app.lc_v9_work(p_id uuid DEFAULT NULL) RETURNS SETOF jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH authorized AS (
 SELECT c.*,app.current_user_id()::text AS uid,
 EXISTS(SELECT 1 FROM app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=c.tenant_id AND u.person_id=e.person_id AND u.archived_at IS NULL) AS own
 FROM lc_v9_case c JOIN employment e ON e.id=c.employment_id AND e.tenant_id=c.tenant_id
 WHERE c.tenant_id=app.current_tenant_id() AND app.current_user_id() IS NOT NULL AND NOT app.login_blocked(app.current_user_id()) AND (p_id IS NULL OR c.id=p_id)
 ), projections AS (
 SELECT a.*,coalesce((SELECT jsonb_agg(t) FROM jsonb_array_elements(a.data->'tasks') t
 WHERE (t->>'assignee'=a.uid OR a.own AND t->>'by'='employee')), '[]'::jsonb) AS tasks,
 coalesce((SELECT jsonb_agg(i) FROM jsonb_array_elements(a.data->'items') i WHERE a.own OR i->>'assignee'=a.uid),'[]'::jsonb) AS items,
 CASE WHEN a.own THEN coalesce((SELECT jsonb_agg(d) FROM jsonb_array_elements(a.data->'documents') d
 WHERE d->>'status' IN ('sent','opened','completed','signed','acknowledged','countersign')),'[]'::jsonb) ELSE '[]'::jsonb END AS documents
 FROM authorized a
 )
 SELECT jsonb_build_object('id',id,'number',number,'module',module,'revision',revision,'state',data->>'state',
 'facts',(data->'facts')-ARRAY['finalConfirmationDate','confirmationDate','probationEndDate','provisionalEndOn'],'tasks',tasks,'items',items,'documents',documents,'own',own)
 FROM projections WHERE own OR jsonb_array_length(tasks)>0 OR jsonb_array_length(items)>0
$$;
REVOKE ALL ON FUNCTION app.lc_v9_work(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lc_v9_work(uuid) TO ai_hr_app;

CREATE FUNCTION app.lc_v9_report_return(p_id uuid,p_revision integer,p_item text,p_note text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c lc_v9_case%ROWTYPE; target jsonb; item jsonb; task jsonb; items jsonb:='[]'::jsonb; tasks jsonb:='[]'::jsonb;
 own_user uuid:=app.current_user_id(); actor_name text; entry jsonb; all_declared boolean;
BEGIN
 IF own_user IS NULL OR app.login_blocked(own_user) OR p_note IS NULL OR length(p_note)>4000 THEN RAISE EXCEPTION 'Return declaration not available'; END IF;
 PERFORM pg_advisory_xact_lock(hashtext('audit-chain:' || app.current_tenant_id()::text));
 PERFORM pg_advisory_xact_lock(hashtextextended(app.current_tenant_id()::text || ':onboarding',0));
 PERFORM pg_advisory_xact_lock(hashtextextended('lifecycle-v9:' || app.current_tenant_id()::text,0));
 SELECT x.* INTO c FROM lc_v9_case x JOIN employment e ON e.id=x.employment_id AND e.tenant_id=x.tenant_id
 JOIN app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id AND u.id=own_user AND u.archived_at IS NULL
 WHERE x.id=p_id AND x.tenant_id=app.current_tenant_id() FOR UPDATE OF x;
 IF NOT FOUND OR c.data->>'module'<>'off' OR c.data->>'state'<>'submitted' THEN RAISE EXCEPTION 'Return declaration not available'; END IF;
 IF c.revision IS DISTINCT FROM p_revision THEN RAISE EXCEPTION 'This case changed. Refresh before trying again.'; END IF;
 SELECT x INTO target FROM jsonb_array_elements(c.data->'items') x WHERE x->>'id'=p_item;
 IF target IS NULL OR target->>'kind'<>'device' OR coalesce(target->>'status','') NOT IN ('todo','progress') OR target->'returnReported' IS NOT NULL THEN RAISE EXCEPTION 'Return declaration not available'; END IF;
 SELECT coalesce(p.full_name,'User') INTO actor_name FROM app_user u LEFT JOIN person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id WHERE u.id=own_user AND u.tenant_id=c.tenant_id AND u.archived_at IS NULL;
 IF actor_name IS NULL THEN RAISE EXCEPTION 'Return declaration not available'; END IF;
 FOR item IN SELECT * FROM jsonb_array_elements(c.data->'items') LOOP
  items:=items||jsonb_build_array(CASE WHEN item->>'id'=p_item THEN item||jsonb_build_object('returnReported',jsonb_build_object('at',now(),'by',own_user,'note',trim(p_note))) ELSE item END);
 END LOOP;
 SELECT NOT EXISTS(SELECT 1 FROM jsonb_array_elements(items) i WHERE i->>'kind'='device' AND coalesce(i->>'status','') NOT IN ('done','notNeeded','notReturned') AND i->'returnReported' IS NULL) INTO all_declared;
 FOR task IN SELECT * FROM jsonb_array_elements(c.data->'tasks') LOOP
  tasks:=tasks||jsonb_build_array(CASE WHEN all_declared AND task->>'by'='employee' AND task->>'documentTemplate' IS NULL AND task->>'status' IN ('todo','progress') AND task->>'name' ~* 'return' AND task->>'name' ~* '(asset|item)' THEN task||jsonb_build_object('status','done') ELSE task END);
 END LOOP;
 INSERT INTO lc_v9_case_revision(tenant_id,case_id,company_id,revision,data,actor_user_id) VALUES(c.tenant_id,c.id,c.company_id,c.revision,c.data,own_user);
 entry:=jsonb_build_object('id',gen_random_uuid(),'at',now(),'actor',jsonb_build_object('id',own_user,'name',actor_name),'action','item.returnReported','detail','Says '||(target->>'name')||' was returned. Waiting for the team to confirm.');
 UPDATE lc_v9_case SET revision=c.revision+1,updated_at=now(),data=c.data||jsonb_build_object('revision',c.revision+1,'items',items,'tasks',tasks,'log',(c.data->'log')||jsonb_build_array(entry)) WHERE id=c.id;
 RETURN c.employment_id;
END;
$$;
REVOKE ALL ON FUNCTION app.lc_v9_report_return(uuid,integer,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lc_v9_report_return(uuid,integer,text,text) TO ai_hr_app;

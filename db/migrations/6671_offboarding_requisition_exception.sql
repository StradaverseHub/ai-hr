-- A fulfilling assignee reports an exception; HR alone adjudicates it through existing case clearance.
CREATE FUNCTION app.offboarding_requisition_not_returned(p_case uuid,p_revision integer,p_item text,p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE scope jsonb;c lc_v9_case;item jsonb;
BEGIN
 IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 4000 OR NOT app.principal_snapshot_current() THEN RAISE EXCEPTION 'Record the reason this item was not returned';END IF;
 PERFORM app.access_workforce_write_lock();
 scope:=app.lc_v9_assigned_item(p_case,p_revision,p_item);item:=scope->'item';
 IF NOT app.probation_company_entitled((scope->>'companyId')::uuid) OR EXISTS(SELECT 1 FROM employment e JOIN app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id WHERE e.id=(scope->>'employmentId')::uuid AND e.tenant_id=app.current_tenant_id() AND u.id=app.current_user_id()) THEN RAISE EXCEPTION 'Providing team authority required';END IF;
 IF item->>'kind'<>'device' OR item->>'status' NOT IN('todo','progress') THEN RAISE EXCEPTION 'This item requires HR review';END IF;
 SELECT * INTO c FROM lc_v9_case WHERE id=p_case AND tenant_id=app.current_tenant_id() FOR UPDATE;
 INSERT INTO lc_v9_case_revision(tenant_id,case_id,company_id,revision,data,actor_user_id) VALUES(c.tenant_id,c.id,c.company_id,c.revision,c.data,app.current_user_id());
 UPDATE lc_v9_case SET revision=c.revision+1,updated_at=now(),data=c.data||jsonb_build_object('revision',c.revision+1,'log',coalesce(c.data->'log','[]')||jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'at',now(),'actor',jsonb_build_object('id',app.current_user_id(),'name',''),'action','item.teamUpdated','detail',(item->>'name')||': notReturned')),'items',(SELECT jsonb_agg(CASE WHEN i->>'id'=p_item THEN i||jsonb_build_object('status','notReturned','reason',btrim(p_reason)) ELSE i END ORDER BY n) FROM jsonb_array_elements(c.data->'items') WITH ORDINALITY a(i,n))) WHERE id=c.id AND tenant_id=c.tenant_id;
END $$;
REVOKE ALL ON FUNCTION app.offboarding_requisition_not_returned(uuid,integer,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.offboarding_requisition_not_returned(uuid,integer,text,text) TO ai_hr_app;

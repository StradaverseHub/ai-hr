-- b472a445: the existing offboarding case owns items, activity and completion; no copied requisition.
CREATE FUNCTION app.offboarding_items_resolved(d jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT jsonb_array_length(coalesce(d->'items','[]'))>0 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d->'items') i
 WHERE coalesce(i->>'status','') NOT IN('done','notNeeded') AND NOT(coalesce(i->>'status','')='notReturned' AND d->>'state'='cleared' AND btrim(coalesce(d->>'closeReason',''))<>''))
$$;
REVOKE ALL ON FUNCTION app.offboarding_items_resolved(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.offboarding_items_resolved(jsonb) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.offboarding_requisition_history() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE item jsonb;prior jsonb;actor_name text;entries jsonb:='[]';stamp text:=to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
 IF NEW.module<>'off' THEN RETURN NEW;END IF;
 SELECT p.full_name INTO actor_name FROM app_user u JOIN person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id WHERE u.id=app.current_user_id() AND u.tenant_id=NEW.tenant_id;
 -- Ignore caller supplied completion metadata. Existing complete cases remain unrecorded until a real transition.
 NEW.data:=NEW.data||jsonb_build_object('itemsClearedAt',CASE WHEN NOT app.offboarding_items_resolved(NEW.data) THEN NULL
  WHEN app.offboarding_items_resolved(OLD.data) THEN OLD.data->>'itemsClearedAt' ELSE stamp END);
 FOR item IN SELECT value FROM jsonb_array_elements(coalesce(NEW.data->'items','[]')) LOOP
  SELECT value INTO prior FROM jsonb_array_elements(coalesce(OLD.data->'items','[]')) WHERE value->>'id'=item->>'id';
  IF prior IS NULL OR (item->'status',item->'assignee',item->'group',item->'dueOn') IS DISTINCT FROM (prior->'status',prior->'assignee',prior->'group',prior->'dueOn') THEN
   entries:=entries||jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'at',stamp,'actor',jsonb_build_object('id',coalesce(app.current_user_id()::text,'system'),'name',coalesce(actor_name,'System')),
    'action',CASE WHEN prior IS NULL THEN 'requisition.itemAdded' ELSE 'requisition.itemUpdated' END,'detail',item->>'name','itemId',item->>'id','itemStatus',item->>'status','groupId',item->>'group','assigneeId',item->>'assignee','dueOn',item->>'dueOn'));
  END IF;
 END LOOP;
 NEW.data:=jsonb_set(NEW.data,'{requisitionActivity}',coalesce(OLD.data->'requisitionActivity','[]')||entries);
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.offboarding_requisition_history() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.offboarding_requisition_history() FROM ai_hr_app;
CREATE TRIGGER offboarding_requisition_history BEFORE UPDATE OF data ON lc_v9_case FOR EACH ROW EXECUTE FUNCTION app.offboarding_requisition_history();
--> statement-breakpoint
CREATE FUNCTION app.offboarding_requisition(p_case uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c lc_v9_case;full_view boolean;is_subject boolean;items jsonb;cfg jsonb;result jsonb;uid text:=app.current_user_id()::text;
BEGIN
 IF uid IS NULL OR NOT app.principal_snapshot_current() OR NOT EXISTS(SELECT 1 FROM app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)) THEN RETURN NULL;END IF;
 SELECT * INTO c FROM lc_v9_case WHERE id=p_case AND tenant_id=app.current_tenant_id() AND module='off' AND data->>'state'<>'pending';
 IF NOT FOUND OR NOT app.probation_company_entitled(c.company_id) THEN RETURN NULL;END IF;
 SELECT EXISTS(SELECT 1 FROM employment e JOIN app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id WHERE e.id=c.employment_id AND e.tenant_id=c.tenant_id AND u.id=app.current_user_id()) INTO is_subject;
 full_view:=app.lc_v9_off_access(c.company_id);
 SELECT data INTO cfg FROM lc_onboarding_config WHERE tenant_id=c.tenant_id;
 WITH teams AS MATERIALIZED(SELECT g->>'id' AS id FROM jsonb_array_elements(cfg->'groups') g WHERE g->'members' ? uid), visible AS MATERIALIZED (
  SELECT i,n FROM jsonb_array_elements(coalesce(c.data->'items','[]')) WITH ORDINALITY a(i,n)
  WHERE full_view OR (i->>'assignee'=uid AND EXISTS(SELECT 1 FROM teams g WHERE g.id=i->>'group') AND NOT is_subject)
 ), people AS MATERIALIZED (
  SELECT u.id::text,p.full_name FROM app_user u JOIN person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id WHERE u.tenant_id=c.tenant_id AND u.id::text IN(SELECT i->>'assignee' FROM visible)
 ) SELECT coalesce(jsonb_agg(jsonb_build_object('id',i->>'id','name',i->>'name','kind',i->>'kind','status',i->>'status','reason',i->>'reason','dueOn',i->>'dueOn',
  'groupId',i->>'group','team',coalesce(g->>'name',''),'assigneeId',i->>'assignee','assignee',coalesce(p.full_name,''),'canAct',c.data->>'state'='submitted' AND (full_view OR i->>'assignee'=uid) AND (full_view OR i->>'status' NOT IN('notReturned','notNeeded')),
  'catalogueId',coalesce(i->>'catalogueId',i->>'sourceCatalogueId'),'providedBy',i->'providedBy') ORDER BY n),'[]') INTO items
 FROM visible v LEFT JOIN people p ON p.id=i->>'assignee' LEFT JOIN LATERAL(SELECT value g FROM jsonb_array_elements(cfg->'groups') WHERE value->>'id'=i->>'group') team ON true;
 IF NOT full_view AND jsonb_array_length(items)=0 THEN RETURN NULL;END IF;
 SELECT jsonb_build_object('id',c.id,'revision',c.revision,'number','RVK-'||right(c.number,4),'caseNumber',c.number,'state',c.data->>'state','fullView',full_view,
  'name',c.data->'facts'->>'name','businessGroup',coalesce(b.name,''),'position',coalesce(p.title,''),'lastDay',c.data->'facts'->>'lastDay','noticeDate',c.data->'facts'->>'noticeDate','caseType',c.data->'facts'->>'caseType',
  'exceptionsReviewed',c.data->>'state'='cleared' AND btrim(coalesce(c.data->>'closeReason',''))<>'','revokeMode',coalesce(c.data->>'revokeMode','lastday'),'revokeDate',c.data->>'revokeDate','items',items,'clearedAt',CASE WHEN full_view THEN c.data->>'itemsClearedAt' END,
  'activity',coalesce((SELECT jsonb_agg(jsonb_build_object('id',l->>'id','at',l->>'at','action',l->>'action','detail',l->>'detail','itemStatus',l->>'itemStatus','actor',l->'actor'->>'name') ORDER BY n DESC)
   FROM jsonb_array_elements(coalesce(c.data->'requisitionActivity','[]')||CASE WHEN full_view THEN coalesce(c.data->'log','[]') ELSE '[]'::jsonb END) WITH ORDINALITY a(l,n) WHERE (l->>'action' IN('requisition.itemAdded','requisition.itemUpdated') AND EXISTS(SELECT 1 FROM jsonb_array_elements(items) i WHERE i->>'id'=l->>'itemId')) OR (full_view AND l->>'action' IN('item.assigned','item.assignment_failed','item.reassigned','item.updated','item.teamUpdated','items.bulkUpdated'))),'[]')) INTO result
 FROM (SELECT 1) seed LEFT JOIN business_unit b ON b.id::text=c.data->'facts'->>'businessGroup' AND b.tenant_id=c.tenant_id LEFT JOIN position p ON p.id::text=c.data->'facts'->>'title' AND p.tenant_id=c.tenant_id;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.offboarding_requisition(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.offboarding_requisition(uuid) TO ai_hr_app;

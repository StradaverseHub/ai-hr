-- Approved a9778c3b. Metadata projection and self-open only; no answer, signature or delivery writes.
-- Canonical saved-instance choice. Multiple live instances are a repairable hold, never a guessed link.
CREATE FUNCTION app.lifecycle_task_document(p_documents jsonb,p_template text) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 WITH candidates AS MATERIALIZED (
  SELECT d FROM jsonb_array_elements(coalesce(p_documents,'[]'::jsonb)) d
  WHERE d->>'templateId'=p_template AND d->>'status' NOT IN ('withdrawn','superseded')
 ), chosen AS (SELECT d FROM candidates ORDER BY (d->>'version')::integer DESC,d->>'createdAt' DESC,d->>'id' DESC LIMIT 1)
 SELECT CASE WHEN (SELECT count(*) FROM candidates)>1 THEN jsonb_build_object('state','review')
 WHEN d->>'status' IN ('sent','opened','completed','signed','acknowledged','countersign') THEN jsonb_build_object('state','released','documentId',d->>'id','documentName',d->>'name','documentStatus',d->>'status')
 ELSE jsonb_build_object('state','unreleased') END FROM (SELECT (SELECT d FROM chosen) AS d) one
$$;
REVOKE ALL ON FUNCTION app.lifecycle_task_document(jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lifecycle_task_document(jsonb,text) TO ai_hr_app;

CREATE FUNCTION app.lifecycle_task_documents(p_companies uuid[],p_offset integer DEFAULT 0,p_limit integer DEFAULT 50,p_case uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF p_companies IS NULL OR cardinality(p_companies)>500 OR p_offset IS NULL OR p_offset<0 OR p_offset>1000000 OR p_limit IS NULL OR p_limit<1 OR p_limit>100 THEN RAISE EXCEPTION 'Invalid document list'; END IF;
 WITH principal AS MATERIALIZED (
  SELECT u.id,u.person_id FROM public.app_user u WHERE u.tenant_id=app.current_tenant_id() AND u.id=app.current_user_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
 ), owned AS MATERIALIZED (
  SELECT c.id,c.revision,c.data->>'number' AS number,'onb'::text AS module,c.data->>'state' AS state,c.data->'tasks' AS tasks,
   coalesce(c.data->'confirmedChecklist'->>'name','Onboarding checklist') AS checklist,p.data->'lifecycleV9'->'documents' AS documents,u.id AS uid
  FROM public.lc_onboarding_case c LEFT JOIN public.lc_onboarding_private p ON p.case_id=c.id AND p.tenant_id=c.tenant_id
  JOIN public.employment e ON e.id=c.employment_id AND e.tenant_id=c.tenant_id AND e.company_id=c.company_id AND e.person_id::text=c.data->>'personId'
  JOIN principal u ON u.person_id=e.person_id
  WHERE c.tenant_id=app.current_tenant_id() AND c.company_id=ANY(p_companies) AND (p_case IS NULL OR c.id=p_case)
   AND (NOT(coalesce(p.data,'{}'::jsonb) ? 'lifecycleV9') OR (p.data->'lifecycleV9Subject'->>'employmentId'=e.id::text AND p.data->'lifecycleV9Subject'->>'personId'=e.person_id::text))
  UNION ALL
  SELECT c.id,c.revision,c.number,c.module,c.data->>'state',c.data->'tasks',coalesce(c.data->>'checklistName','Offboarding checklist'),c.data->'documents',u.id
  FROM public.lc_v9_case c JOIN public.employment e ON e.id=c.employment_id AND e.tenant_id=c.tenant_id JOIN principal u ON u.person_id=e.person_id
  WHERE c.tenant_id=app.current_tenant_id() AND c.company_id=ANY(p_companies) AND (p_case IS NULL OR c.id=p_case)
 ), entries AS MATERIALIZED (
  SELECT o.id,o.revision,o.number,o.module,t->>'id' AS task_id,t->>'name' AS task_name,t->>'status' AS task_status,t->>'dueOn' AS due_on,
   coalesce(t->>'documentAction','completed') AS action,o.checklist AS source_name,'checklist'::text AS source_kind,
   coalesce(t->>'name','Document') AS fallback_name,app.lifecycle_task_document(o.documents,t->>'documentTemplate') AS choice
  FROM owned o CROSS JOIN LATERAL jsonb_array_elements(coalesce(o.tasks,'[]'::jsonb)) t
  WHERE t->>'documentTemplate' IS NOT NULL AND (t->>'assignee'=o.uid::text OR t->>'by' IN ('joiner','employee'))
  UNION ALL
  SELECT o.id,o.revision,o.number,o.module,NULL,NULL,NULL,NULL,NULL,
   'Documents from HR','document',
   d->>'name',app.lifecycle_task_document(o.documents,d->>'templateId')
  FROM owned o CROSS JOIN LATERAL (SELECT DISTINCT ON (saved->>'templateId') saved AS d FROM jsonb_array_elements(coalesce(o.documents,'[]'::jsonb)) saved WHERE saved->>'status' NOT IN ('withdrawn','superseded','draft','hrsigned') ORDER BY saved->>'templateId',(saved->>'version')::integer DESC,saved->>'createdAt' DESC,saved->>'id' DESC) visible
  WHERE d->>'status' NOT IN ('withdrawn','superseded','draft','hrsigned')
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(o.tasks,'[]'::jsonb)) t WHERE t->>'documentTemplate'=d->>'templateId' AND (t->>'assignee'=o.uid::text OR t->>'by' IN ('joiner','employee')))
 ), projected AS MATERIALIZED (
  SELECT id,module,task_id,choice->>'documentId' AS document_id,due_on,jsonb_build_object(
   'caseId',id,'caseNumber',number,'module',module,'revision',revision,'taskId',task_id,'taskName',task_name,'taskStatus',task_status,'dueOn',due_on,'action',action,
   'sourceName',source_name,'sourceKind',source_kind,'state',choice->>'state','documentId',choice->>'documentId','documentName',coalesce(choice->>'documentName',fallback_name),'documentStatus',choice->>'documentStatus') AS item
  FROM entries
 ), page AS (
  SELECT * FROM projected ORDER BY due_on NULLS LAST,id,task_id NULLS LAST,document_id NULLS LAST OFFSET p_offset LIMIT p_limit
 ) SELECT jsonb_build_object('items',coalesce((SELECT jsonb_agg(item ORDER BY due_on NULLS LAST,id,task_id NULLS LAST,document_id NULLS LAST) FROM page),'[]'::jsonb),'total',(SELECT count(*) FROM projected),'offset',p_offset,'limit',p_limit) INTO result;
 RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION app.lifecycle_task_documents(uuid[],integer,integer,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lifecycle_task_documents(uuid[],integer,integer,uuid) TO ai_hr_app;

CREATE FUNCTION app.lifecycle_open_own_document(p_case uuid,p_document text,p_revision integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c public.lc_v9_case%ROWTYPE; n public.lc_onboarding_case%ROWTYPE; private_data jsonb; native boolean:=false;
 who uuid:=app.current_user_id(); actor_name text; doc jsonb; choice jsonb; next_docs jsonb; next_tasks jsonb; entry jsonb; changed boolean;
BEGIN
 IF who IS NULL OR app.login_blocked(who) OR p_revision IS NULL OR p_revision<1 OR p_document IS NULL OR length(p_document)>120 THEN RAISE EXCEPTION 'Document not available'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(app.current_tenant_id()::text||':onboarding',0));
 PERFORM pg_advisory_xact_lock(hashtextextended('lifecycle-v9:'||app.current_tenant_id()::text,0));
 SELECT x.* INTO c FROM public.lc_v9_case x JOIN public.employment e ON e.id=x.employment_id AND e.tenant_id=x.tenant_id
 JOIN public.app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id AND u.id=who AND u.archived_at IS NULL
 WHERE x.id=p_case AND x.tenant_id=app.current_tenant_id() FOR UPDATE OF x;
 IF NOT FOUND THEN
  SELECT x.* INTO n FROM public.lc_onboarding_case x JOIN public.employment e ON e.id=x.employment_id AND e.tenant_id=x.tenant_id AND e.company_id=x.company_id AND e.person_id::text=x.data->>'personId'
  JOIN public.app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id AND u.id=who AND u.archived_at IS NULL
  WHERE x.id=p_case AND x.tenant_id=app.current_tenant_id() FOR UPDATE OF x;
  IF NOT FOUND THEN RAISE EXCEPTION 'Document not available'; END IF;
  SELECT data INTO private_data FROM public.lc_onboarding_private WHERE case_id=n.id AND tenant_id=n.tenant_id FOR UPDATE;
  IF private_data->'lifecycleV9Subject'->>'employmentId' IS DISTINCT FROM n.employment_id::text OR private_data->'lifecycleV9Subject'->>'personId' IS DISTINCT FROM n.data->>'personId' THEN RAISE EXCEPTION 'Document not available'; END IF;
  native:=true;c.id:=n.id;c.tenant_id:=n.tenant_id;c.company_id:=n.company_id;c.employment_id:=n.employment_id;c.revision:=n.revision;
  c.data:=(private_data->'lifecycleV9')||jsonb_build_object('state',n.data->>'state','tasks',n.data->'tasks');
 END IF;
 SELECT d INTO doc FROM jsonb_array_elements(coalesce(c.data->'documents','[]'::jsonb)) d WHERE d->>'id'=p_document;
 IF doc IS NULL THEN RAISE EXCEPTION 'Document not available'; END IF;
 choice:=app.lifecycle_task_document(c.data->'documents',doc->>'templateId');
 IF choice->>'state' IS DISTINCT FROM 'released' OR choice->>'documentId' IS DISTINCT FROM p_document THEN RAISE EXCEPTION 'Document not available'; END IF;
 -- Final documents are viewable, and repeated opens are no-ops even after another tab advanced revision.
 IF doc->>'status' NOT IN ('sent','opened') OR c.data->>'state'<>'submitted' THEN RETURN jsonb_build_object('revision',c.revision,'employmentId',c.employment_id,'changed',false); END IF;
 SELECT coalesce(jsonb_agg(CASE WHEN t->>'documentTemplate'=doc->>'templateId' AND t->>'status'='todo' AND
  (t->>'assignee'=who::text OR t->>'by' IN ('joiner','employee')) THEN t||jsonb_build_object('status','progress') ELSE t END ORDER BY ordinal),'[]'::jsonb)
 INTO next_tasks FROM jsonb_array_elements(coalesce(c.data->'tasks','[]'::jsonb)) WITH ORDINALITY a(t,ordinal);
 changed:=doc->>'status'='sent' OR next_tasks IS DISTINCT FROM c.data->'tasks';
 IF NOT changed THEN RETURN jsonb_build_object('revision',c.revision,'employmentId',c.employment_id,'changed',false); END IF;
 IF c.revision IS DISTINCT FROM p_revision THEN RAISE EXCEPTION 'This case changed. Refresh before opening.'; END IF;
 SELECT coalesce(p.full_name,'Employee') INTO actor_name FROM public.app_user u LEFT JOIN public.person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id WHERE u.id=who AND u.tenant_id=c.tenant_id;
 SELECT jsonb_agg(CASE WHEN d->>'id'=p_document AND d->>'status'='sent' THEN d||jsonb_build_object('status','opened') ELSE d END ORDER BY ordinal)
 INTO next_docs FROM jsonb_array_elements(c.data->'documents') WITH ORDINALITY a(d,ordinal);
 entry:=jsonb_build_object('id',gen_random_uuid(),'at',now(),'actor',jsonb_build_object('id',who,'name',actor_name),'action','document.opened','detail',doc->>'name');
 IF native THEN
  INSERT INTO public.lc_onboarding_case_revision(tenant_id,case_id,company_id,revision,data) VALUES(c.tenant_id,c.id,c.company_id,c.revision,n.data);
  INSERT INTO public.lc_onboarding_private_revision(tenant_id,case_id,company_id,revision,data) VALUES(c.tenant_id,c.id,c.company_id,c.revision,private_data);
  UPDATE public.lc_onboarding_case SET revision=c.revision+1,updated_at=now(),data=n.data||jsonb_build_object('tasks',next_tasks,'history',coalesce(n.data->'history','[]'::jsonb)||jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'at',now(),'by',who,'name',actor_name,'action','document.opened','detail',doc->>'name'))) WHERE id=c.id AND tenant_id=c.tenant_id;
  UPDATE public.lc_onboarding_private SET data=jsonb_set(private_data,'{lifecycleV9}',(private_data->'lifecycleV9')||jsonb_build_object('documents',next_docs,'log',coalesce(c.data->'log','[]'::jsonb)||jsonb_build_array(entry))) WHERE case_id=c.id AND tenant_id=c.tenant_id;
 ELSE
  INSERT INTO public.lc_v9_case_revision(tenant_id,case_id,company_id,revision,data,actor_user_id) VALUES(c.tenant_id,c.id,c.company_id,c.revision,c.data,who);
  UPDATE public.lc_v9_case SET revision=c.revision+1,updated_at=now(),data=c.data||jsonb_build_object('revision',c.revision+1,'documents',next_docs,'tasks',next_tasks,'log',coalesce(c.data->'log','[]'::jsonb)||jsonb_build_array(entry)) WHERE id=c.id AND tenant_id=c.tenant_id;
 END IF;
 RETURN jsonb_build_object('revision',c.revision+1,'employmentId',c.employment_id,'changed',true);
END;
$$;
REVOKE ALL ON FUNCTION app.lifecycle_open_own_document(uuid,text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lifecycle_open_own_document(uuid,text,integer) TO ai_hr_app;

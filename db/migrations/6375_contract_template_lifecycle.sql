-- Builder deletion is a visibility tombstone: immutable version bytes and generated letters remain retained.
ALTER TABLE public.automation_document_template ADD COLUMN deleted_at timestamptz;
ALTER TABLE public.automation_document_template_version ADD COLUMN deleted_at timestamptz;
ALTER TABLE public.automation_document_template_version ADD COLUMN note text NOT NULL DEFAULT '' CHECK(length(note)<=1000);
--> statement-breakpoint
CREATE INDEX contract_letter_template_version_lookup ON public.contract_shared_letter(tenant_id,(data->>'templateId'),(data->>'templateVersion'));
--> statement-breakpoint
CREATE FUNCTION app.automation_document_template_usage(p_template uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE h public.automation_document_template;used boolean;documents bigint;
BEGIN
 SELECT * INTO h FROM public.automation_document_template WHERE tenant_id=app.current_tenant_id() AND id=p_template;
 IF h.id IS NULL OR h.module<>'contract_staff' OR app.automation_can_manage(h.module,'templates') IS NOT TRUE THEN RAISE EXCEPTION 'Template is unavailable' USING ERRCODE='42501';END IF;
 SELECT count(*) INTO documents FROM public.contract_shared_letter l WHERE l.tenant_id=h.tenant_id AND l.data->>'templateId'=p_template::text;
 SELECT EXISTS(SELECT 1 FROM (SELECT DISTINCT ON(workflow_id) status,definition FROM public.automation_workflow_version WHERE tenant_id=h.tenant_id ORDER BY workflow_id,revision DESC) w WHERE w.status<>'retired' AND w.definition::text LIKE '%'||p_template::text||'%')
 OR EXISTS(SELECT 1 FROM public.automation_run r JOIN public.automation_workflow_version v ON v.tenant_id=r.tenant_id AND v.workflow_id=r.workflow_id AND v.revision=r.workflow_revision WHERE r.tenant_id=h.tenant_id AND r.status IN('running','waiting') AND v.definition::text LIKE '%'||p_template::text||'%')
 OR EXISTS(SELECT 1 FROM (SELECT DISTINCT ON(template_id) retired,document_ids FROM public.automation_email_template_version WHERE tenant_id=h.tenant_id ORDER BY template_id,revision DESC) e WHERE NOT e.retired AND e.document_ids ? p_template::text) INTO used;
 RETURN jsonb_build_object('documents',documents,'usedByWorkflow',used,'versions',coalesce((SELECT jsonb_agg(jsonb_build_object('version',v.version,'template',v.definition,'savedAt',v.saved_at,'note',v.note,'documents',coalesce(c.total,0),'state',CASE WHEN h.live_version=v.version THEN 'inUse' WHEN EXISTS(SELECT 1 FROM public.domain_event e WHERE e.tenant_id=h.tenant_id AND e.aggregate_id=h.id AND e.event_type IN('automation.document.published','automation.document.publishVersion') AND e.payload->>'version'=v.version::text) THEN 'published' ELSE 'draft' END,'canDelete',h.live_version IS DISTINCT FROM v.version AND coalesce(c.total,0)=0) ORDER BY v.version DESC) FROM (SELECT * FROM public.automation_document_template_version WHERE tenant_id=h.tenant_id AND template_id=h.id AND deleted_at IS NULL ORDER BY version DESC LIMIT 100) v LEFT JOIN (SELECT (l.data->>'templateVersion')::integer AS version,count(*) AS total FROM public.contract_shared_letter l WHERE l.tenant_id=h.tenant_id AND l.data->>'templateId'=p_template::text GROUP BY l.data->>'templateVersion') c ON c.version=v.version WHERE v.tenant_id=h.tenant_id AND v.template_id=h.id AND v.deleted_at IS NULL),'[]'::jsonb),'deleteReason',CASE WHEN documents>0 THEN 'Used by documents. Retire this template instead.' WHEN used THEN 'Used by a workflow or email template. Remove its references before deleting.' ELSE NULL END);
END $$;
--> statement-breakpoint
CREATE FUNCTION app.automation_document_template_save_noted(p_template uuid,p_module text,p_definition jsonb,p_expected integer,p_publish boolean,p_retired boolean,p_note text) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE n integer;
BEGIN
 IF app.current_user_id() IS NULL OR app.automation_can_manage(p_module,'templates') IS NOT TRUE THEN RAISE EXCEPTION 'Templates are unavailable' USING ERRCODE='42501';END IF;
 PERFORM app.access_workforce_write_lock();
 PERFORM pg_advisory_xact_lock(hashtextextended('document-template:'||app.current_tenant_id()::text||':'||p_template::text,0));
 IF length(coalesce(p_note,''))>1000 THEN RAISE EXCEPTION 'Version note is too long' USING ERRCODE='22023';END IF;
 IF EXISTS(SELECT 1 FROM public.automation_document_template WHERE tenant_id=app.current_tenant_id() AND id=p_template AND deleted_at IS NOT NULL) THEN RAISE EXCEPTION 'This template was deleted' USING ERRCODE='40001';END IF;
 n:=app.automation_document_template_save(p_template,p_module,p_definition,p_expected,p_publish,p_retired);
 UPDATE public.automation_document_template_version SET note=coalesce(p_note,'') WHERE tenant_id=app.current_tenant_id() AND template_id=p_template AND version=n;
 RETURN n;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.automation_document_template_action(p_template uuid,p_expected integer,p_action text,p_version integer) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE h public.automation_document_template;v public.automation_document_template_version;usage jsonb;n integer;r jsonb;
BEGIN
 PERFORM app.access_workforce_write_lock();
 PERFORM pg_advisory_xact_lock(hashtextextended('document-template:'||app.current_tenant_id()::text||':'||p_template::text,0));
 SELECT * INTO h FROM public.automation_document_template WHERE tenant_id=app.current_tenant_id() AND id=p_template FOR UPDATE;
 IF h.id IS NULL OR h.module<>'contract_staff' OR app.current_user_id() IS NULL OR app.automation_can_manage(h.module,'templates') IS NOT TRUE THEN RAISE EXCEPTION 'Template is unavailable' USING ERRCODE='42501';END IF;
 IF h.revision IS DISTINCT FROM p_expected OR h.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'Template changed; reload' USING ERRCODE='40001';END IF;
 IF p_action='deleteTemplate' THEN
  usage:=app.automation_document_template_usage(p_template);
  IF usage->>'deleteReason' IS NOT NULL THEN RAISE EXCEPTION '%',usage->>'deleteReason' USING ERRCODE='22023';END IF;
  h.deleted_at:=now();h.retired:=true;h.live_version:=NULL;
 ELSIF p_action IN('publishVersion','deleteVersion') THEN
  SELECT * INTO v FROM public.automation_document_template_version WHERE tenant_id=h.tenant_id AND template_id=p_template AND version=p_version AND deleted_at IS NULL;
  IF v.template_id IS NULL THEN RAISE EXCEPTION 'Version is unavailable' USING ERRCODE='22023';END IF;
  IF p_action='deleteVersion' THEN
   IF h.live_version=p_version OR EXISTS(SELECT 1 FROM public.contract_shared_letter l WHERE l.tenant_id=h.tenant_id AND l.data->>'templateId'=p_template::text AND l.data->>'templateVersion'=p_version::text) THEN RAISE EXCEPTION 'This version is in use or has documents' USING ERRCODE='22023';END IF;
   IF NOT EXISTS(SELECT 1 FROM public.automation_document_template_version WHERE tenant_id=h.tenant_id AND template_id=p_template AND version<>p_version AND deleted_at IS NULL) THEN RAISE EXCEPTION 'Delete the unused template instead of its last version' USING ERRCODE='22023';END IF;
   UPDATE public.automation_document_template_version SET deleted_at=now() WHERE tenant_id=h.tenant_id AND template_id=p_template AND version=p_version;
  ELSE
   r:=v.definition->'routing';
   IF jsonb_typeof(r) IS DISTINCT FROM 'array' OR jsonb_array_length(r)=0 OR (SELECT count(*) FROM jsonb_array_elements(r) s WHERE s->'owner'='true'::jsonb)<>1 OR EXISTS(SELECT 1 FROM jsonb_array_elements(r) s WHERE s->>'action' NOT IN('review','approve','sign') OR coalesce(s->>'order','')!~'^[1-9][0-9]*$') THEN RAISE EXCEPTION 'A published Contract version needs valid routing and exactly one owner' USING ERRCODE='22023';END IF;
   IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v.definition->'blocks') b WHERE b->>'type' IN('heading','text','table','field','fields'))
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(r) step WHERE step->'who'->>'kind' NOT IN('routing','group','people','employee','directSuperior') OR step->>'action' IS NULL OR step->'who'->>'kind' IS NULL
    OR (step->'who'->>'kind'='group' AND NOT EXISTS(SELECT 1 FROM app.automation_assignment_groups() g WHERE g.group_id=step->'who'->>'groupId'))
    OR (step->'who'->>'kind'='routing' AND NOT EXISTS(SELECT 1 FROM (SELECT DISTINCT ON(routing_id) routing_id,retired FROM public.automation_routing_version WHERE tenant_id=h.tenant_id ORDER BY routing_id,revision DESC) rr WHERE rr.routing_id::text=step->'who'->>'routingId' AND NOT rr.retired))
    OR (step->'who'->>'kind'='people' AND (jsonb_array_length(step->'who'->'userIds')=0 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(step->'who'->'userIds') uid WHERE NOT EXISTS(SELECT 1 FROM app.automation_active_users(ARRAY[uid::uuid]) active(id) WHERE active.id=uid::uuid)))))
   THEN RAISE EXCEPTION 'The content or routing reference is unavailable' USING ERRCODE='22023';END IF;
   IF h.retired THEN RAISE EXCEPTION 'Retired templates cannot be published' USING ERRCODE='22023';END IF;
   h.live_version:=p_version;
  END IF;
 ELSE RAISE EXCEPTION 'Unknown template action' USING ERRCODE='22023';END IF;
 n:=h.revision+1;
 UPDATE public.automation_document_template SET revision=n,updated_at=now(),deleted_at=h.deleted_at,retired=h.retired,live_version=h.live_version WHERE tenant_id=h.tenant_id AND id=p_template;
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload) VALUES(h.tenant_id,'automation_document_template',p_template,'automation.document.'||p_action,'user',app.current_user_id(),jsonb_build_object('version',p_version,'revision',n));
 RETURN n;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.automation_document_template_usage(uuid),app.automation_document_template_save_noted(uuid,text,jsonb,integer,boolean,boolean,text),app.automation_document_template_action(uuid,integer,text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.automation_document_template_usage(uuid),app.automation_document_template_save_noted(uuid,text,jsonb,integer,boolean,boolean,text),app.automation_document_template_action(uuid,integer,text,integer) TO ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.automation_document_deleted_head_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN IF OLD.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'This template was deleted' USING ERRCODE='40001';END IF;RETURN NEW;END $$;
REVOKE ALL ON FUNCTION app.automation_document_deleted_head_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER automation_document_deleted_head_guard BEFORE UPDATE ON public.automation_document_template FOR EACH ROW EXECUTE FUNCTION app.automation_document_deleted_head_guard();

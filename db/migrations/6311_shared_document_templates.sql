-- Shared document definitions. Immutable version bytes; the head selects the version in use.
CREATE TABLE public.automation_document_template (
 tenant_id uuid NOT NULL REFERENCES public.tenant(id), id uuid NOT NULL,
 module text NOT NULL CHECK(module IN('onb','off','contract_staff','probation')),name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 200),
 revision integer NOT NULL CHECK(revision>0), live_version integer, retired boolean NOT NULL DEFAULT false,
 updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id)
);
--> statement-breakpoint
CREATE TABLE public.automation_document_template_version (
 tenant_id uuid NOT NULL,template_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),
 definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object' AND octet_length(definition::text)<=1048576),
 saved_by uuid NOT NULL REFERENCES public.app_user(id),saved_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,template_id,version),FOREIGN KEY(tenant_id,template_id) REFERENCES public.automation_document_template(tenant_id,id)
);
--> statement-breakpoint
ALTER TABLE public.automation_document_template ADD CONSTRAINT automation_document_live_version_fk FOREIGN KEY(tenant_id,id,live_version) REFERENCES public.automation_document_template_version(tenant_id,template_id,version) DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE public.automation_document_template ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_document_template FORCE ROW LEVEL SECURITY;
ALTER TABLE public.automation_document_template_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_document_template_version FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY automation_document_template_owner ON public.automation_document_template FOR ALL TO ai_hr_owner USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
CREATE POLICY automation_document_template_version_owner ON public.automation_document_template_version FOR ALL TO ai_hr_owner USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
CREATE POLICY automation_document_template_read ON public.automation_document_template FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND app.automation_can_manage(module,'templates'));
CREATE POLICY automation_document_template_version_read ON public.automation_document_template_version FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM public.automation_document_template h WHERE h.tenant_id=automation_document_template_version.tenant_id AND h.id=automation_document_template_version.template_id AND app.automation_can_manage(h.module,'templates')));
--> statement-breakpoint
REVOKE ALL ON public.automation_document_template,public.automation_document_template_version FROM PUBLIC,ai_hr_app;
GRANT SELECT ON public.automation_document_template,public.automation_document_template_version TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.automation_document_template_save(p_template uuid,p_module text,p_definition jsonb,p_expected integer,p_publish boolean,p_retired boolean) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();h public.automation_document_template;n integer;
BEGIN
 PERFORM app.access_workforce_write_lock();
 IF t IS NULL OR app.current_user_id() IS NULL OR app.automation_can_manage(p_module,'templates') IS NOT TRUE THEN RAISE EXCEPTION 'Document templates are unavailable' USING ERRCODE='42501';END IF;
 IF p_template IS NULL OR p_definition IS NULL OR jsonb_typeof(p_definition) IS DISTINCT FROM 'object' OR p_definition->>'id' IS DISTINCT FROM p_template::text OR p_definition->>'module' IS DISTINCT FROM p_module
 OR length(btrim(coalesce(p_definition->>'name',''))) NOT BETWEEN 1 AND 200 OR octet_length(p_definition::text)>1048576 THEN RAISE EXCEPTION 'Invalid template' USING ERRCODE='22023';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('document-template:'||t::text||':'||p_template::text,0));
 SELECT * INTO h FROM public.automation_document_template WHERE tenant_id=t AND id=p_template FOR UPDATE;
 IF coalesce(h.revision,0) IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'Template changed; reload' USING ERRCODE='40001';END IF;
 IF h.id IS NOT NULL AND h.module<>p_module THEN RAISE EXCEPTION 'A template cannot change module' USING ERRCODE='22023';END IF;
 n:=coalesce(h.revision,0)+1;
 INSERT INTO public.automation_document_template(tenant_id,id,module,name,revision,live_version,retired) VALUES(t,p_template,p_module,btrim(p_definition->>'name'),n,CASE WHEN p_publish THEN n ELSE NULL END,p_retired)
 ON CONFLICT(tenant_id,id) DO UPDATE SET name=excluded.name,revision=n,live_version=CASE WHEN p_publish THEN n ELSE h.live_version END,retired=p_retired,updated_at=now();
 INSERT INTO public.automation_document_template_version(tenant_id,template_id,version,definition,saved_by) VALUES(t,p_template,n,p_definition,app.current_user_id());
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload) VALUES(t,'automation_document_template',p_template,CASE WHEN p_retired THEN 'automation.document.retired' WHEN p_publish THEN 'automation.document.published' ELSE 'automation.document.draft.saved' END,'user',app.current_user_id(),jsonb_build_object('version',n,'module',p_module));
 RETURN n;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.automation_document_template_save(uuid,text,jsonb,integer,boolean,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.automation_document_template_save(uuid,text,jsonb,integer,boolean,boolean) TO ai_hr_app;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.automation_template_choices(p_module text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.automation_can_manage(p_module,'workflows') IS NOT TRUE AND app.automation_can_manage(p_module,'templates') IS NOT TRUE THEN RAISE EXCEPTION 'Template choices are unavailable' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object(
 'emails',coalesce((SELECT jsonb_agg(to_jsonb(e)) FROM (SELECT DISTINCT ON(template_id) template_id AS id,name,active,retired,subject FROM public.automation_email_template_version WHERE tenant_id=app.current_tenant_id() AND module=p_module ORDER BY template_id,revision DESC LIMIT 500) e),'[]'::jsonb),
 'documents',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'name',name,'version',live_version)) FROM (SELECT id,name,live_version FROM public.automation_document_template WHERE tenant_id=app.current_tenant_id() AND module=p_module AND NOT retired AND live_version IS NOT NULL ORDER BY lower(name),id LIMIT 500) d),'[]'::jsonb));
END $$;

-- Register Contract configuration with the existing shared definition stores. Existing Probation permissions remain.
CREATE FUNCTION app.contract_shared_storage_runner() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.current_user_id() IS NULL AND EXISTS(SELECT 1 FROM pg_roles WHERE rolname=session_user AND (rolname='ai_hr_owner' OR rolsuper))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.contract_shared_storage_runner() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.automation_can_configure(p_module text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.current_tenant_id() IS NOT NULL AND CASE p_module
 WHEN 'probation' THEN app.probation_active_user() AND (app.access_capability_allowed('probation.module',NULL) OR app.probation_permitted_scope('settings.configure',NULL))
 WHEN 'contract_staff' THEN app.contract_verified_human(app.current_user_id()) AND EXISTS(SELECT 1 FROM public.company c
 WHERE c.tenant_id=app.current_tenant_id() AND c.archived_at IS NULL AND (app.contract_shared_permitted('workflows',c.id) OR app.contract_shared_permitted('templates',c.id) OR app.contract_shared_permitted('groups',c.id)))
 ELSE false END
$$;
--> statement-breakpoint
CREATE FUNCTION app.automation_can_manage(p_module text,p_kind text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(p_kind IN('workflows','templates','groups') AND CASE WHEN p_module='contract_staff' THEN
 app.contract_verified_human(app.current_user_id()) AND EXISTS(SELECT 1 FROM public.company c WHERE c.tenant_id=app.current_tenant_id() AND c.archived_at IS NULL AND app.contract_shared_permitted(p_kind,c.id))
 ELSE app.automation_can_configure(p_module) END,false)
$$;
--> statement-breakpoint
CREATE FUNCTION app.automation_can_manage_any(p_kind text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.automation_can_manage('probation',p_kind) OR app.automation_can_manage('contract_staff',p_kind) OR app.automation_can_manage('onb',p_kind) OR app.automation_can_manage('off',p_kind)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.automation_can_manage(text,text),app.automation_can_manage_any(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.automation_can_manage(text,text),app.automation_can_manage_any(text) TO ai_hr_app;
--> statement-breakpoint
ALTER POLICY automation_workflow_read ON public.automation_workflow_version USING(tenant_id=app.current_tenant_id() AND app.automation_can_manage(module,'workflows'));
ALTER POLICY automation_email_template_read ON public.automation_email_template_version USING(tenant_id=app.current_tenant_id() AND app.automation_can_manage(module,'templates'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.automation_run_subject_access(p_module text,p_subject uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(app.current_tenant_id() IS NOT NULL AND CASE p_module
 WHEN 'probation' THEN app.probation_active_user() AND app.probation_case_access(p_subject)
 WHEN 'contract_staff' THEN app.contract_shared_case_permitted(p_subject,'view') OR app.contract_shared_letter_assigned(p_subject)
 ELSE false END,false)
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.automation_can_run(p_module text,p_subject uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(app.current_tenant_id() IS NOT NULL AND p_subject IS NOT NULL AND CASE p_module
 WHEN 'probation' THEN app.probation_storage_runner() OR app.automation_run_subject_access(p_module,p_subject)
 WHEN 'contract_staff' THEN EXISTS(SELECT 1 FROM public.contract_shared_case c WHERE c.tenant_id=app.current_tenant_id() AND c.case_id=p_subject)
 AND (app.contract_shared_storage_runner() OR app.contract_shared_case_permitted(p_subject,'decide') OR app.contract_shared_letter_assigned(p_subject))
 ELSE false END,false)
$$;

--> statement-breakpoint
ALTER FUNCTION app.automation_workflow_save(uuid,text,text,boolean,jsonb,integer,text) RENAME TO automation_workflow_save_before_contract_permissions;
--> statement-breakpoint
CREATE FUNCTION app.automation_workflow_save(p_workflow uuid, p_module text, p_status text, p_required boolean, p_definition jsonb, p_expected integer, p_reason text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid := app.current_tenant_id(); prior public.automation_workflow_version; v_revision integer;
BEGIN
  IF t IS NULL OR app.current_user_id() IS NULL THEN RAISE EXCEPTION 'A signed-in tenant user is required' USING ERRCODE='42501'; END IF;
  PERFORM app.access_workforce_write_lock();
  IF p_workflow IS NULL OR NOT app.automation_can_manage(p_module,'workflows') THEN RAISE EXCEPTION 'You cannot configure workflows for this module' USING ERRCODE='42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('automation-workflow:'||t::text||':'||p_workflow::text, 0));
  SELECT * INTO prior FROM public.automation_workflow_version WHERE tenant_id = t AND workflow_id = p_workflow ORDER BY revision DESC LIMIT 1;
  IF coalesce(prior.revision, 0) IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'This workflow changed since you opened it; reload before saving' USING ERRCODE='40001'; END IF;
  IF prior.revision IS NOT NULL AND prior.module <> p_module THEN RAISE EXCEPTION 'A workflow cannot move to another module' USING ERRCODE='22023'; END IF;
  IF prior.status = 'retired' THEN RAISE EXCEPTION 'A retired workflow cannot change' USING ERRCODE='22023'; END IF;
  IF coalesce(p_status, '') NOT IN ('live','paused','retired') OR p_required IS NULL OR length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Choose a status and give a reason' USING ERRCODE='22023'; END IF;
  -- Each type is checked in its own statement before a function that would fail on another type: SQL does not
  -- promise the order in which OR operands are evaluated.
  IF jsonb_typeof(p_definition) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'The workflow definition is incomplete or too large' USING ERRCODE='22023'; END IF;
  IF jsonb_typeof(p_definition->'trigger') IS DISTINCT FROM 'object' OR jsonb_typeof(p_definition->'conditions') IS DISTINCT FROM 'array' OR jsonb_typeof(p_definition->'steps') IS DISTINCT FROM 'array'
  THEN RAISE EXCEPTION 'The workflow definition is incomplete or too large' USING ERRCODE='22023'; END IF;
  IF pg_column_size(p_definition) > 262144
     OR p_definition->>'module' IS DISTINCT FROM p_module OR p_definition->>'id' IS DISTINCT FROM p_workflow::text
     OR length(btrim(coalesce(p_definition->>'name', ''))) NOT BETWEEN 1 AND 200
     OR jsonb_typeof(p_definition->'trigger'->'event') IS DISTINCT FROM 'string'
     OR jsonb_array_length(p_definition->'conditions') > 20
     OR jsonb_array_length(p_definition->'steps') NOT BETWEEN (CASE WHEN p_module='contract_staff' AND p_status='paused' THEN 0 ELSE 1 END) AND 40
  THEN RAISE EXCEPTION 'The workflow definition is incomplete or too large' USING ERRCODE='22023'; END IF;
  v_revision := coalesce(prior.revision, 0) + 1;
  INSERT INTO public.automation_workflow_version (tenant_id, workflow_id, revision, module, status, required, definition, reason, saved_by)
  VALUES (t, p_workflow, v_revision, p_module, p_status, p_required, p_definition - 'status' - 'required', btrim(p_reason), app.current_user_id());
  INSERT INTO public.domain_event (tenant_id, aggregate_type, aggregate_id, event_type, actor_type, actor_id, payload)
  VALUES (t, 'automation_workflow', p_workflow, CASE WHEN v_revision = 1 THEN 'automation.workflow.created' ELSE 'automation.workflow.saved' END, 'user'::actor_type, app.current_user_id(),
    jsonb_build_object('module', p_module, 'revision', v_revision, 'status', p_status, 'previousStatus', prior.status, 'required', p_required));
  RETURN v_revision;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.automation_workflow_save_before_contract_permissions(uuid,text,text,boolean,jsonb,integer,text),app.automation_workflow_save(uuid,text,text,boolean,jsonb,integer,text) FROM PUBLIC,ai_hr_app;
GRANT EXECUTE ON FUNCTION app.automation_workflow_save(uuid,text,text,boolean,jsonb,integer,text) TO ai_hr_app;

--> statement-breakpoint
ALTER FUNCTION app.automation_routing_save(uuid,text,jsonb,boolean,integer,text) RENAME TO automation_routing_save_before_contract_permissions;
--> statement-breakpoint
CREATE FUNCTION app.automation_routing_save(p_routing uuid,p_name text,p_rows jsonb,p_retired boolean,p_expected integer,p_reason text) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM app.access_workforce_write_lock();
 IF app.automation_can_manage_any('groups') IS NOT TRUE THEN RAISE EXCEPTION 'This builder is unavailable' USING ERRCODE='42501';END IF;
 RETURN app.automation_routing_save_before_contract_permissions(p_routing,p_name,p_rows,p_retired,p_expected,p_reason);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.automation_routing_save_before_contract_permissions(uuid,text,jsonb,boolean,integer,text),app.automation_routing_save(uuid,text,jsonb,boolean,integer,text) FROM PUBLIC,ai_hr_app;
GRANT EXECUTE ON FUNCTION app.automation_routing_save(uuid,text,jsonb,boolean,integer,text) TO ai_hr_app;

--> statement-breakpoint
ALTER FUNCTION app.automation_email_template_save(uuid,text,text,boolean,text,text,jsonb,boolean,integer,text) RENAME TO automation_email_template_save_before_contract_permissions;
--> statement-breakpoint
CREATE FUNCTION app.automation_email_template_save(p_template uuid,p_module text,p_name text,p_active boolean,p_subject text,p_body text,p_cc jsonb,p_retired boolean,p_expected integer,p_reason text) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM app.access_workforce_write_lock();
 IF app.automation_can_manage(p_module,'templates') IS NOT TRUE THEN RAISE EXCEPTION 'This builder is unavailable' USING ERRCODE='42501';END IF;
 RETURN app.automation_email_template_save_before_contract_permissions(p_template,p_module,p_name,p_active,p_subject,p_body,p_cc,p_retired,p_expected,p_reason);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.automation_email_template_save_before_contract_permissions(uuid,text,text,boolean,text,text,jsonb,boolean,integer,text),app.automation_email_template_save(uuid,text,text,boolean,text,text,jsonb,boolean,integer,text) FROM PUBLIC,ai_hr_app;
GRANT EXECUTE ON FUNCTION app.automation_email_template_save(uuid,text,text,boolean,text,text,jsonb,boolean,integer,text) TO ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.automation_template_choices(p_module text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.automation_can_manage(p_module,'workflows') IS NOT TRUE AND app.automation_can_manage(p_module,'templates') IS NOT TRUE THEN RAISE EXCEPTION 'Template choices are unavailable' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('emails',coalesce((SELECT jsonb_agg(to_jsonb(e)) FROM (SELECT DISTINCT ON(template_id) template_id AS id,name,active,retired,subject FROM public.automation_email_template_version WHERE tenant_id=app.current_tenant_id() AND module=p_module ORDER BY template_id,revision DESC LIMIT 500) e),'[]'::jsonb));
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.automation_template_choices(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.automation_template_choices(text) TO ai_hr_app;

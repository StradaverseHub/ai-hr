-- Coordinated additive source claim0943 / when1793330000343 / aggregateidx765.
-- Domain publication remains unavailable until every declared native/read/effect owner is complete.
INSERT INTO public.access_capability(id,scope,supported,bindings)
 SELECT domain||'.'||operation,scope,false,'[]'::jsonb
 FROM (VALUES('claims','company'),('leave','company'),('attendance','company'),('claims_configuration','tenant'),('leave_configuration','tenant'),('attendance_configuration','tenant')) d(domain,scope)
 CROSS JOIN (VALUES('view'),('add'),('edit'),('delete')) o(operation);
--> statement-breakpoint
CREATE FUNCTION app.module_action_legacy_allowed(p_tenant uuid,p_user uuid,p_capability text,p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT p_capability ~ '^(claims|leave|attendance)(_configuration)?\.(view|add|edit|delete)$'
 AND EXISTS(SELECT 1 FROM public.app_user u JOIN public.role_assignment r ON r.tenant_id=u.tenant_id AND r.app_user_id=u.id
  WHERE u.tenant_id=p_tenant AND u.id=p_user AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
   AND CASE WHEN split_part(p_capability,'.',1) LIKE '%_configuration' THEN
    p_company IS NULL AND r.role::text IN ('hr_admin','super_admin')
   ELSE p_company IS NOT NULL AND r.role::text=ANY(CASE WHEN split_part(p_capability,'.',1)='attendance' THEN ARRAY['hr_admin','super_admin','payroll_partner'] ELSE ARRAY['hr_admin','super_admin'] END)
    AND app.access_scope_covers(r.company_id,p_company,p_tenant) END);
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.module_action_legacy_allowed(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.module_action_allowed(p_domain text,p_operation text,p_company uuid DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND app.module_action_legacy_allowed(app.current_tenant_id(),app.current_user_id(),p_domain||'.'||p_operation,p_company)
 AND EXISTS(SELECT 1 FROM public.access_capability c WHERE c.id=p_domain||'.'||p_operation
  AND (NOT c.supported OR (app.access_allowed_for(app.current_user_id(),c.id,p_company)
   AND app.access_allowed_for(app.current_user_id(),p_domain||'.view',p_company))));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.module_action_allowed(text,text,uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.module_action_allowed(text,text,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE TABLE app.module_action_resource(tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,kind text NOT NULL,resource_key text NOT NULL,born_xact xid8 NOT NULL,born_actor uuid,completed boolean NOT NULL DEFAULT false,PRIMARY KEY(tenant_id,kind,resource_key));
--> statement-breakpoint
REVOKE ALL ON TABLE app.module_action_resource FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.claim_configuration_insert_operation(p_kind text,p_row jsonb) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE resource_key text;existed boolean;resource app.module_action_resource%ROWTYPE;
BEGIN
 IF p_kind='claim_policy' THEN
  resource_key:=jsonb_build_array(p_row->'claim_type_id',p_row->'grade_id',p_row->'claim_item_id')::text;
  SELECT EXISTS(SELECT 1 FROM public.claim_policy p WHERE p.tenant_id=(p_row->>'tenant_id')::uuid AND p.claim_type_id=(p_row->>'claim_type_id')::uuid AND p.grade_id IS NOT DISTINCT FROM (p_row->>'grade_id')::uuid AND p.claim_item_id IS NOT DISTINCT FROM (p_row->>'claim_item_id')::uuid) INTO existed;
 ELSIF p_kind='claim_mileage_rate' THEN
  resource_key:=jsonb_build_array(p_row->'claim_type_id',p_row->'grade_id',p_row->'vehicle_class')::text;
  SELECT EXISTS(SELECT 1 FROM public.claim_mileage_rate p WHERE p.tenant_id=(p_row->>'tenant_id')::uuid AND p.claim_type_id=(p_row->>'claim_type_id')::uuid AND p.grade_id IS NOT DISTINCT FROM (p_row->>'grade_id')::uuid AND p.vehicle_class=p_row->>'vehicle_class') INTO existed;
 ELSE RAISE EXCEPTION 'Unbound configuration resource' USING ERRCODE='42501';END IF;
 -- Physical unique-key conflict serializes first publication; a pre-pinned invisible winner
 -- causes40001 rather than reclassifying an existing logical object as a new Add.
 INSERT INTO app.module_action_resource AS target(tenant_id,kind,resource_key,born_xact,born_actor) VALUES((p_row->>'tenant_id')::uuid,p_kind,resource_key,CASE WHEN existed THEN '0'::xid8 ELSE pg_current_xact_id() END,app.current_user_id())
 ON CONFLICT ON CONSTRAINT module_action_resource_pkey DO UPDATE SET born_actor=target.born_actor RETURNING * INTO resource;
 RETURN CASE WHEN resource.born_xact=pg_current_xact_id() AND resource.born_actor=app.current_user_id() THEN 'add' ELSE 'edit' END;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.claim_configuration_insert_operation(text,jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.module_configuration_action_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE before_row jsonb:=CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
 after_row jsonb:=CASE WHEN TG_OP='DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;
 domain text:=TG_ARGV[0];operation text:=CASE TG_OP WHEN 'INSERT' THEN 'add' WHEN 'DELETE' THEN 'delete' ELSE 'edit' END;
BEGIN
 IF app.access_workforce_storage_owner() THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 PERFORM app.access_workforce_write_lock();
 IF COALESCE(after_row->>'tenant_id',before_row->>'tenant_id') IS DISTINCT FROM app.current_tenant_id()::text
  OR TG_OP='UPDATE' AND ((after_row->>'tenant_id') IS DISTINCT FROM before_row->>'tenant_id' OR after_row->>'id' IS DISTINCT FROM before_row->>'id') THEN
  RAISE EXCEPTION 'Module action subject unavailable' USING ERRCODE='42501';END IF;
 IF TG_OP='UPDATE' AND ((before_row->>'archived_at' IS NULL AND after_row->>'archived_at' IS NOT NULL)
  OR before_row->>'active'='true' AND after_row->>'active'='false') THEN operation:='delete';END IF;
 -- A policy's dated replacement is an Edit of its logical key. Initial bands are one Add course.
 IF TG_OP='INSERT' AND TG_TABLE_NAME IN ('claim_policy','claim_mileage_rate') THEN operation:=app.claim_configuration_insert_operation(TG_TABLE_NAME,after_row);END IF;
 IF NOT app.module_action_allowed(domain,operation,NULL) AND NOT (TG_OP='UPDATE' AND TG_TABLE_NAME IN ('claim_policy','claim_mileage_rate') AND before_row->>'valid_to' IS NULL AND after_row->>'valid_to' IS NOT NULL AND app.module_action_allowed(domain,'delete',NULL)) THEN RAISE EXCEPTION 'Module configuration action unavailable' USING ERRCODE='42501';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.module_configuration_action_guard() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
DO $$ DECLARE table_name text;BEGIN
 FOREACH table_name IN ARRAY ARRAY['claim_type','claim_item','claim_policy','claim_mileage_rate','claim_form_field'] LOOP
  EXECUTE format('CREATE TRIGGER module_configuration_action BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.module_configuration_action_guard(%L)',table_name,'claims_configuration');
 END LOOP;
END $$;

--> statement-breakpoint
CREATE TABLE app.module_configuration_insert_receipt(xact_id xid8 NOT NULL,tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,user_id uuid NOT NULL,kind text NOT NULL,row_id uuid NOT NULL,resource_key text NOT NULL,valid_from date,PRIMARY KEY(xact_id,tenant_id,user_id,kind,row_id));
--> statement-breakpoint
REVOKE ALL ON TABLE app.module_configuration_insert_receipt FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.claim_configuration_resource_born() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE subject_key text;row_data jsonb:=to_jsonb(NEW);
BEGIN
 IF app.access_workforce_storage_owner() THEN RETURN NEW;END IF;
 subject_key:=CASE TG_TABLE_NAME WHEN 'claim_policy' THEN jsonb_build_array(row_data->'claim_type_id',row_data->'grade_id',row_data->'claim_item_id')::text ELSE jsonb_build_array(row_data->'claim_type_id',row_data->'grade_id',row_data->'vehicle_class')::text END;
 DELETE FROM app.module_configuration_insert_receipt WHERE tenant_id=NEW.tenant_id AND xact_id<>pg_current_xact_id();
 INSERT INTO app.module_configuration_insert_receipt VALUES(pg_current_xact_id(),NEW.tenant_id,app.current_user_id(),TG_TABLE_NAME,NEW.id,subject_key,(row_data->>'valid_from')::date);
 UPDATE app.module_action_resource r SET completed=true WHERE r.tenant_id=NEW.tenant_id AND r.kind=TG_TABLE_NAME AND r.resource_key=subject_key;
 RETURN NEW;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.claim_configuration_resource_born() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE TRIGGER claim_configuration_resource_born AFTER INSERT ON claim_policy FOR EACH ROW EXECUTE FUNCTION app.claim_configuration_resource_born();
--> statement-breakpoint
CREATE TRIGGER claim_configuration_resource_born AFTER INSERT ON claim_mileage_rate FOR EACH ROW EXECUTE FUNCTION app.claim_configuration_resource_born();
--> statement-breakpoint
CREATE FUNCTION app.module_action_resource_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 -- A skipped INSERT/UPSERT is not an installed logical resource and cannot poison future Add.
 DELETE FROM app.module_action_resource r WHERE r.tenant_id=NEW.tenant_id AND r.kind=NEW.kind AND r.resource_key=NEW.resource_key AND NOT r.completed AND r.born_xact=pg_current_xact_id();
 RETURN NULL;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.module_action_resource_complete() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER module_action_resource_complete AFTER INSERT ON app.module_action_resource DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.module_action_resource_complete();
--> statement-breakpoint
CREATE FUNCTION app.claim_configuration_admit(p_kind text,p_claim_type uuid,p_grade uuid DEFAULT NULL,p_item uuid DEFAULT NULL,p_vehicle text DEFAULT NULL) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE operation text;
BEGIN
 PERFORM app.access_workforce_write_lock();
 IF NOT app.module_action_allowed('claims_configuration','view',NULL) THEN RAISE EXCEPTION 'Module configuration unavailable' USING ERRCODE='42501';END IF;
 operation:=app.claim_configuration_insert_operation(p_kind,jsonb_build_object('tenant_id',app.current_tenant_id(),'claim_type_id',p_claim_type,'grade_id',p_grade,'claim_item_id',p_item,'vehicle_class',p_vehicle));
 IF NOT app.module_action_allowed('claims_configuration',operation,NULL) THEN RAISE EXCEPTION 'Module configuration action unavailable' USING ERRCODE='42501';END IF;
 RETURN operation;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.claim_configuration_admit(text,uuid,uuid,uuid,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.claim_configuration_admit(text,uuid,uuid,uuid,text) TO ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.claim_configuration_range_close() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE old_row jsonb:=to_jsonb(OLD);new_row jsonb:=to_jsonb(NEW);subject_key text;replacement boolean;
BEGIN
 IF app.access_workforce_storage_owner() OR old_row->>'valid_to' IS NOT NULL OR new_row->>'valid_to' IS NULL THEN RETURN NULL;END IF;
 subject_key:=CASE TG_TABLE_NAME WHEN 'claim_policy' THEN jsonb_build_array(new_row->'claim_type_id',new_row->'grade_id',new_row->'claim_item_id')::text ELSE jsonb_build_array(new_row->'claim_type_id',new_row->'grade_id',new_row->'vehicle_class')::text END;
 SELECT EXISTS(SELECT 1 FROM app.module_configuration_insert_receipt r WHERE r.xact_id=pg_current_xact_id() AND r.tenant_id=NEW.tenant_id AND r.user_id=app.current_user_id() AND r.kind=TG_TABLE_NAME AND r.resource_key=subject_key AND r.valid_from=(new_row->>'valid_to')::date) INTO replacement;
 IF NOT app.module_action_allowed('claims_configuration',CASE WHEN replacement THEN 'edit' ELSE 'delete' END,NULL) THEN RAISE EXCEPTION 'Dated configuration action unavailable' USING ERRCODE='42501';END IF;
 RETURN NULL;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.claim_configuration_range_close() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER claim_configuration_range_close AFTER UPDATE ON claim_policy DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.claim_configuration_range_close();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER claim_configuration_range_close AFTER UPDATE ON claim_mileage_rate DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.claim_configuration_range_close();

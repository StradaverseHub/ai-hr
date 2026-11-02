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
   ELSE r.role::text=ANY(CASE WHEN split_part(p_capability,'.',1)='attendance' THEN ARRAY['hr_admin','super_admin','payroll_partner'] ELSE ARRAY['hr_admin','super_admin'] END)
    AND CASE WHEN p_company IS NULL THEN r.company_id IS NULL ELSE app.access_scope_covers(r.company_id,p_company,p_tenant) END END);
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.module_action_legacy_allowed(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Stored target/recovery authority and current execution claims are deliberately separate.
-- Tenant configuration keeps its native ANY-HR course; company work requires the claimed scope.
CREATE FUNCTION app.module_action_current_legacy_allowed(p_tenant uuid,p_user uuid,p_capability text,p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT p_tenant=app.current_tenant_id() AND p_user=app.current_user_id() AND app.principal_snapshot_current()
 AND p_capability ~ '^(claims|leave|attendance)(_configuration)?\.(view|add|edit|delete)$'
 AND CASE WHEN split_part(p_capability,'.',1) LIKE '%_configuration' THEN p_company IS NULL AND app.is_admin()
  ELSE p_company IS NOT NULL AND (app.is_admin_for(p_company)
   OR split_part(p_capability,'.',1)='attendance' AND app.has_role_for('payroll_partner',p_company)) END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.module_action_current_legacy_allowed(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.module_action_current_native_default(t uuid,u uuid,cap text,co uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT t=app.current_tenant_id() AND u=app.current_user_id() AND app.principal_snapshot_current()
 AND app.module_action_legacy_allowed(t,u,cap,co)
 AND CASE WHEN co IS NULL AND cap ~ '^(claims|leave|attendance)\.' THEN EXISTS(SELECT 1 FROM app.current_grants() g WHERE g.company_id IS NULL AND g.role=ANY(CASE WHEN cap LIKE 'attendance.%' THEN ARRAY['hr_admin','super_admin','payroll_partner'] ELSE ARRAY['hr_admin','super_admin'] END))
  ELSE app.module_action_current_legacy_allowed(t,u,cap,co) END;
$$;
REVOKE ALL ON FUNCTION app.module_action_current_native_default(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.module_action_delegation_allowed(t uuid,u uuid,cap text,co uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.module_action_current_native_default(t,u,cap,co)
 AND (cap !~ '^(leave_configuration|attendance_configuration)\.(add|edit|delete)$' OR app.is_group_admin())
 AND (cap !~ '^attendance\.(add|edit|delete)$' OR CASE WHEN co IS NULL THEN app.is_group_admin() ELSE app.is_admin_for(co) END);
$$;
REVOKE ALL ON FUNCTION app.module_action_delegation_allowed(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.module_action_allowed(p_domain text,p_operation text,p_company uuid DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.module_action_current_legacy_allowed(app.current_tenant_id(),app.current_user_id(),p_domain||'.'||p_operation,p_company) AND app.module_action_legacy_allowed(app.current_tenant_id(),app.current_user_id(),p_domain||'.'||p_operation,p_company)
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
-- One native fact owner for dated logical resource identity/history. A read projection does not
-- reserve a resource, take write admission, or mint a successful Add course.
CREATE FUNCTION app.claim_configuration_resource_fact(p_kind text,p_row jsonb) RETURNS TABLE(resource_key text,existed boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE p_kind WHEN 'claim_policy' THEN jsonb_build_array(p_row->'claim_type_id',p_row->'grade_id',p_row->'claim_item_id')::text ELSE jsonb_build_array(p_row->'claim_type_id',p_row->'grade_id',p_row->'vehicle_class')::text END,
 CASE p_kind WHEN 'claim_policy' THEN EXISTS(SELECT 1 FROM public.claim_policy p WHERE p.tenant_id=(p_row->>'tenant_id')::uuid AND p.claim_type_id=(p_row->>'claim_type_id')::uuid AND p.grade_id IS NOT DISTINCT FROM (p_row->>'grade_id')::uuid AND p.claim_item_id IS NOT DISTINCT FROM (p_row->>'claim_item_id')::uuid)
 ELSE EXISTS(SELECT 1 FROM public.claim_mileage_rate p WHERE p.tenant_id=(p_row->>'tenant_id')::uuid AND p.claim_type_id=(p_row->>'claim_type_id')::uuid AND p.grade_id IS NOT DISTINCT FROM (p_row->>'grade_id')::uuid AND p.vehicle_class=p_row->>'vehicle_class') END
 WHERE p_kind IN ('claim_policy','claim_mileage_rate');
$$;
REVOKE ALL ON FUNCTION app.claim_configuration_resource_fact(text,jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.claim_configuration_insert_operation(p_kind text,p_row jsonb) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE resource_key text;existed boolean;resource app.module_action_resource%ROWTYPE;
BEGIN
 SELECT fact.resource_key,fact.existed INTO resource_key,existed FROM app.claim_configuration_resource_fact(p_kind,p_row) fact;
 IF NOT FOUND THEN RAISE EXCEPTION 'Unbound configuration resource' USING ERRCODE='42501';END IF;
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
 function_key text:=CASE TG_TABLE_NAME WHEN 'claim_policy' THEN 'claimsConfig.limits' WHEN 'claim_mileage_rate' THEN 'claimsConfig.mileage' ELSE 'claimsConfig.types' END;
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
 IF NOT (app.module_action_allowed(domain,operation,NULL) AND app.function_action_allowed(function_key,operation,NULL)) AND NOT (TG_OP='UPDATE' AND TG_TABLE_NAME IN ('claim_policy','claim_mileage_rate') AND before_row->>'valid_to' IS NULL AND after_row->>'valid_to' IS NOT NULL AND app.module_action_allowed(domain,'delete',NULL) AND app.function_action_allowed(function_key,'delete',NULL)) THEN RAISE EXCEPTION 'Module configuration action unavailable' USING ERRCODE='42501';END IF;
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
 DELETE FROM app.module_configuration_insert_receipt WHERE tenant_id=NEW.tenant_id AND xact_id<pg_snapshot_xmin(pg_current_snapshot());
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
 IF NOT app.module_action_allowed('claims_configuration',operation,NULL) OR NOT app.function_action_allowed(CASE p_kind WHEN 'claim_policy' THEN 'claimsConfig.limits' WHEN 'claim_mileage_rate' THEN 'claimsConfig.mileage' END,operation,NULL) THEN RAISE EXCEPTION 'Module configuration action unavailable' USING ERRCODE='42501';END IF;
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
 SELECT EXISTS(SELECT 1 FROM app.module_configuration_insert_receipt r WHERE r.xact_id=pg_current_xact_id() AND r.tenant_id=NEW.tenant_id AND r.user_id=app.current_user_id() AND r.kind=TG_TABLE_NAME AND r.resource_key=subject_key AND r.valid_from=(new_row->>'valid_to')::date
  AND CASE WHEN TG_TABLE_NAME='claim_policy' THEN EXISTS(SELECT 1 FROM public.claim_policy p WHERE p.tenant_id=r.tenant_id AND p.id=r.row_id AND p.valid_from=r.valid_from AND jsonb_build_array(p.claim_type_id,p.grade_id,p.claim_item_id)::text=r.resource_key)
   ELSE EXISTS(SELECT 1 FROM public.claim_mileage_rate p WHERE p.tenant_id=r.tenant_id AND p.id=r.row_id AND p.valid_from=r.valid_from AND jsonb_build_array(p.claim_type_id,p.grade_id,p.vehicle_class)::text=r.resource_key) END) INTO replacement;
 IF NOT app.module_action_allowed('claims_configuration',CASE WHEN replacement THEN 'edit' ELSE 'delete' END,NULL) OR NOT app.function_action_allowed(CASE TG_TABLE_NAME WHEN 'claim_policy' THEN 'claimsConfig.limits' ELSE 'claimsConfig.mileage' END,CASE WHEN replacement THEN 'edit' ELSE 'delete' END,NULL) THEN RAISE EXCEPTION 'Dated configuration action unavailable' USING ERRCODE='42501';END IF;
 RETURN NULL;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.claim_configuration_range_close() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER claim_configuration_range_close AFTER UPDATE ON claim_policy DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.claim_configuration_range_close();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER claim_configuration_range_close AFTER UPDATE ON claim_mileage_rate DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.claim_configuration_range_close();


--> statement-breakpoint
-- Exact maintained Claim configuration submenus. /forms is only a Types redirect, never a
-- second independent permission purpose. Reimbursement payments have separate company owners.
CREATE FUNCTION app.module_function_legacy_allowed(t uuid,u uuid,cap text,co uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app.access_function_action a WHERE a.capability_id=cap
  AND a.function_key IN ('claimsConfig.types','claimsConfig.limits','claimsConfig.mileage','claimsConfig.reimbursements','claims.administration','leaveConfig.types','leaveConfig.gradeGroups','attendancePolicy.schedule')
  AND app.module_action_legacy_allowed(t,u,a.parent_capability,co));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.module_function_legacy_allowed(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.module_function_current_legacy_allowed(t uuid,u uuid,cap text,co uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app.access_function_action a WHERE a.capability_id=cap
  AND a.function_key IN ('claimsConfig.types','claimsConfig.limits','claimsConfig.mileage','claimsConfig.reimbursements','claims.administration','leaveConfig.types','leaveConfig.gradeGroups','attendancePolicy.schedule')
  AND app.module_action_current_native_default(t,u,a.parent_capability,co));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.module_function_current_legacy_allowed(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
DO $$ DECLARE selected_key text;operation text;BEGIN
 FOREACH selected_key IN ARRAY ARRAY['types','limits','mileage'] LOOP
  FOREACH operation IN ARRAY ARRAY['view','add','edit','delete'] LOOP
   PERFORM app.register_function_action('claimsConfig.'||selected_key,operation,'tenant','claims_configuration.'||operation,'app.module_action_current_legacy_allowed',
    jsonb_build_object('moduleKey','claims','labelKey','admin.claimsTabs.'||selected_key,'kind','submenu','course','administrative','screenKey','claimsConfig','href',CASE WHEN selected_key='types' THEN '/admin/claims' ELSE '/admin/claims/'||selected_key END,'employeeBearing',false));
  END LOOP;
 END LOOP;
END $$;

--> statement-breakpoint
CREATE FUNCTION app.module_function_allowed(p_key text,p_operation text,p_company uuid DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce((SELECT app.module_action_allowed(split_part(a.parent_capability,'.',1),split_part(a.parent_capability,'.',2),p_company)
  AND app.function_action_allowed(p_key,p_operation,p_company)
  FROM app.access_function_action a WHERE a.function_key=p_key AND a.operation=p_operation
   AND a.function_key IN ('claimsConfig.types','claimsConfig.limits','claimsConfig.mileage','claimsConfig.reimbursements','claims.administration','leaveConfig.types','leaveConfig.gradeGroups','attendancePolicy.schedule')),false);
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.module_function_allowed(text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.module_function_allowed(text,text,uuid) TO ai_hr_app;

--> statement-breakpoint
-- Finite native claim cancellation/reimbursement ports. Runtime cannot mint their effect proofs.
CREATE TABLE app.module_claim_effect(
 xact_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,claim_id uuid NOT NULL,
 course text NOT NULL CHECK(course IN ('own_cancel','admin_cancel','reimbursement')),
 before_hash text NOT NULL,after_hash text NOT NULL,event_id uuid NOT NULL,authority_stamp text NOT NULL,
 PRIMARY KEY(xact_id,tenant_id,user_id,claim_id,before_hash,after_hash)
);
REVOKE ALL ON app.module_claim_effect FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.claim_own_native_allowed(t uuid,u uuid,cap text,co uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT (cap IN ('function.claims.own.view','function.claims.own.delete') OR cap ~ '^function\.claims\.own\.(drafts\.(view|add|edit|delete)|submit\.(view|execute)|receipts\.(view|add))$') AND co IS NOT NULL
 AND EXISTS(SELECT 1 FROM public.app_user actor JOIN public.employment e ON e.tenant_id=actor.tenant_id AND e.person_id=actor.person_id
  WHERE actor.id=u AND actor.tenant_id=t AND actor.archived_at IS NULL AND NOT app.login_blocked(actor.id)
   AND e.company_id=co AND e.voided_at IS NULL);
$$;
--> statement-breakpoint
CREATE FUNCTION app.claim_own_current_native_allowed(t uuid,u uuid,cap text,co uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT t=app.current_tenant_id() AND u=app.current_user_id() AND app.principal_snapshot_current() AND app.claim_own_native_allowed(t,u,cap,co);
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.claim_own_native_allowed(uuid,uuid,text,uuid),app.claim_own_current_native_allowed(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
DO $$ BEGIN
 PERFORM app.register_function_action('claims.own','view','company',NULL,'app.claim_own_current_native_allowed','{"moduleKey":"claims","labelKey":"claims.accessFunctions.own","kind":"native_acl","course":"own","employeeBearing":false}'::jsonb);
 PERFORM app.register_function_action('claims.own','delete','company',NULL,'app.claim_own_current_native_allowed','{}'::jsonb);
 PERFORM app.register_function_action('claims.administration','view','company','claims.view','app.module_action_delegation_allowed','{"moduleKey":"claims","labelKey":"claims.accessFunctions.administration","kind":"native_acl","course":"administrative","employeeBearing":true}'::jsonb);
 PERFORM app.register_function_action('claims.administration','delete','company','claims.delete','app.module_action_delegation_allowed','{}'::jsonb);
 PERFORM app.register_function_action('claimsConfig.reimbursements','view','company','claims.view','app.module_action_delegation_allowed','{"moduleKey":"claims","labelKey":"admin.claimsTabs.reimbursements","kind":"submenu","course":"administrative","screenKey":"claimsConfig","href":"/admin/claims/reimbursements","employeeBearing":true}'::jsonb);
 PERFORM app.register_function_action('claimsConfig.reimbursements','execute','company','claims.edit','app.module_action_delegation_allowed','{}'::jsonb);
END $$;
--> statement-breakpoint
CREATE FUNCTION app.claim_cancel_native(p_claim uuid,p_expected_employment uuid DEFAULT NULL) RETURNS TABLE(event_id uuid,employment_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE selected public.claim_request%ROWTYPE;person_id uuid;company_id uuid;own_course boolean;after_row jsonb;audit uuid;authority text;
BEGIN
 PERFORM app.access_workforce_write_lock();
 IF NOT app.principal_snapshot_current() THEN RAISE EXCEPTION 'Claim cancellation unavailable' USING ERRCODE='42501';END IF;
 PERFORM app.claim_command_lock();
 SELECT q.* INTO selected FROM public.claim_request q WHERE q.id=p_claim AND q.tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Claim not found' USING ERRCODE='42501';END IF;
 SELECT e.person_id,e.company_id INTO person_id,company_id FROM public.employment e WHERE e.id=selected.employment_id AND e.tenant_id=selected.tenant_id AND e.voided_at IS NULL;
 own_course:=app.is_self_person(person_id);
 IF company_id IS NULL OR NOT (own_course OR app.can_admin_employment(selected.employment_id)) THEN RAISE EXCEPTION 'Only the claimant or an admin can cancel this claim' USING ERRCODE='42501';END IF;
 IF p_expected_employment IS NOT NULL AND p_expected_employment IS DISTINCT FROM selected.employment_id THEN RAISE EXCEPTION 'Claim does not belong to the selected employment' USING ERRCODE='42501';END IF;
 IF selected.status::text<>'pending' THEN RAISE EXCEPTION 'Only a pending claim can be cancelled' USING ERRCODE='55000';END IF;
 IF own_course THEN
  IF NOT app.function_action_allowed('claims.own','delete',company_id) THEN RAISE EXCEPTION 'Claim cancellation unavailable' USING ERRCODE='42501';END IF;
 ELSE
  IF NOT app.module_action_allowed('claims','delete',company_id) OR NOT app.function_action_allowed('claims.administration','delete',company_id) THEN RAISE EXCEPTION 'Claim cancellation unavailable' USING ERRCODE='42501';END IF;
 END IF;
 authority:=app.claim_command_authority_stamp();
 UPDATE public.claim_request q SET status='cancelled' WHERE q.id=selected.id AND q.tenant_id=selected.tenant_id RETURNING to_jsonb(q) INTO after_row;
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id)
 VALUES(selected.tenant_id,'claim-request',selected.id,'claim-request.cancelled','user',app.current_user_id(),selected.employment_id) RETURNING id INTO audit;
 DELETE FROM app.module_claim_effect WHERE xact_id<pg_snapshot_xmin(pg_current_snapshot());
 INSERT INTO app.module_claim_effect VALUES(pg_current_xact_id(),selected.tenant_id,app.current_user_id(),selected.id,CASE WHEN own_course THEN 'own_cancel' ELSE 'admin_cancel' END,
  encode(sha256(convert_to(to_jsonb(selected)::text,'UTF8')),'hex'),encode(sha256(convert_to(after_row::text,'UTF8')),'hex'),audit,authority);
 RETURN QUERY SELECT audit,selected.employment_id;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.claim_cancel_native(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_cancel_native(uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.claim_reimburse_native(p_claims uuid[],p_reference text DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE selected public.claim_request%ROWTYPE;company_id uuid;after_row jsonb;audit uuid;authority text;paid integer:=0;
 at_time timestamptz:=statement_timestamp();reference text:=coalesce(p_reference,'reimbursement');
BEGIN
 PERFORM app.access_workforce_write_lock();
 IF NOT app.principal_snapshot_current() OR p_claims IS NULL OR cardinality(p_claims)>10000 OR length(reference)>4000 THEN RAISE EXCEPTION 'Claim reimbursement unavailable' USING ERRCODE='42501';END IF;
 PERFORM app.claim_command_lock();
 DELETE FROM app.module_claim_effect WHERE xact_id<pg_snapshot_xmin(pg_current_snapshot());
 FOR selected IN SELECT q.* FROM public.claim_request q WHERE q.id=ANY(p_claims) AND q.tenant_id=app.current_tenant_id() AND q.status::text='approved' AND NOT q.taxable ORDER BY q.id FOR UPDATE LOOP
  SELECT e.company_id INTO company_id FROM public.employment e WHERE e.id=selected.employment_id AND e.tenant_id=selected.tenant_id AND e.voided_at IS NULL;
  IF company_id IS NULL OR NOT app.can_admin_employment(selected.employment_id) OR NOT app.module_action_allowed('claims','edit',company_id)
   OR NOT app.function_action_allowed('claimsConfig.reimbursements','execute',company_id) THEN RAISE EXCEPTION 'Claim reimbursement unavailable' USING ERRCODE='42501';END IF;
  authority:=app.claim_command_authority_stamp();
  UPDATE public.claim_request q SET status='paid',paid_at=at_time,payout_ref=reference WHERE q.id=selected.id AND q.tenant_id=selected.tenant_id RETURNING to_jsonb(q) INTO after_row;
  INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload)
  VALUES(selected.tenant_id,'claim-request',selected.id,'claim-request.paid','user',app.current_user_id(),selected.employment_id,jsonb_build_object('via','reimbursement','payoutRef',reference)) RETURNING id INTO audit;
  INSERT INTO app.module_claim_effect VALUES(pg_current_xact_id(),selected.tenant_id,app.current_user_id(),selected.id,'reimbursement',
   encode(sha256(convert_to(to_jsonb(selected)::text,'UTF8')),'hex'),encode(sha256(convert_to(after_row::text,'UTF8')),'hex'),audit,authority);
  paid:=paid+1;
 END LOOP;RETURN paid;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.claim_reimburse_native(uuid[],text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_reimburse_native(uuid[],text) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.claim_native_effect_approved(p_claim uuid,p_before jsonb,p_after jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND EXISTS(SELECT 1 FROM app.module_claim_effect proof
 JOIN public.employment e ON e.tenant_id=proof.tenant_id AND e.id=(p_after->>'employment_id')::uuid
 JOIN public.domain_event audit ON audit.tenant_id=proof.tenant_id AND audit.id=proof.event_id AND audit.aggregate_id=proof.claim_id AND audit.aggregate_type='claim-request' AND audit.actor_type='user' AND audit.actor_id=proof.user_id AND audit.subject_employment_id=e.id
 WHERE proof.xact_id=pg_current_xact_id() AND proof.tenant_id=app.current_tenant_id() AND proof.user_id=app.current_user_id() AND proof.claim_id=p_claim
 AND proof.before_hash=encode(sha256(convert_to(p_before::text,'UTF8')),'hex') AND proof.after_hash=encode(sha256(convert_to(p_after::text,'UTF8')),'hex')
 AND CASE proof.course WHEN 'own_cancel' THEN app.is_self_person(e.person_id) AND app.function_action_allowed('claims.own','delete',e.company_id) AND audit.event_type='claim-request.cancelled'
 WHEN 'admin_cancel' THEN app.can_admin_employment(e.id) AND app.module_action_allowed('claims','delete',e.company_id) AND app.function_action_allowed('claims.administration','delete',e.company_id) AND audit.event_type='claim-request.cancelled'
 WHEN 'reimbursement' THEN app.can_admin_employment(e.id) AND app.module_action_allowed('claims','edit',e.company_id) AND app.function_action_allowed('claimsConfig.reimbursements','execute',e.company_id) AND audit.event_type='claim-request.paid' AND audit.payload->>'via'='reimbursement' END);
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.claim_native_effect_approved(uuid,jsonb,jsonb) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.claim_payment_and_cancel_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE before_row jsonb:=CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
 after_row jsonb:=CASE WHEN TG_OP='DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;
BEGIN
 IF app.access_workforce_storage_owner() THEN RETURN NULL;END IF;
 PERFORM app.access_workforce_write_lock();
 IF TG_OP='UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.employment_id IS DISTINCT FROM OLD.employment_id) THEN RAISE EXCEPTION 'Claim identity cannot be reassigned' USING ERRCODE='42501';END IF;
 IF TG_OP='UPDATE' AND app.claim_native_effect_approved(NEW.id,before_row,after_row) THEN RETURN NULL;END IF;
 IF TG_OP='UPDATE' AND app.financial_claim_payment_approved(NEW.id,before_row,after_row) THEN RETURN NULL;END IF;
 -- A raw administrative role or payroll intent alone cannot authorize a payout/cancellation.
 -- Check each queued OLD/NEW image, not only the final restored row.
 IF TG_OP='INSERT' AND (NEW.status::text IN ('paid','cancelled') OR NEW.payroll_batch_id IS NOT NULL OR NEW.paid_at IS NOT NULL OR NEW.payout_ref IS NOT NULL)
 OR TG_OP='UPDATE' AND (OLD.status::text IN ('paid','cancelled') OR NEW.status::text IN ('paid','cancelled') OR NEW.payroll_batch_id IS DISTINCT FROM OLD.payroll_batch_id OR NEW.paid_at IS DISTINCT FROM OLD.paid_at OR NEW.payout_ref IS DISTINCT FROM OLD.payout_ref) THEN
  RAISE EXCEPTION 'Claim payment or cancellation source unavailable' USING ERRCODE='42501';
 END IF;
 RETURN NULL;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.claim_payment_and_cancel_guard() FROM PUBLIC,ai_hr_app;
CREATE CONSTRAINT TRIGGER claim_payment_and_cancel_guard AFTER INSERT OR UPDATE ON public.claim_request DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.claim_payment_and_cancel_guard();

--> statement-breakpoint
-- Maintenance-purpose library guard; shared employee/reference/calculation SELECT remains native.
CREATE FUNCTION app.module_catalogue_action_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE old_row jsonb:=CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
 new_row jsonb:=CASE WHEN TG_OP='DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;
 operation text:=CASE TG_OP WHEN 'INSERT' THEN 'add' WHEN 'DELETE' THEN 'delete' ELSE 'edit' END;
BEGIN
 IF app.access_workforce_storage_owner() THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 PERFORM app.access_workforce_write_lock();
 IF coalesce(new_row->>'tenant_id',old_row->>'tenant_id') IS DISTINCT FROM app.current_tenant_id()::text
  OR TG_OP='UPDATE' AND (old_row->>'id' IS DISTINCT FROM new_row->>'id' OR old_row->>'tenant_id' IS DISTINCT FROM new_row->>'tenant_id') THEN RAISE EXCEPTION 'Module catalogue identity unavailable' USING ERRCODE='42501';END IF;
 IF TG_OP='UPDATE' AND old_row->>'archived_at' IS NULL AND new_row->>'archived_at' IS NOT NULL THEN operation:='delete';END IF;
 -- Only a possible exact reference removal may wait for its actual deleted-source proof.
 IF TG_TABLE_NAME='leave_type' AND TG_OP='UPDATE' AND old_row->>'balance_source_type_id' IS NOT NULL AND new_row->>'balance_source_type_id' IS NULL
  AND (old_row-ARRAY['balance_source_type_id','updated_at']) IS NOT DISTINCT FROM (new_row-ARRAY['balance_source_type_id','updated_at'])
  AND app.module_action_allowed('leave_configuration','delete',NULL) AND app.function_action_allowed('leaveConfig.types','delete',NULL) THEN RETURN NEW;END IF;
 IF NOT app.module_action_allowed(TG_ARGV[0],operation,NULL) OR NOT app.function_action_allowed(TG_ARGV[1],operation,NULL) THEN RAISE EXCEPTION 'Module catalogue action unavailable' USING ERRCODE='42501';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.module_catalogue_action_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER module_catalogue_action BEFORE INSERT OR UPDATE OR DELETE ON public.leave_type FOR EACH ROW EXECUTE FUNCTION app.module_catalogue_action_guard('leave_configuration','leaveConfig.types');
--> statement-breakpoint
DO $$ DECLARE operation text;BEGIN
 FOREACH operation IN ARRAY ARRAY['view','add','edit','delete'] LOOP
  PERFORM app.register_function_action('leaveConfig.types',operation,'tenant','leave_configuration.'||operation,'app.module_action_current_legacy_allowed','{"moduleKey":"leave","labelKey":"admin.leave.typesSectionTitle","kind":"submenu","course":"administrative","screenKey":"leaveConfig","href":"/admin/leave-config/types","employeeBearing":false}'::jsonb);
 END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.module_configuration_write_lock() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT app.access_workforce_storage_owner() THEN PERFORM app.access_workforce_write_lock();END IF;RETURN NULL;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.module_configuration_write_lock() FROM PUBLIC,ai_hr_app;
DO $$ DECLARE relation_name text;BEGIN
 FOREACH relation_name IN ARRAY ARRAY['claim_type','claim_item','claim_policy','claim_mileage_rate','claim_form_field','leave_type','leave_request','leave_request_date'] LOOP
  EXECUTE format('CREATE TRIGGER module_configuration_write_lock BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION app.module_configuration_write_lock()',relation_name);
 END LOOP;
END $$;

--> statement-breakpoint
-- The native Schedule page lazily establishes its canonical Standard. This exact initializer is
-- independent of manual Add; it accepts no row/threshold values and cannot edit an existing rule.
CREATE TABLE app.module_standard_rule_effect(xact_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,rule_id uuid NOT NULL,row_hash text NOT NULL,PRIMARY KEY(xact_id,tenant_id,user_id,rule_id));
REVOKE ALL ON app.module_standard_rule_effect FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.attendance_standard_rule_ensure() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE selected_id uuid;source_policy public.attendance_policy%ROWTYPE;grace integer:=0;observed jsonb;
BEGIN
 PERFORM app.access_workforce_write_lock();
 IF NOT app.module_action_allowed('attendance_configuration','view',NULL) OR NOT app.function_action_allowed('attendancePolicy.schedule','view',NULL) THEN RAISE EXCEPTION 'Schedule default unavailable' USING ERRCODE='42501';END IF;
 IF current_setting('transaction_isolation')<>'read committed' OR current_setting('transaction_read_only')<>'off' OR NOT pg_try_advisory_xact_lock(hashtextextended('leave-dependency-configuration:'||app.current_tenant_id()::text,0)) THEN RAISE EXCEPTION 'Schedule source unavailable' USING ERRCODE='55P03';END IF;
 SELECT r.id INTO selected_id FROM public.attendance_rule r WHERE r.tenant_id=app.current_tenant_id() AND r.is_default;
 IF FOUND THEN RETURN jsonb_build_object('id',selected_id,'created',false);END IF;
 SELECT p.* INTO source_policy FROM public.attendance_policy p WHERE p.tenant_id=app.current_tenant_id() ORDER BY p.created_at,p.id LIMIT 1;
 IF FOUND THEN grace:=greatest(0,(extract(hour FROM source_policy.late_after)::integer*60+extract(minute FROM source_policy.late_after)::integer)-(extract(hour FROM source_policy.work_start)::integer*60+extract(minute FROM source_policy.work_start)::integer));END IF;
 INSERT INTO public.attendance_rule(tenant_id,name,description,is_default,status,late_grace_period_minutes)
 VALUES(app.current_tenant_id(),'Standard','Default attendance calculation rule.',true,'active',grace)
 ON CONFLICT DO NOTHING RETURNING id,to_jsonb(attendance_rule) INTO selected_id,observed;
 IF selected_id IS NULL THEN
  SELECT r.id INTO selected_id FROM public.attendance_rule r WHERE r.tenant_id=app.current_tenant_id() AND r.is_default;
  IF selected_id IS NULL THEN RAISE EXCEPTION 'Schedule default unavailable' USING ERRCODE='42501';END IF;
  RETURN jsonb_build_object('id',selected_id,'created',false);
 END IF;
 DELETE FROM app.module_standard_rule_effect WHERE xact_id<pg_snapshot_xmin(pg_current_snapshot());
 INSERT INTO app.module_standard_rule_effect VALUES(pg_current_xact_id(),app.current_tenant_id(),app.current_user_id(),selected_id,encode(sha256(convert_to(observed::text,'UTF8')),'hex'));
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
 VALUES(app.current_tenant_id(),'attendance-rule',selected_id,'attendance-rule.created','user',app.current_user_id(),'{"name":"Standard","isDefault":true,"seeded":true}'::jsonb);
 RETURN jsonb_build_object('id',selected_id,'created',true);
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.attendance_standard_rule_ensure() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.attendance_standard_rule_ensure() TO ai_hr_app;
--> statement-breakpoint
CREATE TABLE app.module_attendance_rule_birth(xact_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,rule_id uuid NOT NULL,PRIMARY KEY(xact_id,tenant_id,user_id,rule_id));
REVOKE ALL ON app.module_attendance_rule_birth FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.module_attendance_rule_birth_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.access_workforce_storage_owner() THEN RETURN NULL;END IF;
 DELETE FROM app.module_attendance_rule_birth WHERE xact_id<pg_snapshot_xmin(pg_current_snapshot());
 INSERT INTO app.module_attendance_rule_birth VALUES(pg_current_xact_id(),NEW.tenant_id,app.current_user_id(),NEW.id);RETURN NULL;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.module_attendance_rule_birth_record() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER module_attendance_rule_birth AFTER INSERT ON public.attendance_rule FOR EACH ROW EXECUTE FUNCTION app.module_attendance_rule_birth_record();
--> statement-breakpoint
CREATE FUNCTION app.module_attendance_rule_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE before_row jsonb:=CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
 after_row jsonb:=CASE WHEN TG_OP='DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;
 operation text:=CASE TG_OP WHEN 'INSERT' THEN 'add' WHEN 'DELETE' THEN 'delete' ELSE 'edit' END;
 parent_id uuid;old_parent uuid;actual_tenant uuid:=coalesce((after_row->>'tenant_id')::uuid,(before_row->>'tenant_id')::uuid);
BEGIN
 IF app.access_workforce_storage_owner() THEN RETURN NULL;END IF;
 PERFORM app.access_workforce_write_lock();
 IF actual_tenant IS DISTINCT FROM app.current_tenant_id() OR TG_OP='UPDATE' AND (before_row->>'tenant_id' IS DISTINCT FROM after_row->>'tenant_id' OR before_row->>'id' IS DISTINCT FROM after_row->>'id') THEN RAISE EXCEPTION 'Schedule identity unavailable' USING ERRCODE='42501';END IF;
 IF TG_TABLE_NAME='attendance_rule' THEN
  IF TG_OP<>'DELETE' AND NEW.company_id IS NOT NULL THEN RAISE EXCEPTION 'Schedule library is tenant-owned' USING ERRCODE='42501';END IF;
  IF TG_OP='INSERT' AND EXISTS(SELECT 1 FROM app.module_standard_rule_effect proof WHERE proof.xact_id=pg_current_xact_id() AND proof.tenant_id=NEW.tenant_id AND proof.user_id=app.current_user_id() AND proof.rule_id=NEW.id AND proof.row_hash=encode(sha256(convert_to(after_row::text,'UTF8')),'hex'))
   AND app.module_action_allowed('attendance_configuration','view',NULL) AND app.function_action_allowed('attendancePolicy.schedule','view',NULL) THEN RETURN NULL;END IF;
  IF TG_OP='INSERT' AND NEW.is_default OR TG_OP='UPDATE' AND NEW.is_default IS DISTINCT FROM OLD.is_default THEN RAISE EXCEPTION 'Standard Schedule source unavailable' USING ERRCODE='42501';END IF;
  IF TG_OP='UPDATE' AND OLD.status::text='active' AND NEW.status::text='inactive' THEN operation:='delete';END IF;
 ELSE
  parent_id:=coalesce((after_row->>'rule_id')::uuid,(before_row->>'rule_id')::uuid);
  old_parent:=(before_row->>'rule_id')::uuid;
  -- Physical OT-band replacement is one Edit of an existing Schedule, not Delete+Add. Initial
  -- bands are Add only when their parent was actually inserted by this actor in this transaction.
  operation:=CASE WHEN TG_OP='DELETE' AND EXISTS(SELECT 1 FROM app.module_configuration_removed source WHERE source.xact_id=pg_current_xact_id() AND source.tenant_id=actual_tenant AND source.user_id=app.current_user_id() AND source.kind='attendance_rule' AND source.row_id=parent_id)
   AND NOT EXISTS(SELECT 1 FROM public.attendance_rule parent WHERE parent.tenant_id=actual_tenant AND parent.id=parent_id) THEN 'delete'
   WHEN EXISTS(SELECT 1 FROM app.module_attendance_rule_birth born WHERE born.xact_id=pg_current_xact_id() AND born.tenant_id=actual_tenant AND born.user_id=app.current_user_id() AND born.rule_id=parent_id) THEN 'add' ELSE 'edit' END;
  IF old_parent IS NOT NULL AND old_parent IS DISTINCT FROM parent_id THEN RAISE EXCEPTION 'Schedule band cannot be reassigned' USING ERRCODE='42501';END IF;
 END IF;
 IF NOT app.module_action_allowed('attendance_configuration',operation,NULL) OR NOT app.function_action_allowed('attendancePolicy.schedule',operation,NULL) THEN RAISE EXCEPTION 'Schedule action unavailable' USING ERRCODE='42501';END IF;
 RETURN NULL;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.module_attendance_rule_guard() FROM PUBLIC,ai_hr_app;
CREATE CONSTRAINT TRIGGER module_attendance_rule_guard AFTER INSERT OR UPDATE OR DELETE ON public.attendance_rule DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.module_attendance_rule_guard();
CREATE CONSTRAINT TRIGGER module_attendance_rule_guard AFTER INSERT OR UPDATE OR DELETE ON public.attendance_rule_ot_row DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.module_attendance_rule_guard();
CREATE TRIGGER module_configuration_write_lock BEFORE INSERT OR UPDATE OR DELETE ON public.attendance_rule FOR EACH STATEMENT EXECUTE FUNCTION app.module_configuration_write_lock();
CREATE TRIGGER module_configuration_write_lock BEFORE INSERT OR UPDATE OR DELETE ON public.attendance_rule_ot_row FOR EACH STATEMENT EXECUTE FUNCTION app.module_configuration_write_lock();
--> statement-breakpoint
CREATE FUNCTION app.module_schedule_delegation_allowed(t uuid,u uuid,cap text,co uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.module_action_current_legacy_allowed(t,u,cap,co) AND (cap NOT IN ('attendance_configuration.add','attendance_configuration.edit') OR app.is_group_admin());
$$;
REVOKE ALL ON FUNCTION app.module_schedule_delegation_allowed(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
DO $$ DECLARE operation text;BEGIN
 FOREACH operation IN ARRAY ARRAY['view','add','edit','delete'] LOOP
  PERFORM app.register_function_action('attendancePolicy.schedule',operation,'tenant','attendance_configuration.'||operation,'app.module_schedule_delegation_allowed','{"moduleKey":"attendance","labelKey":"nav.workSchedule","kind":"submenu","course":"administrative","screenKey":"attendancePolicy","href":"/admin/attendance/schedule","employeeBearing":false}'::jsonb);
 END LOOP;
END $$;

--> statement-breakpoint
-- Exact physical root removal witnesses let canonical Delete clean its own references/bands without
-- granting arbitrary Edit. Every queued derived mutation must still match its finite source shape.
CREATE TABLE app.module_configuration_removed(xact_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,kind text NOT NULL,row_id uuid NOT NULL,source jsonb NOT NULL,PRIMARY KEY(xact_id,tenant_id,user_id,kind,row_id));
REVOKE ALL ON app.module_configuration_removed FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.module_configuration_removed_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.access_workforce_storage_owner() THEN RETURN NULL;END IF;
 DELETE FROM app.module_configuration_removed WHERE xact_id<pg_snapshot_xmin(pg_current_snapshot());
 INSERT INTO app.module_configuration_removed VALUES(pg_current_xact_id(),OLD.tenant_id,app.current_user_id(),TG_TABLE_NAME,OLD.id,to_jsonb(OLD));RETURN NULL;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.module_configuration_removed_record() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER module_configuration_removed AFTER DELETE ON public.leave_type FOR EACH ROW EXECUTE FUNCTION app.module_configuration_removed_record();
CREATE TRIGGER module_configuration_removed AFTER DELETE ON public.attendance_rule FOR EACH ROW EXECUTE FUNCTION app.module_configuration_removed_record();
--> statement-breakpoint
CREATE FUNCTION app.module_attendance_delete_floor() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.access_workforce_storage_owner() THEN RETURN OLD;END IF;
 IF NOT app.module_action_allowed('attendance_configuration','delete',NULL) OR NOT app.function_action_allowed('attendancePolicy.schedule','delete',NULL)
  OR OLD.is_default OR EXISTS(SELECT 1 FROM public.attendance_rule_shift m WHERE m.tenant_id=OLD.tenant_id AND m.rule_id=OLD.id)
  OR EXISTS(SELECT 1 FROM public.shift s WHERE s.tenant_id=OLD.tenant_id AND s.rule_id=OLD.id)
  OR EXISTS(SELECT 1 FROM public.employment e WHERE e.tenant_id=OLD.tenant_id AND e.attendance_rule_id=OLD.id)
  OR EXISTS(SELECT 1 FROM public.attendance_rotation r WHERE r.tenant_id=OLD.tenant_id AND r.rule_id=OLD.id)
  OR EXISTS(SELECT 1 FROM public.attendance_exception_revision r WHERE r.tenant_id=OLD.tenant_id AND r.rule_id=OLD.id) THEN RAISE EXCEPTION 'Schedule deletion source unavailable' USING ERRCODE='42501';END IF;
 RETURN OLD;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.module_attendance_delete_floor() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER module_attendance_delete_floor BEFORE DELETE ON public.attendance_rule FOR EACH ROW EXECUTE FUNCTION app.module_attendance_delete_floor();
--> statement-breakpoint
CREATE FUNCTION app.module_leave_type_reference_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.access_workforce_storage_owner() OR app.module_action_allowed('leave_configuration','edit',NULL) AND app.function_action_allowed('leaveConfig.types','edit',NULL) THEN RETURN NULL;END IF;
 IF OLD.balance_source_type_id IS NOT NULL AND NEW.balance_source_type_id IS NULL AND (to_jsonb(OLD)-ARRAY['balance_source_type_id','updated_at']) IS NOT DISTINCT FROM (to_jsonb(NEW)-ARRAY['balance_source_type_id','updated_at'])
 AND app.module_action_allowed('leave_configuration','delete',NULL) AND app.function_action_allowed('leaveConfig.types','delete',NULL)
 AND EXISTS(SELECT 1 FROM app.module_configuration_removed source WHERE source.xact_id=pg_current_xact_id() AND source.tenant_id=OLD.tenant_id AND source.user_id=app.current_user_id() AND source.kind='leave_type' AND source.row_id=OLD.balance_source_type_id)
 AND NOT EXISTS(SELECT 1 FROM public.leave_type parent WHERE parent.tenant_id=OLD.tenant_id AND parent.id=OLD.balance_source_type_id) THEN RETURN NULL;END IF;
 RAISE EXCEPTION 'Leave type reference deletion source unavailable' USING ERRCODE='42501';
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.module_leave_type_reference_guard() FROM PUBLIC,ai_hr_app;
CREATE CONSTRAINT TRIGGER module_leave_type_reference_guard AFTER UPDATE ON public.leave_type DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.module_leave_type_reference_guard();

--> statement-breakpoint
DO $$ DECLARE relation_name text;BEGIN
 FOREACH relation_name IN ARRAY ARRAY['attendance_rule_shift','attendance_rotation','attendance_exception_revision'] LOOP
  EXECUTE format('CREATE CONSTRAINT TRIGGER module_attendance_rule_guard AFTER INSERT OR UPDATE OR DELETE ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.module_attendance_rule_guard()',relation_name);
  EXECUTE format('CREATE TRIGGER module_configuration_write_lock BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION app.module_configuration_write_lock()',relation_name);
 END LOOP;
END $$;

--> statement-breakpoint
-- Grade Groups is shared vocabulary; only its maintenance purpose is administrative.
DO $$ DECLARE operation text;BEGIN
 FOREACH operation IN ARRAY ARRAY['view','add','edit','delete'] LOOP
  PERFORM app.register_function_action('leaveConfig.gradeGroups',operation,'tenant','leave_configuration.'||operation,'app.module_action_current_legacy_allowed',
   '{"moduleKey":"leave","labelKey":"admin.benefitScheme.groupsTitle","kind":"submenu","course":"administrative","screenKey":"leaveConfig","href":"/admin/settings/system-labels","employeeBearing":false}'::jsonb);
 END LOOP;
END $$;
--> statement-breakpoint
CREATE TABLE app.module_grade_group_source(
 xact_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,group_id uuid NOT NULL,operation text NOT NULL CHECK(operation IN ('add','delete')),
 PRIMARY KEY(xact_id,tenant_id,user_id,group_id,operation));
REVOKE ALL ON app.module_grade_group_source FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.module_grade_group_source_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.access_workforce_storage_owner() THEN RETURN NULL;END IF;
 DELETE FROM app.module_grade_group_source WHERE xact_id<pg_snapshot_xmin(pg_current_snapshot());
 INSERT INTO app.module_grade_group_source VALUES(pg_current_xact_id(),app.current_tenant_id(),app.current_user_id(),CASE WHEN TG_OP='INSERT' THEN NEW.id ELSE OLD.id END,CASE WHEN TG_OP='INSERT' THEN 'add' ELSE 'delete' END) ON CONFLICT DO NOTHING;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.module_grade_group_source_record() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER module_grade_group_source AFTER INSERT OR DELETE ON public.grade_group FOR EACH ROW EXECUTE FUNCTION app.module_grade_group_source_record();
CREATE TRIGGER module_grade_group_action BEFORE INSERT OR UPDATE OR DELETE ON public.grade_group FOR EACH ROW EXECUTE FUNCTION app.module_catalogue_action_guard('leave_configuration','leaveConfig.gradeGroups');
--> statement-breakpoint
CREATE FUNCTION app.module_grade_group_member_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE row_image jsonb;selected_group_id uuid;operation text;deferred_check boolean:=TG_WHEN='AFTER';
BEGIN
 IF app.access_workforce_storage_owner() THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 PERFORM app.access_workforce_write_lock();
 -- Check both queued images, including membership moved away and restored before commit.
 FOR row_image IN SELECT image FROM (VALUES(CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END),(CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END)) images(image) WHERE image IS NOT NULL LOOP
  IF row_image->>'tenant_id' IS DISTINCT FROM app.current_tenant_id()::text THEN RAISE EXCEPTION 'Grade group member identity unavailable' USING ERRCODE='42501';END IF;
  IF TG_OP<>'DELETE' AND (NOT EXISTS(SELECT 1 FROM public.grade_group parent WHERE parent.id=(row_image->>'grade_group_id')::uuid AND parent.tenant_id=app.current_tenant_id()) OR NOT EXISTS(SELECT 1 FROM public.job_grade grade WHERE grade.id=(row_image->>'grade_id')::uuid AND grade.tenant_id=app.current_tenant_id())) THEN RAISE EXCEPTION 'Grade group member source unavailable' USING ERRCODE='42501';END IF;
  selected_group_id:=(row_image->>'grade_group_id')::uuid;operation:='edit';
  IF EXISTS(SELECT 1 FROM app.module_grade_group_source source WHERE source.xact_id=pg_current_xact_id() AND source.tenant_id=app.current_tenant_id() AND source.user_id=app.current_user_id() AND source.group_id=selected_group_id AND source.operation='add') THEN operation:='add';
  ELSIF TG_OP='DELETE' AND NOT EXISTS(SELECT 1 FROM public.grade_group parent WHERE parent.id=selected_group_id AND parent.tenant_id=app.current_tenant_id()) THEN
   operation:='delete';
   IF deferred_check AND NOT EXISTS(SELECT 1 FROM app.module_grade_group_source source WHERE source.xact_id=pg_current_xact_id() AND source.tenant_id=app.current_tenant_id() AND source.user_id=app.current_user_id() AND source.group_id=selected_group_id AND source.operation='delete') THEN RAISE EXCEPTION 'Grade group deletion source unavailable' USING ERRCODE='42501';END IF;
  END IF;
  IF NOT app.module_action_allowed('leave_configuration',operation,NULL) OR NOT app.function_action_allowed('leaveConfig.gradeGroups',operation,NULL) THEN RAISE EXCEPTION 'Grade group member action unavailable' USING ERRCODE='42501';END IF;
 END LOOP;
 IF TG_OP='UPDATE' AND (OLD.id IS DISTINCT FROM NEW.id OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id) THEN RAISE EXCEPTION 'Grade group member identity unavailable' USING ERRCODE='42501';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END $$;
REVOKE ALL ON FUNCTION app.module_grade_group_member_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER module_grade_group_member BEFORE INSERT OR UPDATE OR DELETE ON public.grade_group_member FOR EACH ROW EXECUTE FUNCTION app.module_grade_group_member_guard();
CREATE CONSTRAINT TRIGGER module_grade_group_member_final AFTER INSERT OR UPDATE OR DELETE ON public.grade_group_member DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.module_grade_group_member_guard();
--> statement-breakpoint
DO $$ DECLARE relation_name text;BEGIN
 FOREACH relation_name IN ARRAY ARRAY['grade_group','grade_group_member'] LOOP
  EXECUTE format('CREATE TRIGGER module_configuration_write_lock BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION app.module_configuration_write_lock()',relation_name);
 END LOOP;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER module_grade_group_action_final AFTER INSERT OR UPDATE OR DELETE ON public.grade_group DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.module_catalogue_action_guard('leave_configuration','leaveConfig.gradeGroups');

--> statement-breakpoint
CREATE FUNCTION app.module_grade_group_delete_floor() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT app.access_workforce_storage_owner() AND EXISTS(SELECT 1 FROM public.leave_approval_policy policy WHERE policy.tenant_id=OLD.tenant_id AND policy.grade_group_id=OLD.id) THEN RAISE EXCEPTION 'Grade group is used by leave approval rules' USING ERRCODE='42501';END IF;
 RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION app.module_grade_group_delete_floor() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER module_grade_group_delete_floor BEFORE DELETE ON public.grade_group FOR EACH ROW EXECUTE FUNCTION app.module_grade_group_delete_floor();

--> statement-breakpoint
-- Ordinary own Claim courses are independent of administrative employee data selection.
DO $$ DECLARE selected_key text;operation text;BEGIN
 FOREACH selected_key IN ARRAY ARRAY['drafts','submit'] LOOP
  FOREACH operation IN ARRAY (CASE selected_key WHEN 'drafts' THEN ARRAY['view','add','edit','delete'] ELSE ARRAY['view','execute'] END) LOOP
   PERFORM app.register_function_action('claims.own.'||selected_key,operation,'company','function.claims.own.view','app.claim_own_current_native_allowed',
    jsonb_build_object('moduleKey','claims','labelKey','claims.accessFunctions.'||selected_key,'kind','native_acl','course','own','employeeBearing',false));
  END LOOP;
 END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.claim_subject_is_own(p_subject uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND EXISTS(SELECT 1 FROM public.employment employment JOIN public.app_user actor ON actor.person_id=employment.person_id AND actor.tenant_id=employment.tenant_id WHERE employment.id=p_subject AND employment.tenant_id=app.current_tenant_id() AND actor.id=app.current_user_id() AND actor.archived_at IS NULL AND NOT app.login_blocked(actor.id));
$$;
REVOKE ALL ON FUNCTION app.claim_subject_is_own(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_subject_is_own(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.claim_own_source_allowed(p_subject uuid,p_key text,p_operation text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.claim_subject_is_own(p_subject) AND p_key IN ('claims.own','claims.own.drafts','claims.own.submit','claims.own.receipts')
 AND EXISTS(SELECT 1 FROM public.employment employment WHERE employment.id=p_subject AND employment.tenant_id=app.current_tenant_id() AND employment.voided_at IS NULL AND app.function_action_allowed('claims.own','view',employment.company_id) AND app.function_action_allowed(p_key,p_operation,employment.company_id));
$$;
REVOKE ALL ON FUNCTION app.claim_own_source_allowed(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_own_source_allowed(uuid,text,text) TO ai_hr_app;
--> statement-breakpoint
CREATE TABLE app.claim_draft_delete_effect(xact_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,claim_id uuid NOT NULL,before_source jsonb NOT NULL,event_id uuid,completed boolean NOT NULL DEFAULT false,authority_stamp text NOT NULL,PRIMARY KEY(xact_id,tenant_id,user_id,claim_id));
REVOKE ALL ON app.claim_draft_delete_effect FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.claim_draft_delete_native(p_claim uuid,p_expected_employment uuid DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source public.claim_request%ROWTYPE;event uuid;
BEGIN
 PERFORM app.claim_command_lock();
 SELECT * INTO source FROM public.claim_request WHERE id=p_claim AND tenant_id=app.current_tenant_id() AND app.claim_own_source_allowed(employment_id,'claims.own.drafts','view') FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Claim not found';END IF;
 IF p_expected_employment IS NOT NULL AND source.employment_id<>p_expected_employment THEN RAISE EXCEPTION 'Draft does not belong to the selected employment';END IF;
 IF source.status<>'draft' THEN RAISE EXCEPTION 'Only a draft claim can be deleted';END IF;
 IF NOT app.claim_own_source_allowed(source.employment_id,'claims.own.drafts','delete') THEN RAISE EXCEPTION 'Claim draft delete unavailable' USING ERRCODE='42501';END IF;
 DELETE FROM app.claim_draft_delete_effect WHERE xact_id<pg_snapshot_xmin(pg_current_snapshot());
 INSERT INTO app.claim_draft_delete_effect(xact_id,tenant_id,user_id,claim_id,before_source,authority_stamp) VALUES(pg_current_xact_id(),source.tenant_id,app.current_user_id(),source.id,to_jsonb(source),app.claim_command_authority_stamp());
 DELETE FROM public.claim_attachment WHERE tenant_id=source.tenant_id AND claim_request_id=source.id;
 DELETE FROM public.claim_request WHERE tenant_id=source.tenant_id AND id=source.id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Claim draft delete changed' USING ERRCODE='40001';END IF;
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload) VALUES(source.tenant_id,'claim-request',source.id,'claim-request.draft-deleted','user',app.current_user_id(),source.employment_id,'{}') RETURNING id INTO event;
 UPDATE app.claim_draft_delete_effect SET completed=true,event_id=event WHERE xact_id=pg_current_xact_id() AND tenant_id=source.tenant_id AND user_id=app.current_user_id() AND claim_id=source.id;
END $$;
REVOKE ALL ON FUNCTION app.claim_draft_delete_native(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_draft_delete_native(uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.claim_draft_delete_approved(p_claim uuid,p_source jsonb,p_final boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.claim_own_source_allowed((p_source->>'employment_id')::uuid,'claims.own.drafts','delete') AND EXISTS(SELECT 1 FROM app.claim_draft_delete_effect proof WHERE proof.xact_id=pg_current_xact_id() AND proof.tenant_id=app.current_tenant_id() AND proof.user_id=app.current_user_id() AND proof.claim_id=p_claim AND proof.before_source=p_source AND (NOT p_final OR proof.completed AND NOT EXISTS(SELECT 1 FROM public.claim_request actual WHERE actual.id=proof.claim_id) AND NOT EXISTS(SELECT 1 FROM public.claim_attachment attachment WHERE attachment.claim_request_id=proof.claim_id) AND EXISTS(SELECT 1 FROM public.domain_event event WHERE event.id=proof.event_id AND event.tenant_id=proof.tenant_id AND event.actor_type='user' AND event.actor_id=proof.user_id AND event.aggregate_type='claim-request' AND event.aggregate_id=proof.claim_id AND event.event_type='claim-request.draft-deleted' AND event.subject_employment_id=(p_source->>'employment_id')::uuid)));
$$;
REVOKE ALL ON FUNCTION app.claim_draft_delete_approved(uuid,jsonb,boolean) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.claim_own_request_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE prior jsonb:=CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;proposed jsonb:=CASE WHEN TG_OP='DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;subject uuid:=coalesce(NEW.employment_id,OLD.employment_id);key text;operation text;
BEGIN
 IF app.access_workforce_storage_owner() THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 PERFORM app.access_workforce_write_lock();
 IF coalesce(NEW.tenant_id,OLD.tenant_id) IS DISTINCT FROM app.current_tenant_id() OR TG_OP='UPDATE' AND ROW(OLD.id,OLD.tenant_id,OLD.employment_id) IS DISTINCT FROM ROW(NEW.id,NEW.tenant_id,NEW.employment_id) THEN RAISE EXCEPTION 'Claim source identity unavailable' USING ERRCODE='42501';END IF;
 IF TG_OP='DELETE' AND OLD.status::text<>'draft' OR TG_OP='UPDATE' AND NEW.status IS DISTINCT FROM OLD.status AND NOT(OLD.status::text='draft' AND NEW.status::text='pending' OR OLD.status::text='pending' AND NEW.status::text IN ('approved','rejected','cancelled') OR OLD.status::text='approved' AND NEW.status::text='paid' OR OLD.status::text='paid' AND NEW.status::text='approved') THEN RAISE EXCEPTION 'Claim lifecycle source unavailable' USING ERRCODE='42501';END IF;
 -- A row-level FK does not establish tenant custody or the selected item's actual parent.
 -- Repeat the native reference owner at creation/reference changes, including raw app SQL.
 IF TG_OP='INSERT' OR TG_OP='UPDATE' AND ROW(OLD.claim_type_id,OLD.claim_item_id) IS DISTINCT FROM ROW(NEW.claim_type_id,NEW.claim_item_id) THEN
  IF NOT EXISTS(SELECT 1 FROM public.employment employee WHERE employee.id=NEW.employment_id AND employee.tenant_id=NEW.tenant_id)
   OR NOT EXISTS(SELECT 1 FROM public.claim_type catalogue WHERE catalogue.id=NEW.claim_type_id AND catalogue.tenant_id=NEW.tenant_id AND catalogue.archived_at IS NULL)
   OR NEW.claim_item_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.claim_item item WHERE item.id=NEW.claim_item_id AND item.tenant_id=NEW.tenant_id AND item.claim_type_id=NEW.claim_type_id AND item.archived_at IS NULL)
  THEN RAISE EXCEPTION 'Claim source reference unavailable' USING ERRCODE='42501';END IF;
 END IF;
 -- Native nonself submission/decision courses retain their current owner until their exact chapter.
 IF NOT app.claim_subject_is_own(subject) AND (TG_OP='INSERT' AND NEW.status='draft' OR TG_OP<>'INSERT' AND OLD.status='draft') THEN RAISE EXCEPTION 'Only the claimant can edit or submit their own draft claim' USING ERRCODE='42501';END IF;
 IF NOT app.claim_subject_is_own(subject) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 IF TG_OP='DELETE' AND OLD.status='draft' THEN
  IF NOT app.claim_draft_delete_approved(OLD.id,prior,TG_WHEN='AFTER') THEN RAISE EXCEPTION 'Claim draft deletion source unavailable' USING ERRCODE='42501';END IF;RETURN OLD;
 ELSIF TG_OP='INSERT' AND NEW.status IN ('draft','pending') THEN
  IF NEW.decided_at IS NOT NULL OR NEW.decided_by_employment_id IS NOT NULL OR NEW.payroll_batch_id IS NOT NULL OR NEW.paid_at IS NOT NULL OR NEW.payout_ref IS NOT NULL THEN RAISE EXCEPTION 'Claim creation stamps unavailable' USING ERRCODE='42501';END IF;
  key:=CASE WHEN NEW.status='draft' THEN 'claims.own.drafts' ELSE 'claims.own.submit' END;operation:=CASE WHEN NEW.status='draft' THEN 'add' ELSE 'execute' END;
 ELSIF TG_OP='UPDATE' AND OLD.status='draft' AND NEW.status IN ('draft','pending') THEN
  IF NEW.status::text='pending' AND prior-ARRAY['claim_item_id','amount','quantity_km','taxable','field_values','mileage_rate_applied','status'] IS DISTINCT FROM proposed-ARRAY['claim_item_id','amount','quantity_km','taxable','field_values','mileage_rate_applied','status'] THEN RAISE EXCEPTION 'Claim draft fields unavailable' USING ERRCODE='42501';END IF;
  IF (prior-ARRAY['claim_type_id','claim_item_id','amount','quantity_km','incurred_on','description','taxable','field_values','mileage_rate_applied','status']) IS DISTINCT FROM (proposed-ARRAY['claim_type_id','claim_item_id','amount','quantity_km','incurred_on','description','taxable','field_values','mileage_rate_applied','status']) THEN RAISE EXCEPTION 'Claim draft fields unavailable' USING ERRCODE='42501';END IF;
  key:=CASE WHEN NEW.status='draft' THEN 'claims.own.drafts' ELSE 'claims.own.submit' END;operation:=CASE WHEN NEW.status='draft' THEN 'edit' ELSE 'execute' END;
 ELSIF TG_OP='UPDATE' AND OLD.status<>'draft' AND NEW.status=OLD.status AND prior IS DISTINCT FROM proposed THEN
  -- A filed own claim has no native content editor. Actual Payroll effect columns keep their941 owner.
  IF prior-ARRAY['payroll_batch_id','paid_at','payout_ref'] IS DISTINCT FROM proposed-ARRAY['payroll_batch_id','paid_at','payout_ref'] THEN RAISE EXCEPTION 'Filed claim is immutable' USING ERRCODE='42501';END IF;
 ELSIF TG_OP='INSERT' OR TG_OP='UPDATE' AND NEW.status='draft' OR TG_OP='DELETE' THEN RAISE EXCEPTION 'Claim lifecycle source unavailable' USING ERRCODE='42501';
 END IF;
 IF key IS NOT NULL AND NOT app.claim_own_source_allowed(subject,key,operation) THEN RAISE EXCEPTION 'Own claim action unavailable' USING ERRCODE='42501';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END $$;
REVOKE ALL ON FUNCTION app.claim_own_request_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER claim_own_request BEFORE INSERT OR UPDATE OR DELETE ON public.claim_request FOR EACH ROW EXECUTE FUNCTION app.claim_own_request_guard();
CREATE CONSTRAINT TRIGGER claim_own_request_final AFTER INSERT OR UPDATE OR DELETE ON public.claim_request DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.claim_own_request_guard();
--> statement-breakpoint
CREATE FUNCTION app.claim_own_read_allowed(p_subject uuid,p_draft boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT NOT app.claim_subject_is_own(p_subject) OR app.claim_own_source_allowed(p_subject,'claims.own','view') AND (NOT p_draft OR app.claim_own_source_allowed(p_subject,'claims.own.drafts','view'));
$$;
REVOKE ALL ON FUNCTION app.claim_own_read_allowed(uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_own_read_allowed(uuid,boolean) TO ai_hr_app;
CREATE POLICY claim_own_action_read ON public.claim_request AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(app.claim_own_read_allowed(employment_id,status::text='draft'));

--> statement-breakpoint
CREATE FUNCTION app.claim_draft_delete_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT app.claim_draft_delete_approved(NEW.claim_id,NEW.before_source,true) THEN RAISE EXCEPTION 'Claim draft delete effects incomplete' USING ERRCODE='42501';END IF;RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.claim_draft_delete_complete() FROM PUBLIC,ai_hr_app;
CREATE CONSTRAINT TRIGGER claim_draft_delete_complete AFTER INSERT OR UPDATE ON app.claim_draft_delete_effect DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.claim_draft_delete_complete();
--> statement-breakpoint
CREATE TRIGGER module_claim_write_lock BEFORE INSERT OR UPDATE OR DELETE ON public.claim_request FOR EACH STATEMENT EXECUTE FUNCTION app.module_configuration_write_lock();

--> statement-breakpoint
-- Real own receipt constructors. Logical draft/submit file initialization needs an actual
-- source mutation, one file slot and its completed native source audit, never a caller flag alone.
DO $$ DECLARE operation text;BEGIN
 FOREACH operation IN ARRAY ARRAY['view','add'] LOOP
  PERFORM app.register_function_action('claims.own.receipts',operation,'company','function.claims.own.view','app.claim_own_current_native_allowed','{"moduleKey":"claims","labelKey":"claims.accessFunctions.receipts","kind":"native_acl","course":"own","employeeBearing":false}'::jsonb);
 END LOOP;
END $$;
--> statement-breakpoint
CREATE TABLE app.claim_own_source_mutation(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),xact_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,claim_id uuid NOT NULL,course text NOT NULL CHECK(course IN ('draft-add','draft-edit','submit')),source jsonb NOT NULL,authority_stamp text NOT NULL,receipt_id uuid);
CREATE TABLE app.claim_own_receipt_effect(xact_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,receipt_id uuid NOT NULL,claim_id uuid NOT NULL,employment_id uuid NOT NULL,course text NOT NULL,source_id uuid,metadata jsonb NOT NULL,content_hash text NOT NULL,authority_stamp text NOT NULL,event_id uuid,born boolean NOT NULL DEFAULT false,completed boolean NOT NULL DEFAULT false,PRIMARY KEY(xact_id,tenant_id,user_id,receipt_id));
CREATE TABLE app.claim_own_source_audit(xact_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,claim_id uuid NOT NULL,event_id uuid NOT NULL,event_type text NOT NULL,payload jsonb NOT NULL,PRIMARY KEY(xact_id,tenant_id,event_id));
REVOKE ALL ON app.claim_own_source_mutation,app.claim_own_receipt_effect,app.claim_own_source_audit FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.claim_own_source_mutation_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE course text;
BEGIN
 IF app.access_workforce_storage_owner() OR NOT app.claim_subject_is_own(NEW.employment_id) THEN RETURN NULL;END IF;
 IF NEW.status::text='draft' THEN course:=CASE TG_OP WHEN 'INSERT' THEN 'draft-add' ELSE 'draft-edit' END;
 ELSIF NEW.status::text='pending' AND (TG_OP='INSERT' OR OLD.status::text='draft') THEN course:='submit';ELSE RETURN NULL;END IF;
 DELETE FROM app.claim_own_source_mutation WHERE xact_id<pg_snapshot_xmin(pg_current_snapshot());
 INSERT INTO app.claim_own_source_mutation(xact_id,tenant_id,user_id,claim_id,course,source,authority_stamp) VALUES(pg_current_xact_id(),NEW.tenant_id,app.current_user_id(),NEW.id,course,to_jsonb(NEW),app.access_function_authority_stamp());RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.claim_own_source_mutation_record() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER claim_own_source_mutation AFTER INSERT OR UPDATE ON public.claim_request FOR EACH ROW EXECUTE FUNCTION app.claim_own_source_mutation_record();
--> statement-breakpoint
CREATE FUNCTION app.claim_own_source_audit_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW.aggregate_type='claim-request' AND NEW.event_type IN ('claim-request.draft-saved','claim-request.submitted') AND NEW.actor_type='user' AND NEW.actor_id=app.current_user_id() AND NEW.tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() THEN
  DELETE FROM app.claim_own_source_audit WHERE xact_id<pg_snapshot_xmin(pg_current_snapshot());
  INSERT INTO app.claim_own_source_audit VALUES(pg_current_xact_id(),NEW.tenant_id,NEW.actor_id,NEW.aggregate_id,NEW.id,NEW.event_type,NEW.payload);
 END IF;RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.claim_own_source_audit_record() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER claim_own_source_audit AFTER INSERT ON public.domain_event FOR EACH ROW EXECUTE FUNCTION app.claim_own_source_audit_record();
--> statement-breakpoint
CREATE FUNCTION app.claim_own_receipt_native(p_claim uuid,p_name text,p_mime text,p_content bytea,p_course text DEFAULT 'receipt-add') RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE parent public.claim_request%ROWTYPE;attachment public.claim_attachment%ROWTYPE;source_id uuid;authority text;event uuid;operation text;
BEGIN
 PERFORM app.access_workforce_write_lock();
 SELECT * INTO parent FROM public.claim_request actual WHERE actual.id=p_claim AND actual.tenant_id=app.current_tenant_id() AND app.claim_subject_is_own(actual.employment_id) FOR UPDATE;
 IF parent.id IS NULL OR parent.status::text NOT IN ('draft','pending') OR p_course IS NULL OR p_course NOT IN ('draft-add','draft-edit','submit','receipt-add') OR p_name IS NULL OR p_mime IS NULL OR p_mime NOT IN ('application/pdf','image/jpeg','image/png') OR p_content IS NULL OR octet_length(p_content) NOT BETWEEN 1 AND 10485760 OR NOT app.claim_own_source_allowed(parent.employment_id,'claims.own.receipts','view') THEN RAISE EXCEPTION 'Own claim receipt unavailable' USING ERRCODE='42501';END IF;
 authority:=app.access_function_authority_stamp();
 IF p_course='receipt-add' THEN
  IF NOT app.claim_own_source_allowed(parent.employment_id,'claims.own.receipts','add') THEN RAISE EXCEPTION 'Own claim receipt Add unavailable' USING ERRCODE='42501';END IF;
 ELSE
  operation:=CASE p_course WHEN 'draft-add' THEN 'add' WHEN 'draft-edit' THEN 'edit' ELSE 'execute' END;
  IF NOT app.claim_own_source_allowed(parent.employment_id,CASE WHEN p_course='submit' THEN 'claims.own.submit' ELSE 'claims.own.drafts' END,operation) THEN RAISE EXCEPTION 'Own receipt source action unavailable' USING ERRCODE='42501';END IF;
  SELECT source.id INTO source_id FROM app.claim_own_source_mutation source WHERE source.xact_id=pg_current_xact_id() AND source.tenant_id=parent.tenant_id AND source.user_id=app.current_user_id() AND source.claim_id=parent.id AND source.course=p_course AND source.source=to_jsonb(parent) AND source.authority_stamp=authority AND source.receipt_id IS NULL ORDER BY source.id LIMIT 1 FOR UPDATE;
  IF source_id IS NULL THEN RAISE EXCEPTION 'Own receipt native source unavailable' USING ERRCODE='42501';END IF;
 END IF;
 attachment.id:=gen_random_uuid();attachment.tenant_id:=parent.tenant_id;attachment.claim_request_id:=parent.id;attachment.employment_id:=parent.employment_id;attachment.content:=p_content;attachment.file_name:=p_name;attachment.mime_type:=p_mime;attachment.size_bytes:=octet_length(p_content);attachment.uploaded_by_user_id:=app.current_user_id();attachment.created_at:=now();
 DELETE FROM app.claim_own_receipt_effect WHERE xact_id<pg_snapshot_xmin(pg_current_snapshot());
 INSERT INTO app.claim_own_receipt_effect(xact_id,tenant_id,user_id,receipt_id,claim_id,employment_id,course,source_id,metadata,content_hash,authority_stamp) VALUES(pg_current_xact_id(),parent.tenant_id,app.current_user_id(),attachment.id,parent.id,parent.employment_id,p_course,source_id,to_jsonb(attachment)-'content',encode(sha256(p_content),'hex'),authority);
 IF source_id IS NOT NULL THEN UPDATE app.claim_own_source_mutation SET receipt_id=attachment.id WHERE id=source_id;END IF;
 INSERT INTO public.claim_attachment SELECT (attachment).*;
 IF NOT FOUND THEN RAISE EXCEPTION 'Own receipt insert changed' USING ERRCODE='40001';END IF;
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload) VALUES(parent.tenant_id,'claim-request',parent.id,'claim-request.receipt-added','user',app.current_user_id(),parent.employment_id,jsonb_build_object('fileName',p_name,'sizeBytes',octet_length(p_content))) RETURNING id INTO event;
 UPDATE app.claim_own_receipt_effect SET completed=true,event_id=event WHERE xact_id=pg_current_xact_id() AND tenant_id=parent.tenant_id AND user_id=app.current_user_id() AND receipt_id=attachment.id;
 RETURN attachment.id;
END $$;
REVOKE ALL ON FUNCTION app.claim_own_receipt_native(uuid,text,text,bytea,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_own_receipt_native(uuid,text,text,bytea,text) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.claim_own_receipt_approved(p_receipt uuid,p_row jsonb,p_content bytea,p_final boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app.claim_own_receipt_effect proof WHERE proof.xact_id=pg_current_xact_id() AND proof.tenant_id=app.current_tenant_id() AND proof.user_id=app.current_user_id() AND proof.receipt_id=p_receipt AND proof.metadata=p_row-'content' AND proof.content_hash=encode(sha256(p_content),'hex') AND proof.authority_stamp=app.access_function_authority_stamp()
 AND app.claim_own_source_allowed(proof.employment_id,'claims.own.receipts','view')
 AND CASE proof.course WHEN 'receipt-add' THEN app.claim_own_source_allowed(proof.employment_id,'claims.own.receipts','add') ELSE app.claim_own_source_allowed(proof.employment_id,CASE WHEN proof.course='submit' THEN 'claims.own.submit' ELSE 'claims.own.drafts' END,CASE proof.course WHEN 'submit' THEN 'execute' WHEN 'draft-add' THEN 'add' ELSE 'edit' END) END
 AND (NOT p_final OR proof.born AND proof.completed AND EXISTS(SELECT 1 FROM public.domain_event event WHERE event.id=proof.event_id AND event.tenant_id=proof.tenant_id AND event.aggregate_id=proof.claim_id AND event.aggregate_type='claim-request' AND event.actor_type='user' AND event.actor_id=proof.user_id AND event.subject_employment_id=proof.employment_id AND event.event_type='claim-request.receipt-added' AND event.payload->>'fileName'=proof.metadata->>'file_name' AND event.payload->>'sizeBytes'=proof.metadata->>'size_bytes')
 AND (proof.source_id IS NULL OR EXISTS(SELECT 1 FROM app.claim_own_source_mutation source JOIN app.claim_own_source_audit audit ON audit.xact_id=source.xact_id AND audit.tenant_id=source.tenant_id AND audit.user_id=source.user_id AND audit.claim_id=source.claim_id WHERE source.id=proof.source_id AND source.receipt_id=proof.receipt_id AND source.authority_stamp=proof.authority_stamp AND audit.event_type=CASE WHEN source.course='submit' THEN 'claim-request.submitted' ELSE 'claim-request.draft-saved' END AND audit.payload->>'claimTypeId'=source.source->>'claim_type_id' AND audit.payload->>'claimItemId' IS NOT DISTINCT FROM source.source->>'claim_item_id' AND audit.payload->>'incurredOn'=source.source->>'incurred_on'))));
$$;
REVOKE ALL ON FUNCTION app.claim_own_receipt_approved(uuid,jsonb,bytea,boolean) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.claim_own_receipt_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE parent public.claim_request%ROWTYPE;image jsonb:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;source jsonb;
BEGIN
 IF app.access_workforce_storage_owner() THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'Claim receipts are immutable' USING ERRCODE='42501';END IF;
 IF TG_OP='DELETE' THEN
  SELECT proof.before_source INTO source FROM app.claim_draft_delete_effect proof WHERE proof.xact_id=pg_current_xact_id() AND proof.tenant_id=OLD.tenant_id AND proof.user_id=app.current_user_id() AND proof.claim_id=OLD.claim_request_id AND proof.before_source->>'employment_id'=OLD.employment_id::text;
  IF source IS NULL OR NOT app.claim_draft_delete_approved(OLD.claim_request_id,source,TG_WHEN='AFTER') THEN RAISE EXCEPTION 'Claim receipt removal source unavailable' USING ERRCODE='42501';END IF;RETURN OLD;
 END IF;
 IF EXISTS(SELECT 1 FROM app.claim_own_receipt_effect proof WHERE proof.xact_id=pg_current_xact_id() AND proof.tenant_id=NEW.tenant_id AND proof.user_id=app.current_user_id() AND proof.receipt_id=NEW.id) OR app.claim_subject_is_own(NEW.employment_id) THEN
  IF NOT app.claim_own_receipt_approved(NEW.id,image,NEW.content,TG_WHEN='AFTER') THEN RAISE EXCEPTION 'Own claim receipt source unavailable' USING ERRCODE='42501';END IF;
 ELSE
  -- Nonself add remains under its native visibility owner until the separate exact-purpose chapter.
  IF TG_WHEN='AFTER' THEN RETURN NULL;END IF;
  SELECT * INTO parent FROM public.claim_request actual WHERE actual.id=NEW.claim_request_id AND actual.tenant_id=NEW.tenant_id;
  IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NOT app.principal_snapshot_current() OR parent.id IS NULL OR parent.employment_id<>NEW.employment_id OR parent.status::text NOT IN ('draft','pending') OR NOT app.can_see_employment(parent.employment_id) OR NEW.uploaded_by_user_id IS DISTINCT FROM app.current_user_id() OR NEW.size_bytes IS DISTINCT FROM octet_length(NEW.content) OR NEW.size_bytes NOT BETWEEN 1 AND 10485760 OR NEW.mime_type NOT IN ('application/pdf','image/jpeg','image/png') THEN RAISE EXCEPTION 'Claim receipt native source unavailable' USING ERRCODE='42501';END IF;
 END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.claim_own_receipt_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER claim_own_receipt BEFORE INSERT OR UPDATE OR DELETE ON public.claim_attachment FOR EACH ROW EXECUTE FUNCTION app.claim_own_receipt_guard();
CREATE CONSTRAINT TRIGGER claim_own_receipt_final AFTER INSERT OR UPDATE OR DELETE ON public.claim_attachment DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.claim_own_receipt_guard();
--> statement-breakpoint
CREATE FUNCTION app.claim_own_receipt_born() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT app.access_workforce_storage_owner() THEN UPDATE app.claim_own_receipt_effect proof SET born=true WHERE proof.xact_id=pg_current_xact_id() AND proof.tenant_id=NEW.tenant_id AND proof.user_id=app.current_user_id() AND proof.receipt_id=NEW.id AND proof.metadata=to_jsonb(NEW)-'content' AND proof.content_hash=encode(sha256(NEW.content),'hex');END IF;RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.claim_own_receipt_born() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER claim_own_receipt_born AFTER INSERT ON public.claim_attachment FOR EACH ROW EXECUTE FUNCTION app.claim_own_receipt_born();
--> statement-breakpoint
CREATE FUNCTION app.claim_own_receipt_read_allowed(p_claim uuid,p_subject uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND EXISTS(SELECT 1 FROM public.claim_request actual WHERE actual.id=p_claim AND actual.tenant_id=app.current_tenant_id() AND actual.employment_id=p_subject AND (NOT app.claim_subject_is_own(p_subject) OR app.claim_own_source_allowed(p_subject,'claims.own.receipts','view') AND app.claim_own_read_allowed(p_subject,actual.status::text='draft')));
$$;
REVOKE ALL ON FUNCTION app.claim_own_receipt_read_allowed(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_own_receipt_read_allowed(uuid,uuid) TO ai_hr_app;
CREATE POLICY claim_own_receipt_read ON public.claim_attachment AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(app.claim_own_receipt_read_allowed(claim_request_id,employment_id));
CREATE TRIGGER module_claim_receipt_lock BEFORE INSERT OR UPDATE OR DELETE ON public.claim_attachment FOR EACH STATEMENT EXECUTE FUNCTION app.module_configuration_write_lock();
--> statement-breakpoint
CREATE FUNCTION app.claim_own_receipt_present(p_claim uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.claim_request actual WHERE actual.id=p_claim AND actual.tenant_id=app.current_tenant_id() AND actual.status::text='draft' AND app.claim_own_source_allowed(actual.employment_id,'claims.own.submit','execute') AND EXISTS(SELECT 1 FROM public.claim_attachment attachment WHERE attachment.claim_request_id=actual.id AND attachment.tenant_id=actual.tenant_id AND attachment.employment_id=actual.employment_id));
$$;
REVOKE ALL ON FUNCTION app.claim_own_receipt_present(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_own_receipt_present(uuid) TO ai_hr_app;

--> statement-breakpoint
-- Nonself native visibility is wider than HR. Reuse the canonical recursive/HOD graph owners;
-- administrative data profiles still narrow this course. Assigned decisions are a separate source.
CREATE FUNCTION app.claim_related_subject_for(t uuid,u uuid,subject uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.employment e JOIN public.app_user actor ON actor.tenant_id=e.tenant_id
 WHERE e.id=subject AND e.tenant_id=t AND actor.id=u AND actor.archived_at IS NULL AND NOT app.login_blocked(u)
 AND actor.person_id IS DISTINCT FROM e.person_id AND app.data_permission_matches_for(u,t,e.id)
 AND EXISTS(SELECT 1 FROM public.employment manager WHERE manager.tenant_id=t AND manager.person_id=actor.person_id AND manager.terminated_on IS NULL
  AND (app.is_admin_report_of(e.id,manager.id) OR app.heads_department_of(e.id,manager.id))));
$$;
CREATE FUNCTION app.claim_related_decision_for(t uuid,u uuid,subject uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.claim_related_subject_for(t,u,subject) AND EXISTS(SELECT 1 FROM public.role_assignment assignment WHERE assignment.tenant_id=t AND assignment.app_user_id=u AND assignment.role::text IN ('hr_admin','super_admin'));
$$;
REVOKE ALL ON FUNCTION app.claim_related_decision_for(uuid,uuid,uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.claim_admin_subject_for(t uuid,u uuid,subject uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.employment e WHERE e.id=subject AND e.tenant_id=t AND app.module_action_legacy_allowed(t,u,'claims.view',e.company_id) AND app.data_permission_matches_for(u,t,e.id));
$$;
CREATE FUNCTION app.claim_assigned_subject_for(t uuid,u uuid,subject uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT t=app.current_tenant_id() AND EXISTS(SELECT 1 FROM public.employment e JOIN public.app_user actor ON actor.tenant_id=e.tenant_id
 WHERE e.id=subject AND e.tenant_id=t AND actor.id=u AND actor.archived_at IS NULL AND NOT app.login_blocked(u) AND actor.person_id IS NOT NULL AND actor.person_id<>e.person_id
 AND (EXISTS(SELECT 1 FROM public.reporting_line line JOIN public.employment manager ON manager.id=line.manager_employment_id AND manager.tenant_id=line.tenant_id
  WHERE line.tenant_id=t AND line.subordinate_employment_id=e.id AND line.line_type='administrative' AND line.superseded_at IS NULL AND line.valid_from<=current_date AND (line.valid_to IS NULL OR line.valid_to>current_date) AND manager.person_id=actor.person_id)
 OR EXISTS(SELECT 1 FROM public.reporting_line adm JOIN public.reporting_line delegation ON delegation.subordinate_employment_id=adm.manager_employment_id AND delegation.tenant_id=adm.tenant_id
  JOIN public.employment delegate ON delegate.id=delegation.manager_employment_id AND delegate.tenant_id=delegation.tenant_id
  WHERE adm.tenant_id=t AND adm.subordinate_employment_id=e.id AND adm.line_type='administrative' AND adm.superseded_at IS NULL AND adm.valid_from<=current_date AND (adm.valid_to IS NULL OR adm.valid_to>current_date)
  AND delegate.person_id=actor.person_id AND app.delegation_line_covers(delegation.id,e.id,'claims','claims.claim'))));
$$;
REVOKE ALL ON FUNCTION app.claim_related_subject_for(uuid,uuid,uuid),app.claim_admin_subject_for(uuid,uuid,uuid),app.claim_assigned_subject_for(uuid,uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- The existing self-super exception is a privileged own course, not ordinary self-approval.
CREATE FUNCTION app.claim_self_decision_native_allowed(t uuid,u uuid,cap text,co uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT cap IN ('function.claims.selfDecision.view','function.claims.selfDecision.approve') AND co IS NOT NULL
 AND EXISTS(SELECT 1 FROM public.employment e JOIN public.app_user actor ON actor.tenant_id=e.tenant_id AND actor.person_id=e.person_id
 JOIN public.role_assignment assignment ON assignment.tenant_id=actor.tenant_id AND assignment.app_user_id=actor.id
 WHERE e.tenant_id=t AND e.company_id=co AND e.voided_at IS NULL AND actor.id=u AND actor.archived_at IS NULL AND NOT app.login_blocked(u) AND assignment.role::text='super_admin' AND app.data_permission_matches_for(u,t,e.id));
$$;
CREATE FUNCTION app.claim_self_decision_current_native_allowed(t uuid,u uuid,cap text,co uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT t=app.current_tenant_id() AND u=app.current_user_id() AND app.principal_snapshot_current()
 AND coalesce(current_setting('app.roles',true),'')~'(^|,)super_admin(,|$)' AND app.claim_self_decision_native_allowed(t,u,cap,co);
$$;
REVOKE ALL ON FUNCTION app.claim_self_decision_native_allowed(uuid,uuid,text,uuid),app.claim_self_decision_current_native_allowed(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
DO $$ DECLARE operation text;BEGIN
 FOREACH operation IN ARRAY ARRAY['view','approve'] LOOP
  PERFORM app.register_function_action('claims.selfDecision',operation,'company',NULL,'app.claim_self_decision_current_native_allowed','{"moduleKey":"claims","labelKey":"claims.accessFunctions.selfDecision","kind":"native_acl","course":"own","employeeBearing":true}');
 END LOOP;
END $$;
CREATE FUNCTION app.claim_self_decision_allowed(subject uuid,p_operation text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT p_operation IN ('view','approve') AND app.claim_subject_is_own(subject) AND EXISTS(SELECT 1 FROM public.employment e WHERE e.id=subject AND e.tenant_id=app.current_tenant_id()
 AND app.claim_self_decision_current_native_allowed(e.tenant_id,app.current_user_id(),'function.claims.selfDecision.'||p_operation,e.company_id) AND app.function_action_allowed('claims.selfDecision','view',e.company_id) AND app.function_action_allowed('claims.selfDecision',p_operation,e.company_id));
$$;
REVOKE ALL ON FUNCTION app.claim_self_decision_allowed(uuid,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.claim_nonself_native_allowed(t uuid,u uuid,cap text,co uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT co IS NOT NULL AND EXISTS(SELECT 1 FROM public.employment e WHERE e.tenant_id=t AND e.company_id=co AND CASE
 WHEN cap IN ('function.claims.related.view','function.claims.related.execute') THEN app.claim_related_subject_for(t,u,e.id)
 WHEN cap='function.claims.related.approve' THEN app.claim_related_decision_for(t,u,e.id)
 WHEN cap IN ('function.claims.assigned.view','function.claims.assigned.approve') THEN app.claim_assigned_subject_for(t,u,e.id) AND EXISTS(SELECT 1 FROM public.claim_request request WHERE request.employment_id=e.id AND request.tenant_id=t AND request.status::text<>'draft')
 ELSE false END);
$$;
CREATE FUNCTION app.claim_nonself_current_native_allowed(t uuid,u uuid,cap text,co uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT t=app.current_tenant_id() AND u=app.current_user_id() AND app.principal_snapshot_current() AND app.claim_nonself_native_allowed(t,u,cap,co)
 AND EXISTS(SELECT 1 FROM public.employment e WHERE e.tenant_id=t AND e.company_id=co AND CASE
 WHEN cap IN ('function.claims.related.view','function.claims.related.execute') THEN app.claim_related_subject_for(t,u,e.id) AND app.can_see_employment(e.id)
 WHEN cap='function.claims.related.approve' THEN app.claim_related_decision_for(t,u,e.id) AND app.can_see_employment(e.id) AND coalesce(current_setting('app.roles',true),'')~'(^|,)(hr_admin|super_admin)(,|$)'
 WHEN cap IN ('function.claims.assigned.view','function.claims.assigned.approve') THEN app.claim_assigned_subject_for(t,u,e.id) AND EXISTS(SELECT 1 FROM public.claim_request request WHERE request.employment_id=e.id AND request.tenant_id=t AND request.status::text<>'draft')
 ELSE false END);
$$;
REVOKE ALL ON FUNCTION app.claim_nonself_native_allowed(uuid,uuid,text,uuid),app.claim_nonself_current_native_allowed(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
DO $$ DECLARE key text;operation text;BEGIN
 FOREACH key IN ARRAY ARRAY['related','assigned'] LOOP
  FOREACH operation IN ARRAY (CASE key WHEN 'related' THEN ARRAY['view','execute','approve'] ELSE ARRAY['view','approve'] END) LOOP
   PERFORM app.register_function_action('claims.'||key,operation,'company',NULL,'app.claim_nonself_current_native_allowed',jsonb_build_object('moduleKey','claims','labelKey','claims.accessFunctions.'||key,'kind','native_acl','course',CASE key WHEN 'assigned' THEN 'assigned' ELSE 'administrative' END,'employeeBearing',key<>'assigned'));
  END LOOP;
 END LOOP;
 PERFORM app.register_function_action('claims.administration','execute','company','claims.add','app.module_action_delegation_allowed','{}');
 PERFORM app.register_function_action('claims.administration','approve','company','claims.edit','app.module_action_delegation_allowed','{}');
END $$;
--> statement-breakpoint
CREATE FUNCTION app.claim_nonself_submit_allowed(subject uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND NOT app.claim_subject_is_own(subject) AND app.can_see_employment(subject)
 AND EXISTS(SELECT 1 FROM public.employment e WHERE e.id=subject AND e.tenant_id=app.current_tenant_id()
 AND (app.claim_admin_subject_for(e.tenant_id,app.current_user_id(),e.id) AND app.is_admin_for(e.company_id) AND app.module_action_allowed('claims','add',e.company_id) AND app.function_action_allowed('claims.administration','view',e.company_id) AND app.function_action_allowed('claims.administration','execute',e.company_id)
 OR app.claim_related_subject_for(e.tenant_id,app.current_user_id(),e.id) AND app.function_action_allowed('claims.related','view',e.company_id) AND app.function_action_allowed('claims.related','execute',e.company_id)));
$$;
CREATE FUNCTION app.claim_decision_allowed(subject uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND EXISTS(SELECT 1 FROM public.employment e WHERE e.id=subject AND e.tenant_id=app.current_tenant_id()
 AND (app.claim_admin_subject_for(e.tenant_id,app.current_user_id(),e.id) AND app.is_admin_for(e.company_id) AND NOT app.claim_subject_is_own(e.id) AND app.module_action_allowed('claims','edit',e.company_id) AND app.function_action_allowed('claims.administration','view',e.company_id) AND app.function_action_allowed('claims.administration','approve',e.company_id)
 OR app.claim_related_decision_for(e.tenant_id,app.current_user_id(),e.id) AND app.can_see_employment(e.id) AND coalesce(current_setting('app.roles',true),'')~'(^|,)(hr_admin|super_admin)(,|$)' AND app.function_action_allowed('claims.related','view',e.company_id) AND app.function_action_allowed('claims.related','approve',e.company_id)
 OR app.claim_assigned_subject_for(e.tenant_id,app.current_user_id(),e.id) AND app.function_action_allowed('claims.assigned','view',e.company_id) AND app.function_action_allowed('claims.assigned','approve',e.company_id) OR app.claim_self_decision_allowed(e.id,'approve')));
$$;
REVOKE ALL ON FUNCTION app.claim_nonself_submit_allowed(uuid),app.claim_decision_allowed(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_nonself_submit_allowed(uuid),app.claim_decision_allowed(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.claim_source_read_allowed(p_subject uuid,p_status text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 -- RLS supplies the actual row's subject/status. This is a permission predicate, not an ID lookup
 -- or a new-row existence waiver; no fresh-born source lookup is required by INSERT RETURNING.
 SELECT p_status IN ('draft','pending','approved','rejected','cancelled','paid') AND app.principal_snapshot_current() AND EXISTS(SELECT 1 FROM public.employment e
 WHERE e.id=p_subject AND e.tenant_id=app.current_tenant_id()
 AND (app.claim_subject_is_own(e.id) AND app.claim_own_read_allowed(e.id,p_status='draft') OR p_status<>'draft' AND app.claim_self_decision_allowed(e.id,'view')
 OR app.claim_admin_subject_for(e.tenant_id,app.current_user_id(),e.id) AND app.is_admin_for(e.company_id) AND app.module_action_allowed('claims','view',e.company_id) AND app.function_action_allowed('claims.administration','view',e.company_id)
 OR app.claim_related_subject_for(e.tenant_id,app.current_user_id(),e.id) AND app.can_see_employment(e.id) AND app.function_action_allowed('claims.related','view',e.company_id)
 OR p_status<>'draft' AND app.claim_assigned_subject_for(e.tenant_id,app.current_user_id(),e.id) AND app.function_action_allowed('claims.assigned','view',e.company_id)));
$$;
REVOKE ALL ON FUNCTION app.claim_source_read_allowed(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_source_read_allowed(uuid,text) TO ai_hr_app;
ALTER POLICY claim_own_action_read ON public.claim_request USING(app.claim_source_read_allowed(employment_id,status::text));
--> statement-breakpoint
-- Genuine current/pure function defaults retain own, recursive/HOD and assigned courses.
CREATE OR REPLACE FUNCTION app.module_function_legacy_allowed(t uuid,u uuid,cap text,co uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.claim_own_native_allowed(t,u,cap,co) OR app.claim_nonself_native_allowed(t,u,cap,co) OR app.claim_self_decision_native_allowed(t,u,cap,co)
 OR EXISTS(SELECT 1 FROM app.access_function_action a WHERE a.capability_id=cap AND a.function_key IN ('claimsConfig.types','claimsConfig.limits','claimsConfig.mileage','claimsConfig.reimbursements','claims.administration','leaveConfig.types','leaveConfig.gradeGroups','attendancePolicy.schedule') AND app.module_action_legacy_allowed(t,u,a.parent_capability,co));
$$;
CREATE OR REPLACE FUNCTION app.module_function_current_legacy_allowed(t uuid,u uuid,cap text,co uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.claim_own_current_native_allowed(t,u,cap,co) OR app.claim_nonself_current_native_allowed(t,u,cap,co) OR app.claim_self_decision_current_native_allowed(t,u,cap,co)
 OR EXISTS(SELECT 1 FROM app.access_function_action a WHERE a.capability_id=cap AND a.function_key IN ('claimsConfig.types','claimsConfig.limits','claimsConfig.mileage','claimsConfig.reimbursements','claims.administration','leaveConfig.types','leaveConfig.gradeGroups','attendancePolicy.schedule') AND app.module_action_current_native_default(t,u,a.parent_capability,co));
$$;

--> statement-breakpoint
-- Claims commands do not mutate native graph/scope/catalogue inputs. Keep their monotone
-- source continuity separate from generic control defaults and from ordinary Claim outcomes.
CREATE TABLE app.claim_native_source_epoch(tenant_id uuid PRIMARY KEY REFERENCES public.tenant(id) ON DELETE CASCADE,epoch bigint NOT NULL DEFAULT 1);
ALTER TABLE app.claim_native_source_epoch ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.claim_native_source_epoch FROM PUBLIC,ai_hr_app;
INSERT INTO app.claim_native_source_epoch(tenant_id) SELECT id FROM public.tenant;
CREATE FUNCTION app.claim_native_source_epoch_bump() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE affected uuid;query text;columns text[]:=string_to_array(coalesce(TG_ARGV[0],''),',');
BEGIN
 IF TG_TABLE_NAME='tenant' THEN INSERT INTO app.claim_native_source_epoch(tenant_id) SELECT id FROM new_rows ON CONFLICT DO NOTHING;RETURN NULL;END IF;
 IF TG_OP='UPDATE' THEN
  query:='WITH changed AS(SELECT n.tenant_id AS next_tenant,o.tenant_id AS prior_tenant FROM new_rows n FULL JOIN old_rows o USING(id) WHERE '
   ||CASE WHEN cardinality(columns)>0 THEN 'EXISTS(SELECT 1 FROM unnest($1::text[]) field WHERE to_jsonb(n)->field IS DISTINCT FROM to_jsonb(o)->field)' ELSE '(to_jsonb(n)-''updated_at'') IS DISTINCT FROM (to_jsonb(o)-''updated_at'')' END
   ||') SELECT next_tenant FROM changed WHERE next_tenant IS NOT NULL UNION SELECT prior_tenant FROM changed WHERE prior_tenant IS NOT NULL';
 ELSE query:='SELECT DISTINCT tenant_id FROM '||CASE TG_OP WHEN 'INSERT' THEN 'new_rows' ELSE 'old_rows' END;END IF;
 FOR affected IN EXECUTE query USING columns LOOP
  INSERT INTO app.claim_native_source_epoch AS current_epoch(tenant_id,epoch) SELECT affected,1 WHERE EXISTS(SELECT 1 FROM public.tenant tenant WHERE tenant.id=affected) ON CONFLICT(tenant_id) DO UPDATE SET epoch=current_epoch.epoch+1;
 END LOOP;RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.claim_native_source_epoch_bump() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER claim_native_epoch_seed AFTER INSERT ON public.tenant REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.claim_native_source_epoch_bump();
CREATE FUNCTION app.claim_native_source_statement_lock() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.current_tenant_id() IS NOT NULL THEN PERFORM app.access_workforce_write_lock();END IF;RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.claim_native_source_statement_lock() FROM PUBLIC,ai_hr_app;
DO $$ DECLARE relation_name text;columns text;BEGIN
 FOREACH relation_name IN ARRAY ARRAY['employment','person','assignment','reporting_line','company','department','claim_type','claim_item','claim_policy','claim_form_field','claim_mileage_rate'] LOOP
  columns:=CASE relation_name WHEN 'person' THEN 'id,tenant_id,nationality,gender,marital_status,voided_at' WHEN 'company' THEN 'id,tenant_id,parent_company_id,archived_at' WHEN 'department' THEN 'id,tenant_id,parent_department_id,company_id,business_unit_id,archived_at' ELSE '' END;
  EXECUTE format('CREATE TRIGGER claim_native_source_access BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION app.claim_native_source_statement_lock()',relation_name);
  EXECUTE format('CREATE TRIGGER claim_native_epoch_insert AFTER INSERT ON public.%I REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.claim_native_source_epoch_bump(%L)',relation_name,columns);
  EXECUTE format('CREATE TRIGGER claim_native_epoch_update AFTER UPDATE ON public.%I REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.claim_native_source_epoch_bump(%L)',relation_name,columns);
  EXECUTE format('CREATE TRIGGER claim_native_epoch_delete AFTER DELETE ON public.%I REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION app.claim_native_source_epoch_bump(%L)',relation_name,columns);
 END LOOP;
END $$;
CREATE FUNCTION app.claim_command_authority_stamp() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN app.access_function_authority_stamp() IS NOT NULL THEN encode(sha256(convert_to(jsonb_build_array(app.access_function_authority_stamp(),source.epoch)::text,'UTF8')),'hex') END FROM app.claim_native_source_epoch source WHERE source.tenant_id=app.current_tenant_id();
$$;
REVOKE ALL ON FUNCTION app.claim_command_authority_stamp() FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.claim_command_lock() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM app.access_workforce_write_lock();
 IF NOT app.principal_snapshot_current() THEN RAISE EXCEPTION 'Claim command principal unavailable' USING ERRCODE='42501';END IF;
 -- Physical native-source tuple fence refuses an old REPEATABLE READ view after revocation.
 PERFORM 1 FROM app.claim_native_source_epoch source WHERE source.tenant_id=app.current_tenant_id() FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Claim native source unavailable' USING ERRCODE='42501';END IF;
END $$;
REVOKE ALL ON FUNCTION app.claim_command_lock() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_command_lock() TO ai_hr_app;
CREATE FUNCTION app.claim_command_statement_lock() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.current_tenant_id() IS NOT NULL AND NOT app.access_workforce_storage_owner() THEN PERFORM app.claim_command_lock();END IF;RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.claim_command_statement_lock() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER claim_command_source_lock BEFORE INSERT OR UPDATE ON public.claim_request FOR EACH STATEMENT EXECUTE FUNCTION app.claim_command_statement_lock();
--> statement-breakpoint
-- Native command receipts prove the actual admitted queued OLD→NEW, never a posted purpose flag.
CREATE TABLE app.claim_command_effect(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),xact_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,claim_id uuid NOT NULL,course text NOT NULL CHECK(course IN ('submit','approve','reject')),before_source jsonb NOT NULL,after_source jsonb NOT NULL,authority_stamp text NOT NULL,born boolean NOT NULL DEFAULT false,completed boolean NOT NULL DEFAULT false);
REVOKE ALL ON app.claim_command_effect FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.claim_own_source_audit_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW.aggregate_type='claim-request' AND NEW.event_type IN ('claim-request.draft-saved','claim-request.submitted','claim-request.approved','claim-request.rejected') AND NEW.actor_type='user' AND NEW.actor_id=app.current_user_id() AND NEW.tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() THEN
  DELETE FROM app.claim_own_source_audit WHERE xact_id<pg_snapshot_xmin(pg_current_snapshot());
  INSERT INTO app.claim_own_source_audit VALUES(pg_current_xact_id(),NEW.tenant_id,NEW.actor_id,NEW.aggregate_id,NEW.id,NEW.event_type,NEW.payload);
  UPDATE app.claim_command_effect proof SET completed=true WHERE proof.xact_id=pg_current_xact_id() AND proof.tenant_id=NEW.tenant_id AND proof.user_id=NEW.actor_id AND proof.claim_id=NEW.aggregate_id AND proof.born AND NEW.event_type=CASE proof.course WHEN 'submit' THEN 'claim-request.submitted' WHEN 'approve' THEN 'claim-request.approved' ELSE 'claim-request.rejected' END;
 END IF;RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.claim_command_effect_allowed(p_before jsonb,p_after jsonb,p_course text,p_receipt uuid DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app.claim_command_effect proof JOIN app.claim_own_source_audit audit ON audit.xact_id=proof.xact_id AND audit.tenant_id=proof.tenant_id AND audit.user_id=proof.user_id AND audit.claim_id=proof.claim_id
   JOIN public.domain_event event ON event.id=audit.event_id AND event.tenant_id=audit.tenant_id AND event.aggregate_id=proof.claim_id AND event.subject_employment_id=(p_after->>'employment_id')::uuid AND event.actor_type='user' AND event.actor_id=proof.user_id AND event.aggregate_type='claim-request'
   WHERE proof.xact_id=pg_current_xact_id() AND proof.tenant_id=app.current_tenant_id() AND proof.user_id=app.current_user_id() AND proof.claim_id=(p_after->>'id')::uuid AND proof.course=p_course AND (p_receipt IS NULL OR proof.id=p_receipt) AND proof.before_source=p_before AND proof.after_source=p_after AND proof.born AND proof.completed AND proof.authority_stamp=app.claim_command_authority_stamp()
   AND event.event_type=CASE p_course WHEN 'submit' THEN 'claim-request.submitted' WHEN 'approve' THEN 'claim-request.approved' ELSE 'claim-request.rejected' END
   AND CASE p_course WHEN 'submit' THEN event.payload->>'claimTypeId'=p_after->>'claim_type_id' AND event.payload->>'claimItemId' IS NOT DISTINCT FROM p_after->>'claim_item_id' AND event.payload->>'incurredOn'=p_after->>'incurred_on' AND event.payload->>'taxable'=p_after->>'taxable'
    WHEN 'approve' THEN event.payload->>'taxable'=p_after->>'taxable' AND event.payload->>'payoutMethod'=CASE WHEN p_after->>'taxable'='true' THEN 'payroll' ELSE 'reimbursement' END ELSE true END) AND CASE p_course WHEN 'submit' THEN app.claim_nonself_submit_allowed((p_after->>'employment_id')::uuid) WHEN 'approve' THEN app.claim_decision_allowed((p_after->>'employment_id')::uuid) WHEN 'reject' THEN app.claim_decision_allowed((p_after->>'employment_id')::uuid) ELSE false END;
$$;
REVOKE ALL ON FUNCTION app.claim_command_effect_allowed(jsonb,jsonb,text,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.claim_command_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE wanted_course text;prior jsonb:=CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;proposed jsonb:=to_jsonb(NEW);subject uuid:=NEW.employment_id;admitted boolean;
BEGIN
 IF app.access_workforce_storage_owner() THEN RETURN NEW;END IF;
 IF TG_OP='INSERT' AND NOT app.claim_subject_is_own(subject) THEN
  IF NEW.status::text<>'pending' OR NEW.decided_at IS NOT NULL OR NEW.decided_by_employment_id IS NOT NULL OR NEW.payroll_batch_id IS NOT NULL OR NEW.paid_at IS NOT NULL OR NEW.payout_ref IS NOT NULL THEN RAISE EXCEPTION 'Nonself claim creation source unavailable' USING ERRCODE='42501';END IF;
  wanted_course:='submit';admitted:=app.claim_nonself_submit_allowed(subject);
 ELSIF TG_OP='UPDATE' AND OLD.status::text='pending' AND NEW.status::text IN ('approved','rejected') THEN
  IF prior-ARRAY['status','taxable','decided_by_employment_id','decided_at'] IS DISTINCT FROM proposed-ARRAY['status','taxable','decided_by_employment_id','decided_at'] OR NEW.decided_at IS NULL OR NEW.status::text='rejected' AND OLD.taxable IS DISTINCT FROM NEW.taxable OR NEW.decided_by_employment_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.employment decider WHERE decider.id=NEW.decided_by_employment_id AND decider.tenant_id=NEW.tenant_id) THEN RAISE EXCEPTION 'Claim decision fields unavailable' USING ERRCODE='42501';END IF;
  wanted_course:=CASE NEW.status::text WHEN 'approved' THEN 'approve' ELSE 'reject' END;admitted:=app.claim_decision_allowed(subject);
 ELSIF TG_OP='UPDATE' AND NOT app.claim_subject_is_own(subject) AND OLD.status::text<>'draft' AND NEW.status=OLD.status
  AND prior-ARRAY['payroll_batch_id','paid_at','payout_ref'] IS DISTINCT FROM proposed-ARRAY['payroll_batch_id','paid_at','payout_ref'] THEN RAISE EXCEPTION 'Filed claim is immutable' USING ERRCODE='42501';
 ELSE RETURN NEW;END IF;
 IF admitted IS NOT TRUE THEN RAISE EXCEPTION 'Claim command unavailable' USING ERRCODE='42501';END IF;
 IF TG_WHEN='BEFORE' THEN
  DELETE FROM app.claim_command_effect WHERE xact_id<pg_snapshot_xmin(pg_current_snapshot());
  INSERT INTO app.claim_command_effect(xact_id,tenant_id,user_id,claim_id,course,before_source,after_source,authority_stamp) VALUES(pg_current_xact_id(),NEW.tenant_id,app.current_user_id(),NEW.id,wanted_course,prior,proposed,app.claim_command_authority_stamp());
 ELSE
  IF NOT app.claim_command_effect_allowed(prior,proposed,wanted_course)  THEN RAISE EXCEPTION 'Claim command effects incomplete' USING ERRCODE='42501';END IF;
 END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.claim_command_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER claim_command BEFORE INSERT OR UPDATE ON public.claim_request FOR EACH ROW EXECUTE FUNCTION app.claim_command_guard();
CREATE CONSTRAINT TRIGGER claim_command_final AFTER INSERT OR UPDATE ON public.claim_request DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.claim_command_guard();
--> statement-breakpoint
CREATE FUNCTION app.claim_command_born() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT app.access_workforce_storage_owner() THEN UPDATE app.claim_command_effect proof SET born=true WHERE proof.xact_id=pg_current_xact_id() AND proof.tenant_id=NEW.tenant_id AND proof.user_id=app.current_user_id() AND proof.claim_id=NEW.id AND proof.before_source=CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END AND proof.after_source=to_jsonb(NEW);END IF;RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.claim_command_born() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER claim_command_born AFTER INSERT OR UPDATE ON public.claim_request FOR EACH ROW EXECUTE FUNCTION app.claim_command_born();
--> statement-breakpoint
-- Only the exact whole-Claim decision gets an assigned write course; no arbitrary field editor.
CREATE POLICY claim_assigned_command ON public.claim_request FOR UPDATE TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND status::text='pending' AND app.claim_assigned_subject_for(tenant_id,app.current_user_id(),employment_id) AND app.claim_decision_allowed(employment_id))
 WITH CHECK(tenant_id=app.current_tenant_id() AND status::text IN ('approved','rejected') AND app.claim_assigned_subject_for(tenant_id,app.current_user_id(),employment_id) AND app.claim_decision_allowed(employment_id));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.claim_own_receipt_read_allowed(p_claim uuid,p_subject uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND EXISTS(SELECT 1 FROM public.claim_request actual WHERE actual.id=p_claim AND actual.tenant_id=app.current_tenant_id() AND actual.employment_id=p_subject AND app.claim_source_read_allowed(p_subject,actual.status::text)
 AND (NOT app.claim_subject_is_own(p_subject) OR app.claim_own_source_allowed(p_subject,'claims.own.receipts','view') OR app.claim_self_decision_allowed(p_subject,'view') OR EXISTS(SELECT 1 FROM public.employment e WHERE e.id=p_subject AND e.tenant_id=actual.tenant_id AND app.claim_admin_subject_for(e.tenant_id,app.current_user_id(),e.id) AND app.is_admin_for(e.company_id) AND app.module_action_allowed('claims','view',e.company_id) AND app.function_action_allowed('claims.administration','view',e.company_id))));
$$;

--> statement-breakpoint
-- Exact pending-decision facts, including the genuine assigned direct-manager course outside an
-- administrative data profile. This is not an employment directory or a role-only grade lookup.
CREATE OR REPLACE FUNCTION app.claim_decision_subject_facts(claim_id uuid) RETURNS TABLE(grade_id uuid,company_id uuid,country text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT e.grade_id,e.company_id,company.country::text FROM public.claim_request request JOIN public.employment e ON e.id=request.employment_id AND e.tenant_id=request.tenant_id
 JOIN public.company company ON company.id=e.company_id AND company.tenant_id=e.tenant_id
 WHERE request.id=claim_id AND request.tenant_id=app.current_tenant_id() AND request.status::text='pending' AND app.claim_decision_allowed(e.id);
$$;


--> statement-breakpoint
-- A skipped/conflicting physical INSERT cannot leave an admitted but unborn command receipt.
CREATE FUNCTION app.claim_command_effect_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE proof app.claim_command_effect%ROWTYPE;
BEGIN
 SELECT * INTO proof FROM app.claim_command_effect actual WHERE actual.id=NEW.id;
 IF NOT FOUND OR app.claim_command_effect_allowed(proof.before_source,proof.after_source,proof.course,proof.id) IS NOT TRUE THEN RAISE EXCEPTION 'Claim command effects incomplete' USING ERRCODE='42501';END IF;RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.claim_command_effect_complete() FROM PUBLIC,ai_hr_app;
CREATE CONSTRAINT TRIGGER claim_command_effect_complete AFTER INSERT OR UPDATE ON app.claim_command_effect DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.claim_command_effect_complete();

--> statement-breakpoint
-- Actual nonself receipt maintenance retains the native can-see/data course. A delegated approval
-- may read its task receipt but never inherits this independent upload permission.
CREATE FUNCTION app.claim_receipt_native_allowed(t uuid,u uuid,cap text,co uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT co IS NOT NULL AND EXISTS(SELECT 1 FROM public.employment e WHERE e.tenant_id=t AND e.company_id=co AND CASE
 WHEN cap IN ('function.claims.related.view','function.claims.related.receipts.view','function.claims.related.receipts.add') THEN app.claim_related_subject_for(t,u,e.id)
 WHEN cap IN ('function.claims.administration.view','function.claims.administration.receipts.view','function.claims.administration.receipts.add') THEN app.claim_admin_subject_for(t,u,e.id)
 ELSE false END);
$$;
CREATE FUNCTION app.claim_receipt_current_native_allowed(t uuid,u uuid,cap text,co uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT t=app.current_tenant_id() AND u=app.current_user_id() AND app.principal_snapshot_current() AND app.claim_receipt_native_allowed(t,u,cap,co)
 AND EXISTS(SELECT 1 FROM public.employment e WHERE e.tenant_id=t AND e.company_id=co AND app.can_see_employment(e.id) AND CASE
 WHEN cap IN ('function.claims.related.view','function.claims.related.receipts.view','function.claims.related.receipts.add') THEN app.claim_related_subject_for(t,u,e.id)
 WHEN cap IN ('function.claims.administration.view','function.claims.administration.receipts.view','function.claims.administration.receipts.add') THEN app.claim_admin_subject_for(t,u,e.id) AND app.is_admin_for(co)
 ELSE false END);
$$;
REVOKE ALL ON FUNCTION app.claim_receipt_native_allowed(uuid,uuid,text,uuid),app.claim_receipt_current_native_allowed(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
DO $$ DECLARE key text;operation text;BEGIN
 FOREACH key IN ARRAY ARRAY['related','administration'] LOOP
  FOREACH operation IN ARRAY ARRAY['view','add'] LOOP
   PERFORM app.register_function_action('claims.'||key||'.receipts',operation,'company','function.claims.'||key||'.view','app.claim_receipt_current_native_allowed',jsonb_build_object('moduleKey','claims','labelKey','claims.accessFunctions.'||key||'Receipts','kind','native_acl','course','administrative','employeeBearing',true));
  END LOOP;
 END LOOP;
END $$;
CREATE FUNCTION app.claim_maintenance_receipt_allowed(subject uuid,p_operation text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT p_operation IN ('view','add') AND app.principal_snapshot_current() AND app.can_see_employment(subject)
 AND EXISTS(SELECT 1 FROM public.employment e WHERE e.id=subject AND e.tenant_id=app.current_tenant_id()
 AND (app.claim_admin_subject_for(e.tenant_id,app.current_user_id(),e.id) AND app.is_admin_for(e.company_id) AND app.module_action_allowed('claims','view',e.company_id) AND app.function_action_allowed('claims.administration','view',e.company_id) AND app.function_action_allowed('claims.administration.receipts','view',e.company_id) AND app.function_action_allowed('claims.administration.receipts',p_operation,e.company_id)
 OR app.claim_related_subject_for(e.tenant_id,app.current_user_id(),e.id) AND app.function_action_allowed('claims.related','view',e.company_id) AND app.function_action_allowed('claims.related.receipts','view',e.company_id) AND app.function_action_allowed('claims.related.receipts',p_operation,e.company_id)));
$$;
REVOKE ALL ON FUNCTION app.claim_maintenance_receipt_allowed(uuid,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
ALTER TABLE app.claim_own_receipt_effect ADD COLUMN native_course text NOT NULL DEFAULT 'own' CHECK(native_course IN ('own','nonself'));
CREATE OR REPLACE FUNCTION app.claim_own_source_mutation_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE course text;own boolean:=app.claim_subject_is_own(NEW.employment_id);
BEGIN
 IF app.access_workforce_storage_owner() THEN RETURN NULL;END IF;
 IF NEW.status::text='draft' AND own THEN course:=CASE TG_OP WHEN 'INSERT' THEN 'draft-add' ELSE 'draft-edit' END;
 ELSIF NEW.status::text='pending' AND(TG_OP='INSERT' OR OLD.status::text='draft') THEN
  course:='submit';
  IF NOT own AND NOT EXISTS(SELECT 1 FROM app.claim_command_effect proof WHERE proof.xact_id=pg_current_xact_id() AND proof.tenant_id=NEW.tenant_id AND proof.user_id=app.current_user_id() AND proof.claim_id=NEW.id AND proof.course='submit' AND proof.after_source=to_jsonb(NEW) AND proof.born AND proof.authority_stamp=app.claim_command_authority_stamp()) THEN RETURN NULL;END IF;
 ELSE RETURN NULL;END IF;
 DELETE FROM app.claim_own_source_mutation WHERE xact_id<pg_snapshot_xmin(pg_current_snapshot());
 INSERT INTO app.claim_own_source_mutation(xact_id,tenant_id,user_id,claim_id,course,source,authority_stamp) VALUES(pg_current_xact_id(),NEW.tenant_id,app.current_user_id(),NEW.id,course,to_jsonb(NEW),app.claim_command_authority_stamp());RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.claim_receipt_native(p_claim uuid,p_name text,p_mime text,p_content bytea,p_course text DEFAULT 'receipt-add') RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE parent public.claim_request%ROWTYPE;attachment public.claim_attachment%ROWTYPE;source_id uuid;authority text;event uuid;operation text;own boolean;
BEGIN
 PERFORM app.claim_command_lock();
 SELECT * INTO parent FROM public.claim_request actual WHERE actual.id=p_claim AND actual.tenant_id=app.current_tenant_id() FOR UPDATE;
 own:=app.claim_subject_is_own(parent.employment_id);
 IF parent.id IS NULL OR parent.status::text NOT IN ('draft','pending') OR p_course IS NULL OR p_course NOT IN ('draft-add','draft-edit','submit','receipt-add') OR p_name IS NULL OR p_mime IS NULL OR p_mime NOT IN ('application/pdf','image/jpeg','image/png') OR p_content IS NULL OR octet_length(p_content) NOT BETWEEN 1 AND 10485760
 OR CASE WHEN own THEN NOT app.claim_own_source_allowed(parent.employment_id,'claims.own.receipts','view') ELSE NOT app.claim_maintenance_receipt_allowed(parent.employment_id,'view') END
 THEN RAISE EXCEPTION '%',CASE WHEN own THEN 'Own claim receipt unavailable' ELSE 'Claim receipt unavailable' END USING ERRCODE='42501';END IF;
 authority:=app.claim_command_authority_stamp();
 IF p_course='receipt-add' THEN
  IF CASE WHEN own THEN NOT app.claim_own_source_allowed(parent.employment_id,'claims.own.receipts','add') ELSE NOT app.claim_maintenance_receipt_allowed(parent.employment_id,'add') END THEN RAISE EXCEPTION '%',CASE WHEN own THEN 'Own claim receipt Add unavailable' ELSE 'Claim receipt Add unavailable' END USING ERRCODE='42501';END IF;
 ELSE
  operation:=CASE p_course WHEN 'draft-add' THEN 'add' WHEN 'draft-edit' THEN 'edit' ELSE 'execute' END;
  IF CASE WHEN own THEN NOT app.claim_own_source_allowed(parent.employment_id,CASE WHEN p_course='submit' THEN 'claims.own.submit' ELSE 'claims.own.drafts' END,operation) ELSE p_course<>'submit' OR NOT app.claim_nonself_submit_allowed(parent.employment_id) END THEN RAISE EXCEPTION '%',CASE WHEN own THEN 'Own receipt source action unavailable' ELSE 'Claim receipt source action unavailable' END USING ERRCODE='42501';END IF;
  SELECT source.id INTO source_id FROM app.claim_own_source_mutation source WHERE source.xact_id=pg_current_xact_id() AND source.tenant_id=parent.tenant_id AND source.user_id=app.current_user_id() AND source.claim_id=parent.id AND source.course=p_course AND source.source=to_jsonb(parent) AND source.authority_stamp=authority AND source.receipt_id IS NULL ORDER BY source.id LIMIT 1 FOR UPDATE;
  IF source_id IS NULL THEN RAISE EXCEPTION '%',CASE WHEN own THEN 'Own receipt native source unavailable' ELSE 'Claim receipt native source unavailable' END USING ERRCODE='42501';END IF;
 END IF;
 attachment.id:=gen_random_uuid();attachment.tenant_id:=parent.tenant_id;attachment.claim_request_id:=parent.id;attachment.employment_id:=parent.employment_id;attachment.content:=p_content;attachment.file_name:=p_name;attachment.mime_type:=p_mime;attachment.size_bytes:=octet_length(p_content);attachment.uploaded_by_user_id:=app.current_user_id();attachment.created_at:=now();
 DELETE FROM app.claim_own_receipt_effect WHERE xact_id<pg_snapshot_xmin(pg_current_snapshot());
 INSERT INTO app.claim_own_receipt_effect(xact_id,tenant_id,user_id,receipt_id,claim_id,employment_id,course,source_id,metadata,content_hash,authority_stamp,native_course) VALUES(pg_current_xact_id(),parent.tenant_id,app.current_user_id(),attachment.id,parent.id,parent.employment_id,p_course,source_id,to_jsonb(attachment)-'content',encode(sha256(p_content),'hex'),authority,CASE WHEN own THEN 'own' ELSE 'nonself' END);
 IF source_id IS NOT NULL THEN UPDATE app.claim_own_source_mutation SET receipt_id=attachment.id WHERE id=source_id;END IF;
 INSERT INTO public.claim_attachment SELECT(attachment).*;
 IF NOT FOUND THEN RAISE EXCEPTION 'Claim receipt insert changed' USING ERRCODE='40001';END IF;
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload) VALUES(parent.tenant_id,'claim-request',parent.id,'claim-request.receipt-added','user',app.current_user_id(),parent.employment_id,jsonb_build_object('fileName',p_name,'sizeBytes',octet_length(p_content))) RETURNING id INTO event;
 UPDATE app.claim_own_receipt_effect SET completed=true,event_id=event WHERE xact_id=pg_current_xact_id() AND tenant_id=parent.tenant_id AND user_id=app.current_user_id() AND receipt_id=attachment.id;
 RETURN attachment.id;
END $$;
REVOKE ALL ON FUNCTION app.claim_receipt_native(uuid,text,text,bytea,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_receipt_native(uuid,text,text,bytea,text) TO ai_hr_app;
--> statement-breakpoint
-- Preserve the published narrow API contract: its name never becomes a nonself-purpose bypass.
CREATE OR REPLACE FUNCTION app.claim_own_receipt_native(p_claim uuid,p_name text,p_mime text,p_content bytea,p_course text DEFAULT 'receipt-add') RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.claim_request actual WHERE actual.id=p_claim AND actual.tenant_id=app.current_tenant_id() AND app.claim_subject_is_own(actual.employment_id)) THEN RAISE EXCEPTION 'Own claim receipt unavailable' USING ERRCODE='42501';END IF;
 RETURN app.claim_receipt_native(p_claim,p_name,p_mime,p_content,p_course);
END $$;
--> statement-breakpoint
CREATE FUNCTION app.claim_receipt_effect_context_allowed(p_receipt uuid,p_final boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app.claim_own_receipt_effect proof WHERE proof.xact_id=pg_current_xact_id() AND proof.tenant_id=app.current_tenant_id() AND proof.user_id=app.current_user_id() AND proof.receipt_id=p_receipt AND proof.authority_stamp=app.claim_command_authority_stamp()
 AND CASE proof.native_course WHEN 'own' THEN app.claim_subject_is_own(proof.employment_id) AND app.claim_own_source_allowed(proof.employment_id,'claims.own.receipts','view') AND CASE proof.course WHEN 'receipt-add' THEN app.claim_own_source_allowed(proof.employment_id,'claims.own.receipts','add') ELSE app.claim_own_source_allowed(proof.employment_id,CASE WHEN proof.course='submit' THEN 'claims.own.submit' ELSE 'claims.own.drafts' END,CASE proof.course WHEN 'submit' THEN 'execute' WHEN 'draft-add' THEN 'add' ELSE 'edit' END) END
 WHEN 'nonself' THEN NOT app.claim_subject_is_own(proof.employment_id) AND app.claim_maintenance_receipt_allowed(proof.employment_id,'view') AND CASE proof.course WHEN 'receipt-add' THEN app.claim_maintenance_receipt_allowed(proof.employment_id,'add') WHEN 'submit' THEN app.claim_nonself_submit_allowed(proof.employment_id) ELSE false END ELSE false END
 AND(NOT p_final OR proof.born AND proof.completed AND EXISTS(SELECT 1 FROM public.domain_event event WHERE event.id=proof.event_id AND event.tenant_id=proof.tenant_id AND event.aggregate_id=proof.claim_id AND event.aggregate_type='claim-request' AND event.actor_type='user' AND event.actor_id=proof.user_id AND event.subject_employment_id=proof.employment_id AND event.event_type='claim-request.receipt-added' AND event.payload->>'fileName'=proof.metadata->>'file_name' AND event.payload->>'sizeBytes'=proof.metadata->>'size_bytes')
 AND(proof.source_id IS NULL OR EXISTS(SELECT 1 FROM app.claim_own_source_mutation source JOIN app.claim_own_source_audit audit ON audit.xact_id=source.xact_id AND audit.tenant_id=source.tenant_id AND audit.user_id=source.user_id AND audit.claim_id=source.claim_id WHERE source.id=proof.source_id AND source.receipt_id=proof.receipt_id AND source.authority_stamp=proof.authority_stamp AND audit.event_type=CASE WHEN source.course='submit' THEN 'claim-request.submitted' ELSE 'claim-request.draft-saved' END AND audit.payload->>'claimTypeId'=source.source->>'claim_type_id' AND audit.payload->>'claimItemId' IS NOT DISTINCT FROM source.source->>'claim_item_id' AND audit.payload->>'incurredOn'=source.source->>'incurred_on'))));
$$;
REVOKE ALL ON FUNCTION app.claim_receipt_effect_context_allowed(uuid,boolean) FROM PUBLIC,ai_hr_app;
CREATE OR REPLACE FUNCTION app.claim_own_receipt_approved(p_receipt uuid,p_row jsonb,p_content bytea,p_final boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.claim_receipt_effect_context_allowed(p_receipt,p_final) AND EXISTS(SELECT 1 FROM app.claim_own_receipt_effect proof WHERE proof.xact_id=pg_current_xact_id() AND proof.tenant_id=app.current_tenant_id() AND proof.user_id=app.current_user_id() AND proof.receipt_id=p_receipt AND proof.metadata=p_row-'content' AND proof.content_hash=encode(sha256(p_content),'hex'));
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.claim_own_receipt_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE image jsonb:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;source jsonb;
BEGIN
 IF app.access_workforce_storage_owner() THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'Claim receipts are immutable' USING ERRCODE='42501';END IF;
 IF TG_OP='DELETE' THEN
  SELECT proof.before_source INTO source FROM app.claim_draft_delete_effect proof WHERE proof.xact_id=pg_current_xact_id() AND proof.tenant_id=OLD.tenant_id AND proof.user_id=app.current_user_id() AND proof.claim_id=OLD.claim_request_id AND proof.before_source->>'employment_id'=OLD.employment_id::text;
  IF source IS NULL OR NOT app.claim_draft_delete_approved(OLD.claim_request_id,source,TG_WHEN='AFTER') THEN RAISE EXCEPTION 'Claim receipt removal source unavailable' USING ERRCODE='42501';END IF;RETURN OLD;
 END IF;
 IF NOT app.claim_own_receipt_approved(NEW.id,image,NEW.content,TG_WHEN='AFTER') THEN RAISE EXCEPTION '%',CASE WHEN app.claim_subject_is_own(NEW.employment_id) THEN 'Own claim receipt source unavailable' ELSE 'Claim receipt source unavailable' END USING ERRCODE='42501';END IF;RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.claim_own_receipt_read_allowed(p_claim uuid,p_subject uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND EXISTS(SELECT 1 FROM public.claim_request actual JOIN public.employment e ON e.id=actual.employment_id AND e.tenant_id=actual.tenant_id WHERE actual.id=p_claim AND actual.tenant_id=app.current_tenant_id() AND actual.employment_id=p_subject AND app.claim_source_read_allowed(p_subject,actual.status::text)
 AND(app.claim_subject_is_own(p_subject) AND app.claim_own_source_allowed(p_subject,'claims.own.receipts','view') OR app.claim_maintenance_receipt_allowed(p_subject,'view') OR actual.status::text<>'draft' AND(app.claim_self_decision_allowed(p_subject,'view') OR app.claim_assigned_subject_for(e.tenant_id,app.current_user_id(),e.id) AND app.function_action_allowed('claims.assigned','view',e.company_id))));
$$;


--> statement-breakpoint
-- Approval-template writes keep the native ANY-HR tenant course; Leave Types' group-only
-- maintenance parent would remove the real company-HR template constructor.
CREATE FUNCTION app.leave_approval_template_native_allowed(t uuid,u uuid,cap text,co uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT co IS NULL AND cap IN ('function.leaveApproval.templates.view','function.leaveApproval.templates.add','function.leaveApproval.templates.edit','function.leaveApproval.templates.delete')
 AND EXISTS(SELECT 1 FROM public.app_user actor WHERE actor.id=u AND actor.tenant_id=t AND actor.archived_at IS NULL AND NOT app.login_blocked(actor.id))
 AND(cap='function.leaveApproval.templates.view' OR app.module_action_legacy_allowed(t,u,'leave_configuration.'||split_part(cap,'.',4),NULL));
$$;
CREATE FUNCTION app.leave_approval_template_current_native_allowed(t uuid,u uuid,cap text,co uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT t=app.current_tenant_id() AND u=app.current_user_id() AND app.principal_snapshot_current() AND app.leave_approval_template_native_allowed(t,u,cap,co)
 AND(cap='function.leaveApproval.templates.view' OR app.is_admin());
$$;
REVOKE ALL ON FUNCTION app.leave_approval_template_native_allowed(uuid,uuid,text,uuid),app.leave_approval_template_current_native_allowed(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
DO $$ DECLARE operation text;BEGIN
 FOREACH operation IN ARRAY ARRAY['view','add','edit','delete'] LOOP
  PERFORM app.register_function_action('leaveApproval.templates',operation,'tenant',NULL,'app.leave_approval_template_current_native_allowed','{"moduleKey":"leave","labelKey":"leaveApproval.templateCreationTitle","kind":"native_acl","course":"administrative","screenKey":"leaveApproval","href":"/admin/leave-config/approval-chains","employeeBearing":false}');
 END LOOP;
END $$;
CREATE FUNCTION app.leave_approval_template_allowed(p_operation text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.leave_approval_template_current_native_allowed(app.current_tenant_id(),app.current_user_id(),'function.leaveApproval.templates.'||p_operation,NULL)
 AND app.function_action_allowed('leaveApproval.templates','view',NULL) AND app.function_action_allowed('leaveApproval.templates',p_operation,NULL);
$$;
REVOKE ALL ON FUNCTION app.leave_approval_template_allowed(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.leave_approval_template_allowed(text) TO ai_hr_app;
CREATE FUNCTION app.leave_approval_template_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE operation text:=CASE TG_OP WHEN 'INSERT' THEN 'add' WHEN 'DELETE' THEN 'delete' ELSE 'edit' END;
BEGIN
 IF app.access_workforce_storage_owner() THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 PERFORM app.access_workforce_write_lock();
 IF TG_OP='UPDATE' AND OLD.active AND NOT NEW.active THEN operation:='delete';END IF;
 IF coalesce(NEW.tenant_id,OLD.tenant_id) IS DISTINCT FROM app.current_tenant_id() OR TG_OP='UPDATE' AND ROW(OLD.id,OLD.tenant_id) IS DISTINCT FROM ROW(NEW.id,NEW.tenant_id)
 OR NOT app.leave_approval_template_allowed(operation) THEN RAISE EXCEPTION 'Leave approval template action unavailable' USING ERRCODE='42501';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END $$;
REVOKE ALL ON FUNCTION app.leave_approval_template_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER module_leave_approval_template_lock BEFORE INSERT OR UPDATE OR DELETE ON public.leave_approval_template FOR EACH STATEMENT EXECUTE FUNCTION app.module_configuration_write_lock();
CREATE TRIGGER module_leave_approval_template_action BEFORE INSERT OR UPDATE OR DELETE ON public.leave_approval_template FOR EACH ROW EXECUTE FUNCTION app.leave_approval_template_guard();

--> statement-breakpoint
-- Per-company approval assignment is independent of tenant template maintenance.
CREATE FUNCTION app.leave_approval_company_native_allowed(t uuid,u uuid,cap text,co uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT cap IN ('function.leaveApproval.assignments.view','function.leaveApproval.assignments.add','function.leaveApproval.assignments.edit','function.leaveApproval.assignments.delete','function.leaveApproval.escalation.view','function.leaveApproval.escalation.edit')
 AND EXISTS(SELECT 1 FROM public.company c WHERE c.id=co AND c.tenant_id=t)
 AND EXISTS(SELECT 1 FROM public.app_user actor WHERE actor.id=u AND actor.tenant_id=t AND actor.archived_at IS NULL AND NOT app.login_blocked(actor.id))
 AND(split_part(cap,'.',4)='view' OR app.module_action_legacy_allowed(t,u,'leave.'||split_part(cap,'.',4),co));
$$;
CREATE FUNCTION app.leave_approval_company_current_native_allowed(t uuid,u uuid,cap text,co uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT t=app.current_tenant_id() AND u=app.current_user_id() AND app.principal_snapshot_current() AND app.leave_approval_company_native_allowed(t,u,cap,co)
 AND(split_part(cap,'.',4)='view' OR app.is_admin_for(co));
$$;
REVOKE ALL ON FUNCTION app.leave_approval_company_native_allowed(uuid,uuid,text,uuid),app.leave_approval_company_current_native_allowed(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
DO $$ DECLARE key text;operation text;BEGIN
 FOREACH key IN ARRAY ARRAY['assignments','escalation'] LOOP
  FOREACH operation IN ARRAY (CASE key WHEN 'assignments' THEN ARRAY['view','add','edit','delete'] ELSE ARRAY['view','edit'] END) LOOP
   PERFORM app.register_function_action('leaveApproval.'||key,operation,'company',NULL,'app.leave_approval_company_current_native_allowed',jsonb_build_object('moduleKey','leave','labelKey',CASE key WHEN 'assignments' THEN 'leaveApproval.assignmentTemplateTitle' ELSE 'leaveApproval.escalationTitle' END,'kind','native_acl','course','administrative','screenKey','leaveApproval','href','/admin/leave-config/approval-chains','employeeBearing',false));
  END LOOP;
 END LOOP;
END $$;
CREATE FUNCTION app.leave_approval_company_allowed(p_key text,p_operation text,p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.leave_approval_company_current_native_allowed(app.current_tenant_id(),app.current_user_id(),'function.'||p_key||'.'||p_operation,p_company)
 AND app.function_action_allowed(p_key,'view',p_company) AND app.function_action_allowed(p_key,p_operation,p_company);
$$;
REVOKE ALL ON FUNCTION app.leave_approval_company_allowed(text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.leave_approval_company_allowed(text,text,uuid) TO ai_hr_app;
CREATE FUNCTION app.leave_approval_assignment_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE operation text:=CASE TG_OP WHEN 'INSERT' THEN 'add' WHEN 'DELETE' THEN 'delete' ELSE 'edit' END;
 image public.leave_approval_policy%ROWTYPE;
BEGIN
 IF TG_OP='DELETE' THEN image:=OLD;ELSE image:=NEW;END IF;
 IF app.access_workforce_storage_owner() THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 PERFORM app.access_workforce_write_lock();
 IF TG_OP='UPDATE' AND OLD.active AND NOT NEW.active THEN operation:='delete';END IF;
 IF image.tenant_id IS DISTINCT FROM app.current_tenant_id() OR TG_OP='UPDATE' AND ROW(OLD.id,OLD.tenant_id) IS DISTINCT FROM ROW(NEW.id,NEW.tenant_id)
 OR NOT app.leave_approval_company_allowed('leaveApproval.assignments',operation,image.company_id)
 OR TG_OP='UPDATE' AND NOT app.leave_approval_company_allowed('leaveApproval.assignments',operation,OLD.company_id)
 OR NOT EXISTS(SELECT 1 FROM public.company c WHERE c.id=image.company_id AND c.tenant_id=image.tenant_id)
 OR image.leave_type_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.leave_type r WHERE r.id=image.leave_type_id AND r.tenant_id=image.tenant_id)
 OR image.template_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.leave_approval_template r WHERE r.id=image.template_id AND r.tenant_id=image.tenant_id)
 OR image.grade_group_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.grade_group r WHERE r.id=image.grade_group_id AND r.tenant_id=image.tenant_id)
 OR image.grade_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.job_grade r WHERE r.id=image.grade_id AND r.tenant_id=image.tenant_id)
 OR image.business_unit_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.business_unit r WHERE r.id=image.business_unit_id AND r.tenant_id=image.tenant_id)
 OR image.department_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.department r WHERE r.id=image.department_id AND r.tenant_id=image.tenant_id)
 OR image.position_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.position r WHERE r.id=image.position_id AND r.tenant_id=image.tenant_id)
 THEN RAISE EXCEPTION 'Leave approval assignment action unavailable' USING ERRCODE='42501';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END $$;
REVOKE ALL ON FUNCTION app.leave_approval_assignment_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER module_leave_approval_assignment_lock BEFORE INSERT OR UPDATE OR DELETE ON public.leave_approval_policy FOR EACH STATEMENT EXECUTE FUNCTION app.module_configuration_write_lock();
CREATE TRIGGER module_leave_approval_assignment_action BEFORE INSERT OR UPDATE OR DELETE ON public.leave_approval_policy FOR EACH ROW EXECUTE FUNCTION app.leave_approval_assignment_guard();

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.module_function_legacy_allowed(t uuid,u uuid,cap text,co uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.leave_approval_company_native_allowed(t,u,cap,co) OR app.leave_approval_template_native_allowed(t,u,cap,co) OR app.claim_receipt_native_allowed(t,u,cap,co) OR app.claim_own_native_allowed(t,u,cap,co) OR app.claim_nonself_native_allowed(t,u,cap,co) OR app.claim_self_decision_native_allowed(t,u,cap,co)
 OR EXISTS(SELECT 1 FROM app.access_function_action a WHERE a.capability_id=cap AND a.function_key IN ('claimsConfig.types','claimsConfig.limits','claimsConfig.mileage','claimsConfig.reimbursements','claims.administration','leaveConfig.types','leaveConfig.gradeGroups','attendancePolicy.schedule') AND app.module_action_legacy_allowed(t,u,a.parent_capability,co));
$$;
CREATE OR REPLACE FUNCTION app.module_function_current_legacy_allowed(t uuid,u uuid,cap text,co uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.leave_approval_company_current_native_allowed(t,u,cap,co) OR app.leave_approval_template_current_native_allowed(t,u,cap,co) OR app.claim_receipt_current_native_allowed(t,u,cap,co) OR app.claim_own_current_native_allowed(t,u,cap,co) OR app.claim_nonself_current_native_allowed(t,u,cap,co) OR app.claim_self_decision_current_native_allowed(t,u,cap,co)
 OR EXISTS(SELECT 1 FROM app.access_function_action a WHERE a.capability_id=cap AND a.function_key IN ('claimsConfig.types','claimsConfig.limits','claimsConfig.mileage','claimsConfig.reimbursements','claims.administration','leaveConfig.types','leaveConfig.gradeGroups','attendancePolicy.schedule') AND app.module_action_current_native_default(t,u,a.parent_capability,co));
$$;


--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.claim_draft_delete_approved(p_claim uuid,p_source jsonb,p_final boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.claim_own_source_allowed((p_source->>'employment_id')::uuid,'claims.own.drafts','delete') AND EXISTS(SELECT 1 FROM app.claim_draft_delete_effect proof WHERE proof.xact_id=pg_current_xact_id() AND proof.tenant_id=app.current_tenant_id() AND proof.user_id=app.current_user_id() AND proof.claim_id=p_claim AND proof.before_source=p_source AND proof.authority_stamp=app.claim_command_authority_stamp() AND (NOT p_final OR proof.completed AND NOT EXISTS(SELECT 1 FROM public.claim_request actual WHERE actual.id=proof.claim_id) AND NOT EXISTS(SELECT 1 FROM public.claim_attachment attachment WHERE attachment.claim_request_id=proof.claim_id) AND EXISTS(SELECT 1 FROM public.domain_event event WHERE event.id=proof.event_id AND event.tenant_id=proof.tenant_id AND event.actor_type='user' AND event.actor_id=proof.user_id AND event.aggregate_type='claim-request' AND event.aggregate_id=proof.claim_id AND event.event_type='claim-request.draft-deleted' AND event.subject_employment_id=(p_source->>'employment_id')::uuid)));
$$;

--> statement-breakpoint
-- Retained completion contexts are rechecked after a real control/native-source change even if
-- the caller flushed all deferred checks early. These do not grant any ongoing source authority.
CREATE FUNCTION app.claim_receipt_effect_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.claim_receipt_effect_context_allowed(NEW.receipt_id,true) IS NOT TRUE THEN RAISE EXCEPTION 'Claim receipt effects incomplete' USING ERRCODE='42501';END IF;RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.claim_receipt_effect_complete() FROM PUBLIC,ai_hr_app;
CREATE CONSTRAINT TRIGGER claim_receipt_effect_complete AFTER INSERT OR UPDATE ON app.claim_own_receipt_effect DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.claim_receipt_effect_complete();
--> statement-breakpoint
CREATE FUNCTION app.claim_native_effect_context_allowed(p_claim uuid,p_before_hash text,p_after_hash text,p_subject uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND EXISTS(SELECT 1 FROM app.module_claim_effect proof
 JOIN public.employment e ON e.tenant_id=proof.tenant_id AND e.id=p_subject
 JOIN public.domain_event audit ON audit.tenant_id=proof.tenant_id AND audit.id=proof.event_id AND audit.aggregate_id=proof.claim_id AND audit.aggregate_type='claim-request' AND audit.actor_type='user' AND audit.actor_id=proof.user_id AND audit.subject_employment_id=e.id
 WHERE proof.xact_id=pg_current_xact_id() AND proof.tenant_id=app.current_tenant_id() AND proof.user_id=app.current_user_id() AND proof.claim_id=p_claim
 AND proof.before_hash=p_before_hash AND proof.after_hash=p_after_hash AND proof.authority_stamp=app.claim_command_authority_stamp()
 AND CASE proof.course WHEN 'own_cancel' THEN app.is_self_person(e.person_id) AND app.function_action_allowed('claims.own','delete',e.company_id) AND audit.event_type='claim-request.cancelled'
 WHEN 'admin_cancel' THEN app.can_admin_employment(e.id) AND app.module_action_allowed('claims','delete',e.company_id) AND app.function_action_allowed('claims.administration','delete',e.company_id) AND audit.event_type='claim-request.cancelled'
 WHEN 'reimbursement' THEN app.can_admin_employment(e.id) AND app.module_action_allowed('claims','edit',e.company_id) AND app.function_action_allowed('claimsConfig.reimbursements','execute',e.company_id) AND audit.event_type='claim-request.paid' AND audit.payload->>'via'='reimbursement' END);
$$;
REVOKE ALL ON FUNCTION app.claim_native_effect_context_allowed(uuid,text,text,uuid) FROM PUBLIC,ai_hr_app;
CREATE OR REPLACE FUNCTION app.claim_native_effect_approved(p_claim uuid,p_before jsonb,p_after jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.claim_native_effect_context_allowed(p_claim,encode(sha256(convert_to(p_before::text,'UTF8')),'hex'),encode(sha256(convert_to(p_after::text,'UTF8')),'hex'),(p_after->>'employment_id')::uuid);
$$;
CREATE FUNCTION app.claim_native_effect_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE subject uuid;
BEGIN
 SELECT audit.subject_employment_id INTO subject FROM public.domain_event audit WHERE audit.id=NEW.event_id AND audit.tenant_id=NEW.tenant_id;
 IF app.claim_native_effect_context_allowed(NEW.claim_id,NEW.before_hash,NEW.after_hash,subject) IS NOT TRUE THEN RAISE EXCEPTION 'Claim native effects incomplete' USING ERRCODE='42501';END IF;RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.claim_native_effect_complete() FROM PUBLIC,ai_hr_app;
CREATE CONSTRAINT TRIGGER claim_native_effect_complete AFTER INSERT OR UPDATE ON app.module_claim_effect DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.claim_native_effect_complete();
--> statement-breakpoint
CREATE FUNCTION app.claim_authority_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW.epoch IS DISTINCT FROM OLD.epoch THEN
  UPDATE app.claim_command_effect proof SET completed=proof.completed WHERE proof.xact_id=pg_current_xact_id() AND proof.tenant_id=NEW.tenant_id AND proof.born AND proof.completed;
  UPDATE app.claim_own_receipt_effect proof SET completed=proof.completed WHERE proof.xact_id=pg_current_xact_id() AND proof.tenant_id=NEW.tenant_id AND proof.born AND proof.completed;
  UPDATE app.claim_draft_delete_effect proof SET completed=proof.completed WHERE proof.xact_id=pg_current_xact_id() AND proof.tenant_id=NEW.tenant_id AND proof.completed;
  UPDATE app.module_claim_effect proof SET event_id=proof.event_id WHERE proof.xact_id=pg_current_xact_id() AND proof.tenant_id=NEW.tenant_id;
 END IF;RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.claim_authority_changed() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER claim_control_authority_recheck AFTER UPDATE ON app.access_control_epoch FOR EACH ROW EXECUTE FUNCTION app.claim_authority_changed();
CREATE TRIGGER claim_native_authority_recheck AFTER UPDATE ON app.claim_native_source_epoch FOR EACH ROW EXECUTE FUNCTION app.claim_authority_changed();

--> statement-breakpoint
-- Exact, read-only control projection. Native source writers still classify under their serializing
-- lock; this result is never a reservation or proof of a successful operation.
CREATE FUNCTION app.claim_configuration_write_access(p_kind text,p_type uuid,p_grade uuid DEFAULT NULL,p_item uuid DEFAULT NULL,p_vehicle text DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE key text;image jsonb;fact record;resource app.module_action_resource%ROWTYPE;operation text;
BEGIN
 key:=CASE p_kind WHEN 'claim_policy' THEN 'claimsConfig.limits' WHEN 'claim_mileage_rate' THEN 'claimsConfig.mileage' END;
 IF key IS NULL OR NOT app.principal_snapshot_current() OR NOT app.module_action_allowed('claims_configuration','view',NULL) OR NOT app.function_action_allowed(key,'view',NULL)
 OR NOT EXISTS(SELECT 1 FROM public.claim_type t WHERE t.id=p_type AND t.tenant_id=app.current_tenant_id() AND t.archived_at IS NULL)
 OR p_grade IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.job_grade g WHERE g.id=p_grade AND g.tenant_id=app.current_tenant_id())
 OR p_item IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.claim_item i WHERE i.id=p_item AND i.tenant_id=app.current_tenant_id() AND i.claim_type_id=p_type AND i.archived_at IS NULL)
 OR p_kind='claim_policy' AND p_vehicle IS NOT NULL OR p_kind='claim_mileage_rate' AND(p_item IS NOT NULL OR p_vehicle IS NULL OR p_vehicle NOT IN ('any','car','motorcycle','van','lorry')) THEN RETURN false;END IF;
 image:=jsonb_build_object('tenant_id',app.current_tenant_id(),'claim_type_id',p_type,'grade_id',p_grade,'claim_item_id',p_item,'vehicle_class',p_vehicle);
 SELECT * INTO fact FROM app.claim_configuration_resource_fact(p_kind,image);
 SELECT * INTO resource FROM app.module_action_resource r WHERE r.tenant_id=app.current_tenant_id() AND r.kind=p_kind AND r.resource_key=fact.resource_key;
 operation:=CASE WHEN FOUND THEN CASE WHEN resource.born_xact=pg_current_xact_id_if_assigned() AND resource.born_actor=app.current_user_id() THEN 'add' ELSE 'edit' END WHEN fact.existed THEN 'edit' ELSE 'add' END;
 RETURN app.module_action_allowed('claims_configuration',operation,NULL) AND app.function_action_allowed(key,operation,NULL);
END $$;
REVOKE ALL ON FUNCTION app.claim_configuration_write_access(text,uuid,uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_configuration_write_access(text,uuid,uuid,uuid,text) TO ai_hr_app;

--> statement-breakpoint
-- Consumed only by the native Company source guard with actual OLD/NEW images. This owns no
-- general Company mutation, employee access or runtime routing grant.
CREATE FUNCTION app.leave_approval_escalation_source_allowed(p_before jsonb,p_after jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT p_before->>'id'=p_after->>'id' AND p_before->>'tenant_id'=app.current_tenant_id()::text
 AND p_before-ARRAY['escalation_enabled','escalate_after_days','escalation_target','escalation_target_role','escalation_updated_at'] = p_after-ARRAY['escalation_enabled','escalate_after_days','escalation_target','escalation_target_role','escalation_updated_at']
 AND EXISTS(SELECT 1 FROM public.company actual WHERE actual.id=(p_before->>'id')::uuid AND actual.tenant_id=app.current_tenant_id() AND to_jsonb(actual)=p_before)
 AND app.leave_approval_company_allowed('leaveApproval.escalation','edit',(p_before->>'id')::uuid);
$$;
REVOKE ALL ON FUNCTION app.leave_approval_escalation_source_allowed(jsonb,jsonb) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
-- The native assignment bucket is shared by the actual constructor and its read-only projection.
-- This is a source lookup, never a reservation, write intent or retained positive grant.
CREATE FUNCTION app.leave_approval_assignment_bucket(p_tenant uuid,p_company uuid,p_type uuid,p_grade_group uuid,p_employment_type text,p_min_days integer,p_max_days integer) RETURNS TABLE(id uuid,template_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT p.id,p.template_id FROM public.leave_approval_policy p WHERE p.tenant_id=p_tenant AND p.company_id=p_company AND p.leave_type_id=p_type
 AND p.business_unit_id IS NULL AND p.department_id IS NULL AND p.position_id IS NULL AND p.grade_id IS NULL
 AND p.grade_group_id IS NOT DISTINCT FROM p_grade_group AND p.employment_type::text IS NOT DISTINCT FROM p_employment_type
 AND p.min_days IS NOT DISTINCT FROM p_min_days AND p.max_days IS NOT DISTINCT FROM p_max_days LIMIT 1;
$$;
REVOKE ALL ON FUNCTION app.leave_approval_assignment_bucket(uuid,uuid,uuid,uuid,text,integer,integer) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.leave_approval_assignment_slot(p_company uuid,p_type uuid,p_grade_group uuid,p_employment_type text,p_min_days integer,p_max_days integer) RETURNS TABLE(id uuid,template_id uuid,operation text,allowed boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source record;course text;
BEGIN
 IF NOT app.leave_approval_company_allowed('leaveApproval.assignments','view',p_company)
 OR NOT EXISTS(SELECT 1 FROM public.leave_type t WHERE t.id=p_type AND t.tenant_id=app.current_tenant_id())
 OR p_grade_group IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.grade_group g WHERE g.id=p_grade_group AND g.tenant_id=app.current_tenant_id())
 OR p_employment_type IS NOT NULL AND NOT(p_employment_type=ANY(enum_range(NULL::public.employment_type)::text[]))
 OR p_min_days<0 OR p_max_days<0 OR p_min_days>p_max_days THEN RETURN;END IF;
 SELECT * INTO source FROM app.leave_approval_assignment_bucket(app.current_tenant_id(),p_company,p_type,p_grade_group,p_employment_type,p_min_days,p_max_days);
 course:=CASE WHEN FOUND THEN 'edit' ELSE 'add' END;
 RETURN QUERY SELECT source.id,source.template_id,course,app.leave_approval_company_allowed('leaveApproval.assignments',course,p_company);
END $$;
REVOKE ALL ON FUNCTION app.leave_approval_assignment_slot(uuid,uuid,uuid,text,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.leave_approval_assignment_slot(uuid,uuid,uuid,text,integer,integer) TO ai_hr_app;

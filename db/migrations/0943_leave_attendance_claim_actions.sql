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
 AND (cap !~ '^leave_configuration\.(add|edit|delete)$' OR app.is_group_admin())
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
  AND a.function_key IN ('claimsConfig.types','claimsConfig.limits','claimsConfig.mileage','claimsConfig.reimbursements','claims.administration','leaveConfig.types','leaveConfig.gradeGroups','attendancePolicy.schedule','attendancePolicy.shifts')
  AND app.module_action_legacy_allowed(t,u,a.parent_capability,co));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.module_function_legacy_allowed(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.module_function_current_legacy_allowed(t uuid,u uuid,cap text,co uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app.access_function_action a WHERE a.capability_id=cap
  AND a.function_key IN ('claimsConfig.types','claimsConfig.limits','claimsConfig.mileage','claimsConfig.reimbursements','claims.administration','leaveConfig.types','leaveConfig.gradeGroups','attendancePolicy.schedule','attendancePolicy.shifts')
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
   AND a.function_key IN ('claimsConfig.types','claimsConfig.limits','claimsConfig.mileage','claimsConfig.reimbursements','claims.administration','leaveConfig.types','leaveConfig.gradeGroups','attendancePolicy.schedule','attendancePolicy.shifts')),false);
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
  IF TG_TABLE_NAME='attendance_rule_shift' AND TG_OP='INSERT' AND app.shift_initial_membership_allowed(after_row) THEN RETURN NULL;END IF;
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
 -- 0319/0545 ordinary Schedule Group is ANY-HR. Dated rotations have their own group-only owner.
 SELECT app.module_action_current_legacy_allowed(t,u,cap,co);
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
-- Restricted publisher target hooks cannot borrow its ambient tenant. Port ONLY the actual
-- 0818 delegation coverage fact, keeping its exact activity/module/task/org-scope semantics.
-- Applied source drift refuses migration instead of silently changing the native target ceiling.
DO $port$ DECLARE source text;BEGIN
 SELECT prosrc INTO source FROM pg_proc WHERE oid='app.delegation_line_covers(uuid,uuid,text,text)'::regprocedure;
 IF source IS NULL OR md5(source)<>'fb19e7bd1c4cbc1363e6de3c579c64a6' OR (length(source)-length(replace(source,'app.current_tenant_id()','')))/length('app.current_tenant_id()')<>1 THEN
  RAISE EXCEPTION 'Native delegation coverage source changed';
 END IF;
 EXECUTE 'CREATE FUNCTION app.claim_delegation_line_covers_for(p_tenant uuid,line_id uuid,subject_id uuid,wanted_module text,wanted_task text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS '||quote_literal(replace(source,'app.current_tenant_id()','p_tenant'));
END $port$;
REVOKE ALL ON FUNCTION app.claim_delegation_line_covers_for(uuid,uuid,uuid,text,text) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.claim_assigned_subject_for(t uuid,u uuid,subject uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.employment e JOIN public.app_user actor ON actor.tenant_id=e.tenant_id
 WHERE e.id=subject AND e.tenant_id=t AND actor.id=u AND actor.archived_at IS NULL AND NOT app.login_blocked(u) AND actor.person_id IS NOT NULL AND actor.person_id<>e.person_id
 AND (EXISTS(SELECT 1 FROM public.reporting_line line JOIN public.employment manager ON manager.id=line.manager_employment_id AND manager.tenant_id=line.tenant_id
  WHERE line.tenant_id=t AND line.subordinate_employment_id=e.id AND line.line_type='administrative' AND line.superseded_at IS NULL AND line.valid_from<=current_date AND (line.valid_to IS NULL OR line.valid_to>current_date) AND manager.person_id=actor.person_id)
 OR EXISTS(SELECT 1 FROM public.reporting_line adm JOIN public.reporting_line delegation ON delegation.subordinate_employment_id=adm.manager_employment_id AND delegation.tenant_id=adm.tenant_id
  JOIN public.employment delegate ON delegate.id=delegation.manager_employment_id AND delegate.tenant_id=delegation.tenant_id
  WHERE adm.tenant_id=t AND adm.subordinate_employment_id=e.id AND adm.line_type='administrative' AND adm.superseded_at IS NULL AND adm.valid_from<=current_date AND (adm.valid_to IS NULL OR adm.valid_to>current_date)
  AND delegate.person_id=actor.person_id AND app.claim_delegation_line_covers_for(t,delegation.id,e.id,'claims','claims.claim'))));
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
 OR EXISTS(SELECT 1 FROM app.access_function_action a WHERE a.capability_id=cap AND a.function_key IN ('claimsConfig.types','claimsConfig.limits','claimsConfig.mileage','claimsConfig.reimbursements','claims.administration','leaveConfig.types','leaveConfig.gradeGroups','attendancePolicy.schedule','attendancePolicy.shifts') AND app.module_action_legacy_allowed(t,u,a.parent_capability,co));
$$;
CREATE OR REPLACE FUNCTION app.module_function_current_legacy_allowed(t uuid,u uuid,cap text,co uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.claim_own_current_native_allowed(t,u,cap,co) OR app.claim_nonself_current_native_allowed(t,u,cap,co) OR app.claim_self_decision_current_native_allowed(t,u,cap,co)
 OR EXISTS(SELECT 1 FROM app.access_function_action a WHERE a.capability_id=cap AND a.function_key IN ('claimsConfig.types','claimsConfig.limits','claimsConfig.mileage','claimsConfig.reimbursements','claims.administration','leaveConfig.types','leaveConfig.gradeGroups','attendancePolicy.schedule','attendancePolicy.shifts') AND app.module_action_current_native_default(t,u,a.parent_capability,co));
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
 IF app.current_tenant_id() IS NOT NULL THEN
  PERFORM app.audit_access_order_lock_for(app.current_tenant_id());
  PERFORM app.access_workforce_write_lock();
 END IF;RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.claim_native_source_statement_lock() FROM PUBLIC,ai_hr_app;
DO $$ DECLARE relation_name text;columns text;BEGIN
 FOREACH relation_name IN ARRAY ARRAY['employment','person','assignment','reporting_line','reporting_line_scope','company','department','claim_type','claim_item','claim_policy','claim_form_field','claim_mileage_rate'] LOOP
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
-- RLS callers receive only the fixed current-principal predicate. Parameterized target/default
-- helpers stay private; they cannot be called as arbitrary-user RPCs by the application role.
CREATE FUNCTION app.claim_assigned_current(p_subject uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND app.claim_assigned_subject_for(app.current_tenant_id(),app.current_user_id(),p_subject) AND app.claim_decision_allowed(p_subject);
$$;
REVOKE ALL ON FUNCTION app.claim_assigned_current(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_assigned_current(uuid) TO ai_hr_app;
CREATE POLICY claim_assigned_command ON public.claim_request FOR UPDATE TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND status::text='pending' AND app.claim_assigned_current(employment_id))
 WITH CHECK(tenant_id=app.current_tenant_id() AND status::text IN ('approved','rejected') AND app.claim_assigned_current(employment_id));
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
 OR (CASE WHEN own THEN NOT app.claim_own_source_allowed(parent.employment_id,'claims.own.receipts','view') ELSE NOT app.claim_maintenance_receipt_allowed(parent.employment_id,'view') END)
 THEN RAISE EXCEPTION '%',CASE WHEN own THEN 'Own claim receipt unavailable' ELSE 'Claim receipt unavailable' END USING ERRCODE='42501';END IF;
 authority:=app.claim_command_authority_stamp();
 IF p_course='receipt-add' THEN
  IF (CASE WHEN own THEN NOT app.claim_own_source_allowed(parent.employment_id,'claims.own.receipts','add') ELSE NOT app.claim_maintenance_receipt_allowed(parent.employment_id,'add') END) THEN RAISE EXCEPTION '%',CASE WHEN own THEN 'Own claim receipt Add unavailable' ELSE 'Claim receipt Add unavailable' END USING ERRCODE='42501';END IF;
 ELSE
  operation:=CASE p_course WHEN 'draft-add' THEN 'add' WHEN 'draft-edit' THEN 'edit' ELSE 'execute' END;
  IF (CASE WHEN own THEN NOT app.claim_own_source_allowed(parent.employment_id,CASE WHEN p_course='submit' THEN 'claims.own.submit' ELSE 'claims.own.drafts' END,operation) ELSE p_course<>'submit' OR NOT app.claim_nonself_submit_allowed(parent.employment_id) END) THEN RAISE EXCEPTION '%',CASE WHEN own THEN 'Own receipt source action unavailable' ELSE 'Claim receipt source action unavailable' END USING ERRCODE='42501';END IF;
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
-- Dated rotations retain their original group-only write ceiling, separately from ordinary
-- ANY-HR Schedule/Shift maintenance. Parent function caps are accepted only for registry floor calls.
CREATE FUNCTION app.attendance_rotation_native_allowed(t uuid,u uuid,cap text,co uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT co IS NULL AND cap IN ('function.attendancePolicy.rotations.view','function.attendancePolicy.rotations.edit','function.attendancePolicy.schedule.view','function.attendancePolicy.schedule.edit')
 AND app.module_action_legacy_allowed(t,u,'attendance_configuration.view',NULL)
 AND(split_part(cap,'.',4)='view' OR EXISTS(SELECT 1 FROM public.role_assignment r WHERE r.tenant_id=t AND r.app_user_id=u AND(r.role::text='super_admin' OR r.role::text='hr_admin' AND r.company_id IS NULL)));
$$;
CREATE FUNCTION app.attendance_rotation_current_native_allowed(t uuid,u uuid,cap text,co uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT t=app.current_tenant_id() AND u=app.current_user_id() AND app.principal_snapshot_current() AND app.attendance_rotation_native_allowed(t,u,cap,co)
 AND(split_part(cap,'.',4)='view' OR app.is_group_admin());
$$;
REVOKE ALL ON FUNCTION app.attendance_rotation_native_allowed(uuid,uuid,text,uuid),app.attendance_rotation_current_native_allowed(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
DO $$ DECLARE operation text;BEGIN
 FOREACH operation IN ARRAY ARRAY['view','edit'] LOOP
  PERFORM app.register_function_action('attendancePolicy.rotations',operation,'tenant','function.attendancePolicy.schedule.'||operation,'app.attendance_rotation_current_native_allowed','{"moduleKey":"attendance","labelKey":"admin.rotation.title","kind":"native_acl","course":"administrative","screenKey":"attendancePolicy","href":"/admin/attendance/schedule","employeeBearing":false}');
 END LOOP;
END $$;
CREATE FUNCTION app.attendance_rotation_allowed(p_operation text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.attendance_rotation_current_native_allowed(app.current_tenant_id(),app.current_user_id(),'function.attendancePolicy.rotations.'||p_operation,NULL)
 AND app.module_function_allowed('attendancePolicy.schedule','view',NULL) AND app.module_function_allowed('attendancePolicy.schedule',p_operation,NULL)
 AND app.function_action_allowed('attendancePolicy.rotations','view',NULL) AND app.function_action_allowed('attendancePolicy.rotations',p_operation,NULL);
$$;
REVOKE ALL ON FUNCTION app.attendance_rotation_allowed(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.attendance_rotation_allowed(text) TO ai_hr_app;
CREATE FUNCTION app.attendance_rotation_action_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.access_workforce_storage_owner() THEN RETURN NEW;END IF;
 PERFORM app.access_workforce_write_lock();
 IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NOT app.is_group_admin() OR NOT EXISTS(SELECT 1 FROM public.attendance_rule parent WHERE parent.id=NEW.rule_id AND parent.tenant_id=NEW.tenant_id AND NOT parent.is_default)
 THEN RAISE EXCEPTION 'Schedule rotation action unavailable' USING ERRCODE='42501';END IF;
 -- A real new Schedule copy can initialize its dated versions under Group Add, with its original
 -- stronger rotation-role floor. Existing groups always consume exact Rotation Edit.
 IF EXISTS(SELECT 1 FROM app.module_attendance_rule_birth born WHERE born.xact_id=pg_current_xact_id() AND born.tenant_id=NEW.tenant_id AND born.user_id=app.current_user_id() AND born.rule_id=NEW.rule_id)
 AND app.module_function_allowed('attendancePolicy.schedule','add',NULL) THEN RETURN NEW;END IF;
 IF NOT app.attendance_rotation_allowed('edit') THEN RAISE EXCEPTION 'Schedule rotation action unavailable' USING ERRCODE='42501';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.attendance_rotation_action_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER module_rotation_access BEFORE INSERT ON public.attendance_rotation FOR EACH STATEMENT EXECUTE FUNCTION app.module_configuration_write_lock();
CREATE TRIGGER aaa_module_rotation_action BEFORE INSERT ON public.attendance_rotation FOR EACH ROW EXECUTE FUNCTION app.attendance_rotation_action_guard();

--> statement-breakpoint
-- Duty roster and exception switches are distinct native ANY-HR Group maintenance purposes.
CREATE FUNCTION app.attendance_schedule_control_native_allowed(t uuid,u uuid,cap text,co uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT cap IN ('function.attendancePolicy.dutyRoster.view','function.attendancePolicy.dutyRoster.edit','function.attendancePolicy.exceptions.view','function.attendancePolicy.exceptions.edit','function.attendancePolicy.schedule.view','function.attendancePolicy.schedule.edit')
 AND app.module_action_legacy_allowed(t,u,'attendance_configuration.'||split_part(cap,'.',4),co);
$$;
CREATE FUNCTION app.attendance_schedule_control_current_native_allowed(t uuid,u uuid,cap text,co uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT t=app.current_tenant_id() AND u=app.current_user_id() AND app.principal_snapshot_current() AND app.attendance_schedule_control_native_allowed(t,u,cap,co)
 AND app.module_action_current_legacy_allowed(t,u,'attendance_configuration.'||split_part(cap,'.',4),co);
$$;
REVOKE ALL ON FUNCTION app.attendance_schedule_control_native_allowed(uuid,uuid,text,uuid),app.attendance_schedule_control_current_native_allowed(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
DO $$ DECLARE key text;operation text;BEGIN
 FOREACH key IN ARRAY ARRAY['dutyRoster','exceptions'] LOOP
  FOREACH operation IN ARRAY ARRAY['view','edit'] LOOP
   PERFORM app.register_function_action('attendancePolicy.'||key,operation,'tenant','function.attendancePolicy.schedule.'||operation,'app.attendance_schedule_control_current_native_allowed',jsonb_build_object('moduleKey','attendance','labelKey',CASE key WHEN 'dutyRoster' THEN 'boardSchedule.duty' ELSE 'boardSchedule.exception' END,'kind','native_acl','course','administrative','screenKey','attendancePolicy','href','/admin/attendance/schedule','employeeBearing',false));
  END LOOP;
 END LOOP;
END $$;
CREATE FUNCTION app.attendance_schedule_control_allowed(p_key text,p_operation text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT p_key IN ('attendancePolicy.dutyRoster','attendancePolicy.exceptions') AND p_operation IN ('view','edit')
 AND app.attendance_schedule_control_current_native_allowed(app.current_tenant_id(),app.current_user_id(),'function.'||p_key||'.'||p_operation,NULL)
 AND app.module_function_allowed('attendancePolicy.schedule','view',NULL) AND app.module_function_allowed('attendancePolicy.schedule',p_operation,NULL)
 AND app.function_action_allowed(p_key,'view',NULL) AND app.function_action_allowed(p_key,p_operation,NULL);
$$;
REVOKE ALL ON FUNCTION app.attendance_schedule_control_allowed(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.attendance_schedule_control_allowed(text,text) TO ai_hr_app;
CREATE FUNCTION app.attendance_schedule_control_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE key text:=CASE TG_TABLE_NAME WHEN 'attendance_rule' THEN 'attendancePolicy.dutyRoster' ELSE 'attendancePolicy.exceptions' END;
BEGIN
 IF app.access_workforce_storage_owner() THEN RETURN NEW;END IF;
 IF TG_TABLE_NAME='attendance_rule' THEN
  IF TG_OP='INSERT' THEN IF NOT NEW.duty_roster_control THEN RETURN NEW;END IF;
  ELSIF OLD.duty_roster_control IS NOT DISTINCT FROM NEW.duty_roster_control THEN RETURN NEW;END IF;
 END IF;
 PERFORM app.access_workforce_write_lock();
 IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NOT app.attendance_schedule_control_allowed(key,'edit') THEN RAISE EXCEPTION 'Schedule control action unavailable' USING ERRCODE='42501';END IF;
 IF TG_TABLE_NAME='attendance_exception_revision' THEN
  IF NOT EXISTS(SELECT 1 FROM public.attendance_rule parent WHERE parent.id=NEW.rule_id AND parent.tenant_id=NEW.tenant_id) THEN RAISE EXCEPTION 'Schedule control subject unavailable' USING ERRCODE='42501';END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.attendance_schedule_control_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER aaa_schedule_duty_action BEFORE INSERT OR UPDATE ON public.attendance_rule FOR EACH ROW EXECUTE FUNCTION app.attendance_schedule_control_guard();
CREATE TRIGGER aaa_schedule_exception_action BEFORE INSERT ON public.attendance_exception_revision FOR EACH ROW EXECUTE FUNCTION app.attendance_schedule_control_guard();
CREATE TRIGGER module_schedule_exception_access BEFORE INSERT ON public.attendance_exception_revision FOR EACH STATEMENT EXECUTE FUNCTION app.module_configuration_write_lock();

--> statement-breakpoint
-- Shared PRIVATE native key fact for actual/proposed role overrides. This is not an
-- admission port: code-owned source guards supply real OLD/NEW, stored/claimed roles and key.
-- All current consumers share the actual original HR/super defaults; unknown keys fail closed.
CREATE FUNCTION app.native_permission_override_fact(p_tenant uuid,p_permission text,p_company uuid,p_roles text[],p_before jsonb DEFAULT NULL,p_after jsonb DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH projected AS(
  SELECT g.role,g.allowed,g.company_id FROM public.payroll_permission_grant g WHERE g.tenant_id=p_tenant AND g.permission_key=p_permission AND (p_before IS NULL OR g.id IS DISTINCT FROM (p_before->>'id')::uuid)
  UNION ALL SELECT p_after->>'role',(p_after->>'allowed')::boolean,(p_after->>'company_id')::uuid WHERE p_after IS NOT NULL AND (p_after->>'tenant_id')::uuid=p_tenant AND p_after->>'permission_key'=p_permission
 ),applicable AS(SELECT * FROM projected WHERE company_id IS NULL OR company_id=p_company),
 effective AS(SELECT role,allowed FROM applicable WHERE CASE WHEN EXISTS(SELECT 1 FROM applicable WHERE company_id IS NOT NULL) THEN company_id IS NOT NULL ELSE company_id IS NULL END)
 SELECT coalesce(p_permission IN ('leave.apply_on_behalf','report.read.personnel','report.read.compensation','report.read.identity','report.read.bank','report.read.statutory','report.read.confidential_hr')
 AND EXISTS(SELECT 1 FROM public.tenant tenant WHERE tenant.id=p_tenant) AND (p_company IS NULL OR EXISTS(SELECT 1 FROM public.company company WHERE company.id=p_company AND company.tenant_id=p_tenant))
 AND CASE WHEN NOT EXISTS(SELECT 1 FROM effective) THEN coalesce(p_roles&&ARRAY['hr_admin','super_admin'],false)
 ELSE EXISTS(SELECT 1 FROM effective allowed_role WHERE allowed_role.allowed AND allowed_role.role=ANY(p_roles) AND NOT EXISTS(SELECT 1 FROM effective denied_role WHERE denied_role.role=allowed_role.role AND NOT denied_role.allowed)) END,false);
$$;
REVOKE ALL ON FUNCTION app.native_permission_override_fact(uuid,text,uuid,text[],jsonb,jsonb) FROM PUBLIC,ai_hr_app;
-- Enumerate the complete affected native key scopes: a company mutation affects that company;
-- a tenant mutation affects every current company plus the genuine future/global NULL scope.
CREATE FUNCTION app.native_permission_override_scopes(p_tenant uuid,p_before jsonb,p_after jsonb) RETURNS TABLE(company_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH images AS(SELECT image FROM (VALUES(p_before),(p_after)) source_images(image) WHERE image IS NOT NULL),global_change AS(SELECT 1 FROM images WHERE image->>'company_id' IS NULL)
 SELECT NULL::uuid WHERE EXISTS(SELECT 1 FROM global_change)
 UNION SELECT company.id FROM public.company company WHERE company.tenant_id=p_tenant AND EXISTS(SELECT 1 FROM global_change)
 UNION SELECT (image->>'company_id')::uuid FROM images WHERE image->>'company_id' IS NOT NULL;
$$;
CREATE FUNCTION app.native_permission_override_recipients(p_tenant uuid,p_permission text,p_before jsonb,p_after jsonb) RETURNS TABLE(user_id uuid,company_id uuid,before_allowed boolean,after_allowed boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT account.id,scope.company_id,app.native_permission_override_fact(p_tenant,p_permission,scope.company_id,roles.held,NULL,NULL),app.native_permission_override_fact(p_tenant,p_permission,scope.company_id,roles.held,p_before,p_after)
 FROM public.app_user account CROSS JOIN app.native_permission_override_scopes(p_tenant,p_before,p_after) scope
 CROSS JOIN LATERAL(SELECT ARRAY(SELECT assignment.role::text FROM public.role_assignment assignment WHERE assignment.tenant_id=p_tenant AND assignment.app_user_id=account.id AND (p_permission='leave.apply_on_behalf' OR app.access_scope_covers(assignment.company_id,scope.company_id,p_tenant))) AS held) roles
 WHERE account.tenant_id=p_tenant AND account.archived_at IS NULL AND NOT app.login_blocked(account.id);
$$;
-- Singleton role transitions additionally cover unknown future recipients. Any OR-role gain is
-- witnessed by at least one singleton, including gains caused by switching whole override sets.
CREATE FUNCTION app.native_permission_override_role_changes(p_tenant uuid,p_permission text,p_before jsonb,p_after jsonb) RETURNS TABLE(role text,company_id uuid,before_allowed boolean,after_allowed boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT candidate_role.name,scope.company_id,app.native_permission_override_fact(p_tenant,p_permission,scope.company_id,ARRAY[candidate_role.name],NULL,NULL),app.native_permission_override_fact(p_tenant,p_permission,scope.company_id,ARRAY[candidate_role.name],p_before,p_after)
 FROM unnest(enum_range(NULL::public.role)) actual_role CROSS JOIN LATERAL(SELECT actual_role::text AS name) candidate_role CROSS JOIN app.native_permission_override_scopes(p_tenant,p_before,p_after) scope;
$$;
REVOKE ALL ON FUNCTION app.native_permission_override_scopes(uuid,jsonb,jsonb),app.native_permission_override_recipients(uuid,text,jsonb,jsonb),app.native_permission_override_role_changes(uuid,text,jsonb,jsonb) FROM PUBLIC,ai_hr_app;

-- Proposed recipients can become administrative even when no supported/default/current witness
-- existed before this ACL change. Force only that classification in the canonical subset owner.
DO $ceiling$ DECLARE source text;BEGIN
 SELECT prosrc INTO source FROM pg_proc WHERE oid='app.data_permission_function_target_ceiling(uuid)'::regprocedure;
 IF source IS NULL OR md5(source)<>'bb618986295af27b0152dbe5d9ed4fa8' OR (length(source)-length(replace(source,'administrative:=EXISTS(','')))/length('administrative:=EXISTS(')<>1 THEN RAISE EXCEPTION 'Native recipient profile ceiling source changed';END IF;
 EXECUTE 'CREATE FUNCTION app.native_permission_recipient_data_ceiling(p_user uuid) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS '||quote_literal(replace(source,'administrative:=EXISTS(','administrative:=true OR EXISTS('));
END $ceiling$;
REVOKE ALL ON FUNCTION app.native_permission_recipient_data_ceiling(uuid) FROM PUBLIC,ai_hr_app;
-- The existing letter ACL's future-company profile fact contains no Letter permission or role
-- test. Reuse that exact shared data ceiling, without borrowing any Letter execution authority.
CREATE FUNCTION app.native_permission_future_company_ceiling(p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.financial_letter_native_acl_company_ceiling(p_company);
$$;
REVOKE ALL ON FUNCTION app.native_permission_future_company_ceiling(uuid) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
-- One owner for the existing leave.apply_on_behalf role-override algebra. Company rows
-- replace the entire tenant override set; role denial wins only against the same role.
-- This fact adds no subject read, company/data ceiling, admission or ledger authority.
CREATE FUNCTION app.leave_on_behalf_permission(p_tenant uuid,p_company uuid,p_roles text[]) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.native_permission_override_fact(p_tenant,'leave.apply_on_behalf',p_company,p_roles,NULL,NULL);
$$;
REVOKE ALL ON FUNCTION app.leave_on_behalf_permission(uuid,uuid,text[]) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.leave_on_behalf_native(p_company uuid DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND (p_company IS NULL OR EXISTS(SELECT 1 FROM public.company c WHERE c.id=p_company AND c.tenant_id=app.current_tenant_id()))
 AND app.leave_on_behalf_permission(app.current_tenant_id(),p_company,ARRAY(SELECT DISTINCT role FROM(SELECT unnest(string_to_array(current_setting('app.roles',true),',')) role UNION SELECT g.role FROM app.current_grants() g) claimed));
$$;
REVOKE ALL ON FUNCTION app.leave_on_behalf_native(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.leave_on_behalf_native(uuid) TO ai_hr_app;

--> statement-breakpoint
-- Applying for another person retains the named native permission AND actual nonself
-- employment visibility/data source. No HR-only replacement of customer-granted manager courses.
CREATE FUNCTION app.leave_on_behalf_application_native_allowed(t uuid,u uuid,cap text,co uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE roles text[];company_id uuid;
BEGIN
 IF cap IS NULL OR cap NOT IN ('function.leave.onBehalf.application.view','function.leave.onBehalf.application.add') OR NOT EXISTS(SELECT 1 FROM public.app_user actor WHERE actor.id=u AND actor.tenant_id=t AND actor.archived_at IS NULL AND NOT app.login_blocked(u)) THEN RETURN false;END IF;
 SELECT array_agg(DISTINCT role::text) INTO roles FROM public.role_assignment WHERE tenant_id=t AND app_user_id=u;
 IF NOT app.leave_on_behalf_permission(t,co,roles) THEN RETURN false;END IF;
 IF co IS NULL THEN
  -- Global/future means a real native global company ceiling plus its future tenant permission.
  IF NOT EXISTS(SELECT 1 FROM public.role_assignment assignment WHERE assignment.tenant_id=t AND assignment.app_user_id=u AND assignment.company_id IS NULL AND assignment.role::text IN ('hr_admin','super_admin')) THEN RETURN false;END IF;
  FOR company_id IN SELECT company.id FROM public.company company WHERE company.tenant_id=t LOOP
   IF NOT app.leave_on_behalf_permission(t,company_id,roles) THEN RETURN false;END IF;
  END LOOP;RETURN true;
 END IF;
 RETURN EXISTS(SELECT 1 FROM public.employment subject JOIN public.app_user actor ON actor.tenant_id=subject.tenant_id AND actor.id=u WHERE subject.tenant_id=t AND subject.company_id=co AND actor.person_id IS DISTINCT FROM subject.person_id AND (app.claim_admin_subject_for(t,u,subject.id) OR app.claim_related_subject_for(t,u,subject.id)));
END $$;
CREATE FUNCTION app.leave_on_behalf_application_current_native_allowed(t uuid,u uuid,cap text,co uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT t=app.current_tenant_id() AND u=app.current_user_id() AND app.principal_snapshot_current() AND app.leave_on_behalf_application_native_allowed(t,u,cap,co) AND app.leave_on_behalf_native(co)
 AND CASE WHEN co IS NULL THEN EXISTS(SELECT 1 FROM app.current_grants() claimed WHERE claimed.company_id IS NULL AND claimed.role IN ('hr_admin','super_admin')) ELSE EXISTS(SELECT 1 FROM public.employment subject WHERE subject.tenant_id=t AND subject.company_id=co AND NOT app.is_self_person(subject.person_id) AND app.can_see_employment(subject.id)) END;
$$;
REVOKE ALL ON FUNCTION app.leave_on_behalf_application_native_allowed(uuid,uuid,text,uuid),app.leave_on_behalf_application_current_native_allowed(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
DO $$ DECLARE operation text;BEGIN
 FOREACH operation IN ARRAY ARRAY['view','add'] LOOP
  PERFORM app.register_function_action('leave.onBehalf.application',operation,'company',NULL,'app.leave_on_behalf_application_current_native_allowed','{"moduleKey":"leave","labelKey":"leave.accessFunctions.onBehalfApplication","kind":"native_acl","course":"administrative","screenKey":"leave","href":"/leave","employeeBearing":true}');
 END LOOP;
END $$;
CREATE FUNCTION app.leave_on_behalf_application_allowed(p_employment uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND EXISTS(SELECT 1 FROM public.employment subject WHERE subject.id=p_employment AND subject.tenant_id=app.current_tenant_id() AND NOT app.is_self_person(subject.person_id) AND app.can_see_employment(subject.id) AND app.leave_on_behalf_native(subject.company_id) AND app.function_action_allowed('leave.onBehalf.application','view',subject.company_id) AND app.function_action_allowed('leave.onBehalf.application','add',subject.company_id));
$$;
REVOKE ALL ON FUNCTION app.leave_on_behalf_application_allowed(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.leave_on_behalf_application_allowed(uuid) TO ai_hr_app;

--> statement-breakpoint
-- Actual own Leave application course stays independent of administrative employee scope.
CREATE FUNCTION app.leave_own_application_native_allowed(t uuid,u uuid,cap text,co uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT cap IN ('function.leave.own.application.view','function.leave.own.application.add','function.leave.own.application.edit','function.leave.own.application.delete') AND co IS NOT NULL
 AND EXISTS(SELECT 1 FROM public.app_user actor JOIN public.employment subject ON subject.tenant_id=actor.tenant_id AND subject.person_id=actor.person_id WHERE actor.id=u AND actor.tenant_id=t AND actor.archived_at IS NULL AND NOT app.login_blocked(actor.id) AND subject.company_id=co AND subject.voided_at IS NULL);
$$;
CREATE FUNCTION app.leave_own_application_current_native_allowed(t uuid,u uuid,cap text,co uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT t=app.current_tenant_id() AND u=app.current_user_id() AND app.principal_snapshot_current() AND app.leave_own_application_native_allowed(t,u,cap,co);
$$;
REVOKE ALL ON FUNCTION app.leave_own_application_native_allowed(uuid,uuid,text,uuid),app.leave_own_application_current_native_allowed(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
DO $$ DECLARE operation text;BEGIN
 FOREACH operation IN ARRAY ARRAY['view','add','edit','delete'] LOOP
  PERFORM app.register_function_action('leave.own.application',operation,'company',NULL,'app.leave_own_application_current_native_allowed','{"moduleKey":"leave","labelKey":"leave.accessFunctions.ownApplication","kind":"native_acl","course":"own","screenKey":"leave","href":"/leave","employeeBearing":false}');
 END LOOP;
END $$;
CREATE FUNCTION app.leave_own_application_allowed(p_employment uuid,p_operation text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND p_operation IN ('view','add','edit','delete') AND EXISTS(SELECT 1 FROM public.employment subject WHERE subject.id=p_employment AND subject.tenant_id=app.current_tenant_id() AND subject.voided_at IS NULL AND app.is_self_person(subject.person_id) AND app.function_action_allowed('leave.own.application','view',subject.company_id) AND app.function_action_allowed('leave.own.application',p_operation,subject.company_id));
$$;
REVOKE ALL ON FUNCTION app.leave_own_application_allowed(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.leave_own_application_allowed(uuid,text) TO ai_hr_app;
-- Pending INSERT is an application course. Approved/cancelled native split/import constructors
-- are separate owners and must not inherit this permission or its completion claim.
CREATE FUNCTION app.leave_pending_application_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE own_subject boolean;
BEGIN
 IF app.access_workforce_storage_owner() OR NEW.status::text<>'pending' THEN RETURN NEW;END IF;
 PERFORM app.access_workforce_write_lock();
 IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() THEN RAISE EXCEPTION 'Leave application subject unavailable' USING ERRCODE='42501';END IF;
 SELECT app.is_self_person(subject.person_id) INTO own_subject FROM public.employment subject WHERE subject.id=NEW.employment_id AND subject.tenant_id=NEW.tenant_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Leave application subject unavailable' USING ERRCODE='42501';END IF;
 IF own_subject THEN
  IF app.leave_own_application_allowed(NEW.employment_id,'add') IS NOT TRUE THEN RAISE EXCEPTION 'Own Leave application action unavailable' USING ERRCODE='42501';END IF;
 ELSIF app.leave_on_behalf_application_allowed(NEW.employment_id) IS NOT TRUE THEN RAISE EXCEPTION 'On-behalf Leave application unavailable' USING ERRCODE='42501';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.leave_pending_application_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER module_leave_pending_application BEFORE INSERT ON public.leave_request FOR EACH ROW EXECUTE FUNCTION app.leave_pending_application_guard();


--> statement-breakpoint
-- Shared Clocking Sites retain the original group-admin write ceiling and ANY-HR maintenance
-- View; scoped maintenance rows remain bounded by the native open-company reader.
CREATE FUNCTION app.clocking_site_native_allowed(t uuid,u uuid,cap text,co uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT co IS NULL AND cap IN ('function.attendancePolicy.clockingSites.view','function.attendancePolicy.clockingSites.add','function.attendancePolicy.clockingSites.edit','function.attendancePolicy.clockingSites.delete','attendance_configuration.view','attendance_configuration.add','attendance_configuration.edit','attendance_configuration.delete')
 AND app.module_action_legacy_allowed(t,u,'attendance_configuration.'||regexp_replace(cap,'^.*[.]',''),NULL)
 AND(regexp_replace(cap,'^.*[.]','')='view' OR EXISTS(SELECT 1 FROM public.role_assignment r WHERE r.tenant_id=t AND r.app_user_id=u AND(r.role::text='super_admin' OR r.role::text='hr_admin' AND r.company_id IS NULL)));
$$;
CREATE FUNCTION app.clocking_site_current_native_allowed(t uuid,u uuid,cap text,co uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT t=app.current_tenant_id() AND u=app.current_user_id() AND app.principal_snapshot_current() AND app.clocking_site_native_allowed(t,u,cap,co)
 AND app.module_action_current_legacy_allowed(t,u,'attendance_configuration.'||regexp_replace(cap,'^.*[.]',''),NULL)
 AND(regexp_replace(cap,'^.*[.]','')='view' OR app.is_group_admin());
$$;
REVOKE ALL ON FUNCTION app.clocking_site_native_allowed(uuid,uuid,text,uuid),app.clocking_site_current_native_allowed(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
DO $$ DECLARE operation text;BEGIN
 FOREACH operation IN ARRAY ARRAY['view','add','edit','delete'] LOOP
  PERFORM app.register_function_action('attendancePolicy.clockingSites',operation,'tenant','attendance_configuration.'||operation,'app.clocking_site_current_native_allowed','{"moduleKey":"attendance","labelKey":"nav.locations","kind":"submenu","course":"administrative","screenKey":"locations","href":"/admin/work-locations/clocking","employeeBearing":false}');
 END LOOP;
END $$;
CREATE FUNCTION app.clocking_site_allowed(p_operation text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.clocking_site_current_native_allowed(app.current_tenant_id(),app.current_user_id(),'function.attendancePolicy.clockingSites.'||p_operation,NULL)
 AND app.module_action_allowed('attendance_configuration','view',NULL) AND app.module_action_allowed('attendance_configuration',p_operation,NULL)
 AND app.function_action_allowed('attendancePolicy.clockingSites','view',NULL) AND app.function_action_allowed('attendancePolicy.clockingSites',p_operation,NULL);
$$;
REVOKE ALL ON FUNCTION app.clocking_site_allowed(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.clocking_site_allowed(text) TO ai_hr_app;
CREATE TABLE app.clocking_site_source(xact_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,site_id uuid NOT NULL,kind text NOT NULL CHECK(kind IN('birth','removed')),source jsonb NOT NULL,authority_stamp text NOT NULL,PRIMARY KEY(xact_id,tenant_id,user_id,site_id,kind));
REVOKE ALL ON app.clocking_site_source FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.clocking_site_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE operation text:=CASE TG_OP WHEN 'INSERT' THEN 'add' WHEN 'DELETE' THEN 'delete' ELSE 'edit' END;image public.clocking_location%ROWTYPE;
BEGIN
 IF app.access_workforce_storage_owner() THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 PERFORM app.access_workforce_write_lock();
 IF TG_OP='DELETE' THEN image:=OLD;ELSE image:=NEW;END IF;
 IF TG_OP='UPDATE' AND OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL THEN
  operation:='delete';
  IF to_jsonb(OLD)-ARRAY['archived_at','updated_at'] IS DISTINCT FROM to_jsonb(NEW)-ARRAY['archived_at','updated_at'] AND NOT app.clocking_site_allowed('edit') THEN RAISE EXCEPTION 'Clocking site Edit unavailable' USING ERRCODE='42501';END IF;
 END IF;
 IF image.tenant_id IS DISTINCT FROM app.current_tenant_id() OR TG_OP='UPDATE' AND ROW(OLD.id,OLD.tenant_id) IS DISTINCT FROM ROW(NEW.id,NEW.tenant_id) OR NOT app.clocking_site_allowed(operation)
 OR image.location_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.location linked WHERE linked.id=image.location_id AND linked.tenant_id=image.tenant_id)
 THEN RAISE EXCEPTION 'Clocking site action unavailable' USING ERRCODE='42501';END IF;
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM public.employee_clocking_location assignment WHERE assignment.tenant_id=OLD.tenant_id AND assignment.clocking_location_id=OLD.id) OR EXISTS(SELECT 1 FROM public.attendance punch WHERE punch.tenant_id=OLD.tenant_id AND (punch.check_in_clocking_location_id=OLD.id OR punch.check_out_clocking_location_id=OLD.id)) THEN RAISE EXCEPTION 'Clocking site is in use' USING ERRCODE='42501';END IF;
  DELETE FROM app.clocking_site_source WHERE xact_id<pg_snapshot_xmin(pg_current_snapshot());
  INSERT INTO app.clocking_site_source VALUES(pg_current_xact_id(),OLD.tenant_id,app.current_user_id(),OLD.id,'removed',to_jsonb(OLD),app.access_function_authority_stamp());RETURN OLD;
 END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.clocking_site_guard() FROM PUBLIC,ai_hr_app;
-- Every actual shared-site parent write has the same original group-admin floor, even if
-- UPDATE RLS would otherwise clip all rows before the exact row-purpose guard can run.
CREATE FUNCTION app.clocking_site_write_admission() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.access_workforce_storage_owner() THEN RETURN NULL;END IF;
 PERFORM app.audit_access_order_lock_for(app.current_tenant_id());
 IF app.principal_snapshot_current() IS NOT TRUE OR app.is_group_admin() IS NOT TRUE THEN RAISE EXCEPTION 'Clocking site native write unavailable' USING ERRCODE='42501';END IF;
 PERFORM app.access_workforce_write_lock();RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.clocking_site_write_admission() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER module_clocking_site_access BEFORE INSERT OR UPDATE OR DELETE ON public.clocking_location FOR EACH STATEMENT EXECUTE FUNCTION app.clocking_site_write_admission();
CREATE TRIGGER module_clocking_site_action BEFORE INSERT OR UPDATE OR DELETE ON public.clocking_location FOR EACH ROW EXECUTE FUNCTION app.clocking_site_guard();
CREATE FUNCTION app.clocking_site_born() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT app.access_workforce_storage_owner() THEN
  DELETE FROM app.clocking_site_source WHERE xact_id<pg_snapshot_xmin(pg_current_snapshot());
  INSERT INTO app.clocking_site_source VALUES(pg_current_xact_id(),NEW.tenant_id,app.current_user_id(),NEW.id,'birth',to_jsonb(NEW),app.access_function_authority_stamp());
 END IF;RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.clocking_site_born() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER module_clocking_site_born AFTER INSERT ON public.clocking_location FOR EACH ROW EXECUTE FUNCTION app.clocking_site_born();
CREATE FUNCTION app.clocking_site_company_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE image public.clocking_location_company%ROWTYPE;parent public.clocking_location%ROWTYPE;operation text:='edit';
BEGIN
 IF app.access_workforce_storage_owner() THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 PERFORM app.access_workforce_write_lock();
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'Clocking site company links are immutable' USING ERRCODE='42501';END IF;
 IF TG_OP='DELETE' THEN image:=OLD;ELSE image:=NEW;END IF;
 IF TG_OP='DELETE' AND app.module_company_cleanup_row_allowed('clocking_location_company',to_jsonb(OLD),true) THEN RETURN OLD;END IF;
 IF image.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NOT EXISTS(SELECT 1 FROM public.company c WHERE c.id=image.company_id AND c.tenant_id=image.tenant_id) THEN RAISE EXCEPTION 'Clocking site company unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO parent FROM public.clocking_location site WHERE site.id=image.clocking_location_id AND site.tenant_id=image.tenant_id;
 IF TG_OP='DELETE' AND parent.id IS NULL AND EXISTS(SELECT 1 FROM app.clocking_site_source proof WHERE proof.xact_id=pg_current_xact_id() AND proof.tenant_id=image.tenant_id AND proof.user_id=app.current_user_id() AND proof.site_id=image.clocking_location_id AND proof.kind='removed' AND proof.authority_stamp=app.access_function_authority_stamp()) THEN operation:='delete';
 ELSIF parent.id IS NULL THEN RAISE EXCEPTION 'Clocking site parent unavailable' USING ERRCODE='42501';
 ELSIF TG_OP='INSERT' AND EXISTS(SELECT 1 FROM app.clocking_site_source proof WHERE proof.xact_id=pg_current_xact_id() AND proof.tenant_id=image.tenant_id AND proof.user_id=app.current_user_id() AND proof.site_id=parent.id AND proof.kind='birth' AND proof.source=to_jsonb(parent) AND proof.authority_stamp=app.access_function_authority_stamp()) THEN operation:='add';END IF;
 IF NOT app.clocking_site_allowed(operation) THEN RAISE EXCEPTION 'Clocking site company action unavailable' USING ERRCODE='42501';END IF;
 -- The administrative data profile may hide employees from the caller's native UI count.
 -- This source-only refusal never returns a hidden row/count and cannot authorize any employee write.
 IF TG_OP='DELETE' AND parent.id IS NOT NULL AND EXISTS(SELECT 1 FROM public.employee_clocking_location assignment JOIN public.employment employment ON employment.id=assignment.employment_id AND employment.tenant_id=assignment.tenant_id WHERE assignment.tenant_id=image.tenant_id AND assignment.clocking_location_id=image.clocking_location_id AND employment.company_id=image.company_id) THEN RAISE EXCEPTION 'Clocking site company is in use' USING ERRCODE='42501';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END $$;
REVOKE ALL ON FUNCTION app.clocking_site_company_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER module_clocking_site_company_access BEFORE INSERT OR UPDATE OR DELETE ON public.clocking_location_company FOR EACH STATEMENT EXECUTE FUNCTION app.module_configuration_write_lock();
CREATE TRIGGER module_clocking_site_company_action BEFORE INSERT OR UPDATE OR DELETE ON public.clocking_location_company FOR EACH ROW EXECUTE FUNCTION app.clocking_site_company_guard();
-- Actual company-link writers use INSERT/DELETE only. Default public-table grants must not
-- expose a silent RLS-filtered UPDATE course for this immutable child. Owner backfills retain rights.
REVOKE UPDATE ON public.clocking_location_company FROM ai_hr_app;
-- Assignment source joins the same Access serialization before touching tuples. Try-only admission
-- prevents an existing native data lock from becoming a blocking Access lock-order upgrade.
-- This fence adds no role, employee visibility, purpose grant or control/business epoch mutation.
CREATE FUNCTION app.clocking_assignment_access_fence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT app.access_workforce_storage_owner() THEN
  PERFORM app.audit_access_order_lock_for(app.current_tenant_id());
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.clocking_assignment_access_fence() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER aaa_clocking_assignment_access BEFORE INSERT OR UPDATE OR DELETE ON public.employee_clocking_location FOR EACH STATEMENT EXECUTE FUNCTION app.clocking_assignment_access_fence();


--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.module_function_legacy_allowed(t uuid,u uuid,cap text,co uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT (cap LIKE 'function.leave.onBehalf.application.%' AND app.leave_on_behalf_application_native_allowed(t,u,cap,co)) OR (cap LIKE 'function.leave.own.application.%' AND app.leave_own_application_native_allowed(t,u,cap,co)) OR (cap LIKE 'function.attendancePolicy.clockingSites.%' AND app.clocking_site_native_allowed(t,u,cap,co)) OR (cap ~ '^function\.attendancePolicy\.(dutyRoster|exceptions)\.(view|edit)$' AND app.attendance_schedule_control_native_allowed(t,u,cap,co)) OR (cap LIKE 'function.attendancePolicy.rotations.%' AND app.attendance_rotation_native_allowed(t,u,cap,co)) OR app.leave_approval_company_native_allowed(t,u,cap,co) OR app.leave_approval_template_native_allowed(t,u,cap,co) OR app.claim_receipt_native_allowed(t,u,cap,co) OR app.claim_own_native_allowed(t,u,cap,co) OR app.claim_nonself_native_allowed(t,u,cap,co) OR app.claim_self_decision_native_allowed(t,u,cap,co)
 OR EXISTS(SELECT 1 FROM app.access_function_action a WHERE a.capability_id=cap AND a.function_key IN ('claimsConfig.types','claimsConfig.limits','claimsConfig.mileage','claimsConfig.reimbursements','claims.administration','leaveConfig.types','leaveConfig.gradeGroups','attendancePolicy.schedule','attendancePolicy.shifts') AND app.module_action_legacy_allowed(t,u,a.parent_capability,co));
$$;
CREATE OR REPLACE FUNCTION app.module_function_current_legacy_allowed(t uuid,u uuid,cap text,co uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT (cap LIKE 'function.leave.onBehalf.application.%' AND app.leave_on_behalf_application_current_native_allowed(t,u,cap,co)) OR (cap LIKE 'function.leave.own.application.%' AND app.leave_own_application_current_native_allowed(t,u,cap,co)) OR (cap LIKE 'function.attendancePolicy.clockingSites.%' AND app.clocking_site_current_native_allowed(t,u,cap,co)) OR (cap ~ '^function\.attendancePolicy\.(dutyRoster|exceptions)\.(view|edit)$' AND app.attendance_schedule_control_current_native_allowed(t,u,cap,co)) OR (cap LIKE 'function.attendancePolicy.rotations.%' AND app.attendance_rotation_current_native_allowed(t,u,cap,co)) OR app.leave_approval_company_current_native_allowed(t,u,cap,co) OR app.leave_approval_template_current_native_allowed(t,u,cap,co) OR app.claim_receipt_current_native_allowed(t,u,cap,co) OR app.claim_own_current_native_allowed(t,u,cap,co) OR app.claim_nonself_current_native_allowed(t,u,cap,co) OR app.claim_self_decision_current_native_allowed(t,u,cap,co)
 OR EXISTS(SELECT 1 FROM app.access_function_action a WHERE a.capability_id=cap AND a.function_key IN ('claimsConfig.types','claimsConfig.limits','claimsConfig.mileage','claimsConfig.reimbursements','claims.administration','leaveConfig.types','leaveConfig.gradeGroups','attendancePolicy.schedule','attendancePolicy.shifts') AND app.module_action_current_native_default(t,u,a.parent_capability,co));
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

--> statement-breakpoint
DO $$ DECLARE operation text;BEGIN
 FOREACH operation IN ARRAY ARRAY['view','add','edit','delete'] LOOP
  PERFORM app.register_function_action('attendancePolicy.shifts',operation,'tenant','attendance_configuration.'||operation,'app.module_action_current_legacy_allowed','{"moduleKey":"attendance","labelKey":"nav.shift","kind":"submenu","course":"administrative","screenKey":"attendancePolicy","href":"/admin/attendance","employeeBearing":false}');
 END LOOP;
END $$;
CREATE FUNCTION app.attendance_shift_allowed(p_operation text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.module_function_allowed('attendancePolicy.shifts','view',NULL) AND app.module_function_allowed('attendancePolicy.shifts',p_operation,NULL);
$$;
REVOKE ALL ON FUNCTION app.attendance_shift_allowed(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.attendance_shift_allowed(text) TO ai_hr_app;
CREATE TABLE app.shift_constructor_source(xact_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,shift_id uuid NOT NULL,source jsonb NOT NULL,authority_stamp text NOT NULL,invalidated boolean NOT NULL DEFAULT false,membership jsonb,membership_born boolean NOT NULL DEFAULT false,PRIMARY KEY(xact_id,tenant_id,user_id,shift_id));
CREATE TABLE app.shift_removed_source(xact_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,shift_id uuid NOT NULL,source jsonb NOT NULL,PRIMARY KEY(xact_id,tenant_id,user_id,shift_id));
REVOKE ALL ON app.shift_constructor_source,app.shift_removed_source FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.attendance_shift_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE operation text:=CASE TG_OP WHEN 'INSERT' THEN 'add' WHEN 'DELETE' THEN 'delete' ELSE 'edit' END;image public.shift%ROWTYPE;
BEGIN
 IF app.access_workforce_storage_owner() THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 PERFORM app.access_workforce_write_lock();
 IF TG_OP='DELETE' THEN image:=OLD;ELSE image:=NEW;END IF;
 IF TG_OP='UPDATE' AND OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL THEN operation:='delete';END IF;
 IF image.tenant_id IS DISTINCT FROM app.current_tenant_id() OR TG_OP='UPDATE' AND ROW(OLD.id,OLD.tenant_id) IS DISTINCT FROM ROW(NEW.id,NEW.tenant_id)
 OR NOT app.attendance_shift_allowed(operation)
 OR image.company_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.company c WHERE c.id=image.company_id AND c.tenant_id=image.tenant_id)
 OR image.rule_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.attendance_rule r WHERE r.id=image.rule_id AND r.tenant_id=image.tenant_id)
 THEN RAISE EXCEPTION 'Shift action unavailable' USING ERRCODE='42501';END IF;
 IF TG_OP='UPDATE' THEN UPDATE app.shift_constructor_source proof SET invalidated=true WHERE proof.xact_id=pg_current_xact_id() AND proof.tenant_id=OLD.tenant_id AND proof.shift_id=OLD.id AND NOT proof.membership_born;END IF;
 IF TG_OP='DELETE' THEN
  DELETE FROM app.shift_removed_source WHERE xact_id<pg_snapshot_xmin(pg_current_snapshot());
  INSERT INTO app.shift_removed_source VALUES(pg_current_xact_id(),OLD.tenant_id,app.current_user_id(),OLD.id,to_jsonb(OLD));RETURN OLD;
 END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.attendance_shift_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER module_shift_access BEFORE INSERT OR UPDATE OR DELETE ON public.shift FOR EACH STATEMENT EXECUTE FUNCTION app.module_configuration_write_lock();
CREATE TRIGGER module_shift_action BEFORE INSERT OR UPDATE OR DELETE ON public.shift FOR EACH ROW EXECUTE FUNCTION app.attendance_shift_guard();
CREATE FUNCTION app.attendance_shift_born() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT app.access_workforce_storage_owner() THEN
  DELETE FROM app.shift_constructor_source WHERE xact_id<pg_snapshot_xmin(pg_current_snapshot());
  INSERT INTO app.shift_constructor_source(xact_id,tenant_id,user_id,shift_id,source,authority_stamp) VALUES(pg_current_xact_id(),NEW.tenant_id,app.current_user_id(),NEW.id,to_jsonb(NEW),app.access_function_authority_stamp());
 END IF;RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.attendance_shift_born() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER module_shift_born AFTER INSERT ON public.shift FOR EACH ROW EXECUTE FUNCTION app.attendance_shift_born();
CREATE FUNCTION app.attendance_shift_window_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE image public.shift_ot_window%ROWTYPE;parent public.shift%ROWTYPE;operation text:='edit';
BEGIN
 IF app.access_workforce_storage_owner() THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 PERFORM app.access_workforce_write_lock();
 IF TG_OP='DELETE' THEN image:=OLD;ELSE image:=NEW;END IF;
 IF image.tenant_id IS DISTINCT FROM app.current_tenant_id() OR TG_OP='UPDATE' AND ROW(OLD.id,OLD.tenant_id,OLD.shift_id) IS DISTINCT FROM ROW(NEW.id,NEW.tenant_id,NEW.shift_id) THEN RAISE EXCEPTION 'Shift window identity unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO parent FROM public.shift actual WHERE actual.id=image.shift_id AND actual.tenant_id=image.tenant_id;
 IF TG_OP='DELETE' AND parent.id IS NULL AND EXISTS(SELECT 1 FROM app.shift_removed_source proof WHERE proof.xact_id=pg_current_xact_id() AND proof.tenant_id=image.tenant_id AND proof.user_id=app.current_user_id() AND proof.shift_id=image.shift_id) THEN operation:='delete';
 ELSIF parent.id IS NULL THEN RAISE EXCEPTION 'Shift window parent unavailable' USING ERRCODE='42501';
 ELSIF EXISTS(SELECT 1 FROM app.shift_constructor_source proof WHERE proof.xact_id=pg_current_xact_id() AND proof.tenant_id=image.tenant_id AND proof.user_id=app.current_user_id() AND proof.shift_id=parent.id AND NOT proof.invalidated AND proof.authority_stamp=app.access_function_authority_stamp()) THEN operation:='add';END IF;
 IF NOT app.attendance_shift_allowed(operation) THEN RAISE EXCEPTION 'Shift window action unavailable' USING ERRCODE='42501';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END $$;
REVOKE ALL ON FUNCTION app.attendance_shift_window_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER module_shift_window_access BEFORE INSERT OR UPDATE OR DELETE ON public.shift_ot_window FOR EACH STATEMENT EXECUTE FUNCTION app.module_configuration_write_lock();
CREATE TRIGGER module_shift_window_action BEFORE INSERT OR UPDATE OR DELETE ON public.shift_ot_window FOR EACH ROW EXECUTE FUNCTION app.attendance_shift_window_guard();
-- Original first-membership construction belongs to Shift Add; every later/neighbor membership
-- remains under its Schedule owner. A posted purpose or caller-owned GUC mints nothing here.
CREATE FUNCTION app.shift_initial_membership_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.access_workforce_storage_owner() THEN RETURN NEW;END IF;
 IF TG_WHEN='BEFORE' THEN
  IF app.attendance_shift_allowed('add') THEN
   UPDATE app.shift_constructor_source proof SET membership=to_jsonb(NEW) FROM public.shift actual
   WHERE proof.xact_id=pg_current_xact_id() AND proof.tenant_id=app.current_tenant_id() AND proof.user_id=app.current_user_id() AND proof.shift_id=NEW.shift_id
   AND proof.tenant_id=NEW.tenant_id AND NOT proof.invalidated AND proof.membership IS NULL AND proof.authority_stamp=app.access_function_authority_stamp()
   AND actual.id=proof.shift_id AND actual.tenant_id=proof.tenant_id AND to_jsonb(actual)=proof.source AND proof.source->>'rule_id'=NEW.rule_id::text;
  END IF;
 ELSE
  UPDATE app.shift_constructor_source proof SET membership_born=true WHERE proof.xact_id=pg_current_xact_id() AND proof.tenant_id=NEW.tenant_id AND proof.user_id=app.current_user_id() AND proof.shift_id=NEW.shift_id AND proof.membership=to_jsonb(NEW) AND NOT proof.invalidated AND proof.authority_stamp=app.access_function_authority_stamp();
 END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.shift_initial_membership_record() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER module_shift_initial_membership BEFORE INSERT ON public.attendance_rule_shift FOR EACH ROW EXECUTE FUNCTION app.shift_initial_membership_record();
CREATE TRIGGER aaa_shift_initial_membership_born AFTER INSERT ON public.attendance_rule_shift FOR EACH ROW EXECUTE FUNCTION app.shift_initial_membership_record();
CREATE FUNCTION app.shift_initial_membership_allowed(p_row jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.attendance_shift_allowed('add') AND EXISTS(SELECT 1 FROM app.shift_constructor_source proof WHERE proof.xact_id=pg_current_xact_id() AND proof.tenant_id=app.current_tenant_id() AND proof.user_id=app.current_user_id() AND proof.shift_id=(p_row->>'shift_id')::uuid
 AND proof.membership=p_row AND proof.membership_born AND NOT proof.invalidated AND proof.authority_stamp=app.access_function_authority_stamp() AND proof.source->>'rule_id'=p_row->>'rule_id' AND proof.tenant_id::text=p_row->>'tenant_id');
$$;
REVOKE ALL ON FUNCTION app.shift_initial_membership_allowed(jsonb) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.shift_initial_membership_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE proof app.shift_constructor_source%ROWTYPE;
BEGIN
 SELECT * INTO proof FROM app.shift_constructor_source actual WHERE actual.xact_id=NEW.xact_id AND actual.tenant_id=NEW.tenant_id AND actual.user_id=NEW.user_id AND actual.shift_id=NEW.shift_id;
 IF NOT FOUND OR proof.membership_born IS NOT TRUE OR app.shift_initial_membership_allowed(proof.membership) IS NOT TRUE THEN RAISE EXCEPTION 'Shift initialization incomplete' USING ERRCODE='42501';END IF;RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.shift_initial_membership_complete() FROM PUBLIC,ai_hr_app;
CREATE CONSTRAINT TRIGGER module_shift_initial_membership_complete AFTER UPDATE ON app.shift_constructor_source DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.membership_born) EXECUTE FUNCTION app.shift_initial_membership_complete();
CREATE FUNCTION app.shift_constructor_authority_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW.epoch IS DISTINCT FROM OLD.epoch THEN UPDATE app.shift_constructor_source proof SET membership_born=proof.membership_born WHERE proof.xact_id=pg_current_xact_id() AND proof.tenant_id=NEW.tenant_id AND proof.membership_born;END IF;RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.shift_constructor_authority_changed() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER shift_constructor_authority_recheck AFTER UPDATE ON app.access_control_epoch FOR EACH ROW EXECUTE FUNCTION app.shift_constructor_authority_changed();

--> statement-breakpoint
-- The native Leave override is a whole-set ACL, not Payroll configuration authority.
-- A finite owner admits the actual OLD/proposed NEW, writes that row and its native audit
-- together, then retains an exact completed proof. No runtime caller can mint an intent.
CREATE TABLE app.leave_permission_mutation(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),xact_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,
 grant_id uuid NOT NULL,before_row jsonb,after_row jsonb,authority_stamp text NOT NULL,
 scopes jsonb NOT NULL,scope_nodes uuid[] NOT NULL,active boolean NOT NULL DEFAULT true,born boolean NOT NULL DEFAULT false,
 event_id uuid,completed boolean NOT NULL DEFAULT false,scope_changed boolean NOT NULL DEFAULT false,
 CHECK(before_row IS NOT NULL OR after_row IS NOT NULL));
CREATE INDEX leave_permission_mutation_transaction ON app.leave_permission_mutation(xact_id,tenant_id,grant_id);
ALTER TABLE app.leave_permission_mutation ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.leave_permission_mutation FROM PUBLIC,ai_hr_app;

-- A NULL scope means actual future/global delegation. The generic operation proof
-- deliberately requires an existing company; do not extend it into a business bypass.
-- These two native ACL definitions have no parent prerequisites. Any explicit covered
-- company deny also constrains global delegation, exactly as access_can_delegate does.
CREATE FUNCTION app.leave_permission_controls_clear(p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN p_company IS NOT NULL THEN
  app.function_action_denial_clear('leave.onBehalf.application','view',p_company) AND app.function_action_denial_clear('leave.onBehalf.application','add',p_company)
 ELSE app.principal_snapshot_current() AND NOT EXISTS(
  SELECT 1 FROM unnest(ARRAY['view','add']) requested(operation_name)
  WHERE NOT EXISTS(SELECT 1 FROM app.access_function_action action JOIN app.access_function_definition definition USING(function_key)
   JOIN public.access_capability capability ON capability.id=action.capability_id
   WHERE action.function_key='leave.onBehalf.application' AND action.operation=requested.operation_name AND capability.id='function.leave.onBehalf.application.'||requested.operation_name
   AND definition.scope='company' AND definition.metadata->>'kind'='native_acl' AND definition.metadata->>'course'='administrative' AND capability.scope='company' AND capability.prerequisites='[]'::jsonb
   AND CASE WHEN capability.supported THEN
    EXISTS(SELECT 1 FROM public.access_configuration configuration WHERE configuration.tenant_id=app.current_tenant_id() AND configuration.initialized)
    AND jsonb_array_length(capability.bindings)>0 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(capability.bindings) binding WHERE jsonb_typeof(binding)<>'object' OR coalesce(binding->>'owner','')='' OR coalesce(binding->>'operation','')='')
    AND NOT EXISTS(SELECT 1 FROM public.access_user_override denial WHERE denial.tenant_id=app.current_tenant_id() AND denial.user_id=app.current_user_id() AND denial.capability_id=capability.id AND denial.effect='deny' AND denial.retired_at IS NULL)
   ELSE capability.bindings='[]'::jsonb END)) END;
$$;
REVOKE ALL ON FUNCTION app.leave_permission_controls_clear(uuid) FROM PUBLIC,ai_hr_app;

CREATE FUNCTION app.leave_permission_admit(p_before jsonb,p_after jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();scope record;recipient record;result jsonb:='[]'::jsonb;
BEGIN
 IF NOT app.principal_snapshot_current() OR NOT app.is_admin() OR app.access_function_authority_stamp() IS NULL
 OR coalesce(p_after,p_before)->>'permission_key' IS DISTINCT FROM 'leave.apply_on_behalf'
 OR (coalesce(p_after,p_before)->>'tenant_id')::uuid IS DISTINCT FROM t THEN RAISE EXCEPTION 'Leave permission administration unavailable' USING ERRCODE='42501';END IF;
 FOR scope IN
  SELECT changed.company_id,bool_or(changed.before_allowed IS DISTINCT FROM changed.after_allowed) AS changes_role,
   bool_or(changed.after_allowed AND NOT changed.before_allowed) AS widens
  FROM app.native_permission_override_role_changes(t,'leave.apply_on_behalf',p_before,p_after) changed GROUP BY changed.company_id
 LOOP
  IF NOT app.leave_permission_controls_clear(scope.company_id) OR scope.changes_role AND NOT app.native_permission_future_company_ceiling(scope.company_id) THEN RAISE EXCEPTION 'Leave permission scope unavailable' USING ERRCODE='42501';END IF;
  IF scope.widens
   AND EXISTS(SELECT 1 FROM public.access_capability capability WHERE capability.id='function.leave.onBehalf.application.add' AND capability.supported)
   AND (NOT app.access_can_delegate('function.leave.onBehalf.application.view',scope.company_id) OR NOT app.access_can_delegate('function.leave.onBehalf.application.add',scope.company_id)) THEN
   RAISE EXCEPTION 'Leave permission widening unavailable' USING ERRCODE='42501';END IF;
  result:=result||jsonb_build_array(scope.company_id);
 END LOOP;
 FOR recipient IN SELECT DISTINCT user_id FROM app.native_permission_override_recipients(t,'leave.apply_on_behalf',p_before,p_after) WHERE before_allowed IS DISTINCT FROM after_allowed LOOP
  IF NOT app.native_permission_recipient_data_ceiling(recipient.user_id) THEN RAISE EXCEPTION 'Leave permission recipient unavailable' USING ERRCODE='42501';END IF;
 END LOOP;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.leave_permission_admit(jsonb,jsonb) FROM PUBLIC,ai_hr_app;

-- Bind hierarchy only for actual affected scopes and the actual actor/changed recipients'
-- company predicates. This is source freshness, not a second data-ceiling implementation.
CREATE FUNCTION app.leave_permission_scope_nodes(p_before jsonb,p_after jsonb,p_scopes jsonb) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH RECURSIVE affected_users(user_id) AS(
  SELECT app.current_user_id() UNION SELECT recipient.user_id FROM app.native_permission_override_recipients(app.current_tenant_id(),'leave.apply_on_behalf',p_before,p_after) recipient
  WHERE recipient.before_allowed IS DISTINCT FROM recipient.after_allowed
 ),roots(id) AS(
  SELECT scope.value::uuid FROM jsonb_array_elements_text(p_scopes) scope WHERE scope.value IS NOT NULL
  UNION SELECT candidate.value::uuid FROM affected_users actor JOIN public.user_data_permission_assignment assignment ON assignment.tenant_id=app.current_tenant_id() AND assignment.user_id=actor.user_id
  JOIN public.data_permission_profile profile ON profile.id=assignment.profile_id AND profile.tenant_id=assignment.tenant_id AND profile.enabled AND profile.retired_at IS NULL
  JOIN public.data_permission_revision revision ON revision.id=profile.active_revision_id AND revision.tenant_id=profile.tenant_id AND revision.profile_id=profile.id
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN app.data_permission_rules_valid(revision.rules) THEN revision.rules->'predicates' ELSE '[]'::jsonb END) predicate
  CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN predicate->>'field'='company' THEN predicate->'values' ELSE '[]'::jsonb END) candidate
 ),lineage(id,parent_company_id) AS(
  SELECT company.id,company.parent_company_id FROM public.company company JOIN roots ON roots.id=company.id WHERE company.tenant_id=app.current_tenant_id()
  UNION SELECT parent.id,parent.parent_company_id FROM lineage child JOIN public.company parent ON parent.id=child.parent_company_id AND parent.tenant_id=app.current_tenant_id()
 ) SELECT coalesce(array_agg(lineage.id ORDER BY lineage.id),'{}'::uuid[]) FROM lineage;
$$;
REVOKE ALL ON FUNCTION app.leave_permission_scope_nodes(jsonb,jsonb,jsonb) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.leave_permission_source_allowed(p_before jsonb,p_after jsonb,p_active boolean DEFAULT false) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND app.is_admin() AND EXISTS(
  SELECT 1 FROM app.leave_permission_mutation proof WHERE proof.xact_id=pg_current_xact_id() AND proof.tenant_id=app.current_tenant_id() AND proof.user_id=app.current_user_id()
  AND proof.before_row IS NOT DISTINCT FROM p_before AND proof.after_row IS NOT DISTINCT FROM p_after
  AND proof.authority_stamp=app.access_function_authority_stamp() AND (CASE WHEN p_active THEN proof.active ELSE proof.active OR proof.completed END));
$$;
REVOKE ALL ON FUNCTION app.leave_permission_source_allowed(jsonb,jsonb,boolean) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.leave_permission_row_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE b jsonb:=CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END;a jsonb:=CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END;
BEGIN
 IF app.access_workforce_storage_owner() THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 IF b->>'permission_key'='leave.apply_on_behalf' OR a->>'permission_key'='leave.apply_on_behalf' THEN
  IF TG_OP='DELETE' AND app.module_company_cleanup_row_allowed('payroll_permission_grant',b,true) THEN RETURN OLD;END IF;
  IF app.leave_permission_source_allowed(b,a,true) IS NOT TRUE THEN RAISE EXCEPTION 'Leave permission source unavailable' USING ERRCODE='42501';END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END $$;
REVOKE ALL ON FUNCTION app.leave_permission_row_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER leave_permission_source BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_permission_grant FOR EACH ROW EXECUTE FUNCTION app.leave_permission_row_guard();
CREATE FUNCTION app.leave_permission_row_born() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE b jsonb:=CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END;a jsonb:=CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END;
BEGIN
 IF NOT app.access_workforce_storage_owner() THEN
  UPDATE app.leave_permission_mutation proof SET born=true WHERE proof.xact_id=pg_current_xact_id() AND proof.tenant_id=app.current_tenant_id() AND proof.user_id=app.current_user_id()
   AND proof.active AND proof.before_row IS NOT DISTINCT FROM b AND proof.after_row IS NOT DISTINCT FROM a AND proof.authority_stamp=app.access_function_authority_stamp();
 END IF;RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.leave_permission_row_born() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER leave_permission_born AFTER INSERT OR UPDATE OR DELETE ON public.payroll_permission_grant FOR EACH ROW EXECUTE FUNCTION app.leave_permission_row_born();

CREATE FUNCTION app.leave_permission_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE proof app.leave_permission_mutation%ROWTYPE;scope jsonb;event_name text;expected_payload jsonb;
BEGIN
 SELECT * INTO proof FROM app.leave_permission_mutation actual WHERE actual.id=NEW.id;
 IF NOT FOUND OR NOT proof.completed OR NOT proof.born OR proof.active OR proof.scope_changed OR proof.xact_id<>pg_current_xact_id() OR proof.tenant_id IS DISTINCT FROM app.current_tenant_id() OR proof.user_id IS DISTINCT FROM app.current_user_id()
 OR proof.authority_stamp IS DISTINCT FROM app.access_function_authority_stamp() OR NOT app.principal_snapshot_current() OR NOT app.is_admin() THEN RAISE EXCEPTION 'Leave permission completion unavailable' USING ERRCODE='42501';END IF;
 event_name:=CASE WHEN proof.before_row IS NULL THEN 'created' WHEN proof.after_row IS NULL THEN 'deleted' ELSE 'updated' END;
 expected_payload:=jsonb_build_object('permissionKey','leave.apply_on_behalf','role',coalesce(proof.after_row,proof.before_row)->>'role');
 IF proof.after_row IS NOT NULL THEN expected_payload:=expected_payload||jsonb_build_object('companyId',proof.after_row->'company_id','allowed',proof.after_row->'allowed');END IF;
 IF NOT EXISTS(SELECT 1 FROM public.domain_event audit WHERE audit.id=proof.event_id AND audit.tenant_id=proof.tenant_id AND audit.aggregate_type='payroll-permission-grant' AND audit.aggregate_id=proof.grant_id
 AND audit.event_type='payroll-permission-grant.'||event_name AND audit.actor_type='user' AND audit.actor_id=proof.user_id AND audit.subject_employment_id IS NULL AND audit.payload=expected_payload) THEN RAISE EXCEPTION 'Leave permission audit unavailable' USING ERRCODE='42501';END IF;
 FOR scope IN SELECT value FROM jsonb_array_elements(proof.scopes) LOOP
  IF NOT app.leave_permission_controls_clear((scope#>>'{}')::uuid) THEN RAISE EXCEPTION 'Leave permission controls changed' USING ERRCODE='42501';END IF;
 END LOOP;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.leave_permission_complete() FROM PUBLIC,ai_hr_app;
-- Insert completion evidence only AFTER the finite row and native audit have completed. Thus
-- caller SET CONSTRAINTS ALL IMMEDIATE is valid without altering any constraint mode.
CREATE CONSTRAINT TRIGGER leave_permission_complete AFTER UPDATE ON app.leave_permission_mutation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.completed) EXECUTE FUNCTION app.leave_permission_complete();
CREATE FUNCTION app.leave_permission_authority_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW.epoch IS DISTINCT FROM OLD.epoch THEN UPDATE app.leave_permission_mutation proof SET completed=proof.completed WHERE proof.xact_id=pg_current_xact_id() AND proof.tenant_id=NEW.tenant_id AND proof.completed;END IF;RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.leave_permission_authority_changed() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER leave_permission_authority_recheck AFTER UPDATE ON app.access_control_epoch FOR EACH ROW EXECUTE FUNCTION app.leave_permission_authority_changed();

CREATE FUNCTION app.leave_permission_write(p_delete uuid,p_company uuid,p_role text,p_allowed boolean) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE prior public.payroll_permission_grant%ROWTYPE;proposed public.payroll_permission_grant%ROWTYPE;
 b jsonb;a jsonb;proof_id uuid;scopes jsonb;audit_id uuid;event_name text;payload jsonb;
BEGIN
 PERFORM app.audit_access_order_lock_for(app.current_tenant_id());PERFORM app.access_workforce_write_lock();
 IF NOT app.principal_snapshot_current() OR NOT app.is_admin() THEN RAISE EXCEPTION 'Leave permission administration unavailable' USING ERRCODE='42501';END IF;
 IF p_delete IS NOT NULL THEN
  SELECT * INTO prior FROM public.payroll_permission_grant actual WHERE actual.id=p_delete AND actual.tenant_id=app.current_tenant_id() AND actual.permission_key='leave.apply_on_behalf' FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL;END IF;
  b:=to_jsonb(prior);
 ELSE
  IF p_role IS NULL OR p_role NOT IN ('employee','manager','hr_admin','super_admin','payroll_partner','performance_comp_partner') OR p_allowed IS NULL
  OR p_company IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.company actual WHERE actual.id=p_company AND actual.tenant_id=app.current_tenant_id()) THEN RAISE EXCEPTION 'Leave permission target unavailable' USING ERRCODE='42501';END IF;
  SELECT * INTO prior FROM public.payroll_permission_grant actual WHERE actual.tenant_id=app.current_tenant_id() AND actual.permission_key='leave.apply_on_behalf' AND actual.company_id IS NOT DISTINCT FROM p_company AND actual.role=p_role FOR UPDATE;
  IF FOUND THEN b:=to_jsonb(prior);proposed:=prior;ELSE proposed.id:=gen_random_uuid();proposed.tenant_id:=app.current_tenant_id();proposed.company_id:=p_company;proposed.permission_key:='leave.apply_on_behalf';proposed.role:=p_role;proposed.created_at:=now();END IF;
  proposed.allowed:=p_allowed;proposed.updated_at:=now();a:=to_jsonb(proposed);
 END IF;
 scopes:=app.leave_permission_admit(b,a);
 DELETE FROM app.leave_permission_mutation WHERE xact_id<pg_snapshot_xmin(pg_current_snapshot());
 INSERT INTO app.leave_permission_mutation(xact_id,tenant_id,user_id,grant_id,before_row,after_row,authority_stamp,scopes,scope_nodes)
 VALUES(pg_current_xact_id(),app.current_tenant_id(),app.current_user_id(),coalesce(proposed.id,prior.id),b,a,app.access_function_authority_stamp(),scopes,app.leave_permission_scope_nodes(b,a,scopes)) RETURNING id INTO proof_id;
 IF a IS NULL THEN DELETE FROM public.payroll_permission_grant WHERE id=prior.id AND tenant_id=prior.tenant_id;
 ELSIF b IS NULL THEN INSERT INTO public.payroll_permission_grant(id,tenant_id,company_id,permission_key,role,allowed,created_at,updated_at)
  VALUES(proposed.id,proposed.tenant_id,proposed.company_id,proposed.permission_key,proposed.role,proposed.allowed,proposed.created_at,proposed.updated_at);
 ELSE UPDATE public.payroll_permission_grant SET allowed=proposed.allowed,updated_at=proposed.updated_at WHERE id=prior.id AND tenant_id=prior.tenant_id;END IF;
 IF NOT EXISTS(SELECT 1 FROM app.leave_permission_mutation actual WHERE actual.id=proof_id AND actual.born) THEN RAISE EXCEPTION 'Leave permission effect unavailable' USING ERRCODE='42501';END IF;
 event_name:=CASE WHEN b IS NULL THEN 'created' WHEN a IS NULL THEN 'deleted' ELSE 'updated' END;
 payload:=jsonb_build_object('permissionKey','leave.apply_on_behalf','role',coalesce(a,b)->>'role');
 IF a IS NOT NULL THEN payload:=payload||jsonb_build_object('companyId',a->'company_id','allowed',a->'allowed');END IF;
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload)
 VALUES(app.current_tenant_id(),'payroll-permission-grant',coalesce(proposed.id,prior.id),'payroll-permission-grant.'||event_name,'user',app.current_user_id(),NULL,payload) RETURNING id INTO audit_id;
 UPDATE app.leave_permission_mutation SET active=false,event_id=audit_id,completed=true WHERE id=proof_id;
 PERFORM app.access_refresh_native_defaults(app.current_user_id());
 RETURN coalesce(proposed.id,prior.id);
END $$;
REVOKE ALL ON FUNCTION app.leave_permission_write(uuid,uuid,text,boolean) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.leave_on_behalf_grant_set(p_company uuid,p_role text,p_allowed boolean) RETURNS uuid
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT app.leave_permission_write(NULL,p_company,p_role,p_allowed);$$;
CREATE FUNCTION app.leave_on_behalf_grant_delete(p_id uuid) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT app.leave_permission_write(p_id,NULL,NULL,NULL) IS NOT NULL;$$;
REVOKE ALL ON FUNCTION app.leave_on_behalf_grant_set(uuid,text,boolean),app.leave_on_behalf_grant_delete(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.leave_on_behalf_grant_set(uuid,text,boolean),app.leave_on_behalf_grant_delete(uuid) TO ai_hr_app;
CREATE TRIGGER leave_permission_access BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_permission_grant FOR EACH STATEMENT EXECUTE FUNCTION app.claim_native_source_statement_lock();

--> statement-breakpoint
-- Company Delete owns disposal of these exact two config relations, not Clocking Edit
-- or an ACL mutation for a surviving scope. The native service still owns retention checks,
-- its ordinary cascade order, the Company DELETE, and its existing audit payload.
CREATE TABLE app.module_company_hierarchy_epoch(
 tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,company_id uuid NOT NULL,epoch bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(tenant_id,company_id));
ALTER TABLE app.module_company_hierarchy_epoch ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.module_company_hierarchy_epoch FROM PUBLIC,ai_hr_app;
INSERT INTO app.module_company_hierarchy_epoch(tenant_id,company_id) SELECT tenant_id,id FROM public.company;
CREATE FUNCTION app.leave_permission_hierarchy_recheck() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' OR NEW.epoch IS DISTINCT FROM OLD.epoch THEN
  UPDATE app.leave_permission_mutation proof SET scope_changed=true WHERE proof.xact_id=pg_current_xact_id() AND proof.tenant_id=NEW.tenant_id
   AND proof.completed AND NOT proof.scope_changed AND (NEW.company_id=ANY(proof.scope_nodes) OR proof.scopes @> '[null]'::jsonb);
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.leave_permission_hierarchy_recheck() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER leave_permission_hierarchy_recheck AFTER INSERT OR UPDATE ON app.module_company_hierarchy_epoch FOR EACH ROW EXECUTE FUNCTION app.leave_permission_hierarchy_recheck();
CREATE TABLE app.module_company_cleanup(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),xact_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,company_id uuid NOT NULL,
 source jsonb NOT NULL,authority_stamp text NOT NULL,hierarchy jsonb NOT NULL,usage_rows bigint NOT NULL,
 clocking_rows jsonb NOT NULL,payroll_rows jsonb NOT NULL,clocking_removed jsonb NOT NULL DEFAULT '[]',payroll_removed jsonb NOT NULL DEFAULT '[]',
 removing_children boolean NOT NULL DEFAULT false,children_consumed boolean NOT NULL DEFAULT false,company_removed boolean NOT NULL DEFAULT false,event_id uuid,restore_immediate boolean NOT NULL,completed boolean NOT NULL DEFAULT false,
 UNIQUE(xact_id,tenant_id,company_id));
ALTER TABLE app.module_company_cleanup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.module_company_cleanup FROM PUBLIC,ai_hr_app;

CREATE FUNCTION app.module_company_cleanup_native(p_source jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND (p_source->>'tenant_id')::uuid=app.current_tenant_id()
 AND app.is_admin_for(coalesce((p_source->>'parent_company_id')::uuid,(p_source->>'id')::uuid))
 AND app.organisation_settings_function_allowed('organization','view',(p_source->>'id')::uuid)
 AND app.organisation_settings_function_allowed('organization','delete',(p_source->>'id')::uuid);
$$;
REVOKE ALL ON FUNCTION app.module_company_cleanup_native(jsonb) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.module_company_cleanup_row_allowed(p_table text,p_old jsonb,p_active boolean DEFAULT false) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND EXISTS(
  SELECT 1 FROM app.module_company_cleanup proof
   WHERE proof.xact_id=pg_current_xact_id() AND proof.tenant_id=app.current_tenant_id() AND proof.user_id=app.current_user_id()
   AND proof.tenant_id=(p_old->>'tenant_id')::uuid AND proof.company_id=(p_old->>'company_id')::uuid
   AND proof.authority_stamp=app.access_function_authority_stamp()
   AND CASE WHEN proof.children_consumed AND NOT p_active THEN CASE p_table
    WHEN 'clocking_location_company' THEN proof.clocking_removed @> jsonb_build_array(p_old)
    WHEN 'payroll_permission_grant' THEN proof.payroll_removed @> jsonb_build_array(p_old) ELSE false END
   WHEN proof.removing_children AND NOT proof.completed AND NOT proof.company_removed THEN
    EXISTS(SELECT 1 FROM public.company actual WHERE actual.id=proof.company_id AND actual.tenant_id=proof.tenant_id AND to_jsonb(actual)=proof.source)
    AND app.module_company_cleanup_native(proof.source)
    AND CASE p_table WHEN 'clocking_location_company' THEN proof.clocking_rows @> jsonb_build_array(p_old) AND NOT proof.clocking_removed @> jsonb_build_array(p_old)
    WHEN 'payroll_permission_grant' THEN proof.payroll_rows @> jsonb_build_array(p_old) AND (NOT p_active OR NOT proof.payroll_removed @> jsonb_build_array(p_old)) ELSE false END
   ELSE false END);
$$;
REVOKE ALL ON FUNCTION app.module_company_cleanup_row_allowed(text,jsonb,boolean) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.module_company_cleanup_child_removed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.module_company_cleanup_row_allowed(TG_TABLE_NAME,to_jsonb(OLD),true) THEN
  UPDATE app.module_company_cleanup proof SET
   clocking_removed=proof.clocking_removed||CASE WHEN TG_TABLE_NAME='clocking_location_company' THEN jsonb_build_array(to_jsonb(OLD)) ELSE '[]'::jsonb END,
   payroll_removed=proof.payroll_removed||CASE WHEN TG_TABLE_NAME='payroll_permission_grant' THEN jsonb_build_array(to_jsonb(OLD)) ELSE '[]'::jsonb END
  WHERE proof.xact_id=pg_current_xact_id() AND proof.tenant_id=OLD.tenant_id AND proof.user_id=app.current_user_id() AND proof.company_id=OLD.company_id;
 END IF;RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.module_company_cleanup_child_removed() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER module_company_clocking_removed AFTER DELETE ON public.clocking_location_company FOR EACH ROW EXECUTE FUNCTION app.module_company_cleanup_child_removed();
CREATE TRIGGER module_company_payroll_removed AFTER DELETE ON public.payroll_permission_grant FOR EACH ROW EXECUTE FUNCTION app.module_company_cleanup_child_removed();
-- The public admission never mutates an ACL while a live company remains. Only this
-- actual Company DELETE statement can enter the tightly scoped child-removal phase.
CREATE FUNCTION app.module_company_cleanup_delete_children() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE proof app.module_company_cleanup%ROWTYPE;
BEGIN
 SELECT * INTO proof FROM app.module_company_cleanup actual WHERE actual.xact_id=pg_current_xact_id() AND actual.tenant_id=OLD.tenant_id AND actual.company_id=OLD.id FOR UPDATE;
 IF NOT FOUND THEN RETURN OLD;END IF;
 IF proof.completed OR proof.company_removed OR proof.removing_children OR proof.children_consumed OR proof.source IS DISTINCT FROM to_jsonb(OLD)
 OR proof.tenant_id IS DISTINCT FROM app.current_tenant_id() OR proof.user_id IS DISTINCT FROM app.current_user_id() OR proof.authority_stamp IS DISTINCT FROM app.access_function_authority_stamp()
 OR NOT app.module_company_cleanup_native(to_jsonb(OLD)) OR EXISTS(SELECT 1 FROM public.employment actual WHERE actual.company_id=OLD.id) THEN
  RAISE EXCEPTION 'Company cleanup source changed' USING ERRCODE='42501';END IF;
 UPDATE app.module_company_cleanup SET removing_children=true WHERE id=proof.id;
 DELETE FROM public.payroll_permission_grant actual WHERE actual.tenant_id=proof.tenant_id AND actual.company_id=proof.company_id AND proof.payroll_rows @> jsonb_build_array(to_jsonb(actual));
 DELETE FROM public.clocking_location_company actual WHERE actual.tenant_id=proof.tenant_id AND actual.company_id=proof.company_id AND proof.clocking_rows @> jsonb_build_array(to_jsonb(actual));
 IF EXISTS(SELECT 1 FROM public.payroll_permission_grant actual WHERE actual.company_id=proof.company_id)
 OR EXISTS(SELECT 1 FROM public.clocking_location_company actual WHERE actual.company_id=proof.company_id) THEN RAISE EXCEPTION 'Company cleanup child set changed' USING ERRCODE='42501';END IF;
 UPDATE app.module_company_cleanup SET removing_children=false,children_consumed=true WHERE id=proof.id;
 PERFORM app.access_refresh_native_defaults(app.current_user_id());
 RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION app.module_company_cleanup_delete_children() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER zz_module_company_cleanup_delete_children BEFORE DELETE ON public.company FOR EACH ROW EXECUTE FUNCTION app.module_company_cleanup_delete_children();
CREATE FUNCTION app.module_company_cleanup_parent_removed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 UPDATE app.module_company_cleanup proof SET company_removed=true
 WHERE proof.xact_id=pg_current_xact_id() AND proof.tenant_id=OLD.tenant_id AND proof.user_id=app.current_user_id() AND proof.company_id=OLD.id
 AND NOT proof.removing_children AND proof.children_consumed AND NOT proof.completed AND NOT proof.company_removed AND proof.source=to_jsonb(OLD) AND proof.authority_stamp=app.access_function_authority_stamp()
 AND proof.clocking_rows @> proof.clocking_removed AND proof.clocking_removed @> proof.clocking_rows
 AND proof.payroll_rows @> proof.payroll_removed AND proof.payroll_removed @> proof.payroll_rows;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.module_company_cleanup_parent_removed() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER module_company_parent_removed AFTER DELETE ON public.company FOR EACH ROW EXECUTE FUNCTION app.module_company_cleanup_parent_removed();
CREATE FUNCTION app.module_company_cleanup_audit_payload(p_source jsonb,p_usage_rows bigint) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('legalName',p_source->'legal_name','code',p_source->'company_label','registrationNo',p_source->'registration_no','usageSnapshotRows',p_usage_rows);
$$;
REVOKE ALL ON FUNCTION app.module_company_cleanup_audit_payload(jsonb,bigint) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.module_company_cleanup_audit_born() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 UPDATE app.module_company_cleanup proof SET event_id=NEW.id
 WHERE proof.xact_id=pg_current_xact_id() AND proof.tenant_id=NEW.tenant_id AND proof.user_id=NEW.actor_id AND proof.user_id=app.current_user_id() AND proof.company_id=NEW.aggregate_id
 AND NOT proof.completed AND proof.company_removed AND proof.event_id IS NULL AND NEW.actor_type='user' AND NEW.subject_employment_id IS NULL
 AND proof.authority_stamp=app.access_function_authority_stamp() AND NEW.payload=app.module_company_cleanup_audit_payload(proof.source,proof.usage_rows);
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.module_company_cleanup_audit_born() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER module_company_cleanup_audit AFTER INSERT ON public.domain_event FOR EACH ROW WHEN(NEW.aggregate_type='company' AND NEW.event_type='company.deleted') EXECUTE FUNCTION app.module_company_cleanup_audit_born();

CREATE FUNCTION app.module_company_cleanup_validate() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE proof app.module_company_cleanup%ROWTYPE;
BEGIN
 SELECT * INTO proof FROM app.module_company_cleanup actual WHERE actual.id=NEW.id;
 IF NOT FOUND OR NOT proof.completed THEN
  RAISE EXCEPTION 'Company cleanup is incomplete' USING ERRCODE='42501',SCHEMA='app',TABLE='module_company_cleanup',CONSTRAINT=TG_NAME;
 END IF;
 IF NOT proof.company_removed OR proof.xact_id<>pg_current_xact_id() OR proof.tenant_id IS DISTINCT FROM app.current_tenant_id() OR proof.user_id IS DISTINCT FROM app.current_user_id()
 OR proof.authority_stamp IS DISTINCT FROM app.access_function_authority_stamp() OR NOT app.principal_snapshot_current()
 OR NOT app.is_admin_for(coalesce((proof.source->>'parent_company_id')::uuid,proof.company_id))
 OR EXISTS(SELECT 1 FROM jsonb_each_text(proof.hierarchy) node LEFT JOIN app.module_company_hierarchy_epoch current_epoch ON current_epoch.tenant_id=proof.tenant_id AND current_epoch.company_id=node.key::uuid
  WHERE current_epoch.epoch IS DISTINCT FROM node.value::bigint+CASE WHEN node.key::uuid=proof.company_id THEN 1 ELSE 0 END)
 OR EXISTS(SELECT 1 FROM public.company actual WHERE actual.id=proof.company_id)
 OR EXISTS(SELECT 1 FROM public.clocking_location_company actual WHERE actual.company_id=proof.company_id)
 OR EXISTS(SELECT 1 FROM public.payroll_permission_grant actual WHERE actual.company_id=proof.company_id)
 OR NOT EXISTS(SELECT 1 FROM public.domain_event audit WHERE audit.id=proof.event_id AND audit.tenant_id=proof.tenant_id AND audit.aggregate_id=proof.company_id
  AND audit.aggregate_type='company' AND audit.event_type='company.deleted' AND audit.actor_type='user' AND audit.actor_id=proof.user_id AND audit.subject_employment_id IS NULL
  AND audit.payload=app.module_company_cleanup_audit_payload(proof.source,proof.usage_rows)) THEN
  RAISE EXCEPTION 'Company cleanup effects or authority changed' USING ERRCODE='42501';
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.module_company_cleanup_validate() FROM PUBLIC,ai_hr_app;
CREATE CONSTRAINT TRIGGER module_company_cleanup_orphan AFTER INSERT ON app.module_company_cleanup DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.module_company_cleanup_validate();
CREATE CONSTRAINT TRIGGER module_company_cleanup_final AFTER UPDATE ON app.module_company_cleanup DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.completed) EXECUTE FUNCTION app.module_company_cleanup_validate();
CREATE FUNCTION app.module_company_cleanup_authority_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW.epoch IS DISTINCT FROM OLD.epoch THEN
  IF TG_TABLE_NAME='access_control_epoch' THEN
   UPDATE app.module_company_cleanup proof SET completed=proof.completed WHERE proof.xact_id=pg_current_xact_id() AND proof.tenant_id=NEW.tenant_id AND proof.completed;
  ELSE
   UPDATE app.module_company_cleanup proof SET completed=proof.completed WHERE proof.xact_id=pg_current_xact_id() AND proof.tenant_id=NEW.tenant_id AND proof.completed AND proof.hierarchy ? (NEW.company_id::text);
  END IF;
 END IF;RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.module_company_cleanup_authority_changed() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER module_company_cleanup_control_recheck AFTER UPDATE ON app.access_control_epoch FOR EACH ROW EXECUTE FUNCTION app.module_company_cleanup_authority_changed();
CREATE TRIGGER module_company_cleanup_hierarchy_recheck AFTER UPDATE ON app.module_company_hierarchy_epoch FOR EACH ROW EXECUTE FUNCTION app.module_company_cleanup_authority_changed();
CREATE FUNCTION app.module_company_hierarchy_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE old_tenant uuid;old_id uuid;new_tenant uuid;new_id uuid;affected record;
BEGIN
 IF TG_OP='UPDATE' AND (OLD.tenant_id,OLD.id,OLD.parent_company_id,OLD.archived_at) IS NOT DISTINCT FROM (NEW.tenant_id,NEW.id,NEW.parent_company_id,NEW.archived_at) THEN RETURN NULL;END IF;
 IF TG_OP<>'INSERT' THEN old_tenant:=OLD.tenant_id;old_id:=OLD.id;END IF;
 IF TG_OP<>'DELETE' THEN new_tenant:=NEW.tenant_id;new_id:=NEW.id;END IF;
 FOR affected IN SELECT DISTINCT t,c FROM (VALUES(old_tenant,old_id),(new_tenant,new_id)) identities(t,c) WHERE c IS NOT NULL ORDER BY t,c LOOP
  INSERT INTO app.module_company_hierarchy_epoch AS epoch(tenant_id,company_id)
   SELECT affected.t,affected.c WHERE EXISTS(SELECT 1 FROM public.tenant tenant WHERE tenant.id=affected.t)
   ON CONFLICT(tenant_id,company_id) DO UPDATE SET epoch=epoch.epoch+1;
 END LOOP;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.module_company_hierarchy_changed() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER module_company_hierarchy_epoch AFTER INSERT OR UPDATE OR DELETE ON public.company FOR EACH ROW EXECUTE FUNCTION app.module_company_hierarchy_changed();

CREATE FUNCTION app.module_company_cleanup_admit(p_company uuid,p_restore_immediate boolean) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source public.company%ROWTYPE;clocking_rows jsonb;payroll_rows jsonb;hierarchy jsonb;result uuid;stamp text;
BEGIN
 SELECT * INTO source FROM public.company actual WHERE actual.id=p_company AND actual.tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND OR NOT app.principal_snapshot_current() OR NOT app.is_admin_for(coalesce(source.parent_company_id,source.id)) THEN RAISE EXCEPTION 'Company cleanup unavailable' USING ERRCODE='42501';END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(actual) ORDER BY actual.id),'[]') INTO clocking_rows FROM (SELECT * FROM public.clocking_location_company child WHERE child.company_id=source.id AND child.tenant_id=source.tenant_id ORDER BY child.id FOR UPDATE) actual;
 SELECT coalesce(jsonb_agg(to_jsonb(actual) ORDER BY actual.id),'[]') INTO payroll_rows FROM (SELECT * FROM public.payroll_permission_grant child WHERE child.company_id=source.id AND child.tenant_id=source.tenant_id ORDER BY child.id FOR UPDATE) actual;
 IF clocking_rows='[]' AND payroll_rows='[]' THEN RETURN NULL;END IF;
 stamp:=app.access_function_authority_stamp();
 IF stamp IS NULL OR NOT app.module_company_cleanup_native(to_jsonb(source))
 OR EXISTS(SELECT 1 FROM public.employment actual WHERE actual.company_id=source.id)
 OR EXISTS(SELECT 1 FROM public.clocking_location_company actual WHERE actual.company_id=source.id AND actual.tenant_id<>source.tenant_id)
 OR EXISTS(SELECT 1 FROM public.payroll_permission_grant actual WHERE actual.company_id=source.id AND actual.tenant_id<>source.tenant_id) THEN RAISE EXCEPTION 'Company cleanup unavailable' USING ERRCODE='42501';END IF;
 WITH RECURSIVE ancestry(id,parent_company_id) AS(
  SELECT source.id,source.parent_company_id UNION
  SELECT parent.id,parent.parent_company_id FROM ancestry child JOIN public.company parent ON parent.id=child.parent_company_id AND parent.tenant_id=source.tenant_id
 ),locked AS(
  SELECT current_epoch.company_id,current_epoch.epoch FROM app.module_company_hierarchy_epoch current_epoch JOIN ancestry node ON node.id=current_epoch.company_id
  WHERE current_epoch.tenant_id=source.tenant_id ORDER BY current_epoch.company_id FOR SHARE OF current_epoch
 ) SELECT jsonb_object_agg(locked.company_id::text,locked.epoch) INTO hierarchy FROM locked;
 IF hierarchy IS NULL OR NOT hierarchy ? (source.id::text) OR source.parent_company_id IS NOT NULL AND NOT hierarchy ? (source.parent_company_id::text) THEN RAISE EXCEPTION 'Company hierarchy unavailable' USING ERRCODE='42501';END IF;
 DELETE FROM app.module_company_cleanup WHERE xact_id<pg_snapshot_xmin(pg_current_snapshot());
 INSERT INTO app.module_company_cleanup(xact_id,tenant_id,user_id,company_id,source,authority_stamp,hierarchy,usage_rows,clocking_rows,payroll_rows,restore_immediate)
 VALUES(pg_current_xact_id(),source.tenant_id,app.current_user_id(),source.id,to_jsonb(source),stamp,hierarchy,
  (SELECT count(*) FROM public.usage_snapshot usage WHERE usage.tenant_id=source.tenant_id AND usage.company_id=source.id),clocking_rows,payroll_rows,p_restore_immediate) RETURNING id INTO result;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.module_company_cleanup_admit(uuid,boolean) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.module_company_cleanup_begin(p_company uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE proof_id uuid;prior_immediate boolean:=false;failure_schema text;failure_table text;failure_constraint text;failure_message text;
BEGIN
 PERFORM app.audit_access_order_lock_for(app.current_tenant_id());PERFORM app.access_workforce_write_lock();
 BEGIN
  proof_id:=app.module_company_cleanup_admit(p_company,false);
 EXCEPTION WHEN SQLSTATE '42501' THEN
  GET STACKED DIAGNOSTICS failure_schema=SCHEMA_NAME,failure_table=TABLE_NAME,failure_constraint=CONSTRAINT_NAME,failure_message=MESSAGE_TEXT;
  IF failure_schema IS DISTINCT FROM 'app' OR failure_table IS DISTINCT FROM 'module_company_cleanup' OR failure_constraint IS DISTINCT FROM 'module_company_cleanup_orphan' OR failure_message IS DISTINCT FROM 'Company cleanup is incomplete' THEN RAISE;END IF;
  prior_immediate:=true;
 END;
 IF prior_immediate THEN
  SET CONSTRAINTS app.module_company_cleanup_orphan DEFERRED;
  proof_id:=app.module_company_cleanup_admit(p_company,true);
  IF proof_id IS NULL THEN SET CONSTRAINTS app.module_company_cleanup_orphan IMMEDIATE;END IF;
 END IF;
 RETURN proof_id;
END $$;
CREATE FUNCTION app.module_company_cleanup_finish(p_proof uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE prior_immediate boolean;
BEGIN
 UPDATE app.module_company_cleanup proof SET completed=true WHERE proof.id=p_proof AND proof.xact_id=pg_current_xact_id() AND proof.tenant_id=app.current_tenant_id() AND proof.user_id=app.current_user_id()
 AND app.principal_snapshot_current() AND proof.authority_stamp=app.access_function_authority_stamp() AND proof.company_removed AND proof.event_id IS NOT NULL AND NOT proof.completed
 RETURNING proof.restore_immediate INTO prior_immediate;
 IF NOT FOUND THEN RAISE EXCEPTION 'Company cleanup completion unavailable' USING ERRCODE='42501';END IF;
 IF prior_immediate THEN SET CONSTRAINTS app.module_company_cleanup_orphan IMMEDIATE;END IF;
END $$;
REVOKE ALL ON FUNCTION app.module_company_cleanup_begin(uuid),app.module_company_cleanup_finish(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.module_company_cleanup_begin(uuid),app.module_company_cleanup_finish(uuid) TO ai_hr_app;

--> statement-breakpoint
-- The own-history surface discloses request details only through the same actual
-- self/company View. Approval, attendance and payroll references are independent.
CREATE FUNCTION app.leave_own_request_view_allowed(p_request uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.leave_request request WHERE request.id=p_request AND request.tenant_id=app.current_tenant_id()
  AND app.leave_own_application_allowed(request.employment_id,'view'));
$$;
REVOKE ALL ON FUNCTION app.leave_own_request_view_allowed(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.leave_own_request_view_allowed(uuid) TO ai_hr_app;
DO $own_history$ DECLARE predecessor record;source text;definition text;anchor text:='AND lr.tenant_id = app.current_tenant_id()';BEGIN
 FOR predecessor IN SELECT * FROM (VALUES
  ('app.own_leave_request_approvals(uuid[])','9b347d9cc12b9ddf3ef4fa7c99f88ae2'),
  ('app.own_leave_request_cancellations(uuid[])','cfd5c4cf3ed2b5681330fc8a02d23816')) owners(signature,source_hash)
 LOOP
  SELECT prosrc,pg_get_functiondef(oid) INTO source,definition FROM pg_proc WHERE oid=to_regprocedure(predecessor.signature);
  IF source IS NULL OR md5(source)<>predecessor.source_hash OR (length(source)-length(replace(source,anchor,'')))/length(anchor)<>1 THEN
   RAISE EXCEPTION 'Own Leave history projection source changed: %',predecessor.signature;
  END IF;
  EXECUTE replace(definition,anchor,anchor||E'\n      AND app.leave_own_application_allowed(lr.employment_id,''view'')');
 END LOOP;
END $own_history$;

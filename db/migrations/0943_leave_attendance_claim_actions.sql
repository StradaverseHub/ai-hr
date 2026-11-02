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
 before_hash text NOT NULL,after_hash text NOT NULL,event_id uuid NOT NULL,
 PRIMARY KEY(xact_id,tenant_id,user_id,claim_id,before_hash,after_hash)
);
REVOKE ALL ON app.module_claim_effect FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.claim_own_native_allowed(t uuid,u uuid,cap text,co uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT (cap IN ('function.claims.own.view','function.claims.own.delete') OR cap ~ '^function\.claims\.own\.(drafts\.(view|add|edit|delete)|submit\.(view|execute))$') AND co IS NOT NULL
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
 PERFORM app.register_function_action('claims.own','view','company',NULL,'app.claim_own_current_native_allowed','{"moduleKey":"claims","labelKey":"claims.title","kind":"native_acl","course":"own","employeeBearing":false}'::jsonb);
 PERFORM app.register_function_action('claims.own','delete','company',NULL,'app.claim_own_current_native_allowed','{}'::jsonb);
 PERFORM app.register_function_action('claims.administration','view','company','claims.view','app.module_action_delegation_allowed','{"moduleKey":"claims","labelKey":"claims.title","kind":"native_acl","course":"administrative","employeeBearing":true}'::jsonb);
 PERFORM app.register_function_action('claims.administration','delete','company','claims.delete','app.module_action_delegation_allowed','{}'::jsonb);
 PERFORM app.register_function_action('claimsConfig.reimbursements','view','company','claims.view','app.module_action_delegation_allowed','{"moduleKey":"claims","labelKey":"admin.claimsTabs.reimbursements","kind":"submenu","course":"administrative","screenKey":"claimsConfig","href":"/admin/claims/reimbursements","employeeBearing":true}'::jsonb);
 PERFORM app.register_function_action('claimsConfig.reimbursements','execute','company','claims.edit','app.module_action_delegation_allowed','{}'::jsonb);
END $$;
--> statement-breakpoint
CREATE FUNCTION app.claim_cancel_native(p_claim uuid,p_expected_employment uuid DEFAULT NULL) RETURNS TABLE(event_id uuid,employment_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE selected public.claim_request%ROWTYPE;person_id uuid;company_id uuid;own_course boolean;after_row jsonb;audit uuid;
BEGIN
 PERFORM app.access_workforce_write_lock();
 IF NOT app.principal_snapshot_current() THEN RAISE EXCEPTION 'Claim cancellation unavailable' USING ERRCODE='42501';END IF;
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
 UPDATE public.claim_request q SET status='cancelled' WHERE q.id=selected.id AND q.tenant_id=selected.tenant_id RETURNING to_jsonb(q) INTO after_row;
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id)
 VALUES(selected.tenant_id,'claim-request',selected.id,'claim-request.cancelled','user',app.current_user_id(),selected.employment_id) RETURNING id INTO audit;
 DELETE FROM app.module_claim_effect WHERE xact_id<pg_snapshot_xmin(pg_current_snapshot());
 INSERT INTO app.module_claim_effect VALUES(pg_current_xact_id(),selected.tenant_id,app.current_user_id(),selected.id,CASE WHEN own_course THEN 'own_cancel' ELSE 'admin_cancel' END,
  encode(sha256(convert_to(to_jsonb(selected)::text,'UTF8')),'hex'),encode(sha256(convert_to(after_row::text,'UTF8')),'hex'),audit);
 RETURN QUERY SELECT audit,selected.employment_id;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.claim_cancel_native(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_cancel_native(uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.claim_reimburse_native(p_claims uuid[],p_reference text DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE selected public.claim_request%ROWTYPE;company_id uuid;after_row jsonb;audit uuid;paid integer:=0;
 at_time timestamptz:=statement_timestamp();reference text:=coalesce(p_reference,'reimbursement');
BEGIN
 PERFORM app.access_workforce_write_lock();
 IF NOT app.principal_snapshot_current() OR p_claims IS NULL OR cardinality(p_claims)>10000 OR length(reference)>4000 THEN RAISE EXCEPTION 'Claim reimbursement unavailable' USING ERRCODE='42501';END IF;
 DELETE FROM app.module_claim_effect WHERE xact_id<pg_snapshot_xmin(pg_current_snapshot());
 FOR selected IN SELECT q.* FROM public.claim_request q WHERE q.id=ANY(p_claims) AND q.tenant_id=app.current_tenant_id() AND q.status::text='approved' AND NOT q.taxable ORDER BY q.id FOR UPDATE LOOP
  SELECT e.company_id INTO company_id FROM public.employment e WHERE e.id=selected.employment_id AND e.tenant_id=selected.tenant_id AND e.voided_at IS NULL;
  IF company_id IS NULL OR NOT app.can_admin_employment(selected.employment_id) OR NOT app.module_action_allowed('claims','edit',company_id)
   OR NOT app.function_action_allowed('claimsConfig.reimbursements','execute',company_id) THEN RAISE EXCEPTION 'Claim reimbursement unavailable' USING ERRCODE='42501';END IF;
  UPDATE public.claim_request q SET status='paid',paid_at=at_time,payout_ref=reference WHERE q.id=selected.id AND q.tenant_id=selected.tenant_id RETURNING to_jsonb(q) INTO after_row;
  INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload)
  VALUES(selected.tenant_id,'claim-request',selected.id,'claim-request.paid','user',app.current_user_id(),selected.employment_id,jsonb_build_object('via','reimbursement','payoutRef',reference)) RETURNING id INTO audit;
  INSERT INTO app.module_claim_effect VALUES(pg_current_xact_id(),selected.tenant_id,app.current_user_id(),selected.id,'reimbursement',
   encode(sha256(convert_to(to_jsonb(selected)::text,'UTF8')),'hex'),encode(sha256(convert_to(after_row::text,'UTF8')),'hex'),audit);
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
    jsonb_build_object('moduleKey','claims','labelKey','claims.title','kind','native_acl','course','own','employeeBearing',false));
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
 SELECT app.claim_subject_is_own(p_subject) AND p_key IN ('claims.own','claims.own.drafts','claims.own.submit')
 AND EXISTS(SELECT 1 FROM public.employment employment WHERE employment.id=p_subject AND employment.tenant_id=app.current_tenant_id() AND employment.voided_at IS NULL AND app.function_action_allowed('claims.own','view',employment.company_id) AND app.function_action_allowed(p_key,p_operation,employment.company_id));
$$;
REVOKE ALL ON FUNCTION app.claim_own_source_allowed(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_own_source_allowed(uuid,text,text) TO ai_hr_app;
--> statement-breakpoint
CREATE TABLE app.claim_draft_delete_effect(xact_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,claim_id uuid NOT NULL,before_source jsonb NOT NULL,event_id uuid,completed boolean NOT NULL DEFAULT false,PRIMARY KEY(xact_id,tenant_id,user_id,claim_id));
REVOKE ALL ON app.claim_draft_delete_effect FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.claim_draft_delete_native(p_claim uuid,p_expected_employment uuid DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source public.claim_request%ROWTYPE;event uuid;
BEGIN
 PERFORM app.access_workforce_write_lock();
 SELECT * INTO source FROM public.claim_request WHERE id=p_claim AND tenant_id=app.current_tenant_id() AND app.claim_own_source_allowed(employment_id,'claims.own.drafts','view') FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Claim not found';END IF;
 IF p_expected_employment IS NOT NULL AND source.employment_id<>p_expected_employment THEN RAISE EXCEPTION 'Draft does not belong to the selected employment';END IF;
 IF source.status<>'draft' THEN RAISE EXCEPTION 'Only a draft claim can be deleted';END IF;
 IF NOT app.claim_own_source_allowed(source.employment_id,'claims.own.drafts','delete') THEN RAISE EXCEPTION 'Claim draft delete unavailable' USING ERRCODE='42501';END IF;
 DELETE FROM app.claim_draft_delete_effect WHERE xact_id<pg_snapshot_xmin(pg_current_snapshot());
 INSERT INTO app.claim_draft_delete_effect(xact_id,tenant_id,user_id,claim_id,before_source) VALUES(pg_current_xact_id(),source.tenant_id,app.current_user_id(),source.id,to_jsonb(source));
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
 -- Native nonself submission/decision courses retain their current owner until their exact chapter.
 IF NOT app.claim_subject_is_own(subject) AND (TG_OP='INSERT' AND NEW.status='draft' OR TG_OP<>'INSERT' AND OLD.status='draft') THEN RAISE EXCEPTION 'Only the claimant can edit or submit their own draft claim' USING ERRCODE='42501';END IF;
 IF NOT app.claim_subject_is_own(subject) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 IF TG_OP='DELETE' AND OLD.status='draft' THEN
  IF NOT app.claim_draft_delete_approved(OLD.id,prior,TG_WHEN='AFTER') THEN RAISE EXCEPTION 'Claim draft deletion source unavailable' USING ERRCODE='42501';END IF;RETURN OLD;
 ELSIF TG_OP='INSERT' AND NEW.status IN ('draft','pending') THEN
  IF NEW.decided_at IS NOT NULL OR NEW.decided_by_employment_id IS NOT NULL OR NEW.payroll_batch_id IS NOT NULL OR NEW.paid_at IS NOT NULL OR NEW.payout_ref IS NOT NULL THEN RAISE EXCEPTION 'Claim creation stamps unavailable' USING ERRCODE='42501';END IF;
  key:=CASE WHEN NEW.status='draft' THEN 'claims.own.drafts' ELSE 'claims.own.submit' END;operation:=CASE WHEN NEW.status='draft' THEN 'add' ELSE 'execute' END;
 ELSIF TG_OP='UPDATE' AND OLD.status='draft' AND NEW.status IN ('draft','pending') THEN
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
CREATE POLICY claim_own_action_read ON public.claim_request AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(app.claim_own_read_allowed(employment_id,status='draft'));

--> statement-breakpoint
CREATE FUNCTION app.claim_draft_delete_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT app.claim_draft_delete_approved(NEW.claim_id,NEW.before_source,true) THEN RAISE EXCEPTION 'Claim draft delete effects incomplete' USING ERRCODE='42501';END IF;RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.claim_draft_delete_complete() FROM PUBLIC,ai_hr_app;
CREATE CONSTRAINT TRIGGER claim_draft_delete_complete AFTER INSERT ON app.claim_draft_delete_effect DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.claim_draft_delete_complete();
--> statement-breakpoint
CREATE TRIGGER module_claim_write_lock BEFORE INSERT OR UPDATE OR DELETE ON public.claim_request FOR EACH STATEMENT EXECUTE FUNCTION app.module_configuration_write_lock();

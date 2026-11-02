-- Explicit administrative action ceilings. Native recipient, task and projection owners remain
-- independent; these capabilities never replace their existing record/company/function authority.
INSERT INTO access_capability(id,scope,supported,bindings)
 SELECT domain||'.'||operation,scope,false,'[]'::jsonb
 FROM(VALUES('lifecycle','company'),('rewards','company'),('notices','company'),
 ('lifecycle_configuration','tenant'),('rewards_configuration','tenant'),('notices_global','tenant'))d(domain,scope)
 CROSS JOIN(VALUES('view'),('add'),('edit'),('delete'))o(operation);
--> statement-breakpoint
CREATE FUNCTION app.lifecycle_reward_notice_action(p_domain text,p_action text,p_company uuid DEFAULT NULL)RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE capability public.access_capability;
BEGIN
 IF p_domain NOT IN ('lifecycle','rewards','notices','lifecycle_configuration','rewards_configuration','notices_global') OR p_action NOT IN ('view','add','edit','delete') THEN RETURN false;END IF;
 IF app.access_workforce_storage_owner() THEN RETURN true;END IF;
 SELECT * INTO capability FROM public.access_capability WHERE id=p_domain||'.'||p_action;
 IF capability.id IS NULL OR NOT app.principal_snapshot_current() THEN RETURN false;END IF;
 IF capability.scope='tenant' AND p_company IS NOT NULL OR capability.scope='company' AND p_company IS NULL THEN RETURN false;END IF;
 IF p_company IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.company c WHERE c.id=p_company AND c.tenant_id=app.current_tenant_id())THEN RETURN false;END IF;
 -- Dormant definitions preserve installed native behavior until the restricted publisher verifies
 -- every owned function and exact binding. Runtime users cannot publish or alter these definitions.
 RETURN NOT capability.supported OR app.access_allowed_for(app.current_user_id(),capability.id,p_company);
END $$;
REVOKE ALL ON FUNCTION app.lifecycle_reward_notice_action(text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lifecycle_reward_notice_action(text,text,uuid) TO ai_hr_app;
--> statement-breakpoint
-- Reward entries are finite assigned-review records, not a general Personnel projection. Their
-- original permissive policy already requires an actual currently eligible membership of THIS unit.
-- Preserve that course under a data profile; ordinary administrators gain no new entry visibility.
ALTER POLICY data_permission_subject_read ON reward_entry USING(app.principal_snapshot_current() AND (app.data_permission_record_read(employment_id) OR EXISTS(SELECT 1 FROM app.reward_roles(unit_id))));
--> statement-breakpoint
-- Committed membership/configuration changes invalidate pre-pinned native read snapshots too.
-- These are authority records; an assigned-work decision may not replay a revoked old membership.
DO $$ DECLARE owned_table text; BEGIN
 FOREACH owned_table IN ARRAY ARRAY['reward_member','lc_staff','lc_onboarding_config','lc_v9_config','lc_onboarding_case']LOOP
  EXECUTE format('CREATE TRIGGER action_authority_generation_insert AFTER INSERT ON public.%I REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('''')',owned_table);
  EXECUTE format('CREATE TRIGGER action_authority_generation_update AFTER UPDATE ON public.%I REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('''')',owned_table);
  EXECUTE format('CREATE TRIGGER action_authority_generation_delete AFTER DELETE ON public.%I REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('''')',owned_table);
 END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.notice_owner_action_allowed(p_company uuid,p_action text)RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND CASE WHEN p_company IS NULL THEN app.is_group_admin()
  AND app.lifecycle_reward_notice_action('notices_global',p_action,NULL) AND app.function_action_allowed('noticeBoard.global',p_action,NULL)
  AND NOT EXISTS(SELECT 1 FROM public.company c WHERE c.tenant_id=app.current_tenant_id() AND (NOT app.lifecycle_reward_notice_action('notices',p_action,c.id) OR NOT app.function_action_allowed('noticeBoard',p_action,c.id)))
 ELSE app.is_admin_for(p_company) AND app.lifecycle_reward_notice_action('notices',p_action,p_company) AND app.function_action_allowed('noticeBoard',p_action,p_company)END;
$$;
REVOKE ALL ON FUNCTION app.notice_owner_action_allowed(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.notice_owner_action_allowed(uuid,text) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.notice_action_allowed(p_notice uuid,p_action text)RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.notice n WHERE n.id=p_notice AND n.tenant_id=app.current_tenant_id()
 AND app.notice_owner_action_allowed(n.owner_company_id,CASE WHEN p_action IN ('publish','attach') THEN
  CASE WHEN n.published_at IS NULL AND n.archived_at IS NULL AND n.created_by_user_id=app.current_user_id() AND app.notice_owner_action_allowed(n.owner_company_id,'add') THEN 'add' ELSE 'edit' END ELSE p_action END));
$$;
REVOKE ALL ON FUNCTION app.notice_action_allowed(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.notice_action_allowed(uuid,text) TO ai_hr_app;
--> statement-breakpoint
-- Keep recipient membership reads and version-bound acknowledgements independent of authoring.
ALTER POLICY notice_admin_rls ON notice USING(tenant_id=app.current_tenant_id() AND app.notice_owner_action_allowed(owner_company_id,'view'));
ALTER POLICY notice_revision_author_read ON notice_revision USING(tenant_id=app.current_tenant_id() AND app.notice_action_allowed(notice_id,'view'));
ALTER POLICY notice_attachment_author ON notice_attachment USING(tenant_id=app.current_tenant_id() AND app.notice_action_allowed(notice_id,'view'));
ALTER POLICY notice_acknowledgement_read ON notice_acknowledgement USING(tenant_id=app.current_tenant_id() AND app.principal_snapshot_current()
 AND(app.notice_action_allowed(notice_id,'view') OR EXISTS(SELECT 1 FROM public.employment e WHERE e.id=employment_id AND e.tenant_id=notice_acknowledgement.tenant_id AND app.is_self_person(e.person_id))));
--> statement-breakpoint
CREATE FUNCTION app.notice_action_statement_lock()RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN IF NOT app.access_workforce_storage_owner()THEN PERFORM app.access_workforce_write_lock();END IF;RETURN NULL;END $$;
REVOKE ALL ON FUNCTION app.notice_action_statement_lock() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER notice_action_lock BEFORE INSERT OR UPDATE OR DELETE ON notice FOR EACH STATEMENT EXECUTE FUNCTION app.notice_action_statement_lock();
CREATE TRIGGER notice_attachment_action_lock BEFORE INSERT ON notice_attachment FOR EACH STATEMENT EXECUTE FUNCTION app.notice_action_statement_lock();
--> statement-breakpoint
CREATE FUNCTION app.notice_action_write_guard()RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE before_row jsonb:=CASE WHEN TG_OP='INSERT'THEN '{}'::jsonb ELSE to_jsonb(OLD)END;after_row jsonb:=CASE WHEN TG_OP='DELETE'THEN '{}'::jsonb ELSE to_jsonb(NEW)END;data jsonb:=CASE WHEN TG_OP='DELETE'THEN before_row ELSE after_row END;operation text;creation boolean;old_ids jsonb;new_ids jsonb;
BEGIN
 IF app.access_workforce_storage_owner()THEN IF TG_OP='DELETE'THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 IF TG_TABLE_NAME='notice_attachment' THEN
  IF NOT app.notice_action_allowed(NEW.notice_id,'attach')THEN RAISE EXCEPTION 'Notice attachment action unavailable' USING ERRCODE='42501';END IF;RETURN NEW;
 END IF;
 IF TG_OP='INSERT' THEN
  operation:='add';
  IF NEW.created_by_user_id IS DISTINCT FROM app.current_user_id() OR NEW.published_at IS NOT NULL OR NEW.archived_at IS NOT NULL THEN RAISE EXCEPTION 'New notices must start as owned drafts' USING ERRCODE='42501';END IF;
 ELSIF TG_OP='DELETE' THEN operation:='delete';
 ELSE
  IF NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id THEN RAISE EXCEPTION 'Notice creation identity is immutable' USING ERRCODE='42501';END IF;
  operation:='edit';creation:=OLD.published_at IS NULL AND OLD.archived_at IS NULL AND OLD.created_by_user_id=app.current_user_id() AND app.notice_owner_action_allowed(OLD.owner_company_id,'add');
  -- Completing the creator's unpublished Add course does not authorize editing an existing body,
  -- audience or window. Only fixed publication metadata or appended owned attachments may move.
  IF creation AND OLD.published_at IS NULL AND NEW.published_at IS NOT NULL AND
   (after_row-ARRAY['published_at','published_by_user_id','updated_at'])=(before_row-ARRAY['published_at','published_by_user_id','updated_at'])THEN operation:='add';
  ELSIF creation AND NEW.published_at IS NULL AND
   (after_row-ARRAY['attachment_ids','content_version','material_hash','updated_at'])=(before_row-ARRAY['attachment_ids','content_version','material_hash','updated_at'])THEN
   old_ids:=to_jsonb(OLD.attachment_ids);new_ids:=to_jsonb(NEW.attachment_ids);
   IF jsonb_array_length(new_ids)>=jsonb_array_length(old_ids) AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(old_ids)WITH ORDINALITY original(id,n)WHERE original.id IS DISTINCT FROM new_ids->(original.n::integer-1))
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(new_ids)wanted(id)WHERE NOT EXISTS(SELECT 1 FROM public.notice_attachment a WHERE a.id=wanted.id::uuid AND a.notice_id=OLD.id AND a.tenant_id=OLD.tenant_id AND(a.created_by_user_id=app.current_user_id() OR OLD.attachment_ids@>ARRAY[a.id])))THEN operation:='add';END IF;
  END IF;
  IF OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL THEN
   IF NOT app.notice_owner_action_allowed(OLD.owner_company_id,'delete')THEN RAISE EXCEPTION 'Notice archive action unavailable' USING ERRCODE='42501';END IF;
   operation:=CASE WHEN(after_row-ARRAY['archived_at','archived_by_user_id','updated_at'])=(before_row-ARRAY['archived_at','archived_by_user_id','updated_at'])THEN'delete' ELSE'edit'END;
  END IF;
 END IF;
 IF NOT app.notice_owner_action_allowed((data->>'owner_company_id')::uuid,operation)THEN RAISE EXCEPTION 'Notice action unavailable' USING ERRCODE='42501';END IF;
 IF TG_OP='DELETE'THEN RETURN OLD;ELSE RETURN NEW;END IF;
END $$;
REVOKE ALL ON FUNCTION app.notice_action_write_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER notice_action_write BEFORE INSERT OR UPDATE OR DELETE ON notice FOR EACH ROW EXECUTE FUNCTION app.notice_action_write_guard();
CREATE TRIGGER notice_attachment_action_write BEFORE INSERT ON notice_attachment FOR EACH ROW EXECUTE FUNCTION app.notice_action_write_guard();
--> statement-breakpoint
DROP POLICY notice_recipient_admin_rls ON notice_recipient;
CREATE POLICY notice_recipient_admin_read ON notice_recipient FOR SELECT
 USING(tenant_id=app.current_tenant_id() AND app.notice_action_allowed(notice_id,'view'));
CREATE POLICY notice_recipient_admin_publish ON notice_recipient FOR INSERT
 WITH CHECK(tenant_id=app.current_tenant_id() AND app.notice_action_allowed(notice_id,'publish'));
CREATE POLICY notice_recipient_admin_update ON notice_recipient FOR UPDATE
 USING(tenant_id=app.current_tenant_id() AND app.notice_action_allowed(notice_id,'view'))
 WITH CHECK(tenant_id=app.current_tenant_id() AND app.notice_action_allowed(notice_id,'edit'));
--> statement-breakpoint
-- Keep the original finite recipient sender projection and immutable audit semantics. Only its
-- administrative branch gains a View ceiling; an actual live recipient retains sender metadata.
DO $$ DECLARE body text;BEGIN
 body:=pg_get_functiondef('app.notice_sender_display_name(uuid)'::regprocedure);
 IF strpos(body,'app.can_manage_notice(n.id) OR')=0 THEN RAISE EXCEPTION 'Notice sender owner changed; review action binding';END IF;
 EXECUTE replace(body,'app.can_manage_notice(n.id) OR','app.notice_action_allowed(n.id,''view'') OR');
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.notice_event_readable(p_notice uuid,p_payload jsonb)RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE parent_tenant uuid;owner_company uuid;encoded text;
BEGIN
 IF NOT app.principal_snapshot_current()THEN RETURN false;END IF;
 SELECT n.tenant_id,n.owner_company_id INTO parent_tenant,owner_company FROM public.notice n WHERE n.id=p_notice;
 IF FOUND THEN RETURN parent_tenant=app.current_tenant_id() AND app.notice_owner_action_allowed(owner_company,'view');END IF;
 IF p_payload?'companyId' THEN
  IF p_payload->'companyId'='null'::jsonb THEN RETURN app.notice_owner_action_allowed(NULL,'view');END IF;
  encoded:=p_payload->>'companyId';
  IF encoded~*'^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'THEN RETURN app.notice_owner_action_allowed(encoded::uuid,'view');END IF;
  RETURN false;
 END IF;
 RETURN app.notice_owner_action_allowed(NULL,'view');
END $$;
--> statement-breakpoint
INSERT INTO app.access_default_capability_grant(legacy_key,capability_id)
 SELECT 'hr_admin',domain||'.'||operation FROM unnest(ARRAY['lifecycle','rewards','notices','lifecycle_configuration','rewards_configuration']) domain CROSS JOIN unnest(ARRAY['view','add','edit','delete']) operation;
--> statement-breakpoint
CREATE FUNCTION app.lifecycle_reward_notice_legacy_allowed(t uuid,u uuid,cap text,co uuid)RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE domain text:=split_part(cap,'.',1);operation text:=split_part(cap,'.',2);administrator boolean;global_admin boolean;
BEGIN
 IF domain NOT IN('lifecycle','rewards','notices','lifecycle_configuration','rewards_configuration','notices_global') OR operation NOT IN('view','add','edit','delete') OR cap<>domain||'.'||operation THEN RETURN false;END IF;
 IF NOT EXISTS(SELECT 1 FROM public.app_user a WHERE a.id=u AND a.tenant_id=t AND a.archived_at IS NULL AND NOT app.login_blocked(a.id))THEN RETURN false;END IF;
 IF co IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.company c WHERE c.id=co AND c.tenant_id=t)THEN RETURN false;END IF;
 SELECT EXISTS(SELECT 1 FROM public.role_assignment r WHERE r.tenant_id=t AND r.app_user_id=u AND r.role::text IN('hr_admin','super_admin') AND(co IS NULL OR app.access_scope_covers(r.company_id,co,t))),
 EXISTS(SELECT 1 FROM public.role_assignment r WHERE r.tenant_id=t AND r.app_user_id=u AND r.role::text IN('hr_admin','super_admin') AND r.company_id IS NULL) INTO administrator,global_admin;
 IF domain='notices_global'THEN RETURN co IS NULL AND global_admin;END IF;
 IF domain IN('lifecycle_configuration','rewards_configuration')THEN
  IF co IS NOT NULL THEN RETURN false;END IF;
  RETURN administrator OR domain='lifecycle_configuration' AND EXISTS(SELECT 1 FROM public.lc_staff s WHERE s.tenant_id=t AND s.user_id=u AND (operation='view' OR s.level='manager'));
 END IF;
 IF co IS NULL THEN RETURN global_admin;END IF;
 IF administrator THEN RETURN true;END IF;
 IF domain='lifecycle'THEN
  RETURN EXISTS(SELECT 1 FROM public.lc_staff s WHERE s.tenant_id=t AND s.user_id=u AND(s.company_id IS NULL OR app.access_scope_covers(s.company_id,co,t)))
   OR EXISTS(SELECT 1 FROM public.lc_onboarding_config c WHERE c.tenant_id=t AND(co IS NOT NULL) AND(c.data->'access'->'onboarding')?u::text);
 END IF;
 RETURN false;
END $$;
CREATE FUNCTION app.lifecycle_reward_notice_delegation_allowed(t uuid,u uuid,cap text,co uuid)RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.lifecycle_reward_notice_legacy_allowed(t,u,cap,co)
 AND CASE WHEN cap LIKE 'lifecycle_configuration.%' OR cap LIKE 'rewards_configuration.%' OR cap LIKE 'notices_global.%'
 THEN EXISTS(SELECT 1 FROM public.role_assignment r WHERE r.tenant_id=t AND r.app_user_id=u AND r.role::text IN('hr_admin','super_admin') AND r.company_id IS NULL)
 ELSE EXISTS(SELECT 1 FROM public.role_assignment r WHERE r.tenant_id=t AND r.app_user_id=u AND r.role::text IN('hr_admin','super_admin') AND app.access_scope_covers(r.company_id,co,t))END;
$$;
REVOKE ALL ON FUNCTION app.lifecycle_reward_notice_legacy_allowed(uuid,uuid,text,uuid),app.lifecycle_reward_notice_delegation_allowed(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- A context is entered ONLY after a canonical command's unchanged native admission checks.
-- Its exact physical effects are captured while that command executes, and closed before return.
-- Runtime callers can neither enter a context nor insert/rewrite its receipts.
CREATE TABLE app.lifecycle_native_effect_context(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),xact_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,
 purpose text NOT NULL,case_id uuid NOT NULL,event_type text NOT NULL,active boolean NOT NULL DEFAULT true,completed boolean NOT NULL DEFAULT false
);
CREATE TABLE app.lifecycle_native_effect_receipt(
 context_id uuid NOT NULL REFERENCES app.lifecycle_native_effect_context(id) ON DELETE CASCADE,
 table_name text NOT NULL,row_id text NOT NULL,before_hash text NOT NULL,after_hash text NOT NULL,
 PRIMARY KEY(context_id,table_name,row_id,before_hash,after_hash)
);
ALTER TABLE app.lifecycle_native_effect_context ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.lifecycle_native_effect_receipt ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.lifecycle_native_effect_context,app.lifecycle_native_effect_receipt FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.lifecycle_assigned_task_function(p_case uuid,p_purpose text,p_operation text)RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN p_purpose='assigned-task' THEN EXISTS(SELECT 1 FROM public.lc_v9_case c WHERE c.id=p_case AND c.tenant_id=app.current_tenant_id() AND app.function_action_allowed('lifecycle.shared.tasks',p_operation,c.company_id))
 WHEN p_purpose IN('assigned-onboarding-task','assigned-onboarding-handover','assigned-onboarding-note','own-onboarding-ack') THEN EXISTS(SELECT 1 FROM public.lc_onboarding_case c WHERE c.id=p_case AND c.tenant_id=app.current_tenant_id() AND app.function_action_allowed(CASE p_purpose WHEN 'assigned-onboarding-task' THEN 'lifecycle.shared.tasks' WHEN 'assigned-onboarding-handover' THEN 'lifecycle.shared.handover' WHEN 'assigned-onboarding-note' THEN 'lifecycle.shared.requisitionNotes' ELSE 'lifecycle.self.acknowledgement' END,p_operation,c.company_id))ELSE false END;
$$;
REVOKE ALL ON FUNCTION app.lifecycle_assigned_task_function(uuid,text,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.lifecycle_native_effect_begin(p_purpose text,p_case uuid,p_event text)RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result uuid;
BEGIN
 IF NOT app.principal_snapshot_current() OR app.current_user_id() IS NULL OR p_case IS NULL
  OR p_purpose NOT IN('own-daa','own-document','assigned-task','own-return-report','assigned-item','own-equipment-receipt','assigned-onboarding-task','assigned-onboarding-handover','assigned-onboarding-note','own-onboarding-ack')
  OR p_event NOT IN('lifecycle-case.daa-submitted','lifecycle-v9.employeeDocumentSigned','lifecycle-v9.employeeDocumentSaved','lifecycle-v9.assignedTaskUpdated','lifecycle-v9.returnReported','lifecycle-v9.providingTeamItemUpdated','lifecycle-v9.equipmentReceipt','onboarding.task','onboarding.handover','onboarding.readNote','onboarding.acknowledge')
  OR EXISTS(SELECT 1 FROM app.lifecycle_native_effect_context c WHERE c.xact_id=pg_current_xact_id() AND c.tenant_id=app.current_tenant_id() AND c.user_id=app.current_user_id() AND c.active)
 THEN RAISE EXCEPTION 'Invalid native Lifecycle effect context' USING ERRCODE='42501';END IF;
 IF p_purpose IN('assigned-task','assigned-onboarding-task','assigned-onboarding-handover','assigned-onboarding-note','own-onboarding-ack') AND NOT app.lifecycle_assigned_task_function(p_case,p_purpose,'execute')THEN RAISE EXCEPTION 'Assigned task function unavailable' USING ERRCODE='42501';END IF;
 INSERT INTO app.lifecycle_native_effect_context(xact_id,tenant_id,user_id,purpose,case_id,event_type)
 VALUES(pg_current_xact_id(),app.current_tenant_id(),app.current_user_id(),p_purpose,p_case,p_event)RETURNING id INTO result;
 RETURN result;
END $$;
CREATE FUNCTION app.lifecycle_native_effect_complete(p_context uuid)RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 UPDATE app.lifecycle_native_effect_context c SET active=false,completed=true WHERE c.id=p_context AND c.xact_id=pg_current_xact_id() AND c.tenant_id=app.current_tenant_id() AND c.user_id=app.current_user_id() AND c.active;
 IF NOT FOUND THEN RAISE EXCEPTION 'Native Lifecycle effect context changed' USING ERRCODE='42501';END IF;
END $$;
REVOKE ALL ON FUNCTION app.lifecycle_native_effect_begin(text,uuid,text),app.lifecycle_native_effect_complete(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.lifecycle_native_effect_capture()RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE before_row jsonb:=CASE WHEN TG_OP='INSERT'THEN '{}'::jsonb ELSE to_jsonb(OLD)END;
 after_row jsonb:=CASE WHEN TG_OP='DELETE'THEN '{}'::jsonb ELSE to_jsonb(NEW)END;
 data jsonb:=CASE WHEN TG_OP='DELETE'THEN before_row ELSE after_row END;subject uuid;identity text;context_id uuid;
BEGIN
 subject:=CASE WHEN TG_TABLE_NAME IN('lc_case','lc_v9_case','lc_onboarding_case')THEN(data->>'id')::uuid
  WHEN TG_TABLE_NAME='lc_history' AND data->>'ref_type'='case'THEN(data->>'ref_id')::uuid
  ELSE(data->>'case_id')::uuid END;
 IF subject IS NULL THEN RETURN NULL;END IF;
 SELECT c.id INTO context_id FROM app.lifecycle_native_effect_context c WHERE c.xact_id=pg_current_xact_id() AND c.tenant_id=(data->>'tenant_id')::uuid
  AND c.tenant_id=app.current_tenant_id() AND c.user_id=app.current_user_id() AND c.active AND c.case_id=subject;
 IF context_id IS NULL THEN RETURN NULL;END IF;
 identity:=coalesce(data->>'id',data->>'case_id'||':'||coalesce(data->>'revision',data->>'step_key',''));
 INSERT INTO app.lifecycle_native_effect_receipt(context_id,table_name,row_id,before_hash,after_hash)
 VALUES(context_id,TG_TABLE_NAME,identity,encode(sha256(convert_to(before_row::text,'UTF8')),'hex'),encode(sha256(convert_to(after_row::text,'UTF8')),'hex'))ON CONFLICT DO NOTHING;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.lifecycle_native_effect_capture() FROM PUBLIC,ai_hr_app;
DO $$ DECLARE owned_table text;BEGIN
 FOREACH owned_table IN ARRAY ARRAY['lc_case','lc_case_step','lc_history','lc_v9_case','lc_v9_case_revision','lc_onboarding_case','lc_onboarding_private','lc_onboarding_case_revision','lc_onboarding_private_revision']LOOP
  EXECUTE format('CREATE TRIGGER lifecycle_native_effect_capture AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.lifecycle_native_effect_capture()',owned_table);
 END LOOP;
END $$;
--> statement-breakpoint
-- Tuple xmin is a subtransaction ID after SAVEPOINT; it is not a top-level transaction witness.
-- Private physical INSERT/UPDATE receipts retain the actual topxid and exact resulting row hash.
CREATE TABLE app.lifecycle_row_transaction_receipt(
 xact_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,table_name text NOT NULL,row_id uuid NOT NULL,row_hash text NOT NULL,
 PRIMARY KEY(xact_id,tenant_id,user_id,table_name,row_id,row_hash)
);
ALTER TABLE app.lifecycle_row_transaction_receipt ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.lifecycle_row_transaction_receipt FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.lifecycle_row_transaction_capture()RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.current_user_id() IS NULL THEN RETURN NULL;END IF;
 DELETE FROM app.lifecycle_row_transaction_receipt WHERE xact_id<pg_snapshot_xmin(pg_current_snapshot());
 INSERT INTO app.lifecycle_row_transaction_receipt VALUES(pg_current_xact_id(),NEW.tenant_id,app.current_user_id(),TG_TABLE_NAME,NEW.id,encode(sha256(convert_to(to_jsonb(NEW)::text,'UTF8')),'hex'))ON CONFLICT DO NOTHING;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.lifecycle_row_transaction_capture() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER lifecycle_row_transaction_capture AFTER INSERT ON public.domain_event FOR EACH ROW EXECUTE FUNCTION app.lifecycle_row_transaction_capture();
CREATE TRIGGER lifecycle_row_transaction_capture AFTER INSERT OR UPDATE ON public.it_asset_request FOR EACH ROW EXECUTE FUNCTION app.lifecycle_row_transaction_capture();
CREATE FUNCTION app.lifecycle_row_in_transaction(p_table text,p_id uuid,p_row jsonb)RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app.lifecycle_row_transaction_receipt r WHERE r.xact_id=pg_current_xact_id() AND r.tenant_id=app.current_tenant_id() AND r.user_id=app.current_user_id()
 AND r.table_name=p_table AND r.row_id=p_id AND r.row_hash=encode(sha256(convert_to(p_row::text,'UTF8')),'hex'));
$$;
REVOKE ALL ON FUNCTION app.lifecycle_row_in_transaction(text,uuid,jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.lifecycle_native_effect_approved(p_table text,p_before jsonb,p_after jsonb)RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND EXISTS(SELECT 1 FROM app.lifecycle_native_effect_context c JOIN app.lifecycle_native_effect_receipt r ON r.context_id=c.id
 WHERE c.xact_id=pg_current_xact_id() AND c.tenant_id=app.current_tenant_id() AND c.user_id=app.current_user_id() AND c.completed AND NOT c.active
 AND (c.purpose NOT IN('assigned-task','assigned-onboarding-task','assigned-onboarding-handover','assigned-onboarding-note','own-onboarding-ack') OR app.lifecycle_assigned_task_function(c.case_id,c.purpose,'execute'))
 AND r.table_name=p_table AND r.before_hash=encode(sha256(convert_to(coalesce(p_before,'{}'::jsonb)::text,'UTF8')),'hex') AND r.after_hash=encode(sha256(convert_to(coalesce(p_after,'{}'::jsonb)::text,'UTF8')),'hex')
 AND EXISTS(SELECT 1 FROM public.domain_event e WHERE e.tenant_id=c.tenant_id AND e.aggregate_id=c.case_id AND e.event_type=c.event_type AND e.actor_type='user' AND e.actor_id=c.user_id AND app.lifecycle_row_in_transaction('domain_event',e.id,to_jsonb(e))));
$$;
REVOKE ALL ON FUNCTION app.lifecycle_native_effect_approved(text,jsonb,jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.lifecycle_native_effect_cleanup()RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM app.lifecycle_native_effect_context c WHERE c.id=NEW.id)THEN RETURN NULL;END IF;
 IF NOT NEW.completed OR NEW.active OR (NEW.purpose IN('assigned-task','assigned-onboarding-task','assigned-onboarding-handover','assigned-onboarding-note','own-onboarding-ack') AND NOT app.lifecycle_assigned_task_function(NEW.case_id,NEW.purpose,'execute')) OR NOT EXISTS(SELECT 1 FROM public.domain_event e WHERE e.tenant_id=NEW.tenant_id AND e.aggregate_id=NEW.case_id AND e.event_type=NEW.event_type AND e.actor_type='user' AND e.actor_id=NEW.user_id AND app.lifecycle_row_in_transaction('domain_event',e.id,to_jsonb(e)))
 THEN RAISE EXCEPTION 'Native Lifecycle completion requires its actual audit event' USING ERRCODE='42501';END IF;
 DELETE FROM app.lifecycle_native_effect_context WHERE id=NEW.id;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.lifecycle_native_effect_cleanup() FROM PUBLIC,ai_hr_app;
-- Queued AFTER completion, hence after every actual row mutation's deferred action guard.
CREATE CONSTRAINT TRIGGER lifecycle_native_effect_cleanup AFTER UPDATE ON app.lifecycle_native_effect_context DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.lifecycle_native_effect_cleanup();
--> statement-breakpoint
-- These single exact insertion anchors are the unchanged first mutation AFTER all native
-- identity, assignment, state and command-value adjudication. Refuse source drift for review.
DO $install$
DECLARE spec record;body text;mutation_at integer;declaration integer;finish integer;entry text;
BEGIN
 FOR spec IN SELECT * FROM(VALUES
 ('app.lc_my_daa_submit_owner(jsonb,uuid,text,text)','own-daa','v_id','''lifecycle-case.daa-submitted''',E'  UPDATE lc_case SET daa =','  RETURN v_id;'),
 ('app.lc_v9_self_document(uuid,integer,text,jsonb,jsonb)','own-document','c.id','CASE WHEN signing THEN ''lifecycle-v9.employeeDocumentSigned'' ELSE ''lifecycle-v9.employeeDocumentSaved'' END',E' IF is_native THEN\n  INSERT INTO lc_onboarding_case_revision',' RETURN c.employment_id;'),
 ('app.lc_v9_self_task(uuid,integer,text,text,text)','assigned-task','c.id','''lifecycle-v9.assignedTaskUpdated''',' INSERT INTO lc_v9_case_revision',' RETURN c.employment_id;'),
 ('app.lc_v9_report_return(uuid,integer,text,text)','own-return-report','c.id','''lifecycle-v9.returnReported''',' INSERT INTO lc_v9_case_revision',' RETURN c.employment_id;'),
 ('app.lc_v9_fulfil_item(uuid,integer,text,text,text)','assigned-item','c.id','''lifecycle-v9.providingTeamItemUpdated''',' INSERT INTO lc_v9_case_revision',' RETURN c.employment_id;'),
 ('app.onboarding_v9_receipt(uuid,integer,text,text,text)','own-equipment-receipt','c.id','''lifecycle-v9.equipmentReceipt''',' INSERT INTO lc_onboarding_case_revision',' RETURN c.employment_id;')
 )v(signature,purpose,subject,event,first_mutation,final_return)LOOP
  body:=pg_get_functiondef(to_regprocedure(spec.signature));
  IF body IS NULL OR strpos(body,'app.lifecycle_native_effect_begin')>0 THEN RAISE EXCEPTION 'Lifecycle native owner missing or already instrumented: %',spec.signature;END IF;
  declaration:=strpos(body,'DECLARE ');mutation_at:=strpos(body,spec.first_mutation);finish:=strpos(body,E'\n'||spec.final_return);
  IF declaration=0 OR mutation_at=0 OR finish<=mutation_at OR strpos(substr(body,mutation_at+length(spec.first_mutation)),spec.first_mutation)>0 OR strpos(substr(body,finish+length(spec.final_return)+1),E'\n'||spec.final_return)>0
  THEN RAISE EXCEPTION 'Lifecycle native mutation anchor changed: %',spec.signature;END IF;
  -- Insert backwards, preserving the entire original canonical body and all its validation.
  body:=overlay(body placing E'\n PERFORM app.lifecycle_native_effect_complete(action_effect);' from finish for 0);
  entry:=format(' action_effect:=app.lifecycle_native_effect_begin(%L,%s,%s);',spec.purpose,spec.subject,spec.event)||E'\n';
  body:=overlay(body placing entry from mutation_at for 0);
  body:=overlay(body placing 'action_effect uuid; ' from declaration+8 for 0);
  mutation_at:=strpos(body,E'BEGIN\n');
  IF mutation_at=0 THEN RAISE EXCEPTION 'Lifecycle native entry changed: %',spec.signature;END IF;
  body:=overlay(body placing E' PERFORM app.audit_access_order_lock();\n PERFORM app.access_workforce_write_lock();\n' from mutation_at+6 for 0);
  EXECUTE body;
 END LOOP;
END $install$;
--> statement-breakpoint
CREATE FUNCTION app.lifecycle_legacy_row_company(p_table text,p_row jsonb)RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result uuid;
BEGIN
 IF(p_row->>'tenant_id')::uuid IS DISTINCT FROM app.current_tenant_id()THEN RETURN NULL;END IF;
 IF p_table IN('lc_case','it_requisition','it_asset','it_asset_request','lc_company_config','lc_staff')THEN RETURN(p_row->>'company_id')::uuid;END IF;
 IF p_table IN('lc_case_step','lc_comment')THEN SELECT company_id INTO result FROM public.lc_case WHERE id=(p_row->>'case_id')::uuid AND tenant_id=app.current_tenant_id();
 ELSIF p_table='it_requisition_item'THEN SELECT company_id INTO result FROM public.it_requisition WHERE id=(p_row->>'requisition_id')::uuid AND tenant_id=app.current_tenant_id();
 ELSIF p_table='lc_history'THEN
  CASE p_row->>'ref_type'
   WHEN 'case'THEN SELECT company_id INTO result FROM public.lc_case WHERE id=(p_row->>'ref_id')::uuid AND tenant_id=app.current_tenant_id();
   WHEN 'asset'THEN SELECT company_id INTO result FROM public.it_asset WHERE id=(p_row->>'ref_id')::uuid AND tenant_id=app.current_tenant_id();
   WHEN 'requisition'THEN SELECT company_id INTO result FROM public.it_requisition WHERE id=(p_row->>'ref_id')::uuid AND tenant_id=app.current_tenant_id();
   WHEN 'asset_request'THEN SELECT company_id INTO result FROM public.it_asset_request WHERE id=(p_row->>'ref_id')::uuid AND tenant_id=app.current_tenant_id();
   ELSE RETURN NULL;
  END CASE;
 END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.lifecycle_legacy_row_company(text,jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.lifecycle_legacy_action_guard()RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE before_row jsonb:=CASE WHEN TG_OP='INSERT'THEN '{}'::jsonb ELSE to_jsonb(OLD)END;
 after_row jsonb:=CASE WHEN TG_OP='DELETE'THEN '{}'::jsonb ELSE to_jsonb(NEW)END;
 data jsonb:=CASE WHEN TG_OP='DELETE'THEN before_row ELSE after_row END;prior_company uuid;next_company uuid;operation text;domain text;
BEGIN
 IF app.access_workforce_storage_owner()THEN RETURN NULL;END IF;
 IF app.lifecycle_native_effect_approved(TG_TABLE_NAME,before_row,after_row)THEN RETURN NULL;END IF;
 operation:=CASE TG_OP WHEN 'INSERT'THEN'add' WHEN'DELETE'THEN'delete' ELSE'edit'END;
 IF TG_OP='UPDATE' AND((before_row->>'active'='true' AND after_row->>'active'='false')
  OR(before_row->>'status' IS DISTINCT FROM 'cancelled' AND after_row->>'status'='cancelled')
  OR(before_row->>'archived_at' IS NULL AND after_row->>'archived_at' IS NOT NULL))THEN operation:='delete';END IF;
 domain:=CASE WHEN TG_TABLE_NAME IN('lc_step_def','it_provision_def','lc_custom_field','it_asset_catalogue','lc_company_config','lc_staff')THEN'lifecycle_configuration'ELSE'lifecycle'END;
 IF domain='lifecycle_configuration'THEN
  IF NOT app.lifecycle_reward_notice_action(domain,operation,NULL)THEN RAISE EXCEPTION 'Lifecycle configuration action unavailable' USING ERRCODE='42501';END IF;
  RETURN NULL;
 END IF;
 prior_company:=CASE WHEN TG_OP<>'INSERT'THEN app.lifecycle_legacy_row_company(TG_TABLE_NAME,before_row)ELSE NULL END;
 next_company:=CASE WHEN TG_OP<>'DELETE'THEN app.lifecycle_legacy_row_company(TG_TABLE_NAME,after_row)ELSE NULL END;
 -- A checklist/comment is work on an existing case, not an administrative new-case Add.
 IF TG_TABLE_NAME IN('lc_case_step','lc_comment','it_requisition_item') AND TG_OP='INSERT'THEN operation:='edit';END IF;
 IF TG_TABLE_NAME='lc_history'THEN
  operation:=CASE WHEN data->>'action'~'(^|[.])(created|registered|requested)$'THEN'add'
   WHEN data->>'action'~'(^|[.])(cancelled|deleted|archived)$'THEN'delete'ELSE'edit'END;
 END IF;
 IF(TG_OP<>'INSERT' AND(prior_company IS NULL OR NOT app.lifecycle_reward_notice_action(domain,operation,prior_company)))
  OR(TG_OP<>'DELETE' AND(next_company IS NULL OR NOT app.lifecycle_reward_notice_action(domain,operation,next_company)))
 THEN RAISE EXCEPTION 'Lifecycle action unavailable in the current or proposed company' USING ERRCODE='42501';END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.lifecycle_legacy_action_guard() FROM PUBLIC,ai_hr_app;
DO $$ DECLARE owned_table text;BEGIN
 FOREACH owned_table IN ARRAY ARRAY['lc_case','lc_case_step','lc_comment','lc_history','it_requisition','it_requisition_item','it_asset','it_asset_request','lc_step_def','it_provision_def','lc_custom_field','it_asset_catalogue','lc_company_config','lc_staff']LOOP
  EXECUTE format('CREATE CONSTRAINT TRIGGER lifecycle_action_guard AFTER INSERT OR UPDATE OR DELETE ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.lifecycle_legacy_action_guard()',owned_table);
  EXECUTE format('CREATE TRIGGER lifecycle_action_lock BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION app.notice_action_statement_lock()',owned_table);
 END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.lifecycle_own_request_effect(p_before jsonb,p_after jsonb)RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE data jsonb:=CASE WHEN p_after='{}'::jsonb THEN p_before ELSE p_after END;event text;
BEGIN
 IF NOT app.principal_snapshot_current() OR app.current_user_id() IS NULL OR(data->>'tenant_id')::uuid IS DISTINCT FROM app.current_tenant_id()
  OR(data->>'requester_user_id')::uuid IS DISTINCT FROM app.current_user_id() OR p_after='{}'::jsonb THEN RETURN false;END IF;
 IF p_before='{}'::jsonb THEN
  event:='lifecycle-asset-request.created';
  IF data->>'status'<>'requested' OR(data->>'created_at')::timestamptz IS DISTINCT FROM transaction_timestamp() OR length(coalesce(data->>'justification',''))>2000 OR EXISTS(SELECT 1 FROM jsonb_each(data)field WHERE field.key IN('handler_user_id','l1_by','l1_at','l1_action','l2_by','l2_at','l2_action','approval_notes','asset_id','notes','cancel_reason','department','job_title')AND field.value<>'null'::jsonb)
   OR NOT EXISTS(SELECT 1 FROM public.it_asset_catalogue c WHERE c.id=(data->>'catalogue_id')::uuid AND c.tenant_id=app.current_tenant_id() AND c.active AND c.approval_levels=(data->>'approval_levels')::integer)
   OR NOT EXISTS(SELECT 1 FROM public.app_user u JOIN public.person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id JOIN public.employment e ON e.person_id=p.id AND e.tenant_id=p.tenant_id
    WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND e.company_id=(data->>'company_id')::uuid AND data->>'full_name'=p.full_name AND data->>'employee_no' IS NOT DISTINCT FROM e.employee_code)
  THEN RETURN false;END IF;
 ELSE
  event:='lifecycle-asset-request.cancelled';
  IF p_before->>'status' IN('cancelled','rejected','completed','assigned') OR p_after->>'status'<>'cancelled'
   OR(p_before-ARRAY['status','cancel_reason'])IS DISTINCT FROM(p_after-ARRAY['status','cancel_reason'])THEN RETURN false;END IF;
 END IF;
 RETURN EXISTS(SELECT 1 FROM public.domain_event e WHERE e.tenant_id=app.current_tenant_id() AND e.aggregate_id=(data->>'id')::uuid AND e.event_type=event AND e.actor_type='user' AND e.actor_id=app.current_user_id() AND app.lifecycle_row_in_transaction('domain_event',e.id,to_jsonb(e)));
END $$;
REVOKE ALL ON FUNCTION app.lifecycle_own_request_effect(jsonb,jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Finite requester courses are separate from all administrative family/function actions.
DO $$ DECLARE body text;anchor text:=' IF app.lifecycle_native_effect_approved(TG_TABLE_NAME,before_row,after_row)THEN RETURN NULL;END IF;';BEGIN
 body:=pg_get_functiondef('app.lifecycle_legacy_action_guard()'::regprocedure);
 IF strpos(body,anchor)=0 THEN RAISE EXCEPTION 'Lifecycle action guard changed before own-request binding';END IF;
 EXECUTE replace(body,anchor,anchor||E'\n IF TG_TABLE_NAME=''it_asset_request'' AND app.lifecycle_own_request_effect(before_row,after_row)THEN RETURN NULL;END IF;\n IF TG_TABLE_NAME=''lc_history'' AND TG_OP=''INSERT'' AND app.principal_snapshot_current() AND data->>''ref_type''=''asset_request'' AND data->>''action'' IN(''request.created'',''request.cancelled'') AND(data->>''actor_user_id'')::uuid=app.current_user_id() AND EXISTS(SELECT 1 FROM public.it_asset_request q JOIN public.domain_event e ON e.aggregate_id=q.id AND e.tenant_id=q.tenant_id WHERE q.id=(data->>''ref_id'')::uuid AND q.tenant_id=app.current_tenant_id() AND q.requester_user_id=app.current_user_id() AND app.lifecycle_row_in_transaction(''it_asset_request'',q.id,to_jsonb(q)) AND e.actor_type=''user'' AND e.actor_id=app.current_user_id() AND e.event_type=CASE WHEN data->>''action''=''request.created'' THEN ''lifecycle-asset-request.created'' ELSE ''lifecycle-asset-request.cancelled'' END AND app.lifecycle_row_in_transaction(''domain_event'',e.id,to_jsonb(e)))THEN RETURN NULL;END IF;');
END $$;
--> statement-breakpoint
CREATE FUNCTION app.lifecycle_legacy_record_read(p_table text,p_row jsonb)RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND(p_row->>'tenant_id')::uuid=app.current_tenant_id()
 AND(app.lifecycle_reward_notice_action('lifecycle','view',app.lifecycle_legacy_row_company(p_table,p_row))
  OR p_table='it_asset_request' AND(p_row->>'requester_user_id')::uuid=app.current_user_id());
$$;
REVOKE ALL ON FUNCTION app.lifecycle_legacy_record_read(text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lifecycle_legacy_record_read(text,jsonb) TO ai_hr_app;
DO $$ DECLARE owned_table text;BEGIN
 FOREACH owned_table IN ARRAY ARRAY['lc_case','lc_case_step','lc_comment','lc_history','it_requisition','it_requisition_item','it_asset','it_asset_request']LOOP
  EXECUTE format('CREATE POLICY lifecycle_action_read ON public.%I AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(app.lifecycle_legacy_record_read(%L,to_jsonb(%I)))',owned_table,owned_table,owned_table);
 END LOOP;
END $$;
--> statement-breakpoint
-- Minimal dispatch fact, bound to the actual stored assignee. It is not a case directory.
CREATE FUNCTION app.onboarding_assigned_task_identity(p_case uuid,p_task text)RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND EXISTS(SELECT 1 FROM public.lc_onboarding_case c
 JOIN public.app_user u ON u.id=app.current_user_id() AND u.tenant_id=c.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
 WHERE c.id=p_case AND c.tenant_id=app.current_tenant_id() AND app.function_action_allowed('lifecycle.shared.tasks','view',c.company_id) AND EXISTS(SELECT 1 FROM jsonb_array_elements(c.data->'tasks')t WHERE t->>'id'=p_task AND t->>'assignee'=u.id::text));
$$;
REVOKE ALL ON FUNCTION app.onboarding_assigned_task_identity(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onboarding_assigned_task_identity(uuid,text) TO ai_hr_app;
--> statement-breakpoint
-- The live assigned-task mutation port. The former M.setTask production branch now delegates here;
-- only one task's status/completion facts and its native task.status history entry can change.
CREATE FUNCTION app.onboarding_assigned_task_update(p_case uuid,p_revision integer,p_task text,p_status text)
RETURNS TABLE(revision integer,employment_id uuid,company_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c public.lc_onboarding_case;target jsonb;target_index bigint;current_request jsonb;tasks jsonb;entry jsonb;actor_name text;stamp text;effect uuid;
BEGIN
 PERFORM app.audit_access_order_lock();
 PERFORM app.access_workforce_write_lock();
 PERFORM pg_advisory_xact_lock(hashtext('audit-chain:'||app.current_tenant_id()::text));
 PERFORM pg_advisory_xact_lock(hashtextextended(app.current_tenant_id()::text||':onboarding',0));
 IF NOT app.principal_snapshot_current() OR app.current_user_id() IS NULL OR p_revision IS NULL OR p_revision<1 OR p_status IS NULL OR p_status NOT IN('todo','progress','done')THEN RAISE EXCEPTION 'Task not available' USING ERRCODE='42501';END IF;
 SELECT x.* INTO c FROM public.lc_onboarding_case x WHERE x.id=p_case AND x.tenant_id=app.current_tenant_id() FOR UPDATE;
 IF c.id IS NULL OR c.data->>'state'<>'submitted'THEN RAISE EXCEPTION 'Task not available' USING ERRCODE='42501';END IF;
 IF c.revision<>p_revision THEN RAISE EXCEPTION 'This case changed. Reload it before trying again.' USING ERRCODE='40001';END IF;
 SELECT task,n INTO target,target_index FROM jsonb_array_elements(c.data->'tasks')WITH ORDINALITY t(task,n)WHERE task->>'id'=p_task ORDER BY n LIMIT 1;
 IF target IS NULL OR target->>'assignee' IS DISTINCT FROM app.current_user_id()::text THEN RAISE EXCEPTION 'Only the assigned person can update this task' USING ERRCODE='42501';END IF;
 IF p_status='done' AND(nullif(target->>'documentTemplate','') IS NOT NULL OR target->>'by'='joiner' AND coalesce((target->>'gate')::boolean,false))THEN RAISE EXCEPTION 'Complete the linked document or device acknowledgement to finish this task' USING ERRCODE='23514';END IF;
 IF nullif(target->>'opensOn','') IS NOT NULL AND target->>'opensOn'>to_char((now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date,'YYYY-MM-DD')THEN RAISE EXCEPTION 'This task has not opened yet' USING ERRCODE='23514';END IF;
 SELECT r INTO current_request FROM jsonb_array_elements(c.data->'requisitions')WITH ORDINALITY requests(r,n)WHERE r->>'cancelledAt' IS NULL ORDER BY n LIMIT 1;
 IF coalesce((target->>'gate')::boolean,false)AND current_request->>'handedAt' IS NULL THEN RAISE EXCEPTION 'Record the Day 1 handover first' USING ERRCODE='23514';END IF;
 SELECT coalesce(p.full_name,'User '||left(u.id::text,8))INTO actor_name FROM public.app_user u LEFT JOIN public.person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id
 WHERE u.id=app.current_user_id() AND u.tenant_id=c.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id);
 IF actor_name IS NULL THEN RAISE EXCEPTION 'Your login is not available' USING ERRCODE='42501';END IF;
 stamp:=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
 SELECT jsonb_agg(CASE WHEN n=target_index THEN task||jsonb_build_object('status',p_status,'completedAt',CASE WHEN p_status='done'THEN stamp ELSE NULL END,'completedBy',CASE WHEN p_status='done'THEN app.current_user_id() ELSE NULL END)ELSE task END ORDER BY n)
 INTO tasks FROM jsonb_array_elements(c.data->'tasks')WITH ORDINALITY t(task,n);
 entry:=jsonb_build_object('id',gen_random_uuid(),'at',stamp,'by',app.current_user_id(),'name',actor_name,'action','task.status','detail',(target->>'name')||' · '||p_status);
 effect:=app.lifecycle_native_effect_begin('assigned-onboarding-task',c.id,'onboarding.task','onboarding.handover','onboarding.readNote','onboarding.acknowledge');
 INSERT INTO public.lc_onboarding_case_revision(tenant_id,case_id,company_id,revision,data)VALUES(c.tenant_id,c.id,c.company_id,c.revision,c.data)ON CONFLICT DO NOTHING;
 UPDATE public.lc_onboarding_case x SET data=c.data||jsonb_build_object('tasks',tasks,'history',coalesce(c.data->'history','[]'::jsonb)||jsonb_build_array(entry)),revision=c.revision+1,updated_at=clock_timestamp()WHERE x.id=c.id AND x.tenant_id=c.tenant_id;
 PERFORM app.lifecycle_native_effect_complete(effect);
 RETURN QUERY SELECT c.revision+1,c.employment_id,c.company_id;
END $$;
REVOKE ALL ON FUNCTION app.onboarding_assigned_task_update(uuid,integer,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onboarding_assigned_task_update(uuid,integer,text,text) TO ai_hr_app;
--> statement-breakpoint
-- A handler picker exposes actual eligible native workflow identities, not a general employee
-- directory. Keep eligibility independent of whether the caller may see a candidate's Person name.
CREATE OR REPLACE FUNCTION app.lc_staff_directory(p_company uuid)
RETURNS TABLE(user_id uuid,full_name text,level text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT x.user_id,CASE WHEN p.id IS NULL OR NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.person_id=p.id AND e.tenant_id=p.tenant_id) OR app.data_permission_person_read(p.id)THEN p.full_name ELSE NULL END,x.level FROM(
  SELECT s.user_id,s.level FROM public.lc_staff s WHERE s.tenant_id=app.current_tenant_id() AND(s.company_id IS NULL OR s.company_id=p_company)
  UNION
  SELECT r.app_user_id,'admin' FROM public.role_assignment r WHERE r.tenant_id=app.current_tenant_id() AND r.role::text IN('hr_admin','super_admin')AND(r.company_id IS NULL OR r.company_id=p_company)
 )x JOIN public.app_user u ON u.id=x.user_id AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
 LEFT JOIN public.person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id
 WHERE app.principal_snapshot_current() AND EXISTS(SELECT 1 FROM public.company c WHERE c.id=p_company AND c.tenant_id=app.current_tenant_id()) AND app.lc_level(p_company)>=1
 ORDER BY 2,x.user_id;
$$;
CREATE FUNCTION app.lifecycle_handler_eligible(p_user uuid,p_company uuid)RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND EXISTS(SELECT 1 FROM public.company c WHERE c.id=p_company AND c.tenant_id=app.current_tenant_id()) AND app.lc_level(p_company)>=2
 AND EXISTS(SELECT 1 FROM app.lc_staff_directory(p_company)c WHERE c.user_id=p_user);
$$;
REVOKE ALL ON FUNCTION app.lifecycle_handler_eligible(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lifecycle_handler_eligible(uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.onboarding_assigned_task_rows()
RETURNS TABLE(case_id uuid,revision integer,updated_at timestamptz,joiner text,business_group text,join_date text,task_id text,title text,task_by text,gate boolean,opens_on text,due_on text,status text,handed boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT c.id,c.revision,c.updated_at,coalesce(c.data->'local'->>'fullName',c.data->'source'->>'fullName',''),
 coalesce(c.data->'local'->>'businessGroup',c.data->'source'->>'businessGroup',''),coalesce(c.data->'local'->>'joinDate',c.data->'source'->>'joinDate',''),
 t.task->>'id',t.task->>'name',t.task->>'by',coalesce((t.task->>'gate')::boolean,false),t.task->>'opensOn',t.task->>'dueOn',t.task->>'status',
 (SELECT r->>'handedAt' IS NOT NULL FROM jsonb_array_elements(c.data->'requisitions')WITH ORDINALITY requests(r,n)WHERE r->>'cancelledAt' IS NULL ORDER BY n LIMIT 1)
 FROM public.lc_onboarding_case c JOIN public.app_user u ON u.id=app.current_user_id() AND u.tenant_id=c.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
 CROSS JOIN LATERAL jsonb_array_elements(c.data->'tasks')WITH ORDINALITY t(task,n)
 WHERE c.tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() AND app.function_action_allowed('lifecycle.shared.tasks','view',c.company_id) AND c.data->>'state'='submitted' AND t.task->>'status'<>'done' AND t.task->>'assignee'=u.id::text
 ORDER BY c.id,t.n;
$$;
REVOKE ALL ON FUNCTION app.onboarding_assigned_task_rows() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onboarding_assigned_task_rows() TO ai_hr_app;

--> statement-breakpoint
-- Workflow identity eligibility remains tenant-local and independent of administrative Person
-- access. An assigned data profile may mask a name; it must not silently revoke an eligible user ID.
CREATE OR REPLACE FUNCTION app.onboarding_directory()RETURNS TABLE(id uuid,name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT u.id,CASE WHEN p.id IS NOT NULL AND app.data_permission_person_read(p.id)
  THEN coalesce(p.full_name,'User '||left(u.id::text,8)) ELSE 'User '||left(u.id::text,8) END
 FROM public.app_user u LEFT JOIN public.person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id
 WHERE u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
 AND app.principal_snapshot_current() AND EXISTS(SELECT 1 FROM public.app_user actor
  WHERE actor.id=app.current_user_id() AND actor.tenant_id=u.tenant_id AND actor.archived_at IS NULL AND NOT app.login_blocked(actor.id))
 ORDER BY 2,u.id;
$$;

--> statement-breakpoint
-- Prospective joiners have no Employment yet. Match only source-owned facts from the current
-- Personnel draft, never the editable Onboarding local overrides or caller-supplied JSON. Fields
-- absent from the draft contract remain NULL, so predicates on those fields fail closed.
CREATE FUNCTION app.onboarding_data_subject_read(p_case uuid)RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c public.lc_onboarding_case;draft public.employee_draft;profile public.data_permission_profile;rules jsonb;subject jsonb;
BEGIN
 IF NOT app.principal_snapshot_current()THEN RETURN false;END IF;
 SELECT * INTO c FROM public.lc_onboarding_case x WHERE x.id=p_case AND x.tenant_id=app.current_tenant_id();
 IF c.id IS NULL THEN RETURN false;END IF;
 IF c.employment_id IS NOT NULL THEN RETURN app.data_permission_record_read(c.employment_id);END IF;
 SELECT p.* INTO profile FROM public.user_data_permission_assignment a LEFT JOIN public.data_permission_profile p ON p.id=a.profile_id AND p.tenant_id=a.tenant_id
 WHERE a.tenant_id=c.tenant_id AND a.user_id=app.current_user_id();
 IF NOT FOUND THEN RETURN true;END IF;
 IF profile.id IS NULL OR NOT profile.enabled OR profile.retired_at IS NOT NULL OR profile.active_revision_id IS NULL THEN RETURN false;END IF;
 SELECT * INTO draft FROM public.employee_draft d WHERE d.id=c.source_draft_id AND d.tenant_id=c.tenant_id AND d.company_id=c.company_id;
 IF draft.id IS NULL THEN RETURN false;END IF;
 SELECT r.rules INTO rules FROM public.data_permission_revision r WHERE r.id=profile.active_revision_id AND r.profile_id=profile.id AND r.tenant_id=c.tenant_id;
 subject:=jsonb_build_object('tenant',draft.tenant_id::text,'company',draft.company_id::text,
 'businessUnit',(SELECT d.business_unit_id::text FROM public.department d WHERE d.id::text=draft.data->'employment'->>'departmentId' AND d.tenant_id=draft.tenant_id),
 'department',nullif(draft.data->'employment'->>'departmentId',''),'position',nullif(draft.data->'employment'->>'positionId',''),
 'grade',nullif(draft.data->'employment'->>'gradeId',''),'employmentType',nullif(draft.data->'employment'->>'employmentType',''),
 'costCentre',nullif(draft.data->'employment'->>'costCenterId',''),'nationality',nullif(draft.data->'profile'->>'nationality',''),
 'gender',nullif(draft.data->'profile'->>'gender',''),'maritalStatus',nullif(draft.data->'profile'->>'maritalStatus',''),
 'employeeId',coalesce(draft.reserved_employee_code,nullif(draft.data->'profile'->>'employeeCode','')));
 RETURN app.data_permission_rules_match(rules,subject);
END $$;
REVOKE ALL ON FUNCTION app.onboarding_data_subject_read(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onboarding_data_subject_read(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.lifecycle_v9_data_subject_read(p_case uuid)RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND EXISTS(SELECT 1 FROM public.lc_v9_case c WHERE c.id=p_case AND c.tenant_id=app.current_tenant_id() AND app.data_permission_record_read(c.employment_id));
$$;
REVOKE ALL ON FUNCTION app.lifecycle_v9_data_subject_read(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lifecycle_v9_data_subject_read(uuid) TO ai_hr_app;
--> statement-breakpoint
ALTER POLICY data_permission_subject_read ON lc_onboarding_case USING(app.onboarding_data_subject_read(id));
CREATE POLICY data_permission_case_read ON lc_onboarding_private AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(app.onboarding_data_subject_read(case_id));
CREATE POLICY data_permission_case_read ON lc_onboarding_private_revision AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(app.onboarding_data_subject_read(case_id));
CREATE POLICY data_permission_case_read ON lc_onboarding_case_revision AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(app.onboarding_data_subject_read(case_id));
CREATE POLICY data_permission_case_read ON lc_onboarding_note AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(app.onboarding_data_subject_read(case_id));
CREATE POLICY data_permission_case_read ON lc_v9_case_revision AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(app.lifecycle_v9_data_subject_read(case_id));
CREATE POLICY data_permission_case_read ON lc_v9_file AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(CASE WHEN case_id IS NOT NULL THEN app.lifecycle_v9_data_subject_read(case_id) ELSE app.onboarding_data_subject_read(onboarding_case_id)END);

--> statement-breakpoint
-- Two original native owners acquire audit/onboarding locks before any event insert. Join the
-- shared no-wait order admission before those manual locks, retaining their actual native bodies.
DO $order$
DECLARE signature text;body text;anchor text;at integer;
BEGIN
 FOREACH signature IN ARRAY ARRAY['app.onboarding_v9_save_case_values(uuid,integer,jsonb)','app.lc_v9_assigned_item(uuid,integer,text)']LOOP
  body:=pg_get_functiondef(to_regprocedure(signature));
  IF body IS NULL OR strpos(body,'app.audit_access_order_lock()')>0 THEN RAISE EXCEPTION 'Lifecycle audit order owner changed: %',signature;END IF;
  anchor:=CASE WHEN signature LIKE 'app.onboarding_v9_save_case_values%' THEN ' PERFORM pg_advisory_xact_lock(hashtext(''audit-chain:''||app.current_tenant_id()::text));'
   ELSE ' PERFORM pg_advisory_xact_lock(hashtext(''audit-chain:'' || app.current_tenant_id()::text));'END;
  at:=strpos(body,anchor);
  IF at=0 OR strpos(substr(body,at+length(anchor)),anchor)>0 THEN RAISE EXCEPTION 'Lifecycle audit order anchor changed: %',signature;END IF;
  body:=overlay(body placing E' PERFORM app.audit_access_order_lock();\n' from at for 0);
  EXECUTE body;
 END LOOP;
END $order$;

--> statement-breakpoint
CREATE FUNCTION app.notice_function_legacy_allowed(t uuid,u uuid,cap text,co uuid)RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.app_user a WHERE a.id=u AND a.tenant_id=t AND a.archived_at IS NULL AND NOT app.login_blocked(a.id))
 AND cap=ANY(ARRAY['function.noticeBoard.view','function.noticeBoard.add','function.noticeBoard.edit','function.noticeBoard.delete','function.noticeBoard.global.view','function.noticeBoard.global.add','function.noticeBoard.global.edit','function.noticeBoard.global.delete'])
 AND (co IS NULL OR EXISTS(SELECT 1 FROM public.company c WHERE c.id=co AND c.tenant_id=t))
 AND (cap NOT LIKE 'function.noticeBoard.global.%' OR co IS NULL)
 AND EXISTS(SELECT 1 FROM public.role_assignment r WHERE r.tenant_id=t AND r.app_user_id=u AND r.role::text IN('hr_admin','super_admin')
 AND CASE WHEN co IS NULL THEN r.company_id IS NULL ELSE app.access_scope_covers(r.company_id,co,t)END);
$$;
CREATE FUNCTION app.notice_function_current_legacy_allowed(t uuid,u uuid,cap text,co uuid)RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT t=app.current_tenant_id() AND u=app.current_user_id()
 AND app.notice_function_legacy_allowed(t,u,cap,co)
 AND CASE WHEN cap LIKE 'function.noticeBoard.global.%' OR co IS NULL THEN app.is_group_admin() ELSE app.is_admin_for(co)END;
$$;
REVOKE ALL ON FUNCTION app.notice_function_legacy_allowed(uuid,uuid,text,uuid),app.notice_function_current_legacy_allowed(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
DO $$ DECLARE operation text;BEGIN
 FOREACH operation IN ARRAY ARRAY['view','add','edit','delete']LOOP
  PERFORM app.register_function_action('noticeBoard',operation,'company','notices.'||operation,'app.lifecycle_reward_notice_delegation_allowed',
   '{"moduleKey":"notices","labelKey":"nav.noticeBoard","kind":"screen","course":"administrative","screenKey":"noticeBoard","href":"/admin/notice-board","employeeBearing":true}'::jsonb);
  PERFORM app.register_function_action('noticeBoard.global',operation,'tenant','notices_global.'||operation,'app.lifecycle_reward_notice_delegation_allowed',
   '{"moduleKey":"notices","labelKey":"nav.noticeBoard","kind":"native_acl","course":"administrative","screenKey":"noticeBoard","href":"/admin/notice-board","employeeBearing":true}'::jsonb);
 END LOOP;
END $$;

--> statement-breakpoint
-- An assignment-derived course has no administrative parent. Exact native command admission still
-- owns the selected task, current assignee, state, dates, revision and values.
CREATE FUNCTION app.lifecycle_task_function_legacy_allowed(t uuid,u uuid,cap text,co uuid)RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT co IS NOT NULL AND cap IN('function.lifecycle.shared.tasks.view','function.lifecycle.shared.tasks.execute')
 AND EXISTS(SELECT 1 FROM public.app_user a WHERE a.id=u AND a.tenant_id=t AND a.archived_at IS NULL AND NOT app.login_blocked(a.id))
 AND (EXISTS(SELECT 1 FROM public.lc_onboarding_case c,jsonb_array_elements(c.data->'tasks')task WHERE c.tenant_id=t AND c.company_id=co AND c.data->>'state'='submitted' AND task->>'assignee'=u::text)
 OR EXISTS(SELECT 1 FROM public.lc_v9_case c JOIN public.employment e ON e.id=c.employment_id AND e.tenant_id=c.tenant_id,jsonb_array_elements(c.data->'tasks')task
 WHERE c.tenant_id=t AND c.company_id=co AND c.data->>'state'='submitted' AND(task->>'assignee'=u::text OR task->>'by'='employee' AND EXISTS(SELECT 1 FROM public.app_user a WHERE a.id=u AND a.tenant_id=t AND a.person_id=e.person_id))));
$$;
CREATE FUNCTION app.lifecycle_task_function_current_legacy_allowed(t uuid,u uuid,cap text,co uuid)RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT t=app.current_tenant_id() AND u=app.current_user_id() AND app.lifecycle_task_function_legacy_allowed(t,u,cap,co);
$$;
REVOKE ALL ON FUNCTION app.lifecycle_task_function_legacy_allowed(uuid,uuid,text,uuid),app.lifecycle_task_function_current_legacy_allowed(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
DO $$ DECLARE operation text;BEGIN
 FOREACH operation IN ARRAY ARRAY['view','execute']LOOP
  PERFORM app.register_function_action('lifecycle.shared.tasks',operation,'company',NULL,'app.lifecycle_task_function_legacy_allowed',
   '{"moduleKey":"lifecycle","labelKey":"nav.myTasks","kind":"native_acl","course":"assigned","href":"/tasks","employeeBearing":false}'::jsonb);
 END LOOP;
END $$;
--> statement-breakpoint
DO $$ DECLARE body text;anchor text:='WHERE (t->>''assignee''=a.uid OR a.own AND t->>''by''=''employee''))';BEGIN
 body:=pg_get_functiondef('app.lc_v9_work(uuid)'::regprocedure);
 IF strpos(body,anchor)=0 OR strpos(substr(body,strpos(body,anchor)+length(anchor)),anchor)>0 THEN RAISE EXCEPTION 'Lifecycle task projection anchor changed';END IF;
 EXECUTE replace(body,anchor,'WHERE app.function_action_allowed(''lifecycle.shared.tasks'',''view'',a.company_id) AND (t->>''assignee''=a.uid OR a.own AND t->>''by''=''employee''))');
END $$;
--> statement-breakpoint
-- Canonical finite counterparts of M.handover, requisition-note acknowledgement and own device
-- acknowledgement. They do not accept a case delta or expose a private case to the application role.
CREATE FUNCTION app.onboarding_delivery_update(p_case uuid,p_revision integer,p_command text,p_data jsonb DEFAULT '{}'::jsonb)
RETURNS TABLE(revision integer,employment_id uuid,company_id uuid,did_change boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c public.lc_onboarding_case;cfg jsonb;request jsonb;request_index bigint;requests jsonb;tasks jsonb;entry jsonb;actor_name text;stamp text;purpose text;event text;effect uuid;detail text:='';action text;
BEGIN
 PERFORM app.audit_access_order_lock();PERFORM app.access_workforce_write_lock();
 PERFORM pg_advisory_xact_lock(hashtext('audit-chain:'||app.current_tenant_id()::text));
 PERFORM pg_advisory_xact_lock(hashtextextended(app.current_tenant_id()::text||':onboarding',0));
 IF NOT app.principal_snapshot_current() OR app.current_user_id() IS NULL OR p_revision IS NULL OR p_revision<1 OR p_command IS NULL OR p_command NOT IN('handover','readNote','acknowledge')THEN RAISE EXCEPTION 'This work is not available' USING ERRCODE='42501';END IF;
 SELECT coalesce(p.full_name,'User '||left(u.id::text,8)) INTO actor_name FROM public.app_user u LEFT JOIN public.person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id
 WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id);
 IF actor_name IS NULL THEN RAISE EXCEPTION 'This work is not available' USING ERRCODE='42501';END IF;
 SELECT * INTO c FROM public.lc_onboarding_case x WHERE x.id=p_case AND x.tenant_id=app.current_tenant_id()FOR UPDATE;
 IF c.id IS NULL THEN RAISE EXCEPTION 'This work is not available' USING ERRCODE='42501';END IF;
 SELECT x.data INTO cfg FROM public.lc_onboarding_config x WHERE x.tenant_id=c.tenant_id;
 SELECT r,n INTO request,request_index FROM jsonb_array_elements(c.data->'requisitions')WITH ORDINALITY q(r,n)WHERE r->>'cancelledAt' IS NULL ORDER BY n LIMIT 1;
 IF p_command='handover' THEN
  IF c.data->>'state'<>'submitted' OR request IS NULL THEN RAISE EXCEPTION 'No active requisition.' USING ERRCODE='23514';END IF;
  IF NOT app.onboarding_group_member(cfg->>'techGroup')THEN RAISE EXCEPTION 'Group Tech records the handover.' USING ERRCODE='42501';END IF;
  IF NOT app.function_action_allowed('lifecycle.shared.handover','execute',c.company_id)THEN RAISE EXCEPTION 'Handover function unavailable' USING ERRCODE='42501';END IF;
  -- The original native command is idempotent after handover, including its stale-review branch.
  IF request->>'handedAt' IS NOT NULL THEN RETURN QUERY SELECT c.revision,c.employment_id,c.company_id,false;RETURN;END IF;
 ELSIF p_command='readNote' THEN
  IF request IS NULL OR NOT(EXISTS(SELECT 1 FROM jsonb_array_elements(request->'items')i WHERE app.onboarding_group_member(i->>'team'))OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(cfg->'exceptions'->'groups')g WHERE app.onboarding_group_member(g)))THEN RAISE EXCEPTION 'Only the fulfilling teams or groups who can add systems acknowledge this note.' USING ERRCODE='42501';END IF;
  IF NOT app.function_action_allowed('lifecycle.shared.requisitionNotes','execute',c.company_id)THEN RAISE EXCEPTION 'Note function unavailable' USING ERRCODE='42501';END IF;
 ELSE
  IF c.data->>'state'<>'submitted' OR request->>'handedAt' IS NULL OR c.data->'acknowledgement'IS DISTINCT FROM 'null'::jsonb OR NOT EXISTS(SELECT 1 FROM public.app_user u JOIN public.employment e ON e.person_id=u.person_id AND e.tenant_id=u.tenant_id WHERE u.id=app.current_user_id() AND u.tenant_id=c.tenant_id AND u.person_id::text=c.data->>'personId' AND e.id=c.employment_id AND e.company_id=c.company_id AND e.voided_at IS NULL)THEN RAISE EXCEPTION 'Acknowledgement is not available.' USING ERRCODE='42501';END IF;
  IF p_data IS NULL OR jsonb_typeof(p_data)<>'object' OR octet_length(p_data::text)>131072 OR EXISTS(SELECT 1 FROM jsonb_each(p_data)f WHERE length(f.key)>100 OR jsonb_typeof(f.value)<>'string' OR length(f.value#>>'{}')>2000)OR p_data->>'acknowledged' IS DISTINCT FROM 'true' OR length(btrim(coalesce(p_data->>'contactNumber','')))=0 OR length(btrim(coalesce(p_data->>'serialNumber','')))=0 THEN RAISE EXCEPTION 'Confirm that you received the equipment.' USING ERRCODE='23514';END IF;
  IF NOT app.function_action_allowed('lifecycle.self.acknowledgement','execute',c.company_id)THEN RAISE EXCEPTION 'Acknowledgement function unavailable' USING ERRCODE='42501';END IF;
 END IF;
 IF c.revision<>p_revision THEN RAISE EXCEPTION 'This case changed. Reload it before trying again.' USING ERRCODE='40001';END IF;
 stamp:=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');tasks:=c.data->'tasks';
 IF p_command='handover' THEN
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(request->'items')i WHERE NOT(i->>'removed')::boolean AND i->>'approval'='pending')THEN RAISE EXCEPTION 'Resolve pending approvals before handover.' USING ERRCODE='23514';END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(request->'items')i WHERE NOT(i->>'removed')::boolean AND i->>'approval'NOT IN('pending','rejected','withdrawn')AND i->>'state'<>'ready')THEN RAISE EXCEPTION 'Prepare every active item before handover.' USING ERRCODE='23514';END IF;
  request:=request||jsonb_build_object('handedAt',stamp,'items',(SELECT coalesce(jsonb_agg(CASE WHEN NOT(i->>'removed')::boolean AND i->>'approval'NOT IN('pending','rejected','withdrawn')THEN i||'{"state":"handed"}'::jsonb ELSE i END ORDER BY n),'[]'::jsonb)FROM jsonb_array_elements(request->'items')WITH ORDINALITY q(i,n)));
  purpose:='assigned-onboarding-handover';event:='onboarding.handover';action:='requisition.handed';detail:=request->>'number';
 ELSIF p_command='readNote' THEN
  request:=jsonb_set(request,ARRAY['noteAcks'],coalesce(request->'noteAcks','{}'::jsonb)||jsonb_build_object(app.current_user_id()::text,request->'noteVersion'));
  purpose:='assigned-onboarding-note';event:='onboarding.readNote';action:='note.read';
 ELSE
  c.data:=jsonb_set(c.data,'{acknowledgement}',jsonb_build_object('at',stamp,'by',app.current_user_id(),'data',p_data));
  SELECT coalesce(jsonb_agg(CASE WHEN t->>'by'='joiner' AND(t->>'gate')::boolean THEN t||jsonb_build_object('status','done','completedAt',stamp,'completedBy',app.current_user_id())ELSE t END ORDER BY n),'[]'::jsonb)INTO tasks FROM jsonb_array_elements(tasks)WITH ORDINALITY q(t,n);
  purpose:='own-onboarding-ack';event:='onboarding.acknowledge';action:='acknowledgement.submitted';
 END IF;
 SELECT jsonb_agg(CASE WHEN n=request_index THEN request ELSE r END ORDER BY n)INTO requests FROM jsonb_array_elements(c.data->'requisitions')WITH ORDINALITY q(r,n);
 entry:=jsonb_build_object('id',gen_random_uuid(),'at',stamp,'by',app.current_user_id(),'name',actor_name,'action',action,'detail',detail);
 effect:=app.lifecycle_native_effect_begin(purpose,c.id,event);
 INSERT INTO public.lc_onboarding_case_revision(tenant_id,case_id,company_id,revision,data)SELECT x.tenant_id,x.id,x.company_id,x.revision,x.data FROM public.lc_onboarding_case x WHERE x.id=c.id ON CONFLICT DO NOTHING;
 UPDATE public.lc_onboarding_case x SET data=c.data||jsonb_build_object('requisitions',requests,'tasks',tasks,'history',coalesce(c.data->'history','[]'::jsonb)||jsonb_build_array(entry)),revision=c.revision+1,updated_at=clock_timestamp()WHERE x.id=c.id AND x.tenant_id=c.tenant_id;
 PERFORM app.lifecycle_native_effect_complete(effect);
 RETURN QUERY SELECT c.revision+1,c.employment_id,c.company_id,true;
END $$;
REVOKE ALL ON FUNCTION app.onboarding_delivery_update(uuid,integer,text,jsonb)FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onboarding_delivery_update(uuid,integer,text,jsonb)TO ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.lifecycle_delivery_function_legacy_allowed(t uuid,u uuid,cap text,co uuid)RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT co IS NOT NULL AND cap=ANY(ARRAY['function.lifecycle.shared.handover.view','function.lifecycle.shared.handover.execute','function.lifecycle.shared.requisitionNotes.view','function.lifecycle.shared.requisitionNotes.execute','function.lifecycle.self.acknowledgement.view','function.lifecycle.self.acknowledgement.execute'])
 AND EXISTS(SELECT 1 FROM public.app_user a WHERE a.id=u AND a.tenant_id=t AND a.archived_at IS NULL AND NOT app.login_blocked(a.id))
 AND EXISTS(SELECT 1 FROM public.lc_onboarding_case c JOIN public.lc_onboarding_config cfg ON cfg.tenant_id=c.tenant_id WHERE c.tenant_id=t AND c.company_id=co AND CASE
 WHEN cap LIKE 'function.lifecycle.self.acknowledgement.%' THEN EXISTS(SELECT 1 FROM public.app_user a JOIN public.employment e ON e.person_id=a.person_id AND e.tenant_id=a.tenant_id WHERE a.id=u AND a.tenant_id=t AND a.person_id::text=c.data->>'personId' AND e.id=c.employment_id AND e.company_id=co AND e.voided_at IS NULL)
 WHEN cap LIKE 'function.lifecycle.shared.handover.%' THEN EXISTS(SELECT 1 FROM jsonb_array_elements(cfg.data->'groups')g WHERE g->>'id'=cfg.data->>'techGroup' AND g->'members'?u::text)
 ELSE EXISTS(SELECT 1 FROM jsonb_array_elements(cfg.data->'groups')g WHERE g->'members'?u::text AND(g->>'id' IN(SELECT i->>'team' FROM jsonb_array_elements(c.data->'requisitions')r,jsonb_array_elements(r->'items')i WHERE r->>'cancelledAt' IS NULL)OR cfg.data->'exceptions'->'groups'? (g->>'id')))END);
$$;
CREATE FUNCTION app.lifecycle_delivery_function_current_legacy_allowed(t uuid,u uuid,cap text,co uuid)RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT t=app.current_tenant_id() AND u=app.current_user_id() AND app.lifecycle_delivery_function_legacy_allowed(t,u,cap,co);
$$;
REVOKE ALL ON FUNCTION app.lifecycle_delivery_function_legacy_allowed(uuid,uuid,text,uuid),app.lifecycle_delivery_function_current_legacy_allowed(uuid,uuid,text,uuid)FROM PUBLIC,ai_hr_app;
DO $$ DECLARE key text;operation text;BEGIN
 FOREACH key IN ARRAY ARRAY['lifecycle.shared.handover','lifecycle.shared.requisitionNotes','lifecycle.self.acknowledgement']LOOP
  FOREACH operation IN ARRAY ARRAY['view','execute']LOOP
   PERFORM app.register_function_action(key,operation,'company',NULL,'app.lifecycle_delivery_function_legacy_allowed',jsonb_build_object('moduleKey','lifecycle','labelKey','nav.myTasks','kind','native_acl','course',CASE WHEN key='lifecycle.self.acknowledgement'THEN'own'ELSE'assigned'END,'href','/tasks','employeeBearing',false));
  END LOOP;
 END LOOP;
END $$;

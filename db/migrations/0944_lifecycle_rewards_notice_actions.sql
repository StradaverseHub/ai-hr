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
 purpose text NOT NULL,case_id uuid NOT NULL,event_type text NOT NULL,
 source_draft_id uuid,source_data jsonb,source_employment_id uuid,source_person_id uuid,source_intent uuid,
 authority_stamp text NOT NULL CHECK(length(authority_stamp)=64),function_key text,function_operation text,company_id uuid,positive_admission boolean NOT NULL DEFAULT false,active boolean NOT NULL DEFAULT true,completed boolean NOT NULL DEFAULT false
);
CREATE TABLE app.lifecycle_native_effect_receipt(
 context_id uuid NOT NULL REFERENCES app.lifecycle_native_effect_context(id) ON DELETE CASCADE,
 table_name text NOT NULL,row_id text NOT NULL,before_hash text NOT NULL,after_hash text NOT NULL,
 PRIMARY KEY(context_id,table_name,row_id,before_hash,after_hash)
);
ALTER TABLE app.lifecycle_native_effect_context ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.lifecycle_native_effect_receipt ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.lifecycle_native_effect_context,app.lifecycle_native_effect_receipt FROM PUBLIC,ai_hr_app;
-- Canonical native owners alone seal the selected offboarding item and the linked issuing
-- recovery. Child rows avoid early context UPDATEs that would queue cleanup before row guards.
CREATE TABLE app.lifecycle_native_item_admission(
 context_id uuid PRIMARY KEY REFERENCES app.lifecycle_native_effect_context(id)ON DELETE CASCADE,
 item_id text NOT NULL,status text NOT NULL,reason text NOT NULL
);
CREATE TABLE app.lifecycle_holding_recovery_admission(
 context_id uuid PRIMARY KEY REFERENCES app.lifecycle_native_effect_context(id)ON DELETE CASCADE,
 offboarding_case_id uuid NOT NULL,offboarding_item_id text NOT NULL,offboarding_revision integer NOT NULL,
 offboarding_before_hash text NOT NULL,request_id text NOT NULL,item_id text NOT NULL,
 employment_id uuid NOT NULL,company_id uuid NOT NULL,team text NOT NULL,offboarding_reason text NOT NULL
);
ALTER TABLE app.lifecycle_native_item_admission ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.lifecycle_holding_recovery_admission ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.lifecycle_native_item_admission,app.lifecycle_holding_recovery_admission FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.lifecycle_effect_function_identity(p_case uuid,p_purpose text)
RETURNS TABLE(function_key text,operation text,company_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE p_purpose WHEN'assigned-item'THEN'lifecycle.shared.recovery'WHEN'assigned-onboarding-holding-recovery'THEN'lifecycle.shared.recovery'WHEN 'assigned-task'THEN'lifecycle.shared.tasks'WHEN'assigned-onboarding-task'THEN'lifecycle.shared.tasks'WHEN'assigned-onboarding-handover'THEN'lifecycle.shared.handover'WHEN'assigned-onboarding-note'THEN'lifecycle.shared.requisitionNotes'WHEN'own-onboarding-ack'THEN'lifecycle.self.acknowledgement'WHEN'assigned-onboarding-conversation'THEN'lifecycle.shared.conversations'WHEN'assigned-onboarding-fulfil'THEN'lifecycle.shared.fulfilment'WHEN'assigned-onboarding-approval'THEN'lifecycle.shared.approvals'WHEN'assigned-onboarding-approval-assignment'THEN'lifecycle.shared.approvalAssignments'WHEN'assigned-onboarding-exception-add'THEN'lifecycle.shared.exceptionAdditions'WHEN'assigned-onboarding-exception-remove'THEN'lifecycle.shared.exceptionRemovals'WHEN'assigned-onboarding-keep-providing'THEN'lifecycle.shared.retainedProvision'WHEN'administrative-onboarding-exception-remove'THEN'lifecycle.hr.exceptionRemovals'END,
 CASE WHEN p_purpose='assigned-onboarding-approval'THEN'approve'ELSE'execute'END,source.company_id FROM(
 SELECT c.company_id FROM public.lc_v9_case c WHERE p_purpose IN('assigned-task','assigned-item')AND c.id=p_case AND c.tenant_id=app.current_tenant_id()
 UNION ALL SELECT c.company_id FROM public.lc_onboarding_case c WHERE p_purpose IN('assigned-onboarding-task','assigned-onboarding-handover','assigned-onboarding-note','own-onboarding-ack','assigned-onboarding-conversation','assigned-onboarding-fulfil','assigned-onboarding-approval','assigned-onboarding-approval-assignment','assigned-onboarding-exception-add','assigned-onboarding-exception-remove','assigned-onboarding-keep-providing','administrative-onboarding-exception-remove','assigned-onboarding-holding-recovery')AND c.id=p_case AND c.tenant_id=app.current_tenant_id())source;
$$;
REVOKE ALL ON FUNCTION app.lifecycle_effect_function_identity(uuid,text)FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.lifecycle_native_effect_begin(p_purpose text,p_case uuid,p_event text)RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result uuid;identity record;stamp text;
BEGIN
 IF NOT app.principal_snapshot_current() OR app.current_user_id() IS NULL OR p_case IS NULL
  OR p_purpose NOT IN('own-daa','own-document','assigned-task','own-return-report','assigned-item','own-equipment-receipt','assigned-onboarding-task','assigned-onboarding-handover','assigned-onboarding-note','own-onboarding-ack','assigned-onboarding-conversation','assigned-onboarding-fulfil','assigned-onboarding-approval','assigned-onboarding-approval-assignment','assigned-onboarding-exception-add','assigned-onboarding-exception-remove','assigned-onboarding-keep-providing','administrative-onboarding-exception-remove','assigned-onboarding-holding-recovery')
  OR p_event NOT IN('lifecycle-case.daa-submitted','lifecycle-v9.employeeDocumentSigned','lifecycle-v9.employeeDocumentSaved','lifecycle-v9.assignedTaskUpdated','lifecycle-v9.returnReported','lifecycle-v9.providingTeamItemUpdated','lifecycle-v9.equipmentReceipt','onboarding.task','onboarding.handover','onboarding.readNote','onboarding.acknowledge','onboarding.note_changed','onboarding.fulfil','onboarding.approve','onboarding.assignApproval','onboarding.addItem','onboarding.removeItem','onboarding.keepProviding','onboarding.holding_returned','onboarding.holding_revoked')
  OR EXISTS(SELECT 1 FROM app.lifecycle_native_effect_context c WHERE c.xact_id=pg_current_xact_id() AND c.tenant_id=app.current_tenant_id() AND c.user_id=app.current_user_id() AND c.active)
 THEN RAISE EXCEPTION 'Invalid native Lifecycle effect context' USING ERRCODE='42501';END IF;
 SELECT * INTO identity FROM app.lifecycle_effect_function_identity(p_case,p_purpose);
 IF identity.function_key IS NOT NULL AND NOT app.function_action_allowed(identity.function_key,identity.operation,identity.company_id)THEN RAISE EXCEPTION 'Assigned function unavailable' USING ERRCODE='42501';END IF;
 stamp:=app.access_function_authority_stamp();IF stamp IS NULL THEN RAISE EXCEPTION 'Native authority changed' USING ERRCODE='42501';END IF;
 INSERT INTO app.lifecycle_native_effect_context(xact_id,tenant_id,user_id,purpose,case_id,event_type,authority_stamp,function_key,function_operation,company_id,positive_admission)
 VALUES(pg_current_xact_id(),app.current_tenant_id(),app.current_user_id(),p_purpose,p_case,p_event,stamp,identity.function_key,identity.operation,identity.company_id,identity.function_key IS NOT NULL)RETURNING id INTO result;
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
CREATE FUNCTION app.lifecycle_native_item_effect_begin(p_case uuid,p_item text,p_status text,p_reason text)RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE effect uuid;
BEGIN
 IF p_item IS NULL OR length(p_item)NOT BETWEEN 1 AND 100 OR p_status IS NULL OR p_status NOT IN('todo','progress','done')OR p_reason IS NULL OR length(p_reason)>4000 THEN RAISE EXCEPTION 'Invalid native return work admission' USING ERRCODE='42501';END IF;
 effect:=app.lifecycle_native_effect_begin('assigned-item',p_case,'lifecycle-v9.providingTeamItemUpdated');
 INSERT INTO app.lifecycle_native_item_admission(context_id,item_id,status,reason)VALUES(effect,p_item,p_status,trim(p_reason));
 RETURN effect;
END $$;
REVOKE ALL ON FUNCTION app.lifecycle_native_item_effect_begin(uuid,text,text,text)FROM PUBLIC,ai_hr_app;
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
 FOREACH owned_table IN ARRAY ARRAY['lc_case','lc_case_step','lc_history','lc_v9_case','lc_v9_case_revision','lc_onboarding_case','lc_onboarding_private','lc_onboarding_case_revision','lc_onboarding_private_revision','lc_onboarding_note']LOOP
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
CREATE FUNCTION app.onboarding_saved_source_facts(p_source jsonb)RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH input AS(SELECT p_source->'data'->'profile' profile,p_source->'data'->'employment' employment),
 raw AS(SELECT jsonb_build_object('fullName',profile->'fullName','employeeId',coalesce(nullif(p_source->'reserved_employee_code','null'::jsonb),profile->'employeeCode'),
 'joinDate',employment->'hiredOn','title',employment->'positionId','department',employment->'departmentId','company',p_source->'company_id',
 'businessGroup',(SELECT to_jsonb(d.business_unit_id)FROM public.department d WHERE d.tenant_id=(p_source->>'tenant_id')::uuid AND d.id::text=employment->>'departmentId'),
 'grade',employment->'gradeId','employmentType',employment->'employmentType','confirmationDate',employment->'confirmationDate','provisionalEndOn',employment->'provisionalEndOn',
 'supervisor',employment->'reportingManagerEmploymentId','email',profile->'primaryEmail','costCentre',employment->'costCenterId','ic',profile->'icNumber','passport',profile->'passportNumber')facts FROM input)
 SELECT coalesce(jsonb_object_agg(field.key,field.value),'{}'::jsonb)FROM raw,jsonb_each(raw.facts)field WHERE jsonb_typeof(field.value)='string'AND length(btrim(field.value#>>'{}'))>0;
$$;
REVOKE ALL ON FUNCTION app.onboarding_saved_source_facts(jsonb)FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- A SAVE receipt remains bound to its exact Draft image, including when that same image is
-- subsequently saved again or consumed by the native activation/discard course in this
-- transaction. Only physical OLD→NEW receipts of this same Draft/actor/stamp form the chain.
CREATE FUNCTION app.lifecycle_saved_source_completion(p_context uuid)RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH RECURSIVE effect AS(SELECT * FROM app.lifecycle_native_effect_context context WHERE context.id=p_context AND context.purpose='source-draft-save'),
 images(source)AS(
  SELECT effect.source_data FROM effect
  UNION
  SELECT mutation.after_source FROM images JOIN app.workforce_draft_mutation mutation ON mutation.before_source=images.source CROSS JOIN effect
  WHERE mutation.xact_id=effect.xact_id AND mutation.tenant_id=effect.tenant_id AND mutation.user_id=effect.user_id AND mutation.draft_id=effect.source_draft_id AND mutation.operation='edit'AND mutation.authority_stamp=effect.authority_stamp
   AND app.data_permission_draft_matches(effect.tenant_id,effect.user_id,mutation.before_source)AND app.data_permission_draft_matches(effect.tenant_id,effect.user_id,mutation.after_source)
 )
 SELECT EXISTS(SELECT 1 FROM effect JOIN public.lc_onboarding_case actual ON actual.id=effect.case_id AND actual.tenant_id=effect.tenant_id AND actual.source_draft_id=effect.source_draft_id CROSS JOIN images
 WHERE actual.company_id::text=images.source->>'company_id'AND actual.data->>'sourceDraftId'=effect.source_draft_id::text
 AND(app.workforce_draft_saved_source_allowed(effect.source_draft_id,images.source)
  OR app.workforce_draft_active_completed(effect.source_draft_id,images.source,actual.employment_id,(actual.data->>'personId')::uuid)
  OR EXISTS(SELECT 1 FROM app.workforce_draft_discard_source intent WHERE intent.xact_id=effect.xact_id AND intent.tenant_id=effect.tenant_id AND intent.user_id=effect.user_id AND intent.draft_id=effect.source_draft_id AND intent.source=images.source AND app.workforce_draft_discard_completed(intent.id,effect.source_draft_id,images.source))));
$$;
REVOKE ALL ON FUNCTION app.lifecycle_saved_source_completion(uuid)FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Issuing recovery closes only through the actual selected native offboarding item owner.
-- Its sealed payload/OLD image survives SAVEPOINTs and later legitimate sibling-item updates.
CREATE FUNCTION app.lifecycle_holding_recovery_completed(p_context uuid)RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app.lifecycle_native_effect_context source_context
 JOIN app.lifecycle_holding_recovery_admission admission ON admission.context_id=source_context.id
 JOIN public.lc_onboarding_case source_case ON source_case.id=source_context.case_id AND source_case.tenant_id=source_context.tenant_id AND source_case.company_id=admission.company_id AND source_case.employment_id=admission.employment_id
 JOIN public.lc_v9_case exit_case ON exit_case.id=admission.offboarding_case_id AND exit_case.tenant_id=source_context.tenant_id AND exit_case.company_id=admission.company_id AND exit_case.employment_id=admission.employment_id AND exit_case.module='off'
 WHERE source_context.id=p_context AND source_context.purpose='assigned-onboarding-holding-recovery'
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(source_case.data->'requisitions')r,jsonb_array_elements(r->'items')i WHERE r->>'id'=admission.request_id AND i->>'id'=admission.item_id AND i->'recovery'->>'offboardingCaseId'=admission.offboarding_case_id::text AND i->'recovery'->>'by'=source_context.user_id::text AND i->'recovery'->>'outcome'=CASE WHEN i->>'type'='system'THEN'revoked'ELSE'returned'END AND(i->>'revokeNeeded')::boolean IS NOT TRUE)
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(exit_case.data->'items')i WHERE i->>'id'=admission.offboarding_item_id AND i->>'status'='done'AND i->>'assignee'=source_context.user_id::text AND i->>'group'=admission.team AND i->'nativeSource'->>'caseId'=source_case.id::text AND i->'nativeSource'->>'requestId'=admission.request_id AND i->'nativeSource'->>'itemId'=admission.item_id)
 AND EXISTS(SELECT 1 FROM app.lifecycle_native_effect_context completion
 JOIN app.lifecycle_native_item_admission selected ON selected.context_id=completion.id
 JOIN app.lifecycle_native_effect_receipt receipt ON receipt.context_id=completion.id
 WHERE completion.xact_id=source_context.xact_id AND completion.tenant_id=source_context.tenant_id AND completion.user_id=source_context.user_id AND completion.case_id=admission.offboarding_case_id AND completion.company_id=admission.company_id
 AND completion.purpose='assigned-item'AND completion.function_key='lifecycle.shared.recovery'AND completion.function_operation='execute'AND completion.positive_admission AND completion.completed AND NOT completion.active AND completion.authority_stamp=source_context.authority_stamp
 AND selected.item_id=admission.offboarding_item_id AND selected.status='done'AND selected.reason=admission.offboarding_reason AND receipt.table_name='lc_v9_case'AND receipt.before_hash=admission.offboarding_before_hash
 AND EXISTS(SELECT 1 FROM public.domain_event event WHERE event.tenant_id=completion.tenant_id AND event.aggregate_id=completion.case_id AND event.event_type='lifecycle-v9.providingTeamItemUpdated'AND event.actor_type='user'AND event.actor_id=completion.user_id AND event.payload->>'functionKey'=completion.function_key AND event.payload->>'nativeBranch'=completion.purpose AND app.lifecycle_row_in_transaction('domain_event',event.id,to_jsonb(event)))));
$$;
REVOKE ALL ON FUNCTION app.lifecycle_holding_recovery_completed(uuid)FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.lifecycle_native_effect_admission_valid(p_context uuid)RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current()AND EXISTS(SELECT 1 FROM app.lifecycle_native_effect_context c
 JOIN public.app_user actor ON actor.id=c.user_id AND actor.tenant_id=c.tenant_id AND actor.archived_at IS NULL AND NOT app.login_blocked(actor.id)
 WHERE c.id=p_context AND c.xact_id=pg_current_xact_id()AND c.tenant_id=app.current_tenant_id()AND c.user_id=app.current_user_id()AND c.completed AND NOT c.active
 AND c.authority_stamp=app.access_function_authority_stamp()
 AND(c.purpose<>'assigned-onboarding-holding-recovery'OR app.lifecycle_holding_recovery_completed(c.id))
 AND(c.purpose<>'source-draft-save' OR app.lifecycle_saved_source_completion(c.id))
 AND(c.purpose<>'source-draft-active' OR app.workforce_draft_active_completed(c.source_draft_id,c.source_data,c.source_employment_id,c.source_person_id)AND EXISTS(SELECT 1 FROM public.lc_onboarding_case actual WHERE actual.id=c.case_id AND actual.tenant_id=c.tenant_id AND actual.source_draft_id=c.source_draft_id AND actual.company_id=c.company_id AND actual.employment_id=c.source_employment_id AND actual.data->>'employmentId'=c.source_employment_id::text AND actual.data->>'personId'=c.source_person_id::text AND actual.data->>'personnelStatus'='Active'))
 AND(c.purpose<>'source-draft-discard' OR app.workforce_draft_discard_completed(c.source_intent,c.source_draft_id,c.source_data)AND EXISTS(SELECT 1 FROM public.lc_onboarding_case actual WHERE actual.id=c.case_id AND actual.tenant_id=c.tenant_id AND actual.source_draft_id=c.source_draft_id AND actual.company_id=c.company_id))
 AND(c.function_key IS NULL OR c.positive_admission AND app.function_action_denial_clear(c.function_key,c.function_operation,c.company_id)
 AND EXISTS(SELECT 1 FROM app.lifecycle_effect_function_identity(c.case_id,c.purpose)native WHERE native.function_key=c.function_key AND native.operation=c.function_operation AND native.company_id=c.company_id)));
$$;
REVOKE ALL ON FUNCTION app.lifecycle_native_effect_admission_valid(uuid)FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.lifecycle_native_effect_approved(p_table text,p_before jsonb,p_after jsonb)RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND EXISTS(SELECT 1 FROM app.lifecycle_native_effect_context c JOIN app.lifecycle_native_effect_receipt r ON r.context_id=c.id
 WHERE c.xact_id=pg_current_xact_id() AND c.tenant_id=app.current_tenant_id() AND c.user_id=app.current_user_id() AND c.completed AND NOT c.active
 AND app.lifecycle_native_effect_admission_valid(c.id)
 AND r.table_name=p_table AND r.before_hash=encode(sha256(convert_to(coalesce(p_before,'{}'::jsonb)::text,'UTF8')),'hex') AND r.after_hash=encode(sha256(convert_to(coalesce(p_after,'{}'::jsonb)::text,'UTF8')),'hex')
 AND EXISTS(SELECT 1 FROM public.domain_event e WHERE e.tenant_id=c.tenant_id AND e.aggregate_id=c.case_id AND e.event_type=c.event_type AND e.actor_type='user' AND e.actor_id=c.user_id AND(c.purpose NOT IN('assigned-onboarding-exception-add','assigned-onboarding-exception-remove','assigned-onboarding-keep-providing','administrative-onboarding-exception-remove','assigned-onboarding-holding-recovery','assigned-item')OR e.payload->>'functionKey'=c.function_key AND e.payload->>'nativeBranch'=c.purpose) AND app.lifecycle_row_in_transaction('domain_event',e.id,to_jsonb(e))));
$$;
REVOKE ALL ON FUNCTION app.lifecycle_native_effect_approved(text,jsonb,jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.lifecycle_native_effect_cleanup()RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM app.lifecycle_native_effect_context c WHERE c.id=NEW.id)THEN RETURN NULL;END IF;
 IF NOT app.lifecycle_native_effect_admission_valid(NEW.id) OR NOT EXISTS(SELECT 1 FROM public.domain_event e WHERE e.tenant_id=NEW.tenant_id AND e.aggregate_id=NEW.case_id AND e.event_type=NEW.event_type AND e.actor_type='user' AND e.actor_id=NEW.user_id AND(NEW.purpose NOT IN('assigned-onboarding-exception-add','assigned-onboarding-exception-remove','assigned-onboarding-keep-providing','administrative-onboarding-exception-remove','assigned-onboarding-holding-recovery','assigned-item')OR e.payload->>'functionKey'=NEW.function_key AND e.payload->>'nativeBranch'=NEW.purpose) AND app.lifecycle_row_in_transaction('domain_event',e.id,to_jsonb(e)))
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
  entry:=CASE WHEN spec.purpose='assigned-item'THEN ' action_effect:=app.lifecycle_native_item_effect_begin(c.id,p_item,p_status,p_reason);'ELSE format(' action_effect:=app.lifecycle_native_effect_begin(%L,%s,%s);',spec.purpose,spec.subject,spec.event)END||E'\n';
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
 effect:=app.lifecycle_native_effect_begin('assigned-onboarding-task',c.id,'onboarding.task');
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
DECLARE c public.lc_onboarding_case;draft public.employee_draft;
BEGIN
 IF NOT app.principal_snapshot_current()THEN RETURN false;END IF;
 SELECT * INTO c FROM public.lc_onboarding_case x WHERE x.id=p_case AND x.tenant_id=app.current_tenant_id();
 IF c.id IS NULL THEN RETURN false;END IF;
 IF c.employment_id IS NOT NULL THEN RETURN app.data_permission_record_read(c.employment_id);END IF;
 IF NOT EXISTS(SELECT 1 FROM public.user_data_permission_assignment a WHERE a.tenant_id=c.tenant_id AND a.user_id=app.current_user_id())THEN RETURN true;END IF;
 SELECT * INTO draft FROM public.employee_draft d WHERE d.id=c.source_draft_id AND d.tenant_id=c.tenant_id AND d.company_id=c.company_id;
 RETURN draft.id IS NOT NULL AND app.data_permission_draft_matches(c.tenant_id,app.current_user_id(),to_jsonb(draft));
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
   '{"moduleKey":"notices","labelKey":"notices.groupAuthoring","kind":"native_acl","course":"administrative","screenKey":"noticeBoard","href":"/admin/notice-board","employeeBearing":true}'::jsonb);
 END LOOP;
END $$;

--> statement-breakpoint
-- An assignment-derived course has no administrative parent. Exact native command admission still
-- owns the selected task, current assignee, state, dates, revision and values.
CREATE FUNCTION app.lifecycle_task_function_legacy_allowed(t uuid,u uuid,cap text,co uuid)RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT co IS NOT NULL AND cap IN('function.lifecycle.shared.tasks.view','function.lifecycle.shared.tasks.execute')
 AND EXISTS(SELECT 1 FROM public.app_user a WHERE a.id=u AND a.tenant_id=t AND a.archived_at IS NULL AND NOT app.login_blocked(a.id))
 AND (EXISTS(SELECT 1 FROM public.lc_onboarding_case c,jsonb_array_elements(c.data->'tasks')task WHERE c.tenant_id=t AND c.company_id=co AND(cap='function.lifecycle.shared.tasks.view'OR c.data->>'state'='submitted') AND task->>'assignee'=u::text)
 OR EXISTS(SELECT 1 FROM public.lc_v9_case c JOIN public.employment e ON e.id=c.employment_id AND e.tenant_id=c.tenant_id,jsonb_array_elements(c.data->'tasks')task
 WHERE c.tenant_id=t AND c.company_id=co AND(cap='function.lifecycle.shared.tasks.view'OR c.data->>'state'='submitted') AND(task->>'assignee'=u::text OR task->>'by'='employee' AND EXISTS(SELECT 1 FROM public.app_user a WHERE a.id=u AND a.tenant_id=t AND a.person_id=e.person_id))));
$$;
CREATE FUNCTION app.lifecycle_task_function_current_legacy_allowed(t uuid,u uuid,cap text,co uuid)RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT t=app.current_tenant_id() AND u=app.current_user_id() AND app.lifecycle_task_function_legacy_allowed(t,u,cap,co);
$$;
REVOKE ALL ON FUNCTION app.lifecycle_task_function_legacy_allowed(uuid,uuid,text,uuid),app.lifecycle_task_function_current_legacy_allowed(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
DO $$ DECLARE operation text;BEGIN
 FOREACH operation IN ARRAY ARRAY['view','execute']LOOP
  PERFORM app.register_function_action('lifecycle.shared.tasks',operation,'company',NULL,'app.lifecycle_task_function_legacy_allowed',
   '{"moduleKey":"lifecycle","labelKey":"onboardingV31.copy.cde75c43eb31e","kind":"native_acl","course":"assigned","href":"/tasks","employeeBearing":false}'::jsonb);
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
 SELECT co IS NOT NULL AND cap=ANY(ARRAY['function.lifecycle.shared.handover.view','function.lifecycle.shared.handover.execute','function.lifecycle.shared.requisitionNotes.view','function.lifecycle.shared.requisitionNotes.execute','function.lifecycle.self.acknowledgement.view','function.lifecycle.self.acknowledgement.execute','function.lifecycle.shared.fulfilment.view','function.lifecycle.shared.fulfilment.execute'])
 AND EXISTS(SELECT 1 FROM public.app_user a WHERE a.id=u AND a.tenant_id=t AND a.archived_at IS NULL AND NOT app.login_blocked(a.id))
 AND EXISTS(SELECT 1 FROM public.lc_onboarding_case c JOIN public.lc_onboarding_config cfg ON cfg.tenant_id=c.tenant_id WHERE c.tenant_id=t AND c.company_id=co AND CASE
 WHEN cap LIKE 'function.lifecycle.self.acknowledgement.%' THEN EXISTS(SELECT 1 FROM public.app_user a JOIN public.employment e ON e.person_id=a.person_id AND e.tenant_id=a.tenant_id WHERE a.id=u AND a.tenant_id=t AND a.person_id::text=c.data->>'personId' AND e.id=c.employment_id AND e.company_id=co AND e.voided_at IS NULL)
 WHEN cap LIKE 'function.lifecycle.shared.fulfilment.%' THEN EXISTS(SELECT 1 FROM jsonb_array_elements(cfg.data->'groups')g WHERE g->'members'?u::text AND g->>'id' IN(SELECT i->>'team' FROM jsonb_array_elements(c.data->'requisitions')r,jsonb_array_elements(r->'items')i WHERE r->>'cancelledAt'IS NULL))
 WHEN cap LIKE 'function.lifecycle.shared.handover.%' THEN EXISTS(SELECT 1 FROM jsonb_array_elements(cfg.data->'groups')g WHERE g->>'id'=cfg.data->>'techGroup' AND g->'members'?u::text)
 ELSE EXISTS(SELECT 1 FROM jsonb_array_elements(cfg.data->'groups')g WHERE g->'members'?u::text AND(g->>'id' IN(SELECT i->>'team' FROM jsonb_array_elements(c.data->'requisitions')r,jsonb_array_elements(r->'items')i WHERE r->>'cancelledAt' IS NULL)OR cfg.data->'exceptions'->'groups'? (g->>'id')))END);
$$;
CREATE FUNCTION app.lifecycle_delivery_function_current_legacy_allowed(t uuid,u uuid,cap text,co uuid)RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT t=app.current_tenant_id() AND u=app.current_user_id() AND app.lifecycle_delivery_function_legacy_allowed(t,u,cap,co);
$$;
REVOKE ALL ON FUNCTION app.lifecycle_delivery_function_legacy_allowed(uuid,uuid,text,uuid),app.lifecycle_delivery_function_current_legacy_allowed(uuid,uuid,text,uuid)FROM PUBLIC,ai_hr_app;
DO $$ DECLARE key text;operation text;BEGIN
 FOREACH key IN ARRAY ARRAY['lifecycle.shared.handover','lifecycle.shared.requisitionNotes','lifecycle.self.acknowledgement','lifecycle.shared.fulfilment']LOOP
  FOREACH operation IN ARRAY ARRAY['view','execute']LOOP
   PERFORM app.register_function_action(key,operation,'company',NULL,'app.lifecycle_delivery_function_legacy_allowed',jsonb_build_object('moduleKey','lifecycle','labelKey',CASE key WHEN 'lifecycle.shared.handover'THEN'onboardingV31.copy.c2ad9e1e18276'WHEN'lifecycle.shared.requisitionNotes'THEN'onboardingV31.copy.c2c2fc0cafbff'WHEN'lifecycle.self.acknowledgement'THEN'onboardingV31.copy.c0671783a107b'ELSE'onboardingV31.copy.c582c799c7789'END,'kind','native_acl','course',CASE WHEN key='lifecycle.self.acknowledgement'THEN'own'ELSE'assigned'END,'href','/tasks','employeeBearing',false));
  END LOOP;
 END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.onboarding_conversation_assigned(p_case uuid,p_context text)RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND EXISTS(SELECT 1 FROM public.lc_onboarding_case c JOIN public.app_user u ON u.id=app.current_user_id() AND u.tenant_id=c.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
 WHERE c.id=p_case AND c.tenant_id=app.current_tenant_id() AND(EXISTS(SELECT 1 FROM jsonb_array_elements(c.data->'tasks')t WHERE t->>'id'=p_context AND t->>'assignee'=u.id::text)
 OR EXISTS(SELECT 1 FROM public.lc_onboarding_note n WHERE n.case_id=c.id AND n.tenant_id=c.tenant_id AND n.data->>'context'=p_context AND n.data->'mentions'?u.id::text)));
$$;
REVOKE ALL ON FUNCTION app.onboarding_conversation_assigned(uuid,text)FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onboarding_conversation_assigned(uuid,text)TO ai_hr_app;
CREATE FUNCTION app.onboarding_conversation_update(p_case uuid,p_context text,p_note uuid,p_body text,p_mentions jsonb,p_deleted boolean,p_resolve boolean)
RETURNS TABLE(revision integer,employment_id uuid,company_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c public.lc_onboarding_case;note public.lc_onboarding_note;actor_name text;stamp text;effect uuid;next_note jsonb;old_note record;
BEGIN
 PERFORM app.audit_access_order_lock();PERFORM app.access_workforce_write_lock();
 PERFORM pg_advisory_xact_lock(hashtext('audit-chain:'||app.current_tenant_id()::text));
 PERFORM pg_advisory_xact_lock(hashtextextended(app.current_tenant_id()::text||':onboarding',0));
 IF NOT app.onboarding_conversation_assigned(p_case,p_context)THEN RAISE EXCEPTION 'This conversation is not available.'USING ERRCODE='42501';END IF;
 SELECT * INTO c FROM public.lc_onboarding_case x WHERE x.id=p_case AND x.tenant_id=app.current_tenant_id()FOR UPDATE;
 IF c.data->>'state'='cancelled'THEN RAISE EXCEPTION 'This case is cancelled.'USING ERRCODE='23514';END IF;
 IF p_body IS NULL OR length(p_body)>10000 OR p_context IS NULL OR length(p_context)>100 OR p_mentions IS NULL OR jsonb_typeof(p_mentions)<>'array' OR jsonb_array_length(p_mentions)>50 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_mentions)m WHERE jsonb_typeof(m)<>'string' OR NOT EXISTS(SELECT 1 FROM public.app_user u WHERE u.id::text=m#>>'{}' AND u.tenant_id=c.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)))THEN RAISE EXCEPTION 'Choose active people from the directory.'USING ERRCODE='23514';END IF;
 IF NOT app.function_action_allowed('lifecycle.shared.conversations','execute',c.company_id)THEN RAISE EXCEPTION 'Conversation function unavailable'USING ERRCODE='42501';END IF;
 SELECT coalesce(p.full_name,'User '||left(u.id::text,8))INTO actor_name FROM public.app_user u LEFT JOIN public.person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id WHERE u.id=app.current_user_id()AND u.tenant_id=c.tenant_id;
 stamp:=to_char(clock_timestamp()AT TIME ZONE'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
 IF p_note IS NOT NULL THEN
  SELECT * INTO note FROM public.lc_onboarding_note n WHERE n.id=p_note AND n.case_id=c.id AND n.tenant_id=c.tenant_id FOR UPDATE;
  IF note.id IS NULL THEN RAISE EXCEPTION 'Note not found.'USING ERRCODE='23514';END IF;
  -- A caller cannot select one assigned conversation and smuggle a note from another context.
  IF note.data->>'context'IS DISTINCT FROM p_context THEN RAISE EXCEPTION 'This conversation is not available.'USING ERRCODE='42501';END IF;
  next_note:=note.data;
  IF coalesce(p_resolve,false)THEN
   IF NOT(note.data->'mentions'?app.current_user_id()::text)THEN RAISE EXCEPTION 'This mention is not assigned to you.'USING ERRCODE='42501';END IF;
   IF NOT(next_note->'resolved'?app.current_user_id()::text)THEN next_note:=jsonb_set(next_note,'{resolved}',coalesce(next_note->'resolved','[]'::jsonb)||jsonb_build_array(app.current_user_id()));END IF;
  ELSE
   IF note.data->>'by'IS DISTINCT FROM app.current_user_id()::text THEN RAISE EXCEPTION 'Only the author can edit a note.'USING ERRCODE='42501';END IF;
   IF NOT coalesce(p_deleted,false)AND length(btrim(p_body))=0 THEN RAISE EXCEPTION 'Write a note before saving.'USING ERRCODE='23514';END IF;
   next_note:=next_note||jsonb_build_object('revisions',coalesce(next_note->'revisions','[]'::jsonb)||jsonb_build_array(jsonb_build_object('body',next_note->'body','mentions',next_note->'mentions','deleted',next_note->'deleted','at',stamp,'by',app.current_user_id())),'resolved','[]'::jsonb,'edited',true,'deleted',coalesce(p_deleted,false));
   IF NOT coalesce(p_deleted,false)THEN next_note:=next_note||jsonb_build_object('body',btrim(p_body),'mentions',p_mentions);END IF;
  END IF;
 ELSE
  IF length(btrim(p_body))=0 THEN RAISE EXCEPTION 'Write a note before sending.'USING ERRCODE='23514';END IF;
  next_note:=jsonb_build_object('id',gen_random_uuid(),'context',p_context,'body',btrim(p_body),'by',app.current_user_id(),'name',actor_name,'at',stamp,'edited',false,'mentions',p_mentions,'resolved','[]'::jsonb,'deleted',false);
 END IF;
 effect:=app.lifecycle_native_effect_begin('assigned-onboarding-conversation',c.id,'onboarding.note_changed');
 IF p_note IS NOT NULL THEN UPDATE public.lc_onboarding_note SET data=next_note WHERE id=note.id;
 ELSE
  INSERT INTO public.lc_onboarding_note(id,tenant_id,case_id,data)VALUES((next_note->>'id')::uuid,c.tenant_id,c.id,next_note);
  FOR old_note IN SELECT * FROM public.lc_onboarding_note n WHERE n.case_id=c.id AND n.tenant_id=c.tenant_id AND n.data->>'context'=p_context AND n.data->'mentions'?app.current_user_id()::text AND NOT(n.data->'resolved'?app.current_user_id()::text)AND(c.data->>'submittedAt'IS NULL OR n.data->>'at'>=c.data->>'submittedAt')LOOP
   UPDATE public.lc_onboarding_note SET data=jsonb_set(old_note.data,'{resolved}',coalesce(old_note.data->'resolved','[]'::jsonb)||jsonb_build_array(app.current_user_id()))WHERE id=old_note.id;
  END LOOP;
 END IF;
 UPDATE public.lc_onboarding_case x SET revision=c.revision+1,updated_at=clock_timestamp()WHERE x.id=c.id;
 PERFORM app.lifecycle_native_effect_complete(effect);
 RETURN QUERY SELECT c.revision+1,c.employment_id,c.company_id;
END $$;
REVOKE ALL ON FUNCTION app.onboarding_conversation_update(uuid,text,uuid,text,jsonb,boolean,boolean)FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onboarding_conversation_update(uuid,text,uuid,text,jsonb,boolean,boolean)TO ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.lifecycle_conversation_function_legacy_allowed(t uuid,u uuid,cap text,co uuid)RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT co IS NOT NULL AND cap IN('function.lifecycle.shared.conversations.view','function.lifecycle.shared.conversations.execute')
 AND EXISTS(SELECT 1 FROM public.app_user a WHERE a.id=u AND a.tenant_id=t AND a.archived_at IS NULL AND NOT app.login_blocked(a.id))
 AND EXISTS(SELECT 1 FROM public.lc_onboarding_case c WHERE c.tenant_id=t AND c.company_id=co AND(EXISTS(SELECT 1 FROM jsonb_array_elements(c.data->'tasks')task WHERE task->>'assignee'=u::text)
 OR EXISTS(SELECT 1 FROM public.lc_onboarding_note n WHERE n.case_id=c.id AND n.tenant_id=t AND n.data->'mentions'?u::text)));
$$;
CREATE FUNCTION app.lifecycle_conversation_function_current_legacy_allowed(t uuid,u uuid,cap text,co uuid)RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT t=app.current_tenant_id() AND u=app.current_user_id() AND app.lifecycle_conversation_function_legacy_allowed(t,u,cap,co);
$$;
REVOKE ALL ON FUNCTION app.lifecycle_conversation_function_legacy_allowed(uuid,uuid,text,uuid),app.lifecycle_conversation_function_current_legacy_allowed(uuid,uuid,text,uuid)FROM PUBLIC,ai_hr_app;
DO $$DECLARE operation text;BEGIN
 FOREACH operation IN ARRAY ARRAY['view','execute']LOOP
  PERFORM app.register_function_action('lifecycle.shared.conversations',operation,'company',NULL,'app.lifecycle_conversation_function_legacy_allowed','{"moduleKey":"lifecycle","labelKey":"onboardingV31.copy.c9bfd2d7fe771","kind":"native_acl","course":"assigned","href":"/tasks","employeeBearing":false}'::jsonb);
 END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.onboarding_conversation_rows(p_case uuid,p_context text)RETURNS SETOF jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT n.data FROM public.lc_onboarding_note n JOIN public.lc_onboarding_case c ON c.id=n.case_id AND c.tenant_id=n.tenant_id
 WHERE c.id=p_case AND c.tenant_id=app.current_tenant_id() AND n.data->>'context'=p_context
 AND app.onboarding_conversation_assigned(c.id,p_context)AND app.function_action_allowed('lifecycle.shared.conversations','view',c.company_id)
 AND(n.data->>'by'=app.current_user_id()::text OR n.data->'mentions'?app.current_user_id()::text OR EXISTS(SELECT 1 FROM jsonb_array_elements(c.data->'tasks')task WHERE task->>'id'=p_context AND task->>'assignee'=app.current_user_id()::text))ORDER BY n.created_at,n.id;
$$;
REVOKE ALL ON FUNCTION app.onboarding_conversation_rows(uuid,text)FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onboarding_conversation_rows(uuid,text)TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.onboarding_fulfil_item(p_case uuid,p_revision integer,p_item text,p_status text)
RETURNS TABLE(revision integer,employment_id uuid,company_id uuid,did_change boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c public.lc_onboarding_case;cfg jsonb;request jsonb;request_index bigint;target jsonb;item_index bigint;items jsonb;requests jsonb;group_row jsonb;due date;due_day integer;join_date text;chosen uuid;history jsonb;actor_name text;stamp text;effect uuid;old_claim uuid;
BEGIN
 PERFORM app.audit_access_order_lock();PERFORM app.access_workforce_write_lock();
 PERFORM pg_advisory_xact_lock(hashtext('audit-chain:'||app.current_tenant_id()::text));
 PERFORM pg_advisory_xact_lock(hashtextextended(app.current_tenant_id()::text||':onboarding',0));
 IF NOT app.principal_snapshot_current() OR app.current_user_id()IS NULL OR p_revision IS NULL OR p_revision<1 OR p_status IS NULL OR p_status NOT IN('todo','progress','done')THEN RAISE EXCEPTION 'This item is not available for fulfilment.'USING ERRCODE='42501';END IF;
 SELECT coalesce(p.full_name,'User '||left(u.id::text,8))INTO actor_name FROM public.app_user u LEFT JOIN public.person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id WHERE u.id=app.current_user_id()AND u.tenant_id=app.current_tenant_id()AND u.archived_at IS NULL AND NOT app.login_blocked(u.id);
 IF actor_name IS NULL THEN RAISE EXCEPTION 'This item is not available for fulfilment.'USING ERRCODE='42501';END IF;
 SELECT * INTO c FROM public.lc_onboarding_case x WHERE x.id=p_case AND x.tenant_id=app.current_tenant_id()FOR UPDATE;
 SELECT x.data INTO cfg FROM public.lc_onboarding_config x WHERE x.tenant_id=c.tenant_id;
 SELECT r,n INTO request,request_index FROM jsonb_array_elements(c.data->'requisitions')WITH ORDINALITY q(r,n)WHERE r->>'cancelledAt'IS NULL ORDER BY n LIMIT 1;
 SELECT i,n INTO target,item_index FROM jsonb_array_elements(request->'items')WITH ORDINALITY q(i,n)WHERE i->>'id'=p_item ORDER BY n LIMIT 1;
 IF c.id IS NULL OR c.data->>'state'<>'submitted'OR request IS NULL OR request->>'handedAt'IS NOT NULL OR target IS NULL OR(target->>'removed')::boolean OR target->>'approval'IN('pending','rejected','withdrawn')THEN RAISE EXCEPTION 'This item is not available for fulfilment.'USING ERRCODE='23514';END IF;
 IF NOT app.onboarding_group_member(target->>'team')THEN RAISE EXCEPTION 'Only the fulfilling team can work this item.'USING ERRCODE='42501';END IF;
 IF NOT app.function_action_allowed('lifecycle.shared.fulfilment','execute',c.company_id)THEN RAISE EXCEPTION 'Fulfilment function unavailable'USING ERRCODE='42501';END IF;
 IF c.revision<>p_revision THEN RAISE EXCEPTION 'This case changed. Reload it before trying again.'USING ERRCODE='40001';END IF;
 IF target->>'fulfilmentMethod'IS NOT NULL AND target->>'state'IN('ready','handed')THEN
  IF p_status='done'THEN RETURN QUERY SELECT c.revision,c.employment_id,c.company_id,false;RETURN;END IF;
  RAISE EXCEPTION 'Completed equipment stays on its requisition.'USING ERRCODE='40001';
 END IF;
 IF target->>'claim'IS NOT NULL AND target->>'claim'IS DISTINCT FROM app.current_user_id()::text THEN RAISE EXCEPTION 'A teammate has claimed this item.'USING ERRCODE='40001';END IF;
 old_claim:=nullif(target->>'claim','')::uuid;stamp:=to_char(clock_timestamp()AT TIME ZONE'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');history:=coalesce(c.data->'history','[]'::jsonb);
 IF p_status='todo'THEN target:=target||jsonb_build_object('state',CASE WHEN(target->>'card')::boolean AND target->>'stage'='tech'THEN'printed'ELSE'todo'END,'claim',NULL);
 ELSIF p_status='progress'THEN target:=target||jsonb_build_object('state','progress','claim',app.current_user_id());
 ELSE
  target:=target||'{"claim":null}'::jsonb;
  IF(target->>'card')::boolean AND target->>'stage'='facility'THEN
   SELECT g INTO group_row FROM jsonb_array_elements(cfg->'groups')g WHERE g->>'id'=cfg->>'techGroup';
   IF group_row IS NULL THEN RAISE EXCEPTION 'Configure the Group Tech fulfilling group before printing access cards.'USING ERRCODE='23514';END IF;
   target:=target||jsonb_build_object('state','printed','stage','tech','team',group_row->>'id');
   IF target->>'fulfilmentMethod'='rr'THEN
    join_date:=coalesce(c.data->'source'->>'joinDate',c.data->'local'->>'joinDate');due_day:=coalesce((target->>'dueDay')::integer,1);
    IF join_date IS NULL OR join_date!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$'THEN RAISE EXCEPTION 'Choose a valid join date.'USING ERRCODE='23514';END IF;
    due:=join_date::date+CASE WHEN due_day>0 THEN due_day-1 ELSE due_day END;
    SELECT u.id INTO chosen FROM jsonb_array_elements_text(group_row->'members')WITH ORDINALITY members(user_id,n)
    JOIN public.app_user u ON u.id::text=members.user_id AND u.tenant_id=c.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
    LEFT JOIN app.onboarding_assignment_loads()loads ON loads.user_id=u.id
    WHERE NOT EXISTS(SELECT 1 FROM app.onboarding_unavailable(ARRAY[due])a WHERE a.user_id=u.id)
    AND(coalesce((group_row->>'limit')::integer,0)=0 OR greatest(coalesce(loads.task_load,0)-CASE WHEN old_claim=u.id THEN 1 ELSE 0 END,0)<(group_row->>'limit')::integer)
    ORDER BY greatest(coalesce(loads.task_load,0)-CASE WHEN old_claim=u.id THEN 1 ELSE 0 END,0),members.n LIMIT 1;
    target:=target||jsonb_build_object('claim',chosen,'assignmentFailure',CASE WHEN chosen IS NULL THEN 'No eligible member is available on '||due::text||' within this team’s open-task limit.'ELSE NULL END);
    history:=history||jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'at',stamp,'by',app.current_user_id(),'name',actor_name,'action',CASE WHEN chosen IS NULL THEN'item.assignment_failed'ELSE'item.assigned'END,'detail',target->>'name'));
   END IF;
  ELSE target:=target||jsonb_build_object('state','ready','claim',CASE WHEN target->>'fulfilmentMethod'IS NOT NULL THEN app.current_user_id()ELSE NULL END);END IF;
 END IF;
 history:=history||jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'at',stamp,'by',app.current_user_id(),'name',actor_name,'action','item.status','detail',(target->>'name')||' · '||(target->>'state')));
 SELECT jsonb_agg(CASE WHEN n=item_index THEN target ELSE i END ORDER BY n)INTO items FROM jsonb_array_elements(request->'items')WITH ORDINALITY q(i,n);request:=jsonb_set(request,'{items}',items);
 SELECT jsonb_agg(CASE WHEN n=request_index THEN request ELSE r END ORDER BY n)INTO requests FROM jsonb_array_elements(c.data->'requisitions')WITH ORDINALITY q(r,n);
 effect:=app.lifecycle_native_effect_begin('assigned-onboarding-fulfil',c.id,'onboarding.fulfil');
 INSERT INTO public.lc_onboarding_case_revision(tenant_id,case_id,company_id,revision,data)VALUES(c.tenant_id,c.id,c.company_id,c.revision,c.data)ON CONFLICT DO NOTHING;
 UPDATE public.lc_onboarding_case x SET data=c.data||jsonb_build_object('requisitions',requests,'history',history),revision=c.revision+1,updated_at=clock_timestamp()WHERE x.id=c.id AND x.tenant_id=c.tenant_id;
 PERFORM app.lifecycle_native_effect_complete(effect);RETURN QUERY SELECT c.revision+1,c.employment_id,c.company_id,true;
END $$;
REVOKE ALL ON FUNCTION app.onboarding_fulfil_item(uuid,integer,text,text)FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onboarding_fulfil_item(uuid,integer,text,text)TO ai_hr_app;
--> statement-breakpoint
-- Native work metadata: only actual current team items, ready handovers, unread workflow notes
-- and unresolved mentions. No private parent or sibling task payload is returned.
CREATE FUNCTION app.onboarding_delivery_task_rows()RETURNS TABLE(task jsonb,updated_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c public.lc_onboarding_case;cfg jsonb;request jsonb;item jsonb;note public.lc_onboarding_note;facts jsonb;base jsonb;due text;claim_name text;actionable jsonb;explicit_assignment boolean;step jsonb;seen_groups text[];today date:=(now()AT TIME ZONE'Asia/Kuala_Lumpur')::date;actor uuid:=app.current_user_id();
BEGIN
 IF NOT app.principal_snapshot_current() OR NOT EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=actor AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id))THEN RETURN;END IF;
 SELECT data INTO cfg FROM public.lc_onboarding_config WHERE tenant_id=app.current_tenant_id();
 FOR c IN SELECT * FROM public.lc_onboarding_case x WHERE x.tenant_id=app.current_tenant_id()AND x.data->>'state'='submitted'ORDER BY x.id LOOP
  facts:=coalesce(c.data->'local','{}'::jsonb)||coalesce(c.data->'source','{}'::jsonb);
  base:=jsonb_build_object('caseId',c.id,'revision',c.revision,'joiner',coalesce(facts->>'fullName',''),'businessGroup',coalesce(facts->>'businessGroup',''),'joinDate',coalesce(facts->>'joinDate',''),'due',coalesce(facts->>'joinDate',''),'overdue',coalesce(facts->>'joinDate','')<>'' AND facts->>'joinDate'<today::text,'assigned',false,'tagged',false,'team',true,'bounded',true);
  SELECT r INTO request FROM jsonb_array_elements(c.data->'requisitions')WITH ORDINALITY q(r,n)WHERE r->>'cancelledAt'IS NULL ORDER BY n LIMIT 1;
  IF request IS NOT NULL AND request->>'handedAt'IS NULL THEN
   IF app.function_action_allowed('lifecycle.shared.approvalAssignments','view',c.company_id)THEN
    seen_groups:=ARRAY[]::text[];
    FOR item IN SELECT i FROM jsonb_array_elements(request->'items')i WHERE NOT(i->>'removed')::boolean LOOP
     FOR step IN SELECT s FROM jsonb_array_elements(item->'steps')WITH ORDINALITY q(s,n)WHERE item->>'approval'='pending'AND s->>'status'IN('pending','unresolved')AND coalesce((s->>'manual')::boolean,false)AND s->>'user'IS NULL AND app.onboarding_group_member(s->>'group')AND(item->>'mode'='par'OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(item->'steps')WITH ORDINALITY prior(p,m)WHERE m<n AND p->>'status'<>'approved'))ORDER BY n LOOP
      IF(step->>'id')||':'||(step->>'group')=ANY(seen_groups)THEN CONTINUE;END IF;seen_groups:=array_append(seen_groups,(step->>'id')||':'||(step->>'group'));
      task:=base||jsonb_build_object('id',c.id::text||':manualApproval:'||(item->>'id')||':'||(step->>'id'),'kind','manualApproval','title','Choose an approver: '||(step->>'label'),'itemIds',jsonb_build_array(item->>'id'),'stepId',step->>'id','canExecute',app.function_action_allowed('lifecycle.shared.approvalAssignments','execute',c.company_id));updated_at:=c.updated_at;RETURN NEXT;
     END LOOP;
    END LOOP;
   END IF;
   IF app.function_action_allowed('lifecycle.shared.approvals','view',c.company_id)THEN
    SELECT jsonb_agg(i->>'id'ORDER BY n)INTO actionable FROM jsonb_array_elements(request->'items')WITH ORDINALITY q(i,n)
    WHERE NOT(i->>'removed')::boolean AND i->>'approval'='pending'AND EXISTS(SELECT 1 FROM jsonb_array_elements(i->'steps')WITH ORDINALITY steps(s,m)WHERE s->>'status'='pending'AND(NOT coalesce((s->>'manual')::boolean,false)OR s->>'user'IS NOT NULL)AND(i->>'mode'='par'OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(i->'steps')WITH ORDINALITY prior(p,k)WHERE k<m AND p->>'status'<>'approved'))AND(s->>'user'=actor::text OR app.onboarding_group_member(s->>'group')));
    IF actionable IS NOT NULL THEN
     SELECT EXISTS(SELECT 1 FROM jsonb_array_elements(request->'items')i,jsonb_array_elements(i->'steps')WITH ORDINALITY steps(s,m)WHERE actionable?(i->>'id')AND s->>'user'=actor::text AND s->>'status'IN('pending','unresolved')AND(i->>'mode'='par'OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(i->'steps')WITH ORDINALITY prior(p,k)WHERE k<m AND p->>'status'<>'approved')))INTO explicit_assignment;
     task:=base||jsonb_build_object('id',c.id::text||':approval:'||(SELECT string_agg(value,',')FROM jsonb_array_elements_text(actionable)),'kind','approval','title','Approve '||jsonb_array_length(actionable)::text||' items','itemIds',actionable,'assigned',explicit_assignment,'canExecute',app.function_action_allowed('lifecycle.shared.approvals','approve',c.company_id));updated_at:=c.updated_at;RETURN NEXT;
    END IF;
   END IF;
   IF app.function_action_allowed('lifecycle.shared.fulfilment','view',c.company_id)THEN
    FOR item IN SELECT i FROM jsonb_array_elements(request->'items')i WHERE NOT(i->>'removed')::boolean AND i->>'approval'NOT IN('pending','rejected','withdrawn')AND i->>'state'NOT IN('ready','handed')AND app.onboarding_group_member(i->>'team')LOOP
     due:=((facts->>'joinDate')::date+CASE WHEN coalesce((item->>'dueDay')::integer,1)>0 THEN coalesce((item->>'dueDay')::integer,1)-1 ELSE coalesce((item->>'dueDay')::integer,1)END)::text;
     claim_name:=NULL;
     IF item->>'claim'IS NOT NULL THEN
      SELECT CASE WHEN p.id IS NOT NULL AND app.data_permission_person_read(p.id)THEN p.full_name ELSE'A teammate'END INTO claim_name FROM public.app_user u LEFT JOIN public.person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id WHERE u.id::text=item->>'claim'AND u.tenant_id=c.tenant_id;
     END IF;
     task:=base||jsonb_build_object('id',c.id::text||':team:'||(item->>'id'),'kind','team','canExecute',app.function_action_allowed('lifecycle.shared.fulfilment','execute',c.company_id),'title',item->>'name','itemIds',jsonb_build_array(item->>'id'),'due',due,'overdue',due<today::text,'status',CASE WHEN item->>'state'='progress'THEN'progress'ELSE'todo'END,'assigned',coalesce(item->>'claim'=actor::text,false),'locked',item->>'claim'IS NOT NULL AND item->>'claim'<>actor::text,'claimedBy',claim_name);updated_at:=c.updated_at;RETURN NEXT;
    END LOOP;
   END IF;
   IF app.function_action_allowed('lifecycle.shared.handover','view',c.company_id)AND app.onboarding_group_member(cfg->>'techGroup')AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(request->'items')i WHERE NOT(i->>'removed')::boolean AND i->>'approval'='pending')AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(request->'items')i WHERE NOT(i->>'removed')::boolean AND i->>'approval'NOT IN('pending','rejected','withdrawn')AND i->>'state'<>'ready')THEN
    task:=base||jsonb_build_object('id',c.id::text||':handover:','kind','handover','canExecute',app.function_action_allowed('lifecycle.shared.handover','execute',c.company_id),'title','Record Day 1 handover','overdue',coalesce(facts->>'joinDate','')<>'' AND facts->>'joinDate'<=today::text);updated_at:=c.updated_at;RETURN NEXT;
   END IF;
   IF app.function_action_allowed('lifecycle.shared.requisitionNotes','view',c.company_id)AND coalesce(request->>'hrNote','')<>'' AND(request->'noteAcks'->actor::text)IS DISTINCT FROM(request->'noteVersion')AND(EXISTS(SELECT 1 FROM jsonb_array_elements(request->'items')i WHERE app.onboarding_group_member(i->>'team'))OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(cfg->'exceptions'->'groups')g WHERE app.onboarding_group_member(g)))THEN
    task:=base||jsonb_build_object('id',c.id::text||':hrNote:','kind','hrNote','canExecute',app.function_action_allowed('lifecycle.shared.requisitionNotes','execute',c.company_id),'title','Read People GBS note');updated_at:=c.updated_at;RETURN NEXT;
   END IF;
  END IF;
  IF app.function_action_allowed('lifecycle.shared.conversations','view',c.company_id)THEN
   FOR note IN SELECT * FROM public.lc_onboarding_note n WHERE n.case_id=c.id AND n.tenant_id=c.tenant_id AND NOT(n.data->>'deleted')::boolean AND(c.data->>'submittedAt'IS NULL OR n.data->>'at'>=c.data->>'submittedAt')AND n.data->'mentions'?actor::text AND NOT(n.data->'resolved'?actor::text)ORDER BY n.created_at,n.id LOOP
    task:=base||jsonb_build_object('id',c.id::text||':mention:'||note.id::text,'kind','mention','canExecute',app.function_action_allowed('lifecycle.shared.conversations','execute',c.company_id),'title',(note.data->>'name')||' mentioned you','noteId',note.id,'context',note.data->>'context','assigned',true,'tagged',true,'team',false,'overdue',coalesce(facts->>'joinDate','')<>'' AND facts->>'joinDate'<=(today+coalesce((cfg->'exceptions'->>'remindDays')::integer,0))::text);updated_at:=c.updated_at;RETURN NEXT;
   END LOOP;
  END IF;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION app.onboarding_delivery_task_rows()FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onboarding_delivery_task_rows()TO ai_hr_app;
--> statement-breakpoint
--> statement-breakpoint
CREATE FUNCTION app.onboarding_checklist_task_rows()RETURNS TABLE(task jsonb,updated_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('id',r.case_id::text||':'||CASE WHEN r.task_by='joiner'AND r.gate THEN'acknowledgement'ELSE'checklist'END||':'||r.task_id,
 'caseId',r.case_id,'revision',r.revision,'kind',CASE WHEN r.task_by='joiner'AND r.gate THEN'acknowledgement'ELSE'checklist'END,'title',r.title,'joiner',r.joiner,'businessGroup',r.business_group,'joinDate',r.join_date,
 'due',coalesce(r.due_on,r.join_date),'overdue',coalesce(r.due_on,r.join_date,'')<>'' AND coalesce(r.due_on,r.join_date)<to_char(now()AT TIME ZONE'Asia/Kuala_Lumpur','YYYY-MM-DD'),
 'assigned',true,'tagged',false,'team',false,'taskId',r.task_id,'context',r.task_id,'status',r.status,'bounded',true,'canExecute',app.function_action_allowed('lifecycle.shared.tasks','execute',(SELECT c.company_id FROM public.lc_onboarding_case c WHERE c.id=r.case_id AND c.tenant_id=app.current_tenant_id())),
 'locked',coalesce(r.opens_on>to_char(now()AT TIME ZONE'Asia/Kuala_Lumpur','YYYY-MM-DD'),false)OR r.gate AND NOT coalesce(r.handed,false),
 'lockReason',CASE WHEN r.gate AND NOT coalesce(r.handed,false)THEN'After Day 1 handover'WHEN r.opens_on>to_char(now()AT TIME ZONE'Asia/Kuala_Lumpur','YYYY-MM-DD')THEN'Opens '||to_char(r.opens_on::date,'DD/MM/YYYY')ELSE NULL END),r.updated_at
 FROM app.onboarding_assigned_task_rows()r;
$$;
REVOKE ALL ON FUNCTION app.onboarding_checklist_task_rows()FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onboarding_checklist_task_rows()TO ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.onboarding_delivery_task_detail(p_task text)RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE selected jsonb;c public.lc_onboarding_case;request jsonb;body text:='';conversation jsonb:='[]'::jsonb;candidate_group text;candidates jsonb:='[]'::jsonb;catalogue_options jsonb:='[]'::jsonb;workflow_item jsonb;
BEGIN
 SELECT r.task INTO selected FROM(SELECT task FROM app.onboarding_delivery_task_rows()UNION ALL SELECT task FROM app.onboarding_checklist_task_rows()UNION ALL SELECT task FROM app.onboarding_exception_task_rows())r WHERE r.task->>'id'=p_task;
 IF selected IS NULL THEN RETURN NULL;END IF;
 SELECT * INTO c FROM public.lc_onboarding_case x WHERE x.id::text=selected->>'caseId'AND x.tenant_id=app.current_tenant_id();
 SELECT r INTO request FROM jsonb_array_elements(c.data->'requisitions')WITH ORDINALITY q(r,n)WHERE r->>'cancelledAt'IS NULL ORDER BY n LIMIT 1;
 selected:=selected||jsonb_build_object('canReply',selected->>'kind'IN('mention','checklist')AND app.function_action_allowed('lifecycle.shared.conversations','execute',c.company_id));
 IF selected->>'kind'='hrNote'THEN body:=coalesce(request->>'hrNote','');END IF;
 IF selected->>'kind'='exceptionAdd'THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',cat->>'id','name',cat->>'name','mandatory',cat->>'workflow'IS NOT NULL OR coalesce((cfg.data->'exceptions'->>'always')::boolean,false),'workflowName',(SELECT w->>'name'FROM jsonb_array_elements(cfg.data->'workflows')w WHERE w->>'id'=coalesce(cat->>'workflow',cfg.data->'exceptions'->>'workflow')))ORDER BY n),'[]')INTO catalogue_options
  FROM public.lc_onboarding_config cfg,jsonb_array_elements(cfg.data->'catalogue')WITH ORDINALITY catalogue(cat,n)WHERE cfg.tenant_id=c.tenant_id AND(cat->>'active')::boolean AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(request->'items')i WHERE(i->>'removed')::boolean IS NOT TRUE AND i->>'catalogueId'=cat->>'id');
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',d.id,'name',d.name)ORDER BY d.name,d.id),'[]')INTO candidates FROM app.onboarding_directory()d;
 ELSIF selected->>'kind'IN('exceptionRemove','keepProviding')THEN
  SELECT i INTO workflow_item FROM jsonb_array_elements(request->'items')i WHERE selected->'itemIds'?(i->>'id');body:=coalesce(workflow_item->>'reason','');
 END IF;
 IF selected->>'kind'IN('mention','checklist')THEN SELECT coalesce(jsonb_agg(n),'[]'::jsonb)INTO conversation FROM app.onboarding_conversation_rows(c.id,selected->>'context')n;END IF;
 IF selected->>'kind'='manualApproval'THEN
  SELECT step->>'group'INTO candidate_group FROM jsonb_array_elements(request->'items')i,jsonb_array_elements(i->'steps')step WHERE selected->'itemIds'?(i->>'id')AND step->>'id'=selected->>'stepId';
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',u.id,'name',CASE WHEN p.id IS NOT NULL AND app.data_permission_person_read(p.id)THEN p.full_name ELSE'User '||left(u.id::text,8)END)ORDER BY members.n),'[]'::jsonb)INTO candidates
  FROM public.lc_onboarding_config cfg,jsonb_array_elements(cfg.data->'groups')g,jsonb_array_elements_text(g->'members')WITH ORDINALITY members(user_id,n)
  JOIN public.app_user u ON u.id::text=members.user_id AND u.tenant_id=app.current_tenant_id()AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
  LEFT JOIN public.person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id WHERE cfg.tenant_id=c.tenant_id AND g->>'id'=candidate_group;
 END IF;
 RETURN jsonb_build_object('task',selected,'body',body,'notes',conversation,'requestNumber',request->>'number','candidates',candidates,'catalogue',catalogue_options,'items',CASE WHEN selected->>'kind'IN('approval','manualApproval','exceptionRemove','keepProviding')THEN(SELECT coalesce(jsonb_agg(jsonb_build_object('id',i->>'id','name',i->>'name')),'[]'::jsonb)FROM jsonb_array_elements(request->'items')i WHERE selected->'itemIds'?(i->>'id'))ELSE'[]'::jsonb END);
END $$;
REVOKE ALL ON FUNCTION app.onboarding_delivery_task_detail(text)FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onboarding_delivery_task_detail(text)TO ai_hr_app;
--> statement-breakpoint
-- Private deterministic helpers used only by native owners after their actual command admission.
CREATE FUNCTION app.onboarding_native_refresh_approval(p_item jsonb)RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_set(p_item,'{approval}',to_jsonb(CASE WHEN jsonb_array_length(p_item->'steps')=0 THEN'none'
 WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(p_item->'steps')s WHERE s->>'status'='rejected')THEN'rejected'
 WHEN NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_item->'steps')s WHERE s->>'status'<>'approved')THEN'approved'ELSE'pending'END));
$$;
REVOKE ALL ON FUNCTION app.onboarding_native_refresh_approval(jsonb)FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.onboarding_native_equipment_assignment(p_config jsonb,p_case jsonb,p_item jsonb,p_loads jsonb,p_stamp text,p_actor_name text)RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE target jsonb:=p_item;group_row jsonb;due date;due_day integer;join_date text;chosen uuid;loads jsonb:=p_loads;entry jsonb;
BEGIN
 SELECT g INTO group_row FROM jsonb_array_elements(p_config->'groups')g WHERE g->>'id'=target->>'team';
 join_date:=coalesce(p_case->'source'->>'joinDate',p_case->'local'->>'joinDate');due_day:=coalesce((target->>'dueDay')::integer,1);
 IF join_date IS NULL OR join_date!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$'THEN RAISE EXCEPTION 'Choose a valid join date.'USING ERRCODE='23514';END IF;
 due:=join_date::date+CASE WHEN due_day>0 THEN due_day-1 ELSE due_day END;
 IF due::text!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$'THEN RAISE EXCEPTION 'The equipment due date is outside the supported calendar.'USING ERRCODE='23514';END IF;
 SELECT u.id INTO chosen FROM jsonb_array_elements_text(group_row->'members')WITH ORDINALITY members(user_id,n)
 JOIN public.app_user u ON u.id::text=members.user_id AND u.tenant_id=app.current_tenant_id()AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
 LEFT JOIN app.onboarding_assignment_loads()l ON l.user_id=u.id
 WHERE NOT EXISTS(SELECT 1 FROM app.onboarding_unavailable(ARRAY[due])a WHERE a.user_id=u.id)
 AND(coalesce((group_row->>'limit')::integer,0)=0 OR coalesce(l.task_load,0)+coalesce((loads->>u.id::text)::bigint,0)<(group_row->>'limit')::integer)
 ORDER BY coalesce(l.task_load,0)+coalesce((loads->>u.id::text)::bigint,0),members.n LIMIT 1;
 target:=target||jsonb_build_object('claim',chosen,'assignmentFailure',CASE WHEN chosen IS NULL THEN'No eligible member is available on '||due::text||' within this team’s open-task limit.'ELSE NULL END);
 IF chosen IS NOT NULL THEN loads:=loads||jsonb_build_object(chosen::text,coalesce((loads->>chosen::text)::bigint,0)+1);END IF;
 entry:=jsonb_build_object('id',gen_random_uuid(),'at',p_stamp,'by',app.current_user_id(),'name',p_actor_name,'action',CASE WHEN chosen IS NULL THEN'item.assignment_failed'ELSE'item.assigned'END,'detail',target->>'name');
 RETURN jsonb_build_object('item',target,'loads',loads,'history',jsonb_build_array(entry));
END $$;
REVOKE ALL ON FUNCTION app.onboarding_native_equipment_assignment(jsonb,jsonb,jsonb,jsonb,text,text)FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.onboarding_approval_decide(p_case uuid,p_revision integer,p_items jsonb,p_decision text)
RETURNS TABLE(revision integer,employment_id uuid,company_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c public.lc_onboarding_case;cfg jsonb;request jsonb;request_index bigint;target jsonb;item_index bigint;step jsonb;step_index bigint;step_row record;decisions jsonb:='[]';choice jsonb;steps jsonb;items jsonb;requests jsonb;history jsonb;extra_loads jsonb:='{}';assigned jsonb;actor_name text;stamp text;effect uuid;auto_name text;selected_id text;
BEGIN
 PERFORM app.audit_access_order_lock();PERFORM app.access_workforce_write_lock();
 PERFORM pg_advisory_xact_lock(hashtext('audit-chain:'||app.current_tenant_id()::text));
 PERFORM pg_advisory_xact_lock(hashtextextended(app.current_tenant_id()::text||':onboarding',0));
 IF NOT app.principal_snapshot_current()OR app.current_user_id()IS NULL OR p_revision IS NULL OR p_revision<1 OR p_decision IS NULL OR p_decision NOT IN('approve','reject')OR p_items IS NULL OR jsonb_typeof(p_items)<>'array'OR jsonb_array_length(p_items)NOT BETWEEN 1 AND 500 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_items)i WHERE jsonb_typeof(i)<>'string'OR length(i#>>'{}')>100)THEN RAISE EXCEPTION 'Choose at least one approval.'USING ERRCODE='23514';END IF;
 IF(SELECT count(*)<>count(DISTINCT value)FROM jsonb_array_elements(p_items))THEN RAISE EXCEPTION 'Choose each approval item only once.'USING ERRCODE='23514';END IF;
 SELECT coalesce(p.full_name,'User '||left(u.id::text,8))INTO actor_name FROM public.app_user u LEFT JOIN public.person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id WHERE u.id=app.current_user_id()AND u.tenant_id=app.current_tenant_id()AND u.archived_at IS NULL AND NOT app.login_blocked(u.id);
 IF actor_name IS NULL THEN RAISE EXCEPTION 'This approval is not assigned or actionable for you.'USING ERRCODE='42501';END IF;
 SELECT * INTO c FROM public.lc_onboarding_case x WHERE x.id=p_case AND x.tenant_id=app.current_tenant_id()FOR UPDATE;
 SELECT data INTO cfg FROM public.lc_onboarding_config WHERE tenant_id=c.tenant_id;
 SELECT r,n INTO request,request_index FROM jsonb_array_elements(c.data->'requisitions')WITH ORDINALITY q(r,n)WHERE r->>'cancelledAt'IS NULL ORDER BY n LIMIT 1;
 IF c.id IS NULL OR c.data->>'state'<>'submitted'OR request IS NULL OR request->>'handedAt'IS NOT NULL THEN RAISE EXCEPTION 'This requisition is closed.'USING ERRCODE='23514';END IF;
 IF c.revision<>p_revision THEN RAISE EXCEPTION 'This case changed. Reload it before trying again.'USING ERRCODE='40001';END IF;
 IF NOT app.function_action_allowed('lifecycle.shared.approvals','approve',c.company_id)THEN RAISE EXCEPTION 'Approval function unavailable'USING ERRCODE='42501';END IF;
 -- Resolve every requested decision before making any logical change, matching the canonical model.
 FOR selected_id IN SELECT value FROM jsonb_array_elements_text(p_items)LOOP
  target:=NULL;step:=NULL;SELECT i,n INTO target,item_index FROM jsonb_array_elements(request->'items')WITH ORDINALITY q(i,n)WHERE i->>'id'=selected_id AND NOT(i->>'removed')::boolean ORDER BY n LIMIT 1;
  IF target IS NULL THEN RAISE EXCEPTION 'Requested item not found.'USING ERRCODE='23514';END IF;
  SELECT s,n INTO step,step_index FROM jsonb_array_elements(target->'steps')WITH ORDINALITY q(s,n)WHERE target->>'approval'='pending'AND s->>'status'IN('pending','unresolved')AND(target->>'mode'='par'OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(target->'steps')WITH ORDINALITY prior(p,m)WHERE m<n AND p->>'status'<>'approved'))AND(s->>'user'=app.current_user_id()::text OR app.onboarding_group_member(s->>'group'))ORDER BY n LIMIT 1;
  IF step IS NULL OR coalesce((step->>'manual')::boolean,false)AND step->>'user'IS NULL OR step->>'status'='unresolved'THEN RAISE EXCEPTION 'This approval is not assigned or actionable for you.'USING ERRCODE='42501';END IF;
  decisions:=decisions||jsonb_build_array(jsonb_build_object('item',item_index,'step',step_index));
 END LOOP;
 items:=request->'items';history:=coalesce(c.data->'history','[]'::jsonb);stamp:=to_char(clock_timestamp()AT TIME ZONE'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
 FOR choice IN SELECT value FROM jsonb_array_elements(decisions)LOOP
  item_index:=(choice->>'item')::bigint;step_index:=(choice->>'step')::bigint;target:=items->(item_index::integer-1);steps:=target->'steps';step:=steps->(step_index::integer-1);
  history:=history||jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'at',stamp,'by',app.current_user_id(),'name',actor_name,'action',CASE WHEN step->>'user'IS NOT NULL AND step->>'user'<>app.current_user_id()::text THEN'approval.on_behalf'ELSE'approval.decided'END,'detail',(target->>'name')||' · '||p_decision));
  step:=step||jsonb_build_object('status',CASE WHEN p_decision='approve'THEN'approved'ELSE'rejected'END,'by',app.current_user_id(),'byName',actor_name,'when',stamp);steps:=jsonb_set(steps,ARRAY[(step_index-1)::text],step);
  target:=app.onboarding_native_refresh_approval(jsonb_set(target,'{steps}',steps));
  IF p_decision='approve'THEN
   assigned:=app.onboarding_native_requester_auto_approve(target,stamp,actor_name);target:=assigned->'item';history:=history||(assigned->'history');
  END IF;
  IF target->>'fulfilmentMethod'='rr'AND target->>'claim'IS NULL AND NOT(target->>'removed')::boolean AND target->>'approval'NOT IN('pending','rejected','withdrawn')THEN
   assigned:=app.onboarding_native_equipment_assignment(cfg,c.data,target,extra_loads,stamp,actor_name);target:=assigned->'item';extra_loads:=assigned->'loads';history:=history||(assigned->'history');
  END IF;
  items:=jsonb_set(items,ARRAY[(item_index-1)::text],target);
 END LOOP;
 request:=jsonb_set(request,'{items}',items);SELECT jsonb_agg(CASE WHEN n=request_index THEN request ELSE r END ORDER BY n)INTO requests FROM jsonb_array_elements(c.data->'requisitions')WITH ORDINALITY q(r,n);
 effect:=app.lifecycle_native_effect_begin('assigned-onboarding-approval',c.id,'onboarding.approve');
 INSERT INTO public.lc_onboarding_case_revision(tenant_id,case_id,company_id,revision,data)VALUES(c.tenant_id,c.id,c.company_id,c.revision,c.data)ON CONFLICT DO NOTHING;
 UPDATE public.lc_onboarding_case x SET data=c.data||jsonb_build_object('requisitions',requests,'history',history),revision=c.revision+1,updated_at=clock_timestamp()WHERE x.id=c.id AND x.tenant_id=c.tenant_id;
 PERFORM app.lifecycle_native_effect_complete(effect);RETURN QUERY SELECT c.revision+1,c.employment_id,c.company_id;
END $$;
REVOKE ALL ON FUNCTION app.onboarding_approval_decide(uuid,integer,jsonb,text)FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onboarding_approval_decide(uuid,integer,jsonb,text)TO ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.lifecycle_approval_function_legacy_allowed(t uuid,u uuid,cap text,co uuid)RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT co IS NOT NULL AND cap IN('function.lifecycle.shared.approvals.view','function.lifecycle.shared.approvals.approve')
 AND EXISTS(SELECT 1 FROM public.app_user a WHERE a.id=u AND a.tenant_id=t AND a.archived_at IS NULL AND NOT app.login_blocked(a.id))
 AND EXISTS(SELECT 1 FROM public.lc_onboarding_case c JOIN public.lc_onboarding_config cfg ON cfg.tenant_id=c.tenant_id,jsonb_array_elements(c.data->'requisitions')r,jsonb_array_elements(r->'items')i,jsonb_array_elements(i->'steps')s
 WHERE c.tenant_id=t AND c.company_id=co AND r->>'cancelledAt'IS NULL AND(s->>'user'=u::text OR EXISTS(SELECT 1 FROM jsonb_array_elements(cfg.data->'groups')g WHERE g->>'id'=s->>'group'AND g->'members'?u::text)));
$$;
CREATE FUNCTION app.lifecycle_approval_function_current_legacy_allowed(t uuid,u uuid,cap text,co uuid)RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT t=app.current_tenant_id()AND u=app.current_user_id()AND app.lifecycle_approval_function_legacy_allowed(t,u,cap,co);
$$;
REVOKE ALL ON FUNCTION app.lifecycle_approval_function_legacy_allowed(uuid,uuid,text,uuid),app.lifecycle_approval_function_current_legacy_allowed(uuid,uuid,text,uuid)FROM PUBLIC,ai_hr_app;
DO $$DECLARE operation text;BEGIN
 FOREACH operation IN ARRAY ARRAY['view','approve']LOOP
  PERFORM app.register_function_action('lifecycle.shared.approvals',operation,'company',NULL,'app.lifecycle_approval_function_legacy_allowed','{"moduleKey":"lifecycle","labelKey":"onboardingV31.copy.c2bfc3471571e","kind":"native_acl","course":"assigned","href":"/tasks","employeeBearing":false}'::jsonb);
 END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.onboarding_native_requester_auto_approve(p_item jsonb,p_stamp text,p_actor_name text)RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE target jsonb:=p_item;steps jsonb:=p_item->'steps';step jsonb;entry record;history jsonb:='[]';auto_name text;
BEGIN
 FOR entry IN SELECT s,n FROM jsonb_array_elements(steps)WITH ORDINALITY q(s,n)LOOP
  step:=steps->(entry.n::integer-1);IF step->>'status'<>'pending'THEN CONTINUE;END IF;
  IF target->>'mode'='seq'AND EXISTS(SELECT 1 FROM jsonb_array_elements(steps)WITH ORDINALITY prior(p,m)WHERE m<entry.n AND p->>'status'<>'approved')THEN EXIT;END IF;
  IF step->>'user'=target->>'requester'THEN
   SELECT coalesce(target->>'requesterName',(SELECT d.name FROM app.onboarding_directory()d WHERE d.id::text=step->>'user'),CASE WHEN step->>'user'=app.current_user_id()::text THEN p_actor_name ELSE NULL END)INTO auto_name;
   step:=(step-'byName')||jsonb_build_object('status','approved','by',step->'user','when',p_stamp);IF auto_name IS NOT NULL THEN step:=step||jsonb_build_object('byName',auto_name);END IF;
   steps:=jsonb_set(steps,ARRAY[(entry.n-1)::text],step);
   history:=history||jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'at',p_stamp,'by',step->'user','name',coalesce(auto_name,'Requester'),'action','approval.auto_approved','detail',(target->>'name')||' · '||(step->>'label')));
  END IF;
 END LOOP;
 RETURN jsonb_build_object('item',app.onboarding_native_refresh_approval(jsonb_set(target,'{steps}',steps)),'history',history);
END $$;
REVOKE ALL ON FUNCTION app.onboarding_native_requester_auto_approve(jsonb,text,text)FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.onboarding_approval_assign(p_case uuid,p_revision integer,p_item text,p_step text,p_user text)
RETURNS TABLE(revision integer,employment_id uuid,company_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c public.lc_onboarding_case;cfg jsonb;request jsonb;request_index bigint;selected_item jsonb;selected_step jsonb;group_row jsonb;chosen uuid;item jsonb;step jsonb;item_row record;step_row record;items jsonb;steps jsonb;history jsonb;requests jsonb;extra_loads jsonb:='{}';assigned jsonb;actor_name text;stamp text;effect uuid;auto_name text;today date:=(now()AT TIME ZONE'Asia/Kuala_Lumpur')::date;
BEGIN
 PERFORM app.audit_access_order_lock();PERFORM app.access_workforce_write_lock();
 PERFORM pg_advisory_xact_lock(hashtext('audit-chain:'||app.current_tenant_id()::text));
 PERFORM pg_advisory_xact_lock(hashtextextended(app.current_tenant_id()::text||':onboarding',0));
 IF NOT app.principal_snapshot_current()OR app.current_user_id()IS NULL OR p_revision IS NULL OR p_revision<1 OR p_user IS NOT NULL AND length(p_user)>100 THEN RAISE EXCEPTION 'This approval cannot be reassigned by you.'USING ERRCODE='42501';END IF;
 SELECT coalesce(p.full_name,'User '||left(u.id::text,8))INTO actor_name FROM public.app_user u LEFT JOIN public.person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id WHERE u.id=app.current_user_id()AND u.tenant_id=app.current_tenant_id()AND u.archived_at IS NULL AND NOT app.login_blocked(u.id);
 IF actor_name IS NULL THEN RAISE EXCEPTION 'This approval cannot be reassigned by you.'USING ERRCODE='42501';END IF;
 SELECT * INTO c FROM public.lc_onboarding_case x WHERE x.id=p_case AND x.tenant_id=app.current_tenant_id()FOR UPDATE;
 SELECT data INTO cfg FROM public.lc_onboarding_config WHERE tenant_id=c.tenant_id;
 SELECT r,n INTO request,request_index FROM jsonb_array_elements(c.data->'requisitions')WITH ORDINALITY q(r,n)WHERE r->>'cancelledAt'IS NULL ORDER BY n LIMIT 1;
 SELECT i INTO selected_item FROM jsonb_array_elements(request->'items')WITH ORDINALITY q(i,n)WHERE i->>'id'=p_item ORDER BY n LIMIT 1;
 SELECT s INTO selected_step FROM jsonb_array_elements(selected_item->'steps')WITH ORDINALITY q(s,n)WHERE s->>'id'=p_step AND selected_item->>'approval'='pending'AND s->>'status'IN('pending','unresolved')AND(selected_item->>'mode'='par'OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(selected_item->'steps')WITH ORDINALITY prior(p,m)WHERE m<n AND p->>'status'<>'approved'))ORDER BY n LIMIT 1;
 IF c.id IS NULL OR c.data->>'state'<>'submitted'OR request IS NULL OR request->>'handedAt'IS NOT NULL OR selected_item IS NULL OR selected_step IS NULL OR selected_step->>'group'IS NULL OR NOT app.onboarding_group_member(selected_step->>'group')THEN RAISE EXCEPTION 'This approval cannot be reassigned by you.'USING ERRCODE='42501';END IF;
 IF c.revision<>p_revision THEN RAISE EXCEPTION 'This case changed. Reload it before trying again.'USING ERRCODE='40001';END IF;
 IF NOT app.function_action_allowed('lifecycle.shared.approvalAssignments','execute',c.company_id)THEN RAISE EXCEPTION 'Approval assignment function unavailable'USING ERRCODE='42501';END IF;
 SELECT g INTO group_row FROM jsonb_array_elements(cfg->'groups')g WHERE g->>'id'=selected_step->>'group';
 IF p_user IS NOT NULL THEN
  IF NOT(group_row->'members'?p_user)THEN RAISE EXCEPTION 'Choose a member of this approval group.'USING ERRCODE='23514';END IF;
  SELECT u.id INTO chosen FROM public.app_user u WHERE u.id::text=p_user AND u.tenant_id=c.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id);
  IF chosen IS NULL THEN RAISE EXCEPTION 'Choose an active user in this organisation.'USING ERRCODE='23514';END IF;
 ELSE
  WITH candidates AS(SELECT u.id,m.n,coalesce(l.pending_approvals,0)pending,coalesce(l.lifetime_approvals,0)lifetime FROM jsonb_array_elements_text(group_row->'members')WITH ORDINALITY m(user_id,n)
   JOIN public.app_user u ON u.id::text=m.user_id AND u.tenant_id=c.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
   LEFT JOIN app.onboarding_assignment_loads()l ON l.user_id=u.id
   WHERE u.id::text IS DISTINCT FROM selected_step->>'user'AND NOT EXISTS(SELECT 1 FROM app.onboarding_unavailable(ARRAY[today])a WHERE a.user_id=u.id))
  SELECT id INTO chosen FROM candidates WHERE id::text<>selected_item->>'requester'OR NOT EXISTS(SELECT 1 FROM candidates WHERE id::text<>selected_item->>'requester')ORDER BY pending,lifetime,n LIMIT 1;
 END IF;
 stamp:=to_char(clock_timestamp()AT TIME ZONE'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');history:=coalesce(c.data->'history','[]'::jsonb);items:=request->'items';
 FOR item_row IN SELECT i,n FROM jsonb_array_elements(items)WITH ORDINALITY q(i,n)LOOP
  item:=items->(item_row.n::integer-1);IF(item->>'removed')::boolean THEN CONTINUE;END IF;steps:=item->'steps';
  FOR step_row IN SELECT s,n FROM jsonb_array_elements(steps)WITH ORDINALITY q(s,n)LOOP
   step:=steps->(step_row.n::integer-1);
   IF step->>'group'IS DISTINCT FROM selected_step->>'group'OR step->>'status'<>'pending'THEN CONTINUE;END IF;
   step:=step||jsonb_build_object('user',chosen,'manual',chosen IS NULL AND step->>'method'='manual','fallback',chosen IS NULL AND step->>'method'='rr','unavailable',chosen IS NULL);
   IF chosen IS NOT NULL THEN step:=step||jsonb_build_object('assignments',coalesce(step->'assignments','[]'::jsonb)||jsonb_build_array(jsonb_build_object('user',chosen,'at',stamp)));END IF;
   steps:=jsonb_set(steps,ARRAY[(step_row.n-1)::text],step);
   -- Canonical requester auto-approval after each affected group assignment, preserving seq order.
   assigned:=app.onboarding_native_requester_auto_approve(jsonb_set(item,'{steps}',steps),stamp,actor_name);item:=assigned->'item';steps:=item->'steps';history:=history||(assigned->'history');
   IF item->>'fulfilmentMethod'='rr'AND item->>'claim'IS NULL AND NOT(item->>'removed')::boolean AND item->>'approval'NOT IN('pending','rejected','withdrawn')THEN
    assigned:=app.onboarding_native_equipment_assignment(cfg,c.data,item,extra_loads,stamp,actor_name);item:=assigned->'item';extra_loads:=assigned->'loads';history:=history||(assigned->'history');
   END IF;
  END LOOP;
  items:=jsonb_set(items,ARRAY[(item_row.n-1)::text],item);
 END LOOP;
 history:=history||jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'at',stamp,'by',app.current_user_id(),'name',actor_name,'action','approval.assigned','detail',selected_item->>'name'));
 request:=jsonb_set(request,'{items}',items);SELECT jsonb_agg(CASE WHEN n=request_index THEN request ELSE r END ORDER BY n)INTO requests FROM jsonb_array_elements(c.data->'requisitions')WITH ORDINALITY q(r,n);
 effect:=app.lifecycle_native_effect_begin('assigned-onboarding-approval-assignment',c.id,'onboarding.assignApproval');
 INSERT INTO public.lc_onboarding_case_revision(tenant_id,case_id,company_id,revision,data)VALUES(c.tenant_id,c.id,c.company_id,c.revision,c.data)ON CONFLICT DO NOTHING;
 UPDATE public.lc_onboarding_case x SET data=c.data||jsonb_build_object('requisitions',requests,'history',history),revision=c.revision+1,updated_at=clock_timestamp()WHERE x.id=c.id AND x.tenant_id=c.tenant_id;
 PERFORM app.lifecycle_native_effect_complete(effect);RETURN QUERY SELECT c.revision+1,c.employment_id,c.company_id;
END $$;
REVOKE ALL ON FUNCTION app.onboarding_approval_assign(uuid,integer,text,text,text)FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onboarding_approval_assign(uuid,integer,text,text,text)TO ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.lifecycle_approval_assignment_legacy_allowed(t uuid,u uuid,cap text,co uuid)RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT co IS NOT NULL AND cap IN('function.lifecycle.shared.approvalAssignments.view','function.lifecycle.shared.approvalAssignments.execute')
 AND EXISTS(SELECT 1 FROM public.app_user a WHERE a.id=u AND a.tenant_id=t AND a.archived_at IS NULL AND NOT app.login_blocked(a.id))
 AND EXISTS(SELECT 1 FROM public.lc_onboarding_case c JOIN public.lc_onboarding_config cfg ON cfg.tenant_id=c.tenant_id,jsonb_array_elements(c.data->'requisitions')r,jsonb_array_elements(r->'items')i,jsonb_array_elements(i->'steps')s,jsonb_array_elements(cfg.data->'groups')g
 WHERE c.tenant_id=t AND c.company_id=co AND r->>'cancelledAt'IS NULL AND g->>'id'=s->>'group'AND g->'members'?u::text);
$$;
CREATE FUNCTION app.lifecycle_approval_assignment_current_legacy_allowed(t uuid,u uuid,cap text,co uuid)RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT t=app.current_tenant_id()AND u=app.current_user_id()AND app.lifecycle_approval_assignment_legacy_allowed(t,u,cap,co);
$$;
REVOKE ALL ON FUNCTION app.lifecycle_approval_assignment_legacy_allowed(uuid,uuid,text,uuid),app.lifecycle_approval_assignment_current_legacy_allowed(uuid,uuid,text,uuid)FROM PUBLIC,ai_hr_app;
DO $$DECLARE operation text;BEGIN
 FOREACH operation IN ARRAY ARRAY['view','execute']LOOP
  PERFORM app.register_function_action('lifecycle.shared.approvalAssignments',operation,'company',NULL,'app.lifecycle_approval_assignment_legacy_allowed','{"moduleKey":"lifecycle","labelKey":"onboardingV31.copy.c9465f30ec600","kind":"native_acl","course":"assigned","href":"/tasks","employeeBearing":false}'::jsonb);
 END LOOP;
END $$;

--> statement-breakpoint
-- Native authority changes are control facts, not case outcomes. A same-TX revoke→restore still
-- invalidates admitted effects; ordinary task status/case updates do not invalidate themselves.
DO $$DECLARE relation_name text;BEGIN
 FOREACH relation_name IN ARRAY ARRAY['lc_staff','lc_onboarding_config','lc_v9_config','reward_member']LOOP
  EXECUTE format('CREATE TRIGGER native_access_control_epoch_insert AFTER INSERT ON public.%I REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.access_control_epoch_bump(''tenant'')',relation_name);
  EXECUTE format('CREATE TRIGGER native_access_control_epoch_update AFTER UPDATE ON public.%I REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.access_control_epoch_bump(''tenant'')',relation_name);
  EXECUTE format('CREATE TRIGGER native_access_control_epoch_delete AFTER DELETE ON public.%I REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION app.access_control_epoch_bump(''tenant'')',relation_name);
 END LOOP;
END $$;
--> statement-breakpoint
-- Canonical services already join Access before audit/onboarding/row locks. The same order holds
-- for direct application-role statements against these owned native sources; this grants no rights.
DO $$DECLARE relation_name text;BEGIN
 FOREACH relation_name IN ARRAY ARRAY['lc_onboarding_case','lc_onboarding_private','lc_onboarding_case_revision','lc_onboarding_private_revision','lc_onboarding_note','lc_v9_case','lc_v9_case_revision','lc_v9_file','lc_onboarding_config','lc_v9_config','reward_member']LOOP
  EXECUTE format('CREATE TRIGGER native_source_access_lock BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION app.notice_action_statement_lock()',relation_name);
 END LOOP;
END $$;

--> statement-breakpoint
-- The native SAVE/ACTIVE source courses require their exact same-TX Workforce receipts. They derive
-- facts itself; no caller supplies a case delta, private snapshot, role or administrative capability.
--> statement-breakpoint
CREATE FUNCTION app.onboarding_sync_draft_source(p_draft uuid,p_employment uuid,p_person uuid)
RETURNS TABLE(handled boolean,case_id uuid,company_id uuid,did_change boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE draft public.employee_draft;source_image jsonb;c public.lc_onboarding_case;cfg jsonb;
 facts jsonb;public_facts jsonb;private_facts jsonb;prior_private public.lc_onboarding_private;
 next_data jsonb;next_private jsonb;private_local jsonb;entry jsonb;resolved_roles jsonb;supervisor text;manager uuid;stamp text;source_version text;actor_name text;hr boolean;effect uuid;case_number text;subject uuid;year text;sequence_number text;
BEGIN
 PERFORM app.audit_access_order_lock();
 PERFORM app.access_workforce_write_lock();
 PERFORM pg_advisory_xact_lock(hashtext('audit-chain:'||app.current_tenant_id()::text));
 PERFORM pg_advisory_xact_lock(hashtextextended(app.current_tenant_id()::text||':onboarding',0));
 IF NOT app.principal_snapshot_current()OR app.current_user_id()IS NULL THEN RAISE EXCEPTION 'Draft source unavailable' USING ERRCODE='42501';END IF;
 SELECT d.* INTO draft FROM public.employee_draft d WHERE d.id=p_draft AND d.tenant_id=app.current_tenant_id()FOR UPDATE;
 IF(p_employment IS NULL)IS DISTINCT FROM(p_person IS NULL)THEN RAISE EXCEPTION 'Draft activation source unavailable' USING ERRCODE='42501';END IF;
 IF p_employment IS NOT NULL THEN
  IF draft.id IS NULL OR app.workforce_draft_active_admitted(p_draft,to_jsonb(draft),p_employment,p_person)IS NOT TRUE THEN RAISE EXCEPTION 'Draft activation source unavailable' USING ERRCODE='42501';END IF;
 ELSIF draft.id IS NULL OR app.workforce_draft_saved_source_allowed(p_draft,to_jsonb(draft))IS NOT TRUE THEN RETURN QUERY SELECT false,NULL::uuid,NULL::uuid,false;RETURN;END IF;
 source_image:=to_jsonb(draft);
 SELECT config.data INTO cfg FROM public.lc_onboarding_config config WHERE config.tenant_id=draft.tenant_id AND config.revision>0;
 IF cfg IS NULL OR draft.company_id IS NULL THEN RETURN QUERY SELECT true,NULL::uuid,NULL::uuid,false;RETURN;END IF;
 SELECT u_case.* INTO c FROM public.lc_onboarding_case u_case WHERE u_case.tenant_id=draft.tenant_id AND u_case.source_draft_id=p_draft FOR UPDATE;
 IF c.id IS NOT NULL AND(c.data->>'id'IS DISTINCT FROM c.id::text OR c.data->>'sourceDraftId'IS DISTINCT FROM p_draft::text OR(c.data->>'personnelStatus'='Draft'AND c.employment_id IS NULL AND c.data->>'employmentId'IS NULL AND c.data->>'personId'IS NULL OR p_employment IS NOT NULL AND c.data->>'personnelStatus'='Active'AND c.employment_id=p_employment AND c.data->>'employmentId'=p_employment::text AND c.data->>'personId'=p_person::text)IS NOT TRUE
  OR c.company_id<>draft.company_id AND NOT EXISTS(SELECT 1 FROM app.workforce_draft_mutation proof WHERE proof.xact_id=pg_current_xact_id()AND proof.tenant_id=draft.tenant_id AND proof.user_id=app.current_user_id()AND proof.draft_id=p_draft AND proof.after_source=source_image AND proof.before_source->>'company_id'=c.company_id::text))
 THEN RAISE EXCEPTION 'Draft source case changed' USING ERRCODE='42501';END IF;
 SELECT coalesce(person.full_name,'User '||left(actor.id::text,8))INTO actor_name FROM public.app_user actor LEFT JOIN public.person person ON person.id=actor.person_id AND person.tenant_id=actor.tenant_id WHERE actor.id=app.current_user_id()AND actor.tenant_id=draft.tenant_id AND actor.archived_at IS NULL AND NOT app.login_blocked(actor.id);
 IF actor_name IS NULL THEN RAISE EXCEPTION 'Your login is not available' USING ERRCODE='42501';END IF;
 -- Match native module membership directly; it is independent of a page-section grant.
 hr:=app.is_admin_for(draft.company_id)AND(coalesce((cfg->'access'->'onboarding')?app.current_user_id()::text,false)OR app.onboarding_v9_sections()IS NULL OR app.onboarding_v9_sections()->>'hr'='view');
 facts:=app.onboarding_saved_source_facts(source_image);public_facts:=facts-ARRAY['costCentre','ic','passport'];
 -- The native private snapshot contains only these three source facts.
 SELECT coalesce(jsonb_object_agg(f.key,f.value),'{}'::jsonb)INTO private_facts FROM jsonb_each(facts)f WHERE f.key IN('costCentre','ic','passport');
 source_version:=to_char(draft.updated_at AT TIME ZONE'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
 IF c.id IS NOT NULL THEN SELECT p.* INTO prior_private FROM public.lc_onboarding_private p WHERE p.case_id=c.id AND p.tenant_id=c.tenant_id FOR UPDATE;END IF;
 IF p_employment IS NULL AND c.id IS NOT NULL AND c.data->>'sourceVersion'=source_version AND c.data->'source'=public_facts AND(NOT hr OR coalesce(prior_private.data->'source','{}')=private_facts)THEN RETURN QUERY SELECT true,c.id,draft.company_id,false;RETURN;END IF;
 stamp:=to_char(clock_timestamp()AT TIME ZONE'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
 subject:=coalesce(c.id,gen_random_uuid());case_number:=c.data->>'number';
 IF nullif(case_number,'')IS NULL THEN year:=to_char(now()AT TIME ZONE'Asia/Kuala_Lumpur','YYYY');sequence_number:=app.onboarding_next_case_number(year)::text;case_number:='OB-'||year||'-'||repeat('0',greatest(4-length(sequence_number),0))||sequence_number;END IF;
 IF c.id IS NULL THEN
  next_data:=jsonb_build_object('version',1,'id',subject,'number',case_number,'sourceDraftId',p_draft,'employmentId',NULL,'personId',NULL,'personnelStatus','Draft','syncedAt',stamp,'source',public_facts,'sourceVersion',source_version,'local','{}'::jsonb,'state','pending','submittedAt',NULL,'submittedBy',NULL,'cancelReason',NULL,'hiring','','replacedEmployee','','deviceType','','floor','','notes','','selected','[]'::jsonb,'extras','[]'::jsonb,'checklistOverride',NULL,'confirmedChecklist',NULL,'reconcileNeeded',false,'tasks','[]'::jsonb,'taskHistory','[]'::jsonb,'requisitions','[]'::jsonb,'history','[]'::jsonb,'acknowledgementHistory','[]'::jsonb,'acknowledgement',NULL);
 ELSE
  next_data:=c.data||jsonb_build_object('source',public_facts,'sourceVersion',source_version,'syncedAt',stamp);
  IF c.data->>'state'='submitted'AND c.data->'source'IS DISTINCT FROM public_facts THEN next_data:=next_data||'{"reconcileNeeded":true}'::jsonb;END IF;
 END IF;
 SELECT coalesce(jsonb_object_agg(f.key,f.value),'{}'::jsonb)INTO private_local FROM jsonb_each(coalesce(next_data->'local','{}')||coalesce(prior_private.data->'local','{}'))f WHERE f.key IN('costCentre','ic','passport');
 next_private:=coalesce(prior_private.data,'{}')||jsonb_build_object('source',private_facts,'local',private_local);
 IF next_data?'caseValues' THEN next_private:=next_private||jsonb_build_object('caseValues',next_data->'caseValues');END IF;
 IF next_data?'caseContactEmail' THEN next_private:=next_private||jsonb_build_object('caseContactEmail',next_data->'caseContactEmail');END IF;
 next_data:=(next_data-ARRAY['caseValues','caseContactEmail'])||jsonb_build_object('local',coalesce(next_data->'local','{}')-ARRAY['costCentre','ic','passport']);
 IF p_employment IS NOT NULL THEN
  next_data:=next_data||jsonb_build_object('employmentId',p_employment,'personId',p_person,'personnelStatus','Active');
  supervisor:=(coalesce(next_data->'local','{}')||public_facts)->>'supervisor';
  manager:=CASE WHEN supervisor~*'^[0-9a-f]{8}-[0-9a-f-]{27}$'THEN supervisor::uuid END;
  SELECT coalesce(jsonb_object_agg(actor.kind,actor.user_id),'{}')INTO resolved_roles FROM app.onboarding_task_actors(p_person,manager)actor;
  next_data:=jsonb_set(next_data,'{tasks}',(SELECT coalesce(jsonb_agg(CASE WHEN task->>'by'<>'group'AND task->>'status'<>'done'THEN task||jsonb_build_object('assignee',resolved_roles->(task->>'by'),'failure',CASE WHEN resolved_roles->>(task->>'by')IS NULL THEN'The '||CASE WHEN task->>'by'='joiner'THEN'new joiner'ELSE'line manager'END||' needs a linked Personnel account.'END)ELSE task END ORDER BY n),'[]')FROM jsonb_array_elements(next_data->'tasks')WITH ORDINALITY tasks(task,n)));
 END IF;
 entry:=jsonb_build_object('id',gen_random_uuid(),'at',stamp,'by',app.current_user_id(),'name',actor_name,'action',CASE WHEN p_employment IS NOT NULL THEN'personnel.activated'WHEN c.id IS NULL THEN'personnel.synced'ELSE'personnel.updated'END,'detail','');
 next_data:=next_data||jsonb_build_object('history',coalesce(next_data->'history','[]')||jsonb_build_array(entry));
 IF EXISTS(SELECT 1 FROM app.lifecycle_native_effect_context context WHERE context.xact_id=pg_current_xact_id()AND context.tenant_id=draft.tenant_id AND context.user_id=app.current_user_id()AND context.active)THEN RAISE EXCEPTION 'Native source context already active' USING ERRCODE='42501';END IF;
 INSERT INTO app.lifecycle_native_effect_context(xact_id,tenant_id,user_id,purpose,case_id,event_type,source_draft_id,source_data,source_employment_id,source_person_id,authority_stamp,company_id,positive_admission)
 VALUES(pg_current_xact_id(),draft.tenant_id,app.current_user_id(),CASE WHEN p_employment IS NULL THEN'source-draft-save'ELSE'source-draft-active'END,subject,CASE WHEN p_employment IS NULL THEN'onboarding.personnel_synced'ELSE'onboarding.personnel_activated'END,p_draft,source_image,p_employment,p_person,app.access_function_authority_stamp(),draft.company_id,true)RETURNING id INTO effect;
 IF c.id IS NULL THEN
  INSERT INTO public.lc_onboarding_case(id,tenant_id,company_id,source_draft_id,employment_id,data)VALUES(subject,draft.tenant_id,draft.company_id,p_draft,p_employment,next_data);
 ELSE
  INSERT INTO public.lc_onboarding_case_revision(tenant_id,case_id,company_id,revision,data)VALUES(c.tenant_id,c.id,c.company_id,c.revision,c.data)ON CONFLICT DO NOTHING;
  IF hr AND prior_private.case_id IS NOT NULL THEN INSERT INTO public.lc_onboarding_private_revision(tenant_id,case_id,company_id,revision,data)VALUES(c.tenant_id,c.id,prior_private.company_id,c.revision,prior_private.data)ON CONFLICT DO NOTHING;END IF;
  UPDATE public.lc_onboarding_case actual SET company_id=draft.company_id,employment_id=p_employment,data=next_data,revision=c.revision+1,updated_at=clock_timestamp()WHERE actual.id=c.id AND actual.tenant_id=c.tenant_id;
 END IF;
 IF hr THEN
  INSERT INTO public.lc_onboarding_private(case_id,tenant_id,company_id,data)VALUES(subject,draft.tenant_id,draft.company_id,next_private)ON CONFLICT ON CONSTRAINT lc_onboarding_private_pkey DO UPDATE SET company_id=excluded.company_id,data=excluded.data;
  IF next_private?'lifecycleV9'AND next_private->'lifecycleV9Subject'->>'employmentId'IS NULL THEN UPDATE public.lc_onboarding_private actual SET data=jsonb_set(actual.data,'{lifecycleV9Subject}',jsonb_build_object('personId',p_person,'employmentId',p_employment),true)WHERE actual.case_id=subject AND actual.tenant_id=draft.tenant_id;END IF;
 END IF;
 PERFORM app.lifecycle_native_effect_complete(effect);
 RETURN QUERY SELECT true,subject,draft.company_id,true;
END $$;
REVOKE ALL ON FUNCTION app.onboarding_sync_draft_source(uuid,uuid,uuid)FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.onboarding_sync_saved_draft(p_draft uuid)
RETURNS TABLE(handled boolean,case_id uuid,company_id uuid,did_change boolean)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$SELECT * FROM app.onboarding_sync_draft_source(p_draft,NULL,NULL)$$;
CREATE FUNCTION app.onboarding_sync_active_draft(p_draft uuid,p_employment uuid,p_person uuid)
RETURNS TABLE(handled boolean,case_id uuid,company_id uuid,did_change boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF p_employment IS NULL OR p_person IS NULL THEN RAISE EXCEPTION 'Draft activation source unavailable' USING ERRCODE='42501';END IF;
 RETURN QUERY SELECT * FROM app.onboarding_sync_draft_source(p_draft,p_employment,p_person);
END $$;
REVOKE ALL ON FUNCTION app.onboarding_sync_saved_draft(uuid),app.onboarding_sync_active_draft(uuid,uuid,uuid)FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onboarding_sync_saved_draft(uuid),app.onboarding_sync_active_draft(uuid,uuid,uuid)TO ai_hr_app;
--> statement-breakpoint
-- A DISCARD source course derives the native M.cancelCase effects from the actual current case.
-- Only canonical native Draft DELETE authority can admit its private intent; the actual closed
-- DELETE port and matching completed audit must still occur before this transaction can commit.
CREATE FUNCTION app.onboarding_sync_discarded_draft(p_draft uuid)
RETURNS TABLE(handled boolean,case_id uuid,company_id uuid,did_change boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE draft public.employee_draft;c public.lc_onboarding_case;intent uuid;effect uuid;source_image jsonb;
 next_data jsonb;requests jsonb;request jsonb;request_index bigint;items jsonb;actor_name text;stamp text;entry jsonb;
BEGIN
 PERFORM app.audit_access_order_lock();
 PERFORM app.access_workforce_write_lock();
 PERFORM pg_advisory_xact_lock(hashtext('audit-chain:'||app.current_tenant_id()::text));
 PERFORM pg_advisory_xact_lock(hashtextextended(app.current_tenant_id()::text||':onboarding',0));
 IF NOT app.principal_snapshot_current()OR app.current_user_id()IS NULL THEN RAISE EXCEPTION 'Draft discard source unavailable' USING ERRCODE='42501';END IF;
 SELECT actual.* INTO draft FROM public.employee_draft actual WHERE actual.id=p_draft AND actual.tenant_id=app.current_tenant_id()FOR UPDATE;
 IF draft.id IS NULL OR app.access_workforce_draft_delete_allowed(p_draft)IS NOT TRUE OR app.data_permission_draft_matches(draft.tenant_id,app.current_user_id(),to_jsonb(draft))IS NOT TRUE THEN RAISE EXCEPTION 'Draft discard source unavailable' USING ERRCODE='42501';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.lc_onboarding_config cfg WHERE cfg.tenant_id=draft.tenant_id AND cfg.revision>0)THEN RETURN QUERY SELECT true,NULL::uuid,NULL::uuid,false;RETURN;END IF;
 SELECT actual.* INTO c FROM public.lc_onboarding_case actual WHERE actual.tenant_id=draft.tenant_id AND actual.source_draft_id=p_draft FOR UPDATE;
 IF c.id IS NULL THEN RETURN QUERY SELECT true,NULL::uuid,NULL::uuid,false;RETURN;END IF;
 IF c.company_id IS DISTINCT FROM draft.company_id OR c.data->>'id'IS DISTINCT FROM c.id::text OR c.data->>'sourceDraftId'IS DISTINCT FROM p_draft::text OR c.data->>'personnelStatus'IS DISTINCT FROM'Draft'OR c.employment_id IS NOT NULL OR c.data->>'employmentId'IS NOT NULL OR c.data->>'personId'IS NOT NULL THEN RAISE EXCEPTION 'Draft discard source case changed' USING ERRCODE='42501';END IF;
 SELECT coalesce(person.full_name,'User '||left(actor.id::text,8))INTO actor_name FROM public.app_user actor LEFT JOIN public.person person ON person.id=actor.person_id AND person.tenant_id=actor.tenant_id WHERE actor.id=app.current_user_id()AND actor.tenant_id=draft.tenant_id AND actor.archived_at IS NULL AND NOT app.login_blocked(actor.id);
 IF actor_name IS NULL THEN RAISE EXCEPTION 'Your login is not available' USING ERRCODE='42501';END IF;
 source_image:=to_jsonb(draft);intent:=app.workforce_draft_discard_begin(p_draft,source_image);
 stamp:=to_char(clock_timestamp()AT TIME ZONE'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');next_data:=c.data;
 IF c.data->>'state'IS DISTINCT FROM'cancelled'THEN
  SELECT r,n INTO request,request_index FROM jsonb_array_elements(c.data->'requisitions')WITH ORDINALITY all_requests(r,n)WHERE r->>'cancelledAt'IS NULL ORDER BY n LIMIT 1;
  IF request IS NOT NULL THEN
   SELECT coalesce(jsonb_agg(item||jsonb_build_object('claim',NULL,'steps',(SELECT coalesce(jsonb_agg(CASE WHEN step->>'status'IN('pending','unresolved')THEN step||'{"status":"withdrawn"}'::jsonb ELSE step END ORDER BY sn),'[]')FROM jsonb_array_elements(item->'steps')WITH ORDINALITY all_steps(step,sn)))ORDER BY n),'[]')INTO items FROM jsonb_array_elements(request->'items')WITH ORDINALITY all_items(item,n);
   request:=request||jsonb_build_object('cancelledAt',stamp,'items',items);
   SELECT jsonb_agg(CASE WHEN n=request_index THEN request ELSE r END ORDER BY n)INTO requests FROM jsonb_array_elements(c.data->'requisitions')WITH ORDINALITY all_requests(r,n);
   next_data:=next_data||jsonb_build_object('requisitions',requests);
  END IF;
  entry:=jsonb_build_object('id',gen_random_uuid(),'at',stamp,'by',app.current_user_id(),'name',actor_name,'action','case.cancelled','detail','Personnel draft discarded');
  next_data:=next_data||jsonb_build_object('state','cancelled','cancelReason','Personnel draft discarded','cancelNote','','history',coalesce(next_data->'history','[]')||jsonb_build_array(entry));
 END IF;
 -- The native discard path writes no private snapshot, and strips private public payload fields.
 next_data:=(next_data-ARRAY['caseValues','caseContactEmail'])||jsonb_build_object('source',coalesce(next_data->'source','{}')-ARRAY['costCentre','ic','passport'],'local',coalesce(next_data->'local','{}')-ARRAY['costCentre','ic','passport']);
 IF EXISTS(SELECT 1 FROM app.lifecycle_native_effect_context context WHERE context.xact_id=pg_current_xact_id()AND context.tenant_id=draft.tenant_id AND context.user_id=app.current_user_id()AND context.active)THEN RAISE EXCEPTION 'Native source context already active' USING ERRCODE='42501';END IF;
 INSERT INTO app.lifecycle_native_effect_context(xact_id,tenant_id,user_id,purpose,case_id,event_type,source_draft_id,source_data,source_intent,authority_stamp,company_id,positive_admission)
 VALUES(pg_current_xact_id(),draft.tenant_id,app.current_user_id(),'source-draft-discard',c.id,'onboarding.source_discarded',p_draft,source_image,intent,app.access_function_authority_stamp(),c.company_id,true)RETURNING id INTO effect;
 INSERT INTO public.lc_onboarding_case_revision(tenant_id,case_id,company_id,revision,data)VALUES(c.tenant_id,c.id,c.company_id,c.revision,c.data)ON CONFLICT DO NOTHING;
 UPDATE public.lc_onboarding_case actual SET data=next_data,revision=c.revision+1,updated_at=clock_timestamp()WHERE actual.id=c.id AND actual.tenant_id=c.tenant_id;
 PERFORM app.lifecycle_native_effect_complete(effect);
 RETURN QUERY SELECT true,c.id,c.company_id,true;
END $$;
REVOKE ALL ON FUNCTION app.onboarding_sync_discarded_draft(uuid)FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onboarding_sync_discarded_draft(uuid)TO ai_hr_app;

--> statement-breakpoint
-- Native exception commands have independent same-purpose courses. An administrative from-case
-- removal still needs its actual HR course and actual subject data scope; group/own courses do not
-- acquire any general case or Personnel permission.
CREATE FUNCTION app.onboarding_exception_hr_allowed(t uuid,u uuid,co uuid,claimed boolean)RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN claimed THEN t=app.current_tenant_id()AND u=app.current_user_id()AND app.is_admin_for(co)
 ELSE app.grants_admin_for((SELECT jsonb_agg(jsonb_build_object('role',r.role::text,'companyId',r.company_id))FROM public.role_assignment r WHERE r.tenant_id=t AND r.app_user_id=u),co)END
 AND EXISTS(SELECT 1 FROM public.lc_onboarding_config cfg WHERE cfg.tenant_id=t AND(
 cfg.data->'access'->'onboarding'?u::text
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(cfg.data->'groups')g WHERE cfg.data->'access'->'joinerViewGroups'?(g->>'id')AND g->'members'?u::text)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(cfg.data->'groups')g WHERE cfg.data->'access'->'joinerViewGroups'?(g->>'id')AND g->'members'?u::text AND(cfg.data->'access'->'joinerSections'->(g->>'id')->>'preset'='full'OR cfg.data->'access'->'joinerSections'->(g->>'id')->>'preset'='custom'AND cfg.data->'access'->'joinerSections'->(g->>'id')->'s'->>'hr'='view'))));
$$;
CREATE FUNCTION app.onboarding_exception_subject_allowed(t uuid,u uuid,p_case uuid)RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.lc_onboarding_case c WHERE c.id=p_case AND c.tenant_id=t AND(
 NOT EXISTS(SELECT 1 FROM public.user_data_permission_assignment a WHERE a.tenant_id=t AND a.user_id=u)
 OR c.employment_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.employment e WHERE e.id=c.employment_id AND e.tenant_id=t AND e.voided_at IS NULL AND(app.data_permission_matches_for(u,t,e.id)OR EXISTS(SELECT 1 FROM public.app_user actor WHERE actor.id=u AND actor.tenant_id=t AND actor.person_id=e.person_id)))
 OR c.employment_id IS NULL AND EXISTS(SELECT 1 FROM public.employee_draft d WHERE d.id=c.source_draft_id AND d.tenant_id=t AND d.company_id=c.company_id AND app.data_permission_draft_matches(t,u,to_jsonb(d)))));
$$;
CREATE FUNCTION app.onboarding_exception_native_allowed(t uuid,u uuid,p_case uuid,p_command text,p_item text,claimed boolean)RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.lc_onboarding_case c JOIN public.lc_onboarding_config cfg ON cfg.tenant_id=c.tenant_id
 JOIN public.app_user actor ON actor.tenant_id=c.tenant_id AND actor.id=u AND actor.archived_at IS NULL AND NOT app.login_blocked(actor.id)
 CROSS JOIN LATERAL(SELECT r FROM jsonb_array_elements(c.data->'requisitions')WITH ORDINALITY requests(r,n)WHERE r->>'cancelledAt'IS NULL ORDER BY n LIMIT 1)request
 WHERE c.tenant_id=t AND(p_case IS NULL OR c.id=p_case)AND CASE p_command
 WHEN'addItem'THEN request.r->>'handedAt'IS NULL AND EXISTS(SELECT 1 FROM jsonb_array_elements(cfg.data->'groups')g WHERE cfg.data->'exceptions'->'groups'?(g->>'id')AND g->'members'?u::text)
 WHEN'removeItem'THEN request.r->>'handedAt'IS NULL AND EXISTS(SELECT 1 FROM jsonb_array_elements(request.r->'items')i WHERE(p_item IS NULL OR i->>'id'=p_item)AND i->>'source'<>'matched'AND(i->>'addedBy'=u::text
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(cfg.data->'groups')g WHERE cfg.data->'exceptions'->'groups'?(g->>'id')AND g->'members'?u::text)))
 WHEN'removeItemHR'THEN request.r->>'handedAt'IS NULL AND EXISTS(SELECT 1 FROM jsonb_array_elements(request.r->'items')i WHERE(p_item IS NULL OR i->>'id'=p_item)AND i->>'source'<>'matched'AND coalesce((i->>'fromCase')::boolean,false)AND app.onboarding_exception_hr_allowed(t,u,c.company_id,claimed)AND app.onboarding_exception_subject_allowed(t,u,c.id))
 WHEN'keepProviding'THEN EXISTS(SELECT 1 FROM jsonb_array_elements(request.r->'items')i,jsonb_array_elements(cfg.data->'groups')g WHERE(p_item IS NULL OR i->>'id'=p_item)AND g->>'id'=i->>'team'AND g->'members'?u::text)
 ELSE false END);
$$;
REVOKE ALL ON FUNCTION app.onboarding_exception_hr_allowed(uuid,uuid,uuid,boolean),app.onboarding_exception_subject_allowed(uuid,uuid,uuid),app.onboarding_exception_native_allowed(uuid,uuid,uuid,text,text,boolean)FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.lifecycle_exception_function_legacy_allowed(t uuid,u uuid,cap text,co uuid)RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT cap IN('function.lifecycle.shared.exceptionAdditions.view','function.lifecycle.shared.exceptionAdditions.execute','function.lifecycle.shared.exceptionRemovals.view','function.lifecycle.shared.exceptionRemovals.execute','function.lifecycle.shared.retainedProvision.view','function.lifecycle.shared.retainedProvision.execute','function.lifecycle.hr.exceptionRemovals.view','function.lifecycle.hr.exceptionRemovals.execute')AND EXISTS(SELECT 1 FROM public.lc_onboarding_case c WHERE c.tenant_id=t AND c.company_id=co AND app.onboarding_exception_native_allowed(t,u,c.id,CASE WHEN cap LIKE'function.lifecycle.hr.exceptionRemovals.%'THEN'removeItemHR'WHEN split_part(cap,'.',4)='exceptionAdditions'THEN'addItem'WHEN split_part(cap,'.',4)='exceptionRemovals'THEN'removeItem'WHEN split_part(cap,'.',4)='retainedProvision'THEN'keepProviding'END,NULL,false));
$$;
CREATE FUNCTION app.lifecycle_exception_function_current_legacy_allowed(t uuid,u uuid,cap text,co uuid)RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT t=app.current_tenant_id()AND u=app.current_user_id()AND app.lifecycle_exception_function_legacy_allowed(t,u,cap,co)AND EXISTS(SELECT 1 FROM public.lc_onboarding_case c WHERE c.tenant_id=t AND c.company_id=co AND app.onboarding_exception_native_allowed(t,u,c.id,CASE WHEN cap LIKE'function.lifecycle.hr.exceptionRemovals.%'THEN'removeItemHR'WHEN split_part(cap,'.',4)='exceptionAdditions'THEN'addItem'WHEN split_part(cap,'.',4)='exceptionRemovals'THEN'removeItem'WHEN split_part(cap,'.',4)='retainedProvision'THEN'keepProviding'END,NULL,true));
$$;
REVOKE ALL ON FUNCTION app.lifecycle_exception_function_legacy_allowed(uuid,uuid,text,uuid),app.lifecycle_exception_function_current_legacy_allowed(uuid,uuid,text,uuid)FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.lifecycle_exception_hr_delegation_allowed(t uuid,u uuid,cap text,co uuid)RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT cap IN('lifecycle.view','lifecycle.edit')AND app.lifecycle_exception_function_current_legacy_allowed(t,u,'function.lifecycle.hr.exceptionRemovals.'||CASE WHEN cap='lifecycle.view'THEN'view'ELSE'execute'END,co);
$$;
REVOKE ALL ON FUNCTION app.lifecycle_exception_hr_delegation_allowed(uuid,uuid,text,uuid)FROM PUBLIC,ai_hr_app;
DO $$DECLARE key text;operation text;label text;BEGIN
 FOREACH key IN ARRAY ARRAY['lifecycle.shared.exceptionAdditions','lifecycle.shared.exceptionRemovals','lifecycle.shared.retainedProvision','lifecycle.hr.exceptionRemovals']LOOP
  label:=CASE key WHEN'lifecycle.shared.exceptionAdditions'THEN'onboardingV31.copy.cd1a0b329a72b'WHEN'lifecycle.shared.exceptionRemovals'THEN'onboardingV31.copy.c5a89edf2867d'WHEN'lifecycle.hr.exceptionRemovals'THEN'onboardingV31.copy.c5a89edf2867d'ELSE'onboardingV31.copy.c42ab73c14173'END;
  FOREACH operation IN ARRAY ARRAY['view','execute']LOOP
   PERFORM app.register_function_action(key,operation,'company',CASE WHEN key='lifecycle.hr.exceptionRemovals'THEN CASE WHEN operation='view'THEN'lifecycle.view'ELSE'lifecycle.edit'END END,CASE WHEN key='lifecycle.hr.exceptionRemovals'THEN'app.lifecycle_exception_hr_delegation_allowed'ELSE'app.lifecycle_exception_function_legacy_allowed'END,jsonb_build_object('moduleKey','lifecycle','labelKey',label,'kind','native_acl','course',CASE WHEN key='lifecycle.hr.exceptionRemovals'THEN'administrative'ELSE'assigned'END,'href','/tasks','employeeBearing',key='lifecycle.hr.exceptionRemovals'));
  END LOOP;
 END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.onboarding_exception_routing(p_config jsonb,p_definition jsonb,p_case jsonb)RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE routing jsonb;chosen jsonb;group_row jsonb;fallback jsonb;fallback_group jsonb;facts jsonb:=coalesce(p_case->'local','{}')||coalesce(p_case->'source','{}');today date:=(now()AT TIME ZONE'Asia/Kuala_Lumpur')::date;
BEGIN
 IF p_definition->>'type'='person'THEN RETURN '{"group":null,"viaDefault":null,"unavailable":false}';END IF;
 IF p_definition->>'type'='group'THEN SELECT g INTO group_row FROM jsonb_array_elements(p_config->'groups')g WHERE g->>'id'=p_definition->>'target';RETURN jsonb_build_object('group',group_row->>'id','viaDefault',NULL,'unavailable',false);END IF;
 SELECT r INTO routing FROM jsonb_array_elements(p_config->'routings')r WHERE r->>'id'=p_definition->>'target';
 SELECT r INTO chosen FROM jsonb_array_elements(routing->'rows')WITH ORDINALITY routing_rows(r,n)
 WHERE NOT EXISTS(SELECT 1 FROM jsonb_each(r->'rules')rule WHERE jsonb_array_length(rule.value)>0 AND NOT(rule.value?coalesce(facts->>rule.key,'')))
 ORDER BY(SELECT count(*)FROM jsonb_each(r->'rules')rule WHERE jsonb_array_length(rule.value)>0)DESC,n LIMIT 1;
 IF chosen IS NULL THEN RETURN '{"group":null,"viaDefault":null,"unavailable":true}';END IF;
 SELECT g INTO group_row FROM jsonb_array_elements(p_config->'groups')g WHERE g->>'id'=chosen->>'group';
 IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(group_row->'members')m JOIN public.app_user u ON u.id::text=m AND u.tenant_id=app.current_tenant_id()AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)WHERE NOT EXISTS(SELECT 1 FROM app.onboarding_unavailable(ARRAY[today])a WHERE a.user_id=u.id))THEN RETURN jsonb_build_object('group',group_row->>'id','viaDefault',NULL,'unavailable',false);END IF;
 SELECT r INTO fallback FROM jsonb_array_elements(routing->'rows')WITH ORDINALITY routing_rows(r,n)WHERE NOT EXISTS(SELECT 1 FROM jsonb_each(r->'rules')rule WHERE jsonb_array_length(rule.value)>0)ORDER BY n LIMIT 1;
 SELECT g INTO fallback_group FROM jsonb_array_elements(p_config->'groups')g WHERE g->>'id'=fallback->>'group';
 IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(fallback_group->'members')m JOIN public.app_user u ON u.id::text=m AND u.tenant_id=app.current_tenant_id()AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)WHERE NOT EXISTS(SELECT 1 FROM app.onboarding_unavailable(ARRAY[today])a WHERE a.user_id=u.id))THEN RETURN jsonb_build_object('group',fallback_group->>'id','viaDefault',coalesce(group_row->>'name','Unavailable group'),'unavailable',false);END IF;
 RETURN jsonb_build_object('group',group_row->>'id','viaDefault',NULL,'unavailable',true);
END $$;
CREATE FUNCTION app.onboarding_exception_choose_approver(p_config jsonb,p_group text,p_requester uuid,p_extra jsonb)RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH candidates AS(SELECT u.id,m.n,coalesce(l.pending_approvals,0)+coalesce((p_extra->>u.id::text)::bigint,0)pending,coalesce(l.lifetime_approvals,0)+coalesce((p_extra->>u.id::text)::bigint,0)lifetime
 FROM jsonb_array_elements(p_config->'groups')g,jsonb_array_elements_text(g->'members')WITH ORDINALITY m(user_id,n)
 JOIN public.app_user u ON u.id::text=m.user_id AND u.tenant_id=app.current_tenant_id()AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
 LEFT JOIN app.onboarding_assignment_loads()l ON l.user_id=u.id WHERE g->>'id'=p_group AND NOT EXISTS(SELECT 1 FROM app.onboarding_unavailable(ARRAY[(now()AT TIME ZONE'Asia/Kuala_Lumpur')::date])a WHERE a.user_id=u.id))
 SELECT c.id FROM candidates c WHERE c.id<>p_requester OR NOT EXISTS(SELECT 1 FROM candidates other WHERE other.id<>p_requester)ORDER BY c.pending,c.lifetime,c.n LIMIT 1;
$$;
REVOKE ALL ON FUNCTION app.onboarding_exception_routing(jsonb,jsonb,jsonb),app.onboarding_exception_choose_approver(jsonb,text,uuid,jsonb)FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Preserve storeTx's JSON.stringify(case).length budget for the native Case contract: its
-- numeric fields are safe integers, while source/custom form values and timestamps are strings.
-- Count compact JSON and UTF-16 units, including supplementary characters, without exposing it.
CREATE FUNCTION app.onboarding_native_case_size(p_value jsonb)RETURNS bigint
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE total bigint:=2;entry record;first_item boolean:=true;encoded text;number_value numeric;
BEGIN
 CASE jsonb_typeof(p_value)
 WHEN'object'THEN
  FOR entry IN SELECT key,value FROM jsonb_each(p_value)LOOP
   total:=total+CASE WHEN first_item THEN 0 ELSE 1 END+app.onboarding_native_case_size(to_jsonb(entry.key))+1+app.onboarding_native_case_size(entry.value);first_item:=false;IF total>10000000 THEN RETURN total;END IF;
  END LOOP;RETURN total;
 WHEN'array'THEN
  FOR entry IN SELECT value FROM jsonb_array_elements(p_value)LOOP
   total:=total+CASE WHEN first_item THEN 0 ELSE 1 END+app.onboarding_native_case_size(entry.value);first_item:=false;IF total>10000000 THEN RETURN total;END IF;
  END LOOP;RETURN total;
 WHEN'number'THEN
  number_value:=(p_value#>>'{}')::numeric;
  IF number_value<>trunc(number_value)OR abs(number_value)>9007199254740991 THEN RAISE EXCEPTION 'Unsupported native case number' USING ERRCODE='23514';END IF;
  RETURN length(trunc(number_value)::text);
 ELSE
  encoded:=p_value::text;
  RETURN char_length(encoded)+char_length(regexp_replace(encoded COLLATE "C",U&'[^\+010000-\+10FFFF]','','g'));
 END CASE;
END $$;
REVOKE ALL ON FUNCTION app.onboarding_native_case_size(jsonb)FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.onboarding_exception_update(p_case uuid,p_revision integer,p_command text,p_payload jsonb)
RETURNS TABLE(revision integer,employment_id uuid,company_id uuid,function_key text,native_branch text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c public.lc_onboarding_case;cfg jsonb;request jsonb;request_index bigint;target jsonb;item_index bigint;catalogue jsonb;v9_projection jsonb;effect uuid;workflow_id text;workflow jsonb;definition jsonb;resolved jsonb;chosen uuid;manual boolean;extra_loads jsonb:='{}';assigned jsonb;items jsonb;requests jsonb;history jsonb;entry jsonb;actor_name text;confirmed_name text;stamp text;purpose text;key text;native_command text;action text;next_data jsonb;
BEGIN
 PERFORM app.audit_access_order_lock();PERFORM app.access_workforce_write_lock();
 PERFORM pg_advisory_xact_lock(hashtext('audit-chain:'||app.current_tenant_id()::text));
 PERFORM pg_advisory_xact_lock(hashtextextended(app.current_tenant_id()::text||':onboarding',0));
 IF NOT app.principal_snapshot_current()OR app.current_user_id()IS NULL OR p_revision IS NULL OR p_revision<1 OR p_command IS NULL OR p_command NOT IN('addItem','removeItem','keepProviding')OR p_payload IS NULL OR jsonb_typeof(p_payload)<>'object'THEN RAISE EXCEPTION 'Exception command unavailable' USING ERRCODE='42501';END IF;
 IF p_command='addItem'THEN
  IF NOT app.access_command_keys(p_payload,ARRAY['catalogueId','reason','approval','confirmedBy'])OR jsonb_typeof(p_payload->'catalogueId')IS DISTINCT FROM'string'OR length(p_payload->>'catalogueId')NOT BETWEEN 1 AND 100 OR jsonb_typeof(p_payload->'reason')IS DISTINCT FROM'string'OR length(p_payload->>'reason')>2000 OR length(btrim(p_payload->>'reason',U&'\0020\0009\000A\000B\000C\000D\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'))=0 OR jsonb_typeof(p_payload->'approval')IS DISTINCT FROM'boolean'OR NOT(p_payload?'confirmedBy')OR jsonb_typeof(p_payload->'confirmedBy')NOT IN('string','null')OR length(coalesce(p_payload->>'confirmedBy','x'))NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Choose an item and a reason' USING ERRCODE='23514';END IF;
 ELSE
  IF NOT app.access_command_keys(p_payload,ARRAY['itemId'])OR jsonb_typeof(p_payload->'itemId')IS DISTINCT FROM'string'OR length(p_payload->>'itemId')NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Choose an item' USING ERRCODE='23514';END IF;
 END IF;
 SELECT actual.* INTO c FROM public.lc_onboarding_case actual WHERE actual.id=p_case AND actual.tenant_id=app.current_tenant_id()FOR UPDATE;
 native_command:=p_command;
 -- Select the actual native branch before consulting its function cell. A denied shared course
 -- never falls back to the HR cell merely because the same actor also has an HR grant.
 IF p_command='removeItem'AND app.onboarding_exception_native_allowed(c.tenant_id,app.current_user_id(),c.id,'removeItem',p_payload->>'itemId',true)IS NOT TRUE THEN native_command:='removeItemHR';END IF;
 IF c.id IS NULL OR app.onboarding_exception_native_allowed(c.tenant_id,app.current_user_id(),c.id,native_command,p_payload->>'itemId',true)IS NOT TRUE THEN RAISE EXCEPTION 'This exception command is not assigned to you' USING ERRCODE='42501';END IF;
 IF c.revision<>p_revision THEN RAISE EXCEPTION 'This case changed. Reload it before trying again.'USING ERRCODE='40001';END IF;
 key:=CASE native_command WHEN'addItem'THEN'lifecycle.shared.exceptionAdditions'WHEN'removeItem'THEN'lifecycle.shared.exceptionRemovals'WHEN'removeItemHR'THEN'lifecycle.hr.exceptionRemovals'ELSE'lifecycle.shared.retainedProvision'END;
 IF app.function_action_allowed(key,'execute',c.company_id)IS NOT TRUE THEN RAISE EXCEPTION 'Exception function unavailable'USING ERRCODE='42501';END IF;
 SELECT data INTO cfg FROM public.lc_onboarding_config WHERE tenant_id=c.tenant_id;
 v9_projection:=app.onboarding_v9_checklists();IF v9_projection IS NOT NULL THEN cfg:=cfg||jsonb_build_object('v9ChecklistRevision',v9_projection->'revision');END IF;
 SELECT coalesce(person.full_name,'User '||left(actor.id::text,8))INTO actor_name FROM public.app_user actor LEFT JOIN public.person person ON person.id=actor.person_id AND person.tenant_id=actor.tenant_id WHERE actor.id=app.current_user_id()AND actor.tenant_id=c.tenant_id AND actor.archived_at IS NULL AND NOT app.login_blocked(actor.id);
 SELECT r,n INTO request,request_index FROM jsonb_array_elements(c.data->'requisitions')WITH ORDINALITY all_requests(r,n)WHERE r->>'cancelledAt'IS NULL ORDER BY n LIMIT 1;
 stamp:=to_char(clock_timestamp()AT TIME ZONE'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');history:=coalesce(c.data->'history','[]');next_data:=c.data;
 IF p_command='addItem'THEN
  SELECT item INTO catalogue FROM jsonb_array_elements(cfg->'catalogue')item WHERE item->>'id'=p_payload->>'catalogueId';
  IF catalogue IS NULL OR(catalogue->>'active')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'This catalogue item is retired or unavailable.'USING ERRCODE='23514';END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(request->'items')item WHERE(item->>'removed')::boolean IS NOT TRUE AND item->>'catalogueId'=catalogue->>'id')THEN RAISE EXCEPTION 'This item is already requested.'USING ERRCODE='23514';END IF;
  IF p_payload->>'confirmedBy'IS NOT NULL THEN
   SELECT CASE WHEN person.id IS NOT NULL AND app.data_permission_person_read(person.id)THEN coalesce(person.full_name,'User '||left(actor.id::text,8))ELSE'User '||left(actor.id::text,8)END INTO confirmed_name FROM public.app_user actor LEFT JOIN public.person person ON person.id=actor.person_id AND person.tenant_id=actor.tenant_id WHERE actor.id::text=p_payload->>'confirmedBy'AND actor.tenant_id=c.tenant_id AND actor.archived_at IS NULL AND NOT app.login_blocked(actor.id);
   IF NOT FOUND THEN RAISE EXCEPTION 'Choose a current confirming user.'USING ERRCODE='23514';END IF;
  END IF;
  workflow_id:=coalesce(catalogue->>'workflow',CASE WHEN(p_payload->>'approval')::boolean OR(cfg->'exceptions'->>'always')::boolean THEN cfg->'exceptions'->>'workflow'END);
  SELECT value INTO workflow FROM jsonb_array_elements(cfg->'workflows')WHERE value->>'id'=workflow_id;
  IF workflow_id IS NOT NULL AND workflow IS NULL THEN RAISE EXCEPTION 'The approval workflow is unavailable. Update settings before requesting this item.'USING ERRCODE='23514';END IF;
  target:=jsonb_build_object('id',gen_random_uuid(),'catalogueId',catalogue->>'id','name',catalogue->>'name','type',catalogue->>'type','team',catalogue->>'team','card',catalogue->'card','source','exception','fromCase',false,'addedBy',app.current_user_id(),'addedByName',actor_name,'requesterName',actor_name,'confirmedByName',confirmed_name,'workflowName',workflow->>'name','requester',app.current_user_id(),'confirmedBy',p_payload->>'confirmedBy','reason',p_payload->>'reason','workflowId',workflow_id,'mode',coalesce(workflow->>'mode','seq'),'steps','[]'::jsonb,'approval','none','state','todo','stage',CASE WHEN(catalogue->>'card')::boolean THEN'facility'ELSE'tech'END,'claim',NULL,'removed',false,'retiredFlag',false,'revokeNeeded',false);
  FOR definition IN SELECT value FROM jsonb_array_elements(coalesce(workflow->'steps','[]'))LOOP
   resolved:=app.onboarding_exception_routing(cfg,definition,c.data);manual:=definition->>'type'<>'person'AND definition->>'method'='manual';chosen:=NULL;
   IF definition->>'type'='person'THEN SELECT actor.id INTO chosen FROM public.app_user actor WHERE actor.id::text=definition->>'target'AND actor.tenant_id=c.tenant_id AND actor.archived_at IS NULL AND NOT app.login_blocked(actor.id);
   ELSIF NOT manual THEN
    SELECT actor.id INTO chosen FROM jsonb_array_elements((target->'steps')||(SELECT coalesce(jsonb_agg(step ORDER BY item_n,step_n),'[]')FROM jsonb_array_elements(request->'items')WITH ORDINALITY all_items(item,item_n),jsonb_array_elements(item->'steps')WITH ORDINALITY all_steps(step,step_n)))WITH ORDINALITY all_shared(step,n)
    JOIN public.app_user actor ON actor.id::text=step->>'user'AND actor.tenant_id=c.tenant_id AND actor.archived_at IS NULL AND NOT app.login_blocked(actor.id)
    WHERE step->>'group'=resolved->>'group'AND step->>'status'NOT IN('withdrawn','unresolved')ORDER BY CASE WHEN step->>'status'='pending'THEN 0 ELSE 1 END,n LIMIT 1;
    IF chosen IS NULL AND resolved->>'group'IS NOT NULL THEN chosen:=app.onboarding_exception_choose_approver(cfg,resolved->>'group',app.current_user_id(),extra_loads);END IF;
   END IF;
   entry:=definition||jsonb_build_object('group',resolved->'group','user',chosen,'status',CASE WHEN definition->>'type'='person'AND chosen IS NULL OR definition->>'type'<>'person'AND resolved->>'group'IS NULL THEN'unresolved'ELSE'pending'END,'manual',manual,'fallback',NOT manual AND resolved->>'group'IS NOT NULL AND chosen IS NULL,'viaDefault',resolved->'viaDefault','unavailable',resolved->'unavailable','by',NULL,'when',NULL,'assignments',CASE WHEN chosen IS NULL THEN'[]'::jsonb ELSE jsonb_build_array(jsonb_build_object('user',chosen,'at',stamp))END);
   target:=jsonb_set(target,'{steps}',(target->'steps')||jsonb_build_array(entry));
   IF chosen IS NOT NULL THEN extra_loads:=extra_loads||jsonb_build_object(chosen::text,coalesce((extra_loads->>chosen::text)::bigint,0)+1);END IF;
  END LOOP;
  IF cfg->>'v9ChecklistRevision'IS NOT NULL THEN target:=target||jsonb_build_object('team',coalesce(c.data->'equipmentOverrides'->(catalogue->>'id')->>'group',target->>'team'),'fulfilmentMethod',coalesce(c.data->'equipmentOverrides'->(catalogue->>'id')->>'method','rr'),'dueDay',coalesce((c.data->'equipmentOverrides'->(catalogue->>'id')->>'due')::integer,-1));END IF;
  assigned:=app.onboarding_native_requester_auto_approve(target,stamp,actor_name);target:=assigned->'item';history:=history||(assigned->'history');
  IF target->>'fulfilmentMethod'='rr'AND target->>'approval'NOT IN('pending','rejected','withdrawn')THEN assigned:=app.onboarding_native_equipment_assignment(cfg,c.data,target,'{}',stamp,actor_name);target:=assigned->'item';history:=history||(assigned->'history');END IF;
  items:=(request->'items')||jsonb_build_array(target);action:='item.added';purpose:='assigned-onboarding-exception-add';
 ELSE
  SELECT item,n INTO target,item_index FROM jsonb_array_elements(request->'items')WITH ORDINALITY all_items(item,n)WHERE item->>'id'=p_payload->>'itemId'ORDER BY n LIMIT 1;
  IF p_command='removeItem'THEN
   target:=target||jsonb_build_object('removed',true,'revokeNeeded',target->>'state'IN('ready','printed','handed'),'claim',NULL,'steps',(SELECT coalesce(jsonb_agg(CASE WHEN step->>'status'IN('pending','unresolved')THEN step||'{"status":"withdrawn"}'::jsonb ELSE step END ORDER BY n),'[]')FROM jsonb_array_elements(target->'steps')WITH ORDINALITY all_steps(step,n)),'approval',CASE WHEN target->>'approval'='pending'THEN'withdrawn'ELSE target->>'approval'END);
   IF(target->>'fromCase')::boolean THEN next_data:=next_data||jsonb_build_object('selected',(SELECT coalesce(jsonb_agg(item ORDER BY n),'[]')FROM jsonb_array_elements(c.data->'selected')WITH ORDINALITY selections(item,n)WHERE item#>>'{}'<>target->>'catalogueId'),'extras',(SELECT coalesce(jsonb_agg(item ORDER BY n),'[]')FROM jsonb_array_elements(c.data->'extras')WITH ORDINALITY extras(item,n)WHERE item->>'catalogueId'<>target->>'catalogueId'));END IF;
   action:=CASE WHEN(target->>'revokeNeeded')::boolean THEN'item.removed_revoke_needed'ELSE'item.removed'END;purpose:=CASE WHEN native_command='removeItemHR'THEN'administrative-onboarding-exception-remove'ELSE'assigned-onboarding-exception-remove'END;
  ELSE target:=target||'{"retiredFlag":false}'::jsonb;action:='item.kept';purpose:='assigned-onboarding-keep-providing';END IF;
  SELECT jsonb_agg(CASE WHEN n=item_index THEN target ELSE item END ORDER BY n)INTO items FROM jsonb_array_elements(request->'items')WITH ORDINALITY all_items(item,n);
 END IF;
 entry:=jsonb_build_object('id',gen_random_uuid(),'at',stamp,'by',app.current_user_id(),'name',actor_name,'action',action,'detail',target->>'name');history:=history||jsonb_build_array(entry);
 request:=jsonb_set(request,'{items}',items);SELECT jsonb_agg(CASE WHEN n=request_index THEN request ELSE r END ORDER BY n)INTO requests FROM jsonb_array_elements(c.data->'requisitions')WITH ORDINALITY all_requests(r,n);
 next_data:=next_data||jsonb_build_object('requisitions',requests,'history',history);
 IF app.onboarding_native_case_size(next_data)>10000000 THEN RAISE EXCEPTION 'This update is too large.'USING ERRCODE='23514';END IF;
 effect:=app.lifecycle_native_effect_begin(purpose,c.id,'onboarding.'||p_command);
 INSERT INTO public.lc_onboarding_case_revision(tenant_id,case_id,company_id,revision,data)VALUES(c.tenant_id,c.id,c.company_id,c.revision,c.data)ON CONFLICT DO NOTHING;
 UPDATE public.lc_onboarding_case actual SET data=next_data,revision=c.revision+1,updated_at=clock_timestamp()WHERE actual.id=c.id AND actual.tenant_id=c.tenant_id;
 PERFORM app.lifecycle_native_effect_complete(effect);
 RETURN QUERY SELECT c.revision+1,c.employment_id,c.company_id,key,purpose;
END $$;
REVOKE ALL ON FUNCTION app.onboarding_exception_update(uuid,integer,text,jsonb)FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onboarding_exception_update(uuid,integer,text,jsonb)TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.onboarding_exception_task_rows()RETURNS TABLE(task jsonb,updated_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c public.lc_onboarding_case;cfg jsonb;request jsonb;item jsonb;facts jsonb;base jsonb;removal_key text;actor uuid:=app.current_user_id();
BEGIN
 IF NOT app.principal_snapshot_current()OR NOT EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=actor AND u.tenant_id=app.current_tenant_id()AND u.archived_at IS NULL AND NOT app.login_blocked(u.id))THEN RETURN;END IF;
 SELECT data INTO cfg FROM public.lc_onboarding_config WHERE tenant_id=app.current_tenant_id();
 FOR c IN SELECT * FROM public.lc_onboarding_case actual WHERE actual.tenant_id=app.current_tenant_id()ORDER BY actual.id LOOP
  SELECT r INTO request FROM jsonb_array_elements(c.data->'requisitions')WITH ORDINALITY all_requests(r,n)WHERE r->>'cancelledAt'IS NULL ORDER BY n LIMIT 1;
  IF request IS NULL THEN CONTINUE;END IF;
  facts:=coalesce(c.data->'local','{}')||coalesce(c.data->'source','{}');
  base:=jsonb_build_object('caseId',c.id,'revision',c.revision,'joiner',coalesce(facts->>'fullName',''),'businessGroup',coalesce(facts->>'businessGroup',''),'joinDate',coalesce(facts->>'joinDate',''),'due','','overdue',false,'assigned',false,'tagged',false,'team',true,'bounded',true);
  IF app.onboarding_exception_native_allowed(c.tenant_id,actor,c.id,'addItem',NULL,true)AND app.function_action_allowed('lifecycle.shared.exceptionAdditions','view',c.company_id)AND EXISTS(SELECT 1 FROM jsonb_array_elements(cfg->'catalogue')catalogue WHERE(catalogue->>'active')::boolean AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(request->'items')i WHERE(i->>'removed')::boolean IS NOT TRUE AND i->>'catalogueId'=catalogue->>'id'))THEN
   task:=base||jsonb_build_object('id',c.id::text||':exceptionAdd:','kind','exceptionAdd','title','Add item','canExecute',app.function_action_allowed('lifecycle.shared.exceptionAdditions','execute',c.company_id));updated_at:=c.updated_at;RETURN NEXT;
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(request->'items')LOOP
   removal_key:=NULL;
   IF app.onboarding_exception_native_allowed(c.tenant_id,actor,c.id,'removeItem',item->>'id',true)THEN removal_key:='lifecycle.shared.exceptionRemovals';
   ELSIF app.onboarding_exception_native_allowed(c.tenant_id,actor,c.id,'removeItemHR',item->>'id',true)THEN removal_key:='lifecycle.hr.exceptionRemovals';END IF;
   IF(item->>'removed')::boolean IS NOT TRUE AND removal_key IS NOT NULL AND app.function_action_allowed(removal_key,'view',c.company_id)THEN
    task:=base||jsonb_build_object('id',c.id::text||':exceptionRemove:'||(item->>'id'),'kind','exceptionRemove','title','Remove item','itemIds',jsonb_build_array(item->>'id'),'assigned',item->>'addedBy'=actor::text,'canExecute',app.function_action_allowed(removal_key,'execute',c.company_id));updated_at:=c.updated_at;RETURN NEXT;
   END IF;
   IF coalesce((item->>'retiredFlag')::boolean,false)AND app.onboarding_exception_native_allowed(c.tenant_id,actor,c.id,'keepProviding',item->>'id',true)AND app.function_action_allowed('lifecycle.shared.retainedProvision','view',c.company_id)THEN
    task:=base||jsonb_build_object('id',c.id::text||':keepProviding:'||(item->>'id'),'kind','keepProviding','title','Keep providing','itemIds',jsonb_build_array(item->>'id'),'canExecute',app.function_action_allowed('lifecycle.shared.retainedProvision','execute',c.company_id));updated_at:=c.updated_at;RETURN NEXT;
   END IF;
  END LOOP;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION app.onboarding_exception_task_rows()FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onboarding_exception_task_rows()TO ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.lifecycle_recovery_function_legacy_allowed(t uuid,u uuid,cap text,co uuid)RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT cap IN('function.lifecycle.shared.recovery.view','function.lifecycle.shared.recovery.execute')AND EXISTS(
 SELECT 1 FROM public.lc_v9_case c JOIN public.app_user actor ON actor.id=u AND actor.tenant_id=c.tenant_id AND actor.archived_at IS NULL AND NOT app.login_blocked(actor.id)
 CROSS JOIN LATERAL jsonb_array_elements(c.data->'items')i WHERE c.tenant_id=t AND c.company_id=co AND c.module='off'AND i->>'assignee'=u::text
 AND(cap='function.lifecycle.shared.recovery.view'OR c.data->>'state'='submitted'AND EXISTS(SELECT 1 FROM public.lc_onboarding_config cfg,jsonb_array_elements(cfg.data->'groups')g WHERE cfg.tenant_id=t AND g->>'id'=i->>'group'AND g->'members'?u::text)));
$$;
CREATE FUNCTION app.lifecycle_recovery_function_current_legacy_allowed(t uuid,u uuid,cap text,co uuid)RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT t=app.current_tenant_id()AND u=app.current_user_id()AND app.lifecycle_recovery_function_legacy_allowed(t,u,cap,co);
$$;
REVOKE ALL ON FUNCTION app.lifecycle_recovery_function_legacy_allowed(uuid,uuid,text,uuid),app.lifecycle_recovery_function_current_legacy_allowed(uuid,uuid,text,uuid)FROM PUBLIC,ai_hr_app;
DO $$DECLARE operation text;BEGIN
 FOREACH operation IN ARRAY ARRAY['view','execute']LOOP
  PERFORM app.register_function_action('lifecycle.shared.recovery',operation,'company',NULL,'app.lifecycle_recovery_function_legacy_allowed','{"moduleKey":"lifecycle","labelKey":"onboardingV31.copy.caseReturnRevoke","kind":"native_acl","course":"assigned","href":"/me/lifecycle","employeeBearing":false}'::jsonb);
 END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.lifecycle_holding_recovery_pending(p_source uuid,p_request text,p_item text,p_exit uuid,p_exit_item text,p_exit_revision integer)RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current()AND EXISTS(SELECT 1 FROM app.lifecycle_native_effect_context context
 JOIN app.lifecycle_holding_recovery_admission admission ON admission.context_id=context.id
 JOIN app.lifecycle_native_effect_receipt receipt ON receipt.context_id=context.id
 JOIN public.lc_onboarding_case source ON source.id=context.case_id AND source.tenant_id=context.tenant_id
 WHERE context.xact_id=pg_current_xact_id()AND context.tenant_id=app.current_tenant_id()AND context.user_id=app.current_user_id()AND context.purpose='assigned-onboarding-holding-recovery'AND context.case_id=p_source AND context.completed AND NOT context.active
 AND context.function_key='lifecycle.shared.recovery'AND context.positive_admission AND context.authority_stamp=app.access_function_authority_stamp()AND app.function_action_denial_clear('lifecycle.shared.recovery','execute',context.company_id)
 AND admission.offboarding_case_id=p_exit AND admission.offboarding_item_id=p_exit_item AND admission.offboarding_revision=p_exit_revision AND admission.request_id=p_request AND admission.item_id=p_item
 AND receipt.table_name='lc_onboarding_case'AND receipt.row_id=source.id::text AND source.company_id=admission.company_id AND source.employment_id=admission.employment_id
 AND EXISTS(SELECT 1 FROM public.domain_event event WHERE event.tenant_id=context.tenant_id AND event.aggregate_id=context.case_id AND event.event_type=context.event_type AND event.actor_type='user'AND event.actor_id=context.user_id AND event.payload->>'functionKey'=context.function_key AND event.payload->>'nativeBranch'=context.purpose AND app.lifecycle_row_in_transaction('domain_event',event.id,to_jsonb(event))));
$$;
REVOKE ALL ON FUNCTION app.lifecycle_holding_recovery_pending(uuid,text,text,uuid,text,integer)FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.onboarding_recover_assigned_holding(p_exit uuid,p_revision integer,p_exit_item text,p_source uuid,p_request text,p_item text,p_employment uuid,p_company uuid,p_reason text)
RETURNS TABLE(source_case_id uuid,employment_id uuid,company_id uuid,did_change boolean,event_type text,function_key text,native_branch text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE scope jsonb;off_case public.lc_v9_case;c public.lc_onboarding_case;request jsonb;request_index bigint;item jsonb;item_index bigint;items jsonb;requests jsonb;next_data jsonb;effect uuid;actor_name text;stamp text;reason text;outcome text;recovery jsonb;entry jsonb;
BEGIN
 PERFORM app.audit_access_order_lock();PERFORM app.access_workforce_write_lock();
 PERFORM pg_advisory_xact_lock(hashtext('audit-chain:'||app.current_tenant_id()::text));
 PERFORM pg_advisory_xact_lock(hashtextextended(app.current_tenant_id()::text||':onboarding',0));
 PERFORM pg_advisory_xact_lock(hashtextextended('lifecycle-v9:'||app.current_tenant_id()::text,0));
 IF NOT app.principal_snapshot_current()OR app.current_user_id()IS NULL OR p_reason IS NULL OR length(p_reason)>4000 OR p_request IS NULL OR length(p_request)NOT BETWEEN 1 AND 100 OR p_item IS NULL OR length(p_item)NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Recovery work unavailable'USING ERRCODE='42501';END IF;
 scope:=app.lc_v9_assigned_item(p_exit,p_revision,p_exit_item);
 IF scope->>'companyId'IS DISTINCT FROM p_company::text OR scope->>'employmentId'IS DISTINCT FROM p_employment::text OR scope->'item'->'nativeSource'->>'caseId'IS DISTINCT FROM p_source::text OR scope->'item'->'nativeSource'->>'requestId'IS DISTINCT FROM p_request OR scope->'item'->'nativeSource'->>'itemId'IS DISTINCT FROM p_item THEN RAISE EXCEPTION 'The open offboarding case does not contain this issued item.'USING ERRCODE='40001';END IF;
 IF app.function_action_allowed('lifecycle.shared.recovery','execute',p_company)IS NOT TRUE THEN RAISE EXCEPTION 'Recovery function unavailable'USING ERRCODE='42501';END IF;
 SELECT actual.* INTO off_case FROM public.lc_v9_case actual WHERE actual.id=p_exit AND actual.tenant_id=app.current_tenant_id();
 SELECT actual.* INTO c FROM public.lc_onboarding_case actual WHERE actual.id=p_source AND actual.tenant_id=app.current_tenant_id()AND actual.company_id=p_company AND actual.employment_id=p_employment FOR UPDATE;
 IF c.id IS NULL THEN RAISE EXCEPTION 'The issuing onboarding record is no longer linked to this employment.'USING ERRCODE='40001';END IF;
 SELECT r,n INTO request,request_index FROM jsonb_array_elements(c.data->'requisitions')WITH ORDINALITY all_requests(r,n)WHERE r->>'id'=p_request ORDER BY n LIMIT 1;
 SELECT i,n INTO item,item_index FROM jsonb_array_elements(request->'items')WITH ORDINALITY all_items(i,n)WHERE i->>'id'=p_item ORDER BY n LIMIT 1;
 IF item IS NULL OR NOT(item->>'state'='handed'AND request->>'handedAt'IS NOT NULL OR coalesce((item->>'revokeNeeded')::boolean,false))THEN RAISE EXCEPTION 'The original item is no longer recorded as issued. Review the holding before closing it.'USING ERRCODE='40001';END IF;
 IF item->'recovery'IS NOT NULL AND item->'recovery'<>'null'::jsonb THEN
  IF item->'recovery'->>'offboardingCaseId'=p_exit::text THEN RETURN QUERY SELECT c.id,c.employment_id,c.company_id,false,NULL::text,'lifecycle.shared.recovery'::text,'assigned-onboarding-holding-recovery'::text;RETURN;END IF;
  RAISE EXCEPTION 'Another case has already recorded this item recovery.'USING ERRCODE='40001';
 END IF;
 IF coalesce(scope->'item'->>'status','')NOT IN('todo','progress')OR item->>'team'IS DISTINCT FROM scope->'item'->>'group'OR app.onboarding_group_member(item->>'team')IS NOT TRUE THEN RAISE EXCEPTION 'The issuing providing team changed. Review the recovery assignment.'USING ERRCODE='40001';END IF;
 SELECT coalesce(person.full_name,'User '||left(actor.id::text,8))INTO actor_name FROM public.app_user actor LEFT JOIN public.person person ON person.id=actor.person_id AND person.tenant_id=actor.tenant_id WHERE actor.id=app.current_user_id()AND actor.tenant_id=c.tenant_id AND actor.archived_at IS NULL AND NOT app.login_blocked(actor.id);
 IF actor_name IS NULL THEN RAISE EXCEPTION 'Your login is not available'USING ERRCODE='42501';END IF;
 stamp:=to_char(clock_timestamp()AT TIME ZONE'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
 reason:=btrim(p_reason,U&'\0020\0009\000A\000B\000C\000D\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF');outcome:=CASE WHEN item->>'type'='system'THEN'revoked'ELSE'returned'END;
 recovery:=jsonb_build_object('offboardingCaseId',p_exit,'outcome',outcome,'at',stamp,'by',app.current_user_id(),'reason',reason);
 item:=item||jsonb_build_object('recovery',recovery,'revokeNeeded',false);
 SELECT jsonb_agg(CASE WHEN n=item_index THEN item ELSE i END ORDER BY n)INTO items FROM jsonb_array_elements(request->'items')WITH ORDINALITY all_items(i,n);
 request:=jsonb_set(request,'{items}',items);SELECT jsonb_agg(CASE WHEN n=request_index THEN request ELSE r END ORDER BY n)INTO requests FROM jsonb_array_elements(c.data->'requisitions')WITH ORDINALITY all_requests(r,n);
 entry:=jsonb_build_object('id',gen_random_uuid(),'at',stamp,'by',app.current_user_id(),'name',actor_name,'action','holding.'||outcome,'detail',(item->>'name')||' · confirmed by the assigned providing team on offboarding case '||p_exit::text||CASE WHEN reason<>''THEN' · '||reason ELSE''END);
 next_data:=(c.data-ARRAY['caseValues','caseContactEmail'])||jsonb_build_object('source',coalesce(c.data->'source','{}')-ARRAY['costCentre','ic','passport'],'local',coalesce(c.data->'local','{}')-ARRAY['costCentre','ic','passport'],'requisitions',requests,'history',coalesce(c.data->'history','[]')||jsonb_build_array(entry));
 IF app.onboarding_native_case_size(next_data)>10000000 THEN RAISE EXCEPTION 'This update is too large.'USING ERRCODE='23514';END IF;
 effect:=app.lifecycle_native_effect_begin('assigned-onboarding-holding-recovery',c.id,'onboarding.holding_'||outcome);
 INSERT INTO app.lifecycle_holding_recovery_admission(context_id,offboarding_case_id,offboarding_item_id,offboarding_revision,offboarding_before_hash,request_id,item_id,employment_id,company_id,team,offboarding_reason)
 VALUES(effect,p_exit,p_exit_item,p_revision,encode(sha256(convert_to(to_jsonb(off_case)::text,'UTF8')),'hex'),p_request,p_item,p_employment,p_company,scope->'item'->>'group',trim(p_reason));
 INSERT INTO public.lc_onboarding_case_revision(tenant_id,case_id,company_id,revision,data)VALUES(c.tenant_id,c.id,c.company_id,c.revision,c.data)ON CONFLICT DO NOTHING;
 UPDATE public.lc_onboarding_case actual SET data=next_data,revision=c.revision+1,updated_at=clock_timestamp()WHERE actual.id=c.id AND actual.tenant_id=c.tenant_id;
 PERFORM app.lifecycle_native_effect_complete(effect);
 RETURN QUERY SELECT c.id,c.employment_id,c.company_id,true,'onboarding.holding_'||outcome,'lifecycle.shared.recovery'::text,'assigned-onboarding-holding-recovery'::text;
END $$;
REVOKE ALL ON FUNCTION app.onboarding_recover_assigned_holding(uuid,integer,text,uuid,text,text,uuid,uuid,text)FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onboarding_recover_assigned_holding(uuid,integer,text,uuid,text,text,uuid,uuid,text)TO ai_hr_app;
--> statement-breakpoint
-- Append exact source-owner changes without rewriting the immutable original V9 migrations.
DO $recovery_owners$
DECLARE body text;anchor text;replacement text;signature text;
BEGIN
 signature:='app.lc_v9_assigned_item(uuid,integer,text)';body:=pg_get_functiondef(signature::regprocedure);
 anchor:=' RETURN jsonb_build_object(''companyId'',c.company_id';
 IF strpos(body,anchor)=0 OR strpos(substr(body,strpos(body,anchor)+length(anchor)),anchor)>0 OR strpos(body,'Recovery view unavailable')>0 THEN RAISE EXCEPTION 'Native recovery scope owner changed';END IF;
 body:=replace(body,anchor,E' IF NOT app.function_action_allowed(''lifecycle.shared.recovery'',''view'',c.company_id)THEN RAISE EXCEPTION ''Recovery view unavailable'' USING ERRCODE=''42501'';END IF;\n'||anchor);EXECUTE body;
 signature:='app.lc_v9_fulfil_item(uuid,integer,text,text,text)';body:=pg_get_functiondef(signature::regprocedure);
 anchor:=' scope:=app.lc_v9_assigned_item(p_case,p_revision,p_item);item:=scope->''item'';';
 IF strpos(body,anchor)=0 OR strpos(substr(body,strpos(body,anchor)+length(anchor)),anchor)>0 OR strpos(body,'Recovery function unavailable')>0 THEN RAISE EXCEPTION 'Native return command owner changed';END IF;
 body:=replace(body,anchor,anchor||E'\n IF NOT app.function_action_allowed(''lifecycle.shared.recovery'',''execute'',(scope->>''companyId'')::uuid)THEN RAISE EXCEPTION ''Recovery function unavailable'' USING ERRCODE=''42501'';END IF;');
 anchor:='n.xmin::text=pg_current_xact_id()::text';
 IF strpos(body,anchor)=0 OR strpos(substr(body,strpos(body,anchor)+length(anchor)),anchor)>0 THEN RAISE EXCEPTION 'Native issuing confirmation witness changed';END IF;
 -- Physical native intent replaces tuple xmin, which is a subtransaction ID under SAVEPOINT.
 body:=replace(body,anchor,'app.lifecycle_holding_recovery_pending(n.id,r->>''id'',i->>''id'',p_case,p_item,p_revision)');EXECUTE body;
 signature:='app.lc_v9_work(uuid)';body:=pg_get_functiondef(signature::regprocedure);
 anchor:='WHERE c.tenant_id=app.current_tenant_id() AND app.current_user_id() IS NOT NULL';
 IF strpos(body,anchor)=0 OR strpos(substr(body,strpos(body,anchor)+length(anchor)),anchor)>0 THEN RAISE EXCEPTION 'Native work principal boundary changed';END IF;
 body:=replace(body,anchor,'WHERE c.tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() AND app.current_user_id() IS NOT NULL');
 anchor:='WHERE app.function_action_allowed(''lifecycle.shared.tasks'',''view'',a.company_id) AND (t->>''assignee''=a.uid OR a.own AND t->>''by''=''employee'')';
 IF strpos(body,anchor)=0 OR strpos(substr(body,strpos(body,anchor)+length(anchor)),anchor)>0 THEN RAISE EXCEPTION 'Native assigned task read owner changed';END IF;
 body:=replace(body,anchor,'WHERE (t->>''assignee''=a.uid AND app.function_action_allowed(''lifecycle.shared.tasks'',''view'',a.company_id) OR a.own AND t->>''by''=''employee'')');
 anchor:='i->>''assignee''=a.uid AND app.onboarding_group_member(i->>''group'')';
 IF strpos(body,anchor)=0 OR strpos(substr(body,strpos(body,anchor)+length(anchor)),anchor)>0 THEN RAISE EXCEPTION 'Native return execution projection changed';END IF;
 body:=replace(body,anchor,anchor||' AND app.function_action_allowed(''lifecycle.shared.recovery'',''execute'',a.company_id)');
 anchor:='WHERE a.own OR i->>''assignee''=a.uid';
 IF strpos(body,anchor)=0 OR strpos(substr(body,strpos(body,anchor)+length(anchor)),anchor)>0 THEN RAISE EXCEPTION 'Native assigned return read owner changed';END IF;
 body:=replace(body,anchor,'WHERE a.own OR i->>''assignee''=a.uid AND(a.module<>''off'' OR app.function_action_allowed(''lifecycle.shared.recovery'',''view'',a.company_id))');
 anchor:='''facts'',(data->''facts'')-ARRAY[''finalConfirmationDate'',''confirmationDate'',''probationEndDate'',''provisionalEndOn'']';
 IF strpos(body,anchor)=0 OR strpos(substr(body,strpos(body,anchor)+length(anchor)),anchor)>0 THEN RAISE EXCEPTION 'Native assigned return fact projection changed';END IF;
 replacement:='''facts'',CASE WHEN own OR module<>''off'' THEN(data->''facts'')-ARRAY[''finalConfirmationDate'',''confirmationDate'',''probationEndDate'',''provisionalEndOn''] ELSE jsonb_build_object(''name'',data->''facts''->>''name'',''employeeNo'',data->''facts''->>''employeeNo'',''joinDate'',data->''facts''->>''joinDate'',''lastDay'',data->''facts''->>''lastDay'')END';
 body:=replace(body,anchor,replacement);EXECUTE body;
END $recovery_owners$;
--> statement-breakpoint
-- Assigned Rewards membership owns work on an existing recipient's entry, never permission to
-- substitute a different employment/person under that entry's history and recommendations.
-- Source refreshes may change pay/classification snapshots; their recipient identity is stable.
CREATE FUNCTION app.reward_entry_recipient_guard()RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.access_workforce_storage_owner()THEN RETURN NEW;END IF;
 IF NOT app.principal_snapshot_current()OR app.current_user_id()IS NULL
  OR OLD.tenant_id IS DISTINCT FROM app.current_tenant_id()OR NEW.tenant_id IS DISTINCT FROM app.current_tenant_id()
  OR ROW(NEW.id,NEW.tenant_id,NEW.unit_id,NEW.employment_id,NEW.created_at)IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.unit_id,OLD.employment_id,OLD.created_at)
  OR NEW.source->'employmentId'IS DISTINCT FROM OLD.source->'employmentId'
  OR NEW.source->'personId'IS DISTINCT FROM OLD.source->'personId'
 THEN RAISE EXCEPTION 'Reward recipient identity is immutable' USING ERRCODE='42501';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.reward_entry_recipient_guard()FROM PUBLIC,ai_hr_app;
CREATE TRIGGER reward_entry_recipient_guard BEFORE UPDATE ON public.reward_entry FOR EACH ROW EXECUTE FUNCTION app.reward_entry_recipient_guard();
-- Join the same authority lock before a direct participant statement acquires any entry row lock.
CREATE TRIGGER reward_entry_recipient_lock BEFORE UPDATE ON public.reward_entry FOR EACH STATEMENT EXECUTE FUNCTION app.notice_action_statement_lock();
--> statement-breakpoint
-- A membership is attached to one saved company/business-unit review. It cannot carry the
-- same historical decisions, funding and recipients into a different owner or annual cycle.
CREATE FUNCTION app.reward_unit_identity_guard()RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.access_workforce_storage_owner()THEN RETURN NEW;END IF;
 IF NOT app.principal_snapshot_current()OR app.current_user_id()IS NULL
  OR OLD.tenant_id IS DISTINCT FROM app.current_tenant_id()OR NEW.tenant_id IS DISTINCT FROM app.current_tenant_id()
  OR ROW(NEW.id,NEW.tenant_id,NEW.company_id,NEW.business_unit_id,NEW.cycle_id,NEW.kind,NEW.parent_unit_id,NEW.created_by,NEW.created_at)
   IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.company_id,OLD.business_unit_id,OLD.cycle_id,OLD.kind,OLD.parent_unit_id,OLD.created_by,OLD.created_at)
 THEN RAISE EXCEPTION 'Reward review ownership is immutable' USING ERRCODE='42501';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.reward_unit_identity_guard()FROM PUBLIC,ai_hr_app;
CREATE TRIGGER reward_unit_identity_guard BEFORE UPDATE ON public.reward_unit FOR EACH ROW EXECUTE FUNCTION app.reward_unit_identity_guard();
CREATE TRIGGER reward_unit_identity_lock BEFORE UPDATE ON public.reward_unit FOR EACH STATEMENT EXECUTE FUNCTION app.notice_action_statement_lock();
--> statement-breakpoint
-- Repeat the native recommendation admission for direct row writers. This protects the OLD
-- recipient/classification as well as its proposed classification; it is not source-refresh or
-- general classification authority. Those separate mutation courses retain their native owners.
CREATE FUNCTION app.reward_entry_recommendation_guard()RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE unit public.reward_unit;roles text[];actor_id uuid;actor_person uuid;old_visible boolean;next_visible boolean;can_edit boolean;
BEGIN
 IF app.access_workforce_storage_owner()OR NEW.recommendation IS NOT DISTINCT FROM OLD.recommendation THEN RETURN NEW;END IF;
 IF NOT app.principal_snapshot_current()OR app.current_user_id()IS NULL OR OLD.tenant_id IS DISTINCT FROM app.current_tenant_id()OR NEW.tenant_id IS DISTINCT FROM app.current_tenant_id()THEN RAISE EXCEPTION 'Reward recommendation unavailable' USING ERRCODE='42501';END IF;
 SELECT actual.* INTO unit FROM public.reward_unit actual WHERE actual.id=OLD.unit_id AND actual.tenant_id=OLD.tenant_id;
 SELECT actor.id,actor.person_id INTO actor_id,actor_person FROM public.app_user actor WHERE actor.id=app.current_user_id()AND actor.tenant_id=OLD.tenant_id AND actor.archived_at IS NULL AND NOT app.login_blocked(actor.id);
 roles:=ARRAY(SELECT app.reward_roles(OLD.unit_id));
 old_visible:=actor_id IS NOT NULL AND OLD.source->>'personId'IS DISTINCT FROM actor_person::text
  AND(OLD.facts->>'reviewed'='true'OR'gr'=ANY(roles))
  AND CASE OLD.facts->>'confidentiality'WHEN'ec'THEN roles&&ARRAY['gr','ctro','ec']WHEN'bg'THEN EXISTS(SELECT 1 FROM unnest(roles)r WHERE r NOT IN('bu','pbp'))WHEN'standard'THEN true ELSE false END;
 next_visible:=actor_id IS NOT NULL AND NEW.source->>'personId'IS DISTINCT FROM actor_person::text
  AND(NEW.facts->>'reviewed'='true'OR'gr'=ANY(roles))
  AND CASE NEW.facts->>'confidentiality'WHEN'ec'THEN roles&&ARRAY['gr','ctro','ec']WHEN'bg'THEN EXISTS(SELECT 1 FROM unnest(roles)r WHERE r NOT IN('bu','pbp'))WHEN'standard'THEN true ELSE false END;
 can_edit:=unit.status='draft'AND(roles&&ARRAY['bu','gr']OR unit.kind<>'annual'AND'bg'=ANY(roles)OR OLD.facts->>'confidentiality'='ec'AND roles&&ARRAY['gr','ctro','ec']);
 IF unit.id IS NULL OR unit.deleted_at IS NOT NULL OR cardinality(roles)=0 OR old_visible IS NOT TRUE OR next_visible IS NOT TRUE OR can_edit IS NOT TRUE
  OR(OLD.facts->>'confidentiality'<>'ec'AND coalesce(NEW.recommendation->'bonusCents','null'::jsonb)<>'null'::jsonb)
  OR NEW.facts->'seniorPlan'IS DISTINCT FROM OLD.facts->'seniorPlan'
  OR(NEW.facts IS DISTINCT FROM OLD.facts AND NOT('gr'=ANY(roles))AND(NOT('bu'=ANY(roles))OR(NEW.facts-ARRAY['erDecision','pipDecision','caseReason'])IS DISTINCT FROM(OLD.facts-ARRAY['erDecision','pipDecision','caseReason'])))
 THEN RAISE EXCEPTION 'Reward recommendation unavailable' USING ERRCODE='42501';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.reward_entry_recommendation_guard()FROM PUBLIC,ai_hr_app;
CREATE TRIGGER reward_entry_recommendation_guard BEFORE UPDATE ON public.reward_entry FOR EACH ROW EXECUTE FUNCTION app.reward_entry_recommendation_guard();
--> statement-breakpoint
-- Private deterministic calculation kernel. NUMERIC intermediates implement the native BigInt
-- quotient, including half-up rounding, without floating-point or bigint multiplication overflow.
-- No application-role EXECUTE: only bounded actual-unit owners may consume unredacted results.
CREATE FUNCTION app.reward_calc_integer(p_value numeric,p_nonnegative boolean DEFAULT false)RETURNS numeric
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF p_value IS NULL OR p_value<>trunc(p_value)OR abs(p_value)>9007199254740991 OR p_nonnegative AND p_value<0 THEN RAISE EXCEPTION 'Invalid reward arithmetic input' USING ERRCODE='22003';END IF;
 RETURN p_value;
END $$;
CREATE FUNCTION app.reward_calc_ratio(n numeric,a numeric,b numeric,p_nearest boolean DEFAULT false)RETURNS numeric
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM app.reward_calc_integer(n,true),app.reward_calc_integer(a,true),app.reward_calc_integer(b,true);
 IF b=0 THEN RAISE EXCEPTION 'Invalid reward arithmetic input' USING ERRCODE='22003';END IF;
 RETURN app.reward_calc_integer(div(n*a+CASE WHEN p_nearest THEN div(b,2)ELSE 0 END,b),true);
END $$;
CREATE FUNCTION app.reward_calc_increase(cents numeric,bp numeric)RETURNS numeric
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.reward_calc_ratio(cents,bp,1000000,true)*100;
$$;
CREATE FUNCTION app.reward_calc_units(value text)RETURNS bigint
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT char_length(value)+char_length(regexp_replace(value COLLATE "C",U&'[^\+010000-\+10FFFF]','','g'));
$$;
CREATE FUNCTION app.reward_calc_text(p_value jsonb,p_limit integer,p_default text DEFAULT NULL)RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE value text;units bigint;
BEGIN
 IF p_value IS NULL AND p_default IS NOT NULL THEN value:=p_default;
 ELSIF jsonb_typeof(p_value)='string'THEN value:=p_value#>>'{}';
 ELSE RAISE EXCEPTION 'Invalid reward text input' USING ERRCODE='22023';END IF;
 value:=app.reward_access_reason_trim(value);
 -- Zod string min/max count code points; explicit JS .length owners retain reward_calc_units.
 units:=char_length(value);
 IF units>p_limit THEN RAISE EXCEPTION 'Invalid reward text input' USING ERRCODE='22023';END IF;
 RETURN value;
END $$;
CREATE FUNCTION app.reward_calc_recommendation(p jsonb)RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE k text;maximum numeric;result jsonb:=p;value numeric;
BEGIN
 IF jsonb_typeof(p)IS DISTINCT FROM'object'OR EXISTS(SELECT 1 FROM jsonb_object_keys(p)fields(key_name) WHERE fields.key_name<>ALL(ARRAY['meritBp','promotionGrade','promotionBp','specialBp','multiplierBp','bonusCents','lumpCents','reason','currentRoleSummary','proposedRoleSummary']))THEN RAISE EXCEPTION 'Invalid reward recommendation' USING ERRCODE='22023';END IF;
 FOREACH k IN ARRAY ARRAY['meritBp','promotionBp','specialBp','multiplierBp','bonusCents','lumpCents']LOOP
  IF NOT(p?k)THEN RAISE EXCEPTION 'Invalid reward recommendation' USING ERRCODE='22023';END IF;
  IF p->k<>'null'::jsonb THEN
   IF jsonb_typeof(p->k)<>'number'THEN RAISE EXCEPTION 'Invalid reward recommendation' USING ERRCODE='22023';END IF;
   value:=app.reward_calc_integer((p->>k)::numeric,true);maximum:=CASE WHEN k IN('bonusCents','lumpCents')THEN 100000000000 ELSE 100000 END;
   IF value>maximum THEN RAISE EXCEPTION 'Invalid reward recommendation' USING ERRCODE='22023';END IF;
  END IF;
 END LOOP;
 IF NOT(p?'promotionGrade')THEN RAISE EXCEPTION 'Invalid reward recommendation' USING ERRCODE='22023';END IF;
 IF p->'promotionGrade'<>'null'::jsonb THEN result:=jsonb_set(result,'{promotionGrade}',to_jsonb(app.reward_calc_text(p->'promotionGrade',30)));END IF;
 result:=result||jsonb_build_object('reason',app.reward_calc_text(p->'reason',4000),'currentRoleSummary',app.reward_calc_text(p->'currentRoleSummary',8000,''),'proposedRoleSummary',app.reward_calc_text(p->'proposedRoleSummary',8000,''));
 RETURN result;
END $$;
CREATE FUNCTION app.reward_calc_facts(p jsonb)RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE k text;
BEGIN
 IF jsonb_typeof(p)IS DISTINCT FROM'object'OR EXISTS(SELECT 1 FROM jsonb_object_keys(p)fields(key_name) WHERE fields.key_name<>ALL(ARRAY['talent','performance','confidentiality','seniorPlan','erCase','pipCase','erDecision','pipDecision','caseReason','segment','branch','reviewed']))THEN RAISE EXCEPTION 'Invalid reward facts' USING ERRCODE='22023';END IF;
 IF NOT(p?'talent')OR NOT(p?'performance')OR(p->'talent'<>'null'::jsonb AND(p->>'talent')<>ALL(ARRAY['SSTAR','STAR','SCORE','IMPRO','PIP']))OR(p->'performance'<>'null'::jsonb AND(p->>'performance')<>ALL(ARRAY['UA','BE','ME','AE','OU']))
  OR coalesce(p->>'confidentiality','')<>ALL(ARRAY['standard','bg','ec'])OR coalesce(p->>'erDecision','')<>ALL(ARRAY['pending','in','out'])OR coalesce(p->>'pipDecision','')<>ALL(ARRAY['pending','lift','confirm'])THEN RAISE EXCEPTION 'Invalid reward facts' USING ERRCODE='22023';END IF;
 FOREACH k IN ARRAY ARRAY['seniorPlan','erCase','pipCase','reviewed']LOOP
  IF jsonb_typeof(p->k)IS DISTINCT FROM'boolean'THEN RAISE EXCEPTION 'Invalid reward facts' USING ERRCODE='22023';END IF;
 END LOOP;
 RETURN p||jsonb_build_object('caseReason',app.reward_calc_text(p->'caseReason',3000),'segment',app.reward_calc_text(p->'segment',80),'branch',app.reward_calc_text(p->'branch',100));
END $$;
CREATE FUNCTION app.reward_calc_blank_budget()RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT '{"excludedCount":0,"excludedPayrollCents":0,"payrollCents":0,"pools":[0,0,0],"used":[0,0,0],"bonusPayrollCents":0,"bonusPoolCents":0,"bonusUsedCents":0,"standardBonusCents":0,"increasesCents":0,"reductionsCents":0,"lumpCents":0,"lumpCount":0,"balanceCents":0}'::jsonb;
$$;
CREATE FUNCTION app.reward_calc_flag(severity text,code text,message text,p_entry jsonb DEFAULT NULL)RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_array(jsonb_build_object('severity',severity,'code',code,'message',message)||CASE WHEN p_entry IS NULL OR p_entry IN('null'::jsonb,'""'::jsonb)THEN'{}'::jsonb ELSE jsonb_build_object('entryId',p_entry)END);
$$;
-- Preserve the host ICU collation for version diagnostics only. Actual casing is the full
-- frozen Unicode owner below; publication/consumer runtime compatibility remains mandatory.
CREATE COLLATION app.reward_calc_unicode(provider=icu,locale='und',deterministic=true);
-- BEGIN GENERATED REWARDS UNICODE17
-- Full Unicode 17.0.0 default lowercase, independent of the server's ICU/libc version.
-- Source: UnicodeData.txt + SpecialCasing.txt + DerivedCoreProperties.txt, Unicode 17.
-- Copyright © 1991-2026 Unicode, Inc. Unicode License V3; full notice:
-- scripts/maintenance/rewards-unicode-LICENSE.txt
-- Regenerate: python3 scripts/maintenance/generate-rewards-unicode-lower.py <official-input-directory>
-- UnicodeData.txt SHA256 2e1efc1dcb59c575eedf5ccae60f95229f706ee6d031835247d843c11d96470c
-- SpecialCasing.txt SHA256 efc25faf19de21b92c1194c111c932e03d2a5eaf18194e33f1156e96de4c9588
-- DerivedCoreProperties.txt SHA256 24c7fed1195c482faaefd5c1e7eb821c5ee1fb6de07ecdbaa64b56a99da22c08
-- Final_Sigma follows ORIGINAL-string context (core specification 3.13, Table 3-17).
-- Its Case_Ignorable scan is possessive, including Cased/Case_Ignorable overlap.
CREATE FUNCTION app.reward_calc_lower(value text)RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog,public,pg_temp AS $$
 WITH characters AS MATERIALIZED(
  SELECT scalar,ordinal,ascii(scalar)AS point FROM regexp_split_to_table(value,'')WITH ORDINALITY input(scalar,ordinal)WHERE scalar<>''
 ),classified AS MATERIALIZED(
  SELECT *,point <@ '{[65,91),[97,123),[170,171),[181,182),[186,187),[192,215),[216,247),[248,443),[444,448),[452,660),[662,688),[688,697),[704,706),[736,741),[837,838),[880,884),[886,888),[890,891),[891,894),[895,896),[902,903),[904,907),[908,909),[910,930),[931,1014),[1015,1154),[1162,1328),[1329,1367),[1376,1417),[4256,4294),[4295,4296),[4301,4302),[4304,4347),[4348,4349),[4349,4352),[5024,5110),[5112,5118),[7296,7307),[7312,7355),[7357,7360),[7424,7468),[7468,7531),[7531,7544),[7544,7545),[7545,7579),[7579,7616),[7680,7958),[7960,7966),[7968,8006),[8008,8014),[8016,8024),[8025,8026),[8027,8028),[8029,8030),[8031,8062),[8064,8117),[8118,8125),[8126,8127),[8130,8133),[8134,8141),[8144,8148),[8150,8156),[8160,8173),[8178,8181),[8182,8189),[8305,8306),[8319,8320),[8336,8349),[8450,8451),[8455,8456),[8458,8468),[8469,8470),[8473,8478),[8484,8485),[8486,8487),[8488,8489),[8490,8494),[8495,8501),[8505,8506),[8508,8512),[8517,8522),[8526,8527),[8544,8576),[8579,8581),[9398,9450),[11264,11388),[11388,11390),[11390,11493),[11499,11503),[11506,11508),[11520,11558),[11559,11560),[11565,11566),[42560,42606),[42624,42652),[42652,42654),[42786,42864),[42864,42865),[42865,42888),[42891,42895),[42896,42973),[42993,42997),[42997,42999),[43000,43002),[43002,43003),[43824,43867),[43868,43872),[43872,43881),[43881,43882),[43888,43968),[64256,64263),[64275,64280),[65313,65339),[65345,65371),[66560,66640),[66736,66772),[66776,66812),[66928,66939),[66940,66955),[66956,66963),[66964,66966),[66967,66978),[66979,66994),[66995,67002),[67003,67005),[67456,67457),[67459,67462),[67463,67505),[67506,67515),[68736,68787),[68800,68851),[68944,68966),[68976,68998),[71840,71904),[93760,93824),[93856,93881),[93883,93908),[119808,119893),[119894,119965),[119966,119968),[119970,119971),[119973,119975),[119977,119981),[119982,119994),[119995,119996),[119997,120004),[120005,120070),[120071,120075),[120077,120085),[120086,120093),[120094,120122),[120123,120127),[120128,120133),[120134,120135),[120138,120145),[120146,120486),[120488,120513),[120514,120539),[120540,120571),[120572,120597),[120598,120629),[120630,120655),[120656,120687),[120688,120713),[120714,120745),[120746,120771),[120772,120780),[122624,122634),[122635,122655),[122661,122667),[122928,122990),[125184,125252),[127280,127306),[127312,127338),[127344,127370)}'::int4multirange AS cased,
   point <@ '{[39,40),[46,47),[58,59),[94,95),[96,97),[168,169),[173,174),[175,176),[180,181),[183,184),[184,185),[688,706),[706,710),[710,722),[722,736),[736,741),[741,748),[748,749),[749,750),[750,751),[751,768),[768,880),[884,885),[885,886),[890,891),[900,902),[903,904),[1155,1160),[1160,1162),[1369,1370),[1375,1376),[1425,1470),[1471,1472),[1473,1475),[1476,1478),[1479,1480),[1524,1525),[1536,1542),[1552,1563),[1564,1565),[1600,1601),[1611,1632),[1648,1649),[1750,1757),[1757,1758),[1759,1765),[1765,1767),[1767,1769),[1770,1774),[1807,1808),[1809,1810),[1840,1867),[1958,1969),[2027,2036),[2036,2038),[2042,2043),[2045,2046),[2070,2074),[2074,2075),[2075,2084),[2084,2085),[2085,2088),[2088,2089),[2089,2094),[2137,2140),[2184,2185),[2192,2194),[2199,2208),[2249,2250),[2250,2274),[2274,2275),[2275,2307),[2362,2363),[2364,2365),[2369,2377),[2381,2382),[2385,2392),[2402,2404),[2417,2418),[2433,2434),[2492,2493),[2497,2501),[2509,2510),[2530,2532),[2558,2559),[2561,2563),[2620,2621),[2625,2627),[2631,2633),[2635,2638),[2641,2642),[2672,2674),[2677,2678),[2689,2691),[2748,2749),[2753,2758),[2759,2761),[2765,2766),[2786,2788),[2810,2816),[2817,2818),[2876,2877),[2879,2880),[2881,2885),[2893,2894),[2901,2903),[2914,2916),[2946,2947),[3008,3009),[3021,3022),[3072,3073),[3076,3077),[3132,3133),[3134,3137),[3142,3145),[3146,3150),[3157,3159),[3170,3172),[3201,3202),[3260,3261),[3263,3264),[3270,3271),[3276,3278),[3298,3300),[3328,3330),[3387,3389),[3393,3397),[3405,3406),[3426,3428),[3457,3458),[3530,3531),[3538,3541),[3542,3543),[3633,3634),[3636,3643),[3654,3655),[3655,3663),[3761,3762),[3764,3773),[3782,3783),[3784,3791),[3864,3866),[3893,3894),[3895,3896),[3897,3898),[3953,3967),[3968,3973),[3974,3976),[3981,3992),[3993,4029),[4038,4039),[4141,4145),[4146,4152),[4153,4155),[4157,4159),[4184,4186),[4190,4193),[4209,4213),[4226,4227),[4229,4231),[4237,4238),[4253,4254),[4348,4349),[4957,4960),[5906,5909),[5938,5940),[5970,5972),[6002,6004),[6068,6070),[6071,6078),[6086,6087),[6089,6100),[6103,6104),[6109,6110),[6155,6158),[6158,6159),[6159,6160),[6211,6212),[6277,6279),[6313,6314),[6432,6435),[6439,6441),[6450,6451),[6457,6460),[6679,6681),[6683,6684),[6742,6743),[6744,6751),[6752,6753),[6754,6755),[6757,6765),[6771,6781),[6783,6784),[6823,6824),[6832,6846),[6846,6847),[6847,6878),[6880,6892),[6912,6916),[6964,6965),[6966,6971),[6972,6973),[6978,6979),[7019,7028),[7040,7042),[7074,7078),[7080,7082),[7083,7086),[7142,7143),[7144,7146),[7149,7150),[7151,7154),[7212,7220),[7222,7224),[7288,7294),[7376,7379),[7380,7393),[7394,7401),[7405,7406),[7412,7413),[7416,7418),[7468,7531),[7544,7545),[7579,7616),[7616,7680),[8125,8126),[8127,8130),[8141,8144),[8157,8160),[8173,8176),[8189,8191),[8203,8208),[8216,8217),[8217,8218),[8228,8229),[8231,8232),[8234,8239),[8288,8293),[8294,8304),[8305,8306),[8319,8320),[8336,8349),[8400,8413),[8413,8417),[8417,8418),[8418,8421),[8421,8433),[11388,11390),[11503,11506),[11631,11632),[11647,11648),[11744,11776),[11823,11824),[12293,12294),[12330,12334),[12337,12342),[12347,12348),[12441,12443),[12443,12445),[12445,12447),[12540,12543),[40981,40982),[42232,42238),[42508,42509),[42607,42608),[42608,42611),[42612,42622),[42623,42624),[42652,42654),[42654,42656),[42736,42738),[42752,42775),[42775,42784),[42784,42786),[42864,42865),[42888,42889),[42889,42891),[42993,42997),[43000,43002),[43010,43011),[43014,43015),[43019,43020),[43045,43047),[43052,43053),[43204,43206),[43232,43250),[43263,43264),[43302,43310),[43335,43346),[43392,43395),[43443,43444),[43446,43450),[43452,43454),[43471,43472),[43493,43494),[43494,43495),[43561,43567),[43569,43571),[43573,43575),[43587,43588),[43596,43597),[43632,43633),[43644,43645),[43696,43697),[43698,43701),[43703,43705),[43710,43712),[43713,43714),[43741,43742),[43756,43758),[43763,43765),[43766,43767),[43867,43868),[43868,43872),[43881,43882),[43882,43884),[44005,44006),[44008,44009),[44013,44014),[64286,64287),[64434,64451),[65024,65040),[65043,65044),[65056,65072),[65106,65107),[65109,65110),[65279,65280),[65287,65288),[65294,65295),[65306,65307),[65342,65343),[65344,65345),[65392,65393),[65438,65440),[65507,65508),[65529,65532),[66045,66046),[66272,66273),[66422,66427),[67456,67462),[67463,67505),[67506,67515),[68097,68100),[68101,68103),[68108,68112),[68152,68155),[68159,68160),[68325,68327),[68900,68904),[68942,68943),[68969,68974),[68975,68976),[69291,69293),[69317,69318),[69370,69376),[69446,69457),[69506,69510),[69633,69634),[69688,69703),[69744,69745),[69747,69749),[69759,69762),[69811,69815),[69817,69819),[69821,69822),[69826,69827),[69837,69838),[69888,69891),[69927,69932),[69933,69941),[70003,70004),[70016,70018),[70070,70079),[70089,70093),[70095,70096),[70191,70194),[70196,70197),[70198,70200),[70206,70207),[70209,70210),[70367,70368),[70371,70379),[70400,70402),[70459,70461),[70464,70465),[70502,70509),[70512,70517),[70587,70593),[70606,70607),[70608,70609),[70610,70611),[70625,70627),[70712,70720),[70722,70725),[70726,70727),[70750,70751),[70835,70841),[70842,70843),[70847,70849),[70850,70852),[71090,71094),[71100,71102),[71103,71105),[71132,71134),[71219,71227),[71229,71230),[71231,71233),[71339,71340),[71341,71342),[71344,71350),[71351,71352),[71453,71454),[71455,71456),[71458,71462),[71463,71468),[71727,71736),[71737,71739),[71995,71997),[71998,71999),[72003,72004),[72148,72152),[72154,72156),[72160,72161),[72193,72203),[72243,72249),[72251,72255),[72263,72264),[72273,72279),[72281,72284),[72330,72343),[72344,72346),[72544,72545),[72546,72549),[72550,72551),[72752,72759),[72760,72766),[72767,72768),[72850,72872),[72874,72881),[72882,72884),[72885,72887),[73009,73015),[73018,73019),[73020,73022),[73023,73030),[73031,73032),[73104,73106),[73109,73110),[73111,73112),[73177,73178),[73459,73461),[73472,73474),[73526,73531),[73536,73537),[73538,73539),[73562,73563),[78896,78912),[78912,78913),[78919,78934),[90398,90410),[90413,90416),[92912,92917),[92976,92983),[92992,92996),[93504,93507),[93547,93549),[94031,94032),[94095,94099),[94099,94112),[94176,94178),[94179,94180),[94180,94181),[94194,94196),[110576,110580),[110581,110588),[110589,110591),[113821,113823),[113824,113828),[118528,118574),[118576,118599),[119143,119146),[119155,119163),[119163,119171),[119173,119180),[119210,119214),[119362,119365),[121344,121399),[121403,121453),[121461,121462),[121476,121477),[121499,121504),[121505,121520),[122880,122887),[122888,122905),[122907,122914),[122915,122917),[122918,122923),[122928,122990),[123023,123024),[123184,123191),[123191,123198),[123566,123567),[123628,123632),[124139,124140),[124140,124144),[124398,124400),[124643,124644),[124646,124647),[124654,124656),[124661,124662),[124671,124672),[125136,125143),[125252,125259),[125259,125260),[127995,128000),[917505,917506),[917536,917632),[917760,918000)}'::int4multirange AS ignorable FROM characters
 ),neighbors AS(
  SELECT *,max(ordinal)FILTER(WHERE NOT ignorable)OVER(ORDER BY ordinal ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)AS prior_ordinal,
   min(ordinal)FILTER(WHERE NOT ignorable)OVER(ORDER BY ordinal DESC ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)AS next_ordinal FROM classified
 )
 SELECT coalesce(string_agg(CASE WHEN original.point=931 AND coalesce(prior_letter.cased,false)AND NOT coalesce(next_letter.cased,false)THEN chr(962)
  ELSE coalesce(($rewards_unicode17_map${"1000":"\u03e9","1002":"\u03eb","1004":"\u03ed","1006":"\u03ef","1012":"\u03b8","1015":"\u03f8","1017":"\u03f2","1018":"\u03fb","1021":"\u037b","1022":"\u037c","1023":"\u037d","1024":"\u0450","1025":"\u0451","1026":"\u0452","1027":"\u0453","1028":"\u0454","1029":"\u0455","1030":"\u0456","1031":"\u0457","1032":"\u0458","1033":"\u0459","1034":"\u045a","1035":"\u045b","1036":"\u045c","1037":"\u045d","1038":"\u045e","1039":"\u045f","1040":"\u0430","1041":"\u0431","1042":"\u0432","1043":"\u0433","1044":"\u0434","1045":"\u0435","1046":"\u0436","1047":"\u0437","1048":"\u0438","1049":"\u0439","1050":"\u043a","1051":"\u043b","1052":"\u043c","1053":"\u043d","1054":"\u043e","1055":"\u043f","1056":"\u0440","1057":"\u0441","1058":"\u0442","1059":"\u0443","1060":"\u0444","1061":"\u0445","1062":"\u0446","1063":"\u0447","1064":"\u0448","1065":"\u0449","1066":"\u044a","1067":"\u044b","1068":"\u044c","1069":"\u044d","1070":"\u044e","1071":"\u044f","1120":"\u0461","1122":"\u0463","1124":"\u0465","1126":"\u0467","11264":"\u2c30","11265":"\u2c31","11266":"\u2c32","11267":"\u2c33","11268":"\u2c34","11269":"\u2c35","11270":"\u2c36","11271":"\u2c37","11272":"\u2c38","11273":"\u2c39","11274":"\u2c3a","11275":"\u2c3b","11276":"\u2c3c","11277":"\u2c3d","11278":"\u2c3e","11279":"\u2c3f","1128":"\u0469","11280":"\u2c40","11281":"\u2c41","11282":"\u2c42","11283":"\u2c43","11284":"\u2c44","11285":"\u2c45","11286":"\u2c46","11287":"\u2c47","11288":"\u2c48","11289":"\u2c49","11290":"\u2c4a","11291":"\u2c4b","11292":"\u2c4c","11293":"\u2c4d","11294":"\u2c4e","11295":"\u2c4f","11296":"\u2c50","11297":"\u2c51","11298":"\u2c52","11299":"\u2c53","1130":"\u046b","11300":"\u2c54","11301":"\u2c55","11302":"\u2c56","11303":"\u2c57","11304":"\u2c58","11305":"\u2c59","11306":"\u2c5a","11307":"\u2c5b","11308":"\u2c5c","11309":"\u2c5d","11310":"\u2c5e","11311":"\u2c5f","1132":"\u046d","1134":"\u046f","1136":"\u0471","11360":"\u2c61","11362":"\u026b","11363":"\u1d7d","11364":"\u027d","11367":"\u2c68","11369":"\u2c6a","11371":"\u2c6c","11373":"\u0251","11374":"\u0271","11375":"\u0250","11376":"\u0252","11378":"\u2c73","1138":"\u0473","11381":"\u2c76","11390":"\u023f","11391":"\u0240","11392":"\u2c81","11394":"\u2c83","11396":"\u2c85","11398":"\u2c87","1140":"\u0475","11400":"\u2c89","11402":"\u2c8b","11404":"\u2c8d","11406":"\u2c8f","11408":"\u2c91","11410":"\u2c93","11412":"\u2c95","11414":"\u2c97","11416":"\u2c99","11418":"\u2c9b","1142":"\u0477","11420":"\u2c9d","11422":"\u2c9f","11424":"\u2ca1","11426":"\u2ca3","11428":"\u2ca5","11430":"\u2ca7","11432":"\u2ca9","11434":"\u2cab","11436":"\u2cad","11438":"\u2caf","1144":"\u0479","11440":"\u2cb1","11442":"\u2cb3","11444":"\u2cb5","11446":"\u2cb7","11448":"\u2cb9","11450":"\u2cbb","11452":"\u2cbd","11454":"\u2cbf","11456":"\u2cc1","11458":"\u2cc3","1146":"\u047b","11460":"\u2cc5","11462":"\u2cc7","11464":"\u2cc9","11466":"\u2ccb","11468":"\u2ccd","11470":"\u2ccf","11472":"\u2cd1","11474":"\u2cd3","11476":"\u2cd5","11478":"\u2cd7","1148":"\u047d","11480":"\u2cd9","11482":"\u2cdb","11484":"\u2cdd","11486":"\u2cdf","11488":"\u2ce1","11490":"\u2ce3","11499":"\u2cec","1150":"\u047f","11501":"\u2cee","11506":"\u2cf3","1152":"\u0481","1162":"\u048b","1164":"\u048d","1166":"\u048f","1168":"\u0491","1170":"\u0493","1172":"\u0495","1174":"\u0497","1176":"\u0499","1178":"\u049b","1180":"\u049d","1182":"\u049f","1184":"\u04a1","1186":"\u04a3","1188":"\u04a5","1190":"\u04a7","1192":"\u04a9","1194":"\u04ab","1196":"\u04ad","1198":"\u04af","1200":"\u04b1","1202":"\u04b3","1204":"\u04b5","1206":"\u04b7","1208":"\u04b9","1210":"\u04bb","1212":"\u04bd","1214":"\u04bf","1216":"\u04cf","1217":"\u04c2","1219":"\u04c4","1221":"\u04c6","1223":"\u04c8","1225":"\u04ca","1227":"\u04cc","1229":"\u04ce","1232":"\u04d1","1234":"\u04d3","1236":"\u04d5","1238":"\u04d7","1240":"\u04d9","1242":"\u04db","1244":"\u04dd","1246":"\u04df","1248":"\u04e1","1250":"\u04e3","125184":"\ud83a\udd22","125185":"\ud83a\udd23","125186":"\ud83a\udd24","125187":"\ud83a\udd25","125188":"\ud83a\udd26","125189":"\ud83a\udd27","125190":"\ud83a\udd28","125191":"\ud83a\udd29","125192":"\ud83a\udd2a","125193":"\ud83a\udd2b","125194":"\ud83a\udd2c","125195":"\ud83a\udd2d","125196":"\ud83a\udd2e","125197":"\ud83a\udd2f","125198":"\ud83a\udd30","125199":"\ud83a\udd31","1252":"\u04e5","125200":"\ud83a\udd32","125201":"\ud83a\udd33","125202":"\ud83a\udd34","125203":"\ud83a\udd35","125204":"\ud83a\udd36","125205":"\ud83a\udd37","125206":"\ud83a\udd38","125207":"\ud83a\udd39","125208":"\ud83a\udd3a","125209":"\ud83a\udd3b","125210":"\ud83a\udd3c","125211":"\ud83a\udd3d","125212":"\ud83a\udd3e","125213":"\ud83a\udd3f","125214":"\ud83a\udd40","125215":"\ud83a\udd41","125216":"\ud83a\udd42","125217":"\ud83a\udd43","1254":"\u04e7","1256":"\u04e9","1258":"\u04eb","1260":"\u04ed","1262":"\u04ef","1264":"\u04f1","1266":"\u04f3","1268":"\u04f5","1270":"\u04f7","1272":"\u04f9","1274":"\u04fb","1276":"\u04fd","1278":"\u04ff","1280":"\u0501","1282":"\u0503","1284":"\u0505","1286":"\u0507","1288":"\u0509","1290":"\u050b","1292":"\u050d","1294":"\u050f","1296":"\u0511","1298":"\u0513","1300":"\u0515","1302":"\u0517","1304":"\u0519","1306":"\u051b","1308":"\u051d","1310":"\u051f","1312":"\u0521","1314":"\u0523","1316":"\u0525","1318":"\u0527","1320":"\u0529","1322":"\u052b","1324":"\u052d","1326":"\u052f","1329":"\u0561","1330":"\u0562","1331":"\u0563","1332":"\u0564","1333":"\u0565","1334":"\u0566","1335":"\u0567","1336":"\u0568","1337":"\u0569","1338":"\u056a","1339":"\u056b","1340":"\u056c","1341":"\u056d","1342":"\u056e","1343":"\u056f","1344":"\u0570","1345":"\u0571","1346":"\u0572","1347":"\u0573","1348":"\u0574","1349":"\u0575","1350":"\u0576","1351":"\u0577","1352":"\u0578","1353":"\u0579","1354":"\u057a","1355":"\u057b","1356":"\u057c","1357":"\u057d","1358":"\u057e","1359":"\u057f","1360":"\u0580","1361":"\u0581","1362":"\u0582","1363":"\u0583","1364":"\u0584","1365":"\u0585","1366":"\u0586","192":"\u00e0","193":"\u00e1","194":"\u00e2","195":"\u00e3","196":"\u00e4","197":"\u00e5","198":"\u00e6","199":"\u00e7","200":"\u00e8","201":"\u00e9","202":"\u00ea","203":"\u00eb","204":"\u00ec","205":"\u00ed","206":"\u00ee","207":"\u00ef","208":"\u00f0","209":"\u00f1","210":"\u00f2","211":"\u00f3","212":"\u00f4","213":"\u00f5","214":"\u00f6","216":"\u00f8","217":"\u00f9","218":"\u00fa","219":"\u00fb","220":"\u00fc","221":"\u00fd","222":"\u00fe","256":"\u0101","258":"\u0103","260":"\u0105","262":"\u0107","264":"\u0109","266":"\u010b","268":"\u010d","270":"\u010f","272":"\u0111","274":"\u0113","276":"\u0115","278":"\u0117","280":"\u0119","282":"\u011b","284":"\u011d","286":"\u011f","288":"\u0121","290":"\u0123","292":"\u0125","294":"\u0127","296":"\u0129","298":"\u012b","300":"\u012d","302":"\u012f","304":"i\u0307","306":"\u0133","308":"\u0135","310":"\u0137","313":"\u013a","315":"\u013c","317":"\u013e","319":"\u0140","321":"\u0142","323":"\u0144","325":"\u0146","327":"\u0148","330":"\u014b","332":"\u014d","334":"\u014f","336":"\u0151","338":"\u0153","340":"\u0155","342":"\u0157","344":"\u0159","346":"\u015b","348":"\u015d","350":"\u015f","352":"\u0161","354":"\u0163","356":"\u0165","358":"\u0167","360":"\u0169","362":"\u016b","364":"\u016d","366":"\u016f","368":"\u0171","370":"\u0173","372":"\u0175","374":"\u0177","376":"\u00ff","377":"\u017a","379":"\u017c","381":"\u017e","385":"\u0253","386":"\u0183","388":"\u0185","390":"\u0254","391":"\u0188","393":"\u0256","394":"\u0257","395":"\u018c","398":"\u01dd","399":"\u0259","400":"\u025b","401":"\u0192","403":"\u0260","404":"\u0263","406":"\u0269","407":"\u0268","408":"\u0199","412":"\u026f","413":"\u0272","415":"\u0275","416":"\u01a1","418":"\u01a3","420":"\u01a5","422":"\u0280","423":"\u01a8","425":"\u0283","4256":"\u2d00","42560":"\ua641","42562":"\ua643","42564":"\ua645","42566":"\ua647","42568":"\ua649","4257":"\u2d01","42570":"\ua64b","42572":"\ua64d","42574":"\ua64f","42576":"\ua651","42578":"\ua653","4258":"\u2d02","42580":"\ua655","42582":"\ua657","42584":"\ua659","42586":"\ua65b","42588":"\ua65d","4259":"\u2d03","42590":"\ua65f","42592":"\ua661","42594":"\ua663","42596":"\ua665","42598":"\ua667","4260":"\u2d04","42600":"\ua669","42602":"\ua66b","42604":"\ua66d","4261":"\u2d05","4262":"\u2d06","42624":"\ua681","42626":"\ua683","42628":"\ua685","4263":"\u2d07","42630":"\ua687","42632":"\ua689","42634":"\ua68b","42636":"\ua68d","42638":"\ua68f","4264":"\u2d08","42640":"\ua691","42642":"\ua693","42644":"\ua695","42646":"\ua697","42648":"\ua699","4265":"\u2d09","42650":"\ua69b","4266":"\u2d0a","4267":"\u2d0b","4268":"\u2d0c","4269":"\u2d0d","4270":"\u2d0e","4271":"\u2d0f","4272":"\u2d10","4273":"\u2d11","4274":"\u2d12","4275":"\u2d13","4276":"\u2d14","4277":"\u2d15","4278":"\u2d16","42786":"\ua723","42788":"\ua725","4279":"\u2d17","42790":"\ua727","42792":"\ua729","42794":"\ua72b","42796":"\ua72d","42798":"\ua72f","428":"\u01ad","4280":"\u2d18","42802":"\ua733","42804":"\ua735","42806":"\ua737","42808":"\ua739","4281":"\u2d19","42810":"\ua73b","42812":"\ua73d","42814":"\ua73f","42816":"\ua741","42818":"\ua743","4282":"\u2d1a","42820":"\ua745","42822":"\ua747","42824":"\ua749","42826":"\ua74b","42828":"\ua74d","4283":"\u2d1b","42830":"\ua74f","42832":"\ua751","42834":"\ua753","42836":"\ua755","42838":"\ua757","4284":"\u2d1c","42840":"\ua759","42842":"\ua75b","42844":"\ua75d","42846":"\ua75f","42848":"\ua761","4285":"\u2d1d","42850":"\ua763","42852":"\ua765","42854":"\ua767","42856":"\ua769","42858":"\ua76b","4286":"\u2d1e","42860":"\ua76d","42862":"\ua76f","4287":"\u2d1f","42873":"\ua77a","42875":"\ua77c","42877":"\u1d79","42878":"\ua77f","4288":"\u2d20","42880":"\ua781","42882":"\ua783","42884":"\ua785","42886":"\ua787","4289":"\u2d21","42891":"\ua78c","42893":"\u0265","42896":"\ua791","42898":"\ua793","4290":"\u2d22","42902":"\ua797","42904":"\ua799","42906":"\ua79b","42908":"\ua79d","4291":"\u2d23","42910":"\ua79f","42912":"\ua7a1","42914":"\ua7a3","42916":"\ua7a5","42918":"\ua7a7","4292":"\u2d24","42920":"\ua7a9","42922":"\u0266","42923":"\u025c","42924":"\u0261","42925":"\u026c","42926":"\u026a","42928":"\u029e","42929":"\u0287","4293":"\u2d25","42930":"\u029d","42931":"\uab53","42932":"\ua7b5","42934":"\ua7b7","42936":"\ua7b9","42938":"\ua7bb","42940":"\ua7bd","42942":"\ua7bf","42944":"\ua7c1","42946":"\ua7c3","42948":"\ua794","42949":"\u0282","4295":"\u2d27","42950":"\u1d8e","42951":"\ua7c8","42953":"\ua7ca","42955":"\u0264","42956":"\ua7cd","42958":"\ua7cf","42960":"\ua7d1","42962":"\ua7d3","42964":"\ua7d5","42966":"\ua7d7","42968":"\ua7d9","42970":"\ua7db","42972":"\u019b","42997":"\ua7f6","430":"\u0288","4301":"\u2d2d","431":"\u01b0","433":"\u028a","434":"\u028b","435":"\u01b4","437":"\u01b6","439":"\u0292","440":"\u01b9","444":"\u01bd","452":"\u01c6","453":"\u01c6","455":"\u01c9","456":"\u01c9","458":"\u01cc","459":"\u01cc","461":"\u01ce","463":"\u01d0","465":"\u01d2","467":"\u01d4","469":"\u01d6","471":"\u01d8","473":"\u01da","475":"\u01dc","478":"\u01df","480":"\u01e1","482":"\u01e3","484":"\u01e5","486":"\u01e7","488":"\u01e9","490":"\u01eb","492":"\u01ed","494":"\u01ef","497":"\u01f3","498":"\u01f3","500":"\u01f5","502":"\u0195","5024":"\uab70","5025":"\uab71","5026":"\uab72","5027":"\uab73","5028":"\uab74","5029":"\uab75","503":"\u01bf","5030":"\uab76","5031":"\uab77","5032":"\uab78","5033":"\uab79","5034":"\uab7a","5035":"\uab7b","5036":"\uab7c","5037":"\uab7d","5038":"\uab7e","5039":"\uab7f","504":"\u01f9","5040":"\uab80","5041":"\uab81","5042":"\uab82","5043":"\uab83","5044":"\uab84","5045":"\uab85","5046":"\uab86","5047":"\uab87","5048":"\uab88","5049":"\uab89","5050":"\uab8a","5051":"\uab8b","5052":"\uab8c","5053":"\uab8d","5054":"\uab8e","5055":"\uab8f","5056":"\uab90","5057":"\uab91","5058":"\uab92","5059":"\uab93","506":"\u01fb","5060":"\uab94","5061":"\uab95","5062":"\uab96","5063":"\uab97","5064":"\uab98","5065":"\uab99","5066":"\uab9a","5067":"\uab9b","5068":"\uab9c","5069":"\uab9d","5070":"\uab9e","5071":"\uab9f","5072":"\uaba0","5073":"\uaba1","5074":"\uaba2","5075":"\uaba3","5076":"\uaba4","5077":"\uaba5","5078":"\uaba6","5079":"\uaba7","508":"\u01fd","5080":"\uaba8","5081":"\uaba9","5082":"\uabaa","5083":"\uabab","5084":"\uabac","5085":"\uabad","5086":"\uabae","5087":"\uabaf","5088":"\uabb0","5089":"\uabb1","5090":"\uabb2","5091":"\uabb3","5092":"\uabb4","5093":"\uabb5","5094":"\uabb6","5095":"\uabb7","5096":"\uabb8","5097":"\uabb9","5098":"\uabba","5099":"\uabbb","510":"\u01ff","5100":"\uabbc","5101":"\uabbd","5102":"\uabbe","5103":"\uabbf","5104":"\u13f8","5105":"\u13f9","5106":"\u13fa","5107":"\u13fb","5108":"\u13fc","5109":"\u13fd","512":"\u0201","514":"\u0203","516":"\u0205","518":"\u0207","520":"\u0209","522":"\u020b","524":"\u020d","526":"\u020f","528":"\u0211","530":"\u0213","532":"\u0215","534":"\u0217","536":"\u0219","538":"\u021b","540":"\u021d","542":"\u021f","544":"\u019e","546":"\u0223","548":"\u0225","550":"\u0227","552":"\u0229","554":"\u022b","556":"\u022d","558":"\u022f","560":"\u0231","562":"\u0233","570":"\u2c65","571":"\u023c","573":"\u019a","574":"\u2c66","577":"\u0242","579":"\u0180","580":"\u0289","581":"\u028c","582":"\u0247","584":"\u0249","586":"\u024b","588":"\u024d","590":"\u024f","65":"a","65313":"\uff41","65314":"\uff42","65315":"\uff43","65316":"\uff44","65317":"\uff45","65318":"\uff46","65319":"\uff47","65320":"\uff48","65321":"\uff49","65322":"\uff4a","65323":"\uff4b","65324":"\uff4c","65325":"\uff4d","65326":"\uff4e","65327":"\uff4f","65328":"\uff50","65329":"\uff51","65330":"\uff52","65331":"\uff53","65332":"\uff54","65333":"\uff55","65334":"\uff56","65335":"\uff57","65336":"\uff58","65337":"\uff59","65338":"\uff5a","66":"b","66560":"\ud801\udc28","66561":"\ud801\udc29","66562":"\ud801\udc2a","66563":"\ud801\udc2b","66564":"\ud801\udc2c","66565":"\ud801\udc2d","66566":"\ud801\udc2e","66567":"\ud801\udc2f","66568":"\ud801\udc30","66569":"\ud801\udc31","66570":"\ud801\udc32","66571":"\ud801\udc33","66572":"\ud801\udc34","66573":"\ud801\udc35","66574":"\ud801\udc36","66575":"\ud801\udc37","66576":"\ud801\udc38","66577":"\ud801\udc39","66578":"\ud801\udc3a","66579":"\ud801\udc3b","66580":"\ud801\udc3c","66581":"\ud801\udc3d","66582":"\ud801\udc3e","66583":"\ud801\udc3f","66584":"\ud801\udc40","66585":"\ud801\udc41","66586":"\ud801\udc42","66587":"\ud801\udc43","66588":"\ud801\udc44","66589":"\ud801\udc45","66590":"\ud801\udc46","66591":"\ud801\udc47","66592":"\ud801\udc48","66593":"\ud801\udc49","66594":"\ud801\udc4a","66595":"\ud801\udc4b","66596":"\ud801\udc4c","66597":"\ud801\udc4d","66598":"\ud801\udc4e","66599":"\ud801\udc4f","66736":"\ud801\udcd8","66737":"\ud801\udcd9","66738":"\ud801\udcda","66739":"\ud801\udcdb","66740":"\ud801\udcdc","66741":"\ud801\udcdd","66742":"\ud801\udcde","66743":"\ud801\udcdf","66744":"\ud801\udce0","66745":"\ud801\udce1","66746":"\ud801\udce2","66747":"\ud801\udce3","66748":"\ud801\udce4","66749":"\ud801\udce5","66750":"\ud801\udce6","66751":"\ud801\udce7","66752":"\ud801\udce8","66753":"\ud801\udce9","66754":"\ud801\udcea","66755":"\ud801\udceb","66756":"\ud801\udcec","66757":"\ud801\udced","66758":"\ud801\udcee","66759":"\ud801\udcef","66760":"\ud801\udcf0","66761":"\ud801\udcf1","66762":"\ud801\udcf2","66763":"\ud801\udcf3","66764":"\ud801\udcf4","66765":"\ud801\udcf5","66766":"\ud801\udcf6","66767":"\ud801\udcf7","66768":"\ud801\udcf8","66769":"\ud801\udcf9","66770":"\ud801\udcfa","66771":"\ud801\udcfb","66928":"\ud801\udd97","66929":"\ud801\udd98","66930":"\ud801\udd99","66931":"\ud801\udd9a","66932":"\ud801\udd9b","66933":"\ud801\udd9c","66934":"\ud801\udd9d","66935":"\ud801\udd9e","66936":"\ud801\udd9f","66937":"\ud801\udda0","66938":"\ud801\udda1","66940":"\ud801\udda3","66941":"\ud801\udda4","66942":"\ud801\udda5","66943":"\ud801\udda6","66944":"\ud801\udda7","66945":"\ud801\udda8","66946":"\ud801\udda9","66947":"\ud801\uddaa","66948":"\ud801\uddab","66949":"\ud801\uddac","66950":"\ud801\uddad","66951":"\ud801\uddae","66952":"\ud801\uddaf","66953":"\ud801\uddb0","66954":"\ud801\uddb1","66956":"\ud801\uddb3","66957":"\ud801\uddb4","66958":"\ud801\uddb5","66959":"\ud801\uddb6","66960":"\ud801\uddb7","66961":"\ud801\uddb8","66962":"\ud801\uddb9","66964":"\ud801\uddbb","66965":"\ud801\uddbc","67":"c","68":"d","68736":"\ud803\udcc0","68737":"\ud803\udcc1","68738":"\ud803\udcc2","68739":"\ud803\udcc3","68740":"\ud803\udcc4","68741":"\ud803\udcc5","68742":"\ud803\udcc6","68743":"\ud803\udcc7","68744":"\ud803\udcc8","68745":"\ud803\udcc9","68746":"\ud803\udcca","68747":"\ud803\udccb","68748":"\ud803\udccc","68749":"\ud803\udccd","68750":"\ud803\udcce","68751":"\ud803\udccf","68752":"\ud803\udcd0","68753":"\ud803\udcd1","68754":"\ud803\udcd2","68755":"\ud803\udcd3","68756":"\ud803\udcd4","68757":"\ud803\udcd5","68758":"\ud803\udcd6","68759":"\ud803\udcd7","68760":"\ud803\udcd8","68761":"\ud803\udcd9","68762":"\ud803\udcda","68763":"\ud803\udcdb","68764":"\ud803\udcdc","68765":"\ud803\udcdd","68766":"\ud803\udcde","68767":"\ud803\udcdf","68768":"\ud803\udce0","68769":"\ud803\udce1","68770":"\ud803\udce2","68771":"\ud803\udce3","68772":"\ud803\udce4","68773":"\ud803\udce5","68774":"\ud803\udce6","68775":"\ud803\udce7","68776":"\ud803\udce8","68777":"\ud803\udce9","68778":"\ud803\udcea","68779":"\ud803\udceb","68780":"\ud803\udcec","68781":"\ud803\udced","68782":"\ud803\udcee","68783":"\ud803\udcef","68784":"\ud803\udcf0","68785":"\ud803\udcf1","68786":"\ud803\udcf2","68944":"\ud803\udd70","68945":"\ud803\udd71","68946":"\ud803\udd72","68947":"\ud803\udd73","68948":"\ud803\udd74","68949":"\ud803\udd75","68950":"\ud803\udd76","68951":"\ud803\udd77","68952":"\ud803\udd78","68953":"\ud803\udd79","68954":"\ud803\udd7a","68955":"\ud803\udd7b","68956":"\ud803\udd7c","68957":"\ud803\udd7d","68958":"\ud803\udd7e","68959":"\ud803\udd7f","68960":"\ud803\udd80","68961":"\ud803\udd81","68962":"\ud803\udd82","68963":"\ud803\udd83","68964":"\ud803\udd84","68965":"\ud803\udd85","69":"e","70":"f","71":"g","71840":"\ud806\udcc0","71841":"\ud806\udcc1","71842":"\ud806\udcc2","71843":"\ud806\udcc3","71844":"\ud806\udcc4","71845":"\ud806\udcc5","71846":"\ud806\udcc6","71847":"\ud806\udcc7","71848":"\ud806\udcc8","71849":"\ud806\udcc9","71850":"\ud806\udcca","71851":"\ud806\udccb","71852":"\ud806\udccc","71853":"\ud806\udccd","71854":"\ud806\udcce","71855":"\ud806\udccf","71856":"\ud806\udcd0","71857":"\ud806\udcd1","71858":"\ud806\udcd2","71859":"\ud806\udcd3","71860":"\ud806\udcd4","71861":"\ud806\udcd5","71862":"\ud806\udcd6","71863":"\ud806\udcd7","71864":"\ud806\udcd8","71865":"\ud806\udcd9","71866":"\ud806\udcda","71867":"\ud806\udcdb","71868":"\ud806\udcdc","71869":"\ud806\udcdd","71870":"\ud806\udcde","71871":"\ud806\udcdf","72":"h","73":"i","7305":"\u1c8a","7312":"\u10d0","7313":"\u10d1","7314":"\u10d2","7315":"\u10d3","7316":"\u10d4","7317":"\u10d5","7318":"\u10d6","7319":"\u10d7","7320":"\u10d8","7321":"\u10d9","7322":"\u10da","7323":"\u10db","7324":"\u10dc","7325":"\u10dd","7326":"\u10de","7327":"\u10df","7328":"\u10e0","7329":"\u10e1","7330":"\u10e2","7331":"\u10e3","7332":"\u10e4","7333":"\u10e5","7334":"\u10e6","7335":"\u10e7","7336":"\u10e8","7337":"\u10e9","7338":"\u10ea","7339":"\u10eb","7340":"\u10ec","7341":"\u10ed","7342":"\u10ee","7343":"\u10ef","7344":"\u10f0","7345":"\u10f1","7346":"\u10f2","7347":"\u10f3","7348":"\u10f4","7349":"\u10f5","7350":"\u10f6","7351":"\u10f7","7352":"\u10f8","7353":"\u10f9","7354":"\u10fa","7357":"\u10fd","7358":"\u10fe","7359":"\u10ff","74":"j","75":"k","76":"l","7680":"\u1e01","7682":"\u1e03","7684":"\u1e05","7686":"\u1e07","7688":"\u1e09","7690":"\u1e0b","7692":"\u1e0d","7694":"\u1e0f","7696":"\u1e11","7698":"\u1e13","77":"m","7700":"\u1e15","7702":"\u1e17","7704":"\u1e19","7706":"\u1e1b","7708":"\u1e1d","7710":"\u1e1f","7712":"\u1e21","7714":"\u1e23","7716":"\u1e25","7718":"\u1e27","7720":"\u1e29","7722":"\u1e2b","7724":"\u1e2d","7726":"\u1e2f","7728":"\u1e31","7730":"\u1e33","7732":"\u1e35","7734":"\u1e37","7736":"\u1e39","7738":"\u1e3b","7740":"\u1e3d","7742":"\u1e3f","7744":"\u1e41","7746":"\u1e43","7748":"\u1e45","7750":"\u1e47","7752":"\u1e49","7754":"\u1e4b","7756":"\u1e4d","7758":"\u1e4f","7760":"\u1e51","7762":"\u1e53","7764":"\u1e55","7766":"\u1e57","7768":"\u1e59","7770":"\u1e5b","7772":"\u1e5d","7774":"\u1e5f","7776":"\u1e61","7778":"\u1e63","7780":"\u1e65","7782":"\u1e67","7784":"\u1e69","7786":"\u1e6b","7788":"\u1e6d","7790":"\u1e6f","7792":"\u1e71","7794":"\u1e73","7796":"\u1e75","7798":"\u1e77","78":"n","7800":"\u1e79","7802":"\u1e7b","7804":"\u1e7d","7806":"\u1e7f","7808":"\u1e81","7810":"\u1e83","7812":"\u1e85","7814":"\u1e87","7816":"\u1e89","7818":"\u1e8b","7820":"\u1e8d","7822":"\u1e8f","7824":"\u1e91","7826":"\u1e93","7828":"\u1e95","7838":"\u00df","7840":"\u1ea1","7842":"\u1ea3","7844":"\u1ea5","7846":"\u1ea7","7848":"\u1ea9","7850":"\u1eab","7852":"\u1ead","7854":"\u1eaf","7856":"\u1eb1","7858":"\u1eb3","7860":"\u1eb5","7862":"\u1eb7","7864":"\u1eb9","7866":"\u1ebb","7868":"\u1ebd","7870":"\u1ebf","7872":"\u1ec1","7874":"\u1ec3","7876":"\u1ec5","7878":"\u1ec7","7880":"\u1ec9","7882":"\u1ecb","7884":"\u1ecd","7886":"\u1ecf","7888":"\u1ed1","7890":"\u1ed3","7892":"\u1ed5","7894":"\u1ed7","7896":"\u1ed9","7898":"\u1edb","79":"o","7900":"\u1edd","7902":"\u1edf","7904":"\u1ee1","7906":"\u1ee3","7908":"\u1ee5","7910":"\u1ee7","7912":"\u1ee9","7914":"\u1eeb","7916":"\u1eed","7918":"\u1eef","7920":"\u1ef1","7922":"\u1ef3","7924":"\u1ef5","7926":"\u1ef7","7928":"\u1ef9","7930":"\u1efb","7932":"\u1efd","7934":"\u1eff","7944":"\u1f00","7945":"\u1f01","7946":"\u1f02","7947":"\u1f03","7948":"\u1f04","7949":"\u1f05","7950":"\u1f06","7951":"\u1f07","7960":"\u1f10","7961":"\u1f11","7962":"\u1f12","7963":"\u1f13","7964":"\u1f14","7965":"\u1f15","7976":"\u1f20","7977":"\u1f21","7978":"\u1f22","7979":"\u1f23","7980":"\u1f24","7981":"\u1f25","7982":"\u1f26","7983":"\u1f27","7992":"\u1f30","7993":"\u1f31","7994":"\u1f32","7995":"\u1f33","7996":"\u1f34","7997":"\u1f35","7998":"\u1f36","7999":"\u1f37","80":"p","8008":"\u1f40","8009":"\u1f41","8010":"\u1f42","8011":"\u1f43","8012":"\u1f44","8013":"\u1f45","8025":"\u1f51","8027":"\u1f53","8029":"\u1f55","8031":"\u1f57","8040":"\u1f60","8041":"\u1f61","8042":"\u1f62","8043":"\u1f63","8044":"\u1f64","8045":"\u1f65","8046":"\u1f66","8047":"\u1f67","8072":"\u1f80","8073":"\u1f81","8074":"\u1f82","8075":"\u1f83","8076":"\u1f84","8077":"\u1f85","8078":"\u1f86","8079":"\u1f87","8088":"\u1f90","8089":"\u1f91","8090":"\u1f92","8091":"\u1f93","8092":"\u1f94","8093":"\u1f95","8094":"\u1f96","8095":"\u1f97","81":"q","8104":"\u1fa0","8105":"\u1fa1","8106":"\u1fa2","8107":"\u1fa3","8108":"\u1fa4","8109":"\u1fa5","8110":"\u1fa6","8111":"\u1fa7","8120":"\u1fb0","8121":"\u1fb1","8122":"\u1f70","8123":"\u1f71","8124":"\u1fb3","8136":"\u1f72","8137":"\u1f73","8138":"\u1f74","8139":"\u1f75","8140":"\u1fc3","8152":"\u1fd0","8153":"\u1fd1","8154":"\u1f76","8155":"\u1f77","8168":"\u1fe0","8169":"\u1fe1","8170":"\u1f7a","8171":"\u1f7b","8172":"\u1fe5","8184":"\u1f78","8185":"\u1f79","8186":"\u1f7c","8187":"\u1f7d","8188":"\u1ff3","82":"r","83":"s","84":"t","8486":"\u03c9","8490":"k","8491":"\u00e5","8498":"\u214e","85":"u","8544":"\u2170","8545":"\u2171","8546":"\u2172","8547":"\u2173","8548":"\u2174","8549":"\u2175","8550":"\u2176","8551":"\u2177","8552":"\u2178","8553":"\u2179","8554":"\u217a","8555":"\u217b","8556":"\u217c","8557":"\u217d","8558":"\u217e","8559":"\u217f","8579":"\u2184","86":"v","87":"w","88":"x","880":"\u0371","882":"\u0373","886":"\u0377","89":"y","895":"\u03f3","90":"z","902":"\u03ac","904":"\u03ad","905":"\u03ae","906":"\u03af","908":"\u03cc","910":"\u03cd","911":"\u03ce","913":"\u03b1","914":"\u03b2","915":"\u03b3","916":"\u03b4","917":"\u03b5","918":"\u03b6","919":"\u03b7","920":"\u03b8","921":"\u03b9","922":"\u03ba","923":"\u03bb","924":"\u03bc","925":"\u03bd","926":"\u03be","927":"\u03bf","928":"\u03c0","929":"\u03c1","931":"\u03c3","932":"\u03c4","933":"\u03c5","934":"\u03c6","935":"\u03c7","936":"\u03c8","937":"\u03c9","93760":"\ud81b\ude60","93761":"\ud81b\ude61","93762":"\ud81b\ude62","93763":"\ud81b\ude63","93764":"\ud81b\ude64","93765":"\ud81b\ude65","93766":"\ud81b\ude66","93767":"\ud81b\ude67","93768":"\ud81b\ude68","93769":"\ud81b\ude69","93770":"\ud81b\ude6a","93771":"\ud81b\ude6b","93772":"\ud81b\ude6c","93773":"\ud81b\ude6d","93774":"\ud81b\ude6e","93775":"\ud81b\ude6f","93776":"\ud81b\ude70","93777":"\ud81b\ude71","93778":"\ud81b\ude72","93779":"\ud81b\ude73","93780":"\ud81b\ude74","93781":"\ud81b\ude75","93782":"\ud81b\ude76","93783":"\ud81b\ude77","93784":"\ud81b\ude78","93785":"\ud81b\ude79","93786":"\ud81b\ude7a","93787":"\ud81b\ude7b","93788":"\ud81b\ude7c","93789":"\ud81b\ude7d","93790":"\ud81b\ude7e","93791":"\ud81b\ude7f","938":"\u03ca","93856":"\ud81b\udebb","93857":"\ud81b\udebc","93858":"\ud81b\udebd","93859":"\ud81b\udebe","93860":"\ud81b\udebf","93861":"\ud81b\udec0","93862":"\ud81b\udec1","93863":"\ud81b\udec2","93864":"\ud81b\udec3","93865":"\ud81b\udec4","93866":"\ud81b\udec5","93867":"\ud81b\udec6","93868":"\ud81b\udec7","93869":"\ud81b\udec8","93870":"\ud81b\udec9","93871":"\ud81b\udeca","93872":"\ud81b\udecb","93873":"\ud81b\udecc","93874":"\ud81b\udecd","93875":"\ud81b\udece","93876":"\ud81b\udecf","93877":"\ud81b\uded0","93878":"\ud81b\uded1","93879":"\ud81b\uded2","93880":"\ud81b\uded3","939":"\u03cb","9398":"\u24d0","9399":"\u24d1","9400":"\u24d2","9401":"\u24d3","9402":"\u24d4","9403":"\u24d5","9404":"\u24d6","9405":"\u24d7","9406":"\u24d8","9407":"\u24d9","9408":"\u24da","9409":"\u24db","9410":"\u24dc","9411":"\u24dd","9412":"\u24de","9413":"\u24df","9414":"\u24e0","9415":"\u24e1","9416":"\u24e2","9417":"\u24e3","9418":"\u24e4","9419":"\u24e5","9420":"\u24e6","9421":"\u24e7","9422":"\u24e8","9423":"\u24e9","975":"\u03d7","984":"\u03d9","986":"\u03db","988":"\u03dd","990":"\u03df","992":"\u03e1","994":"\u03e3","996":"\u03e5","998":"\u03e7"}$rewards_unicode17_map$::jsonb)->>original.point::text,original.scalar)END,''ORDER BY original.ordinal),'')COLLATE "C"
 FROM neighbors original LEFT JOIN classified prior_letter ON prior_letter.ordinal=original.prior_ordinal LEFT JOIN classified next_letter ON next_letter.ordinal=original.next_ordinal;
$$;
-- END GENERATED REWARDS UNICODE17
CREATE FUNCTION app.reward_calc_number(value text)RETURNS double precision
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v text:=app.reward_access_reason_trim(value);base integer;digits text;digit integer;result numeric:=0;result_float double precision;
BEGIN
 IF v IS NULL OR v=''THEN RETURN 0;END IF;
 IF v~'^0[xX][0-9a-fA-F]+$'THEN base:=16;ELSIF v~'^0[bB][01]+$'THEN base:=2;ELSIF v~'^0[oO][0-7]+$'THEN base:=8;END IF;
 IF base IS NOT NULL THEN
  digits:=lower(substr(v,3)COLLATE "C");FOR n IN 1..length(digits)LOOP digit:=strpos('0123456789abcdef',substr(digits,n,1))-1;result:=result*base+digit;END LOOP;
  RETURN result::double precision;
 END IF;
 IF v!~'^[+-]?(([0-9]+([.][0-9]*)?|[.][0-9]+)([eE][+-]?[0-9]+)?|Infinity)$'THEN RETURN NULL;END IF;
 BEGIN result_float:=v::double precision;
 EXCEPTION WHEN numeric_value_out_of_range THEN
  -- ECMAScript Number over/underflow is infinity or signed zero, not an exception.
  IF v~'[eE]-[0-9]+$'THEN RETURN 0;END IF;
  RETURN CASE WHEN left(v,1)='-'THEN'-Infinity'::double precision ELSE'Infinity'::double precision END;
 END;
 RETURN result_float;
END $$;
CREATE FUNCTION app.reward_calc_promotion_jump(proposed text,grade text)RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT advance=trunc(advance)AND advance BETWEEN 1 AND 3 FROM(SELECT app.reward_calc_number(proposed)-app.reward_calc_number(grade)advance)difference;
$$;
CREATE FUNCTION app.reward_calc_offcycle(p_entries jsonb,p_kind text,p_details jsonb,p_available jsonb)RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE rows jsonb:='[]';flags jsonb:='[]';budgets jsonb;entry jsonb;s jsonb;r jsonb;f jsonb;plan text;budget jsonb;basic numeric;merit_bp numeric;promotion_bp numeric;special_bp numeric;merit numeric;promotion numeric;special numeric;delta numeric;exception_reason text;message text;available numeric;
BEGIN
 IF jsonb_typeof(p_entries)IS DISTINCT FROM'array'OR p_kind IS NULL OR p_kind NOT IN('adhoc','midyear')OR jsonb_typeof(p_details->'exceptionReason')IS DISTINCT FROM'string'THEN RAISE EXCEPTION 'Invalid off-cycle calculation input' USING ERRCODE='22023';END IF;
 exception_reason:=p_details->>'exceptionReason';budgets:=jsonb_build_object('standard',app.reward_calc_blank_budget(),'h',app.reward_calc_blank_budget(),'ec',app.reward_calc_blank_budget());
 IF p_kind='adhoc'AND jsonb_array_length(p_entries)<>1 THEN flags:=flags||app.reward_calc_flag('block','OC-01','An ad-hoc request must contain exactly one employee.');END IF;
 IF jsonb_array_length(p_entries)=0 THEN flags:=flags||app.reward_calc_flag('block','OC-01','Add at least one employee.');END IF;
 IF exception_reason<>''AND(p_kind<>'adhoc'OR app.reward_calc_units(app.reward_access_reason_trim(exception_reason))<30)THEN flags:=flags||app.reward_calc_flag('block','OC-02','Only an ad-hoc request may use a budget exception, with a reason of at least 30 characters.');END IF;
 FOR entry IN SELECT value FROM jsonb_array_elements(p_entries)LOOP
  s:=entry->'source';r:=app.reward_calc_recommendation(entry->'recommendation');f:=app.reward_calc_facts(entry->'facts');
  IF jsonb_typeof(s->'basicCents')IS DISTINCT FROM'number'THEN RAISE EXCEPTION 'Invalid reward arithmetic input' USING ERRCODE='22003';END IF;
  basic:=app.reward_calc_integer((s->>'basicCents')::numeric,true);
  plan:=CASE WHEN f->>'confidentiality'='ec'THEN'ec'WHEN s->>'grade'='H'THEN'h'ELSE'standard'END;
  IF NOT(f->>'reviewed')::boolean OR coalesce(s->>'compensationId','')=''OR basic<=0 OR s->>'currency'IS DISTINCT FROM'MYR'OR coalesce(s->>'payMode','')NOT IN('monthly','custom_period')THEN flags:=flags||app.reward_calc_flag('block','OC-03','Verify the employee and their current MYR monthly salary.',entry->'id');END IF;
  IF(s->>'notice')::boolean OR(f->>'erCase')::boolean AND f->>'erDecision'<>'in'OR(f->>'pipCase')::boolean AND f->>'pipDecision'<>'lift'THEN flags:=flags||app.reward_calc_flag('block','OC-04','Resolve employee eligibility before submitting this request.',entry->'id');END IF;
  IF app.reward_calc_units(r->>'reason')<(CASE WHEN coalesce(r->>'promotionGrade','')<>''THEN 30 ELSE 10 END) THEN flags:=flags||app.reward_calc_flag('block','OC-05',CASE WHEN coalesce(r->>'promotionGrade','')<>''THEN'Record a promotion business case of at least 30 characters.'ELSE'Record an increment reason of at least 10 characters.'END,entry->'id');END IF;
  merit_bp:=coalesce((r->>'meritBp')::numeric,0);promotion_bp:=CASE WHEN coalesce(r->>'promotionGrade','')<>''THEN coalesce((r->>'promotionBp')::numeric,1000)ELSE 0 END;special_bp:=coalesce((r->>'specialBp')::numeric,0);
  IF coalesce(r->>'promotionGrade','')<>''THEN
   IF app.reward_calc_promotion_jump(r->>'promotionGrade',s->>'grade')IS NOT TRUE THEN flags:=flags||app.reward_calc_flag('block','OC-06','A promotion must advance one to three grades.',entry->'id');END IF;
   IF app.reward_calc_units(r->>'currentRoleSummary')<30 OR app.reward_calc_units(r->>'proposedRoleSummary')<30 OR app.reward_calc_lower(r->>'currentRoleSummary')COLLATE"C"=app.reward_calc_lower(r->>'proposedRoleSummary')COLLATE"C"THEN flags:=flags||app.reward_calc_flag('block','OC-07','Provide distinct current and proposed job-description summaries (at least 30 characters each).',entry->'id');END IF;
  END IF;
  merit:=app.reward_calc_increase(basic,merit_bp);promotion:=app.reward_calc_increase(basic,promotion_bp);special:=app.reward_calc_increase(basic,special_bp);delta:=app.reward_calc_integer(merit+promotion+special);
  IF delta=0 THEN flags:=flags||app.reward_calc_flag('block','OC-08','Enter a positive salary increase.',entry->'id');END IF;
  IF plan<>'ec'AND(CASE WHEN coalesce(r->>'promotionGrade','')<>''THEN delta::double precision*10>=basic::double precision*3 ELSE delta::double precision*10>basic::double precision END) THEN flags:=flags||app.reward_calc_flag('warning','INC-01','Increase exceeds the individual review threshold.',entry->'id');END IF;
  IF coalesce((r->>'bonusCents')::numeric,0)<>0 OR coalesce((r->>'lumpCents')::numeric,0)<>0 OR r->'multiplierBp'<>'null'::jsonb THEN flags:=flags||app.reward_calc_flag('block','OC-09','Off-cycle reviews support salary changes only.');END IF;
  IF plan='ec'AND exception_reason=''THEN flags:=flags||app.reward_calc_flag('block','OC-10','An EC-plan off-cycle award requires an ad-hoc budget exception.');END IF;
  budget:=budgets->plan;budget:=jsonb_set(budget,'{payrollCents}',to_jsonb(app.reward_calc_integer((budget->>'payrollCents')::numeric+basic)));budget:=jsonb_set(budget,'{used,0}',to_jsonb(app.reward_calc_integer((budget->'used'->>0)::numeric+delta)));budgets:=jsonb_set(budgets,ARRAY[plan],budget);
  rows:=rows||jsonb_build_array(entry||jsonb_build_object('facts',f,'recommendation',r,'activeInReview',coalesce(s->>'leftOn','')='','plan',plan,'incrementEligible',true,'bonusEligible',false,'lumpEligible',false,'incrementReason','','bonusReason','Off-cycle salary review','meritBp',merit_bp,'promotionBp',promotion_bp,'specialBp',special_bp,'meritCents',merit,'promotionCents',promotion,'specialCents',special,'newBasicCents',app.reward_calc_integer(basic+delta),'bonusCents',0,'standardBonusCents',0,'lumpCents',0,'bonusMultiplierBp',0,'payChange',NULL,'payWindowKept',false,'bonusBasicCents',basic));
 END LOOP;
 FOREACH plan IN ARRAY ARRAY['standard','h']LOOP
  IF jsonb_typeof(p_available->plan)IS DISTINCT FROM'number'THEN RAISE EXCEPTION 'Invalid reward funding input' USING ERRCODE='22003';END IF;
  available:=app.reward_calc_integer((p_available->>plan)::numeric);budgets:=jsonb_set(budgets,ARRAY[plan,'pools','0'],to_jsonb(available));
  IF(budgets->plan->'used'->>0)::numeric>available THEN flags:=flags||app.reward_calc_flag(CASE WHEN exception_reason<>''THEN'exception'ELSE'block'END,'OC-11',CASE WHEN plan='h'THEN'JG H'ELSE'Standard'END||' request exceeds its unreserved annual increment balance.');END IF;
 END LOOP;
 RETURN jsonb_build_object('rows',rows,'budgets',budgets,'flags',flags,'suggestedMultiplierBp',0,'suggestedLumpCents',0,'lumpUnitCents',0,'lumpWorking','[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION app.reward_calc_units(text),app.reward_calc_integer(numeric,boolean),app.reward_calc_ratio(numeric,numeric,numeric,boolean),app.reward_calc_increase(numeric,numeric),app.reward_calc_text(jsonb,integer,text),app.reward_calc_recommendation(jsonb),app.reward_calc_facts(jsonb),app.reward_calc_blank_budget(),app.reward_calc_flag(text,text,text,jsonb),app.reward_calc_lower(text),app.reward_calc_number(text),app.reward_calc_promotion_jump(text,text),app.reward_calc_offcycle(jsonb,text,jsonb,jsonb)FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.reward_calc_entry_visible(p_entry jsonb,p_roles text[],p_person uuid)RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT(p_person IS NULL OR p_entry->'source'->>'personId'IS DISTINCT FROM p_person::text)
 AND(p_entry->'facts'->>'reviewed'='true'OR'gr'=ANY(p_roles))
 AND CASE p_entry->'facts'->>'confidentiality'WHEN'ec'THEN p_roles&&ARRAY['gr','ctro','ec']WHEN'bg'THEN EXISTS(SELECT 1 FROM unnest(p_roles)r WHERE r NOT IN('bu','pbp'))WHEN'standard'THEN true ELSE false END;
$$;
CREATE FUNCTION app.reward_calc_senior(p_policy jsonb,p_entry jsonb)RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce((p_entry->'facts'->>'seniorPlan')::boolean,false)OR(p_policy->>'seniorMembershipMode'IS DISTINCT FROM'named-members'AND coalesce(p_policy->'seniorGrades','[]'::jsonb)?(p_entry->'source'->>'grade'));
$$;
CREATE FUNCTION app.reward_calc_offcycle_route(p_kind text,p_details jsonb,p_entries jsonb)RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN p_kind='midyear'THEN'["bu","bg","gr"]'::jsonb ELSE CASE WHEN(p_details->>'bgOrigin')::boolean THEN'["bg","gr","ctro"]'::jsonb ELSE'["bu","bg","gr","ctro"]'::jsonb END||CASE WHEN coalesce(p_details->>'exceptionReason','')<>''OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_entries)e WHERE app.reward_calc_number(e->'source'->>'grade')>=22 OR app.reward_calc_number(e->'recommendation'->>'promotionGrade')>=22 OR e->'facts'->>'confidentiality'='ec')THEN'["ec"]'::jsonb ELSE'[]'::jsonb END END;
$$;
REVOKE ALL ON FUNCTION app.reward_calc_entry_visible(jsonb,text[],uuid),app.reward_calc_senior(jsonb,jsonb),app.reward_calc_offcycle_route(text,jsonb,jsonb)FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.reward_calc_projection(p_calculation jsonb,p_policy jsonb,p_roles text[],p_person uuid,p_route jsonb)RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE entry jsonb;visible jsonb:='[]';visible_ids jsonb:='[]';flags jsonb;hidden_blocks bigint;plan text;counts jsonb:='{}';pay_windows jsonb:='{}';count_eligible bigint;count_increases bigint;count_reductions bigint;count_lump bigint;
BEGIN
 FOR entry IN SELECT value FROM jsonb_array_elements(p_calculation->'rows')LOOP
  IF app.reward_calc_entry_visible(entry,p_roles,p_person)IS TRUE THEN
   visible_ids:=visible_ids||jsonb_build_array(entry->'id');
   IF NOT(p_roles&&ARRAY['gr','ctro','ec'])AND app.reward_calc_senior(p_policy,entry)THEN entry:=entry||jsonb_build_object('recommendation',jsonb_build_object('meritBp',NULL,'promotionGrade',NULL,'promotionBp',NULL,'specialBp',NULL,'multiplierBp',NULL,'bonusCents',NULL,'lumpCents',NULL,'reason','','currentRoleSummary','','proposedRoleSummary',''),'newBasicCents',entry->'source'->'basicCents','bonusCents',0,'meritCents',0,'promotionCents',0,'specialCents',0,'lumpCents',0);END IF;
   visible:=visible||jsonb_build_array(entry);
  END IF;
 END LOOP;
 SELECT coalesce(jsonb_agg(f ORDER BY n)FILTER(WHERE NOT(f?'entryId')OR visible_ids?(f->>'entryId')),'[]'::jsonb),count(*)FILTER(WHERE f?'entryId'AND NOT(visible_ids?(f->>'entryId'))AND f->>'severity'='block')INTO flags,hidden_blocks FROM jsonb_array_elements(p_calculation->'flags')WITH ORDINALITY all_flags(f,n);
 IF hidden_blocks>0 THEN flags:=flags||app.reward_calc_flag('block','ACCESS-01','A restricted record needs review by its authorised reviewer.');END IF;
 FOREACH plan IN ARRAY ARRAY['standard','h']LOOP
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_calculation->'rows')e WHERE e->>'plan'=plan AND NOT app.reward_calc_senior(p_policy,e)AND NOT(visible_ids?(e->>'id')))THEN counts:=counts||jsonb_build_object(plan,NULL);
  ELSE
   SELECT count(*)FILTER(WHERE(e->>'bonusEligible')::boolean),count(*)FILTER(WHERE(e->>'bonusCents')::numeric>(e->>'standardBonusCents')::numeric),count(*)FILTER(WHERE(e->>'bonusCents')::numeric<(e->>'standardBonusCents')::numeric),count(*)FILTER(WHERE(e->>'lumpCents')::numeric>0)INTO count_eligible,count_increases,count_reductions,count_lump FROM jsonb_array_elements(p_calculation->'rows')e WHERE e->>'plan'=plan AND NOT app.reward_calc_senior(p_policy,e);
   counts:=counts||jsonb_build_object(plan,jsonb_build_object('eligible',count_eligible,'increases',count_increases,'reductions',count_reductions,'lump',count_lump));
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_calculation->'rows')e WHERE e->>'plan'=plan AND NOT(visible_ids?(e->>'id')))THEN pay_windows:=pay_windows||jsonb_build_object(plan,NULL);ELSE pay_windows:=pay_windows||jsonb_build_object(plan,jsonb_build_object('count',p_calculation->'budgets'->plan->'excludedCount','payrollCents',p_calculation->'budgets'->plan->'excludedPayrollCents'));END IF;
 END LOOP;
 RETURN(p_calculation-'rows'-'flags'-'budgets')||CASE WHEN p_calculation?'suggestion'AND NOT('gr'=ANY(p_roles))THEN'{"suggestion":null}'::jsonb ELSE'{}'::jsonb END||jsonb_build_object('rows',visible,'flags',flags,'budgets',(p_calculation->'budgets')-'ec','hiddenCount',jsonb_array_length(p_calculation->'rows')-jsonb_array_length(visible),'route',p_route,'bonusCounts',counts,'payWindow',pay_windows);
END $$;
REVOKE ALL ON FUNCTION app.reward_calc_projection(jsonb,jsonb,text[],uuid,jsonb)FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- A bounded actual-unit calculation read. The application cannot supply source rows, funding,
-- roles or a person discriminator, and never receives private/own/EC-hidden entry inputs.
-- Raw read policies remain unchanged until every independent native consumer is ported.
CREATE FUNCTION app.reward_calc_source_identity_current(p_unit uuid,p_tenant uuid)RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT NOT EXISTS(SELECT 1 FROM public.reward_entry e LEFT JOIN public.employment emp ON emp.id=e.employment_id AND emp.tenant_id=e.tenant_id WHERE e.unit_id=p_unit AND e.tenant_id=p_tenant AND(emp.id IS NULL OR e.source->>'employmentId'IS DISTINCT FROM e.employment_id::text OR e.source->>'personId'IS DISTINCT FROM emp.person_id::text));
$$;
REVOKE ALL ON FUNCTION app.reward_calc_source_identity_current(uuid,uuid)FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.reward_offcycle_calculation(p_unit uuid,p_revision integer)RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE unit public.reward_unit;actor public.app_user;roles text[];entries jsonb;calculation jsonb;funding jsonb;
BEGIN
 IF NOT app.principal_snapshot_current()OR app.current_user_id()IS NULL THEN RAISE EXCEPTION 'Reward calculation unavailable' USING ERRCODE='42501';END IF;
 SELECT actual.* INTO actor FROM public.app_user actual WHERE actual.id=app.current_user_id()AND actual.tenant_id=app.current_tenant_id()AND actual.archived_at IS NULL AND NOT app.login_blocked(actual.id);
 SELECT actual.* INTO unit FROM public.reward_unit actual WHERE actual.id=p_unit AND actual.tenant_id=app.current_tenant_id()AND actual.kind IN('adhoc','midyear')AND actual.deleted_at IS NULL;
 roles:=ARRAY(SELECT app.reward_roles(p_unit));
 IF actor.id IS NULL OR unit.id IS NULL OR cardinality(roles)=0 THEN RAISE EXCEPTION 'Reward calculation unavailable' USING ERRCODE='42501';END IF;
 IF app.function_action_allowed('rewards.review','view',unit.company_id)IS NOT TRUE THEN RAISE EXCEPTION 'Reward review function unavailable' USING ERRCODE='42501';END IF;
 IF unit.revision IS DISTINCT FROM p_revision THEN RAISE EXCEPTION 'Reward calculation changed' USING ERRCODE='40001';END IF;
 IF NOT app.reward_calc_source_identity_current(unit.id,unit.tenant_id)THEN RAISE EXCEPTION 'Reward recipient source unavailable' USING ERRCODE='42501';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',e.id,'source',e.source,'facts',e.facts,'recommendation',e.recommendation)ORDER BY e.id),'[]'::jsonb)INTO entries FROM public.reward_entry e WHERE e.tenant_id=unit.tenant_id AND e.unit_id=unit.id;
 funding:=app.reward_funding(unit.id,false);calculation:=app.reward_calc_offcycle(entries,unit.kind,unit.offcycle,funding);
 IF(funding->>'duplicate')::boolean THEN calculation:=jsonb_set(calculation,'{flags}',(calculation->'flags')||app.reward_calc_flag('block','OC-12','An employee already has an open off-cycle request against this annual review.'));END IF;
 RETURN app.reward_calc_projection(calculation,unit.policy,roles,actor.person_id,app.reward_calc_offcycle_route(unit.kind,unit.offcycle,entries));
END $$;
REVOKE ALL ON FUNCTION app.reward_offcycle_calculation(uuid,integer)FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_offcycle_calculation(uuid,integer)TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.reward_calc_json_integer(p_value jsonb,p_max numeric,p_min numeric DEFAULT 0)RETURNS numeric
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE value numeric;
BEGIN
 IF jsonb_typeof(p_value)IS DISTINCT FROM'number'THEN RAISE EXCEPTION 'Invalid reward policy number' USING ERRCODE='22023';END IF;
 value:=app.reward_calc_integer((p_value#>>'{}')::numeric);
 IF value<p_min OR value>p_max THEN RAISE EXCEPTION 'Invalid reward policy number' USING ERRCODE='22023';END IF;
 RETURN value;
END $$;
CREATE FUNCTION app.reward_calc_vector(p_value jsonb,p_count integer,p_max numeric)RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF jsonb_typeof(p_value)IS DISTINCT FROM'array'OR jsonb_array_length(p_value)<>p_count THEN RAISE EXCEPTION 'Invalid reward policy vector' USING ERRCODE='22023';END IF;
 PERFORM app.reward_calc_json_integer(value,p_max)FROM jsonb_array_elements(p_value);RETURN p_value;
END $$;
CREATE FUNCTION app.reward_calc_day(value text)RETURNS integer
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE y integer;m integer;d integer;days integer[]:=ARRAY[31,28,31,30,31,30,31,31,30,31,30,31];ordinal integer;
BEGIN
 IF value IS NULL OR value!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$'THEN RAISE EXCEPTION 'Invalid reward date' USING ERRCODE='22023';END IF;
 y:=left(value,4)::integer;m:=substr(value,6,2)::integer;d:=right(value,2)::integer;
 IF mod(y,4)=0 AND(mod(y,100)<>0 OR mod(y,400)=0)THEN days[2]:=29;END IF;
 IF m NOT BETWEEN 1 AND 12 OR d<1 OR d>days[m]THEN RAISE EXCEPTION 'Invalid reward date' USING ERRCODE='22023';END IF;
 ordinal:=365*(y-1)+floor((y-1)::numeric/4)::integer-floor((y-1)::numeric/100)::integer+floor((y-1)::numeric/400)::integer+d-1;
 FOR n IN 1..m-1 LOOP ordinal:=ordinal+days[n];END LOOP;RETURN ordinal;
END $$;
CREATE FUNCTION app.reward_calc_date(p_value jsonb)RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE value text:=p_value#>>'{}';
BEGIN
 IF jsonb_typeof(p_value)IS DISTINCT FROM'string'THEN RAISE EXCEPTION 'Invalid reward policy date' USING ERRCODE='22023';END IF;
 PERFORM app.reward_calc_day(value);RETURN value;
END $$;
CREATE FUNCTION app.reward_calc_policy(p jsonb)RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE k text;part record;result jsonb:=p;matrix jsonb:='{}';normalized jsonb;text_value text;number_value numeric;
BEGIN
 IF jsonb_typeof(p)IS DISTINCT FROM'object'OR EXISTS(SELECT 1 FROM jsonb_object_keys(p)fields(key_name) WHERE fields.key_name<>ALL(ARRAY['year','effectiveFrom','joinedBefore','confirmedBy','blockedFrom','blockedTo','unitGovernanceDigest','activeAsOf','minimumBonusRating','excludeNotice','excludeErCase','standardPools','hPools','meritMatrix','bonusMatrix','ranges','seniorGrades','seniorMembershipMode','patActual','patTarget','targetMonthsBp','multiplierBp','bonusStructure','branchFactors','branchRatings','lumpStepCents','lumpShareBp','lumpCapCents','lumpUnitCents','exemptReason','lumpReason','payWindowKeep']))THEN RAISE EXCEPTION 'Invalid reward policy' USING ERRCODE='22023';END IF;
 PERFORM app.reward_calc_json_integer(p->'year',2200,2000);
 FOREACH k IN ARRAY ARRAY['effectiveFrom','joinedBefore','confirmedBy','blockedFrom','blockedTo']LOOP PERFORM app.reward_calc_date(p->k);END LOOP;
 IF p?'activeAsOf'THEN PERFORM app.reward_calc_date(p->'activeAsOf');END IF;
 IF p->>'blockedFrom'>p->>'blockedTo'OR p?'unitGovernanceDigest'AND(jsonb_typeof(p->'unitGovernanceDigest')IS DISTINCT FROM'string'OR(p->>'unitGovernanceDigest')!~'^[a-f0-9]{64}$')OR p?'minimumBonusRating'AND coalesce(p->>'minimumBonusRating','')<>ALL(ARRAY['UA','BE','ME','AE','OU'])THEN RAISE EXCEPTION 'Invalid reward policy' USING ERRCODE='22023';END IF;
 FOREACH k IN ARRAY ARRAY['excludeNotice','excludeErCase']LOOP IF p?k AND jsonb_typeof(p->k)IS DISTINCT FROM'boolean'THEN RAISE EXCEPTION 'Invalid reward policy' USING ERRCODE='22023';END IF;END LOOP;
 FOREACH k IN ARRAY ARRAY['standardPools','hPools']LOOP PERFORM app.reward_calc_vector(p->k,3,100000);END LOOP;
 FOREACH k IN ARRAY ARRAY['SSTAR','STAR','SCORE','IMPRO','PIP']LOOP matrix:=matrix||jsonb_build_object(k,app.reward_calc_vector(p->'meritMatrix'->k,3,100000));END LOOP;
 result:=jsonb_set(result,'{meritMatrix}',matrix);
 FOREACH k IN ARRAY ARRAY['bonusMatrix','ranges','branchFactors','branchRatings']LOOP
  IF jsonb_typeof(p->k)IS DISTINCT FROM'object'THEN RAISE EXCEPTION 'Invalid reward policy map' USING ERRCODE='22023';END IF;
  FOR part IN SELECT key,value FROM jsonb_each(p->k)LOOP
   IF char_length(part.key)NOT BETWEEN 1 AND(CASE k WHEN'branchFactors'THEN 80 WHEN'branchRatings'THEN 100 ELSE 30 END) THEN RAISE EXCEPTION 'Invalid reward policy key' USING ERRCODE='22023';END IF;
   IF k='branchRatings'THEN
    IF jsonb_typeof(part.value)IS DISTINCT FROM'string'OR(part.value#>>'{}')<>ALL(ARRAY['UA','BE','ME','AE','OU'])THEN RAISE EXCEPTION 'Invalid reward policy branch rating' USING ERRCODE='22023';END IF;
   ELSIF k='ranges'THEN
    PERFORM app.reward_calc_vector(part.value,3,100000000000);
    IF(part.value->>0)::numeric<=0 OR(part.value->>0)::numeric>(part.value->>1)::numeric OR(part.value->>1)::numeric>(part.value->>2)::numeric THEN RAISE EXCEPTION 'Invalid reward salary range' USING ERRCODE='22023';END IF;
   ELSE PERFORM app.reward_calc_vector(part.value,5,100000);END IF;
  END LOOP;
 END LOOP;
 IF jsonb_typeof(p->'seniorGrades')IS DISTINCT FROM'array'OR jsonb_array_length(p->'seniorGrades')>50 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p->'seniorGrades')v WHERE jsonb_typeof(v)<>'string')OR p?'seniorMembershipMode'AND coalesce(p->>'seniorMembershipMode','')NOT IN('legacy-grades','named-members')THEN RAISE EXCEPTION 'Invalid reward Senior policy' USING ERRCODE='22023';END IF;
 PERFORM app.reward_calc_json_integer(p->'patActual',100000000000),app.reward_calc_json_integer(p->'patTarget',100000000000,1),app.reward_calc_json_integer(p->'targetMonthsBp',100000);
 FOREACH k IN ARRAY ARRAY['multiplierBp','lumpCapCents','lumpUnitCents']LOOP
  IF NOT(p?k)THEN RAISE EXCEPTION 'Invalid reward policy' USING ERRCODE='22023';END IF;
  IF p->k<>'null'::jsonb THEN PERFORM app.reward_calc_json_integer(p->k,CASE WHEN k='multiplierBp'THEN 100000 ELSE 100000000000 END);END IF;
 END LOOP;
 IF coalesce(p->>'bonusStructure','')NOT IN('standard','branch')THEN RAISE EXCEPTION 'Invalid reward bonus policy' USING ERRCODE='22023';END IF;
 number_value:=app.reward_calc_json_integer(p->'lumpStepCents',100000000000,1000);
 IF mod(number_value,1000)<>0 THEN RAISE EXCEPTION 'Invalid reward lump rounding' USING ERRCODE='22023';END IF;
 PERFORM app.reward_calc_json_integer(p->'lumpShareBp',10000);
 text_value:=app.reward_calc_text(p->'exemptReason',2000);IF text_value<>''AND app.reward_calc_units(text_value)<10 THEN RAISE EXCEPTION 'Invalid reward exemption' USING ERRCODE='22023';END IF;
 result:=jsonb_set(result,'{exemptReason}',to_jsonb(text_value));
 IF p?'lumpReason'THEN result:=jsonb_set(result,'{lumpReason}',to_jsonb(app.reward_calc_text(p->'lumpReason',1000)));END IF;
 IF p?'payWindowKeep'THEN
  IF jsonb_typeof(p->'payWindowKeep')IS DISTINCT FROM'object'THEN RAISE EXCEPTION 'Invalid reward pay window' USING ERRCODE='22023';END IF;
  normalized:='{}';FOR part IN SELECT key,value FROM jsonb_each(p->'payWindowKeep')LOOP
   text_value:=app.reward_calc_text(part.value,1000);
   IF char_length(part.key)NOT BETWEEN 1 AND 64 OR char_length(text_value)<10 THEN RAISE EXCEPTION 'Invalid reward pay window' USING ERRCODE='22023';END IF;
   normalized:=normalized||jsonb_build_object(part.key,text_value);
  END LOOP;result:=jsonb_set(result,'{payWindowKeep}',normalized);
 END IF;
 RETURN result;
END $$;
--> statement-breakpoint
-- Exact first pass of calculateRewards. Shared cohorts/budgets/bonus/lump/Senior overrides are
-- deliberately a separate private phase; this seed is never a public final calculation result.
CREATE FUNCTION app.reward_calc_annual_seed(p_entries jsonb,p_input jsonb)RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE policy jsonb:=app.reward_calc_policy(p_input);entry jsonb;s jsonb;r jsonb;f jsonb;rows jsonb:='[]';flags jsonb:='[]';plan text;basic numeric;left_review boolean;kept boolean;window_change jsonb;pay_change jsonb;increment_reason text;bonus_reason text;increment_eligible boolean;bonus_eligible boolean;senior boolean;salary_range jsonb;range_position integer;merit_default numeric;merit_bp numeric;promotion_bp numeric;
BEGIN
 IF jsonb_typeof(p_entries)IS DISTINCT FROM'array'THEN RAISE EXCEPTION 'Invalid reward entries' USING ERRCODE='22023';END IF;
 FOR entry IN SELECT value FROM jsonb_array_elements(p_entries)LOOP
  s:=entry->'source';r:=app.reward_calc_recommendation(entry->'recommendation');f:=app.reward_calc_facts(entry->'facts');
  IF jsonb_typeof(s->'basicCents')IS DISTINCT FROM'number'THEN RAISE EXCEPTION 'Invalid salary snapshot' USING ERRCODE='22003';END IF;
  basic:=app.reward_calc_integer((s->>'basicCents')::numeric,true);plan:=CASE WHEN f->>'confidentiality'='ec'THEN'ec'WHEN s->>'grade'='H'THEN'h'ELSE'standard'END;
  IF NOT(f->>'reviewed')::boolean THEN flags:=flags||app.reward_calc_flag('block','DATA-01','Validate the reward classification and ratings before submission.',entry->'id');END IF;
  IF coalesce(s->>'compensationId','')=''OR basic<=0 OR s->>'currency'IS DISTINCT FROM'MYR'OR coalesce(s->>'payMode','')NOT IN('monthly','custom_period')THEN flags:=flags||app.reward_calc_flag('block','DATA-02','A positive MYR monthly salary record is required for this reward policy.',entry->'id');END IF;
  left_review:=coalesce(s->>'leftOn','')<>''AND(NOT(policy?'activeAsOf')OR s->>'leftOn'<=policy->>'activeAsOf');kept:=coalesce(policy->'payWindowKeep'->>(s->>'employmentId'),'')<>'';window_change:=NULL;
  IF jsonb_typeof(s->'payChanges')='array'THEN SELECT change INTO window_change FROM jsonb_array_elements(s->'payChanges')WITH ORDINALITY changes(change,n)WHERE change->>'on'>=policy->>'blockedFrom'AND change->>'on'<=policy->>'blockedTo'ORDER BY n DESC LIMIT 1;
  ELSIF coalesce(s->>'lastPayChange','')<>''AND s->>'lastPayChange'>=policy->>'blockedFrom'AND s->>'lastPayChange'<=policy->>'blockedTo'THEN window_change:=jsonb_build_object('on',s->'lastPayChange','basicCents',s->'basicCents','kind',NULL);END IF;
  pay_change:=CASE WHEN kept THEN NULL ELSE window_change END;senior:=app.reward_calc_senior(policy,entry);increment_reason:='';
  IF left_review THEN increment_reason:='Left or moved out';ELSIF senior THEN increment_reason:='Senior leadership plan';ELSIF(s->>'notice')::boolean THEN increment_reason:='Serving notice';ELSIF s->>'hiredOn'>=policy->>'joinedBefore'THEN increment_reason:='Joined after the increment cutoff';ELSIF coalesce(s->>'confirmedOn','')=''OR s->>'confirmedOn'>policy->>'confirmedBy'THEN increment_reason:='Not confirmed by the cutoff';ELSIF NOT kept AND(s->>'confirmationPayChange')::boolean AND s->>'confirmedOn'>=policy->>'blockedFrom'THEN increment_reason:='Confirmation included a pay change';ELSIF pay_change IS NOT NULL THEN increment_reason:='Pay change in the exclusion window';ELSIF f->>'talent'IS NULL THEN increment_reason:='No talent rating';ELSIF(f->>'erCase')::boolean AND f->>'erDecision'<>'in'THEN increment_reason:='ER case held or awaiting decision';ELSIF(f->>'pipCase')::boolean AND f->>'pipDecision'<>'lift'THEN increment_reason:='PIP confirmed or awaiting decision';ELSIF f->>'talent'IN('IMPRO','PIP')THEN increment_reason:='Nil increment rating';END IF;
  IF(f->>'erCase')::boolean AND f->>'erDecision'='pending'OR(f->>'pipCase')::boolean AND f->>'pipDecision'='pending'THEN flags:=flags||app.reward_calc_flag('block','ELIG-02','Record the BU CEO and PBP case decision.',entry->'id');END IF;
  IF((f->>'erCase')::boolean AND f->>'erDecision'<>'pending'OR(f->>'pipCase')::boolean AND f->>'pipDecision'<>'pending')AND app.reward_calc_units(f->>'caseReason')<10 THEN flags:=flags||app.reward_calc_flag('block','ELIG-02','Record the reason for the case decision.',entry->'id');END IF;
  increment_eligible:=increment_reason='';bonus_reason:='';
  IF left_review THEN bonus_reason:='Left or moved out';ELSIF senior THEN bonus_reason:='Senior leadership plan';ELSIF(s->>'notice')::boolean AND policy->'excludeNotice'IS DISTINCT FROM'false'::jsonb THEN bonus_reason:='Serving notice';ELSIF(f->>'erCase')::boolean AND policy->'excludeErCase'IS DISTINCT FROM'false'::jsonb THEN bonus_reason:='ER case';ELSIF coalesce(s->>'confirmedOn','')=''OR s->>'confirmedOn'>policy->>'confirmedBy'THEN bonus_reason:='Not confirmed by the cutoff';ELSIF f->>'performance'IS NULL THEN bonus_reason:='No performance rating';ELSIF policy?'minimumBonusRating'AND array_position(ARRAY['UA','BE','ME','AE','OU'],f->>'performance')<array_position(ARRAY['UA','BE','ME','AE','OU'],policy->>'minimumBonusRating')THEN bonus_reason:='Below the minimum bonus rating';END IF;
  bonus_eligible:=bonus_reason='';salary_range:=policy->'ranges'->coalesce(r->>'promotionGrade',s->>'grade');
  IF salary_range IS NULL AND increment_eligible AND plan<>'ec'THEN flags:=flags||app.reward_calc_flag('block','DATA-03','Configure the salary range for this grade.',entry->'id');END IF;
  IF bonus_eligible AND NOT(policy->'bonusMatrix'?(s->>'grade'))AND plan<>'ec'THEN flags:=flags||app.reward_calc_flag('block','DATA-04','Configure the bonus matrix for this grade.',entry->'id');END IF;
  range_position:=CASE WHEN salary_range IS NULL THEN 1 WHEN basic<(salary_range->>0)::numeric THEN 0 WHEN basic>(salary_range->>2)::numeric THEN 2 ELSE 1 END;
  merit_default:=CASE WHEN increment_eligible AND f->>'talent'IS NOT NULL THEN(policy->'meritMatrix'->(f->>'talent')->>range_position)::numeric ELSE 0 END;
  merit_bp:=CASE WHEN left_review THEN 0 WHEN plan='ec'THEN coalesce((r->>'meritBp')::numeric,merit_default)WHEN increment_eligible THEN coalesce((r->>'meritBp')::numeric,merit_default)ELSE 0 END;
  promotion_bp:=CASE WHEN NOT left_review AND(increment_eligible OR plan='ec')AND coalesce(r->>'promotionGrade','')<>''THEN coalesce((r->>'promotionBp')::numeric,1000)ELSE 0 END;
  IF coalesce(r->>'promotionGrade','')<>''AND NOT left_review THEN
   IF NOT increment_eligible AND plan<>'ec'THEN flags:=flags||app.reward_calc_flag('block','PRO-03','This employee is not eligible for an annual promotion award.',entry->'id');END IF;
   IF app.reward_calc_promotion_jump(r->>'promotionGrade',s->>'grade')IS NOT TRUE THEN flags:=flags||app.reward_calc_flag('block','PRO-01','A promotion must advance one to three grades.',entry->'id');END IF;
   IF app.reward_calc_units(r->>'reason')<30 THEN flags:=flags||app.reward_calc_flag('block','PRO-02','A promotion needs a business case of at least 30 characters.',entry->'id');END IF;
  END IF;
  IF NOT left_review AND r->'meritBp'<>'null'::jsonb AND(r->>'meritBp')::numeric<>merit_default AND plan<>'ec'THEN flags:=flags||app.reward_calc_flag('exception','POOL-05','Individual merit differs from the matrix.',entry->'id');END IF;
  IF NOT left_review AND r->'promotionBp'<>'null'::jsonb AND(r->>'promotionBp')::numeric<>1000 AND coalesce(r->>'promotionGrade','')<>''THEN flags:=flags||app.reward_calc_flag('exception','POOL-05','Promotion differs from the standard 10%.',entry->'id');END IF;
  rows:=rows||jsonb_build_array(entry||jsonb_build_object('facts',f,'recommendation',r,'activeInReview',NOT left_review,'plan',plan,'incrementEligible',increment_eligible,'bonusEligible',bonus_eligible,'lumpEligible',NOT left_review AND NOT bonus_eligible AND NOT senior AND plan<>'ec'AND NOT(f->>'erCase')::boolean,'incrementReason',increment_reason,'bonusReason',bonus_reason,'meritBp',merit_bp,'promotionBp',promotion_bp,'specialBp',0,'payChange',CASE WHEN window_change IS NULL THEN NULL ELSE jsonb_build_object('on',window_change->'on','kind',window_change->'kind')END,'payWindowKept',kept AND window_change IS NOT NULL,'bonusBasicCents',CASE WHEN pay_change IS NOT NULL THEN(pay_change->>'basicCents')::numeric ELSE basic END,'meritCents',app.reward_calc_increase(basic,merit_bp),'promotionCents',app.reward_calc_increase(basic,promotion_bp),'specialCents',0,'newBasicCents',basic,'bonusCents',0,'standardBonusCents',0,'lumpCents',0,'bonusMultiplierBp',0));
 END LOOP;
 RETURN jsonb_build_object('rows',rows,'flags',flags);
END $$;
REVOKE ALL ON FUNCTION app.reward_calc_day(text),app.reward_calc_json_integer(jsonb,numeric,numeric),app.reward_calc_vector(jsonb,integer,numeric),app.reward_calc_date(jsonb),app.reward_calc_policy(jsonb),app.reward_calc_annual_seed(jsonb,jsonb)FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.reward_calc_bonus_base(p_row jsonb,p_policy jsonb)RETURNS numeric
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE year_start integer:=app.reward_calc_day((p_policy->>'year')||'-01-01');year_end integer:=app.reward_calc_day((p_policy->>'year')||'-12-31');year_days integer;days integer;months numeric;
BEGIN
 IF(p_row->>'bonusEligible')::boolean IS NOT TRUE OR p_row->'facts'->>'performance'IS NULL THEN RETURN 0;END IF;
 year_days:=year_end-year_start+1;days:=greatest(0,least(year_days,year_end-greatest(year_start,app.reward_calc_day(p_row->'source'->>'hiredOn'))+1));
 months:=coalesce((p_policy->'bonusMatrix'->(p_row->'source'->>'grade')->>(array_position(ARRAY['UA','BE','ME','AE','OU'],p_row->'facts'->>'performance')-1))::numeric,0);
 RETURN app.reward_calc_ratio(app.reward_calc_ratio((p_row->>'bonusBasicCents')::numeric,months,10000),days,year_days);
END $$;
CREATE FUNCTION app.reward_calc_annual(p_entries jsonb,p_input jsonb,p_controls jsonb DEFAULT '{}'::jsonb)RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE policy jsonb:=app.reward_calc_policy(p_input);seed jsonb:=app.reward_calc_annual_seed(p_entries,policy);rows jsonb:=seed->'rows';flags jsonb:=seed->'flags';budgets jsonb;plan text;budget jsonb;group_rows jsonb;row_value jsonb;s jsonb;r jsonb;f jsonb;salary_range jsonb;percentages jsonb;pools jsonb;star_indices integer[];star_payroll numeric;maximum_need numeric;need numeric;cohort_bp numeric;basic numeric;catch_up numeric;top_up numeric;special numeric;special_bp numeric;new_basic numeric;payroll numeric;bonus_payroll numeric;excluded_payroll numeric;excluded_count integer;bonus_pool numeric;cost numeric;affordable jsonb:='{}';suggested_multiplier numeric:=NULL;suggestion jsonb;multiplier numeric;rating text;factors jsonb;bonus_base numeric;standard_bonus numeric;bonus_multiplier numeric;bonus numeric;lump_working jsonb:='[]';lump_count integer;balance numeric;available numeric;per_person numeric;suggested_lump numeric:=NULL;lump_unit numeric;lump numeric;used jsonb;used_amount numeric;standard_total numeric;increases numeric;reductions numeric;lump_total numeric;bonus_used numeric;severity text;code text;award jsonb;pool_status text:=coalesce(p_controls->>'poolStatus','legacy');labels text[]:=ARRAY['merit','promotion','special adjustment'];n integer;j integer;
BEGIN
 budgets:=jsonb_build_object('standard',app.reward_calc_blank_budget(),'h',app.reward_calc_blank_budget(),'ec',app.reward_calc_blank_budget());
 FOREACH plan IN ARRAY ARRAY['standard','h','ec']LOOP
  SELECT coalesce(jsonb_agg(e ORDER BY ordinal),'[]'::jsonb)INTO group_rows FROM jsonb_array_elements(rows)WITH ORDINALITY entries(e,ordinal)WHERE e->>'plan'=plan AND NOT app.reward_calc_senior(policy,e);
  SELECT app.reward_calc_integer(coalesce(sum((e->'source'->>'basicCents')::numeric)FILTER(WHERE(e->>'incrementEligible')::boolean OR e->>'incrementReason'IN('Nil increment rating','PIP confirmed or awaiting decision')AND NOT((e->'facts'->>'pipCase')::boolean AND e->'facts'->>'pipDecision'='pending')),0)),app.reward_calc_integer(coalesce(sum((e->>'bonusBasicCents')::numeric)FILTER(WHERE(e->>'bonusEligible')::boolean),0)),count(*)FILTER(WHERE e->>'incrementReason'IN('Confirmation included a pay change','Pay change in the exclusion window')),app.reward_calc_integer(coalesce(sum((e->'source'->>'basicCents')::numeric)FILTER(WHERE e->>'incrementReason'IN('Confirmation included a pay change','Pay change in the exclusion window')),0))INTO payroll,bonus_payroll,excluded_count,excluded_payroll FROM jsonb_array_elements(group_rows)e;
  percentages:=CASE WHEN plan='h'THEN policy->'hPools'ELSE policy->'standardPools'END;
  SELECT jsonb_agg(to_jsonb(app.reward_calc_ratio(payroll,value::text::numeric,10000))ORDER BY ordinal)INTO pools FROM jsonb_array_elements(percentages)WITH ORDINALITY parts(value,ordinal);
  bonus_pool:=CASE WHEN plan<>'ec'AND p_controls?'bonusPools'THEN app.reward_calc_json_integer(p_controls->'bonusPools'->plan,9007199254740991)ELSE app.reward_calc_ratio(app.reward_calc_ratio(bonus_payroll,(policy->>'patActual')::numeric,(policy->>'patTarget')::numeric),(policy->>'targetMonthsBp')::numeric,10000)END;
  budget:=app.reward_calc_blank_budget()||jsonb_build_object('payrollCents',payroll,'pools',pools,'bonusPayrollCents',bonus_payroll,'excludedCount',excluded_count,'excludedPayrollCents',excluded_payroll,'bonusPoolCents',bonus_pool);budgets:=jsonb_set(budgets,ARRAY[plan],budget);
  SELECT coalesce(array_agg((ordinal-1)::integer ORDER BY ordinal),ARRAY[]::integer[])INTO star_indices FROM jsonb_array_elements(rows)WITH ORDINALITY entries(e,ordinal)WHERE e->>'plan'=plan AND NOT app.reward_calc_senior(policy,e)AND(e->>'incrementEligible')::boolean AND e->'facts'->>'talent'IN('STAR','SSTAR')AND policy->'ranges'->coalesce(e->'recommendation'->>'promotionGrade',e->'source'->>'grade')IS NOT NULL AND(e->'source'->>'basicCents')::double precision*10<(policy->'ranges'->coalesce(e->'recommendation'->>'promotionGrade',e->'source'->>'grade')->>1)::double precision*9;
  star_payroll:=0;maximum_need:=0;
  FOREACH n IN ARRAY star_indices LOOP
   row_value:=rows->n;basic:=(row_value->'source'->>'basicCents')::numeric;salary_range:=policy->'ranges'->coalesce(row_value->'recommendation'->>'promotionGrade',row_value->'source'->>'grade');star_payroll:=app.reward_calc_integer(star_payroll+basic);
   need:=app.reward_calc_ratio(greatest(0,app.reward_calc_ratio((salary_range->>1)::numeric,9,10)-basic-(row_value->>'meritCents')::numeric-(row_value->>'promotionCents')::numeric),10000,basic);maximum_need:=greatest(maximum_need,need);
  END LOOP;
  cohort_bp:=CASE WHEN star_payroll>0 THEN div(least(app.reward_calc_ratio((pools->>2)::numeric,10000,star_payroll),maximum_need),50)*50 ELSE 0 END;
  FOR n IN 0..jsonb_array_length(rows)-1 LOOP
   row_value:=rows->n;IF row_value->>'plan'<>plan OR app.reward_calc_senior(policy,row_value)THEN CONTINUE;END IF;
   s:=row_value->'source';r:=row_value->'recommendation';basic:=(s->>'basicCents')::numeric;salary_range:=policy->'ranges'->coalesce(r->>'promotionGrade',s->>'grade');
   catch_up:=CASE WHEN n=ANY(star_indices)THEN app.reward_calc_increase(basic,CASE WHEN(row_value->>'promotionBp')::numeric<>0 THEN cohort_bp ELSE least(cohort_bp,greatest(0,1000-(row_value->>'meritBp')::numeric))END)ELSE 0 END;
   top_up:=CASE WHEN salary_range IS NOT NULL AND(row_value->>'incrementEligible')::boolean THEN greatest(0,ceil(((salary_range->>0)::numeric-basic-(row_value->>'meritCents')::numeric-(row_value->>'promotionCents')::numeric-catch_up)/100)*100)ELSE 0 END;
   special:=CASE WHEN NOT(row_value->>'activeInReview')::boolean THEN 0 WHEN plan='ec'THEN app.reward_calc_increase(basic,coalesce((r->>'specialBp')::numeric,0))WHEN(row_value->>'incrementEligible')::boolean THEN CASE WHEN r->'specialBp'<>'null'::jsonb THEN app.reward_calc_increase(basic,(r->>'specialBp')::numeric)ELSE catch_up+top_up END ELSE 0 END;
   special_bp:=CASE WHEN basic<>0 THEN app.reward_calc_ratio(special,10000,basic,true)ELSE 0 END;new_basic:=app.reward_calc_integer(basic+(row_value->>'meritCents')::numeric+(row_value->>'promotionCents')::numeric+special);
   row_value:=row_value||jsonb_build_object('specialCents',special,'specialBp',special_bp,'newBasicCents',new_basic);rows:=jsonb_set(rows,ARRAY[n::text],row_value);
   IF coalesce(s->>'leftOn','')=''AND r->'specialBp'<>'null'::jsonb AND special<>catch_up+top_up AND plan<>'ec'THEN flags:=flags||app.reward_calc_flag('exception','POOL-05','Special adjustment differs from the calculated amount.',row_value->'id');END IF;
   IF plan<>'ec'AND(CASE WHEN coalesce(r->>'promotionGrade','')<>''THEN(new_basic-basic)::double precision*10>=basic::double precision*3 ELSE(new_basic-basic)::double precision*10>basic::double precision END) THEN flags:=flags||app.reward_calc_flag('warning','INC-01','Increase exceeds the individual review threshold.',row_value->'id');END IF;
   IF salary_range IS NOT NULL AND new_basic>(salary_range->>2)::numeric THEN flags:=flags||app.reward_calc_flag('review','RANGE-01','New salary is above the range maximum.',row_value->'id');END IF;
  END LOOP;
 END LOOP;
 FOREACH plan IN ARRAY ARRAY['standard','h']LOOP
  SELECT app.reward_calc_integer(coalesce(sum(app.reward_calc_bonus_base(e,policy)),0))INTO cost FROM jsonb_array_elements(rows)e WHERE e->>'plan'=plan;
  available:=CASE WHEN cost>0 THEN app.reward_calc_ratio((budgets->plan->>'bonusPoolCents')::numeric,10000,cost)ELSE NULL END;affordable:=affordable||jsonb_build_object(plan,available);
  IF available IS NOT NULL THEN suggested_multiplier:=CASE WHEN suggested_multiplier IS NULL THEN available ELSE least(suggested_multiplier,available)END;END IF;
 END LOOP;
 suggested_multiplier:=div(coalesce(suggested_multiplier,0),100)*100;
 suggestion:=jsonb_build_object('patActualMissing',(policy->>'patActual')::numeric=0,'achievementBp',app.reward_calc_ratio((policy->>'patActual')::numeric,10000,(policy->>'patTarget')::numeric),'targetMonthsBp',policy->'targetMonthsBp','poolMultiplierBp',app.reward_calc_ratio((policy->>'patActual')::numeric,(policy->>'targetMonthsBp')::numeric,(policy->>'patTarget')::numeric),'affordableBp',affordable);
 FOR n IN 0..jsonb_array_length(rows)-1 LOOP
  row_value:=rows->n;r:=row_value->'recommendation';f:=row_value->'facts';multiplier:=coalesce((policy->>'multiplierBp')::numeric,suggested_multiplier);rating:=NULL;
  IF policy->>'bonusStructure'='branch'THEN
   rating:=policy->'branchRatings'->>(f->>'branch');factors:=policy->'branchFactors'->(f->>'segment');multiplier:=CASE WHEN rating='UA'THEN 0 WHEN rating IS NOT NULL AND factors IS NOT NULL THEN(factors->>(array_position(ARRAY['UA','BE','ME','AE','OU'],rating)-1))::numeric ELSE 0 END;
   IF(row_value->>'bonusEligible')::boolean AND(rating IS NULL OR factors IS NULL)AND row_value->>'plan'<>'ec'THEN flags:=flags||app.reward_calc_flag('block','PPCH-01','Set the branch rating and bonus segment factor.',row_value->'id');END IF;
  END IF;
  bonus_base:=app.reward_calc_bonus_base(row_value,policy);standard_bonus:=div(app.reward_calc_ratio(bonus_base,multiplier,10000),100)*100;bonus_multiplier:=CASE WHEN policy->>'bonusStructure'='branch'AND rating='UA'THEN 0 ELSE coalesce((r->>'multiplierBp')::numeric,multiplier)END;
  bonus:=CASE WHEN NOT(row_value->>'activeInReview')::boolean THEN 0 WHEN row_value->>'plan'='ec'AND r->'bonusCents'<>'null'::jsonb THEN(r->>'bonusCents')::numeric ELSE div(app.reward_calc_ratio(bonus_base,bonus_multiplier,10000),100)*100 END;
  rows:=jsonb_set(rows,ARRAY[n::text],row_value||jsonb_build_object('standardBonusCents',standard_bonus,'bonusMultiplierBp',bonus_multiplier,'bonusCents',bonus));
  IF r->'multiplierBp'<>'null'::jsonb AND(r->>'multiplierBp')::numeric<>multiplier AND(row_value->>'bonusEligible')::boolean AND row_value->>'plan'<>'ec'THEN flags:=flags||app.reward_calc_flag('exception','BUD-02','Individual bonus differs from the unit multiplier.',row_value->'id');END IF;
 END LOOP;
 FOREACH plan IN ARRAY ARRAY['standard','h']LOOP
  SELECT count(*)FILTER(WHERE(e->>'lumpEligible')::boolean),app.reward_calc_integer(coalesce(sum((e->>'bonusCents')::numeric),0))INTO lump_count,bonus_used FROM jsonb_array_elements(rows)e WHERE e->>'plan'=plan AND NOT app.reward_calc_senior(policy,e);
  balance:=greatest(0,(budgets->plan->>'bonusPoolCents')::numeric-bonus_used);available:=app.reward_calc_ratio(balance,(policy->>'lumpShareBp')::numeric,10000);
  IF lump_count>0 THEN
   per_person:=app.reward_calc_ratio(available,1,lump_count::numeric*(policy->>'lumpStepCents')::numeric)*(policy->>'lumpStepCents')::numeric;lump_working:=lump_working||jsonb_build_array(jsonb_build_object('plan',plan,'count',lump_count,'balanceCents',balance,'perPersonCents',per_person));suggested_lump:=CASE WHEN suggested_lump IS NULL THEN per_person ELSE least(suggested_lump,per_person)END;
  END IF;
 END LOOP;
 suggested_lump:=CASE WHEN suggested_lump IS NULL THEN 0 ELSE least(suggested_lump,coalesce((policy->>'lumpCapCents')::numeric,9007199254740991))END;lump_unit:=coalesce((policy->>'lumpUnitCents')::numeric,suggested_lump);
 IF lump_unit>suggested_lump THEN flags:=flags||app.reward_calc_flag('warning','BUD-05','The unit lump sum exceeds the amount supported by the remaining budget.');END IF;
 IF lump_unit=0 AND EXISTS(SELECT 1 FROM jsonb_array_elements(rows)e WHERE(e->>'lumpEligible')::boolean)THEN flags:=flags||app.reward_calc_flag('review','BUD-05','The unit lump-sum provision is withheld (RM 0)'||CASE WHEN coalesce(policy->>'lumpReason','')<>''THEN': '||(policy->>'lumpReason')ELSE'.'END);END IF;
 FOR n IN 0..jsonb_array_length(rows)-1 LOOP
  row_value:=rows->n;r:=row_value->'recommendation';lump:=CASE WHEN NOT(row_value->>'activeInReview')::boolean THEN 0 WHEN row_value->>'plan'='ec'THEN coalesce((r->>'lumpCents')::numeric,0)WHEN(row_value->>'lumpEligible')::boolean THEN coalesce((r->>'lumpCents')::numeric,lump_unit)ELSE 0 END;
  rows:=jsonb_set(rows,ARRAY[n::text],row_value||jsonb_build_object('lumpCents',lump));
  IF(row_value->>'lumpEligible')::boolean AND r->'lumpCents'<>'null'::jsonb AND lump<>lump_unit THEN flags:=flags||app.reward_calc_flag('exception','BUD-05','Individual lump sum differs from the unit amount; RM 0 means withheld.',row_value->'id');END IF;
 END LOOP;
 FOREACH plan IN ARRAY ARRAY['standard','h','ec']LOOP
  SELECT jsonb_build_array(app.reward_calc_integer(coalesce(sum((e->>'meritCents')::numeric),0)),app.reward_calc_integer(coalesce(sum((e->>'promotionCents')::numeric),0)),app.reward_calc_integer(coalesce(sum((e->>'specialCents')::numeric),0))),app.reward_calc_integer(coalesce(sum((e->>'standardBonusCents')::numeric),0)),app.reward_calc_integer(coalesce(sum(greatest(0,(e->>'bonusCents')::numeric-(e->>'standardBonusCents')::numeric)),0)),app.reward_calc_integer(coalesce(sum(greatest(0,(e->>'standardBonusCents')::numeric-(e->>'bonusCents')::numeric)),0)),app.reward_calc_integer(coalesce(sum((e->>'lumpCents')::numeric),0)),count(*)FILTER(WHERE(e->>'lumpCents')::numeric>0),app.reward_calc_integer(coalesce(sum((e->>'bonusCents')::numeric+(e->>'lumpCents')::numeric),0))INTO used,standard_total,increases,reductions,lump_total,lump_count,bonus_used FROM jsonb_array_elements(rows)e WHERE e->>'plan'=plan;
  budget:=budgets->plan;bonus_pool:=(budget->>'bonusPoolCents')::numeric;budget:=budget||jsonb_build_object('used',used,'standardBonusCents',standard_total,'increasesCents',increases,'reductionsCents',reductions,'lumpCents',lump_total,'lumpCount',lump_count,'bonusUsedCents',bonus_used,'balanceCents',bonus_pool-bonus_used);budgets:=jsonb_set(budgets,ARRAY[plan],budget);
  IF plan='ec'THEN CONTINUE;END IF;
  severity:=CASE WHEN policy->>'exemptReason'<>''THEN'review'ELSE'block'END;code:=CASE WHEN policy->>'exemptReason'<>''THEN'CFG-01'ELSE'POOL-03'END;
  FOR j IN 0..2 LOOP IF(used->>j)::numeric>(budget->'pools'->>j)::numeric THEN flags:=flags||app.reward_calc_flag(severity,code,CASE WHEN plan='h'THEN'JG H'ELSE'Standard'END||' '||labels[j+1]||' exceeds its separate pool.');END IF;END LOOP;
  IF bonus_used>bonus_pool THEN flags:=flags||app.reward_calc_flag(CASE WHEN pool_status='final'THEN'block'ELSE severity END,CASE WHEN policy->>'exemptReason'<>''THEN'CFG-01'ELSE'BUD-01'END,CASE WHEN plan='h'THEN'JG H'ELSE'Standard'END||' bonus exceeds the 100% budget cap.');END IF;
  IF bonus_pool>0 AND bonus_used::double precision*100<bonus_pool::double precision*80 THEN flags:=flags||app.reward_calc_flag('warning','BUD-07',CASE WHEN plan='h'THEN'JG H'ELSE'Standard'END||' bonus budget is less than 80% utilised.');END IF;
 END LOOP;
 FOR n IN 0..jsonb_array_length(rows)-1 LOOP
  row_value:=rows->n;IF NOT app.reward_calc_senior(policy,row_value)THEN CONTINUE;END IF;
  award:=p_controls->'seniorAwards'->(row_value->>'id');row_value:=row_value||jsonb_build_object('meritBp',0,'promotionBp',0,'specialBp',0,'meritCents',0,'promotionCents',0,'specialCents',0,'standardBonusCents',0,'lumpCents',0,'newBasicCents',CASE WHEN NOT(row_value->>'activeInReview')::boolean THEN(row_value->'source'->>'basicCents')::numeric ELSE coalesce((award->>'newBasicCents')::numeric,(row_value->'source'->>'basicCents')::numeric)END,'bonusCents',CASE WHEN NOT(row_value->>'activeInReview')::boolean THEN 0 ELSE coalesce((award->>'bonusCents')::numeric,0)END);rows:=jsonb_set(rows,ARRAY[n::text],row_value);
 END LOOP;
 IF pool_status='not-set'THEN flags:=flags||app.reward_calc_flag('block','PAT-01','Enter a valid unit PAT and target before calculating the bonus pool.');END IF;
 FOR row_value IN SELECT value FROM jsonb_array_elements(rows)LOOP IF(row_value->>'newBasicCents')::numeric<(row_value->'source'->>'basicCents')::numeric THEN flags:=flags||app.reward_calc_flag('block','SAL-01','Salary reductions are not allowed in the salary review.',row_value->'id');END IF;END LOOP;
 RETURN jsonb_build_object('rows',rows,'budgets',budgets,'flags',flags,'poolStatus',pool_status,'suggestedMultiplierBp',suggested_multiplier,'suggestion',suggestion,'suggestedLumpCents',suggested_lump,'lumpUnitCents',lump_unit,'lumpWorking',lump_working);
END $$;
REVOKE ALL ON FUNCTION app.reward_calc_bonus_base(jsonb,jsonb),app.reward_calc_annual(jsonb,jsonb,jsonb)FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Native governance receipts use JSON.stringify, not jsonb::text (different whitespace, object
-- enumeration and numeric exponent spelling). These private serializers preserve that existing
-- contract rather than invalidating every saved budget or accepting an unverified old digest.
CREATE FUNCTION app.reward_calc_json_number(p numeric)RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp SET extra_float_digits=3 AS $$
DECLARE value double precision;raw text;negative boolean;mantissa text;exponent integer:=0;decimal_position integer;digits text;leading_zero_count integer;dot integer;output text;
BEGIN
 BEGIN value:=p::double precision;EXCEPTION WHEN numeric_value_out_of_range THEN RETURN'null';END;
 IF value=0 THEN RETURN'0';END IF;
 raw:=value::text;IF raw IN('NaN','Infinity','-Infinity')THEN RETURN'null';END IF;
 negative:=left(raw,1)='-';IF negative THEN raw:=substr(raw,2);END IF;
 IF strpos(raw,'e')>0 THEN exponent:=split_part(raw,'e',2)::integer;mantissa:=split_part(raw,'e',1);ELSE mantissa:=raw;END IF;
 dot:=strpos(mantissa,'.');IF dot=0 THEN dot:=length(mantissa)+1;END IF;
 digits:=replace(mantissa,'.','');leading_zero_count:=length(digits)-length(regexp_replace(digits,'^0+',''));digits:=regexp_replace(digits,'^0+','');decimal_position:=dot-1+exponent-leading_zero_count;digits:=regexp_replace(digits,'0+$','');
 IF decimal_position-1>=21 OR decimal_position-1<=-7 THEN output:=left(digits,1)||CASE WHEN length(digits)>1 THEN'.'||substr(digits,2)ELSE''END||'e'||CASE WHEN decimal_position-1>=0 THEN'+'ELSE''END||(decimal_position-1)::text;
 ELSIF decimal_position<=0 THEN output:='0.'||repeat('0',-decimal_position)||digits;
 ELSIF decimal_position>=length(digits)THEN output:=digits||repeat('0',decimal_position-length(digits));
 ELSE output:=left(digits,decimal_position)||'.'||substr(digits,decimal_position+1);END IF;
 RETURN CASE WHEN negative THEN'-'ELSE''END||output;
END $$;
CREATE FUNCTION app.reward_calc_json_stringify(p jsonb)RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE part record;result text;separator text:='';index_key boolean;
BEGIN
 CASE jsonb_typeof(p)
 WHEN'object'THEN
  result:='{';FOR part IN SELECT key,value FROM jsonb_each(p)WITH ORDINALITY items(key,value,n)ORDER BY CASE WHEN key~'^(0|[1-9][0-9]*)$'AND length(key)<=10 THEN CASE WHEN key::numeric<=4294967294 THEN 0 ELSE 1 END ELSE 1 END,CASE WHEN key~'^(0|[1-9][0-9]*)$'AND length(key)<=10 THEN CASE WHEN key::numeric<=4294967294 THEN key::numeric ELSE NULL END ELSE NULL END,n LOOP
   result:=result||separator||to_jsonb(part.key)::text||':'||app.reward_calc_json_stringify(part.value);separator:=',';
  END LOOP;RETURN result||'}';
 WHEN'array'THEN
  result:='[';FOR part IN SELECT value FROM jsonb_array_elements(p)WITH ORDINALITY items(value,n)ORDER BY n LOOP result:=result||separator||app.reward_calc_json_stringify(part.value);separator:=',';END LOOP;RETURN result||']';
 WHEN'number'THEN RETURN app.reward_calc_json_number((p#>>'{}')::numeric);
 ELSE RETURN coalesce(p::text,'null');END CASE;
END $$;
CREATE FUNCTION app.reward_calc_senior_fingerprint(p_entry jsonb)RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE k text;result text:='{';separator text:='';
BEGIN
 FOREACH k IN ARRAY ARRAY['employmentId','compensationId','basicCents','gradeId','grade']LOOP
  IF p_entry->'source'?k THEN result:=result||separator||to_jsonb(k)::text||':'||app.reward_calc_json_stringify(p_entry->'source'->k);separator:=',';END IF;
 END LOOP;RETURN result||'}';
END $$;
CREATE FUNCTION app.reward_calc_governance_basis(p_policy jsonb,p_entries jsonb)RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE k text;body text:='{"group":{';separator text:='';entry jsonb;facts text;fact_separator text;
BEGIN
 FOREACH k IN ARRAY ARRAY['year','activeAsOf','minimumBonusRating','excludeNotice','excludeErCase','confirmedBy','blockedFrom','blockedTo','payWindowKeep','seniorMembershipMode','seniorGrades']LOOP
  IF p_policy?k THEN body:=body||separator||to_jsonb(k)::text||':'||app.reward_calc_json_stringify(p_policy->k);separator:=',';END IF;
 END LOOP;body:=body||'},"entries":[';separator:='';
 FOR entry IN SELECT value FROM jsonb_array_elements(p_entries)ORDER BY value->>'id'COLLATE "C" LOOP
  facts:='{';fact_separator:='';FOREACH k IN ARRAY ARRAY['performance','seniorPlan','erCase','confidentiality']LOOP
   IF entry->'facts'?k THEN facts:=facts||fact_separator||to_jsonb(k)::text||':'||app.reward_calc_json_stringify(entry->'facts'->k);fact_separator:=',';END IF;
  END LOOP;
  body:=body||separator||'{"id":'||app.reward_calc_json_stringify(entry->'id')||',"source":'||app.reward_calc_json_stringify(entry->'source')||',"facts":'||facts||'}}';separator:=',';
 END LOOP;
 RETURN encode(sha256(convert_to(body||']}','UTF8')),'hex');
END $$;
CREATE FUNCTION app.reward_calc_effective_policy(p_policy jsonb,p_state jsonb)RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE input jsonb:=p_state->'inputs';status text;actual numeric;target numeric;
BEGIN
 IF input IS NULL OR input='null'::jsonb THEN RETURN p_policy;END IF;
 target:=(input->>'targetCents')::numeric;
 status:=CASE WHEN target IS NULL OR target<=0 THEN'not-set'WHEN input->'actualCents'<>'null'::jsonb THEN CASE WHEN(input->>'actualCents')::numeric>0 THEN'final'ELSE'not-set'END WHEN coalesce((input->>'forecastCents')::numeric,0)>0 THEN'provisional'ELSE'not-set'END;
 RETURN p_policy||jsonb_build_object('patActual',CASE WHEN status='not-set'THEN 0 ELSE coalesce((input->>'actualCents')::numeric,(input->>'forecastCents')::numeric,0)END,'patTarget',CASE WHEN status='not-set'THEN 100 ELSE target END,'targetMonthsBp',input->'targetMonthsBp','multiplierBp',CASE WHEN p_policy->>'bonusStructure'='branch'THEN'10000'::jsonb ELSE input->'multiplierBp'END,'branchRatings',input->'branchRatings','exemptReason',CASE WHEN coalesce(p_state->'exemption'->>'confirmedBy','')<>''THEN p_state->'exemption'->>'reason'ELSE''END);
END $$;
REVOKE ALL ON FUNCTION app.reward_calc_json_number(numeric),app.reward_calc_json_stringify(jsonb),app.reward_calc_senior_fingerprint(jsonb),app.reward_calc_governance_basis(jsonb,jsonb),app.reward_calc_effective_policy(jsonb,jsonb)FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- The actual annual owner derives the caller's native governance course itself. GR can read
-- private inputs; other members consume the existing public pool projection, never private PAT.
CREATE FUNCTION app.reward_calc_annual_unit(p_unit uuid,p_revision integer)RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE unit public.reward_unit;roles text[];entries jsonb;state jsonb;public_state jsonb;effective jsonb;controls jsonb;awards jsonb:='{}';item record;calculation jsonb;
BEGIN
 IF NOT app.principal_snapshot_current()OR app.current_user_id()IS NULL THEN RAISE EXCEPTION 'Reward calculation unavailable' USING ERRCODE='42501';END IF;
 SELECT actual.* INTO unit FROM public.reward_unit actual WHERE actual.id=p_unit AND actual.tenant_id=app.current_tenant_id()AND actual.kind='annual'AND actual.deleted_at IS NULL;
 roles:=ARRAY(SELECT app.reward_roles(p_unit));
 IF unit.id IS NULL OR cardinality(roles)=0 THEN RAISE EXCEPTION 'Reward calculation unavailable' USING ERRCODE='42501';END IF;
 IF unit.revision IS DISTINCT FROM p_revision THEN RAISE EXCEPTION 'Reward calculation changed' USING ERRCODE='40001';END IF;
 IF NOT app.reward_calc_source_identity_current(unit.id,unit.tenant_id)THEN RAISE EXCEPTION 'Reward recipient source unavailable' USING ERRCODE='42501';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',e.id,'source',e.source,'facts',e.facts,'recommendation',e.recommendation)ORDER BY e.id),'[]'::jsonb)INTO entries FROM public.reward_entry e WHERE e.tenant_id=unit.tenant_id AND e.unit_id=unit.id;
 IF'gr'=ANY(roles)THEN SELECT g.state INTO state FROM public.reward_governance g WHERE g.tenant_id=unit.tenant_id AND g.unit_id=unit.id;END IF;
 SELECT g.snapshot INTO public_state FROM public.reward_governance_public g WHERE g.tenant_id=unit.tenant_id AND g.unit_id=unit.id;

 effective:=CASE WHEN state IS NOT NULL THEN app.reward_calc_effective_policy(unit.policy,state)WHEN public_state IS NOT NULL THEN unit.policy||jsonb_build_object('patActual',0,'patTarget',100,'targetMonthsBp',public_state->'targetMonthsBp','multiplierBp',public_state->'multiplierBp','branchRatings',public_state->'branchRatings','exemptReason','')ELSE unit.policy END;
 IF roles&&ARRAY['gr','ctro','ec']THEN
  FOR item IN SELECT a.award,e.id,e.source FROM public.reward_senior_award a JOIN public.reward_entry e ON e.id=a.entry_id AND e.unit_id=a.unit_id AND e.tenant_id=a.tenant_id WHERE a.tenant_id=unit.tenant_id AND a.unit_id=unit.id LOOP
   IF coalesce(item.award->>'confirmedBy','')<>''AND item.award->>'sourceFingerprint'=app.reward_calc_senior_fingerprint(jsonb_build_object('source',item.source))AND(item.award->>'newBasicCents')::numeric>=(item.source->>'basicCents')::numeric THEN awards:=awards||jsonb_build_object(item.id::text,jsonb_build_object('newBasicCents',item.award->'newBasicCents','bonusCents',item.award->'bonusCents'));END IF;
  END LOOP;
 END IF;
 controls:=jsonb_build_object('poolStatus',coalesce(public_state->>'status','legacy'),'seniorAwards',awards);
 IF public_state IS NOT NULL THEN controls:=controls||jsonb_build_object('bonusPools',public_state->'pools');END IF;
 calculation:=app.reward_calc_annual(entries,effective,controls);
 IF public_state IS NOT NULL AND public_state->>'basis'IS DISTINCT FROM app.reward_calc_governance_basis(unit.policy,entries)THEN calculation:=jsonb_set(calculation,'{flags}',(calculation->'flags')||app.reward_calc_flag('block','PAT-STALE','Eligibility or employee source facts changed. Group Rewards must review and refresh the unit budget inputs.'));END IF;
 RETURN calculation;
END $$;
REVOKE ALL ON FUNCTION app.reward_calc_annual_unit(uuid,integer)FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.reward_annual_calculation(p_unit uuid,p_revision integer)RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE unit public.reward_unit;actor public.app_user;roles text[];calculation jsonb;
BEGIN
 IF NOT app.principal_snapshot_current()OR app.current_user_id()IS NULL THEN RAISE EXCEPTION 'Reward calculation unavailable' USING ERRCODE='42501';END IF;
 SELECT actual.* INTO actor FROM public.app_user actual WHERE actual.id=app.current_user_id()AND actual.tenant_id=app.current_tenant_id()AND actual.archived_at IS NULL AND NOT app.login_blocked(actual.id);
 SELECT actual.* INTO unit FROM public.reward_unit actual WHERE actual.id=p_unit AND actual.tenant_id=app.current_tenant_id();roles:=ARRAY(SELECT app.reward_roles(p_unit));
 IF actor.id IS NULL OR unit.id IS NULL OR cardinality(roles)=0 THEN RAISE EXCEPTION 'Reward calculation unavailable' USING ERRCODE='42501';END IF;
 IF app.function_action_allowed('rewards.review','view',unit.company_id)IS NOT TRUE THEN RAISE EXCEPTION 'Reward review function unavailable' USING ERRCODE='42501';END IF;
 IF'bu'=ANY(roles)AND NOT('gr'=ANY(roles))AND EXISTS(SELECT 1 FROM public.reward_governance_public g WHERE g.unit_id=unit.id AND g.tenant_id=unit.tenant_id AND g.snapshot->'selectionConfirmed'='false'::jsonb)THEN RAISE EXCEPTION 'Senior plan membership awaits independent Group Rewards confirmation before the BU review can open.' USING ERRCODE='42501';END IF;
 calculation:=app.reward_calc_annual_unit(p_unit,p_revision);
 RETURN app.reward_calc_projection(calculation,unit.policy,roles,actor.person_id,'["bu","bg","gr","ctro","ec"]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION app.reward_annual_calculation(uuid,integer)FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_annual_calculation(uuid,integer)TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.reward_calc_decision_digest(p_policy jsonb,p_kind text,p_parent uuid,p_offcycle jsonb,p_entries jsonb)RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE body text;entry jsonb;separator text:='';
BEGIN
 body:='{"policy":'||app.reward_calc_json_stringify(p_policy)||',"kind":'||to_jsonb(p_kind)::text||',"parentUnitId":'||coalesce(to_jsonb(p_parent)::text,'null')||',"offcycle":'||app.reward_calc_json_stringify(p_offcycle)||',"entries":[';
 FOR entry IN SELECT value FROM jsonb_array_elements(p_entries)ORDER BY value->>'id'COLLATE "C" LOOP
  body:=body||separator||'{"id":'||app.reward_calc_json_stringify(entry->'id')||',"source":'||app.reward_calc_json_stringify(entry->'source')||',"facts":'||app.reward_calc_json_stringify(entry->'facts')||',"recommendation":'||app.reward_calc_json_stringify(entry->'recommendation')||'}';separator:=',';
 END LOOP;RETURN encode(sha256(convert_to(body||']}','UTF8')),'hex');
END $$;
CREATE FUNCTION app.reward_calc_transition(p_kind text,p_stage text,p_roles text[],p_action text,p_route jsonb DEFAULT NULL)RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE route text[];position_in_route integer;stages text[]:=ARRAY['draft','bg','gr','ctro','ec','approved','posted','rejected','withdrawn'];
BEGIN
 IF p_kind='annual'THEN
  IF p_action IN('reject','withdraw')THEN RAISE EXCEPTION 'Return an annual review to draft instead.' USING ERRCODE='42501';END IF;
  IF p_stage='draft'AND p_action='submit'AND'bu'=ANY(p_roles)THEN RETURN'bg';END IF;
  IF p_stage='approved'AND p_action='return'AND p_roles&&ARRAY['gr','ctro','ec']THEN RETURN'draft';END IF;
  IF p_stage IN('bg','gr','ctro','ec')AND p_stage=ANY(p_roles)THEN
   IF p_action='return'THEN RETURN'draft';ELSIF p_action='approve'THEN RETURN stages[array_position(stages,p_stage)+1];END IF;
  END IF;
 ELSIF p_kind IN('adhoc','midyear')THEN
  SELECT array_agg(value ORDER BY n)INTO route FROM jsonb_array_elements_text(p_route)WITH ORDINALITY items(value,n);
  IF p_stage='draft'AND p_action='withdraw'AND(route[1]=ANY(p_roles)OR'gr'=ANY(p_roles))THEN RETURN'withdrawn';END IF;
  IF p_stage='approved'AND p_action='return'AND p_roles&&ARRAY['gr','ctro','ec']THEN RETURN'draft';END IF;
  IF p_stage='draft'AND p_action='submit'AND route[1]=ANY(p_roles)THEN RETURN route[2];END IF;
  position_in_route:=array_position(route,p_stage);
  IF position_in_route>=2 AND p_stage=ANY(p_roles)THEN
   IF p_action='return'THEN RETURN'draft';ELSIF p_action='reject'THEN RETURN'rejected';ELSIF p_action='approve'THEN RETURN coalesce(route[position_in_route+1],'approved');END IF;
  END IF;
 END IF;
 RAISE EXCEPTION 'You cannot perform this action at the current approval stage.' USING ERRCODE='42501';
END $$;
REVOKE ALL ON FUNCTION app.reward_calc_decision_digest(jsonb,text,uuid,jsonb,jsonb),app.reward_calc_transition(text,text,text[],text,jsonb)FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.reward_calc_senior_grade(value text)RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE grade text:=app.reward_access_reason_trim(value);
BEGIN
 IF upper(left(grade,2)COLLATE "C")='JG'THEN grade:=app.reward_access_reason_trim(substr(grade,3));END IF;
 RETURN coalesce(grade IN('21','22','23'),false);
END $$;
-- Private actual-source admission, not a public preview or reusable grant. The future finite
-- mutation owner must invoke it inside its same locked transaction and bind the exact effects.
CREATE FUNCTION app.reward_decision_admission(p_unit uuid,p_revision integer,p_action text,p_reason text,p_acknowledged boolean DEFAULT false)RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE unit public.reward_unit;actor public.app_user;roles text[];entries jsonb;route jsonb;route_roles text[];governance jsonb;next_stage text;reason text;hash text;calculation jsonb;funding jsonb;missing text[];missing_labels text;prior_actor uuid;authority text;function_key text;function_operation text;
BEGIN
 IF nullif(current_setting('app.agent_principal_id',true),'')IS NOT NULL THEN RAISE EXCEPTION 'A current human Rewards principal is required' USING ERRCODE='42501';END IF;
 IF app.current_agent_principal()IS NOT NULL THEN RAISE EXCEPTION 'A current human Rewards principal is required' USING ERRCODE='42501';END IF;
 PERFORM app.audit_access_order_lock();PERFORM app.access_workforce_write_lock();
 PERFORM pg_advisory_xact_lock(hashtext('audit-chain:'||app.current_tenant_id()::text));
 IF NOT app.principal_snapshot_current()OR app.current_user_id()IS NULL OR p_action IS NULL OR p_action NOT IN('submit','approve','return','reject','withdraw')OR p_acknowledged IS NULL THEN RAISE EXCEPTION 'Reward decision unavailable' USING ERRCODE='42501';END IF;
 reason:=app.reward_calc_text(to_jsonb(p_reason),4000);funding:=app.reward_funding(p_unit,true);
 SELECT actual.* INTO unit FROM public.reward_unit actual WHERE actual.id=p_unit AND actual.tenant_id=app.current_tenant_id()AND actual.deleted_at IS NULL FOR UPDATE;
 SELECT actual.* INTO actor FROM public.app_user actual WHERE actual.id=app.current_user_id()AND actual.tenant_id=app.current_tenant_id()AND actual.archived_at IS NULL AND NOT app.login_blocked(actual.id);
 roles:=ARRAY(SELECT app.reward_roles(p_unit));
 IF unit.id IS NULL OR actor.id IS NULL OR cardinality(roles)=0 THEN RAISE EXCEPTION 'Reward decision unavailable' USING ERRCODE='42501';END IF;
 IF unit.revision IS DISTINCT FROM p_revision THEN RAISE EXCEPTION 'This review changed in another session. Reload before saving.' USING ERRCODE='40001';END IF;
 function_key:='rewards.decisions.'||p_action;function_operation:=CASE WHEN p_action='approve'THEN'approve'ELSE'execute'END;
 IF app.function_action_allowed(function_key,function_operation,unit.company_id)IS NOT TRUE THEN RAISE EXCEPTION 'Reward decision function unavailable' USING ERRCODE='42501';END IF;
 IF NOT app.reward_calc_source_identity_current(unit.id,unit.tenant_id)THEN RAISE EXCEPTION 'Reward recipient source unavailable' USING ERRCODE='42501';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',e.id,'source',e.source,'facts',e.facts,'recommendation',e.recommendation)ORDER BY e.id),'[]'::jsonb)INTO entries FROM public.reward_entry e WHERE e.tenant_id=unit.tenant_id AND e.unit_id=unit.id;
 route:=CASE WHEN unit.kind='annual'THEN'["bu","bg","gr","ctro","ec"]'::jsonb ELSE app.reward_calc_offcycle_route(unit.kind,unit.offcycle,entries)END;
 IF unit.kind='annual'THEN SELECT g.snapshot INTO governance FROM public.reward_governance_public g WHERE g.unit_id=unit.id AND g.tenant_id=unit.tenant_id;END IF;
 next_stage:=app.reward_calc_transition(unit.kind,unit.status,roles,p_action,route);
 IF unit.kind<>'annual'AND p_action='approve'AND NOT p_acknowledged AND EXISTS(SELECT 1 FROM jsonb_array_elements(entries)e WHERE app.reward_calc_entry_visible(e,roles,actor.person_id)AND coalesce(e->'recommendation'->>'promotionGrade','')<>'')THEN RAISE EXCEPTION 'Acknowledge that you reviewed the current and proposed role summaries.' USING ERRCODE='42501';END IF;
 IF p_action IN('return','reject','withdraw')AND app.reward_calc_units(reason)<10 THEN RAISE EXCEPTION 'Explain why the unit is being returned (at least 10 characters).' USING ERRCODE='42501';END IF;
 hash:=app.reward_calc_decision_digest(unit.policy,unit.kind,unit.parent_unit_id,unit.offcycle,entries);
 IF unit.kind='annual'THEN calculation:=app.reward_calc_annual_unit(unit.id,unit.revision);ELSE
  calculation:=app.reward_calc_offcycle(entries,unit.kind,unit.offcycle,funding);
  IF(funding->>'duplicate')::boolean THEN calculation:=jsonb_set(calculation,'{flags}',(calculation->'flags')||app.reward_calc_flag('block','OC-12','An employee already has an open off-cycle request against this annual review.'));END IF;
 END IF;
 IF p_action IN('submit','approve')THEN
  IF jsonb_array_length(entries)=0 THEN RAISE EXCEPTION 'A review needs at least one employee.' USING ERRCODE='42501';END IF;
  IF governance IS NOT NULL THEN
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(entries)e WHERE app.reward_calc_senior(unit.policy,e)AND NOT app.reward_calc_senior_grade(e->'source'->>'grade'))THEN RAISE EXCEPTION 'Senior plan membership is limited to JG 21–23. Correct selection before submission.' USING ERRCODE='42501';END IF;
   IF coalesce((governance->>'selectionConfirmed')::boolean,false)IS NOT TRUE THEN RAISE EXCEPTION 'A different Group Rewards user must confirm and lock Senior membership before the BU review opens.' USING ERRCODE='42501';END IF;
   IF next_stage IN('ctro','ec','approved')AND governance->>'status'IS DISTINCT FROM'final'THEN RAISE EXCEPTION 'The unit bonus pool must be Final (Actual) before CTRO or EC approval.' USING ERRCODE='42501';END IF;
   IF unit.policy->>'bonusStructure'='branch'AND EXISTS(SELECT 1 FROM jsonb_array_elements(entries)e WHERE coalesce(e->'facts'->>'branch','')<>''AND coalesce(governance->'branchRatings'->>(e->'facts'->>'branch'),'')='')THEN RAISE EXCEPTION 'Every PPCH branch needs a rating before submission.' USING ERRCODE='42501';END IF;
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(calculation->'flags')f WHERE f->>'severity'='block')THEN RAISE EXCEPTION 'Resolve all blocking checks, including restricted records, before proceeding.' USING ERRCODE='42501';END IF;
  IF app.reward_calc_units(reason)<10 AND EXISTS(SELECT 1 FROM jsonb_array_elements(calculation->'flags')f WHERE f->>'severity'IN('exception','warning'))THEN RAISE EXCEPTION 'Record why the exceptions and warnings are acceptable.' USING ERRCODE='42501';END IF;
  SELECT array_agg(value ORDER BY n)INTO route_roles FROM jsonb_array_elements_text(route||'["payroll"]'::jsonb)WITH ORDINALITY stages(value,n);
  SELECT array_agg(role ORDER BY n)INTO missing FROM unnest(route_roles)WITH ORDINALITY required(role,n)WHERE NOT EXISTS(SELECT 1 FROM public.reward_member m JOIN public.app_user u ON u.id=m.user_id AND u.tenant_id=m.tenant_id WHERE m.unit_id=unit.id AND m.tenant_id=unit.tenant_id AND m.role=required.role AND app.reward_member_eligible_internal(m.id));
  IF cardinality(missing)>0 THEN
   SELECT string_agg(CASE role WHEN'bu'THEN'BU CEO'WHEN'bg'THEN'BG CEO / authorised proxy'WHEN'gr'THEN'Group Rewards'WHEN'ctro'THEN'CTRO'WHEN'ec'THEN'Executive Chairman'WHEN'payroll'THEN'Payroll handoff'ELSE'PBP'END,', 'ORDER BY n)INTO missing_labels FROM unnest(missing)WITH ORDINALITY required(role,n);
   RAISE EXCEPTION 'Assign every approval role and the payroll handoff before submitting. Missing: %.',missing_labels USING ERRCODE='42501';
  END IF;
  IF unit.status<>'draft'AND unit.approved_digest IS DISTINCT FROM hash THEN RAISE EXCEPTION 'The inputs changed after submission. Return this review to draft.' USING ERRCODE='42501';END IF;
  SELECT d.actor_id INTO prior_actor FROM public.reward_decision d WHERE d.unit_id=unit.id AND d.tenant_id=unit.tenant_id AND d.revision=p_revision ORDER BY d.created_at DESC,d.id DESC LIMIT 1;
  IF prior_actor=actor.id AND p_action='approve'THEN RAISE EXCEPTION 'A different reviewer must sign the next approval stage.' USING ERRCODE='42501';END IF;
 END IF;
 authority:=app.access_function_authority_stamp();IF authority IS NULL THEN RAISE EXCEPTION 'Reward authority changed' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('tenantId',unit.tenant_id,'actorId',actor.id,'unitId',unit.id,'companyId',unit.company_id,'revision',unit.revision,'kind',unit.kind,'fromStage',unit.status,'toStage',next_stage,'action',p_action,'reason',reason,'decisionDigest',hash,'authorityStamp',authority,'functionKey',function_key,'functionOperation',function_operation,'positiveAdmission',true,'route',route,'unitBeforeHash',app.reward_decision_row_hash(to_jsonb(unit),'reward_unit'),'reservedCents',CASE WHEN unit.kind='annual'THEN unit.reserved_cents ELSE jsonb_build_object('standard',calculation->'budgets'->'standard'->'used'->0,'h',calculation->'budgets'->'h'->'used'->0)END);
END $$;
REVOKE ALL ON FUNCTION app.reward_calc_senior_grade(text),app.reward_decision_admission(uuid,integer,text,text,boolean)FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Private, exact physical effects of one hardcoded native decision. Completed records remain
-- through the root transaction: SET CONSTRAINTS cannot retire later authority revalidation.
-- Normalize only timestamp representation, preserving every value and exact instant. This
-- avoids changing current_date/login eligibility merely to hash timestamptz in a fixed timezone.
CREATE FUNCTION app.reward_decision_row_hash(p_row jsonb,p_table text)RETURNS text
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE value jsonb:=p_row;fields text[];field text;
BEGIN
 fields:=CASE p_table WHEN'reward_unit'THEN ARRAY['created_at','updated_at','posted_at','deleted_at']WHEN'reward_decision'THEN ARRAY['created_at']WHEN'domain_event'THEN ARRAY['occurred_at']ELSE NULL END;
 IF fields IS NULL THEN RAISE EXCEPTION 'Unknown native Rewards receipt relation' USING ERRCODE='42501';END IF;
 FOREACH field IN ARRAY fields LOOP IF value?field AND value->field<>'null'::jsonb THEN value:=jsonb_set(value,ARRAY[field],to_jsonb(extract(epoch FROM(value->>field)::timestamptz)));END IF;END LOOP;
 RETURN encode(sha256(convert_to(value::text,'UTF8')),'hex');
END $$;
REVOKE ALL ON FUNCTION app.reward_decision_row_hash(jsonb,text)FROM PUBLIC,ai_hr_app;
CREATE TABLE app.reward_decision_native_effect(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),xact_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,unit_id uuid NOT NULL,
 admission jsonb NOT NULL,decision_id uuid NOT NULL,event_id uuid NOT NULL,unit_after_hash text,event_after_hash text,
 active boolean NOT NULL DEFAULT true,completed boolean NOT NULL DEFAULT false,recheck bigint NOT NULL DEFAULT 0
);
CREATE TABLE app.reward_decision_native_receipt(
 effect_id uuid NOT NULL REFERENCES app.reward_decision_native_effect(id)ON DELETE CASCADE,
 table_name text NOT NULL,row_id uuid NOT NULL,before_hash text NOT NULL,after_hash text NOT NULL,
 PRIMARY KEY(effect_id,table_name,row_id,before_hash,after_hash)
);
CREATE INDEX reward_decision_native_effect_transaction ON app.reward_decision_native_effect(xact_id,tenant_id,user_id,unit_id);
ALTER TABLE app.reward_decision_native_effect ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.reward_decision_native_receipt ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.reward_decision_native_effect,app.reward_decision_native_receipt FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.reward_decision_native_capture()RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE previous jsonb:=CASE WHEN TG_OP='INSERT'THEN'{}'::jsonb ELSE to_jsonb(OLD)END;following jsonb:=to_jsonb(NEW);effect uuid;target uuid;
BEGIN
 target:=CASE WHEN TG_TABLE_NAME='reward_unit'THEN NEW.id ELSE(following->>'unit_id')::uuid END;
 SELECT e.id INTO effect FROM app.reward_decision_native_effect e WHERE e.xact_id=pg_current_xact_id()AND e.tenant_id=NEW.tenant_id AND e.tenant_id=app.current_tenant_id()AND e.user_id=app.current_user_id()AND e.unit_id=target AND e.active;
 IF effect IS NOT NULL THEN INSERT INTO app.reward_decision_native_receipt VALUES(effect,TG_TABLE_NAME,NEW.id,app.reward_decision_row_hash(previous,TG_TABLE_NAME),app.reward_decision_row_hash(following,TG_TABLE_NAME))ON CONFLICT DO NOTHING;END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.reward_decision_native_capture()FROM PUBLIC,ai_hr_app;
CREATE TRIGGER rewards_decision_native_capture AFTER UPDATE ON public.reward_unit FOR EACH ROW EXECUTE FUNCTION app.reward_decision_native_capture();
CREATE TRIGGER rewards_decision_native_capture AFTER INSERT ON public.reward_decision FOR EACH ROW EXECUTE FUNCTION app.reward_decision_native_capture();
CREATE FUNCTION app.reward_decision_native_validate()RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE effect app.reward_decision_native_effect;admission jsonb;unit public.reward_unit;next_stage text;
BEGIN
 SELECT actual.* INTO effect FROM app.reward_decision_native_effect actual WHERE actual.id=NEW.id;
 IF NOT FOUND THEN RETURN NULL;END IF;admission:=effect.admission;
 IF nullif(current_setting('app.agent_principal_id',true),'')IS NOT NULL THEN RAISE EXCEPTION 'A current human Rewards principal is required' USING ERRCODE='42501';END IF;
 IF app.current_agent_principal()IS NOT NULL OR NOT app.principal_snapshot_current()OR effect.xact_id<>pg_current_xact_id()OR effect.tenant_id IS DISTINCT FROM app.current_tenant_id()OR effect.user_id IS DISTINCT FROM app.current_user_id()OR effect.active OR NOT effect.completed
  OR admission->>'tenantId'IS DISTINCT FROM effect.tenant_id::text OR admission->>'actorId'IS DISTINCT FROM effect.user_id::text OR admission->>'unitId'IS DISTINCT FROM effect.unit_id::text OR coalesce(admission->>'authorityStamp','')!~'^[a-f0-9]{64}$'
  OR admission->>'authorityStamp'IS DISTINCT FROM app.access_function_authority_stamp()OR NOT EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=effect.user_id AND u.tenant_id=effect.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id))THEN RAISE EXCEPTION 'Native Rewards decision authority changed' USING ERRCODE='42501';END IF;
 SELECT actual.* INTO unit FROM public.reward_unit actual WHERE actual.id=effect.unit_id AND actual.tenant_id=effect.tenant_id AND actual.company_id::text=admission->>'companyId'AND actual.kind=admission->>'kind'AND actual.deleted_at IS NULL;
 IF unit.id IS NULL THEN RAISE EXCEPTION 'Native Rewards decision source changed' USING ERRCODE='42501';END IF;
 IF admission->'positiveAdmission'IS DISTINCT FROM'true'::jsonb OR admission->>'functionKey'IS DISTINCT FROM('rewards.decisions.'||(admission->>'action'))OR admission->>'functionOperation'IS DISTINCT FROM(CASE WHEN admission->>'action'='approve'THEN'approve'ELSE'execute'END)OR app.function_action_denial_clear(admission->>'functionKey',admission->>'functionOperation',unit.company_id)IS NOT TRUE THEN RAISE EXCEPTION 'Native Rewards decision authority changed' USING ERRCODE='42501';END IF;
 -- Repeat current native role/availability against the actually admitted course, never the
 -- post-command pending state. A later legitimate business outcome does not revoke that course.
 next_stage:=app.reward_calc_transition(unit.kind,admission->>'fromStage',ARRAY(SELECT app.reward_roles(unit.id)),admission->>'action',admission->'route');
 IF next_stage IS DISTINCT FROM admission->>'toStage'OR NOT EXISTS(SELECT 1 FROM app.reward_decision_native_receipt r WHERE r.effect_id=effect.id AND r.table_name='reward_unit'AND r.row_id=unit.id AND r.before_hash=admission->>'unitBeforeHash'AND r.after_hash=effect.unit_after_hash)
  OR NOT EXISTS(SELECT 1 FROM public.reward_decision d JOIN app.reward_decision_native_receipt r ON r.effect_id=effect.id AND r.table_name='reward_decision'AND r.row_id=d.id AND r.before_hash=encode(sha256(convert_to('{}','UTF8')),'hex')AND r.after_hash=app.reward_decision_row_hash(to_jsonb(d),'reward_decision')WHERE d.id=effect.decision_id AND d.tenant_id=effect.tenant_id AND d.unit_id=unit.id AND d.actor_id=effect.user_id AND d.revision=(admission->>'revision')::integer AND d.action=admission->>'action'AND d.from_stage=admission->>'fromStage'AND d.to_stage=admission->>'toStage'AND encode(sha256(convert_to(d.reason,'UTF8')),'hex')=admission->>'reasonHash'AND d.digest=admission->>'decisionDigest')
  OR NOT EXISTS(SELECT 1 FROM public.domain_event event WHERE event.id=effect.event_id AND event.tenant_id=effect.tenant_id AND event.aggregate_type='reward-unit'AND event.aggregate_id=unit.id AND event.event_type=CASE WHEN admission->>'toStage'='approved'THEN'reward-unit.approved'ELSE'reward-unit.routed'END AND event.actor_type='user'AND event.actor_id=effect.user_id AND event.subject_employment_id IS NULL AND event.payload=jsonb_build_object('from',admission->'fromStage','to',admission->'toStage','revision',admission->'revision')AND effect.event_after_hash=app.reward_decision_row_hash(to_jsonb(event),'domain_event')AND EXISTS(SELECT 1 FROM app.lifecycle_row_transaction_receipt birth WHERE birth.xact_id=effect.xact_id AND birth.tenant_id=effect.tenant_id AND birth.user_id=effect.user_id AND birth.table_name='domain_event'AND birth.row_id=event.id))
 THEN RAISE EXCEPTION 'Native Rewards decision effect incomplete' USING ERRCODE='42501';END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.reward_decision_native_validate()FROM PUBLIC,ai_hr_app;
CREATE CONSTRAINT TRIGGER rewards_decision_native_effect AFTER UPDATE ON app.reward_decision_native_effect DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.completed AND NOT NEW.active)EXECUTE FUNCTION app.reward_decision_native_validate();
CREATE FUNCTION app.reward_decision_authority_changed()RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 -- Rows owned by another transaction are never touched. This only requeues the same root
 -- transaction's completed exact decisions after a real authority epoch mutation.
 UPDATE app.reward_decision_native_effect e SET recheck=e.recheck+1 WHERE e.xact_id=pg_current_xact_id()AND e.tenant_id=NEW.tenant_id AND e.completed AND NOT e.active;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.reward_decision_authority_changed()FROM PUBLIC,ai_hr_app;
CREATE TRIGGER rewards_decision_authority_recheck AFTER UPDATE ON app.access_control_epoch FOR EACH ROW EXECUTE FUNCTION app.reward_decision_authority_changed();
--> statement-breakpoint
-- Kept PRIVATE pending hosted qualification and exact function publication review. No caller
-- actor/event/namespace/row delta is accepted. Existing Assistant sealed-write guards remain live.
CREATE FUNCTION app.reward_decision_native(p_unit uuid,p_revision integer,p_command text,p_reason text,p_acknowledged boolean DEFAULT false)RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE admission jsonb;effect uuid;decision uuid:=gen_random_uuid();event uuid:=gen_random_uuid();after_unit jsonb;after_event jsonb;affected integer;
BEGIN
 IF nullif(current_setting('app.agent_principal_id',true),'')IS NOT NULL THEN RAISE EXCEPTION 'A current human Rewards principal is required' USING ERRCODE='42501';END IF;
 IF app.current_agent_principal()IS NOT NULL OR app.current_user_id()IS NULL OR NOT app.principal_snapshot_current()THEN RAISE EXCEPTION 'A current human Rewards principal is required' USING ERRCODE='42501';END IF;
 admission:=app.reward_decision_admission(p_unit,p_revision,p_command,p_reason,p_acknowledged);
 DELETE FROM app.reward_decision_native_effect WHERE tenant_id=app.current_tenant_id()AND xact_id<pg_snapshot_xmin(pg_current_snapshot());
 IF EXISTS(SELECT 1 FROM app.reward_decision_native_effect e WHERE e.xact_id=pg_current_xact_id()AND e.tenant_id=app.current_tenant_id()AND e.active)THEN RAISE EXCEPTION 'A native Rewards decision is already active' USING ERRCODE='42501';END IF;
 INSERT INTO app.reward_decision_native_effect(xact_id,tenant_id,user_id,unit_id,admission,decision_id,event_id)VALUES(pg_current_xact_id(),app.current_tenant_id(),app.current_user_id(),p_unit,(admission-'reason')||jsonb_build_object('reasonHash',encode(sha256(convert_to(admission->>'reason','UTF8')),'hex')),decision,event)RETURNING id INTO effect;
 INSERT INTO public.reward_decision(id,tenant_id,unit_id,actor_id,revision,action,from_stage,to_stage,reason,digest)VALUES(decision,app.current_tenant_id(),p_unit,app.current_user_id(),p_revision,p_command,admission->>'fromStage',admission->>'toStage',admission->>'reason',admission->>'decisionDigest');
 UPDATE public.reward_unit actual SET status=admission->>'toStage',approved_digest=CASE WHEN p_command IN('return','reject','withdraw')THEN NULL ELSE admission->>'decisionDigest'END,revision=CASE WHEN p_command='return'THEN p_revision+1 ELSE p_revision END,reserved_cents=CASE WHEN actual.kind='annual'THEN actual.reserved_cents ELSE admission->'reservedCents'END,updated_at=clock_timestamp()WHERE actual.id=p_unit AND actual.tenant_id=app.current_tenant_id()AND actual.revision=p_revision AND actual.status=admission->>'fromStage'RETURNING to_jsonb(actual)INTO after_unit;
 GET DIAGNOSTICS affected=ROW_COUNT;IF affected<>1 THEN RAISE EXCEPTION 'Native Rewards decision source changed' USING ERRCODE='40001';END IF;
 INSERT INTO public.domain_event(id,tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)VALUES(event,app.current_tenant_id(),'reward-unit',p_unit,CASE WHEN admission->>'toStage'='approved'THEN'reward-unit.approved'ELSE'reward-unit.routed'END,'user',app.current_user_id(),jsonb_build_object('from',admission->'fromStage','to',admission->'toStage','revision',admission->'revision'));
 SELECT to_jsonb(actual)INTO after_event FROM public.domain_event actual WHERE actual.id=event AND actual.tenant_id=app.current_tenant_id();
 UPDATE app.reward_decision_native_effect e SET active=false,completed=true,unit_after_hash=app.reward_decision_row_hash(after_unit,'reward_unit'),event_after_hash=app.reward_decision_row_hash(after_event,'domain_event')WHERE e.id=effect;
 RETURN admission->>'toStage';
END $$;
REVOKE ALL ON FUNCTION app.reward_decision_native(uuid,integer,text,text,boolean)FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
-- Private preparation only: payroll's native confirmed-award course differs from the review
-- screen course. Budgets and flags are already calculated before the final Senior override;
-- never feed a redacted review projection back into payroll, and never recompute those pools.
CREATE FUNCTION app.reward_calc_post_senior(p_calculation jsonb,p_policy jsonb,p_awards jsonb)RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE rows jsonb:=p_calculation->'rows';item jsonb;award jsonb;basic numeric;new_basic numeric;bonus numeric;n integer;
BEGIN
 FOR n IN 0..jsonb_array_length(rows)-1 LOOP
  item:=rows->n;IF NOT app.reward_calc_senior(p_policy,item)THEN CONTINUE;END IF;
  award:=p_awards->(item->>'id');
  IF coalesce(award->>'confirmedBy','')=''OR award->>'sourceFingerprint'IS DISTINCT FROM app.reward_calc_senior_fingerprint(item)THEN
   RAISE EXCEPTION 'Every Senior plan member needs an independently confirmed offline decision before payroll transfer.' USING ERRCODE='42501';
  END IF;
  basic:=(item->'source'->>'basicCents')::numeric;new_basic:=basic;bonus:=0;
  -- Same confirmedSeniorAwards filter as the native engine. An old lower proposal is not
  -- enacted, while the actual confirmation/fingerprint requirement still applies to leavers.
  IF(item->>'activeInReview')::boolean AND(award->>'newBasicCents')::numeric>=basic THEN
   new_basic:=app.reward_calc_integer((award->>'newBasicCents')::numeric);bonus:=app.reward_calc_integer((award->>'bonusCents')::numeric);
  END IF;
  rows:=jsonb_set(rows,ARRAY[n::text],item||jsonb_build_object('meritBp',0,'promotionBp',0,'specialBp',0,'meritCents',0,'promotionCents',0,'specialCents',0,'standardBonusCents',0,'lumpCents',0,'newBasicCents',new_basic,'bonusCents',bonus));
 END LOOP;
 RETURN jsonb_set(p_calculation,'{rows}',rows);
END $$;
REVOKE ALL ON FUNCTION app.reward_calc_post_senior(jsonb,jsonb,jsonb)FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
-- Ordinary native posting preparation. This private owner does not enact salary, grade,
-- payroll, funding or audit effects. Reviewed Assistant preparation retains its separate
-- NOWAIT/full nominated-source contract; no caller flag can weaken that contract here.
-- Repeat the original unit RLS visibility before a definer distinguishes missing authority
-- from a missing unit. A native creator/admin/seat is not an employee-row read grant.
CREATE FUNCTION app.reward_unit_native_readable(p_unit uuid)RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current()AND app.current_user_id()IS NOT NULL AND EXISTS(SELECT 1 FROM public.reward_unit u WHERE u.id=p_unit AND u.tenant_id=app.current_tenant_id()AND(u.created_by=app.current_user_id()OR app.reward_access(u.id)));
$$;
REVOKE ALL ON FUNCTION app.reward_unit_native_readable(uuid)FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.reward_post_admission(p_unit uuid,p_revision integer,p_batch uuid DEFAULT NULL)RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE unit public.reward_unit;actor public.app_user;batch public.payroll_batch;roles text[];entries jsonb;funding jsonb;calculation jsonb;awards jsonb;hash text;has_bonus boolean;authority text;
BEGIN
 IF nullif(current_setting('app.agent_principal_id',true),'')IS NOT NULL THEN RAISE EXCEPTION 'A current human Rewards principal is required' USING ERRCODE='42501';END IF;
 IF app.current_agent_principal()IS NOT NULL OR NOT app.principal_snapshot_current()OR app.current_user_id()IS NULL THEN RAISE EXCEPTION 'A current human Rewards principal is required' USING ERRCODE='42501';END IF;
 PERFORM app.audit_access_order_lock();PERFORM app.access_workforce_write_lock();
 IF current_setting('transaction_isolation')<>'read committed'OR current_setting('transaction_read_only')<>'off'OR NOT pg_try_advisory_xact_lock(hashtextextended('leave-dependency-configuration:'||app.current_tenant_id()::text,0))THEN RAISE EXCEPTION 'Leave source is unavailable; review it again.' USING ERRCODE='55P03';END IF;
 funding:=app.reward_funding(p_unit,true);
 SELECT actual.* INTO unit FROM public.reward_unit actual WHERE actual.id=p_unit AND actual.tenant_id=app.current_tenant_id()AND actual.deleted_at IS NULL AND app.reward_unit_native_readable(actual.id)FOR UPDATE;
 SELECT actual.* INTO actor FROM public.app_user actual WHERE actual.id=app.current_user_id()AND actual.tenant_id=app.current_tenant_id()AND actual.archived_at IS NULL AND NOT app.login_blocked(actual.id);
 roles:=ARRAY(SELECT app.reward_roles(p_unit));
 IF unit.id IS NULL OR actor.id IS NULL THEN RAISE EXCEPTION 'Reward posting unavailable' USING ERRCODE='42501';END IF;
 IF unit.revision IS DISTINCT FROM p_revision THEN RAISE EXCEPTION 'This review changed in another session. Reload before saving.' USING ERRCODE='40001';END IF;
 IF NOT('payroll'=ANY(roles))THEN RAISE EXCEPTION 'The assigned payroll role is required.' USING ERRCODE='42501';END IF;
 IF NOT app.reward_admin(unit.company_id)THEN RAISE EXCEPTION 'Company administrator access is required.' USING ERRCODE='42501';END IF;
 IF app.function_action_allowed('rewards.posting','execute',unit.company_id)IS NOT TRUE THEN RAISE EXCEPTION 'Reward posting function unavailable' USING ERRCODE='42501';END IF;
 -- Native idempotence precedes fresh source, calculation and batch checks, but never authority.
 IF unit.status='posted'THEN RETURN jsonb_build_object('alreadyPosted',true,'unitId',unit.id,'revision',unit.revision);END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',e.id,'source',e.source,'facts',e.facts,'recommendation',e.recommendation)ORDER BY e.id),'[]'::jsonb)INTO entries FROM public.reward_entry e WHERE e.tenant_id=unit.tenant_id AND e.unit_id=unit.id;
 hash:=app.reward_calc_decision_digest(unit.policy,unit.kind,unit.parent_unit_id,unit.offcycle,entries);
 IF unit.status<>'approved'OR unit.approved_digest IS DISTINCT FROM hash THEN RAISE EXCEPTION 'Only the unchanged, fully approved review can be posted.' USING ERRCODE='42501';END IF;
 IF NOT app.reward_calc_source_identity_current(unit.id,unit.tenant_id)THEN RAISE EXCEPTION 'Reward recipient source unavailable' USING ERRCODE='42501';END IF;
 -- Canonical post-purpose reader derives actual approved/payroll/admin authority itself.
 -- It never supplies approval evidence/reference/reason/date or a generic raw-pay grant.
 awards:=app.reward_senior_awards_for_post(unit.id);
 IF unit.kind='annual'THEN calculation:=app.reward_calc_post_senior(app.reward_calc_annual_unit(unit.id,unit.revision),unit.policy,awards);ELSE
  calculation:=app.reward_calc_offcycle(entries,unit.kind,unit.offcycle,funding);
  IF(funding->>'duplicate')::boolean THEN calculation:=jsonb_set(calculation,'{flags}',(calculation->'flags')||app.reward_calc_flag('block','OC-12','An employee already has an open off-cycle request against this annual review.'));END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(calculation->'flags')f WHERE f->>'severity'='block')THEN RAISE EXCEPTION 'The approved review no longer passes validation.' USING ERRCODE='42501';END IF;
 SELECT EXISTS(SELECT 1 FROM jsonb_array_elements(calculation->'rows')e WHERE(e->>'bonusCents')::numeric+(e->>'lumpCents')::numeric>0 OR app.reward_calc_senior(unit.policy,e))INTO has_bonus;
 IF has_bonus AND p_batch IS NULL THEN RAISE EXCEPTION 'Select a draft payroll batch for the bonus and lump-sum awards.' USING ERRCODE='42501';END IF;
 IF p_batch IS NOT NULL THEN
  SELECT actual.* INTO batch FROM public.payroll_batch actual WHERE actual.id=p_batch AND actual.tenant_id=unit.tenant_id FOR UPDATE;
  IF batch.id IS NULL OR batch.company_id<>unit.company_id OR batch.status<>'draft'THEN RAISE EXCEPTION 'The payroll batch must be a draft in this company.' USING ERRCODE='42501';END IF;
 END IF;
 authority:=app.access_function_authority_stamp();IF authority IS NULL THEN RAISE EXCEPTION 'Reward posting authority unavailable' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('alreadyPosted',false,'tenantId',unit.tenant_id,'userId',actor.id,'unitId',unit.id,'revision',unit.revision,'batchId',p_batch,'authorityStamp',authority,'functionKey','rewards.posting','functionOperation','execute','positiveAdmission',true,'decisionDigest',hash,'unitBeforeHash',app.reward_decision_row_hash(to_jsonb(unit),'reward_unit'),'calculation',calculation,'postingAwards',awards,'hasBonus',has_bonus);
END $$;
REVOKE ALL ON FUNCTION app.reward_post_admission(uuid,integer,uuid)FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
-- Exact ordinary posting source plan, still private and effect-free. The eventual mutation
-- owner must consume this within this transaction, retain exact physical receipts, and recheck
-- authority after effects; this result alone is never a reusable write or disclosure proof.
CREATE FUNCTION app.reward_post_sources(p_unit uuid,p_revision integer,p_batch uuid DEFAULT NULL)RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE admission jsonb;unit public.reward_unit;item jsonb;emp public.employment;salary public.compensation;grade public.job_grade;target_grade public.job_grade;pay_input public.payroll_input;award jsonb;provenance jsonb;effects jsonb:='[]';current_grade text;whitespace text:=chr(9)||chr(10)||chr(11)||chr(12)||chr(13)||chr(32)||chr(160)||chr(5760)||chr(8192)||chr(8193)||chr(8194)||chr(8195)||chr(8196)||chr(8197)||chr(8198)||chr(8199)||chr(8200)||chr(8201)||chr(8202)||chr(8232)||chr(8233)||chr(8239)||chr(8287)||chr(12288)||chr(65279);is_senior boolean;amount numeric;
BEGIN
 admission:=app.reward_post_admission(p_unit,p_revision,p_batch);
 IF(admission->>'alreadyPosted')::boolean THEN RETURN admission;END IF;
 SELECT actual.* INTO unit FROM public.reward_unit actual WHERE actual.id=p_unit AND actual.tenant_id=app.current_tenant_id();
 FOR item IN SELECT value FROM jsonb_array_elements(admission->'calculation'->'rows')ORDER BY value->'source'->>'employmentId'COLLATE "C" LOOP
  SELECT actual.* INTO emp FROM public.employment actual WHERE actual.id=(item->'source'->>'employmentId')::uuid AND actual.tenant_id=unit.tenant_id FOR UPDATE;
  IF emp.id IS NULL OR emp.company_id<>unit.company_id OR emp.terminated_on IS NOT NULL OR emp.grade_id IS DISTINCT FROM(item->'source'->>'gradeId')::uuid THEN RAISE EXCEPTION 'An employee changed company, grade or employment status. Return and refresh the review.' USING ERRCODE='42501';END IF;
  is_senior:=app.reward_calc_senior(unit.policy,item);
  grade:=NULL;target_grade:=NULL;pay_input:=NULL;provenance:=NULL;
  IF is_senior THEN
   SELECT actual.* INTO grade FROM public.job_grade actual WHERE actual.id=emp.grade_id AND actual.tenant_id=unit.tenant_id FOR SHARE;
   current_grade:=app.reward_access_reason_trim(regexp_replace(coalesce(grade.code,''),'^[jJ][gG]['||whitespace||']*',''));
   IF current_grade IS DISTINCT FROM item->'source'->>'grade'OR NOT app.reward_calc_senior_grade(current_grade)THEN RAISE EXCEPTION 'The Senior employee grade changed after the snapshot. Return and refresh the review.' USING ERRCODE='42501';END IF;
  END IF;
  SELECT actual.* INTO salary FROM public.compensation actual WHERE actual.employment_id=emp.id AND actual.tenant_id=unit.tenant_id AND actual.valid_to IS NULL AND actual.superseded_at IS NULL FOR UPDATE;
  IF salary.id IS NULL OR salary.id IS DISTINCT FROM(item->'source'->>'compensationId')::uuid OR salary.basic_salary*100 IS DISTINCT FROM(item->'source'->>'basicCents')::numeric OR salary.currency IS DISTINCT FROM item->'source'->>'currency'OR salary.pay_mode::text IS DISTINCT FROM item->'source'->>'payMode'THEN RAISE EXCEPTION 'Salary data changed after the snapshot. Return and refresh the review.' USING ERRCODE='42501';END IF;
  IF(item->>'newBasicCents')::numeric<>(item->'source'->>'basicCents')::numeric AND(unit.policy->>'effectiveFrom')::date<=salary.valid_from THEN RAISE EXCEPTION 'The salary effective date must follow the current salary record.' USING ERRCODE='42501';END IF;
  IF coalesce(item->'recommendation'->>'promotionGrade','')<>''AND coalesce(item->'source'->>'leftOn','')=''AND NOT is_senior THEN
   IF(unit.policy->>'effectiveFrom')::date<>(clock_timestamp() AT TIME ZONE'Asia/Kuala_Lumpur')::date THEN RAISE EXCEPTION 'A promotion must be posted on its effective date because Job Grade is not effective-dated.' USING ERRCODE='42501';END IF;
   SELECT actual.* INTO target_grade FROM public.job_grade actual WHERE actual.tenant_id=unit.tenant_id AND actual.archived_at IS NULL AND regexp_replace(actual.code,'^[jJ][gG]['||whitespace||']*','')=item->'recommendation'->>'promotionGrade'LIMIT 1 FOR SHARE;
   IF target_grade.id IS NULL THEN RAISE EXCEPTION 'The approved promotion grade does not exist in Job Grades.' USING ERRCODE='42501';END IF;
  END IF;
  amount:=(item->>'bonusCents')::numeric+(item->>'lumpCents')::numeric;
  IF(amount<>0 OR is_senior)AND p_batch IS NOT NULL THEN
   SELECT actual.* INTO pay_input FROM public.payroll_input actual WHERE actual.batch_id=p_batch AND actual.employment_id=emp.id AND actual.tenant_id=unit.tenant_id FOR UPDATE;
   IF is_senior THEN
    award:=admission->'postingAwards'->(item->>'id');
    IF coalesce(award->>'confirmedBy','')=''OR coalesce(award->>'confirmedAt','')=''THEN RAISE EXCEPTION 'Senior decision lost its independent confirmation.' USING ERRCODE='42501';END IF;
    SELECT coalesce(jsonb_agg(value ORDER BY n),'[]'::jsonb)INTO provenance FROM jsonb_array_elements(coalesce(pay_input.reward_provenance,'[]'::jsonb))WITH ORDINALITY sources(value,n)WHERE value->>'unitId'IS DISTINCT FROM unit.id::text OR value->>'entryId'IS DISTINCT FROM item->>'id';
    provenance:=provenance||jsonb_build_array(jsonb_build_object('unitId',unit.id,'entryId',item->>'id','revision',unit.revision,'plan','Senior plan','confirmedBy',award->'confirmedBy','confirmedAt',award->'confirmedAt','historicalOnly',true));
    IF jsonb_array_length(provenance)>100 THEN RAISE EXCEPTION 'This payroll input has too many historical reward sources.' USING ERRCODE='42501';END IF;
   END IF;
  END IF;
  effects:=effects||jsonb_build_array(jsonb_build_object('entryId',item->>'id','employmentBefore',to_jsonb(emp),'compensationBefore',to_jsonb(salary),'seniorGradeBefore',CASE WHEN grade.id IS NULL THEN NULL ELSE to_jsonb(grade)END,'promotionGrade',CASE WHEN target_grade.id IS NULL THEN NULL ELSE to_jsonb(target_grade)END,'payrollInputBefore',CASE WHEN pay_input.id IS NULL THEN NULL ELSE to_jsonb(pay_input)END,'newBasicCents',item->'newBasicCents','newBasicSalary',app.reward_calc_fixed_money((item->>'newBasicCents')::double precision/100::double precision),'awardCents',amount,'newBonusAmount',CASE WHEN(amount<>0 OR is_senior)AND p_batch IS NOT NULL THEN app.reward_calc_fixed_money(CASE WHEN pay_input.bonus_amount::text='NaN'THEN 0::double precision ELSE greatest(0::double precision,coalesce(pay_input.bonus_amount,0)::double precision+amount::double precision/100::double precision)END)ELSE NULL END,'rewardProvenance',provenance));
 END LOOP;
 RETURN admission||jsonb_build_object('sourcePlan',effects,'transactionId',pg_current_xact_id()::text);
END $$;
REVOKE ALL ON FUNCTION app.reward_post_sources(uuid,integer,uuid)FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
-- Native setCompensation/setPayrollInput persist Number.toFixed(2), after the exact cents
-- engine has completed. Decode the actual IEEE754 value rather than round its shortest
-- decimal text (1.005 is the familiar counterexample). Private, finite money preparation.
CREATE FUNCTION app.reward_calc_fixed_money(p double precision)RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE bytes bytea;bits integer;binary_exponent integer;mantissa numeric;denominator numeric:=1;numerator numeric;cents numeric;n integer;
BEGIN
 IF p<0 OR p>=1e21 OR p::text IN('NaN','Infinity','-Infinity')THEN RAISE EXCEPTION 'Native Rewards money unavailable' USING ERRCODE='22003';END IF;
 IF p=0 THEN RETURN'0.00';END IF;
 bytes:=float8send(p);bits:=(get_byte(bytes,0)%128)*16+get_byte(bytes,1)/16;
 mantissa:=get_byte(bytes,1)%16;
 FOR n IN 2..7 LOOP mantissa:=mantissa*256+get_byte(bytes,n);END LOOP;
 IF bits=0 THEN binary_exponent:=-1074;ELSE mantissa:=mantissa+4503599627370496;binary_exponent:=bits-1023-52;END IF;
 numerator:=mantissa*100;
 IF binary_exponent>=0 THEN numerator:=numerator*power(2::numeric,binary_exponent);ELSE denominator:=power(2::numeric,-binary_exponent);END IF;
 -- ECMA toFixed chooses the larger integer on an exact tie for a nonnegative input.
 cents:=div(numerator*2+denominator,denominator*2);
 RETURN div(cents,100)::text||'.'||lpad(mod(cents,100)::text,2,'0');
END $$;
REVOKE ALL ON FUNCTION app.reward_calc_fixed_money(double precision)FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
-- Private construction state. No caller supplies salary, actor, event, target employment or
-- source image. Until the complete posting owner closes this exact context, deferred validation
-- refuses COMMIT; a salary constructor can never become a standalone partial-post API.
CREATE TABLE app.reward_post_native_context(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),xact_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,
 unit_id uuid NOT NULL,admission jsonb NOT NULL,source_plan jsonb NOT NULL,
 effects jsonb NOT NULL DEFAULT '{}',active boolean NOT NULL DEFAULT true,completed boolean NOT NULL DEFAULT false,
 recheck integer NOT NULL DEFAULT 0,posted_event_id uuid
);
ALTER TABLE app.reward_post_native_context ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.reward_post_native_context FROM PUBLIC,ai_hr_app;
CREATE INDEX reward_post_native_current_idx ON app.reward_post_native_context(xact_id,tenant_id,user_id,unit_id);
CREATE FUNCTION app.reward_post_context_begin(p_unit uuid,p_revision integer,p_batch uuid DEFAULT NULL)RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE prepared jsonb;result uuid;
BEGIN
 prepared:=app.reward_post_sources(p_unit,p_revision,p_batch);
 DELETE FROM app.reward_post_native_context c WHERE c.tenant_id=app.current_tenant_id()AND c.xact_id<pg_snapshot_xmin(pg_current_snapshot());
 IF(prepared->>'alreadyPosted')::boolean THEN RETURN NULL;END IF;
 IF EXISTS(SELECT 1 FROM app.reward_post_native_context c WHERE c.xact_id=pg_current_xact_id()AND c.tenant_id=app.current_tenant_id()AND c.user_id=app.current_user_id()AND c.unit_id=p_unit)THEN RAISE EXCEPTION 'Reward posting construction already entered' USING ERRCODE='42501';END IF;
 INSERT INTO app.reward_post_native_context(xact_id,tenant_id,user_id,unit_id,admission,source_plan)VALUES(pg_current_xact_id(),app.current_tenant_id(),app.current_user_id(),p_unit,prepared-ARRAY['sourcePlan','calculation','postingAwards'],prepared)RETURNING id INTO result;
 RETURN result;
END $$;
CREATE FUNCTION app.reward_post_context_current(p_context uuid)RETURNS app.reward_post_native_context
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE proof app.reward_post_native_context;
BEGIN
 IF nullif(current_setting('app.agent_principal_id',true),'')IS NOT NULL THEN RAISE EXCEPTION 'A current human Rewards principal is required' USING ERRCODE='42501';END IF;
 IF app.current_agent_principal()IS NOT NULL OR NOT app.principal_snapshot_current()OR app.current_user_id()IS NULL THEN RAISE EXCEPTION 'A current human Rewards principal is required' USING ERRCODE='42501';END IF;
 SELECT c.* INTO proof FROM app.reward_post_native_context c WHERE c.id=p_context AND c.xact_id=pg_current_xact_id()AND c.tenant_id=app.current_tenant_id()AND c.user_id=app.current_user_id()AND c.active AND NOT c.completed FOR UPDATE;
 IF proof.id IS NULL OR proof.admission->>'authorityStamp'IS DISTINCT FROM app.access_function_authority_stamp()OR NOT EXISTS(SELECT 1 FROM public.reward_unit u WHERE u.id=proof.unit_id AND u.tenant_id=proof.tenant_id AND u.deleted_at IS NULL AND u.status='approved'AND u.revision=(proof.admission->>'revision')::integer AND app.reward_decision_row_hash(to_jsonb(u),'reward_unit')=proof.admission->>'unitBeforeHash'AND app.reward_calc_decision_digest(u.policy,u.kind,u.parent_unit_id,u.offcycle,(SELECT coalesce(jsonb_agg(jsonb_build_object('id',e.id,'source',e.source,'facts',e.facts,'recommendation',e.recommendation)ORDER BY e.id),'[]'::jsonb)FROM public.reward_entry e WHERE e.unit_id=u.id AND e.tenant_id=u.tenant_id))=proof.admission->>'decisionDigest'AND app.reward_admin(u.company_id)AND'payroll'=ANY(ARRAY(SELECT app.reward_roles(u.id))))THEN RAISE EXCEPTION 'Reward posting construction unavailable' USING ERRCODE='42501';END IF;
 RETURN proof;
END $$;
CREATE FUNCTION app.reward_post_salary(p_context uuid,p_entry uuid)RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE proof app.reward_post_native_context;plan jsonb;unit public.reward_unit;salary public.compensation;after_salary public.compensation;new_salary public.compensation;entry public.reward_entry;after_entry public.reward_entry;audit_id uuid;native_remarks text;target_employment uuid;
BEGIN
 proof:=app.reward_post_context_current(p_context);
 SELECT value INTO plan FROM jsonb_array_elements(proof.source_plan->'sourcePlan')WHERE value->>'entryId'=p_entry::text;
 IF plan IS NULL OR proof.effects?('salary:'||p_entry::text)THEN RAISE EXCEPTION 'Reward salary construction unavailable' USING ERRCODE='42501';END IF;
 SELECT u.* INTO unit FROM public.reward_unit u WHERE u.id=proof.unit_id AND u.tenant_id=proof.tenant_id;
 target_employment:=(plan->'employmentBefore'->>'id')::uuid;
 SELECT e.* INTO entry FROM public.reward_entry e WHERE e.id=p_entry AND e.unit_id=unit.id AND e.tenant_id=proof.tenant_id AND e.employment_id=target_employment FOR UPDATE;
 IF entry.id IS NULL THEN RAISE EXCEPTION 'Reward salary entry unavailable' USING ERRCODE='42501';END IF;
 IF(plan->>'newBasicCents')::numeric=(entry.source->>'basicCents')::numeric THEN RETURN NULL;END IF;
 -- Same independent financial Add floor as canonical setCompensation, never a Rewards grant.
 IF NOT app.access_compensation_action(target_employment,'add')THEN RAISE EXCEPTION 'Salary record or permission is unavailable' USING ERRCODE='42501';END IF;
 SELECT c.* INTO salary FROM public.compensation c WHERE c.id=(plan->'compensationBefore'->>'id')::uuid AND c.tenant_id=proof.tenant_id AND c.employment_id=target_employment FOR UPDATE;
 IF salary.id IS NULL OR to_jsonb(salary)IS DISTINCT FROM plan->'compensationBefore'OR salary.valid_to IS NOT NULL OR salary.superseded_at IS NOT NULL OR(unit.policy->>'effectiveFrom')::date<=salary.valid_from THEN RAISE EXCEPTION 'Salary data changed after the snapshot. Return and refresh the review.' USING ERRCODE='42501';END IF;
 IF salary.pay_mode::text IN('daily','hourly')AND(salary.rate_amount IS NULL OR salary.rate_amount::text IN('NaN','Infinity','-Infinity')OR salary.rate_amount<=0)THEN RAISE EXCEPTION 'A daily or hourly pay mode requires a rate greater than zero' USING ERRCODE='22003';END IF;
 IF salary.monthly_allowance::text IN('NaN','Infinity','-Infinity')THEN RAISE EXCEPTION 'Monthly allowance must be a number — a blank or unparseable amount cannot be stored on a salary record' USING ERRCODE='22003';END IF;
 native_remarks:=CASE WHEN app.reward_calc_senior(unit.policy,jsonb_build_object('source',entry.source,'facts',entry.facts))THEN'Senior plan — 'ELSE''END||'Approved Reward Desk review '||unit.id::text;
 UPDATE public.compensation c SET valid_to=(unit.policy->>'effectiveFrom')::date WHERE c.id=salary.id AND c.tenant_id=proof.tenant_id RETURNING c.* INTO after_salary;
 INSERT INTO public.compensation(tenant_id,employment_id,basic_salary,currency,monthly_allowance,pay_mode,payment_term,rate_amount,remarks,valid_from,valid_to)
 VALUES(proof.tenant_id,target_employment,(plan->>'newBasicSalary')::numeric,salary.currency,salary.monthly_allowance,salary.pay_mode,salary.payment_term,salary.rate_amount,native_remarks,(unit.policy->>'effectiveFrom')::date,NULL)RETURNING * INTO new_salary;
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload)
 VALUES(proof.tenant_id,'compensation',new_salary.id,'compensation.set','user',proof.user_id,target_employment,jsonb_build_object('employmentId',target_employment,'effectiveFrom',unit.policy->>'effectiveFrom','fieldsChanged',jsonb_build_array('basicSalary','remarks')))RETURNING id INTO audit_id;
 PERFORM app.financial_mark_source_payroll_stale(ARRAY[target_employment],'compensation',(unit.policy->>'effectiveFrom')::date);
 UPDATE public.reward_entry e SET enacted_compensation_id=new_salary.id WHERE e.id=p_entry AND e.tenant_id=proof.tenant_id AND e.unit_id=unit.id RETURNING e.* INTO after_entry;
 UPDATE app.reward_post_native_context c SET effects=c.effects||jsonb_build_object('salary:'||p_entry::text,jsonb_build_object('oldId',salary.id,'oldBefore',to_jsonb(salary),'oldAfter',to_jsonb(after_salary),'newId',new_salary.id,'newAfter',to_jsonb(new_salary),'auditId',audit_id,'employmentId',target_employment,'entryBefore',to_jsonb(entry),'entryAfter',to_jsonb(after_entry)))WHERE c.id=proof.id;
 RETURN new_salary.id;
END $$;
-- Conservative declaration order: the exact physical/audit validator is installed below.
-- Incomplete contexts remain refused; application callers receive no construction flag.
CREATE FUNCTION app.reward_post_native_validate()RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 RAISE EXCEPTION 'Reward posting construction is incomplete' USING ERRCODE='42501',SCHEMA='app',TABLE='reward_post_native_context',CONSTRAINT=TG_NAME;
END $$;
CREATE CONSTRAINT TRIGGER rewards_post_native_effect AFTER INSERT ON app.reward_post_native_context DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.reward_post_native_validate();
CREATE CONSTRAINT TRIGGER rewards_post_native_completed AFTER UPDATE ON app.reward_post_native_context DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.completed AND NOT NEW.active)EXECUTE FUNCTION app.reward_post_native_validate();
REVOKE ALL ON FUNCTION app.reward_post_context_begin(uuid,integer,uuid),app.reward_post_context_current(uuid),app.reward_post_salary(uuid,uuid),app.reward_post_native_validate()FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.reward_post_grade(p_context uuid,p_entry uuid)RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE proof app.reward_post_native_context;plan jsonb;emp public.employment;after_emp public.employment;target public.job_grade;audit_id uuid;
BEGIN
 proof:=app.reward_post_context_current(p_context);
 SELECT value INTO plan FROM jsonb_array_elements(proof.source_plan->'sourcePlan')WHERE value->>'entryId'=p_entry::text;
 IF plan IS NULL OR proof.effects?('grade:'||p_entry::text)THEN RAISE EXCEPTION 'Reward grade construction unavailable' USING ERRCODE='42501';END IF;
 IF coalesce(plan->'promotionGrade','null'::jsonb)='null'::jsonb THEN RETURN NULL;END IF;
 SELECT e.* INTO emp FROM public.employment e WHERE e.id=(plan->'employmentBefore'->>'id')::uuid AND e.tenant_id=proof.tenant_id FOR UPDATE;
 IF emp.id IS NULL OR to_jsonb(emp)IS DISTINCT FROM plan->'employmentBefore'OR NOT app.access_workforce_action_employment(emp.id,'edit')THEN RAISE EXCEPTION 'Reward promotion source or permission unavailable' USING ERRCODE='42501';END IF;
 SELECT g.* INTO target FROM public.job_grade g WHERE g.id=(plan->'promotionGrade'->>'id')::uuid AND g.tenant_id=proof.tenant_id FOR SHARE;
 IF target.id IS NULL OR to_jsonb(target)IS DISTINCT FROM plan->'promotionGrade'OR target.archived_at IS NOT NULL THEN RAISE EXCEPTION 'The approved promotion grade does not exist in Job Grades.' USING ERRCODE='42501';END IF;
 IF emp.grade_id IS NOT DISTINCT FROM target.id THEN RETURN NULL;END IF;
 IF NOT EXISTS(SELECT 1 FROM public.reward_unit u WHERE u.id=proof.unit_id AND u.tenant_id=proof.tenant_id AND(u.policy->>'effectiveFrom')::date=(clock_timestamp()AT TIME ZONE'Asia/Kuala_Lumpur')::date)THEN RAISE EXCEPTION 'A promotion must be posted on its effective date because Job Grade is not effective-dated.' USING ERRCODE='42501';END IF;
 UPDATE public.employment e SET grade_id=target.id WHERE e.id=emp.id AND e.tenant_id=proof.tenant_id RETURNING e.* INTO after_emp;
 IF NOT app.data_permission_matches(emp.id)THEN RAISE EXCEPTION 'Reward promotion destination unavailable' USING ERRCODE='42501';END IF;
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload)
 VALUES(proof.tenant_id,'employment',emp.id,'employment.grade.changed','user',proof.user_id,emp.id,jsonb_build_object('before',emp.grade_id,'after',target.id))RETURNING id INTO audit_id;
 UPDATE app.reward_post_native_context c SET effects=c.effects||jsonb_build_object('grade:'||p_entry::text,jsonb_build_object('employmentId',emp.id,'before',to_jsonb(emp),'after',to_jsonb(after_emp),'auditId',audit_id))WHERE c.id=proof.id;
 RETURN target.id;
END $$;
CREATE FUNCTION app.reward_post_input(p_context uuid,p_entry uuid)RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE proof app.reward_post_native_context;plan jsonb;before_input public.payroll_input;after_input public.payroll_input;batch public.payroll_batch;target_employment uuid;audit_id uuid;event_after jsonb;
BEGIN
 proof:=app.reward_post_context_current(p_context);
 SELECT value INTO plan FROM jsonb_array_elements(proof.source_plan->'sourcePlan')WHERE value->>'entryId'=p_entry::text;
 IF plan IS NULL OR proof.effects?('input:'||p_entry::text)THEN RAISE EXCEPTION 'Reward payroll construction unavailable' USING ERRCODE='42501';END IF;
 IF plan->>'newBonusAmount'IS NULL THEN RETURN NULL;END IF;
 target_employment:=(plan->'employmentBefore'->>'id')::uuid;
 SELECT b.* INTO batch FROM public.payroll_batch b WHERE b.id=(proof.admission->>'batchId')::uuid AND b.tenant_id=proof.tenant_id FOR UPDATE;
 IF batch.id IS NULL OR batch.status<>'draft'OR NOT app.function_action_allowed('payroll.process','edit',batch.company_id)OR NOT app.access_financial_action_employment('payroll',target_employment,'edit')THEN RAISE EXCEPTION 'Reward payroll source or permission unavailable' USING ERRCODE='42501';END IF;
 SELECT i.* INTO before_input FROM public.payroll_input i WHERE i.batch_id=batch.id AND i.employment_id=target_employment AND i.tenant_id=proof.tenant_id FOR UPDATE;
 IF(CASE WHEN before_input.id IS NULL THEN NULL ELSE to_jsonb(before_input)END)IS DISTINCT FROM nullif(plan->'payrollInputBefore','null'::jsonb)THEN RAISE EXCEPTION 'Payroll input changed after reward preparation' USING ERRCODE='42501';END IF;
 IF before_input.id IS NULL THEN
  INSERT INTO public.payroll_input(tenant_id,batch_id,employment_id,overtime_amount,bonus_amount,tp1_deduction,zakat,ot_breakdown,ot_source,tp1_source)
  VALUES(proof.tenant_id,batch.id,target_employment,0,(plan->>'newBonusAmount')::numeric,0,0,NULL,NULL,NULL)RETURNING * INTO after_input;
 ELSE
  -- The canonical bonus-enact call explicitly preserves OT/TP1 provenance and decomposition.
  -- All unrelated allowance/claim/loan/component fields remain on the same physical row.
  UPDATE public.payroll_input i SET overtime_amount=app.reward_calc_input_carry(before_input.overtime_amount),bonus_amount=(plan->>'newBonusAmount')::numeric,tp1_deduction=app.reward_calc_input_carry(before_input.tp1_deduction),zakat=app.reward_calc_input_carry(before_input.zakat),updated_at=now()WHERE i.id=before_input.id AND i.tenant_id=proof.tenant_id RETURNING i.* INTO after_input;
 END IF;
 event_after:=to_jsonb(after_input);
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
 VALUES(proof.tenant_id,'payroll-batch',batch.id,'payroll-batch.input-set','user',proof.user_id,jsonb_build_object('employmentId',target_employment,'payrollInputId',after_input.id,'fieldsChanged',jsonb_build_array('overtimeAmount','bonusAmount','tp1Deduction','zakat')))RETURNING id INTO audit_id;
 -- Same second write as the native Senior history path, after the ordinary input event.
 IF plan->'rewardProvenance'<>'null'::jsonb THEN UPDATE public.payroll_input i SET reward_provenance=plan->'rewardProvenance'WHERE i.id=after_input.id AND i.tenant_id=proof.tenant_id RETURNING i.* INTO after_input;END IF;
 UPDATE app.reward_post_native_context c SET effects=c.effects||jsonb_build_object('input:'||p_entry::text,jsonb_build_object('inputId',after_input.id,'before',CASE WHEN before_input.id IS NULL THEN NULL ELSE to_jsonb(before_input)END,'eventAfter',event_after,'after',to_jsonb(after_input),'auditId',audit_id,'employmentId',target_employment))WHERE c.id=proof.id;
 RETURN after_input.id;
END $$;
REVOKE ALL ON FUNCTION app.reward_post_grade(uuid,uuid),app.reward_post_input(uuid,uuid)FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
-- Physical receipts belong only to the internally derived active posting, never to raw app
-- writes outside it. They attest actual mutations; the completion validator checks their exact
-- source/effect/audit relation rather than treating the existence of a context as authority.
CREATE TABLE app.reward_post_native_receipt(
 context_id uuid NOT NULL REFERENCES app.reward_post_native_context(id)ON DELETE CASCADE,
 table_name text NOT NULL,row_id uuid NOT NULL,before_row jsonb,after_row jsonb,
 receipt_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY
);
ALTER TABLE app.reward_post_native_receipt ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.reward_post_native_receipt FROM PUBLIC,ai_hr_app;
CREATE INDEX reward_post_native_receipt_context_idx ON app.reward_post_native_receipt(context_id,table_name,row_id);
CREATE FUNCTION app.reward_post_native_capture()RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE before_image jsonb:=CASE WHEN TG_OP='INSERT'THEN NULL ELSE to_jsonb(OLD)END;after_image jsonb:=to_jsonb(NEW);data jsonb:=to_jsonb(NEW);proof record;
BEGIN
 FOR proof IN SELECT c.id FROM app.reward_post_native_context c WHERE c.xact_id=pg_current_xact_id()AND c.tenant_id=(data->>'tenant_id')::uuid AND c.user_id=app.current_user_id()AND c.active AND NOT c.completed AND(
  TG_TABLE_NAME='reward_unit'AND c.unit_id=(data->>'id')::uuid
  OR TG_TABLE_NAME='reward_entry'AND c.unit_id=(data->>'unit_id')::uuid AND EXISTS(SELECT 1 FROM jsonb_array_elements(c.source_plan->'sourcePlan')p WHERE p->>'entryId'=data->>'id')
  OR TG_TABLE_NAME='compensation'AND EXISTS(SELECT 1 FROM jsonb_array_elements(c.source_plan->'sourcePlan')p WHERE p->'employmentBefore'->>'id'=data->>'employment_id')
  OR TG_TABLE_NAME='employment'AND EXISTS(SELECT 1 FROM jsonb_array_elements(c.source_plan->'sourcePlan')p WHERE p->'employmentBefore'->>'id'=data->>'id')
  OR TG_TABLE_NAME='payroll_input'AND c.admission->>'batchId'=data->>'batch_id'AND EXISTS(SELECT 1 FROM jsonb_array_elements(c.source_plan->'sourcePlan')p WHERE p->'employmentBefore'->>'id'=data->>'employment_id'))LOOP
  INSERT INTO app.reward_post_native_receipt(context_id,table_name,row_id,before_row,after_row)VALUES(proof.id,TG_TABLE_NAME,(data->>'id')::uuid,before_image,after_image);
 END LOOP;
 RETURN NULL;
END $$;
DO $$ DECLARE target text;BEGIN
 FOREACH target IN ARRAY ARRAY['reward_unit','reward_entry','compensation','employment','payroll_input']LOOP
  EXECUTE format('CREATE TRIGGER rewards_post_native_capture AFTER INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.reward_post_native_capture()',target);
 END LOOP;
END $$;
CREATE FUNCTION app.reward_post_receipt(p_context uuid,p_table text,p_row uuid,p_before jsonb,p_after jsonb)RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app.reward_post_native_context c JOIN app.reward_post_native_receipt r ON r.context_id=c.id WHERE c.id=p_context AND c.xact_id=pg_current_xact_id()AND c.tenant_id=app.current_tenant_id()AND c.user_id=app.current_user_id()AND r.table_name=p_table AND r.row_id=p_row AND r.before_row IS NOT DISTINCT FROM p_before AND r.after_row IS NOT DISTINCT FROM p_after);
$$;
CREATE FUNCTION app.reward_post_audit(p_context uuid,p_audit uuid,p_aggregate text,p_id uuid,p_event text,p_subject uuid,p_payload jsonb)RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app.reward_post_native_context c JOIN public.domain_event e ON e.id=p_audit AND e.tenant_id=c.tenant_id AND e.actor_type='user'AND e.actor_id=c.user_id WHERE c.id=p_context AND c.xact_id=pg_current_xact_id()AND c.tenant_id=app.current_tenant_id()AND c.user_id=app.current_user_id()AND e.aggregate_type=p_aggregate AND e.aggregate_id=p_id AND e.event_type=p_event AND e.subject_employment_id IS NOT DISTINCT FROM p_subject AND e.payload=p_payload AND EXISTS(SELECT 1 FROM app.lifecycle_row_transaction_receipt b WHERE b.xact_id=c.xact_id AND b.tenant_id=c.tenant_id AND b.user_id=c.user_id AND b.table_name='domain_event'AND b.row_id=e.id));
$$;
REVOKE ALL ON FUNCTION app.reward_post_native_capture(),app.reward_post_receipt(uuid,text,uuid,jsonb,jsonb),app.reward_post_audit(uuid,uuid,text,uuid,text,uuid,jsonb)FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.reward_post_native_validate()RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE proof app.reward_post_native_context;unit public.reward_unit;plan jsonb;effect jsonb;before_image jsonb;after_image jsonb;native_before jsonb;expected jsonb;senior_ids jsonb;target_employment uuid;entry_id uuid;input_id uuid;
BEGIN
 SELECT c.* INTO proof FROM app.reward_post_native_context c WHERE c.id=NEW.id;
 IF proof.id IS NULL THEN RETURN NULL;END IF;
 IF proof.active OR NOT proof.completed THEN RAISE EXCEPTION 'Reward posting construction is incomplete' USING ERRCODE='42501',SCHEMA='app',TABLE='reward_post_native_context',CONSTRAINT=TG_NAME;END IF;
 IF nullif(current_setting('app.agent_principal_id',true),'')IS NOT NULL THEN RAISE EXCEPTION 'Reward posting authority changed' USING ERRCODE='42501';END IF;
 IF app.current_agent_principal()IS NOT NULL OR NOT app.principal_snapshot_current()OR proof.xact_id<>pg_current_xact_id()OR proof.tenant_id IS DISTINCT FROM app.current_tenant_id()OR proof.user_id IS DISTINCT FROM app.current_user_id()OR proof.admission->>'authorityStamp'IS DISTINCT FROM app.access_function_authority_stamp()THEN RAISE EXCEPTION 'Reward posting authority changed' USING ERRCODE='42501';END IF;
 SELECT u.* INTO unit FROM public.reward_unit u WHERE u.id=proof.unit_id AND u.tenant_id=proof.tenant_id AND u.deleted_at IS NULL;
 IF unit.id IS NULL OR unit.status<>'posted'OR NOT app.reward_admin(unit.company_id)OR NOT('payroll'=ANY(ARRAY(SELECT app.reward_roles(unit.id))))THEN RAISE EXCEPTION 'Reward posting authority changed' USING ERRCODE='42501';END IF;
 IF proof.admission->'positiveAdmission'IS DISTINCT FROM'true'::jsonb OR proof.admission->>'functionKey'IS DISTINCT FROM'rewards.posting'OR proof.admission->>'functionOperation'IS DISTINCT FROM'execute'OR app.function_action_denial_clear('rewards.posting','execute',unit.company_id)IS NOT TRUE THEN RAISE EXCEPTION 'Reward posting authority changed' USING ERRCODE='42501';END IF;
 effect:=proof.effects->'unit';native_before:=effect->'before';
 IF effect IS NULL OR app.reward_decision_row_hash(native_before,'reward_unit')IS DISTINCT FROM proof.admission->>'unitBeforeHash'OR app.reward_decision_row_hash(to_jsonb(unit),'reward_unit')IS DISTINCT FROM app.reward_decision_row_hash(effect->'after','reward_unit')OR NOT app.reward_post_receipt(proof.id,'reward_unit',unit.id,native_before,effect->'after')
  OR(effect->'after')-ARRAY['status','funding_cents','posted_batch_id','posted_at','updated_at']IS DISTINCT FROM native_before-ARRAY['status','funding_cents','posted_batch_id','posted_at','updated_at']OR effect->'after'->>'status'<>'posted'OR effect->'after'->'posted_batch_id'IS DISTINCT FROM proof.admission->'batchId'OR effect->'after'->'funding_cents'IS DISTINCT FROM app.reward_post_funding(native_before->>'kind',native_before->'funding_cents',proof.source_plan->'calculation')OR effect->'after'->'posted_at'='null'::jsonb THEN RAISE EXCEPTION 'Reward posting unit effect unavailable' USING ERRCODE='42501';END IF;
 SELECT coalesce(jsonb_agg(e->'id'ORDER BY n),'[]'::jsonb)INTO senior_ids FROM jsonb_array_elements(proof.source_plan->'calculation'->'rows')WITH ORDINALITY rows(e,n)WHERE app.reward_calc_senior(native_before->'policy',e);
 IF NOT app.reward_post_audit(proof.id,proof.posted_event_id,'reward-unit',unit.id,'reward-unit.posted',NULL,jsonb_build_object('batchId',proof.admission->'batchId','revision',proof.admission->'revision','seniorPlanEntryIds',senior_ids))THEN RAISE EXCEPTION 'Reward posting audit unavailable' USING ERRCODE='42501';END IF;
 FOR plan IN SELECT value FROM jsonb_array_elements(proof.source_plan->'sourcePlan')LOOP
  entry_id:=(plan->>'entryId')::uuid;target_employment:=(plan->'employmentBefore'->>'id')::uuid;
  IF(plan->>'newBasicCents')::numeric<>(plan->'compensationBefore'->>'basic_salary')::numeric*100 THEN
   effect:=proof.effects->('salary:'||entry_id::text);before_image:=effect->'oldBefore';after_image:=effect->'oldAfter';
   IF effect IS NULL OR before_image IS DISTINCT FROM plan->'compensationBefore'OR after_image IS DISTINCT FROM before_image||jsonb_build_object('valid_to',native_before->'policy'->>'effectiveFrom')OR NOT app.reward_post_receipt(proof.id,'compensation',(effect->>'oldId')::uuid,before_image,after_image)OR NOT app.access_compensation_action(target_employment,'add')THEN RAISE EXCEPTION 'Reward salary boundary effect unavailable' USING ERRCODE='42501';END IF;
   after_image:=effect->'newAfter';
   expected:=jsonb_build_object('tenant_id',proof.tenant_id,'employment_id',target_employment,'basic_salary',(plan->>'newBasicSalary')::numeric,'currency',before_image->'currency','monthly_allowance',before_image->'monthly_allowance','pay_mode',before_image->'pay_mode','payment_term',before_image->'payment_term','rate_amount',before_image->'rate_amount','remarks',CASE WHEN app.reward_calc_senior(native_before->'policy',effect->'entryBefore')THEN'Senior plan — 'ELSE''END||'Approved Reward Desk review '||unit.id::text,'valid_from',native_before->'policy'->>'effectiveFrom','valid_to',NULL);
   IF after_image-ARRAY['id','recorded_at','created_at','updated_at','superseded_at']IS DISTINCT FROM expected OR after_image->'updated_at'<>'null'::jsonb OR after_image->'superseded_at'<>'null'::jsonb OR NOT app.reward_post_receipt(proof.id,'compensation',(effect->>'newId')::uuid,NULL,after_image)
    OR effect->'entryAfter'IS DISTINCT FROM(effect->'entryBefore')||jsonb_build_object('enacted_compensation_id',effect->'newId')OR NOT app.reward_post_receipt(proof.id,'reward_entry',entry_id,effect->'entryBefore',effect->'entryAfter')OR NOT app.reward_post_audit(proof.id,(effect->>'auditId')::uuid,'compensation',(effect->>'newId')::uuid,'compensation.set',target_employment,jsonb_build_object('employmentId',target_employment,'effectiveFrom',native_before->'policy'->>'effectiveFrom','fieldsChanged',jsonb_build_array('basicSalary','remarks')))THEN RAISE EXCEPTION 'Reward salary effect or audit unavailable' USING ERRCODE='42501';END IF;
  ELSIF proof.effects?('salary:'||entry_id::text)THEN RAISE EXCEPTION 'Unexpected Reward salary effect' USING ERRCODE='42501';END IF;
  IF coalesce(plan->'promotionGrade','null'::jsonb)<>'null'::jsonb AND plan->'promotionGrade'->'id'IS DISTINCT FROM plan->'employmentBefore'->'grade_id'THEN
   effect:=proof.effects->('grade:'||entry_id::text);before_image:=effect->'before';after_image:=effect->'after';
   IF effect IS NULL OR before_image IS DISTINCT FROM plan->'employmentBefore'OR after_image IS DISTINCT FROM before_image||jsonb_build_object('grade_id',plan->'promotionGrade'->'id')OR NOT app.reward_post_receipt(proof.id,'employment',target_employment,before_image,after_image)OR NOT app.access_workforce_action_employment(target_employment,'edit')OR NOT app.reward_post_audit(proof.id,(effect->>'auditId')::uuid,'employment',target_employment,'employment.grade.changed',target_employment,jsonb_build_object('before',before_image->'grade_id','after',after_image->'grade_id'))THEN RAISE EXCEPTION 'Reward grade effect or audit unavailable' USING ERRCODE='42501';END IF;
  ELSIF proof.effects?('grade:'||entry_id::text)THEN RAISE EXCEPTION 'Unexpected Reward grade effect' USING ERRCODE='42501';END IF;
  IF plan->>'newBonusAmount'IS NOT NULL THEN
   effect:=proof.effects->('input:'||entry_id::text);before_image:=nullif(effect->'before','null'::jsonb);after_image:=effect->'eventAfter';input_id:=(effect->>'inputId')::uuid;
   IF effect IS NULL OR before_image IS DISTINCT FROM nullif(plan->'payrollInputBefore','null'::jsonb)OR NOT app.reward_post_receipt(proof.id,'payroll_input',input_id,before_image,after_image)OR after_image->>'batch_id'IS DISTINCT FROM proof.admission->>'batchId'OR after_image->>'employment_id'IS DISTINCT FROM target_employment::text OR(after_image->>'bonus_amount')::numeric IS DISTINCT FROM(plan->>'newBonusAmount')::numeric OR NOT app.function_action_allowed('payroll.process','edit',unit.company_id)OR NOT app.access_financial_action_employment('payroll',target_employment,'edit')THEN RAISE EXCEPTION 'Reward payroll input effect unavailable' USING ERRCODE='42501';END IF;
   IF before_image IS NOT NULL AND after_image-ARRAY['overtime_amount','bonus_amount','tp1_deduction','zakat','updated_at']IS DISTINCT FROM before_image-ARRAY['overtime_amount','bonus_amount','tp1_deduction','zakat','updated_at']THEN RAISE EXCEPTION 'Reward payroll input metadata changed' USING ERRCODE='42501';END IF;
   IF(after_image->>'overtime_amount')::numeric<>app.reward_calc_input_carry((before_image->>'overtime_amount')::numeric)OR(after_image->>'tp1_deduction')::numeric<>app.reward_calc_input_carry((before_image->>'tp1_deduction')::numeric)OR(after_image->>'zakat')::numeric<>app.reward_calc_input_carry((before_image->>'zakat')::numeric)OR NOT app.reward_post_audit(proof.id,(effect->>'auditId')::uuid,'payroll-batch',(proof.admission->>'batchId')::uuid,'payroll-batch.input-set',NULL,jsonb_build_object('employmentId',target_employment,'payrollInputId',input_id,'fieldsChanged',jsonb_build_array('overtimeAmount','bonusAmount','tp1Deduction','zakat')))THEN RAISE EXCEPTION 'Reward payroll input audit unavailable' USING ERRCODE='42501';END IF;
   IF plan->'rewardProvenance'<>'null'::jsonb THEN
    IF effect->'after'IS DISTINCT FROM after_image||jsonb_build_object('reward_provenance',plan->'rewardProvenance')OR NOT app.reward_post_receipt(proof.id,'payroll_input',input_id,after_image,effect->'after')THEN RAISE EXCEPTION 'Reward historical provenance effect unavailable' USING ERRCODE='42501';END IF;
   ELSIF effect->'after'IS DISTINCT FROM after_image THEN RAISE EXCEPTION 'Unexpected Reward provenance effect' USING ERRCODE='42501';END IF;
  ELSIF proof.effects?('input:'||entry_id::text)THEN RAISE EXCEPTION 'Unexpected Reward payroll input effect' USING ERRCODE='42501';END IF;
 END LOOP;
 RETURN NULL;
END $$;

--> statement-breakpoint
CREATE FUNCTION app.reward_post_funding(p_kind text,p_existing jsonb,p_calculation jsonb)RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb:='{}';plan text;remaining numeric;
BEGIN
 IF p_kind<>'annual'THEN RETURN p_existing;END IF;
 FOREACH plan IN ARRAY ARRAY['standard','h']LOOP
  SELECT app.reward_calc_integer(coalesce(sum(greatest(0,(pool.value#>>'{}')::numeric-(p_calculation->'budgets'->plan->'used'->>(pool.n-1)::integer)::numeric)),0),true)INTO remaining FROM jsonb_array_elements(p_calculation->'budgets'->plan->'pools')WITH ORDINALITY pool(value,n);
  result:=result||jsonb_build_object(plan,remaining);
 END LOOP;
 RETURN result;
END $$;
CREATE FUNCTION app.reward_post_native(p_unit uuid,p_revision integer,p_batch uuid DEFAULT NULL)RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE context_id uuid;proof app.reward_post_native_context;plan jsonb;before_unit public.reward_unit;after_unit public.reward_unit;posted_id uuid;senior_ids jsonb;posted_time timestamptz;own_immediate boolean:=false;refusal_schema text;refusal_table text;refusal_constraint text;refusal_message text;
BEGIN
 -- Keep the tenant Access/audit order before source, credit and financial row acquisition.
 PERFORM app.audit_access_order_lock();PERFORM app.access_workforce_write_lock();
 PERFORM pg_advisory_xact_lock(hashtext('audit-chain:'||app.current_tenant_id()::text));
 -- This is a real admission/construction attempt, not a mode probe or fabricated row.
 -- Only the actual owned INSERT-orphan constraint proves that its caller mode is IMMEDIATE.
 -- Its failed child transaction rolls back the insertion and all source work performed there.
 BEGIN
  context_id:=app.reward_post_context_begin(p_unit,p_revision,p_batch);
 EXCEPTION WHEN SQLSTATE '42501' THEN
  GET STACKED DIAGNOSTICS refusal_schema=SCHEMA_NAME,refusal_table=TABLE_NAME,refusal_constraint=CONSTRAINT_NAME,refusal_message=MESSAGE_TEXT;
  IF refusal_schema IS DISTINCT FROM'app'OR refusal_table IS DISTINCT FROM'reward_post_native_context'OR refusal_constraint IS DISTINCT FROM'rewards_post_native_effect'OR refusal_message IS DISTINCT FROM'Reward posting construction is incomplete'THEN RAISE;END IF;
  own_immediate:=true;
 END;
 IF own_immediate THEN
  SET CONSTRAINTS app.rewards_post_native_effect DEFERRED;
  -- Re-adjudicate actual locked sources after rollback; no failed admission/source image is reused.
  context_id:=app.reward_post_context_begin(p_unit,p_revision,p_batch);
 END IF;
 IF context_id IS NULL THEN IF own_immediate THEN SET CONSTRAINTS app.rewards_post_native_effect IMMEDIATE;END IF;RETURN jsonb_build_object('alreadyPosted',true);END IF;
 SELECT c.* INTO proof FROM app.reward_post_native_context c WHERE c.id=context_id;
 FOR plan IN SELECT value FROM jsonb_array_elements(proof.source_plan->'sourcePlan')ORDER BY value->'employmentBefore'->>'id'COLLATE "C" LOOP
  PERFORM app.reward_post_salary(context_id,(plan->>'entryId')::uuid);
  PERFORM app.reward_post_grade(context_id,(plan->>'entryId')::uuid);
  PERFORM app.reward_post_input(context_id,(plan->>'entryId')::uuid);
 END LOOP;
 proof:=app.reward_post_context_current(context_id);
 SELECT u.* INTO before_unit FROM public.reward_unit u WHERE u.id=proof.unit_id AND u.tenant_id=proof.tenant_id FOR UPDATE;
 posted_time:=clock_timestamp();
 UPDATE public.reward_unit u SET status='posted',funding_cents=app.reward_post_funding(u.kind,u.funding_cents,proof.source_plan->'calculation'),posted_batch_id=p_batch,posted_at=posted_time,updated_at=posted_time WHERE u.id=proof.unit_id AND u.tenant_id=proof.tenant_id RETURNING u.* INTO after_unit;
 SELECT coalesce(jsonb_agg(e->'id'ORDER BY n),'[]'::jsonb)INTO senior_ids FROM jsonb_array_elements(proof.source_plan->'calculation'->'rows')WITH ORDINALITY rows(e,n)WHERE app.reward_calc_senior(before_unit.policy,e);
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
 VALUES(proof.tenant_id,'reward-unit',proof.unit_id,'reward-unit.posted','user',proof.user_id,jsonb_build_object('batchId',p_batch,'revision',p_revision,'seniorPlanEntryIds',senior_ids))RETURNING id INTO posted_id;
 UPDATE app.reward_post_native_context c SET active=false,completed=true,posted_event_id=posted_id,effects=c.effects||jsonb_build_object('unit',jsonb_build_object('before',to_jsonb(before_unit),'after',to_jsonb(after_unit)))WHERE c.id=context_id;
 -- Restore exactly the one constraint whose prior IMMEDIATE mode was proven above.
 -- This forces the finished effect through the unchanged full validator before returning.
 IF own_immediate THEN SET CONSTRAINTS app.rewards_post_native_effect IMMEDIATE;END IF;
 RETURN jsonb_build_object('alreadyPosted',false);
END $$;
CREATE FUNCTION app.reward_post_authority_changed()RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 UPDATE app.reward_post_native_context c SET recheck=c.recheck+1 WHERE c.xact_id=pg_current_xact_id()AND c.tenant_id=NEW.tenant_id AND c.completed AND NOT c.active;
 RETURN NULL;
END $$;
CREATE TRIGGER rewards_post_authority_recheck AFTER UPDATE ON app.access_control_epoch FOR EACH ROW EXECUTE FUNCTION app.reward_post_authority_changed();
REVOKE ALL ON FUNCTION app.reward_post_funding(text,jsonb,jsonb),app.reward_post_native(uuid,integer,uuid),app.reward_post_authority_changed()FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
-- setPayrollInput carries Number(value)||0 through Math.max(0,...); SQL NaN ordering must
-- not turn a legacy NaN into a stored NaN or award it a different bonus on the merge path.
CREATE FUNCTION app.reward_calc_input_carry(p numeric)RETURNS numeric
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN p::text='NaN'THEN 0 ELSE greatest(0,coalesce(p,0))END;
$$;
REVOKE ALL ON FUNCTION app.reward_calc_input_carry(numeric)FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
-- Pay-free complete verification totals are an existing seated review-list course. They
-- disclose no category/person/own-person status or monetary aggregate. An administrator
-- without a native seat gets NULL, never a partial Personnel-filtered population.
-- Private until its finite read ACL and consuming list owner are reviewed together.
CREATE FUNCTION app.reward_unit_verification_counts(p_unit uuid)RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE unit public.reward_unit;people integer;verified integer;
BEGIN
 IF NOT app.principal_snapshot_current()OR app.current_user_id()IS NULL OR NOT EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=app.current_user_id()AND u.tenant_id=app.current_tenant_id()AND u.archived_at IS NULL AND NOT app.login_blocked(u.id))THEN RETURN NULL;END IF;
 SELECT u.* INTO unit FROM public.reward_unit u WHERE u.id=p_unit AND u.tenant_id=app.current_tenant_id()AND u.deleted_at IS NULL;
 IF unit.id IS NULL OR NOT EXISTS(SELECT 1 FROM app.reward_roles(unit.id))THEN RETURN NULL;END IF;
 SELECT count(*)::integer,count(*)FILTER(WHERE e.facts->>'reviewed'='true')::integer INTO people,verified FROM public.reward_entry e WHERE e.unit_id=unit.id AND e.tenant_id=unit.tenant_id;
 RETURN jsonb_build_object('people',people,'verified',verified);
END $$;
REVOKE ALL ON FUNCTION app.reward_unit_verification_counts(uuid)FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
-- A distinct pay-free GR membership screen. It does not load the private monetary kernel,
-- governance inputs, recommendations or awards. Own-person exclusion derives actual immutable
-- employment/person identity, not a posted JSON replacement. No new app ACL until reviewed.
CREATE FUNCTION app.reward_senior_membership_metadata(p_unit uuid)RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE unit public.reward_unit;actor public.app_user;roles text[];rows jsonb;
BEGIN
 IF NOT app.principal_snapshot_current()OR app.current_user_id()IS NULL THEN RAISE EXCEPTION 'Reward unit not found or access has been removed.' USING ERRCODE='42501';END IF;
 SELECT u.* INTO actor FROM public.app_user u WHERE u.id=app.current_user_id()AND u.tenant_id=app.current_tenant_id()AND u.archived_at IS NULL AND NOT app.login_blocked(u.id);
 roles:=ARRAY(SELECT app.reward_roles(p_unit));
 SELECT u.* INTO unit FROM public.reward_unit u WHERE u.id=p_unit AND u.tenant_id=app.current_tenant_id()AND u.deleted_at IS NULL AND(u.created_by=app.current_user_id()OR app.reward_admin(u.company_id)OR cardinality(roles)>0);
 IF actor.id IS NULL OR unit.id IS NULL THEN RAISE EXCEPTION 'Reward unit not found or access has been removed.' USING ERRCODE='42501';END IF;
 IF cardinality(roles)=0 THEN RAISE EXCEPTION 'Ask an administrator to assign your Reward Desk role for this unit.' USING ERRCODE='42501';END IF;
 IF NOT('gr'=ANY(roles))THEN RAISE EXCEPTION 'Group Rewards membership access is required.' USING ERRCODE='42501';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('employmentId',e.employment_id,'name',e.source->'name','employeeCode',e.source->'employeeCode','member',app.reward_calc_senior(unit.policy,jsonb_build_object('source',e.source,'facts',e.facts)),'eligible',app.reward_calc_senior_grade(e.source->>'grade'),'grade',e.source->'grade')ORDER BY e.id),'[]'::jsonb)INTO rows
 FROM public.reward_entry e JOIN public.employment actual ON actual.id=e.employment_id AND actual.tenant_id=e.tenant_id WHERE e.unit_id=unit.id AND e.tenant_id=unit.tenant_id AND actual.person_id IS DISTINCT FROM actor.person_id;
 RETURN jsonb_build_object('unitId',unit.id,'revision',unit.revision,'canEdit',unit.kind='annual'AND unit.status='draft','mode',coalesce(unit.policy->>'seniorMembershipMode','legacy-grades'),'rows',rows);
END $$;
REVOKE ALL ON FUNCTION app.reward_senior_membership_metadata(uuid)FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
-- Exact selected Senior evidence only. Private pending reviewed read ACL; callers never
-- receive the entry/source/recommendation, other attachments or a general personnel grant.
CREATE FUNCTION app.reward_senior_evidence_read(p_unit uuid,p_evidence uuid)RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE unit public.reward_unit;actor public.app_user;roles text[];result jsonb;
BEGIN
 IF NOT app.principal_snapshot_current()OR app.current_user_id()IS NULL THEN RAISE EXCEPTION 'Reward unit not found or access has been removed.' USING ERRCODE='42501';END IF;
 SELECT u.* INTO actor FROM public.app_user u WHERE u.id=app.current_user_id()AND u.tenant_id=app.current_tenant_id()AND u.archived_at IS NULL AND NOT app.login_blocked(u.id);
 roles:=ARRAY(SELECT app.reward_roles(p_unit));
 SELECT u.* INTO unit FROM public.reward_unit u WHERE u.id=p_unit AND u.tenant_id=app.current_tenant_id()AND u.deleted_at IS NULL AND(u.created_by=app.current_user_id()OR app.reward_admin(u.company_id)OR cardinality(roles)>0);
 IF actor.id IS NULL OR unit.id IS NULL THEN RAISE EXCEPTION 'Reward unit not found or access has been removed.' USING ERRCODE='42501';END IF;
 IF cardinality(roles)=0 THEN RAISE EXCEPTION 'Ask an administrator to assign your Reward Desk role for this unit.' USING ERRCODE='42501';END IF;
 IF NOT(roles&&ARRAY['gr','ctro','ec'])THEN RAISE EXCEPTION 'Senior plan evidence is restricted.' USING ERRCODE='42501';END IF;
 SELECT jsonb_build_object('name',f.name,'mime',f.mime,'content',f.content)INTO result FROM public.reward_senior_evidence f
 JOIN public.reward_entry e ON e.id=f.entry_id AND e.unit_id=f.unit_id AND e.tenant_id=f.tenant_id
 JOIN public.employment actual ON actual.id=e.employment_id AND actual.tenant_id=e.tenant_id
 WHERE f.id=p_evidence AND f.unit_id=unit.id AND f.tenant_id=unit.tenant_id AND actual.person_id IS DISTINCT FROM actor.person_id AND(e.facts->>'reviewed'='true'OR'gr'=ANY(roles));
 IF result IS NULL THEN RAISE EXCEPTION 'Evidence is not available.' USING ERRCODE='42501';END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.reward_senior_evidence_read(uuid,uuid)FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
-- Pure target-user defaults must use the same native membership windows, restoration source
-- fingerprint, notice/BU eligibility and login rules as reward_roles, without borrowing the
-- current caller's tenant/claims. Copy exact actual native bodies, refusing unexpected ambient
-- dependencies; originals and their custody/ACL remain unchanged.
DO $$
DECLARE spec record;definition text;body text;expected_calls text[];actual_calls text[];header text;replacement text;
BEGIN
 FOR spec IN SELECT * FROM(VALUES
  ('reward_member_people_fingerprint','uuid,uuid','rewards_member_fingerprint_for_tenant','p_tenant uuid, ',ARRAY['current_tenant_id']::text[]),
  ('reward_member_state','uuid','rewards_member_state_for_tenant','p_tenant uuid, ',ARRAY['current_tenant_id','login_blocked_on','reward_member_people_fingerprint']::text[]),
  ('reward_roles','uuid','rewards_roles_for_tenant','p_tenant uuid, p_user uuid, ',ARRAY['current_tenant_id','current_user_id','reward_member_eligible_internal']::text[])
 )sources(name,args,target,parameters,calls)LOOP
  SELECT p.prosrc INTO body FROM pg_proc p WHERE p.oid=to_regprocedure('app.'||spec.name||'('||spec.args||')')AND p.prosecdef AND p.provolatile='s';
  IF body IS NULL THEN RAISE EXCEPTION 'Native Rewards eligibility owner unavailable: %',spec.name;END IF;
  SELECT array_agg(DISTINCT dependency_match[1]ORDER BY dependency_match[1])INTO actual_calls FROM regexp_matches(body,'app[.]([A-Za-z_][A-Za-z0-9_]*)[(]','g')dependency_match;
  IF actual_calls IS DISTINCT FROM spec.calls OR(length(body)-length(replace(body,'app.current_tenant_id()','')))/length('app.current_tenant_id()')<>1 THEN RAISE EXCEPTION 'Native Rewards eligibility dependencies changed: %',spec.name;END IF;
  definition:=pg_get_functiondef(to_regprocedure('app.'||spec.name||'('||spec.args||')'));
  header:='FUNCTION app.'||spec.name||'(';replacement:='FUNCTION app.'||spec.target||'('||spec.parameters;
  IF strpos(definition,header)=0 THEN RAISE EXCEPTION 'Native Rewards eligibility header changed: %',spec.name;END IF;
  definition:=replace(replace(definition,header,replacement),'app.current_tenant_id()','p_tenant');
  IF spec.name='reward_member_state'THEN
   IF strpos(definition,'app.reward_member_people_fingerprint(m.user_id,m.unit_id)')=0 THEN RAISE EXCEPTION 'Native Rewards restore source changed';END IF;
   definition:=replace(definition,'app.reward_member_people_fingerprint(m.user_id,m.unit_id)','app.rewards_member_fingerprint_for_tenant(p_tenant,m.user_id,m.unit_id)');
  ELSIF spec.name='reward_roles'THEN
   IF strpos(definition,'app.reward_member_eligible_internal(m.id)')=0 OR(length(body)-length(replace(body,'app.current_user_id()','')))/length('app.current_user_id()')<>1 THEN RAISE EXCEPTION 'Native Rewards role source changed';END IF;
   definition:=replace(replace(definition,'app.current_user_id()','p_user'),'app.reward_member_eligible_internal(m.id)','app.rewards_member_state_for_tenant(p_tenant,m.id)IS NULL');
  END IF;
  EXECUTE definition;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION app.rewards_member_fingerprint_for_tenant(uuid,uuid,uuid),app.rewards_member_state_for_tenant(uuid,uuid),app.rewards_roles_for_tenant(uuid,uuid,uuid)FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.rewards_function_legacy_allowed(t uuid,u uuid,cap text,co uuid)RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE key text:=substring(cap FROM '^function[.](.+)[.][^.]+$');operation text:=substring(cap FROM '[^.]+$');unit public.reward_unit;roles text[];command text;route jsonb;entries jsonb;next_stage text;
BEGIN
 IF co IS NULL OR cap IS NULL OR cap<>'function.'||key||'.'||operation OR NOT EXISTS(SELECT 1 FROM public.company c WHERE c.id=co AND c.tenant_id=t)OR NOT EXISTS(SELECT 1 FROM public.app_user a WHERE a.id=u AND a.tenant_id=t AND a.archived_at IS NULL AND NOT app.login_blocked(a.id))THEN RETURN false;END IF;
 IF key IN('rewards.review','rewards.configuration.assigned','rewards.configuration.administration')THEN IF operation<>'view'THEN RETURN false;END IF;
 ELSIF key IN('rewards.posting','rewards.cancellation.assigned','rewards.cancellation.administration')THEN IF operation NOT IN('view','execute')THEN RETURN false;END IF;
 ELSIF key IN('rewards.decisions.submit','rewards.decisions.approve','rewards.decisions.return','rewards.decisions.reject','rewards.decisions.withdraw')THEN
  command:=substring(key FROM '[^.]+$');IF operation<>'view'AND operation<>(CASE WHEN command='approve'THEN'approve'ELSE'execute'END)THEN RETURN false;END IF;
 ELSE RETURN false;END IF;
 FOR unit IN SELECT r.* FROM public.reward_unit r WHERE r.tenant_id=t AND r.company_id=co AND r.deleted_at IS NULL LOOP
  roles:=ARRAY(SELECT app.rewards_roles_for_tenant(t,u,unit.id));
  IF key IN('rewards.configuration.administration','rewards.cancellation.administration')THEN
   IF(key<>'rewards.cancellation.administration'OR operation='view'OR unit.status NOT IN('posted','withdrawn','rejected'))AND EXISTS(SELECT 1 FROM public.role_assignment r WHERE r.tenant_id=t AND r.app_user_id=u AND r.role::text IN('hr_admin','super_admin')AND app.access_scope_covers(r.company_id,co,t))THEN RETURN true;END IF;
   CONTINUE;
  END IF;
  IF cardinality(roles)=0 THEN CONTINUE;END IF;
  IF key='rewards.configuration.assigned'THEN
   IF'gr'=ANY(roles)THEN RETURN true;END IF;
  ELSIF key='rewards.cancellation.assigned'THEN
   IF'gr'=ANY(roles)AND(operation='view'OR unit.status NOT IN('posted','withdrawn','rejected'))THEN RETURN true;END IF;
  ELSIF key='rewards.posting'THEN
   IF'payroll'=ANY(roles)AND EXISTS(SELECT 1 FROM public.role_assignment r WHERE r.tenant_id=t AND r.app_user_id=u AND r.role::text IN('hr_admin','super_admin')AND app.access_scope_covers(r.company_id,co,t))THEN RETURN true;END IF;
  ELSIF operation='view'THEN RETURN true;
  ELSE
   route:='["bu","bg","gr","ctro","ec"]'::jsonb;
   IF unit.kind<>'annual'THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('source',jsonb_build_object('grade',e.source->'grade'),'recommendation',jsonb_build_object('promotionGrade',e.recommendation->'promotionGrade'),'facts',jsonb_build_object('confidentiality',e.facts->'confidentiality'))),'[]'::jsonb)INTO entries FROM public.reward_entry e WHERE e.unit_id=unit.id AND e.tenant_id=t;
    route:=app.reward_calc_offcycle_route(unit.kind,unit.offcycle,entries);
   END IF;
   BEGIN next_stage:=app.reward_calc_transition(unit.kind,unit.status,roles,command,route);RETURN next_stage IS NOT NULL;EXCEPTION WHEN SQLSTATE '42501' THEN CONTINUE;END;
  END IF;
 END LOOP;
 RETURN false;
END $$;
CREATE FUNCTION app.rewards_function_current_legacy_allowed(t uuid,u uuid,cap text,co uuid)RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT co IS NOT NULL AND t=app.current_tenant_id()AND u=app.current_user_id()AND app.principal_snapshot_current()
 AND app.rewards_function_legacy_allowed(t,u,cap,co)
 AND CASE WHEN cap IN('function.rewards.posting.view','function.rewards.posting.execute','function.rewards.configuration.administration.view','function.rewards.cancellation.administration.view','function.rewards.cancellation.administration.execute')THEN app.reward_admin(co)ELSE true END;
$$;
REVOKE ALL ON FUNCTION app.rewards_function_legacy_allowed(uuid,uuid,text,uuid),app.rewards_function_current_legacy_allowed(uuid,uuid,text,uuid)FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
-- Registration is a code-owned definition, not supported publication. Exact native default
-- dispatch and restricted publisher wiring are separately reviewed. No family sentinel exists.
DO $$ DECLARE item record;operation text;metadata jsonb;BEGIN
 FOR item IN SELECT * FROM(VALUES
  ('rewards.review','nav.rewards','screen',false,ARRAY['view']::text[]),
  ('rewards.decisions.submit','rewards.submit','native_acl',false,ARRAY['view','execute']::text[]),
  ('rewards.decisions.approve','rewards.approve','native_acl',false,ARRAY['view','approve']::text[]),
  ('rewards.decisions.return','rewards.return','native_acl',false,ARRAY['view','execute']::text[]),
  ('rewards.decisions.reject','rewards.reject','native_acl',false,ARRAY['view','execute']::text[]),
  ('rewards.decisions.withdraw','rewards.withdraw','native_acl',false,ARRAY['view','execute']::text[]),
  ('rewards.posting','rewards.post','native_acl',true,ARRAY['view','execute']::text[])
 )definitions(key,label,kind,employee_bearing,operations)LOOP
  metadata:=jsonb_build_object('moduleKey','rewards','labelKey',item.label,'kind',item.kind,'course','assigned','screenKey','rewards','href','/rewards','employeeBearing',item.employee_bearing);
  FOREACH operation IN ARRAY item.operations LOOP PERFORM app.register_function_action(item.key,operation,'company',NULL,'app.rewards_function_legacy_allowed',metadata);END LOOP;
 END LOOP;
END $$;
-- Actual bounded production front doors. ACL activation and service cutover remain a separate
-- held patch until default wiring and the complete transaction/audit contract are reviewed.
CREATE FUNCTION app.reward_decision_command(p_unit uuid,p_revision integer,p_command text,p_reason text,p_acknowledged boolean DEFAULT false)RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 RETURN app.reward_decision_native(p_unit,p_revision,p_command,p_reason,p_acknowledged);
END $$;
CREATE FUNCTION app.reward_post_command(p_unit uuid,p_revision integer,p_batch uuid DEFAULT NULL)RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF nullif(current_setting('app.agent_principal_id',true),'')IS NOT NULL THEN RAISE EXCEPTION 'A current human Rewards principal is required' USING ERRCODE='42501';END IF;
 IF app.current_agent_principal()IS NOT NULL OR NOT app.principal_snapshot_current()OR app.current_user_id()IS NULL THEN RAISE EXCEPTION 'A current human Rewards principal is required' USING ERRCODE='42501';END IF;
 RETURN app.reward_post_native(p_unit,p_revision,p_batch);
END $$;
REVOKE ALL ON FUNCTION app.reward_decision_command(uuid,integer,text,text,boolean),app.reward_post_command(uuid,integer,uuid)FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
-- Native governance review projection. The private monetary/source roster never crosses this
-- boundary. Audit actor names remain an INVOKER person-reader concern, not a definer disclosure.
CREATE FUNCTION app.reward_governance_history_visible(p_state jsonb,p_entries uuid[],p_employments uuid[])RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb:=p_state;selected jsonb;awards jsonb;
BEGIN
 IF p_state IS NULL OR p_state='null'::jsonb THEN RETURN NULL;END IF;
 IF jsonb_typeof(p_state)<>'object'THEN RAISE EXCEPTION 'Invalid Reward governance history' USING ERRCODE='22023';END IF;
 IF p_state->'selection'IS NOT NULL AND p_state->'selection'<>'null'::jsonb THEN
  SELECT coalesce(jsonb_agg(value ORDER BY n),'[]'::jsonb)INTO selected FROM jsonb_array_elements(p_state->'selection'->'employmentIds')WITH ORDINALITY ids(value,n)WHERE value#>>'{}'=ANY(ARRAY(SELECT id::text FROM unnest(p_employments)id));
  result:=jsonb_set(result,'{selection,employmentIds}',selected);
 ELSE result:=result||jsonb_build_object('selection',NULL);END IF;
 SELECT coalesce(jsonb_object_agg(key,value),'{}'::jsonb)INTO awards FROM jsonb_each(coalesce(nullif(p_state->'awards','null'::jsonb),'{}'::jsonb))WHERE key=ANY(ARRAY(SELECT id::text FROM unnest(p_entries)id));
 RETURN result||jsonb_build_object('awards',awards);
END $$;
CREATE FUNCTION app.reward_governance_review(p_unit uuid)RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE unit public.reward_unit;actor public.app_user;roles text[];is_gr boolean;can_amounts boolean;state jsonb;public_state jsonb;calculation jsonb;entries jsonb;route_funding jsonb;senior jsonb:='[]';history jsonb:='[]';branches jsonb:='[]';visible_ids uuid[]:='{}';visible_employments uuid[]:='{}';item record;award jsonb;senior_count integer:=0;increment_total double precision:=0;bonus_total double precision:=0;effective_multiplier jsonb;
BEGIN
 IF NOT app.principal_snapshot_current()OR app.current_user_id()IS NULL THEN RAISE EXCEPTION 'Reward unit not found or access has been removed.' USING ERRCODE='42501';END IF;
 SELECT u.* INTO actor FROM public.app_user u WHERE u.id=app.current_user_id()AND u.tenant_id=app.current_tenant_id()AND u.archived_at IS NULL AND NOT app.login_blocked(u.id);
 SELECT u.* INTO unit FROM public.reward_unit u WHERE u.id=p_unit AND u.tenant_id=app.current_tenant_id()AND u.deleted_at IS NULL AND app.reward_unit_native_readable(u.id);
 roles:=ARRAY(SELECT app.reward_roles(p_unit));
 IF actor.id IS NULL OR unit.id IS NULL THEN RAISE EXCEPTION 'Reward unit not found or access has been removed.' USING ERRCODE='42501';END IF;
 IF cardinality(roles)=0 THEN RAISE EXCEPTION 'Ask an administrator to assign your Reward Desk role for this unit.' USING ERRCODE='42501';END IF;
 IF app.function_action_allowed('rewards.review','view',unit.company_id)IS NOT TRUE THEN RAISE EXCEPTION 'Reward review function unavailable' USING ERRCODE='42501';END IF;
 IF NOT app.reward_calc_source_identity_current(unit.id,unit.tenant_id)THEN RAISE EXCEPTION 'Reward recipient source unavailable' USING ERRCODE='42501';END IF;
 is_gr:='gr'=ANY(roles);can_amounts:=roles&&ARRAY['gr','ctro','ec'];
 IF is_gr THEN SELECT g.state INTO state FROM public.reward_governance g WHERE g.unit_id=unit.id AND g.tenant_id=unit.tenant_id;END IF;
 SELECT g.snapshot INTO public_state FROM public.reward_governance_public g WHERE g.unit_id=unit.id AND g.tenant_id=unit.tenant_id;
 IF unit.kind='annual'THEN calculation:=app.reward_calc_annual_unit(unit.id,unit.revision);ELSE
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',e.id,'source',e.source,'facts',e.facts,'recommendation',e.recommendation)ORDER BY e.id),'[]'::jsonb)INTO entries FROM public.reward_entry e WHERE e.unit_id=unit.id AND e.tenant_id=unit.tenant_id;
  route_funding:=app.reward_funding(unit.id,false);calculation:=app.reward_calc_offcycle(entries,unit.kind,unit.offcycle,route_funding);
 END IF;
 FOR item IN SELECT e.id,e.employment_id,e.source,e.facts FROM public.reward_entry e JOIN public.employment actual ON actual.id=e.employment_id AND actual.tenant_id=e.tenant_id
 WHERE e.unit_id=unit.id AND e.tenant_id=unit.tenant_id AND actual.person_id IS DISTINCT FROM actor.person_id AND app.reward_calc_entry_visible(jsonb_build_object('source',e.source,'facts',e.facts),roles,actor.person_id)ORDER BY e.id LOOP
  visible_ids:=array_append(visible_ids,item.id);visible_employments:=array_append(visible_employments,item.employment_id);
  IF NOT app.reward_calc_senior(unit.policy,jsonb_build_object('source',item.source,'facts',item.facts))THEN CONTINUE;END IF;
  award:=NULL;IF can_amounts THEN SELECT a.award INTO award FROM public.reward_senior_award a WHERE a.unit_id=unit.id AND a.tenant_id=unit.tenant_id AND a.entry_id=item.id;END IF;
  senior:=senior||jsonb_build_array(jsonb_build_object('entryId',item.id,'employmentId',item.employment_id,'name',item.source->'name','employeeCode',item.source->'employeeCode','grade',item.source->'grade','basicCents',CASE WHEN can_amounts THEN item.source->'basicCents'ELSE NULL END,'award',CASE WHEN can_amounts THEN award ELSE NULL END,'awaiting',coalesce(award->>'confirmedBy','')=''));
  senior_count:=senior_count+1;
  IF can_amounts AND coalesce(award->>'confirmedBy','')<>''THEN
   increment_total:=increment_total+greatest(0::double precision,(award->>'newBasicCents')::double precision-(item.source->>'basicCents')::double precision);bonus_total:=bonus_total+(award->>'bonusCents')::double precision;
  END IF;
 END LOOP;
 IF is_gr THEN
  SELECT coalesce(jsonb_agg(branch ORDER BY branch COLLATE"C"),'[]'::jsonb)INTO branches FROM(SELECT DISTINCT e.facts->>'branch'AS branch FROM public.reward_entry e WHERE e.unit_id=unit.id AND e.tenant_id=unit.tenant_id AND coalesce(e.facts->>'branch','')<>'')b;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',h.id,'kind',h.kind,'reason',h.reason,'actorId',h.actor_id,'createdAt',h.created_at,'before',app.reward_governance_history_visible(h.before_state,visible_ids,visible_employments),'after',app.reward_governance_history_visible(h.after_state,visible_ids,visible_employments))ORDER BY h.created_at DESC,h.id DESC),'[]'::jsonb)INTO history FROM public.reward_governance_history h WHERE h.unit_id=unit.id AND h.tenant_id=unit.tenant_id;
 END IF;
 effective_multiplier:=CASE WHEN unit.policy->>'bonusStructure'='branch'THEN'10000'::jsonb ELSE unit.policy->'multiplierBp'END;
 RETURN jsonb_build_object('unitId',unit.id,'revision',unit.revision,'canEdit',is_gr AND unit.status='draft'AND unit.kind='annual','isGr',is_gr,'canAmounts',can_amounts,'managed',public_state IS NOT NULL,'available',true,
 'legacyInputs',CASE WHEN is_gr THEN jsonb_build_object('forecastCents',NULL,'actualCents',unit.policy->'patActual','targetCents',unit.policy->'patTarget','targetMonthsBp',unit.policy->'targetMonthsBp','multiplierBp',effective_multiplier,'branchRatings',unit.policy->'branchRatings')ELSE NULL END,
 'poolStatus',coalesce(public_state->>'status','legacy'),'inputs',CASE WHEN is_gr THEN state->'inputs'ELSE NULL END,'selection',CASE WHEN is_gr THEN state->'selection'ELSE NULL END,'exemption',CASE WHEN is_gr THEN state->'exemption'ELSE NULL END,'previousPools',public_state->'previousPools',
 'pools',jsonb_build_object('standard',calculation->'budgets'->'standard'->'bonusPoolCents','h',calculation->'budgets'->'h'->'bonusPoolCents'),'branches',branches,'senior',senior,'totals',CASE WHEN can_amounts THEN jsonb_build_object('count',senior_count,'incrementCents',increment_total,'bonusCents',bonus_total)ELSE NULL END,'history',history);
END $$;
REVOKE ALL ON FUNCTION app.reward_governance_history_visible(jsonb,uuid[],uuid[]),app.reward_governance_review(uuid)FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
-- Configuration metadata is a distinct native course: an actual Group Rewards assignee may
-- inspect its unit without borrowing company administration, while an unassigned administrator
-- remains subject to the existing administrative View ceiling. No employee/pay roster is read.
-- This private owner awaits exact configuration descriptors and independent consumer qualification.
CREATE FUNCTION app.reward_configuration_review(p_unit uuid)RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE unit public.reward_unit;actor public.app_user;roles text[];administrator boolean;is_gr boolean;state jsonb;policy jsonb;unit_projection jsonb;members jsonb;cycle jsonb;label text;
BEGIN
 IF NOT app.principal_snapshot_current()OR app.current_user_id()IS NULL THEN RAISE EXCEPTION 'Reward unit not found or access has been removed.' USING ERRCODE='42501';END IF;
 SELECT u.* INTO actor FROM public.app_user u WHERE u.id=app.current_user_id()AND u.tenant_id=app.current_tenant_id()AND u.archived_at IS NULL AND NOT app.login_blocked(u.id);
 SELECT u.* INTO unit FROM public.reward_unit u WHERE u.id=p_unit AND u.tenant_id=app.current_tenant_id()AND u.deleted_at IS NULL AND app.reward_unit_native_readable(u.id);
 IF actor.id IS NULL OR unit.id IS NULL THEN RAISE EXCEPTION 'Reward unit not found or access has been removed.' USING ERRCODE='42501';END IF;
 roles:=ARRAY(SELECT app.reward_roles(unit.id));administrator:=app.reward_admin(unit.company_id);is_gr:='gr'=ANY(roles);
 IF NOT administrator AND NOT is_gr THEN RAISE EXCEPTION 'Rewards configuration requires company administrator or Group Rewards access.' USING ERRCODE='42501';END IF;
 -- Eligibility selects the native course once. A denied assigned course cannot retry through HR.
 IF is_gr THEN
  IF app.function_action_allowed('rewards.configuration.assigned','view',unit.company_id)IS NOT TRUE THEN RAISE EXCEPTION 'Reward review function unavailable' USING ERRCODE='42501';END IF;
  SELECT g.state INTO state FROM public.reward_governance g WHERE g.unit_id=unit.id AND g.tenant_id=unit.tenant_id;
 ELSIF app.function_action_allowed('rewards.configuration.administration','view',unit.company_id)IS NOT TRUE OR app.lifecycle_reward_notice_action('rewards','view',unit.company_id)IS NOT TRUE THEN RAISE EXCEPTION 'Rewards configuration unavailable' USING ERRCODE='42501';END IF;
 policy:=app.reward_calc_effective_policy(unit.policy,state);
 IF NOT is_gr THEN policy:=policy||jsonb_build_object('patActual',0,'patTarget',100);END IF;
 -- An explicit field list prevents a future private unit column becoming public implicitly.
 unit_projection:=jsonb_build_object('deletedAt',unit.deleted_at,'deletedBy',unit.deleted_by,'kind',unit.kind,'parentUnitId',unit.parent_unit_id,'createdBy',unit.created_by,'offcycle',unit.offcycle,'fundingCents',unit.funding_cents,'reservedCents',unit.reserved_cents,'id',unit.id,'tenantId',unit.tenant_id,'cycleId',unit.cycle_id,'companyId',unit.company_id,'businessUnitId',unit.business_unit_id,'policy',policy,'policyGroupVersionId',unit.policy_group_version_id,'status',unit.status,'revision',unit.revision,'snapshotDate',unit.snapshot_date,'approvedDigest',unit.approved_digest,'postedBatchId',unit.posted_batch_id,'postedAt',unit.posted_at,'createdAt',unit.created_at,'updatedAt',unit.updated_at);
 SELECT jsonb_build_object('name',c.name,'year',c.year)INTO cycle FROM public.reward_cycle c WHERE c.id=unit.cycle_id AND c.tenant_id=unit.tenant_id;
 SELECT coalesce(nullif(trim(b.label),''),b.code)INTO label FROM public.business_unit b WHERE b.id=unit.business_unit_id AND b.tenant_id=unit.tenant_id;
 IF cycle IS NULL OR label IS NULL THEN RAISE EXCEPTION 'Rewards configuration unavailable' USING ERRCODE='42501';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',m.id,'userId',m.user_id,'role',m.role)ORDER BY m.role COLLATE"C",m.user_id),'[]'::jsonb)INTO members FROM public.reward_member m WHERE m.unit_id=unit.id AND m.tenant_id=unit.tenant_id;
 RETURN jsonb_build_object('unit',unit_projection,'cycle',cycle,'name',label,'members',members,'canReadPat',is_gr,'policyOrigin',app.reward_policy_unit_origin(unit.id),'canConfigure',is_gr AND unit.status='draft'AND unit.kind='annual','canManageMembers',administrator AND unit.status='draft');
END $$;
REVOKE ALL ON FUNCTION app.reward_configuration_review(uuid)FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
-- Distinct real configuration read purposes. They stay dormant and private; defining View
-- does not assert that policy/member mutation purposes are closed or publication is complete.
SELECT app.register_function_action('rewards.configuration.assigned','view','company',NULL,'app.rewards_function_legacy_allowed','{"moduleKey":"rewards","labelKey":"rewards.configuration","kind":"native_acl","course":"assigned","screenKey":"rewards","href":"/rewards","employeeBearing":false}'::jsonb);
SELECT app.register_function_action('rewards.configuration.administration','view','company','rewards.view','app.rewards_function_legacy_allowed','{"moduleKey":"rewards","labelKey":"rewards.configuration","kind":"native_acl","course":"administrative","screenKey":"rewardsAdmin","href":"/admin/rewards","employeeBearing":false}'::jsonb);

--> statement-breakpoint
-- Cancellation is the original actor-only unit course (0839), not an employee-data read.
-- No posted actor, event namespace, source rows, authority hint or monetary input is accepted.
CREATE FUNCTION app.reward_cancel_admission(p_unit uuid,p_revision integer,p_reason text)RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE unit public.reward_unit;actor public.app_user;roles text[];reason text;course text;key text;entries jsonb;decision_digest text;has_decision boolean;stamp text;
BEGIN
 IF nullif(current_setting('app.agent_principal_id',true),'')IS NOT NULL THEN RAISE EXCEPTION 'A current human Rewards principal is required' USING ERRCODE='42501';END IF;
 IF app.current_agent_principal()IS NOT NULL OR NOT app.principal_snapshot_current()OR app.current_user_id()IS NULL THEN RAISE EXCEPTION 'A current human Rewards principal is required' USING ERRCODE='42501';END IF;
 PERFORM app.audit_access_order_lock();PERFORM app.access_workforce_write_lock();PERFORM pg_advisory_xact_lock(hashtext('audit-chain:'||app.current_tenant_id()::text));
 reason:=app.reward_calc_text(to_jsonb(p_reason),4000);
 IF char_length(reason)<10 THEN RAISE EXCEPTION 'Explain why the review is being cancelled (at least 10 characters).' USING ERRCODE='42501';END IF;
 SELECT u.* INTO unit FROM public.reward_unit u WHERE u.id=p_unit AND u.tenant_id=app.current_tenant_id()AND u.deleted_at IS NULL AND app.reward_unit_native_readable(u.id) FOR UPDATE;
 SELECT u.* INTO actor FROM public.app_user u WHERE u.id=app.current_user_id()AND u.tenant_id=app.current_tenant_id()AND u.archived_at IS NULL AND NOT app.login_blocked(u.id);
 IF unit.id IS NULL OR actor.id IS NULL THEN RAISE EXCEPTION 'Reward unit not found or access has been removed.' USING ERRCODE='42501';END IF;
 roles:=ARRAY(SELECT app.reward_roles(unit.id));
 IF'gr'=ANY(roles)THEN course:='assigned';ELSIF app.reward_admin(unit.company_id)THEN course:='administration';ELSE RAISE EXCEPTION 'Only the company Rewards administrator or Group Rewards may cancel this review.' USING ERRCODE='42501';END IF;
 key:='rewards.cancellation.'||course;
 IF app.function_action_allowed(key,'execute',unit.company_id)IS NOT TRUE OR(course='administration'AND app.lifecycle_reward_notice_action('rewards','delete',unit.company_id)IS NOT TRUE)THEN RAISE EXCEPTION 'Reward cancellation function unavailable' USING ERRCODE='42501';END IF;
 IF unit.revision IS DISTINCT FROM p_revision THEN RAISE EXCEPTION 'This review changed in another session. Reload before saving.' USING ERRCODE='40001';END IF;
 IF unit.status IN('posted','withdrawn','rejected')THEN RAISE EXCEPTION 'This review can no longer be cancelled.' USING ERRCODE='42501';END IF;
 IF unit.parent_unit_id IS NOT NULL THEN PERFORM 1 FROM public.reward_unit parent WHERE parent.id=unit.parent_unit_id AND parent.tenant_id=unit.tenant_id FOR UPDATE;END IF;
 has_decision:=EXISTS(SELECT 1 FROM unnest(roles)r WHERE r<>'pbp');
 IF has_decision THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',e.id,'source',e.source,'facts',e.facts,'recommendation',e.recommendation)ORDER BY e.id),'[]'::jsonb)INTO entries FROM public.reward_entry e WHERE e.unit_id=unit.id AND e.tenant_id=unit.tenant_id;
  decision_digest:=app.reward_calc_decision_digest(unit.policy,unit.kind,unit.parent_unit_id,unit.offcycle,entries);
 END IF;
 stamp:=app.access_function_authority_stamp();IF stamp IS NULL THEN RAISE EXCEPTION 'Reward cancellation authority unavailable' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('tenantId',unit.tenant_id,'userId',actor.id,'unitId',unit.id,'companyId',unit.company_id,'unitBefore',to_jsonb(unit),'unitBeforeHash',app.reward_decision_row_hash(to_jsonb(unit),'reward_unit'),'reason',reason,'revision',unit.revision,'fromStage',unit.status,'course',course,'functionKey',key,'positiveAdmission',true,'authorityStamp',stamp,'hasDecision',has_decision,'decisionDigest',decision_digest);
END $$;
REVOKE ALL ON FUNCTION app.reward_cancel_admission(uuid,integer,text)FROM PUBLIC,ai_hr_app;
CREATE TABLE app.reward_cancel_native_effect(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),xact_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,unit_id uuid NOT NULL,
 admission jsonb NOT NULL,unit_after jsonb,decision_id uuid,decision_after jsonb,event_id uuid NOT NULL,event_after jsonb,
 active boolean NOT NULL DEFAULT true,completed boolean NOT NULL DEFAULT false,recheck bigint NOT NULL DEFAULT 0
);
CREATE TABLE app.reward_cancel_native_receipt(
 effect_id uuid NOT NULL REFERENCES app.reward_cancel_native_effect(id)ON DELETE CASCADE,table_name text NOT NULL,row_id uuid NOT NULL,before_hash text NOT NULL,after_hash text NOT NULL,
 PRIMARY KEY(effect_id,table_name,row_id,before_hash,after_hash)
);
ALTER TABLE app.reward_cancel_native_effect ENABLE ROW LEVEL SECURITY;ALTER TABLE app.reward_cancel_native_receipt ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.reward_cancel_native_effect,app.reward_cancel_native_receipt FROM PUBLIC,ai_hr_app;
CREATE INDEX reward_cancel_native_current_idx ON app.reward_cancel_native_effect(xact_id,tenant_id,user_id,unit_id);
CREATE FUNCTION app.reward_cancel_native_capture()RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE previous jsonb:=CASE WHEN TG_OP='INSERT'THEN'{}'::jsonb ELSE to_jsonb(OLD)END;following jsonb:=to_jsonb(NEW);proof uuid;
BEGIN
 IF TG_TABLE_NAME NOT IN('reward_unit','reward_decision')THEN RAISE EXCEPTION 'Invalid Reward cancellation receipt' USING ERRCODE='42501';END IF;
 SELECT e.id INTO proof FROM app.reward_cancel_native_effect e WHERE e.xact_id=pg_current_xact_id()AND e.tenant_id=app.current_tenant_id()AND e.user_id=app.current_user_id()AND e.active AND NOT e.completed
 AND(TG_TABLE_NAME='reward_unit'AND e.unit_id=NEW.id OR TG_TABLE_NAME='reward_decision'AND e.decision_id=NEW.id);
 IF proof IS NOT NULL THEN INSERT INTO app.reward_cancel_native_receipt VALUES(proof,TG_TABLE_NAME,NEW.id,app.reward_decision_row_hash(previous,TG_TABLE_NAME),app.reward_decision_row_hash(following,TG_TABLE_NAME))ON CONFLICT DO NOTHING;END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.reward_cancel_native_capture()FROM PUBLIC,ai_hr_app;
CREATE TRIGGER rewards_cancel_native_capture AFTER UPDATE ON public.reward_unit FOR EACH ROW EXECUTE FUNCTION app.reward_cancel_native_capture();
CREATE TRIGGER rewards_cancel_native_capture AFTER INSERT ON public.reward_decision FOR EACH ROW EXECUTE FUNCTION app.reward_cancel_native_capture();
CREATE FUNCTION app.reward_cancel_native_validate()RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE proof app.reward_cancel_native_effect;unit public.reward_unit;roles text[];before_image jsonb;after_image jsonb;expected_payload jsonb;
BEGIN
 SELECT e.* INTO proof FROM app.reward_cancel_native_effect e WHERE e.id=NEW.id;IF proof.id IS NULL THEN RETURN NULL;END IF;
 IF proof.active OR NOT proof.completed OR nullif(current_setting('app.agent_principal_id',true),'')IS NOT NULL OR app.current_agent_principal()IS NOT NULL OR NOT app.principal_snapshot_current()OR proof.xact_id<>pg_current_xact_id()OR proof.tenant_id IS DISTINCT FROM app.current_tenant_id()OR proof.user_id IS DISTINCT FROM app.current_user_id()OR proof.admission->>'authorityStamp'IS DISTINCT FROM app.access_function_authority_stamp()OR NOT EXISTS(SELECT 1 FROM public.app_user actor WHERE actor.id=proof.user_id AND actor.tenant_id=proof.tenant_id AND actor.archived_at IS NULL AND NOT app.login_blocked(actor.id))THEN RAISE EXCEPTION 'Reward cancellation authority changed' USING ERRCODE='42501';END IF;
 SELECT u.* INTO unit FROM public.reward_unit u WHERE u.id=proof.unit_id AND u.tenant_id=proof.tenant_id AND u.company_id::text=proof.admission->>'companyId'AND u.deleted_at IS NULL;
 IF unit.id IS NULL OR proof.admission->>'tenantId'IS DISTINCT FROM proof.tenant_id::text OR proof.admission->>'userId'IS DISTINCT FROM proof.user_id::text OR proof.admission->>'unitId'IS DISTINCT FROM proof.unit_id::text OR proof.admission->'positiveAdmission'IS DISTINCT FROM'true'::jsonb OR proof.admission->>'course'NOT IN('assigned','administration')OR proof.admission->>'functionKey'IS DISTINCT FROM('rewards.cancellation.'||(proof.admission->>'course'))OR app.function_action_denial_clear(proof.admission->>'functionKey','execute',unit.company_id)IS NOT TRUE THEN RAISE EXCEPTION 'Reward cancellation authority changed' USING ERRCODE='42501';END IF;
 roles:=ARRAY(SELECT app.reward_roles(unit.id));
 IF(proof.admission->>'course'='assigned'AND NOT('gr'=ANY(roles)))OR(proof.admission->>'course'='administration'AND(app.reward_admin(unit.company_id)IS NOT TRUE OR app.lifecycle_reward_notice_action('rewards','delete',unit.company_id)IS NOT TRUE))THEN RAISE EXCEPTION 'Reward cancellation authority changed' USING ERRCODE='42501';END IF;
 before_image:=proof.admission->'unitBefore';after_image:=proof.unit_after;
 IF before_image->>'status'IN('posted','withdrawn','rejected')OR after_image IS NULL OR app.reward_decision_row_hash(before_image,'reward_unit')IS DISTINCT FROM proof.admission->>'unitBeforeHash'OR app.reward_decision_row_hash(to_jsonb(unit),'reward_unit')IS DISTINCT FROM app.reward_decision_row_hash(after_image,'reward_unit')OR after_image-ARRAY['status','approved_digest','revision','updated_at']IS DISTINCT FROM before_image-ARRAY['status','approved_digest','revision','updated_at']OR after_image->>'status'<>'withdrawn'OR after_image->'approved_digest'IS DISTINCT FROM'null'::jsonb OR(after_image->>'revision')::integer<>(before_image->>'revision')::integer+1
 OR NOT EXISTS(SELECT 1 FROM app.reward_cancel_native_receipt r WHERE r.effect_id=proof.id AND r.table_name='reward_unit'AND r.row_id=unit.id AND r.before_hash=proof.admission->>'unitBeforeHash'AND r.after_hash=app.reward_decision_row_hash(after_image,'reward_unit'))THEN RAISE EXCEPTION 'Reward cancellation unit effect unavailable' USING ERRCODE='42501';END IF;
 IF proof.admission->'hasDecision'='true'::jsonb THEN
  IF NOT EXISTS(SELECT 1 FROM unnest(roles)r WHERE r<>'pbp')OR NOT EXISTS(SELECT 1 FROM public.reward_decision d JOIN app.reward_cancel_native_receipt r ON r.effect_id=proof.id AND r.table_name='reward_decision'AND r.row_id=d.id AND r.before_hash=encode(sha256(convert_to('{}','UTF8')),'hex')AND r.after_hash=app.reward_decision_row_hash(to_jsonb(d),'reward_decision')WHERE d.id=proof.decision_id AND d.tenant_id=proof.tenant_id AND d.unit_id=unit.id AND d.actor_id=proof.user_id AND d.revision=(proof.admission->>'revision')::integer AND d.action='withdraw'AND d.from_stage=proof.admission->>'fromStage'AND d.to_stage='withdrawn'AND d.reason=proof.admission->>'reason'AND d.digest=proof.admission->>'decisionDigest'AND app.reward_decision_row_hash(to_jsonb(d),'reward_decision')=app.reward_decision_row_hash(proof.decision_after,'reward_decision'))THEN RAISE EXCEPTION 'Reward cancellation decision effect unavailable' USING ERRCODE='42501';END IF;
 ELSIF proof.decision_id IS NOT NULL OR proof.decision_after IS NOT NULL THEN RAISE EXCEPTION 'Unexpected Reward cancellation decision' USING ERRCODE='42501';END IF;
 expected_payload:=jsonb_build_object('cancelRowHash',encode(sha256(convert_to(after_image::text,'UTF8')),'hex'),'fromStage',proof.admission->'fromStage','reason',proof.admission->'reason','revision',proof.admission->'revision','before',jsonb_build_object('status',proof.admission->'fromStage','revision',proof.admission->'revision'),'after',jsonb_build_object('status','withdrawn','revision',(proof.admission->>'revision')::integer+1));
 IF NOT EXISTS(SELECT 1 FROM public.domain_event audit WHERE audit.id=proof.event_id AND audit.tenant_id=proof.tenant_id AND audit.aggregate_type='reward-unit'AND audit.aggregate_id=unit.id AND audit.event_type='reward-unit.cancelled'AND audit.actor_type='user'AND audit.actor_id=proof.user_id AND audit.subject_employment_id IS NULL AND audit.payload=expected_payload AND app.reward_decision_row_hash(to_jsonb(audit),'domain_event')=app.reward_decision_row_hash(proof.event_after,'domain_event')AND EXISTS(SELECT 1 FROM app.lifecycle_row_transaction_receipt birth WHERE birth.xact_id=proof.xact_id AND birth.tenant_id=proof.tenant_id AND birth.user_id=proof.user_id AND birth.table_name='domain_event'AND birth.row_id=audit.id))THEN RAISE EXCEPTION 'Reward cancellation audit unavailable' USING ERRCODE='42501';END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.reward_cancel_native_validate()FROM PUBLIC,ai_hr_app;
CREATE CONSTRAINT TRIGGER rewards_cancel_native_effect AFTER UPDATE ON app.reward_cancel_native_effect DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.completed AND NOT NEW.active)EXECUTE FUNCTION app.reward_cancel_native_validate();
CREATE FUNCTION app.reward_cancel_authority_changed()RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 UPDATE app.reward_cancel_native_effect e SET recheck=e.recheck+1 WHERE e.xact_id=pg_current_xact_id()AND e.tenant_id=NEW.tenant_id AND e.completed AND NOT e.active;RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.reward_cancel_authority_changed()FROM PUBLIC,ai_hr_app;
CREATE TRIGGER rewards_cancel_authority_recheck AFTER UPDATE ON app.access_control_epoch FOR EACH ROW EXECUTE FUNCTION app.reward_cancel_authority_changed();
CREATE FUNCTION app.reward_cancel_native(p_unit uuid,p_revision integer,p_reason text)RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE admission jsonb;context_id uuid;decision_id uuid;event_id uuid:=gen_random_uuid();after_unit jsonb;after_decision jsonb;after_event jsonb;affected integer;
BEGIN
 admission:=app.reward_cancel_admission(p_unit,p_revision,p_reason);
 DELETE FROM app.reward_cancel_native_effect e WHERE e.tenant_id=app.current_tenant_id()AND e.xact_id<pg_snapshot_xmin(pg_current_snapshot());
 IF EXISTS(SELECT 1 FROM app.reward_cancel_native_effect e WHERE e.xact_id=pg_current_xact_id()AND e.tenant_id=app.current_tenant_id()AND e.active)THEN RAISE EXCEPTION 'A native Reward cancellation is already active' USING ERRCODE='42501';END IF;
 IF admission->'hasDecision'='true'::jsonb THEN decision_id:=gen_random_uuid();END IF;
 INSERT INTO app.reward_cancel_native_effect(xact_id,tenant_id,user_id,unit_id,admission,decision_id,event_id)VALUES(pg_current_xact_id(),app.current_tenant_id(),app.current_user_id(),p_unit,admission,decision_id,event_id)RETURNING id INTO context_id;
 UPDATE public.reward_unit actual SET status='withdrawn',approved_digest=NULL,revision=p_revision+1,updated_at=clock_timestamp()WHERE actual.id=p_unit AND actual.tenant_id=app.current_tenant_id()AND actual.revision=p_revision AND app.reward_decision_row_hash(to_jsonb(actual),'reward_unit')=admission->>'unitBeforeHash'RETURNING to_jsonb(actual)INTO after_unit;
 GET DIAGNOSTICS affected=ROW_COUNT;IF affected<>1 THEN RAISE EXCEPTION 'Reward cancellation source changed' USING ERRCODE='40001';END IF;
 IF decision_id IS NOT NULL THEN
  INSERT INTO public.reward_decision(id,tenant_id,unit_id,actor_id,revision,action,from_stage,to_stage,reason,digest)VALUES(decision_id,app.current_tenant_id(),p_unit,app.current_user_id(),p_revision,'withdraw',admission->>'fromStage','withdrawn',admission->>'reason',admission->>'decisionDigest')RETURNING to_jsonb(reward_decision)INTO after_decision;
 END IF;
 INSERT INTO public.domain_event(id,tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)VALUES(event_id,app.current_tenant_id(),'reward-unit',p_unit,'reward-unit.cancelled','user',app.current_user_id(),jsonb_build_object('cancelRowHash',encode(sha256(convert_to(after_unit::text,'UTF8')),'hex'),'fromStage',admission->'fromStage','reason',admission->'reason','revision',p_revision,'before',jsonb_build_object('status',admission->'fromStage','revision',p_revision),'after',jsonb_build_object('status','withdrawn','revision',p_revision+1)))RETURNING to_jsonb(domain_event)INTO after_event;
 UPDATE app.reward_cancel_native_effect e SET active=false,completed=true,unit_after=after_unit,decision_after=after_decision,event_after=after_event WHERE e.id=context_id;
 RETURN jsonb_build_object('unitId',p_unit,'eventId',event_id,'cancelledRevision',p_revision,'currentRevision',p_revision+1,'status','withdrawn');
END $$;
CREATE FUNCTION app.reward_cancel_command(p_unit uuid,p_revision integer,p_reason text)RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT app.reward_cancel_native(p_unit,p_revision,p_reason);$$;
REVOKE ALL ON FUNCTION app.reward_cancel_native(uuid,integer,text),app.reward_cancel_command(uuid,integer,text)FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
DO $$ DECLARE course text;operation text;BEGIN
 FOREACH course IN ARRAY ARRAY['assigned','administration']LOOP
  FOREACH operation IN ARRAY ARRAY['view','execute']LOOP
   PERFORM app.register_function_action('rewards.cancellation.'||course,operation,'company',CASE WHEN course='administration'THEN CASE WHEN operation='view'THEN'rewards.view'ELSE'rewards.delete'END END,'app.rewards_function_legacy_allowed',jsonb_build_object('moduleKey','rewards','labelKey','rewardsConfig.actions.cancel','kind','native_acl','course',CASE WHEN course='assigned'THEN'assigned'ELSE'administrative'END,'screenKey',CASE WHEN course='assigned'THEN'rewards'ELSE'rewardsAdmin'END,'href',CASE WHEN course='assigned'THEN'/rewards'ELSE'/admin/rewards'END,'employeeBearing',false));
  END LOOP;
 END LOOP;
END $$;

--> statement-breakpoint
-- Same ordinary financial authority, with the just-written actor-owned native event ID.
-- The reviewed TS owner separately retains its full nomination/NOWAIT/xmin/double-read
-- interval; this owner accepts no caller event, source capsule or reviewed-authority flag.
CREATE FUNCTION app.reward_post_receipt_command(p_unit uuid,p_revision integer,p_batch uuid DEFAULT NULL)RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;event_id uuid;
BEGIN
 result:=app.reward_post_command(p_unit,p_revision,p_batch);
 IF result->'alreadyPosted'='true'::jsonb THEN RETURN result;END IF;
 SELECT proof.posted_event_id INTO event_id FROM app.reward_post_native_context proof JOIN public.domain_event audit ON audit.id=proof.posted_event_id AND audit.tenant_id=proof.tenant_id
 WHERE proof.xact_id=pg_current_xact_id()AND proof.tenant_id=app.current_tenant_id()AND proof.user_id=app.current_user_id()AND proof.unit_id=p_unit AND proof.completed AND NOT proof.active
 AND(proof.admission->>'revision')::integer=p_revision AND(proof.admission->>'batchId')::uuid IS NOT DISTINCT FROM p_batch AND proof.admission->>'authorityStamp'=app.access_function_authority_stamp()
 AND audit.aggregate_type='reward-unit'AND audit.aggregate_id=p_unit AND audit.event_type='reward-unit.posted'AND audit.actor_type='user'AND audit.actor_id=proof.user_id
 AND EXISTS(SELECT 1 FROM app.lifecycle_row_transaction_receipt birth WHERE birth.xact_id=proof.xact_id AND birth.tenant_id=proof.tenant_id AND birth.user_id=proof.user_id AND birth.table_name='domain_event'AND birth.row_id=audit.id);
 IF event_id IS NULL THEN RAISE EXCEPTION 'The native posting event is unavailable.' USING ERRCODE='42501';END IF;
 RETURN result||jsonb_build_object('postedEventId',event_id);
END $$;
REVOKE ALL ON FUNCTION app.reward_post_receipt_command(uuid,integer,uuid)FROM PUBLIC,ai_hr_app;

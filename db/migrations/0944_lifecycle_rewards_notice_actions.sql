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
 units:=app.reward_calc_units(value);
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
-- Explicit root Unicode casing; never depend on the installation's Turkish/libc default.
-- Hosted differential qualification must compare the runner's full scalar casing plus Sigma context.
CREATE COLLATION app.reward_calc_unicode(provider=icu,locale='und',deterministic=true);
CREATE FUNCTION app.reward_calc_lower(value text)RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT lower(value COLLATE app.reward_calc_unicode)COLLATE "C";
$$;
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
   IF app.reward_calc_units(r->>'currentRoleSummary')<30 OR app.reward_calc_units(r->>'proposedRoleSummary')<30 OR app.reward_calc_lower(r->>'currentRoleSummary')=app.reward_calc_lower(r->>'proposedRoleSummary')THEN flags:=flags||app.reward_calc_flag('block','OC-07','Provide distinct current and proposed job-description summaries (at least 30 characters each).',entry->'id');END IF;
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
   IF app.reward_calc_units(part.key)NOT BETWEEN 1 AND(CASE k WHEN'branchFactors'THEN 80 WHEN'branchRatings'THEN 100 ELSE 30 END) THEN RAISE EXCEPTION 'Invalid reward policy key' USING ERRCODE='22023';END IF;
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
   IF app.reward_calc_units(part.key)NOT BETWEEN 1 AND 64 OR app.reward_calc_units(text_value)<10 THEN RAISE EXCEPTION 'Invalid reward pay window' USING ERRCODE='22023';END IF;
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
 IF public_state IS NOT NULL AND public_state->'selectionConfirmed'='false'::jsonb AND'bu'=ANY(roles)AND NOT('gr'=ANY(roles))THEN RAISE EXCEPTION 'Senior plan membership awaits independent Group Rewards confirmation before the BU review can open.' USING ERRCODE='42501';END IF;
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
 calculation:=app.reward_calc_annual_unit(p_unit,p_revision);
 SELECT actual.* INTO actor FROM public.app_user actual WHERE actual.id=app.current_user_id()AND actual.tenant_id=app.current_tenant_id()AND actual.archived_at IS NULL AND NOT app.login_blocked(actual.id);
 SELECT actual.* INTO unit FROM public.reward_unit actual WHERE actual.id=p_unit AND actual.tenant_id=app.current_tenant_id();roles:=ARRAY(SELECT app.reward_roles(p_unit));
 IF actor.id IS NULL OR unit.id IS NULL OR cardinality(roles)=0 THEN RAISE EXCEPTION 'Reward calculation unavailable' USING ERRCODE='42501';END IF;
 RETURN app.reward_calc_projection(calculation,unit.policy,roles,actor.person_id,'["bu","bg","gr","ctro","ec"]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION app.reward_annual_calculation(uuid,integer)FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_annual_calculation(uuid,integer)TO ai_hr_app;

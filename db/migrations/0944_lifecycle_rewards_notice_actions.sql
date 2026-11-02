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
 source_draft_id uuid,source_data jsonb,
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
--> statement-breakpoint
CREATE FUNCTION app.lifecycle_effect_function_identity(p_case uuid,p_purpose text)
RETURNS TABLE(function_key text,operation text,company_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE p_purpose WHEN 'assigned-task'THEN'lifecycle.shared.tasks'WHEN'assigned-onboarding-task'THEN'lifecycle.shared.tasks'WHEN'assigned-onboarding-handover'THEN'lifecycle.shared.handover'WHEN'assigned-onboarding-note'THEN'lifecycle.shared.requisitionNotes'WHEN'own-onboarding-ack'THEN'lifecycle.self.acknowledgement'WHEN'assigned-onboarding-conversation'THEN'lifecycle.shared.conversations'WHEN'assigned-onboarding-fulfil'THEN'lifecycle.shared.fulfilment'WHEN'assigned-onboarding-approval'THEN'lifecycle.shared.approvals'WHEN'assigned-onboarding-approval-assignment'THEN'lifecycle.shared.approvalAssignments'END,
 CASE WHEN p_purpose='assigned-onboarding-approval'THEN'approve'ELSE'execute'END,source.company_id FROM(
 SELECT c.company_id FROM public.lc_v9_case c WHERE p_purpose='assigned-task'AND c.id=p_case AND c.tenant_id=app.current_tenant_id()
 UNION ALL SELECT c.company_id FROM public.lc_onboarding_case c WHERE p_purpose IN('assigned-onboarding-task','assigned-onboarding-handover','assigned-onboarding-note','own-onboarding-ack','assigned-onboarding-conversation','assigned-onboarding-fulfil','assigned-onboarding-approval','assigned-onboarding-approval-assignment')AND c.id=p_case AND c.tenant_id=app.current_tenant_id())source;
$$;
REVOKE ALL ON FUNCTION app.lifecycle_effect_function_identity(uuid,text)FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.lifecycle_native_effect_begin(p_purpose text,p_case uuid,p_event text)RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result uuid;identity record;stamp text;
BEGIN
 IF NOT app.principal_snapshot_current() OR app.current_user_id() IS NULL OR p_case IS NULL
  OR p_purpose NOT IN('own-daa','own-document','assigned-task','own-return-report','assigned-item','own-equipment-receipt','assigned-onboarding-task','assigned-onboarding-handover','assigned-onboarding-note','own-onboarding-ack','assigned-onboarding-conversation','assigned-onboarding-fulfil','assigned-onboarding-approval','assigned-onboarding-approval-assignment')
  OR p_event NOT IN('lifecycle-case.daa-submitted','lifecycle-v9.employeeDocumentSigned','lifecycle-v9.employeeDocumentSaved','lifecycle-v9.assignedTaskUpdated','lifecycle-v9.returnReported','lifecycle-v9.providingTeamItemUpdated','lifecycle-v9.equipmentReceipt','onboarding.task','onboarding.handover','onboarding.readNote','onboarding.acknowledge','onboarding.note_changed','onboarding.fulfil','onboarding.approve','onboarding.assignApproval')
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
CREATE FUNCTION app.lifecycle_native_effect_admission_valid(p_context uuid)RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current()AND EXISTS(SELECT 1 FROM app.lifecycle_native_effect_context c
 JOIN public.app_user actor ON actor.id=c.user_id AND actor.tenant_id=c.tenant_id AND actor.archived_at IS NULL AND NOT app.login_blocked(actor.id)
 WHERE c.id=p_context AND c.xact_id=pg_current_xact_id()AND c.tenant_id=app.current_tenant_id()AND c.user_id=app.current_user_id()AND c.completed AND NOT c.active
 AND c.authority_stamp=app.access_function_authority_stamp()
 AND(c.purpose<>'source-draft-save' OR app.lifecycle_saved_source_completion(c.id))
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
 AND EXISTS(SELECT 1 FROM public.domain_event e WHERE e.tenant_id=c.tenant_id AND e.aggregate_id=c.case_id AND e.event_type=c.event_type AND e.actor_type='user' AND e.actor_id=c.user_id AND app.lifecycle_row_in_transaction('domain_event',e.id,to_jsonb(e))));
$$;
REVOKE ALL ON FUNCTION app.lifecycle_native_effect_approved(text,jsonb,jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.lifecycle_native_effect_cleanup()RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM app.lifecycle_native_effect_context c WHERE c.id=NEW.id)THEN RETURN NULL;END IF;
 IF NOT app.lifecycle_native_effect_admission_valid(NEW.id) OR NOT EXISTS(SELECT 1 FROM public.domain_event e WHERE e.tenant_id=NEW.tenant_id AND e.aggregate_id=NEW.case_id AND e.event_type=NEW.event_type AND e.actor_type='user' AND e.actor_id=NEW.user_id AND app.lifecycle_row_in_transaction('domain_event',e.id,to_jsonb(e)))
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
DECLARE selected jsonb;c public.lc_onboarding_case;request jsonb;body text:='';conversation jsonb:='[]'::jsonb;candidate_group text;candidates jsonb:='[]'::jsonb;
BEGIN
 SELECT r.task INTO selected FROM(SELECT task FROM app.onboarding_delivery_task_rows()UNION ALL SELECT task FROM app.onboarding_checklist_task_rows())r WHERE r.task->>'id'=p_task;
 IF selected IS NULL THEN RETURN NULL;END IF;
 SELECT * INTO c FROM public.lc_onboarding_case x WHERE x.id::text=selected->>'caseId'AND x.tenant_id=app.current_tenant_id();
 SELECT r INTO request FROM jsonb_array_elements(c.data->'requisitions')WITH ORDINALITY q(r,n)WHERE r->>'cancelledAt'IS NULL ORDER BY n LIMIT 1;
 selected:=selected||jsonb_build_object('canReply',selected->>'kind'IN('mention','checklist')AND app.function_action_allowed('lifecycle.shared.conversations','execute',c.company_id));
 IF selected->>'kind'='hrNote'THEN body:=coalesce(request->>'hrNote','');END IF;
 IF selected->>'kind'IN('mention','checklist')THEN SELECT coalesce(jsonb_agg(n),'[]'::jsonb)INTO conversation FROM app.onboarding_conversation_rows(c.id,selected->>'context')n;END IF;
 IF selected->>'kind'='manualApproval'THEN
  SELECT step->>'group'INTO candidate_group FROM jsonb_array_elements(request->'items')i,jsonb_array_elements(i->'steps')step WHERE selected->'itemIds'?(i->>'id')AND step->>'id'=selected->>'stepId';
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',u.id,'name',CASE WHEN p.id IS NOT NULL AND app.data_permission_person_read(p.id)THEN p.full_name ELSE'User '||left(u.id::text,8)END)ORDER BY members.n),'[]'::jsonb)INTO candidates
  FROM public.lc_onboarding_config cfg,jsonb_array_elements(cfg.data->'groups')g,jsonb_array_elements_text(g->'members')WITH ORDINALITY members(user_id,n)
  JOIN public.app_user u ON u.id::text=members.user_id AND u.tenant_id=app.current_tenant_id()AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
  LEFT JOIN public.person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id WHERE cfg.tenant_id=c.tenant_id AND g->>'id'=candidate_group;
 END IF;
 RETURN jsonb_build_object('task',selected,'body',body,'notes',conversation,'requestNumber',request->>'number','candidates',candidates,'items',CASE WHEN selected->>'kind'IN('approval','manualApproval')THEN(SELECT coalesce(jsonb_agg(jsonb_build_object('id',i->>'id','name',i->>'name')),'[]'::jsonb)FROM jsonb_array_elements(request->'items')i WHERE selected->'itemIds'?(i->>'id'))ELSE'[]'::jsonb END);
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
-- The native SAVE source course accepts only an actual same-TX Workforce save receipt. It derives
-- facts itself; no caller supplies a case delta, private snapshot, role or administrative capability.
--> statement-breakpoint
CREATE FUNCTION app.onboarding_sync_saved_draft(p_draft uuid)
RETURNS TABLE(handled boolean,case_id uuid,company_id uuid,did_change boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE draft public.employee_draft;source_image jsonb;c public.lc_onboarding_case;cfg jsonb;
 facts jsonb;public_facts jsonb;private_facts jsonb;prior_private public.lc_onboarding_private;
 next_data jsonb;next_private jsonb;private_local jsonb;entry jsonb;stamp text;source_version text;actor_name text;hr boolean;effect uuid;case_number text;subject uuid;year text;sequence_number text;
BEGIN
 PERFORM app.audit_access_order_lock();
 PERFORM app.access_workforce_write_lock();
 PERFORM pg_advisory_xact_lock(hashtext('audit-chain:'||app.current_tenant_id()::text));
 PERFORM pg_advisory_xact_lock(hashtextextended(app.current_tenant_id()::text||':onboarding',0));
 IF NOT app.principal_snapshot_current()OR app.current_user_id()IS NULL THEN RAISE EXCEPTION 'Draft source unavailable' USING ERRCODE='42501';END IF;
 SELECT d.* INTO draft FROM public.employee_draft d WHERE d.id=p_draft AND d.tenant_id=app.current_tenant_id()FOR UPDATE;
 IF draft.id IS NULL OR app.workforce_draft_saved_source_allowed(p_draft,to_jsonb(draft))IS NOT TRUE THEN RETURN QUERY SELECT false,NULL::uuid,NULL::uuid,false;RETURN;END IF;
 source_image:=to_jsonb(draft);
 SELECT config.data INTO cfg FROM public.lc_onboarding_config config WHERE config.tenant_id=draft.tenant_id AND config.revision>0;
 IF cfg IS NULL OR draft.company_id IS NULL THEN RETURN QUERY SELECT true,NULL::uuid,NULL::uuid,false;RETURN;END IF;
 SELECT u_case.* INTO c FROM public.lc_onboarding_case u_case WHERE u_case.tenant_id=draft.tenant_id AND u_case.source_draft_id=p_draft FOR UPDATE;
 IF c.id IS NOT NULL AND(c.data->>'id'IS DISTINCT FROM c.id::text OR c.data->>'sourceDraftId'IS DISTINCT FROM p_draft::text OR c.data->>'personnelStatus'IS DISTINCT FROM'Draft'OR c.employment_id IS NOT NULL OR c.data->>'employmentId'IS NOT NULL OR c.data->>'personId'IS NOT NULL
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
 IF c.id IS NOT NULL AND c.data->>'sourceVersion'=source_version AND c.data->'source'=public_facts AND(NOT hr OR coalesce(prior_private.data->'source','{}')=private_facts)THEN RETURN QUERY SELECT true,c.id,draft.company_id,false;RETURN;END IF;
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
 entry:=jsonb_build_object('id',gen_random_uuid(),'at',stamp,'by',app.current_user_id(),'name',actor_name,'action',CASE WHEN c.id IS NULL THEN'personnel.synced'ELSE'personnel.updated'END,'detail','');
 next_data:=next_data||jsonb_build_object('history',coalesce(next_data->'history','[]')||jsonb_build_array(entry));
 IF EXISTS(SELECT 1 FROM app.lifecycle_native_effect_context context WHERE context.xact_id=pg_current_xact_id()AND context.tenant_id=draft.tenant_id AND context.user_id=app.current_user_id()AND context.active)THEN RAISE EXCEPTION 'Native source context already active' USING ERRCODE='42501';END IF;
 INSERT INTO app.lifecycle_native_effect_context(xact_id,tenant_id,user_id,purpose,case_id,event_type,source_draft_id,source_data,authority_stamp,company_id,positive_admission)
 VALUES(pg_current_xact_id(),draft.tenant_id,app.current_user_id(),'source-draft-save',subject,'onboarding.personnel_synced',p_draft,source_image,app.access_function_authority_stamp(),draft.company_id,true)RETURNING id INTO effect;
 IF c.id IS NULL THEN
  INSERT INTO public.lc_onboarding_case(id,tenant_id,company_id,source_draft_id,data)VALUES(subject,draft.tenant_id,draft.company_id,p_draft,next_data);
 ELSE
  INSERT INTO public.lc_onboarding_case_revision(tenant_id,case_id,company_id,revision,data)VALUES(c.tenant_id,c.id,c.company_id,c.revision,c.data)ON CONFLICT DO NOTHING;
  IF hr AND prior_private.case_id IS NOT NULL THEN INSERT INTO public.lc_onboarding_private_revision(tenant_id,case_id,company_id,revision,data)VALUES(c.tenant_id,c.id,prior_private.company_id,c.revision,prior_private.data)ON CONFLICT DO NOTHING;END IF;
  UPDATE public.lc_onboarding_case actual SET company_id=draft.company_id,data=next_data,revision=c.revision+1,updated_at=clock_timestamp()WHERE actual.id=c.id AND actual.tenant_id=c.tenant_id;
 END IF;
 IF hr THEN
  INSERT INTO public.lc_onboarding_private(case_id,tenant_id,company_id,data)VALUES(subject,draft.tenant_id,draft.company_id,next_private)ON CONFLICT(case_id)DO UPDATE SET company_id=excluded.company_id,data=excluded.data;
 END IF;
 PERFORM app.lifecycle_native_effect_complete(effect);
 RETURN QUERY SELECT true,subject,draft.company_id,true;
END $$;
REVOKE ALL ON FUNCTION app.onboarding_sync_saved_draft(uuid)FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onboarding_sync_saved_draft(uuid)TO ai_hr_app;
--> statement-breakpoint
-- A combined SAVE→DISCARD transaction must close the already-sealed SAVE image through the
-- real closed Draft DELETE port. This bridge only creates that private intent; cancellation and
-- deletion remain the existing native owners, and an orphan intent cannot commit.
CREATE FUNCTION app.onboarding_saved_draft_discard_admit(p_draft uuid)RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actual public.employee_draft;
BEGIN
 IF NOT app.principal_snapshot_current()OR app.current_user_id()IS NULL THEN RAISE EXCEPTION 'Draft source unavailable' USING ERRCODE='42501';END IF;
 PERFORM app.access_workforce_write_lock();
 SELECT draft.* INTO actual FROM public.employee_draft draft WHERE draft.id=p_draft AND draft.tenant_id=app.current_tenant_id()FOR UPDATE;
 IF actual.id IS NOT NULL AND EXISTS(SELECT 1 FROM app.lifecycle_native_effect_context effect WHERE effect.xact_id=pg_current_xact_id()AND effect.tenant_id=actual.tenant_id AND effect.user_id=app.current_user_id()AND effect.purpose='source-draft-save'AND effect.source_draft_id=p_draft AND effect.source_data=to_jsonb(actual)AND effect.completed AND NOT effect.active)THEN
  PERFORM app.workforce_draft_discard_begin(p_draft,to_jsonb(actual));
 END IF;
END $$;
REVOKE ALL ON FUNCTION app.onboarding_saved_draft_discard_admit(uuid)FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onboarding_saved_draft_discard_admit(uuid)TO ai_hr_app;

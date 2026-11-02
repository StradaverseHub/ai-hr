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
 FOREACH owned_table IN ARRAY ARRAY['reward_member','lc_staff','lc_onboarding_config','lc_v9_config']LOOP
  EXECUTE format('CREATE TRIGGER action_authority_generation_insert AFTER INSERT ON public.%I REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('''')',owned_table);
  EXECUTE format('CREATE TRIGGER action_authority_generation_update AFTER UPDATE ON public.%I REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('''')',owned_table);
  EXECUTE format('CREATE TRIGGER action_authority_generation_delete AFTER DELETE ON public.%I REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('''')',owned_table);
 END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.notice_owner_action_allowed(p_company uuid,p_action text)RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND CASE WHEN p_company IS NULL THEN app.is_group_admin()
  AND app.lifecycle_reward_notice_action('notices_global',p_action,NULL)
  AND NOT EXISTS(SELECT 1 FROM public.company c WHERE c.tenant_id=app.current_tenant_id() AND NOT app.lifecycle_reward_notice_action('notices',p_action,c.id))
 ELSE app.is_admin_for(p_company) AND app.lifecycle_reward_notice_action('notices',p_action,p_company)END;
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
CREATE FUNCTION app.lifecycle_native_effect_begin(p_purpose text,p_case uuid,p_event text)RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result uuid;
BEGIN
 IF NOT app.principal_snapshot_current() OR app.current_user_id() IS NULL OR p_case IS NULL
  OR p_purpose NOT IN('own-daa','own-document','assigned-task','own-return-report','assigned-item','own-equipment-receipt')
  OR p_event NOT IN('lifecycle-case.daa-submitted','lifecycle-v9.employeeDocumentSigned','lifecycle-v9.employeeDocumentSaved','lifecycle-v9.assignedTaskUpdated','lifecycle-v9.returnReported','lifecycle-v9.providingTeamItemUpdated','lifecycle-v9.equipmentReceipt')
  OR EXISTS(SELECT 1 FROM app.lifecycle_native_effect_context c WHERE c.xact_id=pg_current_xact_id() AND c.tenant_id=app.current_tenant_id() AND c.user_id=app.current_user_id() AND c.active)
 THEN RAISE EXCEPTION 'Invalid native Lifecycle effect context' USING ERRCODE='42501';END IF;
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
CREATE FUNCTION app.lifecycle_native_effect_approved(p_table text,p_before jsonb,p_after jsonb)RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND EXISTS(SELECT 1 FROM app.lifecycle_native_effect_context c JOIN app.lifecycle_native_effect_receipt r ON r.context_id=c.id
 WHERE c.xact_id=pg_current_xact_id() AND c.tenant_id=app.current_tenant_id() AND c.user_id=app.current_user_id() AND c.completed AND NOT c.active
 AND r.table_name=p_table AND r.before_hash=encode(sha256(convert_to(coalesce(p_before,'{}'::jsonb)::text,'UTF8')),'hex') AND r.after_hash=encode(sha256(convert_to(coalesce(p_after,'{}'::jsonb)::text,'UTF8')),'hex')
 AND EXISTS(SELECT 1 FROM public.domain_event e WHERE e.tenant_id=c.tenant_id AND e.aggregate_id=c.case_id AND e.event_type=c.event_type AND e.actor_type='user' AND e.actor_id=c.user_id AND e.xmin::text=pg_current_xact_id()::text));
$$;
REVOKE ALL ON FUNCTION app.lifecycle_native_effect_approved(text,jsonb,jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.lifecycle_native_effect_cleanup()RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM app.lifecycle_native_effect_context c WHERE c.id=NEW.id)THEN RETURN NULL;END IF;
 IF NOT NEW.completed OR NEW.active OR NOT EXISTS(SELECT 1 FROM public.domain_event e WHERE e.tenant_id=NEW.tenant_id AND e.aggregate_id=NEW.case_id AND e.event_type=NEW.event_type AND e.actor_type='user' AND e.actor_id=NEW.user_id AND e.xmin::text=NEW.xact_id::text)
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
  body:=overlay(body placing E' PERFORM app.access_workforce_write_lock();\n' from mutation_at+6 for 0);
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
 RETURN EXISTS(SELECT 1 FROM public.domain_event e WHERE e.tenant_id=app.current_tenant_id() AND e.aggregate_id=(data->>'id')::uuid AND e.event_type=event AND e.actor_type='user' AND e.actor_id=app.current_user_id() AND e.xmin::text=pg_current_xact_id()::text);
END $$;
REVOKE ALL ON FUNCTION app.lifecycle_own_request_effect(jsonb,jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Finite requester courses are separate from all administrative family/function actions.
DO $$ DECLARE body text;anchor text:=' IF app.lifecycle_native_effect_approved(TG_TABLE_NAME,before_row,after_row)THEN RETURN NULL;END IF;';BEGIN
 body:=pg_get_functiondef('app.lifecycle_legacy_action_guard()'::regprocedure);
 IF strpos(body,anchor)=0 THEN RAISE EXCEPTION 'Lifecycle action guard changed before own-request binding';END IF;
 EXECUTE replace(body,anchor,anchor||E'\n IF TG_TABLE_NAME=''it_asset_request'' AND app.lifecycle_own_request_effect(before_row,after_row)THEN RETURN NULL;END IF;\n IF TG_TABLE_NAME=''lc_history'' AND TG_OP=''INSERT'' AND app.principal_snapshot_current() AND data->>''ref_type''=''asset_request'' AND data->>''action'' IN(''request.created'',''request.cancelled'') AND(data->>''actor_user_id'')::uuid=app.current_user_id() AND EXISTS(SELECT 1 FROM public.it_asset_request q JOIN public.domain_event e ON e.aggregate_id=q.id AND e.tenant_id=q.tenant_id WHERE q.id=(data->>''ref_id'')::uuid AND q.tenant_id=app.current_tenant_id() AND q.requester_user_id=app.current_user_id() AND q.xmin::text=pg_current_xact_id()::text AND e.actor_type=''user'' AND e.actor_id=app.current_user_id() AND e.event_type=CASE WHEN data->>''action''=''request.created'' THEN ''lifecycle-asset-request.created'' ELSE ''lifecycle-asset-request.cancelled'' END AND e.xmin::text=pg_current_xact_id()::text)THEN RETURN NULL;END IF;');
END $$;

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
 WHERE app.principal_snapshot_current() AND app.lc_level(p_company)>=1
 ORDER BY 2,x.user_id;
$$;
CREATE FUNCTION app.lifecycle_handler_eligible(p_user uuid,p_company uuid)RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND app.lc_level(p_company)>=2
 AND EXISTS(SELECT 1 FROM app.lc_staff_directory(p_company)c WHERE c.user_id=p_user);
$$;
REVOKE ALL ON FUNCTION app.lifecycle_handler_eligible(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lifecycle_handler_eligible(uuid,uuid) TO ai_hr_app;

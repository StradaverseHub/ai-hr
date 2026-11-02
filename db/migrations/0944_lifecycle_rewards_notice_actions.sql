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
ALTER POLICY data_permission_subject_read ON reward_entry USING(app.data_permission_record_read(employment_id) OR EXISTS(SELECT 1 FROM app.reward_roles(unit_id)));
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
ALTER POLICY notice_admin_rls ON notice USING(tenant_id=app.current_tenant_id() AND app.notice_action_allowed(id,'view'));
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

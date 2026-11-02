-- Exact financial/letter action restrictions retain native role/ACL and independent workflow floors.
-- Source reservation0941 / aggregateidx763 / when1793330000341. Activation is the restricted publisher.
INSERT INTO access_capability(id,scope,supported,bindings) SELECT domain||'.'||operation,'company',false,'[]'::jsonb FROM (VALUES('payroll'),('performance_compensation'))d(domain) CROSS JOIN (VALUES('view'),('add'),('edit'),('delete'))o(operation);
INSERT INTO access_capability(id,scope,supported,bindings) SELECT 'letters.'||operation,'company',false,'[]'::jsonb FROM (VALUES('view'),('add'),('edit'),('delete'),('approve'),('issue'))o(operation);
--> statement-breakpoint
CREATE FUNCTION app.letter_native_permission_for_user_at(wanted_tenant uuid,subject uuid,co uuid,cap text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT cap IN ('read','template','generate','approve','issue','report','settings') AND EXISTS(SELECT 1 FROM public.company c
 JOIN public.app_user u ON u.tenant_id=c.tenant_id AND u.id=subject AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
 WHERE c.id=co AND c.tenant_id=wanted_tenant AND c.archived_at IS NULL
 AND EXISTS(SELECT 1 FROM public.role_assignment r WHERE r.tenant_id=c.tenant_id AND r.app_user_id=u.id AND app.access_scope_covers(r.company_id,c.id,c.tenant_id)
 AND coalesce((SELECT g.allowed FROM public.letter_capability_grant g WHERE g.tenant_id=c.tenant_id AND g.company_id=c.id AND g.capability=cap AND g.role=r.role::text),r.role::text IN ('super_admin','hr_admin'))));
$$;
REVOKE ALL ON FUNCTION app.letter_native_permission_for_user_at(uuid,uuid,uuid,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.financial_letter_native_operations(p_capability text) RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE p_capability
 WHEN 'letters.view' THEN ARRAY['read','template','generate','approve','issue','report','settings']
 WHEN 'letters.add' THEN ARRAY['generate','template','settings']
 WHEN 'letters.edit' THEN ARRAY['generate','template','settings']
 WHEN 'letters.delete' THEN ARRAY['generate','template','settings','issue']
 WHEN 'letters.approve' THEN ARRAY['approve','template'] WHEN 'letters.issue' THEN ARRAY['issue'] ELSE NULL::text[] END;
$$;
REVOKE ALL ON FUNCTION app.financial_letter_native_operations(text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.financial_letter_legacy_allowed(p_tenant uuid,p_user uuid,p_capability text,p_company uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE roles text[];operation text;company_id uuid;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=p_user AND u.tenant_id=p_tenant AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)) THEN RETURN false;END IF;
 IF p_capability=ANY(ARRAY['payroll.view','payroll.add','payroll.edit','payroll.delete']) THEN roles:=ARRAY['hr_admin','super_admin','payroll_partner'];
 ELSIF p_capability=ANY(ARRAY['performance_compensation.view','performance_compensation.add','performance_compensation.edit','performance_compensation.delete']) THEN roles:=ARRAY['hr_admin','super_admin','performance_comp_partner'];
 ELSIF app.financial_letter_native_operations(p_capability) IS NOT NULL THEN
  IF p_company IS NULL THEN
   -- A tenant grant includes future companies. Only a real tenant-wide default native role can
   -- prove that future floor; today-only enumeration of explicit company ACLs cannot do so.
   IF NOT EXISTS(SELECT 1 FROM public.role_assignment r WHERE r.tenant_id=p_tenant AND r.app_user_id=p_user AND r.company_id IS NULL AND r.role::text IN ('hr_admin','super_admin')) THEN RETURN false;END IF;
   FOR company_id IN SELECT c.id FROM public.company c WHERE c.tenant_id=p_tenant AND c.archived_at IS NULL LOOP
    IF NOT app.financial_letter_legacy_allowed(p_tenant,p_user,p_capability,company_id) THEN RETURN false;END IF;
   END LOOP;RETURN true;
  END IF;
  FOREACH operation IN ARRAY app.financial_letter_native_operations(p_capability) LOOP
   IF app.letter_native_permission_for_user_at(p_tenant,p_user,p_company,operation) THEN RETURN true;END IF;
  END LOOP;RETURN false;
 ELSE RETURN false;END IF;
 RETURN EXISTS(SELECT 1 FROM public.role_assignment r WHERE r.tenant_id=p_tenant AND r.app_user_id=p_user AND r.role::text=ANY(roles)
  AND (p_company IS NULL AND r.company_id IS NULL OR p_company IS NOT NULL AND app.access_scope_covers(r.company_id,p_company,p_tenant)));
END;
$$;
REVOKE ALL ON FUNCTION app.financial_letter_legacy_allowed(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.financial_letter_delegation_allowed(p_tenant uuid,p_user uuid,p_capability text,p_company uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE operation text;company_id uuid;
BEGIN
 IF app.financial_letter_native_operations(p_capability) IS NULL THEN RETURN app.financial_letter_legacy_allowed(p_tenant,p_user,p_capability,p_company);END IF;
 IF NOT app.financial_letter_legacy_allowed(p_tenant,p_user,p_capability,p_company) THEN RETURN false;END IF;
 IF p_company IS NULL THEN
  FOR company_id IN SELECT c.id FROM public.company c WHERE c.tenant_id=p_tenant AND c.archived_at IS NULL LOOP
   IF NOT app.financial_letter_delegation_allowed(p_tenant,p_user,p_capability,company_id) THEN RETURN false;END IF;
  END LOOP;RETURN true;
 END IF;
 -- ANY native course is sufficient only for preserving installed authority. Delegation of an
 -- aggregate action cell must prove EVERY operation represented by that cell, including View.
 FOREACH operation IN ARRAY app.financial_letter_native_operations(p_capability) LOOP
  IF NOT app.letter_native_permission_for_user_at(p_tenant,p_user,p_company,operation) THEN RETURN false;END IF;
 END LOOP;RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION app.financial_letter_delegation_allowed(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.financial_letter_capability_allowed_for(p_tenant uuid,p_user uuid,p_capability text,p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.access_capability c WHERE c.id=p_capability AND c.scope='company'
 AND (NOT c.supported OR CASE WHEN p_company IS NOT NULL THEN app.access_allowed_for_tenant(p_tenant,p_user,c.id,p_company)
 ELSE EXISTS(SELECT 1 FROM public.access_configuration state WHERE state.tenant_id=p_tenant AND state.initialized)
  AND NOT EXISTS(SELECT 1 FROM public.access_user_override deny WHERE deny.tenant_id=p_tenant AND deny.user_id=p_user AND deny.capability_id=c.id AND deny.effect='deny' AND deny.retired_at IS NULL)
  AND (EXISTS(SELECT 1 FROM public.access_user_override allow_rule WHERE allow_rule.tenant_id=p_tenant AND allow_rule.user_id=p_user AND allow_rule.capability_id=c.id AND allow_rule.effect='allow' AND allow_rule.company_id IS NULL AND allow_rule.retired_at IS NULL)
   OR EXISTS(SELECT 1 FROM public.access_effective_membership member JOIN public.access_group g ON g.id=member.group_id AND g.tenant_id=member.tenant_id JOIN public.access_group_grant grant_rule ON grant_rule.group_id=g.id AND grant_rule.tenant_id=g.tenant_id
    WHERE member.tenant_id=p_tenant AND member.user_id=p_user AND member.company_id IS NULL AND g.retired_at IS NULL AND grant_rule.capability_id=c.id AND grant_rule.company_id IS NULL AND grant_rule.retired_at IS NULL))
  AND NOT EXISTS(SELECT 1 FROM public.company co WHERE co.tenant_id=p_tenant AND NOT app.access_allowed_for_tenant(p_tenant,p_user,c.id,co.id)) END));
$$;
REVOKE ALL ON FUNCTION app.financial_letter_capability_allowed_for(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.access_financial_action_company(p_domain text,p_company uuid,p_operation text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT p_domain IN ('payroll','performance_compensation') AND p_operation IN ('view','add','edit','delete')
 AND app.principal_snapshot_current() AND app.financial_letter_legacy_allowed(app.current_tenant_id(),app.current_user_id(),p_domain||'.'||p_operation,p_company)
 AND CASE WHEN p_domain='payroll' THEN app.grants_payroll_admin_for((SELECT jsonb_agg(jsonb_build_object('role',g.role,'companyId',g.company_id)) FROM app.current_grants() g),p_company)
 ELSE app.grants_admin_for((SELECT jsonb_agg(jsonb_build_object('role',g.role,'companyId',g.company_id)) FROM app.current_grants() g),p_company) OR app.grants_have_role_for((SELECT jsonb_agg(jsonb_build_object('role',g.role,'companyId',g.company_id)) FROM app.current_grants() g),'performance_comp_partner',p_company) END
 AND app.financial_letter_capability_allowed_for(app.current_tenant_id(),app.current_user_id(),p_domain||'.view',p_company)
 AND app.financial_letter_capability_allowed_for(app.current_tenant_id(),app.current_user_id(),p_domain||'.'||p_operation,p_company);
$$;
REVOKE ALL ON FUNCTION app.access_financial_action_company(text,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.access_financial_action_company(text,uuid,text) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.access_financial_action_employment(p_domain text,p_employment uuid,p_operation text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.employment e WHERE e.id=p_employment AND e.tenant_id=app.current_tenant_id() AND e.voided_at IS NULL
 AND app.access_financial_action_company(p_domain,e.company_id,p_operation)
 AND (app.data_permission_matches(e.id) OR p_operation='add' AND app.data_permission_employment_born(e.id)));
$$;
REVOKE ALL ON FUNCTION app.access_financial_action_employment(text,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.access_financial_action_employment(text,uuid,text) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.access_letter_action_for_user(p_tenant uuid,p_user uuid,p_company uuid,p_native text,p_operation text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT p_operation IN ('view','add','edit','delete','approve','issue') AND app.letter_native_permission_for_user_at(p_tenant,p_user,p_company,p_native)
 AND app.financial_letter_capability_allowed_for(p_tenant,p_user,'letters.view',p_company)
 AND app.financial_letter_capability_allowed_for(p_tenant,p_user,'letters.'||p_operation,p_company);
$$;
REVOKE ALL ON FUNCTION app.access_letter_action_for_user(uuid,uuid,uuid,text,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.access_letter_action(p_company uuid,p_native text,p_operation text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND app.access_letter_action_for_user(app.current_tenant_id(),app.current_user_id(),p_company,p_native,p_operation);
$$;
REVOKE ALL ON FUNCTION app.access_letter_action(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.access_letter_action(uuid,text,text) TO ai_hr_app;
--> statement-breakpoint
-- Read owners require View; approval and issuance additionally remain their own purposes.
-- Configuration/template/generation reads do not silently become write permissions.
CREATE OR REPLACE FUNCTION app.letter_permission_for_user_at(wanted_tenant uuid,subject uuid,co uuid,cap text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.access_letter_action_for_user(wanted_tenant,subject,co,cap,CASE cap WHEN 'approve' THEN 'approve' WHEN 'issue' THEN 'issue' ELSE 'view' END);
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.can_admin_payroll_for(p_company uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT app.access_financial_action_company('payroll',p_company,'view') $$;
CREATE OR REPLACE FUNCTION app.can_admin_perfcomp_for(p_company uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT app.access_financial_action_company('performance_compensation',p_company,'view') $$;
--> statement-breakpoint
-- Successful AFTER INSERT proofs classify initial content as part of its authorized Add.
-- They cannot be minted by a skipped ON CONFLICT INSERT or by a caller-supplied context flag.
CREATE TABLE app.financial_letter_birth (
 transaction_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,kind text NOT NULL,row_id uuid NOT NULL,operation text NOT NULL,
 PRIMARY KEY(transaction_id,tenant_id,user_id,kind,row_id)
);
ALTER TABLE app.financial_letter_birth ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.financial_letter_birth FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.financial_letter_born(p_kind text,p_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT operation FROM app.financial_letter_birth WHERE transaction_id=pg_current_xact_id() AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND kind=p_kind AND row_id=p_id;
$$;
REVOKE ALL ON FUNCTION app.financial_letter_born(text,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.access_letter_write_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE row_data jsonb;old_data jsonb;co uuid;native text;operation text;root uuid;parent_operation text;
BEGIN
 IF TG_OP='DELETE' THEN row_data:=to_jsonb(OLD);ELSE row_data:=to_jsonb(NEW);END IF;
 IF TG_OP='UPDATE' THEN old_data:=to_jsonb(OLD);END IF;
 IF row_data->>'tenant_id' IS DISTINCT FROM app.current_tenant_id()::text THEN RAISE EXCEPTION 'Letter action unavailable' USING ERRCODE='42501';END IF;
 -- These existing private owners validate the leased job, actual author, current source,
 -- exact inserted columns and immutable workflow. They also recheck the author's Add below.
 IF app.current_user_id() IS NULL THEN
  IF TG_OP='INSERT' AND app.letter_automation_insert_allowed(TG_TABLE_NAME,row_data) THEN
   IF TG_TABLE_NAME='letter_job' THEN RETURN NEW;END IF;
   SELECT b.company_id,b.created_by INTO co,root FROM public.letter_generation_batch b
    WHERE b.id=CASE WHEN TG_TABLE_NAME='letter_generation_batch' THEN (row_data->>'id')::uuid
     WHEN TG_TABLE_NAME='letter_record' THEN (row_data->>'batch_id')::uuid
     ELSE (SELECT l.batch_id FROM public.letter_record l WHERE l.id=(row_data->>'letter_id')::uuid AND l.tenant_id=app.current_tenant_id()) END;
   IF TG_TABLE_NAME='letter_generation_batch' THEN co:=(row_data->>'company_id')::uuid;root:=(row_data->>'created_by')::uuid;END IF;
   IF app.access_letter_action_for_user(app.current_tenant_id(),root,co,'generate','add') THEN RETURN NEW;END IF;
  ELSIF TG_OP='UPDATE' AND TG_TABLE_NAME='letter_record' AND app.letter_automation_transition_allowed(old_data,row_data) THEN RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Letter action unavailable' USING ERRCODE='42501';
 END IF;
 PERFORM app.access_workforce_write_lock();
 co:=(row_data->>'company_id')::uuid;
 operation:=CASE TG_OP WHEN 'INSERT' THEN 'add' WHEN 'DELETE' THEN 'delete' ELSE 'edit' END;
 CASE TG_TABLE_NAME
 WHEN 'letter_capability_grant' THEN
  native:='settings';
  IF TG_OP='INSERT' AND EXISTS(SELECT 1 FROM public.letter_capability_grant g WHERE g.tenant_id=app.current_tenant_id() AND g.company_id=co AND g.capability=row_data->>'capability' AND g.role=row_data->>'role') THEN operation:='edit';END IF;
 WHEN 'letter_asset' THEN
  native:=CASE row_data->>'kind' WHEN 'signature' THEN 'approve' ELSE 'settings' END;
  IF native='approve' THEN operation:='approve';END IF;
 WHEN 'letter_policy_version' THEN
  native:='settings';IF (row_data->>'ordinal')::integer>1 THEN operation:='edit';END IF;
  IF TG_OP='INSERT' AND NOT (row_data->>'enabled')::boolean AND EXISTS(SELECT 1 FROM public.letter_policy_version v WHERE v.tenant_id=app.current_tenant_id() AND v.company_id=co AND v.category=row_data->>'category' AND v.ordinal=(row_data->>'ordinal')::integer-1 AND v.enabled) THEN operation:='delete';END IF;
 WHEN 'letter_merge_field_version' THEN
  native:='template';IF (row_data->>'ordinal')::integer>1 THEN operation:='edit';END IF;
  IF TG_OP='INSERT' AND NOT (row_data->>'active')::boolean AND EXISTS(SELECT 1 FROM public.letter_merge_field_version v WHERE v.tenant_id=app.current_tenant_id() AND v.company_id=co AND v.key=row_data->>'key' AND v.ordinal=(row_data->>'ordinal')::integer-1 AND v.active) THEN operation:='delete';END IF;
 WHEN 'letter_automation_rule_version' THEN
  native:='settings';IF (row_data->>'ordinal')::integer>1 THEN operation:='edit';END IF;
  IF TG_OP='INSERT' AND NOT (row_data->>'enabled')::boolean AND EXISTS(SELECT 1 FROM public.letter_automation_rule_version v WHERE v.tenant_id=app.current_tenant_id() AND v.company_id=co AND v.template_id=(row_data->>'template_id')::uuid AND v.trigger=row_data->>'trigger' AND v.ordinal=(row_data->>'ordinal')::integer-1 AND v.enabled) THEN operation:='delete';END IF;
  IF TG_OP='INSERT' AND (row_data->>'enabled')::boolean AND NOT app.access_letter_action(co,'generate','add') THEN RAISE EXCEPTION 'Letter automatic generation action unavailable' USING ERRCODE='42501';END IF;
 WHEN 'letter_template' THEN
  native:='template';IF TG_OP='UPDATE' AND (row_data->>'deactivated')::boolean AND NOT (old_data->>'deactivated')::boolean THEN operation:='delete';END IF;
 WHEN 'letter_template_version' THEN
  native:='template';
  IF TG_OP='INSERT' THEN operation:=coalesce(app.financial_letter_born('letter_template',(row_data->>'template_id')::uuid),'edit');
  ELSIF TG_OP='UPDATE' AND row_data->>'status' IN ('approved','rejected') THEN operation:='approve';
  ELSIF TG_OP='UPDATE' AND row_data->>'status'='submitted' THEN operation:=coalesce(app.financial_letter_born('letter_template_version',(row_data->>'id')::uuid),'edit');END IF;
 WHEN 'letter_template_field' THEN
  native:='template';SELECT v.company_id,app.financial_letter_born('letter_template_version',v.id) INTO co,parent_operation FROM public.letter_template_version v WHERE v.id=(row_data->>'template_version_id')::uuid AND v.tenant_id=app.current_tenant_id();
  operation:=coalesce(parent_operation,operation);
 WHEN 'letter_generation_batch' THEN native:='generate';
 WHEN 'letter_record' THEN
  native:='generate';
  IF TG_OP='UPDATE' THEN
   IF row_data->>'state' IN ('withdrawn','void') AND row_data->>'state' IS DISTINCT FROM old_data->>'state' THEN operation:='delete';native:=CASE row_data->>'state' WHEN 'void' THEN 'issue' ELSE 'generate' END;
   ELSIF row_data->>'state'='issued' AND old_data->>'state'='approved' THEN operation:='issue';native:='issue';
   ELSIF old_data->>'state'='submitted' AND row_data->>'state' IN ('submitted','approved','returned','rejected') THEN operation:='approve';native:='approve';
   ELSIF row_data->>'legal_hold' IS DISTINCT FROM old_data->>'legal_hold' OR row_data->>'retain_until' IS DISTINCT FROM old_data->>'retain_until' THEN native:='settings';
   ELSIF old_data->>'current_revision_id' IS NULL AND app.financial_letter_born('letter_record',(row_data->>'id')::uuid)='add' THEN operation:='add';END IF;
  END IF;
 WHEN 'letter_revision','letter_approval_decision','letter_artifact' THEN
  SELECT l.company_id INTO co FROM public.letter_record l WHERE l.id=(row_data->>'letter_id')::uuid AND l.tenant_id=app.current_tenant_id();
  IF TG_TABLE_NAME='letter_revision' THEN native:='generate';operation:=coalesce(app.financial_letter_born('letter_record',(row_data->>'letter_id')::uuid),'edit');
  ELSE native:='approve';operation:='approve';END IF;
 ELSE RAISE EXCEPTION 'Unbound letter action owner' USING ERRCODE='42501';
 END CASE;
 IF co IS NULL OR NOT app.access_letter_action(co,native,operation) THEN RAISE EXCEPTION 'Letter action unavailable' USING ERRCODE='42501';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.access_letter_write_guard() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.financial_letter_record_birth() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE operation text:='add';
BEGIN
 IF app.current_user_id() IS NULL THEN RETURN NEW;END IF;
 IF TG_TABLE_NAME='letter_template_version' THEN operation:=coalesce(app.financial_letter_born('letter_template',NEW.template_id),'edit');END IF;
 INSERT INTO app.financial_letter_birth VALUES(pg_current_xact_id(),NEW.tenant_id,app.current_user_id(),TG_TABLE_NAME,NEW.id,operation) ON CONFLICT DO NOTHING;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.financial_letter_record_birth() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
DO $$ DECLARE table_name text;BEGIN
 FOREACH table_name IN ARRAY ARRAY['letter_capability_grant','letter_asset','letter_policy_version','letter_merge_field_version','letter_automation_rule_version','letter_template','letter_template_version','letter_template_field','letter_generation_batch','letter_record','letter_revision','letter_approval_decision','letter_artifact'] LOOP
  EXECUTE format('CREATE TRIGGER financial_letter_action_write BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.access_letter_write_guard()',table_name);
 END LOOP;
 FOREACH table_name IN ARRAY ARRAY['letter_template','letter_template_version','letter_record'] LOOP
  EXECUTE format('CREATE TRIGGER financial_letter_record_birth AFTER INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION app.financial_letter_record_birth()',table_name);
 END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.access_compensation_action(p_employment uuid,p_operation text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.access_financial_action_employment('performance_compensation',p_employment,p_operation) OR
 (p_operation='add' AND app.data_permission_employment_born(p_employment)
  AND app.access_workforce_action_employment(p_employment,'add')
  AND EXISTS(SELECT 1 FROM public.employment e WHERE e.id=p_employment AND e.tenant_id=app.current_tenant_id()
   AND app.financial_letter_legacy_allowed(e.tenant_id,app.current_user_id(),'performance_compensation.add',e.company_id)));
$$;
REVOKE ALL ON FUNCTION app.access_compensation_action(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.access_compensation_action(uuid,text) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.access_financial_write_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE row_data jsonb;old_data jsonb;operation text;subject uuid;boundary boolean;
BEGIN
 IF app.acting_as_owner() THEN RETURN NULL;END IF;
 IF TG_OP='DELETE' THEN row_data:=to_jsonb(OLD);ELSE row_data:=to_jsonb(NEW);END IF;
 IF TG_OP='UPDATE' THEN old_data:=to_jsonb(OLD);END IF;
 IF row_data->>'tenant_id' IS DISTINCT FROM app.current_tenant_id()::text THEN RAISE EXCEPTION 'Financial action unavailable' USING ERRCODE='42501';END IF;
 PERFORM app.access_workforce_write_lock();
 IF TG_TABLE_NAME='compensation' THEN
  subject:=(row_data->>'employment_id')::uuid;
  operation:=CASE TG_OP WHEN 'INSERT' THEN 'add' WHEN 'DELETE' THEN 'delete' ELSE 'edit' END;
  IF TG_OP='UPDATE' AND old_data->>'superseded_at' IS NULL AND row_data->>'superseded_at' IS NOT NULL THEN
   operation:=CASE WHEN EXISTS(SELECT 1 FROM public.compensation c WHERE c.tenant_id=app.current_tenant_id() AND c.employment_id=subject AND c.id<>(row_data->>'id')::uuid AND c.valid_from=(row_data->>'valid_from')::date AND app.financial_letter_born('compensation',c.id)='add') THEN 'edit' ELSE 'delete' END;
  END IF;
  IF app.access_compensation_action(subject,operation) THEN RETURN NULL;END IF;
  -- A new dated version closes exactly the adjacent boundary. Add cannot change the
  -- prior salary's amount, dates other than its end, metadata or deletion status.
  boundary:=TG_OP='UPDATE' AND row_data-'valid_to' IS NOT DISTINCT FROM old_data-'valid_to';
  IF boundary AND EXISTS(SELECT 1 FROM public.compensation c WHERE c.tenant_id=app.current_tenant_id() AND c.employment_id=subject AND c.id<>(row_data->>'id')::uuid
    AND c.valid_from=(row_data->>'valid_to')::date AND c.superseded_at IS NULL AND app.financial_letter_born('compensation',c.id)='add')
   AND app.access_compensation_action(subject,'add') THEN RETURN NULL;END IF;
  -- Removing a version restores only its adjacent predecessor's original boundary.
  IF boundary AND EXISTS(SELECT 1 FROM public.compensation c WHERE c.tenant_id=app.current_tenant_id() AND c.employment_id=subject AND c.id<>(row_data->>'id')::uuid
    AND c.valid_from=(old_data->>'valid_to')::date AND to_jsonb(c)->>'valid_to' IS NOT DISTINCT FROM row_data->>'valid_to'
    AND app.financial_letter_born('compensation_deleted',c.id)='delete') AND app.access_compensation_action(subject,'delete') THEN RETURN NULL;END IF;
 END IF;
 RAISE EXCEPTION 'Financial action unavailable' USING ERRCODE='42501';
END;
$$;
REVOKE ALL ON FUNCTION app.access_financial_write_guard() FROM PUBLIC,ai_hr_app;
CREATE CONSTRAINT TRIGGER financial_action_write AFTER INSERT OR UPDATE OR DELETE ON compensation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.access_financial_write_guard();
--> statement-breakpoint
CREATE FUNCTION app.financial_compensation_birth() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.current_user_id() IS NULL THEN RETURN NEW;END IF;
 IF TG_OP='INSERT' THEN
  INSERT INTO app.financial_letter_birth VALUES(pg_current_xact_id(),NEW.tenant_id,app.current_user_id(),'compensation',NEW.id,'add') ON CONFLICT DO NOTHING;
 ELSIF OLD.superseded_at IS NULL AND NEW.superseded_at IS NOT NULL THEN
  INSERT INTO app.financial_letter_birth VALUES(pg_current_xact_id(),NEW.tenant_id,app.current_user_id(),'compensation_deleted',NEW.id,'delete') ON CONFLICT DO NOTHING;
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.financial_compensation_birth() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER financial_compensation_birth AFTER INSERT OR UPDATE ON compensation FOR EACH ROW EXECUTE FUNCTION app.financial_compensation_birth();
--> statement-breakpoint
CREATE TABLE app.financial_family_effect (
 transaction_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,person_id uuid NOT NULL,row_id uuid NOT NULL,
 before_hash text NOT NULL,after_hash text NOT NULL,PRIMARY KEY(transaction_id,tenant_id,user_id,row_id,before_hash,after_hash)
);
ALTER TABLE app.financial_family_effect ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.financial_family_effect FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Insert the receipt into the actual canonical derivation, preserving all existing caller,
-- eligibility, jurisdiction and audit owners (including approved/direct Profile adapters).
DO $$ DECLARE definition text;needle text:=' UPDATE public.employee_statutory_my SET num_children=derived,child_relief_table=grid,updated_at=now() WHERE id=stat.id AND tenant_id=t;';addition text;BEGIN
 definition:=pg_get_functiondef('app.my_sync_family_child_relief(uuid,timestamptz)'::regprocedure);
 IF (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'Canonical family derivation binding changed';END IF;
 addition:=$body$
 IF app.current_user_id() IS NOT NULL THEN
 INSERT INTO app.financial_family_effect(transaction_id,tenant_id,user_id,person_id,row_id,before_hash,after_hash)
 SELECT pg_current_xact_id(),t,app.current_user_id(),p_person,stat.id,
  encode(sha256(convert_to(to_jsonb(stat)::text,'UTF8')),'hex'),encode(sha256(convert_to(to_jsonb(updated)::text,'UTF8')),'hex')
 FROM public.employee_statutory_my updated WHERE updated.id=stat.id AND updated.tenant_id=t ON CONFLICT DO NOTHING;
 END IF;
$body$;
 EXECUTE replace(definition,needle,needle||addition);
END $$;
--> statement-breakpoint
CREATE FUNCTION app.access_financial_statutory_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE before_row jsonb:=CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
 after_row jsonb:=CASE WHEN TG_OP='DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;
 target uuid:=coalesce(NEW.person_id,OLD.person_id);delta jsonb;relevant boolean;operation text;
 ignored text[]:=ARRAY['id','tenant_id','person_id','created_at','updated_at','ic_number','old_ic_number','passport_number','passport_issue_date','passport_expiry_date','passport_issuing_country_code','passport_issuing_country','passport_remark','bank_name','bank_account_no','enable_custom_holder_name','custom_holder_name','enable_custom_holder_id','custom_holder_id'];
BEGIN
 IF app.acting_as_owner() THEN RETURN NULL;END IF;
 SELECT coalesce(jsonb_object_agg(d.key,d.value),'{}'::jsonb) INTO delta FROM jsonb_each(after_row)d WHERE d.key NOT IN ('id','tenant_id','person_id','created_at','updated_at') AND d.value IS DISTINCT FROM before_row->d.key;
 IF TG_OP='INSERT' THEN before_row:='{"tax_category":1,"tax_applicability_epoch":0,"num_children":0,"child_relief_mode":"manual","is_resident":true,"tax_residency":"resident","employer_bears_tax":false,"eis_eligible":true,"socso_category":"auto","eis_category":"auto","subject_to_socso":true,"subject_to_skbbk":false,"employer_bears_socso":false,"employer_bears_eis":false,"employer_bears_skbbk":false,"employer_bears_epf":false,"epf_citizenship":"citizen","epf_mode":"auto","enable_custom_holder_name":false,"enable_custom_holder_id":false,"zakat_active":false,"disabled_individual":false,"disabled_spouse":false}'::jsonb;END IF;
 SELECT EXISTS(SELECT 1 FROM jsonb_each(CASE WHEN TG_OP='DELETE' THEN before_row ELSE after_row END)d WHERE d.key<>ALL(ignored) AND (TG_OP='DELETE' OR d.value IS DISTINCT FROM coalesce(before_row->d.key,'null'::jsonb))) INTO relevant;
 IF NOT relevant THEN RETURN NULL;END IF;
 IF app.access_privacy_value_intent_allowed('statutory',before_row,after_row) THEN RETURN NULL;END IF;
 -- Direct ESS still needs the existing exact private, audited, deferred field witness.
 IF TG_OP<>'DELETE' AND app.profile_direct_person(target) THEN RETURN NULL;END IF;
 IF TG_OP<>'DELETE' AND app.profile_task_statutory_delta_approved(target,NEW.id,delta,TG_OP='INSERT') THEN RETURN NULL;END IF;
 IF TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM app.financial_family_effect proof WHERE proof.transaction_id=pg_current_xact_id() AND proof.tenant_id=app.current_tenant_id() AND proof.user_id=app.current_user_id() AND proof.person_id=target AND proof.row_id=NEW.id
  AND proof.before_hash=encode(sha256(convert_to(before_row::text,'UTF8')),'hex') AND proof.after_hash=encode(sha256(convert_to(after_row::text,'UTF8')),'hex')
  AND EXISTS(SELECT 1 FROM public.domain_event audit WHERE audit.tenant_id=proof.tenant_id AND audit.aggregate_id=proof.row_id AND audit.event_type='employee.tax.updated' AND audit.actor_id=proof.user_id
   AND audit.xmin::text=pg_current_xact_id()::text AND audit.payload->>'provenance'='auto_child_relief' AND audit.payload->>'personId'=target::text)) THEN RETURN NULL;END IF;
 IF TG_OP<>'DELETE' AND app.access_workforce_initial_person(target) THEN RETURN NULL;END IF;
 operation:=CASE WHEN TG_OP='DELETE' THEN 'delete' ELSE 'edit' END;
 IF app.principal_snapshot_current() AND EXISTS(SELECT 1 FROM public.employment e WHERE e.tenant_id=app.current_tenant_id() AND e.person_id=target)
 AND NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.tenant_id=app.current_tenant_id() AND e.person_id=target AND NOT app.access_financial_action_employment('payroll',e.id,operation)) THEN RETURN NULL;END IF;
 RAISE EXCEPTION 'Financial statutory action unavailable' USING ERRCODE='42501';
END;
$$;
REVOKE ALL ON FUNCTION app.access_financial_statutory_guard() FROM PUBLIC,ai_hr_app;
CREATE CONSTRAINT TRIGGER financial_statutory_action_write AFTER INSERT OR UPDATE OR DELETE ON employee_statutory_my DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.access_financial_statutory_guard();
--> statement-breakpoint
CREATE TABLE app.financial_batch_intent (
 transaction_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,batch_id uuid NOT NULL,company_id uuid NOT NULL,operation text NOT NULL CHECK(operation IN ('edit','delete')),
 PRIMARY KEY(transaction_id,tenant_id,user_id,batch_id,operation)
);
ALTER TABLE app.financial_batch_intent ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.financial_batch_intent FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.financial_batch_subjects_allowed(p_batch uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.payroll_batch b WHERE b.id=p_batch AND b.tenant_id=app.current_tenant_id()
 AND NOT EXISTS(SELECT 1 FROM (
  SELECT p.employment_id FROM public.payslip p WHERE p.batch_id=b.id AND p.tenant_id=b.tenant_id
  UNION SELECT i.employment_id FROM public.payroll_input i WHERE i.batch_id=b.id AND i.tenant_id=b.tenant_id
  UNION SELECT c.employment_id FROM public.payroll_batch_component c WHERE c.batch_id=b.id AND c.tenant_id=b.tenant_id
  UNION SELECT t.employment_id FROM public.payroll_individual_txn t WHERE (t.batch_id=b.id OR t.consumed_batch_id=b.id) AND t.tenant_id=b.tenant_id
  UNION SELECT (picked.value)::uuid FROM jsonb_array_elements_text(coalesce(b.scope->'employmentIds','[]'))picked(value)
 ) subject WHERE subject.employment_id IS NULL OR NOT app.data_permission_matches(subject.employment_id)));
$$;
REVOKE ALL ON FUNCTION app.financial_batch_subjects_allowed(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.access_payroll_batch_begin(p_batch uuid,p_operation text,p_targets uuid[] DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE batch public.payroll_batch;starts date;ends date;
BEGIN
 PERFORM app.access_workforce_write_lock();
 SELECT * INTO batch FROM public.payroll_batch b WHERE b.id=p_batch AND b.tenant_id=app.current_tenant_id() FOR UPDATE;
 IF batch.id IS NULL OR p_operation NOT IN ('edit','delete') OR NOT app.access_financial_action_company('payroll',batch.company_id,p_operation) OR NOT app.financial_batch_subjects_allowed(batch.id) THEN RAISE EXCEPTION 'Payroll action unavailable' USING ERRCODE='42501';END IF;
 starts:=(batch.pay_period||'-01')::date;ends:=(starts+interval '1 month'-interval '1 day')::date;
 -- Actual process membership mirrors employedByCompanyDuring + resolveBatchScopeFilter.
 -- Querying as the private owner prevents RLS from silently shrinking a requested payroll.
 IF EXISTS(SELECT 1 FROM public.employment e WHERE e.tenant_id=batch.tenant_id
  AND (p_targets IS NULL OR e.id=ANY(p_targets))
  AND (p_targets IS NOT NULL OR (coalesce(jsonb_array_length(batch.scope->'employmentIds'),0)=0 AND coalesce(jsonb_array_length(batch.scope->'departmentIds'),0)=0)
   OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(coalesce(batch.scope->'employmentIds','[]'))picked(value) WHERE picked.value=e.id::text)
   OR EXISTS(SELECT 1 FROM public.assignment a JOIN jsonb_array_elements_text(coalesce(batch.scope->'departmentIds','[]'))picked(value) ON a.department_id::text=picked.value WHERE a.employment_id=e.id AND a.tenant_id=e.tenant_id AND a.superseded_at IS NULL))
  AND e.hired_on<=ends AND (e.terminated_on IS NULL OR e.terminated_on>=starts)
  AND (e.company_id=batch.company_id OR EXISTS(SELECT 1 FROM public.assignment a WHERE a.employment_id=e.id AND a.tenant_id=e.tenant_id AND a.superseded_at IS NULL AND a.company_id=batch.company_id AND a.valid_from<=ends AND (a.valid_to IS NULL OR a.valid_to>starts)))
  AND NOT app.access_financial_action_employment('payroll',e.id,p_operation))
 OR p_targets IS NOT NULL AND EXISTS(SELECT 1 FROM unnest(p_targets)target(id) WHERE NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.id=target.id AND e.tenant_id=batch.tenant_id AND app.access_financial_action_employment('payroll',e.id,p_operation)))
 THEN RAISE EXCEPTION 'Payroll scope unavailable' USING ERRCODE='42501';END IF;
 INSERT INTO app.financial_batch_intent VALUES(pg_current_xact_id(),batch.tenant_id,app.current_user_id(),batch.id,batch.company_id,p_operation) ON CONFLICT DO NOTHING;
END;
$$;
REVOKE ALL ON FUNCTION app.access_payroll_batch_begin(uuid,text,uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.access_payroll_batch_begin(uuid,text,uuid[]) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.financial_batch_intent_allowed(p_batch uuid,p_operation text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app.financial_batch_intent proof WHERE proof.transaction_id=pg_current_xact_id() AND proof.tenant_id=app.current_tenant_id() AND proof.user_id=app.current_user_id() AND proof.batch_id=p_batch AND proof.operation=p_operation
 AND app.access_financial_action_company('payroll',proof.company_id,proof.operation));
$$;
REVOKE ALL ON FUNCTION app.financial_batch_intent_allowed(uuid,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- The administrative aggregate reader is bound below alongside the bounded ESS projection;
-- no broad raw-batch SELF exception is introduced.

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.access_can_delegate(p_capability text,p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.access_capability c
  JOIN public.app_user u ON u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id()
  WHERE c.id=p_capability AND (p_capability !~ '^(payroll|performance_compensation|letters)\.' OR app.financial_letter_delegation_allowed(u.tenant_id,u.id,p_capability,p_company)) AND (p_capability !~ '^(payroll|performance_compensation)\.' OR app.access_financial_action_company(split_part(p_capability,'.',1),p_company,split_part(p_capability,'.',2))) AND (p_capability !~ '^[a-z][a-z0-9_]*\.(add|edit|delete|approve|issue)$' OR app.access_can_delegate(split_part(p_capability,'.',1)||'.view',p_company)) AND c.supported AND jsonb_array_length(c.bindings)>0
   AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
   AND CASE WHEN c.scope='tenant' THEN p_company IS NULL AND app.access_allowed_for(u.id,c.id,NULL)
    WHEN p_company IS NOT NULL THEN app.access_allowed_for(u.id,c.id,p_company)
    ELSE EXISTS(SELECT 1 FROM public.access_configuration s WHERE s.tenant_id=u.tenant_id AND s.initialized)
     AND (EXISTS(SELECT 1 FROM public.access_user_override o WHERE o.tenant_id=u.tenant_id AND o.user_id=u.id AND o.capability_id=c.id AND o.company_id IS NULL AND o.effect='allow' AND o.retired_at IS NULL)
      OR EXISTS(SELECT 1 FROM public.access_effective_membership m JOIN public.access_group g ON g.id=m.group_id AND g.tenant_id=m.tenant_id
       JOIN public.access_group_grant a ON a.group_id=g.id AND a.tenant_id=g.tenant_id
       WHERE m.tenant_id=u.tenant_id AND m.user_id=u.id AND m.company_id IS NULL
        AND g.retired_at IS NULL AND a.capability_id=c.id AND a.company_id IS NULL AND a.retired_at IS NULL)) END
   AND NOT EXISTS(SELECT 1 FROM public.access_user_override o
    WHERE o.tenant_id=u.tenant_id AND o.user_id=u.id AND o.capability_id=c.id AND o.effect='deny' AND o.retired_at IS NULL
     AND (p_company IS NULL OR o.company_id IS NULL
      OR app.access_scope_covers(o.company_id,p_company,u.tenant_id)
      OR app.access_scope_covers(p_company,o.company_id,u.tenant_id)))
 );
$$;

--> statement-breakpoint
INSERT INTO app.access_default_capability_grant(legacy_key,capability_id) VALUES
 ('hr_admin','payroll.view'),
 ('hr_admin','payroll.add'),
 ('hr_admin','payroll.edit'),
 ('hr_admin','payroll.delete'),
 ('payroll_partner','payroll.view'),
 ('payroll_partner','payroll.add'),
 ('payroll_partner','payroll.edit'),
 ('payroll_partner','payroll.delete'),
 ('hr_admin','performance_compensation.view'),
 ('hr_admin','performance_compensation.add'),
 ('hr_admin','performance_compensation.edit'),
 ('hr_admin','performance_compensation.delete'),
 ('performance_comp_partner','performance_compensation.view'),
 ('performance_comp_partner','performance_compensation.add'),
 ('performance_comp_partner','performance_compensation.edit'),
 ('performance_comp_partner','performance_compensation.delete'),
 ('hr_admin','letters.view'),
 ('hr_admin','letters.add'),
 ('hr_admin','letters.edit'),
 ('hr_admin','letters.delete'),
 ('hr_admin','letters.approve'),
 ('hr_admin','letters.issue') ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE TABLE app.letter_operation_effect (
 transaction_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,letter_id uuid NOT NULL,company_id uuid NOT NULL,native_capability text NOT NULL,operation text NOT NULL,
 PRIMARY KEY(transaction_id,tenant_id,user_id,letter_id,native_capability,operation)
);
ALTER TABLE app.letter_operation_effect ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.letter_operation_effect FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.letter_operation_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE operation text:='edit';native text:='generate';
BEGIN
 IF app.current_user_id() IS NULL THEN RETURN NEW;END IF;
 IF TG_OP='INSERT' THEN operation:='add';
 ELSIF NEW.state IN ('withdrawn','void') AND NEW.state IS DISTINCT FROM OLD.state THEN operation:='delete';IF NEW.state='void' THEN native:='issue';END IF;
 ELSIF NEW.state='issued' AND OLD.state='approved' THEN operation:='issue';native:='issue';
 ELSIF OLD.state='submitted' AND NEW.state IN ('submitted','approved','returned','rejected') THEN operation:='approve';native:='approve';
 ELSIF NEW.legal_hold IS DISTINCT FROM OLD.legal_hold OR NEW.retain_until IS DISTINCT FROM OLD.retain_until THEN native:='settings';
 ELSIF OLD.current_revision_id IS NULL AND app.financial_letter_born('letter_record',NEW.id)='add' THEN operation:='add';END IF;
 INSERT INTO app.letter_operation_effect VALUES(pg_current_xact_id(),NEW.tenant_id,app.current_user_id(),NEW.id,NEW.company_id,native,operation) ON CONFLICT DO NOTHING;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.letter_operation_record() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER letter_operation_effect AFTER INSERT OR UPDATE ON letter_record FOR EACH ROW EXECUTE FUNCTION app.letter_operation_record();
--> statement-breakpoint
CREATE FUNCTION app.access_letter_job_action_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE data jsonb:=to_jsonb(NEW);
BEGIN
 IF app.current_user_id() IS NULL AND app.letter_notification_storage_owner() THEN RETURN NULL;END IF;
 IF NOT app.principal_snapshot_current() OR NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR TG_OP='DELETE' OR NEW.letter_id IS NULL THEN RAISE EXCEPTION 'Letter delivery consequence unavailable' USING ERRCODE='42501';END IF;
 IF TG_OP='UPDATE' AND (NEW.status<>'cancelled' OR NEW.lease_token IS NOT NULL OR NEW.lease_until IS NOT NULL
  OR data-ARRAY['status','lease_token','lease_until','last_error'] IS DISTINCT FROM to_jsonb(OLD)-ARRAY['status','lease_token','lease_until','last_error']) THEN RAISE EXCEPTION 'Letter cancellation consequence unavailable' USING ERRCODE='42501';END IF;
 IF NOT EXISTS(SELECT 1 FROM app.letter_operation_effect proof WHERE proof.transaction_id=pg_current_xact_id() AND proof.tenant_id=NEW.tenant_id AND proof.user_id=app.current_user_id() AND proof.letter_id=NEW.letter_id AND proof.company_id=NEW.company_id
  AND app.access_letter_action(proof.company_id,proof.native_capability,proof.operation)
  AND (TG_OP<>'UPDATE' OR proof.operation IN ('delete','approve'))
  AND (TG_OP='UPDATE' OR EXISTS(SELECT 1 FROM public.domain_event audit WHERE audit.id=NEW.source_event_id AND audit.tenant_id=NEW.tenant_id AND audit.aggregate_id=NEW.letter_id AND audit.aggregate_type='letter' AND audit.actor_id=app.current_user_id() AND audit.xmin::text=pg_current_xact_id()::text
   AND (proof.operation='edit' AND audit.event_type='letter.submitted' OR proof.operation='approve' AND audit.event_type IN ('letter.approval.approve','letter.approval.reject','letter.approval.return','letter.approval.delegated') OR proof.operation='issue' AND audit.event_type='letter.issued'))))
 THEN RAISE EXCEPTION 'Letter delivery consequence unavailable' USING ERRCODE='42501';END IF;
 RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION app.access_letter_job_action_guard() FROM PUBLIC,ai_hr_app;
CREATE CONSTRAINT TRIGGER financial_letter_job_action AFTER INSERT OR UPDATE OR DELETE ON letter_job DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.access_letter_job_action_guard();
--> statement-breakpoint
CREATE FUNCTION app.access_letter_counter_action_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.current_user_id() IS NULL AND app.letter_notification_storage_owner() AND app.letter_automation_insert_allowed('letter_counter',to_jsonb(NEW)||jsonb_build_object('next_value',1)) THEN RETURN NEW;END IF;
 IF NOT app.principal_snapshot_current() OR NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NOT EXISTS(SELECT 1 FROM public.company c WHERE c.tenant_id=NEW.tenant_id AND app.access_letter_action(c.id,'generate','add')) THEN RAISE EXCEPTION 'Letter reference allocation unavailable' USING ERRCODE='42501';END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.access_letter_counter_action_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER financial_letter_counter_action BEFORE INSERT OR UPDATE ON letter_counter FOR EACH ROW EXECUTE FUNCTION app.access_letter_counter_action_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.letter_automation_owner_eligible_at(wanted_tenant uuid,subject uuid,co uuid,confidential boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.letter_creator_eligible_at(wanted_tenant,subject,co,confidential)
 AND app.access_letter_action_for_user(wanted_tenant,subject,co,'generate','add')
 AND EXISTS(SELECT 1 FROM public.role_assignment r JOIN public.access_capability c ON c.id='workforce.view'
  WHERE r.tenant_id=wanted_tenant AND r.app_user_id=subject AND r.role::text IN ('hr_admin','super_admin') AND app.access_scope_covers(r.company_id,co,wanted_tenant)
  AND (NOT c.supported OR app.access_allowed_for_tenant(wanted_tenant,subject,c.id,co)));
$$;
--> statement-breakpoint
CREATE TABLE app.financial_kernel_context (
 transaction_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,table_name text NOT NULL,before_hash text NOT NULL,after_hash text NOT NULL,
 company_id uuid,old_company_id uuid,employment_id uuid,batch_id uuid,
 PRIMARY KEY(transaction_id,tenant_id,user_id,table_name,before_hash,after_hash)
);
ALTER TABLE app.financial_kernel_context ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.financial_kernel_context FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.financial_kernel_context_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE before_row jsonb:=CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
 after_row jsonb:=CASE WHEN TG_OP='DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;
 data jsonb:=CASE WHEN TG_OP='DELETE' THEN before_row ELSE after_row END;co uuid;old_co uuid;batch uuid;
BEGIN
 IF app.acting_as_owner() THEN IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;END IF;
 IF data->>'tenant_id' IS DISTINCT FROM app.current_tenant_id()::text OR NOT app.principal_snapshot_current() THEN RAISE EXCEPTION 'Financial context unavailable' USING ERRCODE='42501';END IF;
 co:=(data->>'company_id')::uuid;old_co:=(before_row->>'company_id')::uuid;
 batch:=CASE WHEN TG_TABLE_NAME='payroll_batch' THEN (data->>'id')::uuid ELSE (data->>'batch_id')::uuid END;
 IF co IS NULL AND batch IS NOT NULL THEN SELECT b.company_id INTO co FROM public.payroll_batch b WHERE b.id=batch AND b.tenant_id=app.current_tenant_id();END IF;
 IF co IS NULL THEN RAISE EXCEPTION 'Financial parent unavailable' USING ERRCODE='42501';END IF;
 INSERT INTO app.financial_kernel_context VALUES(pg_current_xact_id(),app.current_tenant_id(),app.current_user_id(),TG_TABLE_NAME,
 encode(sha256(convert_to(before_row::text,'UTF8')),'hex'),encode(sha256(convert_to(after_row::text,'UTF8')),'hex'),co,old_co,(data->>'employment_id')::uuid,batch) ON CONFLICT DO NOTHING;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.financial_kernel_context_record() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.access_payroll_kernel_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE before_row jsonb:=CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
 after_row jsonb:=CASE WHEN TG_OP='DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;
 data jsonb:=CASE WHEN TG_OP='DELETE' THEN before_row ELSE after_row END;context app.financial_kernel_context;operation text;
BEGIN
 IF app.acting_as_owner() THEN RETURN NULL;END IF;
 SELECT * INTO context FROM app.financial_kernel_context proof WHERE proof.transaction_id=pg_current_xact_id() AND proof.tenant_id=app.current_tenant_id() AND proof.user_id=app.current_user_id() AND proof.table_name=TG_TABLE_NAME
 AND proof.before_hash=encode(sha256(convert_to(before_row::text,'UTF8')),'hex') AND proof.after_hash=encode(sha256(convert_to(after_row::text,'UTF8')),'hex');
 IF context.company_id IS NULL THEN RAISE EXCEPTION 'Financial consequence unavailable' USING ERRCODE='42501';END IF;
 IF to_regprocedure('app.financial_history_kernel_approved(text,jsonb,jsonb)') IS NOT NULL THEN
  IF app.financial_history_kernel_approved(TG_TABLE_NAME,before_row,after_row) THEN RETURN NULL;END IF;
 END IF;
 IF TG_TABLE_NAME='payroll_batch' AND TG_OP='UPDATE' THEN
  IF EXISTS(SELECT 1 FROM app.financial_stale_effect proof WHERE proof.transaction_id=pg_current_xact_id() AND proof.tenant_id=app.current_tenant_id() AND proof.user_id=app.current_user_id() AND proof.batch_id=(data->>'id')::uuid
   AND proof.before_hash=encode(sha256(convert_to(before_row::text,'UTF8')),'hex') AND proof.after_hash=encode(sha256(convert_to(after_row::text,'UTF8')),'hex')) THEN RETURN NULL;END IF;
  IF to_regprocedure('app.leave_task_payroll_approved(uuid,jsonb,jsonb)') IS NOT NULL THEN
   IF app.leave_task_payroll_approved((data->>'id')::uuid,before_row,after_row) THEN RETURN NULL;END IF;
  END IF;
 END IF;
 operation:=CASE TG_OP WHEN 'INSERT' THEN 'add' WHEN 'DELETE' THEN 'delete' ELSE 'edit' END;
 IF TG_TABLE_NAME IN ('payroll_input','payroll_status_history','payroll_employee_result_history','payroll_reprocess_job','payroll_step_up_challenge') THEN operation:='edit';END IF;
 IF TG_TABLE_NAME='payslip' THEN operation:=CASE WHEN TG_OP='DELETE' THEN 'delete' ELSE 'edit' END;END IF;
 IF TG_TABLE_NAME='payroll_batch' AND (NOT app.financial_payroll_scope_allowed(context.company_id,data->'scope',operation,data->>'pay_period') OR TG_OP='UPDATE' AND NOT app.financial_payroll_scope_allowed(coalesce(context.old_company_id,context.company_id),before_row->'scope',operation,before_row->>'pay_period')) THEN RAISE EXCEPTION 'Payroll scope unavailable' USING ERRCODE='42501';END IF;
 IF TG_TABLE_NAME='payroll_batch' AND TG_OP='INSERT' AND (data->>'status'<>'draft' OR (data->>'employee_count')::integer<>0 OR data->>'totals' IS NOT NULL OR data->>'closed_at' IS NOT NULL OR data->>'released_at' IS NOT NULL OR data->>'needs_recalc_at' IS NOT NULL OR data->>'recalc_employment_ids' IS NOT NULL) THEN RAISE EXCEPTION 'New payroll runs must start as empty drafts' USING ERRCODE='42501';END IF;
 -- Direct logical action on this row remains sufficient; target scope is always checked.
 IF app.access_financial_action_company('payroll',context.company_id,operation)
 AND (context.old_company_id IS NULL OR app.access_financial_action_company('payroll',context.old_company_id,operation))
 AND (context.employment_id IS NULL OR app.access_financial_action_employment('payroll',context.employment_id,operation)) THEN
  IF TG_TABLE_NAME='payroll_batch' AND TG_OP='UPDATE' THEN PERFORM app.access_payroll_batch_begin((data->>'id')::uuid,'edit');END IF;
  RETURN NULL;
 END IF;
 -- Batch teardown consumes only an actual native Delete intent bound to this same root.
 IF TG_OP='DELETE' AND app.financial_batch_intent_allowed(context.batch_id,'delete')
 AND (context.employment_id IS NULL OR app.access_financial_action_employment('payroll',context.employment_id,'delete')) THEN RETURN NULL;END IF;
 -- Process results are derived Edit materializations. Deleting a slip under Edit must
 -- replace that employee's materialization or finish the canonical whole-run reset.
 IF TG_TABLE_NAME='payslip' AND TG_OP='DELETE' AND app.financial_batch_intent_allowed(context.batch_id,'edit') AND app.access_financial_action_employment('payroll',context.employment_id,'edit')
 AND (EXISTS(SELECT 1 FROM public.payslip p WHERE p.tenant_id=app.current_tenant_id() AND p.batch_id=context.batch_id AND p.employment_id=context.employment_id)
  OR EXISTS(SELECT 1 FROM public.payroll_batch b JOIN public.domain_event audit ON audit.aggregate_id=b.id AND audit.tenant_id=b.tenant_id AND audit.event_type='payroll-batch.reset' AND audit.actor_id=app.current_user_id() AND audit.xmin::text=pg_current_xact_id()::text WHERE b.id=context.batch_id AND b.tenant_id=app.current_tenant_id() AND b.status='draft')) THEN RETURN NULL;END IF;
 RAISE EXCEPTION 'Payroll action unavailable' USING ERRCODE='42501';
END;
$$;
REVOKE ALL ON FUNCTION app.access_payroll_kernel_guard() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
DO $$ DECLARE table_name text;BEGIN
 FOREACH table_name IN ARRAY ARRAY['payroll_batch','pay_period','payslip','payroll_input','payroll_batch_component','payroll_statutory_adjustment','payroll_status_history','payroll_employee_result_history','payroll_reprocess_job','payroll_step_up_challenge'] LOOP
  EXECUTE format('CREATE TRIGGER financial_kernel_context AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.financial_kernel_context_record()',table_name);
  EXECUTE format('CREATE CONSTRAINT TRIGGER financial_kernel_action AFTER INSERT OR UPDATE OR DELETE ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.access_payroll_kernel_guard()',table_name);
 END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.financial_payroll_scope_allowed(p_company uuid,p_scope jsonb,p_operation text,p_period text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE field text;
BEGIN
 IF p_scope IS NULL OR p_scope='null'::jsonb THEN RETURN true;END IF;
 IF jsonb_typeof(p_scope)<>'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_scope)keys(key) WHERE keys.key NOT IN ('employmentIds','departmentIds')) THEN RETURN false;END IF;
 FOREACH field IN ARRAY ARRAY['employmentIds','departmentIds'] LOOP
  IF p_scope?field AND (jsonb_typeof(p_scope->field)<>'array' OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_scope->field)choice WHERE jsonb_typeof(choice)<>'string' OR (choice#>>'{}') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')) THEN RETURN false;END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(coalesce(p_scope->'employmentIds','[]'))choice(id)
  WHERE NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.id=choice.id::uuid AND e.tenant_id=app.current_tenant_id() AND app.access_financial_action_employment('payroll',e.id,p_operation)
   AND (e.company_id=p_company OR EXISTS(SELECT 1 FROM public.assignment a WHERE a.employment_id=e.id AND a.tenant_id=e.tenant_id AND a.superseded_at IS NULL AND a.company_id=p_company AND a.valid_from<=((p_period||'-01')::date+interval '1 month'-interval '1 day')::date AND (a.valid_to IS NULL OR a.valid_to>(p_period||'-01')::date)))))
 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(coalesce(p_scope->'departmentIds','[]'))choice(id)
  WHERE NOT EXISTS(SELECT 1 FROM public.department d WHERE d.id=choice.id::uuid AND d.tenant_id=app.current_tenant_id() AND d.company_id=p_company)) THEN RETURN false;END IF;
 RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION app.financial_payroll_scope_allowed(uuid,jsonb,text,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- An actual source mutation can mark its paid materializations stale without granting
-- the source editor Payroll Edit or exposing another employee's payroll totals.
CREATE TABLE app.financial_source_change (
 transaction_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,employment_id uuid NOT NULL,category text NOT NULL,effective_from date,
 PRIMARY KEY(transaction_id,tenant_id,user_id,employment_id,category)
);
CREATE TABLE app.financial_stale_effect (
 transaction_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,batch_id uuid NOT NULL,before_hash text NOT NULL,after_hash text NOT NULL,
 PRIMARY KEY(transaction_id,tenant_id,user_id,batch_id,before_hash,after_hash)
);
ALTER TABLE app.financial_source_change ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.financial_stale_effect ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.financial_source_change,app.financial_stale_effect FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.financial_source_change_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE before_row jsonb:=CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
 after_row jsonb:=CASE WHEN TG_OP='DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;
 data jsonb:=CASE WHEN TG_OP='DELETE' THEN before_row ELSE after_row END;source_category text;categories text[];subject uuid;person uuid;starts date;
BEGIN
 IF app.acting_as_owner() OR app.current_user_id() IS NULL OR before_row-ARRAY['created_at','updated_at','recorded_at'] IS NOT DISTINCT FROM after_row-ARRAY['created_at','updated_at','recorded_at'] THEN RETURN NULL;END IF;
 IF data->>'tenant_id' IS DISTINCT FROM app.current_tenant_id()::text THEN RAISE EXCEPTION 'Source mutation tenant changed' USING ERRCODE='42501';END IF;
 CASE TG_TABLE_NAME
 WHEN 'compensation' THEN source_category:='compensation';subject:=(data->>'employment_id')::uuid;starts:=least((before_row->>'valid_from')::date,(after_row->>'valid_from')::date);
 WHEN 'employment_pay_component' THEN source_category:='compensation';subject:=(data->>'employment_id')::uuid;starts:=least((before_row->>'valid_from')::date,(after_row->>'valid_from')::date);
 WHEN 'employee_statutory_my' THEN source_category:='statutory';person:=(data->>'person_id')::uuid;
 WHEN 'person' THEN
  IF NOT EXISTS(SELECT 1 FROM unnest(ARRAY['full_name','date_of_birth','gender','nationality','marital_status'])field(name) WHERE before_row->field.name IS DISTINCT FROM after_row->field.name) THEN RETURN NULL;END IF;
  source_category:='statutory';person:=(data->>'id')::uuid;
 WHEN 'employment' THEN
  IF NOT EXISTS(SELECT 1 FROM unnest(ARRAY['company_id','hired_on','terminated_on','resignation_date','last_working_date','employment_type','grade_id'])field(name) WHERE before_row->field.name IS DISTINCT FROM after_row->field.name) THEN RETURN NULL;END IF;
  source_category:=CASE WHEN before_row->>'company_id' IS DISTINCT FROM after_row->>'company_id' THEN 'transfer' WHEN before_row->>'hired_on' IS DISTINCT FROM after_row->>'hired_on' THEN 'hire_date' ELSE 'termination' END;
  subject:=(data->>'id')::uuid;starts:=least((before_row->>'hired_on')::date,(after_row->>'hired_on')::date);
  categories:=ARRAY[]::text[];
  IF before_row->>'company_id' IS DISTINCT FROM after_row->>'company_id' OR before_row->>'employment_type' IS DISTINCT FROM after_row->>'employment_type' OR before_row->>'grade_id' IS DISTINCT FROM after_row->>'grade_id' THEN categories:=array_append(categories,'transfer');END IF;
  IF before_row->>'hired_on' IS DISTINCT FROM after_row->>'hired_on' THEN categories:=array_append(categories,'hire_date');END IF;
  IF EXISTS(SELECT 1 FROM unnest(ARRAY['terminated_on','resignation_date','last_working_date'])field(name) WHERE before_row->field.name IS DISTINCT FROM after_row->field.name) THEN categories:=array_append(categories,'termination');END IF;
 WHEN 'assignment' THEN source_category:='transfer';subject:=(data->>'employment_id')::uuid;starts:=least((before_row->>'valid_from')::date,(after_row->>'valid_from')::date);
 ELSE RAISE EXCEPTION 'Unbound payroll source mutation';
 END CASE;
 IF categories IS NULL THEN categories:=ARRAY[source_category];END IF;
 INSERT INTO app.financial_source_change(transaction_id,tenant_id,user_id,employment_id,category,effective_from)
 SELECT pg_current_xact_id(),app.current_tenant_id(),app.current_user_id(),e.id,class.value,starts FROM public.employment e CROSS JOIN unnest(categories)class(value)
 WHERE e.tenant_id=app.current_tenant_id() AND (e.id=subject OR e.person_id=person)
 ON CONFLICT(transaction_id,tenant_id,user_id,employment_id,category) DO UPDATE SET effective_from=CASE WHEN app.financial_source_change.effective_from IS NULL OR excluded.effective_from IS NULL THEN NULL ELSE least(app.financial_source_change.effective_from,excluded.effective_from) END;
 RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION app.financial_source_change_record() FROM PUBLIC,ai_hr_app;
DO $$ DECLARE table_name text;BEGIN
 FOREACH table_name IN ARRAY ARRAY['compensation','employment_pay_component','employee_statutory_my','person','employment','assignment'] LOOP
  EXECUTE format('CREATE TRIGGER financial_source_change AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.financial_source_change_record()',table_name);
 END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.financial_mark_source_payroll_stale(p_employments uuid[],p_category text,p_from date DEFAULT NULL) RETURNS TABLE(batch_id uuid,employment_ids uuid[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE batch public.payroll_batch;before_row jsonb;after_row jsonb;targets uuid[];combined jsonb;starts date;
BEGIN
 PERFORM app.access_workforce_write_lock();
 IF NOT app.principal_snapshot_current() OR p_category NOT IN ('compensation','statutory','transfer','hire_date','termination') OR p_employments IS NULL OR cardinality(p_employments)=0 THEN RAISE EXCEPTION 'Payroll source consequence unavailable' USING ERRCODE='42501';END IF;
 IF NOT EXISTS(SELECT 1 FROM app.financial_source_change proof WHERE proof.transaction_id=pg_current_xact_id() AND proof.tenant_id=app.current_tenant_id() AND proof.user_id=app.current_user_id() AND proof.employment_id=ANY(p_employments) AND proof.category=p_category) THEN RETURN;END IF;
 IF EXISTS(SELECT 1 FROM unnest(p_employments)target(id) WHERE NOT EXISTS(SELECT 1 FROM app.financial_source_change proof WHERE proof.transaction_id=pg_current_xact_id() AND proof.tenant_id=app.current_tenant_id() AND proof.user_id=app.current_user_id() AND proof.employment_id=target.id AND proof.category=p_category))
 THEN RAISE EXCEPTION 'Payroll source consequence unavailable' USING ERRCODE='42501';END IF;
 FOR batch IN SELECT b.* FROM public.payroll_batch b WHERE b.tenant_id=app.current_tenant_id() AND b.status='processed' AND (p_from IS NULL OR ((b.pay_period||'-01')::date+interval '1 month'-interval '1 day')::date>=p_from)
 AND EXISTS(SELECT 1 FROM public.payslip p JOIN app.financial_source_change proof ON proof.employment_id=p.employment_id AND proof.tenant_id=p.tenant_id AND proof.transaction_id=pg_current_xact_id() AND proof.user_id=app.current_user_id() AND proof.category=p_category
  WHERE p.batch_id=b.id AND p.tenant_id=b.tenant_id AND p.employment_id=ANY(p_employments) AND (proof.effective_from IS NULL OR ((b.pay_period||'-01')::date+interval '1 month'-interval '1 day')::date>=proof.effective_from)) ORDER BY b.id FOR UPDATE LOOP
  SELECT array_agg(DISTINCT p.employment_id ORDER BY p.employment_id) INTO targets FROM public.payslip p JOIN app.financial_source_change proof ON proof.employment_id=p.employment_id AND proof.tenant_id=p.tenant_id AND proof.transaction_id=pg_current_xact_id() AND proof.user_id=app.current_user_id() AND proof.category=p_category
  WHERE p.batch_id=batch.id AND p.tenant_id=batch.tenant_id AND p.employment_id=ANY(p_employments) AND (proof.effective_from IS NULL OR ((batch.pay_period||'-01')::date+interval '1 month'-interval '1 day')::date>=proof.effective_from);
  SELECT jsonb_agg(value ORDER BY value) INTO combined FROM(SELECT DISTINCT value FROM jsonb_array_elements_text(coalesce(batch.recalc_employment_ids,'[]'))existing(value) UNION SELECT target::text FROM unnest(targets)target)selected;
  before_row:=to_jsonb(batch);
  UPDATE public.payroll_batch b SET needs_recalc_at=coalesce(b.needs_recalc_at,now()),recalc_employment_ids=combined WHERE b.id=batch.id AND b.tenant_id=batch.tenant_id RETURNING to_jsonb(b) INTO after_row;
  INSERT INTO app.financial_stale_effect VALUES(pg_current_xact_id(),batch.tenant_id,app.current_user_id(),batch.id,encode(sha256(convert_to(before_row::text,'UTF8')),'hex'),encode(sha256(convert_to(after_row::text,'UTF8')),'hex')) ON CONFLICT DO NOTHING;
  INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload) VALUES(batch.tenant_id,'payroll-batch',batch.id,'payroll-batch.recalc-required','user',app.current_user_id(),jsonb_build_object('employmentIds',combined,'addedEmploymentIds',to_jsonb(targets),'changeCategory',p_category));
  -- Return only administrative metadata the actual actor could already read.
  IF app.can_admin_payroll_for(batch.company_id) AND app.financial_batch_subjects_allowed(batch.id) THEN batch_id:=batch.id;employment_ids:=targets;RETURN NEXT;END IF;
 END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION app.financial_mark_source_payroll_stale(uuid[],text,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.financial_mark_source_payroll_stale(uuid[],text,date) TO ai_hr_app;
--> statement-breakpoint
-- A document reader needs run identity/release metadata, never another employee's totals,
-- population or selection. Keep that bounded projection separate from administrative aggregates.
CREATE VIEW public.payroll_document_batch WITH(security_barrier=true) AS
 SELECT b.id,b.tenant_id,b.company_id,b.pay_period_id,b.run_seq,b.run_type,b.pay_period,b.batch_date,b.status,b.closed_at,b.released_at,b.payroll_cycle_id,b.history_import_attempt_id,b.history_import_cycle_name,b.needs_recalc_at,b.created_at
 FROM public.payroll_batch b WHERE b.tenant_id=app.current_tenant_id() AND app.principal_snapshot_current()
 AND EXISTS(SELECT 1 FROM public.payslip p JOIN public.employment e ON e.id=p.employment_id AND e.tenant_id=p.tenant_id
  WHERE p.batch_id=b.id AND p.tenant_id=b.tenant_id AND (app.can_admin_payroll_employment(e.id) OR app.is_self_person(e.person_id)));
REVOKE ALL ON public.payroll_document_batch FROM PUBLIC,ai_hr_app;
GRANT SELECT ON public.payroll_document_batch TO ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.financial_batch_subjects_allowed(p_batch uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 -- INSERT RETURNING checks the proposed new root before a STABLE self-query can see it.
 -- The independent typed Add guard checks its posted scope before transaction commit.
 SELECT NOT EXISTS(SELECT 1 FROM public.payroll_batch b WHERE b.id=p_batch)
 OR EXISTS(SELECT 1 FROM public.payroll_batch b WHERE b.id=p_batch AND b.tenant_id=app.current_tenant_id()
 AND NOT EXISTS(SELECT 1 FROM (
  SELECT p.employment_id FROM public.payslip p WHERE p.batch_id=b.id AND p.tenant_id=b.tenant_id
  UNION SELECT i.employment_id FROM public.payroll_input i WHERE i.batch_id=b.id AND i.tenant_id=b.tenant_id
  UNION SELECT c.employment_id FROM public.payroll_batch_component c WHERE c.batch_id=b.id AND c.tenant_id=b.tenant_id
  UNION SELECT t.employment_id FROM public.payroll_individual_txn t WHERE (t.batch_id=b.id OR t.consumed_batch_id=b.id) AND t.tenant_id=b.tenant_id
  UNION SELECT picked.value::uuid FROM jsonb_array_elements_text(coalesce(b.scope->'employmentIds','[]'))picked(value)
 )subject WHERE subject.employment_id IS NULL OR NOT app.can_admin_payroll_employment(subject.employment_id)));
$$;
CREATE FUNCTION app.financial_batch_read(p_batch uuid,p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT p_batch IS NOT NULL AND p_company IS NOT NULL AND app.principal_snapshot_current()
 AND app.can_admin_payroll_for(p_company)
 AND EXISTS(SELECT 1 FROM public.company co WHERE co.id=p_company AND co.tenant_id=app.current_tenant_id())
 AND NOT EXISTS(SELECT 1 FROM public.payroll_batch b WHERE b.id=p_batch AND (b.tenant_id<>app.current_tenant_id() OR b.company_id<>p_company))
 AND app.financial_batch_subjects_allowed(p_batch);
$$;
REVOKE ALL ON FUNCTION app.financial_batch_read(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.financial_batch_read(uuid,uuid) TO ai_hr_app;
CREATE POLICY financial_batch_subject_read ON payroll_batch AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(app.financial_batch_read(id,company_id));
--> statement-breakpoint
DO $$ DECLARE definition text;needle text:='''batch'',to_jsonb(b)';replacement text;BEGIN
 definition:=pg_get_functiondef('app.information_payslip_document(uuid)'::regprocedure);
 IF (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'Retained payslip document binding changed';END IF;
 replacement:=$body$'batch',jsonb_build_object('id',b.id,'tenant_id',b.tenant_id,'company_id',b.company_id,'pay_period_id',b.pay_period_id,'run_seq',b.run_seq,'run_type',b.run_type,'pay_period',b.pay_period,'batch_date',b.batch_date,'status',b.status,'closed_at',b.closed_at,'released_at',b.released_at,'payroll_cycle_id',b.payroll_cycle_id,'history_import_attempt_id',b.history_import_attempt_id,'history_import_cycle_name',b.history_import_cycle_name,'created_at',b.created_at)$body$;
 EXECUTE replace(definition,needle,replacement);
END $$;
--> statement-breakpoint
CREATE TABLE app.financial_receipt_epoch(transaction_id xid8 PRIMARY KEY);
ALTER TABLE app.financial_receipt_epoch ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.financial_receipt_epoch FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.financial_receipts_prune() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE inserted xid8;oldest xid8:=pg_snapshot_xmin(pg_current_snapshot());table_name text;
BEGIN
 INSERT INTO app.financial_receipt_epoch VALUES(pg_current_xact_id()) ON CONFLICT DO NOTHING RETURNING transaction_id INTO inserted;
 IF inserted IS NULL THEN RETURN NULL;END IF;
 -- A transaction below the global snapshot xmin has no live/deferred consumer. Do
 -- this once per transaction, retaining every in-flight actor's exact receipts.
 FOREACH table_name IN ARRAY ARRAY['financial_letter_birth','financial_family_effect','financial_batch_intent','letter_operation_effect','financial_kernel_context','financial_source_change','financial_stale_effect'] LOOP
  EXECUTE format('DELETE FROM app.%I WHERE transaction_id<$1',table_name) USING oldest;
 END LOOP;
 DELETE FROM app.financial_receipt_epoch WHERE transaction_id<oldest;
 RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION app.financial_receipts_prune() FROM PUBLIC,ai_hr_app;
DO $$ DECLARE table_name text;BEGIN
 FOREACH table_name IN ARRAY ARRAY['financial_letter_birth','financial_family_effect','financial_batch_intent','letter_operation_effect','financial_kernel_context','financial_source_change','financial_stale_effect'] LOOP
  EXECUTE format('CREATE TRIGGER financial_receipts_prune AFTER INSERT ON app.%I FOR EACH ROW EXECUTE FUNCTION app.financial_receipts_prune()',table_name);
 END LOOP;
END $$;
--> statement-breakpoint
-- Preserve the original finite Leave follow-up course for visible/delegated requests.
-- The additional hidden whole-request branch remains bound to0940's final task proof.
DO $$ DECLARE definition text;needle text:='recalc_employment_ids=CASE WHEN added THEN coalesce(recalc_employment_ids,''[]''::jsonb)||jsonb_build_array(lr.employment_id::text) ELSE recalc_employment_ids END WHERE id=b.id;';addition text;BEGIN
 definition:=pg_get_functiondef('app.record_leave_payroll_effect(uuid,uuid,text,jsonb,text)'::regprocedure);
 IF (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'Native Leave payroll effect binding changed';END IF;
 addition:=$body$
 IF (app.can_see_employment(lr.employment_id) OR app.can_decide_via_delegation(lr.employment_id)) AND NOT app.leave_task_effect_pending(lr.id) THEN
  INSERT INTO app.financial_stale_effect(transaction_id,tenant_id,user_id,batch_id,before_hash,after_hash)
  SELECT pg_current_xact_id(),lr.tenant_id,app.current_user_id(),b.id,encode(sha256(convert_to(to_jsonb(b)::text,'UTF8')),'hex'),encode(sha256(convert_to(to_jsonb(actual)::text,'UTF8')),'hex')
  FROM public.payroll_batch actual WHERE actual.id=b.id AND actual.tenant_id=b.tenant_id ON CONFLICT DO NOTHING;
 END IF;
$body$;
 EXECUTE replace(definition,needle,needle||addition);
END $$;

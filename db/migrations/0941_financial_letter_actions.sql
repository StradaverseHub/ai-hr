-- Exact financial/letter action restrictions retain native role/ACL and independent workflow floors.
-- Source reservation0941 / aggregateidx763 / when1793330000341. Activation is the restricted publisher.
INSERT INTO access_capability(id,scope,supported,bindings) SELECT domain||'.'||operation,'company',false,'[]'::jsonb FROM (VALUES('payroll'),('performance_compensation'))d(domain) CROSS JOIN (VALUES('view'),('add'),('edit'),('delete'))o(operation);
INSERT INTO access_capability(id,scope,supported,bindings) SELECT 'letters.'||operation,'company',false,'[]'::jsonb FROM (VALUES('view'),('add'),('edit'),('delete'),('approve'),('issue'))o(operation);
--> statement-breakpoint
-- A hardcoded human effect may not adopt an agent marker, even when a mixed
-- caller also carries a current human snapshot. Invalid raw markers fail closed.
CREATE FUNCTION app.financial_human_principal_current() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN nullif(current_setting('app.agent_principal_id',true),'') IS NOT NULL THEN false
 ELSE app.current_agent_principal() IS NULL AND app.principal_snapshot_current() END;
$$;
REVOKE ALL ON FUNCTION app.financial_human_principal_current() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Top-level transaction receipts also cover successful native savepoint writes;
-- tuple xmin alone is a subtransaction ID in per-employee reprocessing.
CREATE TABLE app.financial_audit_effect(transaction_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,event_id uuid NOT NULL,PRIMARY KEY(transaction_id,tenant_id,user_id,event_id));
ALTER TABLE app.financial_audit_effect ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.financial_audit_effect FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.financial_audit_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT app.access_workforce_storage_owner() AND NEW.actor_type='user' AND NEW.actor_id=app.current_user_id() AND NEW.tenant_id=app.current_tenant_id() AND app.principal_snapshot_current()
 AND (NEW.event_type LIKE 'payroll-batch.%' OR NEW.event_type LIKE 'payroll.individual-txn.%' OR NEW.event_type LIKE 'back-pay.%' OR NEW.event_type='pay-component.created' OR NEW.event_type LIKE 'loan.%' OR NEW.event_type LIKE 'claim-request.%' OR NEW.event_type LIKE 'letter.%' OR NEW.event_type LIKE 'employment-pay-component.%' OR NEW.event_type='employee.tax.updated') THEN
  INSERT INTO app.financial_audit_effect VALUES(pg_current_xact_id(),NEW.tenant_id,NEW.actor_id,NEW.id) ON CONFLICT DO NOTHING;
 END IF;RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.financial_audit_record() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER financial_audit_effect AFTER INSERT ON domain_event FOR EACH ROW EXECUTE FUNCTION app.financial_audit_record();
CREATE FUNCTION app.financial_audit_written(p_event uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app.financial_audit_effect proof WHERE proof.transaction_id=pg_current_xact_id() AND proof.tenant_id=app.current_tenant_id() AND proof.user_id=app.current_user_id() AND proof.event_id=p_event);
$$;
REVOKE ALL ON FUNCTION app.financial_audit_written(uuid) FROM PUBLIC,ai_hr_app;
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
-- Live native defaults use only the verified CURRENT native role/ACL carrier, never the
-- canonical capability resolver (which itself consults this hook).
CREATE FUNCTION app.letter_current_native_permission(p_tenant uuid,p_user uuid,p_company uuid,p_native text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT p_tenant=app.current_tenant_id() AND p_user=app.current_user_id() AND app.financial_human_principal_current()
 AND app.letter_native_permission_for_user_at(p_tenant,p_user,p_company,p_native)
 AND EXISTS(SELECT 1 FROM public.role_assignment r JOIN app.current_grants() claimed ON claimed.role=r.role::text
  WHERE r.tenant_id=p_tenant AND r.app_user_id=p_user
  AND app.access_scope_covers(r.company_id,p_company,p_tenant) AND app.access_scope_covers(claimed.company_id,p_company,p_tenant)
  AND coalesce((SELECT g.allowed FROM public.letter_capability_grant g WHERE g.tenant_id=p_tenant AND g.company_id=p_company AND g.capability=p_native AND g.role=r.role::text),r.role::text IN ('super_admin','hr_admin')));
$$;
REVOKE ALL ON FUNCTION app.letter_current_native_permission(uuid,uuid,uuid,text) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.financial_letter_current_legacy_allowed(p_tenant uuid,p_user uuid,p_capability text,p_company uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE native_roles text[];native_operation text;selected_company uuid;
BEGIN
 IF p_tenant IS DISTINCT FROM app.current_tenant_id() OR p_user IS DISTINCT FROM app.current_user_id() OR NOT app.financial_human_principal_current()
 OR NOT app.financial_letter_legacy_allowed(p_tenant,p_user,p_capability,p_company) THEN RETURN false;END IF;
 IF p_capability=ANY(ARRAY['payroll.view','payroll.add','payroll.edit','payroll.delete']) THEN native_roles:=ARRAY['hr_admin','super_admin','payroll_partner'];
 ELSIF p_capability=ANY(ARRAY['performance_compensation.view','performance_compensation.add','performance_compensation.edit','performance_compensation.delete']) THEN native_roles:=ARRAY['hr_admin','super_admin','performance_comp_partner'];
 ELSIF app.financial_letter_native_operations(p_capability) IS NOT NULL THEN
  IF p_company IS NULL THEN
   IF NOT EXISTS(SELECT 1 FROM app.current_grants() claimed WHERE claimed.company_id IS NULL AND claimed.role IN ('hr_admin','super_admin')) THEN RETURN false;END IF;
   FOR selected_company IN SELECT c.id FROM public.company c WHERE c.tenant_id=p_tenant AND c.archived_at IS NULL LOOP
    IF NOT app.financial_letter_current_legacy_allowed(p_tenant,p_user,p_capability,selected_company) THEN RETURN false;END IF;
   END LOOP;RETURN true;
  END IF;
  FOREACH native_operation IN ARRAY app.financial_letter_native_operations(p_capability) LOOP
   IF app.letter_current_native_permission(p_tenant,p_user,p_company,native_operation) THEN RETURN true;END IF;
  END LOOP;RETURN false;
 ELSE RETURN false;END IF;
 RETURN EXISTS(SELECT 1 FROM app.current_grants() claimed WHERE claimed.role=ANY(native_roles)
  AND (p_company IS NULL AND claimed.company_id IS NULL OR p_company IS NOT NULL AND app.access_scope_covers(claimed.company_id,p_company,p_tenant)));
END;
$$;
REVOKE ALL ON FUNCTION app.financial_letter_current_legacy_allowed(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
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
 AND (NOT c.supported OR jsonb_array_length(c.bindings)>0 AND CASE WHEN p_company IS NOT NULL THEN app.access_allowed_for_tenant(p_tenant,p_user,c.id,p_company)
 ELSE EXISTS(SELECT 1 FROM public.access_configuration state WHERE state.tenant_id=p_tenant AND state.initialized)
  AND NOT EXISTS(SELECT 1 FROM public.access_user_override deny WHERE deny.tenant_id=p_tenant AND deny.user_id=p_user AND deny.capability_id=c.id AND deny.effect='deny' AND deny.retired_at IS NULL)
  AND (EXISTS(SELECT 1 FROM public.access_user_override allow_rule WHERE allow_rule.tenant_id=p_tenant AND allow_rule.user_id=p_user AND allow_rule.capability_id=c.id AND allow_rule.effect='allow' AND allow_rule.company_id IS NULL AND allow_rule.retired_at IS NULL)
   OR EXISTS(SELECT 1 FROM public.access_effective_membership member JOIN public.access_group g ON g.id=member.group_id AND g.tenant_id=member.tenant_id JOIN public.access_group_grant grant_rule ON grant_rule.group_id=g.id AND grant_rule.tenant_id=g.tenant_id
    WHERE member.tenant_id=p_tenant AND member.user_id=p_user AND member.company_id IS NULL AND g.retired_at IS NULL AND grant_rule.capability_id=c.id AND grant_rule.company_id IS NULL AND grant_rule.retired_at IS NULL))
  AND NOT EXISTS(SELECT 1 FROM public.company co WHERE co.tenant_id=p_tenant AND NOT app.access_allowed_for_tenant(p_tenant,p_user,c.id,co.id)) END));
$$;
REVOKE ALL ON FUNCTION app.financial_letter_capability_allowed_for(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.financial_letter_capability_allowed_current(p_capability text,p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.access_capability c WHERE c.id=p_capability AND c.scope='company'
 AND (NOT c.supported OR jsonb_array_length(c.bindings)>0 AND CASE WHEN p_company IS NOT NULL THEN app.access_allowed_for(app.current_user_id(),c.id,p_company)
 ELSE app.financial_letter_capability_allowed_for(app.current_tenant_id(),app.current_user_id(),c.id,NULL)
 AND app.access_current_capability_source(c.id,NULL)
 AND NOT EXISTS(SELECT 1 FROM public.company co WHERE co.tenant_id=app.current_tenant_id() AND NOT app.access_allowed_for(app.current_user_id(),c.id,co.id)) END));
$$;
REVOKE ALL ON FUNCTION app.financial_letter_capability_allowed_current(text,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.access_financial_action_company(p_domain text,p_company uuid,p_operation text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT p_domain IN ('payroll','performance_compensation') AND p_operation IN ('view','add','edit','delete')
 AND app.financial_human_principal_current() AND app.financial_letter_legacy_allowed(app.current_tenant_id(),app.current_user_id(),p_domain||'.'||p_operation,p_company)
 AND CASE WHEN p_domain='payroll' THEN app.grants_payroll_admin_for((SELECT jsonb_agg(jsonb_build_object('role',g.role,'companyId',g.company_id)) FROM app.current_grants() g),p_company)
 ELSE app.grants_admin_for((SELECT jsonb_agg(jsonb_build_object('role',g.role,'companyId',g.company_id)) FROM app.current_grants() g),p_company) OR app.grants_have_role_for((SELECT jsonb_agg(jsonb_build_object('role',g.role,'companyId',g.company_id)) FROM app.current_grants() g),'performance_comp_partner',p_company) END
 AND app.financial_letter_capability_allowed_current(p_domain||'.view',p_company)
 AND app.financial_letter_capability_allowed_current(p_domain||'.'||p_operation,p_company);
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
 SELECT app.financial_human_principal_current() AND app.access_letter_action_for_user(app.current_tenant_id(),app.current_user_id(),p_company,p_native,p_operation)
 AND app.financial_letter_capability_allowed_current('letters.view',p_company) AND app.financial_letter_capability_allowed_current('letters.'||p_operation,p_company);
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
CREATE OR REPLACE FUNCTION app.letter_permission(co uuid,cap text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND app.letter_permission_for_user_at(app.current_tenant_id(),app.current_user_id(),co,cap)
 AND app.financial_letter_capability_allowed_current('letters.view',co)
 AND app.financial_letter_capability_allowed_current('letters.'||CASE cap WHEN 'approve' THEN 'approve' WHEN 'issue' THEN 'issue' ELSE 'view' END,co);
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
DECLARE row_data jsonb;old_data jsonb;co uuid;native text;operation text;root uuid;parent_operation text;function_key text;function_operation text;deactivation_previous jsonb;needs_content_edit boolean:=false;
BEGIN
 IF app.access_workforce_storage_owner() THEN RETURN coalesce(NEW,OLD);END IF;
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
 function_operation:=operation;
 function_key:=CASE WHEN TG_TABLE_NAME='letter_asset' AND row_data->>'kind'='signature' THEN 'letterSettings.signature'
 WHEN TG_TABLE_NAME='letter_merge_field_version' THEN 'letterFields'
 WHEN TG_TABLE_NAME IN ('letter_template','letter_template_version','letter_template_field') THEN 'letterTemplates'
 ELSE app.financial_letter_native_function(native,operation) END;
 IF function_key='letterSettings.signature' THEN function_operation:='add';END IF;
 -- Delete authorizes the native toggle, not unrelated edits bundled into its new version.
 IF operation='delete' AND TG_OP='INSERT' AND TG_TABLE_NAME IN ('letter_policy_version','letter_merge_field_version','letter_automation_rule_version') THEN
  CASE TG_TABLE_NAME
  WHEN 'letter_policy_version' THEN SELECT to_jsonb(v) INTO deactivation_previous FROM public.letter_policy_version v WHERE v.tenant_id=app.current_tenant_id() AND v.company_id=co AND v.category=row_data->>'category' AND v.ordinal=(row_data->>'ordinal')::integer-1;
  WHEN 'letter_merge_field_version' THEN SELECT to_jsonb(v) INTO deactivation_previous FROM public.letter_merge_field_version v WHERE v.tenant_id=app.current_tenant_id() AND v.company_id=co AND v.key=row_data->>'key' AND v.ordinal=(row_data->>'ordinal')::integer-1;
  WHEN 'letter_automation_rule_version' THEN SELECT to_jsonb(v) INTO deactivation_previous FROM public.letter_automation_rule_version v WHERE v.tenant_id=app.current_tenant_id() AND v.company_id=co AND v.template_id=(row_data->>'template_id')::uuid AND v.trigger=row_data->>'trigger' AND v.ordinal=(row_data->>'ordinal')::integer-1;
  END CASE;
  needs_content_edit:=deactivation_previous IS NULL OR row_data-ARRAY['id','ordinal','created_by','created_at','enabled','active'] IS DISTINCT FROM deactivation_previous-ARRAY['id','ordinal','created_by','created_at','enabled','active'];
 ELSIF operation='delete' AND TG_OP='UPDATE' AND TG_TABLE_NAME='letter_template' THEN
  needs_content_edit:=row_data-ARRAY['deactivated','revision'] IS DISTINCT FROM old_data-ARRAY['deactivated','revision'];
 END IF;
 IF needs_content_edit AND (NOT app.letter_function_action(function_key,'edit',co) OR NOT app.access_letter_action(co,native,'edit')) THEN
  RAISE EXCEPTION 'Letter content edit unavailable' USING ERRCODE='42501';
 END IF;
 IF co IS NULL OR function_key IS NULL OR NOT app.letter_function_action(function_key,function_operation,co)
 OR NOT app.access_letter_action(co,native,operation) THEN RAISE EXCEPTION 'Letter action unavailable' USING ERRCODE='42501';END IF;
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
 IF app.access_workforce_storage_owner() THEN RETURN NULL;END IF;
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
 IF app.access_workforce_storage_owner() THEN RETURN NULL;END IF;
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
   AND app.financial_audit_written(audit.id) AND audit.payload->>'provenance'='auto_child_relief' AND audit.payload->>'personId'=target::text)) THEN RETURN NULL;END IF;
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
DECLARE batch public.payroll_batch;starts date;ends date;scope_ids uuid[];
BEGIN
 IF NOT app.financial_human_principal_current() THEN RAISE EXCEPTION 'Payroll actor unavailable' USING ERRCODE='42501';END IF;
 PERFORM app.access_workforce_write_lock();
 SELECT * INTO batch FROM public.payroll_batch b WHERE b.id=p_batch AND b.tenant_id=app.current_tenant_id() FOR UPDATE;
 IF batch.id IS NULL OR p_operation NOT IN ('edit','delete') OR NOT app.access_financial_action_company('payroll',batch.company_id,p_operation) OR NOT app.function_action_allowed('payroll.process',p_operation,batch.company_id) OR NOT app.financial_batch_subjects_allowed(batch.id) THEN RAISE EXCEPTION 'Payroll action unavailable' USING ERRCODE='42501';END IF;
 starts:=(batch.pay_period||'-01')::date;ends:=(starts+interval '1 month'-interval '1 day')::date;
 scope_ids:=app.financial_payroll_scope_ids(batch.tenant_id,batch.scope);
 -- Actual process membership mirrors employedByCompanyDuring + resolveBatchScopeFilter.
 -- Querying as the private owner prevents RLS from silently shrinking a requested payroll.
 IF EXISTS(SELECT 1 FROM public.employment e WHERE e.tenant_id=batch.tenant_id
  AND (p_targets IS NULL OR e.id=ANY(p_targets))
  AND (p_targets IS NOT NULL OR scope_ids IS NULL OR e.id=ANY(scope_ids))
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
 AND app.access_financial_action_company('payroll',proof.company_id,proof.operation) AND app.function_action_allowed('payroll.process',proof.operation,proof.company_id));
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
  WHERE c.id=p_capability AND (p_capability !~ '^(payroll|performance_compensation|letters)\.' OR app.financial_letter_delegation_allowed(u.tenant_id,u.id,p_capability,p_company)) AND (p_capability !~ '^(payroll|performance_compensation)\.' OR app.access_financial_action_company(split_part(p_capability,'.',1),p_company,split_part(p_capability,'.',2))) AND app.access_function_delegation_floor(p_capability,p_company) AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(c.prerequisites) needed(id) JOIN public.access_capability prerequisite ON prerequisite.id=needed.id WHERE NOT app.access_can_delegate(needed.id,CASE WHEN prerequisite.scope='tenant' THEN NULL ELSE p_company END)) AND app.access_current_capability_source(p_capability,p_company) AND (p_capability NOT IN ('workforce.add','workforce.edit','workforce.delete','workforce.maintain') OR CASE WHEN p_company IS NULL THEN app.is_group_admin() ELSE app.is_admin_for(p_company) END) AND (p_capability !~ '^.+\.(add|edit|delete|approve|issue|execute)$' OR app.access_can_delegate(regexp_replace(p_capability,'[^.]+$','view'),p_company)) AND c.supported AND jsonb_array_length(c.bindings)>0
   AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
   AND CASE WHEN c.scope='tenant' THEN p_company IS NULL AND app.access_allowed_for(u.id,c.id,NULL)
    WHEN p_company IS NOT NULL THEN app.access_allowed_for(u.id,c.id,p_company)
    ELSE EXISTS(SELECT 1 FROM public.access_configuration s WHERE s.tenant_id=u.tenant_id AND s.initialized)
     AND (app.access_native_default_current(c.id,NULL) OR EXISTS(SELECT 1 FROM public.access_user_override o WHERE o.tenant_id=u.tenant_id AND o.user_id=u.id AND o.capability_id=c.id AND o.company_id IS NULL AND o.effect='allow' AND o.retired_at IS NULL)
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
 -- Native draft creation is an Add consequence, not a fabricated Edit/Approve.
 IF TG_OP='INSERT' AND NEW.kind='notification' AND NEW.status='queued' AND NEW.attempts=0 AND NEW.lease_token IS NULL AND NEW.lease_until IS NULL THEN
  IF NEW.payload->>'purpose'='draftCreated' AND app.letter_function_action('letterGenerate','view',NEW.company_id) AND app.letter_function_action('letterGenerate','add',NEW.company_id)
  AND app.access_letter_action(NEW.company_id,'generate','add') AND app.letter_draft_created_job_current(NEW.tenant_id,NEW.id)
  AND EXISTS(SELECT 1 FROM app.financial_letter_proposed_birth birth JOIN public.letter_record actual ON actual.id=birth.letter_id AND actual.tenant_id=birth.tenant_id AND actual.company_id=birth.company_id AND actual.batch_id=birth.batch_id AND actual.created_by=birth.user_id
   WHERE birth.transaction_id=pg_current_xact_id() AND birth.tenant_id=NEW.tenant_id AND birth.user_id=app.current_user_id() AND birth.letter_id=NEW.letter_id AND birth.company_id=NEW.company_id AND birth.completed AND app.data_permission_matches(birth.employment_id))
  AND EXISTS(SELECT 1 FROM public.domain_event audit WHERE audit.id=NEW.source_event_id AND audit.tenant_id=NEW.tenant_id AND audit.aggregate_type='letter' AND audit.aggregate_id=NEW.letter_id AND audit.event_type='letter.draft.batch-created' AND audit.actor_type='user' AND audit.actor_id=app.current_user_id() AND app.financial_audit_written(audit.id)) THEN RETURN NULL;END IF;
  -- Employee acknowledgement/signature owns a separate, exact recipient consequence.
  IF NEW.payload->>'purpose'='recipientAcknowledgement' AND app.letter_recipient_function_action('execute') AND app.letter_acknowledgement_job_current(NEW.tenant_id,NEW.id)
  AND EXISTS(SELECT 1 FROM public.letter_recipient_event action JOIN public.domain_event audit ON audit.id=NEW.source_event_id AND audit.tenant_id=action.tenant_id AND audit.aggregate_id=action.letter_id AND audit.aggregate_type='letter'
   WHERE action.id::text=NEW.payload->>'recipientEventId' AND action.tenant_id=NEW.tenant_id AND action.letter_id=NEW.letter_id AND action.actor_id=app.current_user_id() AND action.kind IN ('acknowledged','signed')
   AND audit.actor_type='user' AND audit.actor_id=action.actor_id AND audit.event_type='letter.recipient.'||action.kind AND app.financial_audit_written(audit.id)) THEN RETURN NULL;END IF;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM app.letter_operation_effect proof WHERE proof.transaction_id=pg_current_xact_id() AND proof.tenant_id=NEW.tenant_id AND proof.user_id=app.current_user_id() AND proof.letter_id=NEW.letter_id AND proof.company_id=NEW.company_id
  AND app.access_letter_action(proof.company_id,proof.native_capability,proof.operation)
  AND app.letter_function_action(app.financial_letter_native_function(proof.native_capability,proof.operation),proof.operation,proof.company_id)
  AND (TG_OP<>'UPDATE' OR proof.operation IN ('delete','approve'))
  AND (TG_OP='UPDATE' OR EXISTS(SELECT 1 FROM public.domain_event audit WHERE audit.id=NEW.source_event_id AND audit.tenant_id=NEW.tenant_id AND audit.aggregate_id=NEW.letter_id AND audit.aggregate_type='letter' AND audit.actor_id=app.current_user_id() AND app.financial_audit_written(audit.id)
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
 IF NOT app.financial_human_principal_current() OR NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NOT EXISTS(SELECT 1 FROM public.company c WHERE c.tenant_id=NEW.tenant_id AND app.access_letter_action(c.id,'generate','add')) THEN RAISE EXCEPTION 'Letter reference allocation unavailable' USING ERRCODE='42501';END IF;
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
 IF app.access_workforce_storage_owner() THEN IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;END IF;
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
 IF app.access_workforce_storage_owner() THEN RETURN NULL;END IF;
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
 -- A Process operation never lends the independently configurable Statutory Adjustment cell.
 -- Teardown/reprocess consequences are admitted below from their exact batch intent.
 IF TG_TABLE_NAME='payroll_statutory_adjustment' THEN
  IF app.function_action_allowed('payroll.statutoryAdjustments',operation,context.company_id)
   AND app.access_financial_action_employment('payroll',context.employment_id,operation) THEN RETURN NULL;END IF;
  IF TG_OP='DELETE' AND app.financial_batch_intent_allowed(context.batch_id,'delete')
   AND NOT EXISTS(SELECT 1 FROM public.payslip p WHERE p.tenant_id=app.current_tenant_id() AND p.batch_id=context.batch_id AND p.employment_id=context.employment_id)
   AND EXISTS(SELECT 1 FROM public.domain_event audit WHERE audit.tenant_id=app.current_tenant_id() AND audit.aggregate_id=context.batch_id AND audit.actor_id=app.current_user_id() AND audit.event_type IN ('payroll-batch.deleted','payroll-batch.employee-payroll-removed') AND app.financial_audit_written(audit.id)) THEN RETURN NULL;END IF;
  RAISE EXCEPTION 'Statutory adjustment action unavailable' USING ERRCODE='42501';
 END IF;
 -- Direct logical action on this row remains sufficient; target scope is always checked.
 IF app.function_action_allowed('payroll.process',operation,context.company_id)
 AND app.access_financial_action_company('payroll',context.company_id,operation)
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
  OR EXISTS(SELECT 1 FROM public.payroll_batch b JOIN public.domain_event audit ON audit.aggregate_id=b.id AND audit.tenant_id=b.tenant_id AND audit.event_type='payroll-batch.reset' AND audit.actor_id=app.current_user_id() AND app.financial_audit_written(audit.id) WHERE b.id=context.batch_id AND b.tenant_id=app.current_tenant_id() AND b.status='draft')) THEN RETURN NULL;END IF;
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
 IF app.access_workforce_storage_owner() OR app.current_user_id() IS NULL OR before_row-ARRAY['created_at','updated_at','recorded_at'] IS NOT DISTINCT FROM after_row-ARRAY['created_at','updated_at','recorded_at'] THEN RETURN NULL;END IF;
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
 IF NOT app.financial_human_principal_current() THEN RAISE EXCEPTION 'Payroll source actor unavailable' USING ERRCODE='42501';END IF;
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
 FOREACH table_name IN ARRAY ARRAY['financial_letter_birth','financial_family_effect','financial_batch_intent','letter_operation_effect','financial_kernel_context','financial_source_change','financial_stale_effect','financial_loan_repayment_effect','financial_loan_counter_effect','financial_loan_auxiliary','financial_claim_effect','financial_audit_effect','financial_fixed_replacement','financial_individual_effect','financial_backpay_posting','financial_backpay_catalog_effect','financial_backpay_birth','financial_claim_source_custody','financial_letter_proposed_birth','financial_claim_port_effect','financial_onehr_worker_source','financial_onehr_source_context'] LOOP
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
--> statement-breakpoint
CREATE TABLE app.financial_loan_repayment_effect (
 transaction_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,repayment_id uuid NOT NULL,loan_id uuid NOT NULL,employment_id uuid NOT NULL,batch_id uuid NOT NULL,
 mode text NOT NULL,amount numeric(12,2) NOT NULL,count_delta integer NOT NULL,due_amount numeric(12,2) NOT NULL,sequence_no integer NOT NULL,consumed boolean NOT NULL DEFAULT false,
 before_hash text NOT NULL,after_hash text NOT NULL,PRIMARY KEY(transaction_id,tenant_id,user_id,repayment_id,before_hash,after_hash)
);
CREATE TABLE app.financial_loan_counter_effect (
 transaction_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,loan_id uuid NOT NULL,repayment_id uuid NOT NULL,batch_id uuid NOT NULL,mode text NOT NULL,before_hash text NOT NULL,after_hash text NOT NULL,
 PRIMARY KEY(transaction_id,tenant_id,user_id,loan_id,before_hash,after_hash)
);
ALTER TABLE app.financial_loan_repayment_effect ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.financial_loan_counter_effect ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.financial_loan_repayment_effect,app.financial_loan_counter_effect FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.financial_kernel_row_written(p_table text,p_row jsonb,p_insert boolean DEFAULT false) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT p_table IN ('payslip','payroll_input') AND EXISTS(SELECT 1 FROM app.financial_kernel_context proof WHERE proof.transaction_id=pg_current_xact_id() AND proof.tenant_id=app.current_tenant_id() AND proof.user_id=app.current_user_id() AND proof.table_name=p_table
 AND proof.after_hash=encode(sha256(convert_to(p_row::text,'UTF8')),'hex') AND (NOT p_insert OR proof.before_hash=encode(sha256(convert_to('{}'::jsonb::text,'UTF8')),'hex')));
$$;
REVOKE ALL ON FUNCTION app.financial_kernel_row_written(text,jsonb,boolean) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.financial_loan_repayment_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE before_row jsonb:=to_jsonb(OLD);after_row jsonb:=to_jsonb(NEW);batch uuid;mode text;amount numeric;count_delta integer;operation text;
BEGIN
 IF app.access_workforce_storage_owner() OR TG_OP<>'UPDATE' OR NOT app.principal_snapshot_current() THEN RETURN NULL;END IF;
 IF OLD.status='reserved' AND NEW.status='applied' AND OLD.reserved_batch_id=NEW.applied_batch_id
 AND before_row-ARRAY['status','applied_batch_id','applied_amount','applied_at'] IS NOT DISTINCT FROM after_row-ARRAY['status','applied_batch_id','applied_amount','applied_at']
 AND NEW.applied_at IS NOT NULL AND NEW.applied_amount>=0 AND NEW.applied_amount<=OLD.due_amount THEN
  batch:=NEW.applied_batch_id;mode:='apply';amount:=NEW.applied_amount;count_delta:=CASE WHEN amount>0 THEN 1 ELSE 0 END;operation:='edit';
  IF NOT EXISTS(SELECT 1 FROM public.payslip p WHERE p.tenant_id=NEW.tenant_id AND p.batch_id=batch AND p.employment_id=NEW.employment_id AND app.financial_kernel_row_written('payslip',to_jsonb(p),true))
  AND amount<>0 THEN RETURN NULL;END IF;
 ELSIF OLD.status='applied' AND NEW.status IN ('reserved','scheduled') AND NEW.applied_batch_id IS NULL AND NEW.applied_amount=0 AND NEW.applied_at IS NULL
 AND NEW.due_amount IN (OLD.due_amount,OLD.applied_amount)
 AND (NEW.status='reserved' AND NEW.reserved_batch_id IS NOT DISTINCT FROM OLD.reserved_batch_id OR NEW.status='scheduled' AND NEW.reserved_batch_id IS NULL)
 AND before_row-ARRAY['status','reserved_batch_id','due_amount','applied_batch_id','applied_amount','applied_at'] IS NOT DISTINCT FROM after_row-ARRAY['status','reserved_batch_id','due_amount','applied_batch_id','applied_amount','applied_at'] THEN
  batch:=OLD.applied_batch_id;mode:='reverse';amount:=OLD.applied_amount;count_delta:=CASE WHEN amount>0 THEN -1 ELSE 0 END;
  operation:=CASE WHEN app.financial_batch_intent_allowed(batch,'delete') THEN 'delete' ELSE 'edit' END;
 ELSE RETURN NULL;END IF;
 IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NOT app.financial_batch_intent_allowed(batch,operation) OR NOT app.access_financial_action_employment('payroll',NEW.employment_id,operation) THEN RETURN NULL;END IF;
 INSERT INTO app.financial_loan_repayment_effect VALUES(pg_current_xact_id(),NEW.tenant_id,app.current_user_id(),NEW.id,NEW.loan_id,NEW.employment_id,batch,mode,amount,count_delta,OLD.due_amount,OLD.sequence_no,false,
 encode(sha256(convert_to(before_row::text,'UTF8')),'hex'),encode(sha256(convert_to(after_row::text,'UTF8')),'hex')) ON CONFLICT DO NOTHING;
 RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION app.financial_loan_repayment_record() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER financial_loan_repayment_effect AFTER UPDATE ON loan_repayment FOR EACH ROW EXECUTE FUNCTION app.financial_loan_repayment_record();
--> statement-breakpoint
CREATE FUNCTION app.financial_loan_counter_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE proof app.financial_loan_repayment_effect;expected_amount numeric;expected_count integer;expected_status text;
BEGIN
 IF app.access_workforce_storage_owner() OR NOT app.principal_snapshot_current() OR NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR to_jsonb(NEW)-ARRAY['outstanding_balance','instalments_paid','status','updated_at'] IS DISTINCT FROM to_jsonb(OLD)-ARRAY['outstanding_balance','instalments_paid','status','updated_at'] THEN RETURN NULL;END IF;
 FOR proof IN SELECT * FROM app.financial_loan_repayment_effect e WHERE e.transaction_id=pg_current_xact_id() AND e.tenant_id=NEW.tenant_id AND e.user_id=app.current_user_id() AND e.loan_id=NEW.id AND NOT e.consumed ORDER BY e.repayment_id FOR UPDATE LOOP
  expected_amount:=CASE proof.mode WHEN 'apply' THEN greatest(0,OLD.outstanding_balance-proof.amount) ELSE OLD.outstanding_balance+proof.amount END;
  expected_count:=greatest(0,OLD.instalments_paid+proof.count_delta);
  expected_status:=CASE WHEN proof.mode='apply' AND expected_amount<=0 THEN 'settled' WHEN proof.mode='reverse' AND OLD.status='settled' AND proof.amount>0 THEN 'active' ELSE OLD.status::text END;
  IF NEW.outstanding_balance=expected_amount AND NEW.instalments_paid=expected_count AND NEW.status::text=expected_status THEN
   UPDATE app.financial_loan_repayment_effect e SET consumed=true WHERE e.transaction_id=proof.transaction_id AND e.tenant_id=proof.tenant_id AND e.user_id=proof.user_id AND e.repayment_id=proof.repayment_id AND e.before_hash=proof.before_hash AND e.after_hash=proof.after_hash;
   INSERT INTO app.financial_loan_counter_effect VALUES(pg_current_xact_id(),NEW.tenant_id,app.current_user_id(),NEW.id,proof.repayment_id,proof.batch_id,proof.mode,encode(sha256(convert_to(to_jsonb(OLD)::text,'UTF8')),'hex'),encode(sha256(convert_to(to_jsonb(NEW)::text,'UTF8')),'hex')) ON CONFLICT DO NOTHING;
   RETURN NULL;
  END IF;
 END LOOP;
 RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION app.financial_loan_counter_record() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER financial_loan_counter_effect AFTER UPDATE ON employee_loan FOR EACH ROW EXECUTE FUNCTION app.financial_loan_counter_record();
--> statement-breakpoint
CREATE FUNCTION app.financial_loan_effect_audited(p_repayment uuid,p_mode text,p_batch uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app.financial_loan_repayment_effect proof JOIN public.domain_event audit ON audit.tenant_id=proof.tenant_id AND audit.aggregate_id=proof.repayment_id AND audit.aggregate_type='loan-repayment' AND audit.actor_id=proof.user_id AND audit.subject_employment_id=proof.employment_id
 WHERE proof.transaction_id=pg_current_xact_id() AND proof.tenant_id=app.current_tenant_id() AND proof.user_id=app.current_user_id() AND proof.repayment_id=p_repayment AND proof.mode=p_mode AND proof.batch_id=p_batch AND proof.consumed
 AND (proof.mode<>'reverse' OR EXISTS(SELECT 1 FROM public.domain_event root_event WHERE root_event.tenant_id=proof.tenant_id AND root_event.aggregate_id=p_batch AND root_event.aggregate_type='payroll-batch' AND root_event.actor_id=proof.user_id AND app.financial_audit_written(root_event.id) AND root_event.event_type IN ('payroll-batch.reset','payroll-batch.employee-payroll-removed')))
 AND (app.financial_batch_intent_allowed(p_batch,'edit') AND app.access_financial_action_employment('payroll',proof.employment_id,'edit') OR proof.mode='reverse' AND app.financial_batch_intent_allowed(p_batch,'delete') AND app.access_financial_action_employment('payroll',proof.employment_id,'delete'))
 AND app.financial_audit_written(audit.id) AND audit.event_type=CASE proof.mode WHEN 'apply' THEN 'loan.instalment.applied' ELSE 'loan.instalment.reversed' END AND audit.payload->>'batchId'=p_batch::text
 AND (proof.mode<>'apply' OR (audit.payload->>'appliedAmount')::numeric=proof.amount)
 AND (proof.mode<>'apply' OR EXISTS(SELECT 1 FROM public.payroll_batch b JOIN public.domain_event materialized ON materialized.tenant_id=b.tenant_id AND materialized.aggregate_id=b.id AND materialized.aggregate_type='payroll-batch' AND materialized.event_type IN ('payroll-batch.processed','payroll-batch.selective-reprocessed') AND materialized.actor_id=proof.user_id AND app.financial_audit_written(materialized.id) WHERE b.id=p_batch AND b.tenant_id=proof.tenant_id AND b.status='processed'))
 AND (proof.mode<>'reverse' OR audit.payload->>'loanId'=proof.loan_id::text)
 AND (proof.mode<>'reverse' OR EXISTS(SELECT 1 FROM public.payroll_batch b WHERE b.id=p_batch AND b.tenant_id=proof.tenant_id AND b.status='draft') OR NOT EXISTS(SELECT 1 FROM public.payslip p WHERE p.tenant_id=proof.tenant_id AND p.batch_id=p_batch AND p.employment_id=proof.employment_id)));
$$;
REVOKE ALL ON FUNCTION app.financial_loan_effect_audited(uuid,text,uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.financial_payroll_loan_counter_approved(p_before jsonb,p_after jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND EXISTS(SELECT 1 FROM app.financial_loan_counter_effect proof WHERE proof.transaction_id=pg_current_xact_id() AND proof.tenant_id=app.current_tenant_id() AND proof.user_id=app.current_user_id()
 AND proof.loan_id=(p_after->>'id')::uuid AND proof.before_hash=encode(sha256(convert_to(p_before::text,'UTF8')),'hex') AND proof.after_hash=encode(sha256(convert_to(p_after::text,'UTF8')),'hex') AND app.financial_loan_effect_audited(proof.repayment_id,proof.mode,proof.batch_id));
$$;
REVOKE ALL ON FUNCTION app.financial_payroll_loan_counter_approved(jsonb,jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE TABLE app.financial_loan_auxiliary (
 transaction_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,repayment_id uuid NOT NULL,loan_id uuid NOT NULL,employment_id uuid NOT NULL,batch_id uuid,mode text NOT NULL,due_amount numeric(12,2) NOT NULL,sequence_no integer NOT NULL,before_hash text NOT NULL,after_hash text NOT NULL,
 PRIMARY KEY(transaction_id,tenant_id,user_id,repayment_id,before_hash,after_hash)
);
ALTER TABLE app.financial_loan_auxiliary ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.financial_loan_auxiliary FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.financial_loan_auxiliary_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE before_row jsonb:=CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
 after_row jsonb:=CASE WHEN TG_OP='DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;
 data jsonb:=CASE WHEN TG_OP='DELETE' THEN before_row ELSE after_row END;mode text;batch uuid;
BEGIN
 IF app.access_workforce_storage_owner() OR NOT app.principal_snapshot_current() OR data->>'tenant_id' IS DISTINCT FROM app.current_tenant_id()::text THEN RETURN NULL;END IF;
 IF TG_OP='INSERT' AND NEW.status='scheduled' AND NEW.reserved_batch_id IS NULL AND NEW.applied_batch_id IS NULL AND NEW.applied_amount=0 THEN mode:='shortfall-created';
 ELSIF TG_OP='DELETE' AND OLD.status='scheduled' AND OLD.applied_batch_id IS NULL AND OLD.applied_amount=0 THEN mode:='shortfall-removed';
 ELSIF TG_OP='UPDATE' AND OLD.status='scheduled' AND NEW.status='skipped' AND after_row-'status' IS NOT DISTINCT FROM before_row-'status' THEN mode:='auto-stop';
 ELSIF TG_OP='UPDATE' AND OLD.status='scheduled' AND NEW.status='reserved' AND NEW.reserved_batch_id IS NOT NULL AND NEW.due_amount>0 AND NEW.due_amount<=OLD.due_amount
 AND after_row-ARRAY['status','reserved_batch_id','due_amount'] IS NOT DISTINCT FROM before_row-ARRAY['status','reserved_batch_id','due_amount'] THEN mode:='reserve';batch:=NEW.reserved_batch_id;
 ELSIF TG_OP='UPDATE' AND OLD.status='reserved' AND NEW.status='scheduled' AND NEW.reserved_batch_id IS NULL AND after_row-ARRAY['status','reserved_batch_id'] IS NOT DISTINCT FROM before_row-ARRAY['status','reserved_batch_id'] THEN mode:='release';batch:=OLD.reserved_batch_id;
 ELSE RETURN NULL;END IF;
 INSERT INTO app.financial_loan_auxiliary VALUES(pg_current_xact_id(),app.current_tenant_id(),app.current_user_id(),(data->>'id')::uuid,(data->>'loan_id')::uuid,(data->>'employment_id')::uuid,batch,mode,(data->>'due_amount')::numeric,(data->>'sequence_no')::integer,encode(sha256(convert_to(before_row::text,'UTF8')),'hex'),encode(sha256(convert_to(after_row::text,'UTF8')),'hex')) ON CONFLICT DO NOTHING;
 RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION app.financial_loan_auxiliary_record() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER financial_loan_auxiliary AFTER INSERT OR UPDATE OR DELETE ON loan_repayment FOR EACH ROW EXECUTE FUNCTION app.financial_loan_auxiliary_record();
--> statement-breakpoint
CREATE FUNCTION app.access_financial_loan_repayment_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE before_row jsonb:=CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
 after_row jsonb:=CASE WHEN TG_OP='DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;
 data jsonb:=CASE WHEN TG_OP='DELETE' THEN before_row ELSE after_row END;aux app.financial_loan_auxiliary;proof app.financial_loan_repayment_effect;operation text;
BEGIN
 IF app.access_workforce_storage_owner() THEN RETURN NULL;END IF;
 IF data->>'tenant_id' IS DISTINCT FROM app.current_tenant_id()::text OR NOT app.principal_snapshot_current() THEN RAISE EXCEPTION 'Loan repayment action unavailable' USING ERRCODE='42501';END IF;
 IF TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM unnest(ARRAY['id','tenant_id','loan_id','employment_id','sequence_no','created_at'])field(name) WHERE before_row->field.name IS DISTINCT FROM after_row->field.name) THEN RAISE EXCEPTION 'Loan schedule identity changed' USING ERRCODE='42501';END IF;
 IF to_regprocedure('app.financial_loan_schedule_approved(jsonb,jsonb)') IS NOT NULL THEN
  IF app.financial_loan_schedule_approved(before_row,after_row) THEN RETURN NULL;END IF;
 END IF;
 operation:=CASE WHEN TG_OP='DELETE' OR TG_OP='UPDATE' AND after_row->>'status'='skipped' THEN 'delete' WHEN TG_OP='INSERT' THEN 'add' ELSE 'edit' END;
 -- Standalone native HR schedule administration remains independent from actual payments.
 IF (TG_OP='INSERT' OR before_row->>'status' IN ('scheduled','skipped')) AND (TG_OP='DELETE' OR after_row->>'status' IN ('scheduled','skipped'))
 AND coalesce((before_row->>'applied_amount')::numeric,0)=0 AND coalesce((after_row->>'applied_amount')::numeric,0)=0
 AND app.access_financial_action_employment('payroll',(data->>'employment_id')::uuid,operation)
 AND EXISTS(SELECT 1 FROM public.employment e WHERE e.id=(data->>'employment_id')::uuid AND e.tenant_id=app.current_tenant_id() AND app.is_admin_for(e.company_id)) THEN RETURN NULL;END IF;
 IF EXISTS(SELECT 1 FROM app.financial_loan_repayment_effect e WHERE e.transaction_id=pg_current_xact_id() AND e.tenant_id=app.current_tenant_id() AND e.user_id=app.current_user_id() AND e.repayment_id=(data->>'id')::uuid
  AND e.before_hash=encode(sha256(convert_to(before_row::text,'UTF8')),'hex') AND e.after_hash=encode(sha256(convert_to(after_row::text,'UTF8')),'hex') AND app.financial_loan_effect_audited(e.repayment_id,e.mode,e.batch_id)) THEN RETURN NULL;END IF;
 SELECT * INTO aux FROM app.financial_loan_auxiliary e WHERE e.transaction_id=pg_current_xact_id() AND e.tenant_id=app.current_tenant_id() AND e.user_id=app.current_user_id() AND e.repayment_id=(data->>'id')::uuid
 AND e.before_hash=encode(sha256(convert_to(before_row::text,'UTF8')),'hex') AND e.after_hash=encode(sha256(convert_to(after_row::text,'UTF8')),'hex');
 IF aux.mode IN ('reserve','release') AND (app.financial_batch_intent_allowed(aux.batch_id,'edit') OR aux.mode='release' AND app.financial_batch_intent_allowed(aux.batch_id,'delete'))
 AND app.access_financial_action_employment('payroll',aux.employment_id,CASE WHEN app.financial_batch_intent_allowed(aux.batch_id,'delete') THEN 'delete' ELSE 'edit' END)
 AND EXISTS(SELECT 1 FROM public.domain_event audit WHERE audit.tenant_id=aux.tenant_id AND audit.aggregate_id=aux.repayment_id AND audit.aggregate_type='loan-repayment' AND audit.actor_id=aux.user_id AND audit.subject_employment_id=aux.employment_id AND app.financial_audit_written(audit.id) AND audit.event_type=CASE aux.mode WHEN 'reserve' THEN 'loan.instalment.reserved' ELSE 'loan.instalment.reservation-released' END AND audit.payload->>'batchId'=aux.batch_id::text) THEN RETURN NULL;END IF;
 FOR proof IN SELECT * FROM app.financial_loan_repayment_effect e WHERE e.transaction_id=pg_current_xact_id() AND e.tenant_id=app.current_tenant_id() AND e.user_id=app.current_user_id() AND e.loan_id=aux.loan_id AND e.employment_id=aux.employment_id AND app.financial_loan_effect_audited(e.repayment_id,e.mode,e.batch_id) LOOP
  IF aux.mode='auto-stop' AND proof.mode='apply' AND EXISTS(SELECT 1 FROM app.financial_loan_counter_effect e JOIN public.domain_event audit ON audit.tenant_id=e.tenant_id AND audit.aggregate_id=e.loan_id AND audit.event_type='loan.settled' AND audit.actor_id=e.user_id AND app.financial_audit_written(audit.id) WHERE e.transaction_id=proof.transaction_id AND e.tenant_id=proof.tenant_id AND e.user_id=proof.user_id AND e.loan_id=proof.loan_id AND e.repayment_id=proof.repayment_id AND e.mode='apply') THEN RETURN NULL;END IF;
  IF (aux.mode='shortfall-created' AND proof.mode='apply' OR aux.mode='shortfall-removed' AND proof.mode='reverse') AND proof.due_amount>proof.amount AND aux.due_amount=proof.due_amount-proof.amount AND aux.sequence_no>proof.sequence_no
  AND (SELECT count(*) FROM app.financial_loan_auxiliary sibling WHERE sibling.transaction_id=aux.transaction_id AND sibling.tenant_id=aux.tenant_id AND sibling.user_id=aux.user_id AND sibling.loan_id=aux.loan_id AND sibling.mode=aux.mode AND sibling.due_amount=aux.due_amount AND sibling.sequence_no>proof.sequence_no)=1 THEN RETURN NULL;END IF;
 END LOOP;
 RAISE EXCEPTION 'Loan repayment action unavailable' USING ERRCODE='42501';
END;
$$;
REVOKE ALL ON FUNCTION app.access_financial_loan_repayment_guard() FROM PUBLIC,ai_hr_app;
CREATE CONSTRAINT TRIGGER financial_loan_repayment_action AFTER INSERT OR UPDATE OR DELETE ON loan_repayment DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.access_financial_loan_repayment_guard();
--> statement-breakpoint
CREATE TRIGGER financial_receipts_prune AFTER INSERT ON app.financial_loan_repayment_effect FOR EACH ROW EXECUTE FUNCTION app.financial_receipts_prune();
CREATE TRIGGER financial_receipts_prune AFTER INSERT ON app.financial_loan_counter_effect FOR EACH ROW EXECUTE FUNCTION app.financial_receipts_prune();
CREATE TRIGGER financial_receipts_prune AFTER INSERT ON app.financial_loan_auxiliary FOR EACH ROW EXECUTE FUNCTION app.financial_receipts_prune();
--> statement-breakpoint
CREATE TABLE app.financial_claim_effect (
 transaction_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,claim_id uuid NOT NULL,batch_id uuid NOT NULL,employment_id uuid NOT NULL,mode text NOT NULL,operation text NOT NULL,
 before_hash text NOT NULL,after_hash text NOT NULL,PRIMARY KEY(transaction_id,tenant_id,user_id,claim_id,before_hash,after_hash)
);
ALTER TABLE app.financial_claim_effect ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.financial_claim_effect FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.financial_claim_effect_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE before_row jsonb:=to_jsonb(OLD);after_row jsonb:=to_jsonb(NEW);batch uuid;mode text;operation text;period text;
BEGIN
 IF app.access_workforce_storage_owner() OR NOT app.principal_snapshot_current() OR NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() THEN RETURN NULL;END IF;
 IF OLD.status='approved' AND NEW.status='approved' AND OLD.payroll_batch_id IS NULL AND NEW.payroll_batch_id IS NOT NULL AND OLD.taxable
 AND after_row-'payroll_batch_id' IS NOT DISTINCT FROM before_row-'payroll_batch_id' THEN mode:='reserve';batch:=NEW.payroll_batch_id;
 ELSIF OLD.status='approved' AND NEW.status='paid' AND OLD.payroll_batch_id IS NOT NULL AND NEW.payroll_batch_id=OLD.payroll_batch_id AND OLD.taxable AND NEW.paid_at IS NOT NULL
 AND after_row-ARRAY['status','paid_at','payout_ref'] IS NOT DISTINCT FROM before_row-ARRAY['status','paid_at','payout_ref'] THEN mode:='pay';batch:=NEW.payroll_batch_id;
 ELSIF OLD.status='paid' AND NEW.status='approved' AND OLD.payroll_batch_id IS NOT NULL AND NEW.payroll_batch_id=OLD.payroll_batch_id AND NEW.paid_at IS NULL AND NEW.payout_ref IS NULL
 AND after_row-ARRAY['status','paid_at','payout_ref'] IS NOT DISTINCT FROM before_row-ARRAY['status','paid_at','payout_ref'] THEN mode:='unpay';batch:=OLD.payroll_batch_id;
 ELSIF OLD.status='approved' AND NEW.status='approved' AND OLD.payroll_batch_id IS NOT NULL AND NEW.payroll_batch_id IS NULL
 AND after_row-'payroll_batch_id' IS NOT DISTINCT FROM before_row-'payroll_batch_id' THEN mode:='requeue';batch:=OLD.payroll_batch_id;
 ELSE RETURN NULL;END IF;
 operation:=CASE WHEN mode IN ('unpay','requeue') AND app.financial_batch_intent_allowed(batch,'delete') THEN 'delete' ELSE 'edit' END;
 IF NOT app.financial_batch_intent_allowed(batch,operation) OR NOT app.access_financial_action_employment('payroll',NEW.employment_id,operation) THEN RETURN NULL;END IF;
 SELECT b.pay_period INTO period FROM public.payroll_batch b WHERE b.id=batch AND b.tenant_id=NEW.tenant_id;
 IF period IS NULL OR mode='pay' AND (NEW.payout_ref IS DISTINCT FROM 'payroll:'||period OR NOT EXISTS(SELECT 1 FROM public.payslip p WHERE p.tenant_id=NEW.tenant_id AND p.batch_id=batch AND p.employment_id=NEW.employment_id AND app.financial_kernel_row_written('payslip',to_jsonb(p),true))) THEN RETURN NULL;END IF;
 IF mode='reserve' AND NOT EXISTS(SELECT 1 FROM public.payroll_batch b WHERE b.id=batch AND b.tenant_id=NEW.tenant_id AND b.status='draft') THEN RETURN NULL;END IF;
 INSERT INTO app.financial_claim_effect VALUES(pg_current_xact_id(),NEW.tenant_id,app.current_user_id(),NEW.id,batch,NEW.employment_id,mode,operation,encode(sha256(convert_to(before_row::text,'UTF8')),'hex'),encode(sha256(convert_to(after_row::text,'UTF8')),'hex')) ON CONFLICT DO NOTHING;
 RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION app.financial_claim_effect_record() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER financial_claim_effect AFTER UPDATE ON claim_request FOR EACH ROW EXECUTE FUNCTION app.financial_claim_effect_record();
--> statement-breakpoint
CREATE FUNCTION app.financial_claim_payment_approved(p_claim uuid,p_before jsonb,p_after jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND EXISTS(SELECT 1 FROM app.financial_claim_effect proof WHERE proof.transaction_id=pg_current_xact_id() AND proof.tenant_id=app.current_tenant_id() AND proof.user_id=app.current_user_id() AND proof.claim_id=p_claim
 AND proof.before_hash=encode(sha256(convert_to(p_before::text,'UTF8')),'hex') AND proof.after_hash=encode(sha256(convert_to(p_after::text,'UTF8')),'hex')
 AND app.financial_batch_intent_allowed(proof.batch_id,proof.operation) AND app.access_financial_action_employment('payroll',proof.employment_id,proof.operation)
 AND (proof.mode='reserve' AND EXISTS(SELECT 1 FROM public.payroll_input input WHERE input.tenant_id=proof.tenant_id AND input.batch_id=proof.batch_id AND input.employment_id=proof.employment_id AND app.financial_kernel_row_written('payroll_input',to_jsonb(input)))
  OR proof.mode='pay' AND EXISTS(SELECT 1 FROM public.payslip p WHERE p.tenant_id=proof.tenant_id AND p.batch_id=proof.batch_id AND p.employment_id=proof.employment_id AND app.financial_kernel_row_written('payslip',to_jsonb(p),true)) AND EXISTS(SELECT 1 FROM public.payroll_batch b JOIN public.domain_event root_event ON root_event.tenant_id=b.tenant_id AND root_event.aggregate_id=b.id AND root_event.aggregate_type='payroll-batch' AND root_event.actor_id=proof.user_id AND app.financial_audit_written(root_event.id) AND root_event.event_type IN ('payroll-batch.processed','payroll-batch.selective-reprocessed') WHERE b.id=proof.batch_id AND b.tenant_id=proof.tenant_id AND b.status='processed')
  OR proof.mode IN ('unpay','requeue') AND (EXISTS(SELECT 1 FROM public.payroll_batch b WHERE b.id=proof.batch_id AND b.tenant_id=proof.tenant_id AND b.status='draft') OR NOT EXISTS(SELECT 1 FROM public.payslip p WHERE p.tenant_id=proof.tenant_id AND p.batch_id=proof.batch_id AND p.employment_id=proof.employment_id)))
 AND (EXISTS(SELECT 1 FROM public.domain_event audit WHERE audit.tenant_id=proof.tenant_id AND audit.aggregate_id=proof.claim_id AND audit.aggregate_type='claim-request' AND audit.actor_id=proof.user_id AND audit.subject_employment_id=proof.employment_id AND app.financial_audit_written(audit.id) AND audit.payload->>'batchId'=proof.batch_id::text
  AND audit.event_type=CASE proof.mode WHEN 'reserve' THEN 'claim-request.queued-for-payroll' WHEN 'pay' THEN 'claim-request.paid' WHEN 'unpay' THEN 'claim-request.payment-reversed' ELSE 'claim-request.unqueued-from-payroll' END)
  OR proof.mode='requeue' AND proof.operation='edit' AND EXISTS(SELECT 1 FROM public.domain_event audit WHERE audit.tenant_id=proof.tenant_id AND audit.aggregate_id=proof.batch_id AND audit.aggregate_type='payroll-batch' AND audit.event_type='payroll-batch.processed' AND audit.actor_id=proof.user_id AND app.financial_audit_written(audit.id))));
$$;
REVOKE ALL ON FUNCTION app.financial_claim_payment_approved(uuid,jsonb,jsonb) FROM PUBLIC,ai_hr_app;
CREATE TRIGGER financial_receipts_prune AFTER INSERT ON app.financial_claim_effect FOR EACH ROW EXECUTE FUNCTION app.financial_receipts_prune();
--> statement-breakpoint
CREATE FUNCTION app.access_fixed_payroll_action(p_employment uuid,p_operation text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.employment e WHERE e.id=p_employment AND e.tenant_id=app.current_tenant_id() AND app.is_admin_for(e.company_id)
 AND app.function_action_allowed('payroll.fixedTransactions',p_operation,e.company_id)
 AND (app.access_financial_action_employment('payroll',e.id,p_operation)
  OR p_operation='add' AND app.data_permission_employment_born(e.id) AND app.access_workforce_action_employment(e.id,'add')));
$$;
REVOKE ALL ON FUNCTION app.access_fixed_payroll_action(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.access_fixed_payroll_action(uuid,text) TO ai_hr_app;
CREATE TABLE app.financial_fixed_replacement(transaction_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,source_id uuid NOT NULL,source_hash text NOT NULL,projection_hash text NOT NULL,PRIMARY KEY(transaction_id,tenant_id,user_id,source_id));
ALTER TABLE app.financial_fixed_replacement ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.financial_fixed_replacement FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.financial_fixed_projection(value jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('employment_id',value->>'employment_id','component_id',value->>'component_id','amount',(value->>'amount')::numeric,
 'valid_from',value->>'valid_from','valid_to',value->>'valid_to','currency',value->>'currency','prorate_override',value->'prorate_override',
 'remarks',value->>'remarks','run_type',value->>'run_type','payroll_cycle_id',value->>'payroll_cycle_id');
$$;
REVOKE ALL ON FUNCTION app.financial_fixed_projection(jsonb) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.financial_fixed_replacement_begin(p_source uuid,p_expected jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source public.employment_pay_component%ROWTYPE;
BEGIN
 IF NOT app.financial_human_principal_current() THEN RAISE EXCEPTION 'Fixed payroll actor unavailable' USING ERRCODE='42501';END IF;
 PERFORM app.access_workforce_write_lock();
 SELECT * INTO source FROM public.employment_pay_component c WHERE c.id=p_source AND c.tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND OR source.superseded_at IS NOT NULL OR NOT app.access_fixed_payroll_action(source.employment_id,'edit')
 OR p_expected->>'employment_id' IS DISTINCT FROM source.employment_id::text OR p_expected->>'component_id' IS DISTINCT FROM source.component_id::text
 OR jsonb_typeof(p_expected)<>'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_expected) k WHERE k NOT IN ('employment_id','component_id','amount','valid_from','valid_to','currency','prorate_override','remarks','run_type','payroll_cycle_id'))
 THEN RAISE EXCEPTION 'Fixed replacement unavailable' USING ERRCODE='42501';END IF;
 INSERT INTO app.financial_fixed_replacement VALUES(pg_current_xact_id(),source.tenant_id,app.current_user_id(),source.id,
 encode(sha256(convert_to(to_jsonb(source)::text,'UTF8')),'hex'),encode(sha256(convert_to(app.financial_fixed_projection(p_expected)::text,'UTF8')),'hex'));
END;
$$;
REVOKE ALL ON FUNCTION app.financial_fixed_replacement_begin(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.financial_fixed_replacement_begin(uuid,jsonb) TO ai_hr_app;
CREATE FUNCTION app.financial_fixed_replacement_allowed(p_before jsonb,p_after jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app.financial_fixed_replacement proof
 JOIN public.employment_pay_component source ON source.id=proof.source_id AND source.tenant_id=proof.tenant_id
 JOIN public.employment_pay_component replacement ON replacement.employment_id=source.employment_id AND replacement.component_id=source.component_id AND replacement.tenant_id=source.tenant_id AND replacement.id<>source.id
 JOIN public.domain_event event ON event.aggregate_id=replacement.id AND event.event_type='employment-pay-component.set' AND event.tenant_id=source.tenant_id AND app.financial_audit_written(event.id)
 WHERE proof.transaction_id=pg_current_xact_id() AND proof.tenant_id=app.current_tenant_id() AND proof.user_id=app.current_user_id()
 AND app.access_fixed_payroll_action(source.employment_id,'edit') AND app.financial_letter_born('employment_pay_component',replacement.id)='add'
 AND proof.projection_hash=encode(sha256(convert_to(app.financial_fixed_projection(to_jsonb(replacement))::text,'UTF8')),'hex')
 AND (source.superseded_at IS NOT NULL AND replacement.valid_from<=source.valid_from OR source.superseded_at IS NULL AND source.valid_to=replacement.valid_from-1)
 AND (p_before='{}'::jsonb AND p_after=to_jsonb(replacement)
  OR p_before->>'id'=source.id::text AND proof.source_hash=encode(sha256(convert_to(p_before::text,'UTF8')),'hex') AND p_after=to_jsonb(source)
   AND p_before-ARRAY['valid_to','superseded_at'] IS NOT DISTINCT FROM p_after-ARRAY['valid_to','superseded_at']));
$$;
REVOKE ALL ON FUNCTION app.financial_fixed_replacement_allowed(jsonb,jsonb) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.financial_fixed_birth() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.current_user_id() IS NOT NULL THEN INSERT INTO app.financial_letter_birth VALUES(pg_current_xact_id(),NEW.tenant_id,app.current_user_id(),'employment_pay_component',NEW.id,'add') ON CONFLICT DO NOTHING;END IF;RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.financial_fixed_birth() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER financial_fixed_birth AFTER INSERT ON employment_pay_component FOR EACH ROW EXECUTE FUNCTION app.financial_fixed_birth();
CREATE FUNCTION app.access_fixed_payroll_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE before_row jsonb:=CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
 after_row jsonb:=CASE WHEN TG_OP='DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;
 data jsonb:=CASE WHEN TG_OP='DELETE' THEN before_row ELSE after_row END;operation text;
BEGIN
 IF app.access_workforce_storage_owner() THEN RETURN NULL;END IF;
 IF data->>'tenant_id' IS DISTINCT FROM app.current_tenant_id()::text OR TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM unnest(ARRAY['id','tenant_id','employment_id','component_id','created_at','recorded_at'])field(name) WHERE before_row->field.name IS DISTINCT FROM after_row->field.name) THEN RAISE EXCEPTION 'Fixed transaction identity changed' USING ERRCODE='42501';END IF;
 operation:=CASE WHEN TG_OP='DELETE' THEN 'delete' WHEN TG_OP='INSERT' THEN 'add' WHEN OLD.superseded_at IS NULL AND NEW.superseded_at IS NOT NULL THEN 'delete' ELSE 'edit' END;
 IF TG_OP='UPDATE' AND OLD.superseded_at IS NULL AND NEW.superseded_at IS NOT NULL AND EXISTS(SELECT 1 FROM public.employment_pay_component c WHERE c.tenant_id=NEW.tenant_id AND c.employment_id=NEW.employment_id AND c.component_id=NEW.component_id AND c.id<>NEW.id AND c.valid_from<=OLD.valid_from AND app.financial_letter_born('employment_pay_component',c.id)='add') THEN operation:='edit';END IF;
 IF app.financial_fixed_replacement_allowed(before_row,after_row) OR app.access_fixed_payroll_action((data->>'employment_id')::uuid,operation) THEN RETURN NULL;END IF;
 IF TG_OP='UPDATE' AND before_row-'valid_to' IS NOT DISTINCT FROM after_row-'valid_to' AND app.access_fixed_payroll_action(NEW.employment_id,'add')
 AND EXISTS(SELECT 1 FROM public.employment_pay_component c WHERE c.tenant_id=NEW.tenant_id AND c.employment_id=NEW.employment_id AND c.component_id=NEW.component_id AND c.id<>NEW.id AND c.valid_from=NEW.valid_to+1 AND c.superseded_at IS NULL AND app.financial_letter_born('employment_pay_component',c.id)='add') THEN RETURN NULL;END IF;
 RAISE EXCEPTION 'Fixed transaction action unavailable' USING ERRCODE='42501';
END;
$$;
REVOKE ALL ON FUNCTION app.access_fixed_payroll_guard() FROM PUBLIC,ai_hr_app;
CREATE CONSTRAINT TRIGGER financial_fixed_action AFTER INSERT OR UPDATE OR DELETE ON employment_pay_component DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.access_fixed_payroll_guard();

--> statement-breakpoint
CREATE TRIGGER financial_receipts_prune AFTER INSERT ON app.financial_audit_effect FOR EACH ROW EXECUTE FUNCTION app.financial_receipts_prune();

CREATE TRIGGER financial_receipts_prune AFTER INSERT ON app.financial_fixed_replacement FOR EACH ROW EXECUTE FUNCTION app.financial_receipts_prune();

--> statement-breakpoint
-- Exact function parity is distinct from the aggregate family: a template operator's
-- installed native course does not imply Approval or Settings ownership.
CREATE FUNCTION app.financial_letter_same_purpose_not_denied(t uuid,u uuid,cap text,co uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.access_capability c WHERE c.id=cap AND (NOT c.supported OR jsonb_array_length(c.bindings)>0 AND NOT EXISTS(
  SELECT 1 FROM public.access_user_override deny WHERE deny.tenant_id=t AND deny.user_id=u AND deny.capability_id=cap AND deny.effect='deny' AND deny.retired_at IS NULL
  AND (co IS NULL OR deny.company_id IS NULL OR app.access_scope_covers(deny.company_id,co,t)))));
$$;
REVOKE ALL ON FUNCTION app.financial_letter_same_purpose_not_denied(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.financial_function_native(p_tenant uuid,p_user uuid,p_capability text,p_company uuid,p_current boolean) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE function_key text:=regexp_replace(substr(p_capability,10),'\.[^.]+$','');operation text:=substring(p_capability from '[^.]+$');native text;selected uuid;family text;required text[]:='{}';alternatives text[]:='{}';passed boolean:=false;
BEGIN
 IF p_capability NOT LIKE 'function.%' OR p_current AND (p_tenant IS DISTINCT FROM app.current_tenant_id() OR p_user IS DISTINCT FROM app.current_user_id() OR NOT app.principal_snapshot_current()) THEN RETURN false;END IF;
 IF function_key='performance.onehr.setup' THEN
  IF operation NOT IN ('view','add','edit') OR NOT EXISTS(SELECT 1 FROM public.app_user u JOIN public.role_assignment r ON r.app_user_id=u.id AND r.tenant_id=u.tenant_id
   WHERE u.id=p_user AND u.tenant_id=p_tenant AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
   AND r.role::text=ANY(CASE WHEN operation='add' THEN ARRAY['hr_admin','super_admin','performance_comp_partner'] ELSE ARRAY['hr_admin','super_admin','performance_comp_partner','performance_partner'] END)
   AND (p_company IS NULL AND r.company_id IS NULL AND (operation<>'add' OR r.role::text IN ('hr_admin','super_admin')) OR p_company IS NOT NULL AND app.access_scope_covers(r.company_id,p_company,p_tenant))) THEN RETURN false;END IF;
  RETURN NOT p_current OR app.performance_current_native_roles(p_company,CASE WHEN operation='add' AND p_company IS NULL THEN ARRAY['hr_admin','super_admin'] WHEN operation='add' THEN ARRAY['hr_admin','super_admin','performance_comp_partner'] ELSE ARRAY['hr_admin','super_admin','performance_comp_partner','performance_partner'] END);
 END IF;
 IF function_key IN ('performance.onehr.selfReview','performance.onehr.assignedReview') THEN
  RETURN operation='view' AND p_company IS NOT NULL AND EXISTS(SELECT 1 FROM public.performance_review review
   JOIN public.performance_onehr_cycle config ON config.cycle_id=review.cycle_id AND config.tenant_id=review.tenant_id
   JOIN public.employment subject ON subject.id=review.employment_id AND subject.tenant_id=review.tenant_id
   WHERE review.tenant_id=p_tenant AND subject.company_id=p_company
   AND app.financial_onehr_review_course_for(p_tenant,p_user,review.id)=CASE function_key WHEN 'performance.onehr.selfReview' THEN 'self' ELSE 'assigned' END);
 END IF;
 IF function_key='myLetters' THEN
  RETURN p_company IS NULL AND operation IN ('view','execute') AND EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=p_user AND u.tenant_id=p_tenant AND u.archived_at IS NULL AND NOT app.login_blocked(u.id));
 END IF;
 IF function_key IN ('payroll.process','payroll.fixedTransactions','payroll.individualTransactions','payroll.statutoryAdjustments','payroll.backPay') THEN family:='payroll';END IF;
 IF function_key='performance.cycles' THEN
  IF operation NOT IN ('view','add','edit') THEN RETURN false;END IF;
  IF p_company IS NULL AND NOT EXISTS(SELECT 1 FROM public.role_assignment r WHERE r.tenant_id=p_tenant AND r.app_user_id=p_user AND r.role::text IN ('hr_admin','super_admin') AND r.company_id IS NULL) THEN RETURN false;END IF;
  IF p_current AND p_company IS NULL AND NOT app.performance_current_native_roles(NULL,ARRAY['hr_admin','super_admin']) THEN RETURN false;END IF;
  family:='performance_compensation';
 END IF;
 IF family IS NOT NULL THEN
  IF function_key='payroll.backPay' AND operation='execute' THEN operation:='edit';END IF;
  IF operation NOT IN ('view','add','edit','delete') THEN RETURN false;END IF;
  IF function_key IN ('payroll.fixedTransactions','payroll.backPay') AND NOT EXISTS(SELECT 1 FROM public.role_assignment r WHERE r.tenant_id=p_tenant AND r.app_user_id=p_user AND r.role::text IN ('hr_admin','super_admin') AND (p_company IS NULL AND r.company_id IS NULL OR p_company IS NOT NULL AND app.access_scope_covers(r.company_id,p_company,p_tenant))) THEN RETURN false;END IF;
  RETURN CASE WHEN p_current THEN app.financial_letter_current_legacy_allowed(p_tenant,p_user,family||'.'||operation,p_company)
   AND (function_key NOT IN ('payroll.fixedTransactions','payroll.backPay') OR EXISTS(SELECT 1 FROM app.current_grants() g WHERE g.role IN ('hr_admin','super_admin') AND (p_company IS NULL AND g.company_id IS NULL OR p_company IS NOT NULL AND app.access_scope_covers(g.company_id,p_company,p_tenant))))
   ELSE app.financial_letter_legacy_allowed(p_tenant,p_user,family||'.'||operation,p_company) END;
 END IF;
 -- These are the actual independent Letters navigation/service courses. Native read-only
 -- access to fields/templates is not silently changed into native Template maintenance.
 CASE function_key
 WHEN 'letterFields' THEN
  IF operation='view' THEN alternatives:=ARRAY['read','template'];ELSIF operation IN ('add','edit','delete') THEN required:=ARRAY['template'];ELSE RETURN false;END IF;
 WHEN 'letterTemplates' THEN
  IF operation='view' THEN alternatives:=ARRAY['read','template'];ELSIF operation IN ('add','edit','delete','approve') THEN required:=ARRAY['template'];ELSE RETURN false;END IF;
 WHEN 'letterGenerate' THEN
  IF operation='view' THEN required:=ARRAY['read','generate'];ELSIF operation IN ('add','edit','delete') THEN required:=ARRAY['generate'];ELSE RETURN false;END IF;
 WHEN 'letterApproval' THEN
  IF operation NOT IN ('view','approve') THEN RETURN false;END IF;required:=ARRAY['read','approve'];
 WHEN 'letterRegister' THEN
  IF operation='view' THEN required:=ARRAY['read'];ELSIF operation IN ('issue','delete') THEN required:=ARRAY['issue'];ELSE RETURN false;END IF;
 WHEN 'letterReports' THEN
  IF operation<>'view' THEN RETURN false;END IF;required:=ARRAY['read','report'];
 WHEN 'letterSettings' THEN
  IF operation='view' THEN alternatives:=ARRAY['settings','approve'];ELSIF operation IN ('add','edit','delete') THEN required:=ARRAY['settings'];ELSE RETURN false;END IF;
 WHEN 'letterSettings.signature' THEN
  IF operation NOT IN ('view','add') THEN RETURN false;END IF;required:=ARRAY['approve'];
 ELSE RETURN false;END CASE;
 IF p_company IS NULL THEN
  IF NOT EXISTS(SELECT 1 FROM public.role_assignment r WHERE r.tenant_id=p_tenant AND r.app_user_id=p_user AND r.company_id IS NULL AND r.role::text IN ('super_admin','hr_admin')) THEN RETURN false;END IF;
  IF p_current AND NOT EXISTS(SELECT 1 FROM app.current_grants() g WHERE g.role IN ('super_admin','hr_admin') AND g.company_id IS NULL) THEN RETURN false;END IF;
  FOR selected IN SELECT c.id FROM public.company c WHERE c.tenant_id=p_tenant AND c.archived_at IS NULL LOOP
   IF NOT app.financial_function_native(p_tenant,p_user,p_capability,selected,p_current) THEN RETURN false;END IF;
  END LOOP;RETURN true;
 END IF;
 FOREACH native IN ARRAY required LOOP
  IF NOT (CASE WHEN p_current THEN app.letter_current_native_permission(p_tenant,p_user,p_company,native) ELSE app.letter_native_permission_for_user_at(p_tenant,p_user,p_company,native) END) THEN RETURN false;END IF;
 END LOOP;
 IF cardinality(alternatives)=0 THEN RETURN true;END IF;
 FOREACH native IN ARRAY alternatives LOOP
  IF (CASE WHEN p_current THEN app.letter_current_native_permission(p_tenant,p_user,p_company,native) ELSE app.letter_native_permission_for_user_at(p_tenant,p_user,p_company,native) END) THEN passed:=true;END IF;
 END LOOP;RETURN passed;
END;
$$;

REVOKE ALL ON FUNCTION app.financial_function_native(uuid,uuid,text,uuid,boolean) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.financial_function_legacy_allowed(p_tenant uuid,p_user uuid,p_capability text,p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT app.financial_function_native(p_tenant,p_user,p_capability,p_company,false); $$;
CREATE FUNCTION app.financial_function_current_legacy_allowed(p_tenant uuid,p_user uuid,p_capability text,p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT app.financial_function_native(p_tenant,p_user,p_capability,p_company,true); $$;
REVOKE ALL ON FUNCTION app.financial_function_legacy_allowed(uuid,uuid,text,uuid),app.financial_function_current_legacy_allowed(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.financial_delegate_payroll_process(t uuid,u uuid,cap text,co uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT app.financial_function_native(t,u,'function.payroll.process.'||substring(cap from '[^.]+$'),co,true); $$;
REVOKE ALL ON FUNCTION app.financial_delegate_payroll_process(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
SELECT app.register_function_action('payroll.process','view','company','payroll.view','app.financial_delegate_payroll_process','{"moduleKey":"payroll","labelKey":"nav.payrollProcess","kind":"submenu","course":"administrative","screenKey":"payroll","href":"/payroll","employeeBearing":true}'::jsonb);
SELECT app.register_function_action('payroll.process','add','company','payroll.add','app.financial_delegate_payroll_process','{"moduleKey":"payroll","labelKey":"nav.payrollProcess","kind":"submenu","course":"administrative","screenKey":"payroll","href":"/payroll","employeeBearing":true}'::jsonb);
SELECT app.register_function_action('payroll.process','edit','company','payroll.edit','app.financial_delegate_payroll_process','{"moduleKey":"payroll","labelKey":"nav.payrollProcess","kind":"submenu","course":"administrative","screenKey":"payroll","href":"/payroll","employeeBearing":true}'::jsonb);
SELECT app.register_function_action('payroll.process','delete','company','payroll.delete','app.financial_delegate_payroll_process','{"moduleKey":"payroll","labelKey":"nav.payrollProcess","kind":"submenu","course":"administrative","screenKey":"payroll","href":"/payroll","employeeBearing":true}'::jsonb);
CREATE FUNCTION app.financial_delegate_payroll_fixedtransactions(t uuid,u uuid,cap text,co uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT app.financial_function_native(t,u,'function.payroll.fixedTransactions.'||substring(cap from '[^.]+$'),co,true); $$;
REVOKE ALL ON FUNCTION app.financial_delegate_payroll_fixedtransactions(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
SELECT app.register_function_action('payroll.fixedTransactions','view','company','payroll.view','app.financial_delegate_payroll_fixedtransactions','{"moduleKey":"payroll","labelKey":"payroll.transactions.fixed.title","kind":"submenu","course":"administrative","screenKey":"payroll","href":"/payroll/transactions/fixed","employeeBearing":true}'::jsonb);
SELECT app.register_function_action('payroll.fixedTransactions','add','company','payroll.add','app.financial_delegate_payroll_fixedtransactions','{"moduleKey":"payroll","labelKey":"payroll.transactions.fixed.title","kind":"submenu","course":"administrative","screenKey":"payroll","href":"/payroll/transactions/fixed","employeeBearing":true}'::jsonb);
SELECT app.register_function_action('payroll.fixedTransactions','edit','company','payroll.edit','app.financial_delegate_payroll_fixedtransactions','{"moduleKey":"payroll","labelKey":"payroll.transactions.fixed.title","kind":"submenu","course":"administrative","screenKey":"payroll","href":"/payroll/transactions/fixed","employeeBearing":true}'::jsonb);
SELECT app.register_function_action('payroll.fixedTransactions','delete','company','payroll.delete','app.financial_delegate_payroll_fixedtransactions','{"moduleKey":"payroll","labelKey":"payroll.transactions.fixed.title","kind":"submenu","course":"administrative","screenKey":"payroll","href":"/payroll/transactions/fixed","employeeBearing":true}'::jsonb);
CREATE FUNCTION app.financial_delegate_payroll_individualtransactions(t uuid,u uuid,cap text,co uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT app.financial_function_native(t,u,'function.payroll.individualTransactions.'||substring(cap from '[^.]+$'),co,true); $$;
REVOKE ALL ON FUNCTION app.financial_delegate_payroll_individualtransactions(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
SELECT app.register_function_action('payroll.individualTransactions','view','company','payroll.view','app.financial_delegate_payroll_individualtransactions','{"moduleKey":"payroll","labelKey":"payroll.transactions.individual.title","kind":"submenu","course":"administrative","screenKey":"payroll","href":"/payroll/transactions/individual","employeeBearing":true}'::jsonb);
SELECT app.register_function_action('payroll.individualTransactions','add','company','payroll.add','app.financial_delegate_payroll_individualtransactions','{"moduleKey":"payroll","labelKey":"payroll.transactions.individual.title","kind":"submenu","course":"administrative","screenKey":"payroll","href":"/payroll/transactions/individual","employeeBearing":true}'::jsonb);
SELECT app.register_function_action('payroll.individualTransactions','edit','company','payroll.edit','app.financial_delegate_payroll_individualtransactions','{"moduleKey":"payroll","labelKey":"payroll.transactions.individual.title","kind":"submenu","course":"administrative","screenKey":"payroll","href":"/payroll/transactions/individual","employeeBearing":true}'::jsonb);
SELECT app.register_function_action('payroll.individualTransactions','delete','company','payroll.delete','app.financial_delegate_payroll_individualtransactions','{"moduleKey":"payroll","labelKey":"payroll.transactions.individual.title","kind":"submenu","course":"administrative","screenKey":"payroll","href":"/payroll/transactions/individual","employeeBearing":true}'::jsonb);
CREATE FUNCTION app.financial_delegate_payroll_statutoryadjustments(t uuid,u uuid,cap text,co uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT app.financial_function_native(t,u,'function.payroll.statutoryAdjustments.'||substring(cap from '[^.]+$'),co,true); $$;
REVOKE ALL ON FUNCTION app.financial_delegate_payroll_statutoryadjustments(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
SELECT app.register_function_action('payroll.statutoryAdjustments','view','company','payroll.view','app.financial_delegate_payroll_statutoryadjustments','{"moduleKey":"payroll","labelKey":"payroll.statutoryAdjustment.title","kind":"submenu","course":"administrative","screenKey":"payroll","href":"/payroll/statutory-adjustment","employeeBearing":true}'::jsonb);
SELECT app.register_function_action('payroll.statutoryAdjustments','add','company','payroll.add','app.financial_delegate_payroll_statutoryadjustments','{"moduleKey":"payroll","labelKey":"payroll.statutoryAdjustment.title","kind":"submenu","course":"administrative","screenKey":"payroll","href":"/payroll/statutory-adjustment","employeeBearing":true}'::jsonb);
SELECT app.register_function_action('payroll.statutoryAdjustments','edit','company','payroll.edit','app.financial_delegate_payroll_statutoryadjustments','{"moduleKey":"payroll","labelKey":"payroll.statutoryAdjustment.title","kind":"submenu","course":"administrative","screenKey":"payroll","href":"/payroll/statutory-adjustment","employeeBearing":true}'::jsonb);
SELECT app.register_function_action('payroll.statutoryAdjustments','delete','company','payroll.delete','app.financial_delegate_payroll_statutoryadjustments','{"moduleKey":"payroll","labelKey":"payroll.statutoryAdjustment.title","kind":"submenu","course":"administrative","screenKey":"payroll","href":"/payroll/statutory-adjustment","employeeBearing":true}'::jsonb);
CREATE FUNCTION app.financial_delegate_letterfields(t uuid,u uuid,cap text,co uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT app.financial_function_native(t,u,'function.letterFields.'||substring(cap from '[^.]+$'),co,true); $$;
REVOKE ALL ON FUNCTION app.financial_delegate_letterfields(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
SELECT app.register_function_action('letterFields','view','company','letters.view','app.financial_delegate_letterfields','{"moduleKey":"letters","labelKey":"nav.letterFields","kind":"submenu","course":"administrative","screenKey":"letterFields","href":"/letters/fields","employeeBearing":false}'::jsonb);
SELECT app.register_function_action('letterFields','add','company','letters.add','app.financial_delegate_letterfields','{"moduleKey":"letters","labelKey":"nav.letterFields","kind":"submenu","course":"administrative","screenKey":"letterFields","href":"/letters/fields","employeeBearing":false}'::jsonb);
SELECT app.register_function_action('letterFields','edit','company','letters.edit','app.financial_delegate_letterfields','{"moduleKey":"letters","labelKey":"nav.letterFields","kind":"submenu","course":"administrative","screenKey":"letterFields","href":"/letters/fields","employeeBearing":false}'::jsonb);
SELECT app.register_function_action('letterFields','delete','company','letters.delete','app.financial_delegate_letterfields','{"moduleKey":"letters","labelKey":"nav.letterFields","kind":"submenu","course":"administrative","screenKey":"letterFields","href":"/letters/fields","employeeBearing":false}'::jsonb);
CREATE FUNCTION app.financial_delegate_lettertemplates(t uuid,u uuid,cap text,co uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT app.financial_function_native(t,u,'function.letterTemplates.'||substring(cap from '[^.]+$'),co,true); $$;
REVOKE ALL ON FUNCTION app.financial_delegate_lettertemplates(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
SELECT app.register_function_action('letterTemplates','view','company','letters.view','app.financial_delegate_lettertemplates','{"moduleKey":"letters","labelKey":"nav.letterTemplates","kind":"submenu","course":"administrative","screenKey":"letterTemplates","href":"/letters/templates","employeeBearing":false}'::jsonb);
SELECT app.register_function_action('letterTemplates','add','company','letters.add','app.financial_delegate_lettertemplates','{"moduleKey":"letters","labelKey":"nav.letterTemplates","kind":"submenu","course":"administrative","screenKey":"letterTemplates","href":"/letters/templates","employeeBearing":false}'::jsonb);
SELECT app.register_function_action('letterTemplates','edit','company','letters.edit','app.financial_delegate_lettertemplates','{"moduleKey":"letters","labelKey":"nav.letterTemplates","kind":"submenu","course":"administrative","screenKey":"letterTemplates","href":"/letters/templates","employeeBearing":false}'::jsonb);
SELECT app.register_function_action('letterTemplates','delete','company','letters.delete','app.financial_delegate_lettertemplates','{"moduleKey":"letters","labelKey":"nav.letterTemplates","kind":"submenu","course":"administrative","screenKey":"letterTemplates","href":"/letters/templates","employeeBearing":false}'::jsonb);
SELECT app.register_function_action('letterTemplates','approve','company','letters.approve','app.financial_delegate_lettertemplates','{"moduleKey":"letters","labelKey":"nav.letterTemplates","kind":"submenu","course":"administrative","screenKey":"letterTemplates","href":"/letters/templates","employeeBearing":false}'::jsonb);
CREATE FUNCTION app.financial_delegate_lettergenerate(t uuid,u uuid,cap text,co uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT app.financial_function_native(t,u,'function.letterGenerate.'||substring(cap from '[^.]+$'),co,true); $$;
REVOKE ALL ON FUNCTION app.financial_delegate_lettergenerate(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
SELECT app.register_function_action('letterGenerate','view','company','letters.view','app.financial_delegate_lettergenerate','{"moduleKey":"letters","labelKey":"nav.letterGenerate","kind":"submenu","course":"administrative","screenKey":"letterGenerate","href":"/letters/generate","employeeBearing":true}'::jsonb);
SELECT app.register_function_action('letterGenerate','add','company','letters.add','app.financial_delegate_lettergenerate','{"moduleKey":"letters","labelKey":"nav.letterGenerate","kind":"submenu","course":"administrative","screenKey":"letterGenerate","href":"/letters/generate","employeeBearing":true}'::jsonb);
SELECT app.register_function_action('letterGenerate','edit','company','letters.edit','app.financial_delegate_lettergenerate','{"moduleKey":"letters","labelKey":"nav.letterGenerate","kind":"submenu","course":"administrative","screenKey":"letterGenerate","href":"/letters/generate","employeeBearing":true}'::jsonb);
SELECT app.register_function_action('letterGenerate','delete','company','letters.delete','app.financial_delegate_lettergenerate','{"moduleKey":"letters","labelKey":"nav.letterGenerate","kind":"submenu","course":"administrative","screenKey":"letterGenerate","href":"/letters/generate","employeeBearing":true}'::jsonb);
CREATE FUNCTION app.financial_delegate_letterapproval(t uuid,u uuid,cap text,co uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT app.financial_function_native(t,u,'function.letterApproval.'||substring(cap from '[^.]+$'),co,true) AND (substring(cap from '[^.]+$')<>'approve' OR app.financial_letter_same_purpose_not_denied(t,u,'letters.approve',co)); $$;
REVOKE ALL ON FUNCTION app.financial_delegate_letterapproval(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
SELECT app.register_function_action('letterApproval','view','company',NULL,'app.financial_delegate_letterapproval','{"moduleKey":"letters","labelKey":"nav.letterApproval","kind":"submenu","course":"assigned","screenKey":"letterApproval","href":"/letters/approval","employeeBearing":false}'::jsonb);
SELECT app.register_function_action('letterApproval','approve','company',NULL,'app.financial_delegate_letterapproval','{"moduleKey":"letters","labelKey":"nav.letterApproval","kind":"submenu","course":"assigned","screenKey":"letterApproval","href":"/letters/approval","employeeBearing":false}'::jsonb);
CREATE FUNCTION app.financial_delegate_letterregister(t uuid,u uuid,cap text,co uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT app.financial_function_native(t,u,'function.letterRegister.'||substring(cap from '[^.]+$'),co,true); $$;
REVOKE ALL ON FUNCTION app.financial_delegate_letterregister(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
SELECT app.register_function_action('letterRegister','view','company','letters.view','app.financial_delegate_letterregister','{"moduleKey":"letters","labelKey":"nav.letterRegister","kind":"submenu","course":"administrative","screenKey":"letterRegister","href":"/letters/register","employeeBearing":true}'::jsonb);
SELECT app.register_function_action('letterRegister','issue','company','letters.issue','app.financial_delegate_letterregister','{"moduleKey":"letters","labelKey":"nav.letterRegister","kind":"submenu","course":"administrative","screenKey":"letterRegister","href":"/letters/register","employeeBearing":true}'::jsonb);
SELECT app.register_function_action('letterRegister','delete','company','letters.delete','app.financial_delegate_letterregister','{"moduleKey":"letters","labelKey":"nav.letterRegister","kind":"submenu","course":"administrative","screenKey":"letterRegister","href":"/letters/register","employeeBearing":true}'::jsonb);
CREATE FUNCTION app.financial_delegate_lettersettings(t uuid,u uuid,cap text,co uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT app.financial_function_native(t,u,'function.letterSettings.'||substring(cap from '[^.]+$'),co,true); $$;
REVOKE ALL ON FUNCTION app.financial_delegate_lettersettings(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
SELECT app.register_function_action('letterSettings','view','company','letters.view','app.financial_delegate_lettersettings','{"moduleKey":"letters","labelKey":"nav.letterSettings","kind":"submenu","course":"administrative","screenKey":"letterSettings","href":"/letters/settings","employeeBearing":false}'::jsonb);
SELECT app.register_function_action('letterSettings','add','company','letters.add','app.financial_delegate_lettersettings','{"moduleKey":"letters","labelKey":"nav.letterSettings","kind":"submenu","course":"administrative","screenKey":"letterSettings","href":"/letters/settings","employeeBearing":false}'::jsonb);
SELECT app.register_function_action('letterSettings','edit','company','letters.edit','app.financial_delegate_lettersettings','{"moduleKey":"letters","labelKey":"nav.letterSettings","kind":"submenu","course":"administrative","screenKey":"letterSettings","href":"/letters/settings","employeeBearing":false}'::jsonb);
SELECT app.register_function_action('letterSettings','delete','company','letters.delete','app.financial_delegate_lettersettings','{"moduleKey":"letters","labelKey":"nav.letterSettings","kind":"submenu","course":"administrative","screenKey":"letterSettings","href":"/letters/settings","employeeBearing":false}'::jsonb);

--> statement-breakpoint
-- Every one-off physical change has its own immutable source image. Native Process may move only
-- attachment/consumption bookkeeping; it cannot edit the ledger's money, dates, intent or provenance.
CREATE TABLE app.financial_individual_effect(
 transaction_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,row_id uuid NOT NULL,
 before_hash text NOT NULL,after_hash text NOT NULL,before_row jsonb NOT NULL,after_row jsonb NOT NULL,
 company_id uuid NOT NULL,old_company_id uuid,employment_id uuid NOT NULL,batch_id uuid,
 mode text,operation text,PRIMARY KEY(transaction_id,tenant_id,user_id,row_id,before_hash,after_hash)
);
ALTER TABLE app.financial_individual_effect ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.financial_individual_effect FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.financial_individual_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE b jsonb:=CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
 a jsonb:=CASE WHEN TG_OP='DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;
 d jsonb:=CASE WHEN TG_OP='DELETE' THEN b ELSE a END;co uuid;old_co uuid;batch uuid;mode text;operation text;
 run public.payroll_batch;
BEGIN
 IF app.access_workforce_storage_owner() THEN RETURN NULL;END IF;
 IF NOT app.principal_snapshot_current() OR d->>'tenant_id' IS DISTINCT FROM app.current_tenant_id()::text THEN RAISE EXCEPTION 'Individual transaction action unavailable' USING ERRCODE='42501';END IF;
 co:=(d->>'company_id')::uuid;old_co:=(b->>'company_id')::uuid;
 IF co IS NULL THEN SELECT company_id INTO co FROM public.payroll_batch WHERE id=(d->>'batch_id')::uuid AND tenant_id=app.current_tenant_id();END IF;
 IF old_co IS NULL AND b->>'batch_id' IS NOT NULL THEN SELECT company_id INTO old_co FROM public.payroll_batch WHERE id=(b->>'batch_id')::uuid AND tenant_id=app.current_tenant_id();END IF;
 IF co IS NULL THEN RAISE EXCEPTION 'Individual transaction company unavailable' USING ERRCODE='42501';END IF;
 IF TG_OP='UPDATE' THEN
  IF OLD.batch_id IS NULL AND NEW.batch_id IS NOT NULL AND a-'batch_id' IS NOT DISTINCT FROM b-'batch_id' THEN mode:='attach';batch:=NEW.batch_id;
  ELSIF OLD.consumed_batch_id IS NULL AND NEW.consumed_batch_id IS NOT NULL AND NEW.consumed_at IS NOT NULL AND NEW.batch_id=NEW.consumed_batch_id
   AND a-ARRAY['consumed_batch_id','consumed_at'] IS NOT DISTINCT FROM b-ARRAY['consumed_batch_id','consumed_at'] THEN mode:='consume';batch:=NEW.consumed_batch_id;
  ELSIF OLD.consumed_batch_id IS NOT NULL AND NEW.consumed_batch_id IS NULL AND NEW.consumed_at IS NULL
   AND a-ARRAY['consumed_batch_id','consumed_at'] IS NOT DISTINCT FROM b-ARRAY['consumed_batch_id','consumed_at'] THEN mode:='release';batch:=OLD.consumed_batch_id;
  ELSIF OLD.batch_id IS NOT NULL AND NEW.batch_id IS NULL AND NEW.consumed_batch_id IS NULL AND NEW.consumed_at IS NULL
   AND a-ARRAY['batch_id','company_id','pay_period'] IS NOT DISTINCT FROM b-ARRAY['batch_id','company_id','pay_period'] THEN mode:='detach';batch:=OLD.batch_id;
  END IF;
  IF mode IS NOT NULL THEN
   SELECT * INTO run FROM public.payroll_batch WHERE id=batch AND tenant_id=app.current_tenant_id();
   operation:=CASE WHEN mode IN ('release','detach') AND app.financial_batch_intent_allowed(batch,'delete') THEN 'delete' ELSE 'edit' END;
   IF run.id IS NULL OR NOT app.financial_batch_intent_allowed(batch,operation)
    OR NOT app.access_financial_action_employment('payroll',NEW.employment_id,operation) THEN mode:=NULL;
   ELSIF mode IN ('attach','detach') AND (NEW.company_id IS DISTINCT FROM run.company_id OR NEW.pay_period IS DISTINCT FROM run.pay_period) THEN mode:=NULL;
   ELSIF mode='attach' AND NOT (run.run_type='regular' AND (NEW.intended_cycle_id IS NULL OR EXISTS(SELECT 1 FROM public.payroll_cycle c WHERE c.tenant_id=run.tenant_id AND c.company_id=run.company_id AND c.id=NEW.intended_cycle_id AND c.run_type='regular')) OR run.run_type<>'regular' AND run.payroll_cycle_id IS NOT NULL AND NEW.intended_cycle_id=run.payroll_cycle_id) THEN mode:=NULL;
   END IF;
  END IF;
 END IF;
 INSERT INTO app.financial_individual_effect VALUES(pg_current_xact_id(),app.current_tenant_id(),app.current_user_id(),(d->>'id')::uuid,
  encode(sha256(convert_to(b::text,'UTF8')),'hex'),encode(sha256(convert_to(a::text,'UTF8')),'hex'),b,a,co,old_co,(d->>'employment_id')::uuid,batch,mode,operation) ON CONFLICT DO NOTHING;
 RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION app.financial_individual_record() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER financial_individual_effect AFTER INSERT OR UPDATE OR DELETE ON payroll_individual_txn FOR EACH ROW EXECUTE FUNCTION app.financial_individual_record();
--> statement-breakpoint
CREATE FUNCTION app.access_individual_payroll_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE b jsonb:=CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
 a jsonb:=CASE WHEN TG_OP='DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;
 d jsonb:=CASE WHEN TG_OP='DELETE' THEN b ELSE a END;proof app.financial_individual_effect;operation text;
BEGIN
 IF app.access_workforce_storage_owner() THEN RETURN NULL;END IF;
 SELECT * INTO proof FROM app.financial_individual_effect e WHERE e.transaction_id=pg_current_xact_id() AND e.tenant_id=app.current_tenant_id() AND e.user_id=app.current_user_id() AND e.row_id=(d->>'id')::uuid
 AND e.before_hash=encode(sha256(convert_to(b::text,'UTF8')),'hex') AND e.after_hash=encode(sha256(convert_to(a::text,'UTF8')),'hex');
 IF proof.row_id IS NULL OR NOT app.principal_snapshot_current() THEN RAISE EXCEPTION 'Individual transaction source unavailable' USING ERRCODE='42501';END IF;
 IF app.financial_backpay_posting_approved(b,a) THEN RETURN NULL;END IF;
 operation:=CASE TG_OP WHEN 'INSERT' THEN 'add' WHEN 'DELETE' THEN 'delete' ELSE 'edit' END;
 -- Genuine entry/import edits require their own View and action, not Process authority.
 IF app.function_action_allowed('payroll.individualTransactions',operation,proof.company_id)
 AND app.access_financial_action_employment('payroll',proof.employment_id,operation)
 AND (proof.old_company_id IS NULL OR app.function_action_allowed('payroll.individualTransactions',operation,proof.old_company_id) AND app.access_financial_action_company('payroll',proof.old_company_id,operation))
 AND (d->>'batch_id' IS NULL OR EXISTS(SELECT 1 FROM public.payroll_batch run WHERE run.id=(d->>'batch_id')::uuid AND run.tenant_id=proof.tenant_id AND run.status IN ('draft','processed') AND run.company_id=proof.company_id))
 AND (TG_OP<>'INSERT' OR a->>'consumed_batch_id' IS NULL AND a->>'consumed_at' IS NULL)
 AND (TG_OP<>'UPDATE' OR a-ARRAY['kind','component_id','txn_date','amount','quantity','unit','notes','intended_cycle_id','updated_at'] IS NOT DISTINCT FROM b-ARRAY['kind','component_id','txn_date','amount','quantity','unit','notes','intended_cycle_id','updated_at']) THEN RETURN NULL;END IF;
 IF proof.mode IS NOT NULL AND app.financial_batch_intent_allowed(proof.batch_id,proof.operation)
 AND app.access_financial_action_employment('payroll',proof.employment_id,proof.operation) THEN
  IF proof.mode='consume' AND EXISTS(SELECT 1 FROM public.payslip p WHERE p.tenant_id=proof.tenant_id AND p.batch_id=proof.batch_id AND p.employment_id=proof.employment_id AND app.financial_kernel_row_written('payslip',to_jsonb(p),true))
   AND EXISTS(SELECT 1 FROM public.domain_event audit WHERE audit.tenant_id=proof.tenant_id AND audit.aggregate_id=proof.batch_id AND audit.aggregate_type='payroll-batch' AND audit.actor_id=proof.user_id AND audit.event_type IN ('payroll-batch.processed','payroll-batch.selective-reprocessed') AND app.financial_audit_written(audit.id)) THEN RETURN NULL;END IF;
  IF proof.mode='attach' AND EXISTS(SELECT 1 FROM public.domain_event audit WHERE audit.tenant_id=proof.tenant_id AND audit.aggregate_id=proof.row_id AND audit.aggregate_type='payroll-individual-txn' AND audit.actor_id=proof.user_id AND audit.subject_employment_id=proof.employment_id AND audit.event_type='payroll.individual-txn.attached' AND audit.payload->>'batchId'=proof.batch_id::text AND app.financial_audit_written(audit.id))
   AND EXISTS(SELECT 1 FROM public.payroll_batch run JOIN public.domain_event audit ON audit.tenant_id=run.tenant_id AND audit.aggregate_id=run.id AND audit.aggregate_type='payroll-batch' AND audit.actor_id=proof.user_id AND audit.event_type IN ('payroll-batch.processed','payroll-batch.selective-reprocessed') AND app.financial_audit_written(audit.id) WHERE run.id=proof.batch_id AND run.tenant_id=proof.tenant_id AND run.status='processed') THEN RETURN NULL;END IF;
  IF proof.mode IN ('release','detach') AND NOT EXISTS(SELECT 1 FROM public.payslip p WHERE p.tenant_id=proof.tenant_id AND p.batch_id=proof.batch_id AND p.employment_id=proof.employment_id)
   AND EXISTS(SELECT 1 FROM public.domain_event audit WHERE audit.tenant_id=proof.tenant_id AND audit.aggregate_id=proof.batch_id AND audit.aggregate_type='payroll-batch' AND audit.actor_id=proof.user_id AND audit.event_type IN ('payroll-batch.reset','payroll-batch.deleted','payroll-batch.employee-payroll-removed') AND app.financial_audit_written(audit.id))
   AND (proof.mode<>'detach' OR EXISTS(SELECT 1 FROM public.domain_event audit WHERE audit.tenant_id=proof.tenant_id AND audit.aggregate_id=proof.row_id AND audit.aggregate_type='payroll-individual-txn' AND audit.actor_id=proof.user_id AND audit.event_type='payroll.individual-txn.detached' AND audit.payload->>'batchId'=proof.batch_id::text AND app.financial_audit_written(audit.id))) THEN RETURN NULL;END IF;
 END IF;
 RAISE EXCEPTION 'Individual transaction action unavailable' USING ERRCODE='42501';
END;
$$;
REVOKE ALL ON FUNCTION app.access_individual_payroll_guard() FROM PUBLIC,ai_hr_app;
CREATE CONSTRAINT TRIGGER financial_individual_action AFTER INSERT OR UPDATE OR DELETE ON payroll_individual_txn DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.access_individual_payroll_guard();
CREATE TRIGGER financial_receipts_prune AFTER INSERT ON app.financial_individual_effect FOR EACH ROW EXECUTE FUNCTION app.financial_receipts_prune();

--> statement-breakpoint
CREATE FUNCTION app.access_backpay_action(p_company uuid,p_operation text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT p_operation IN ('view','add','edit','delete','execute') AND app.is_admin_for(p_company)
 AND app.access_financial_action_company('payroll',p_company,CASE WHEN p_operation='execute' THEN 'edit' ELSE p_operation END)
 AND app.function_action_allowed('payroll.backPay',p_operation,p_company);
$$;
REVOKE ALL ON FUNCTION app.access_backpay_action(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.access_backpay_action(uuid,text) TO ai_hr_app;
CREATE TABLE app.financial_backpay_posting(
 transaction_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,run_id uuid NOT NULL,row_id uuid NOT NULL,
 employment_id uuid NOT NULL,affected_period text NOT NULL,amount numeric(12,2) NOT NULL,mode text NOT NULL,source_hash text NOT NULL,
 PRIMARY KEY(transaction_id,tenant_id,user_id,run_id,row_id,mode)
);
ALTER TABLE app.financial_backpay_posting ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.financial_backpay_posting FROM PUBLIC,ai_hr_app;
CREATE TABLE app.financial_backpay_birth(
 transaction_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,run_id uuid NOT NULL,company_id uuid NOT NULL,row_hash text NOT NULL,completed boolean NOT NULL DEFAULT false,
 PRIMARY KEY(transaction_id,tenant_id,user_id,run_id)
);
ALTER TABLE app.financial_backpay_birth ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.financial_backpay_birth FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.access_backpay_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a jsonb:=CASE WHEN TG_OP='DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;
 b jsonb:=CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
 d jsonb:=CASE WHEN TG_OP='DELETE' THEN b ELSE a END;run public.back_pay_run;operation text;total numeric;period text;txn uuid;source jsonb;
BEGIN
 IF app.access_workforce_storage_owner() THEN IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;END IF;
 PERFORM app.access_workforce_write_lock();
 IF d->>'tenant_id' IS DISTINCT FROM app.current_tenant_id()::text OR NOT app.principal_snapshot_current() OR TG_OP='DELETE' THEN RAISE EXCEPTION 'Back Pay action unavailable' USING ERRCODE='42501';END IF;
 IF TG_TABLE_NAME='back_pay_run' THEN
  operation:=CASE WHEN TG_OP='INSERT' THEN 'add' WHEN NEW.status='cancelled' AND OLD.status<>'cancelled' THEN 'delete' WHEN NEW.status='posted' AND OLD.status IN ('draft','verified') THEN 'execute' ELSE 'edit' END;
  IF NOT app.access_backpay_action(NEW.company_id,operation) THEN RAISE EXCEPTION 'Back Pay action unavailable' USING ERRCODE='42501';END IF;
  IF TG_OP='INSERT' THEN
   IF NEW.status<>'draft' OR NEW.created_by_user_id IS DISTINCT FROM app.current_user_id() OR NEW.approved_by_user_id IS NOT NULL OR NEW.approved_at IS NOT NULL OR NEW.posted_at IS NOT NULL OR NEW.cancelled_by_user_id IS NOT NULL OR NEW.cancelled_at IS NOT NULL THEN RAISE EXCEPTION 'Back Pay must start as an owned draft' USING ERRCODE='42501';END IF;
   IF EXISTS(SELECT 1 FROM public.back_pay_run existing WHERE existing.id=NEW.id) THEN RAISE EXCEPTION 'Back Pay source identity already exists' USING ERRCODE='23505';END IF;
   INSERT INTO app.financial_backpay_birth VALUES(pg_current_xact_id(),NEW.tenant_id,app.current_user_id(),NEW.id,NEW.company_id,encode(sha256(convert_to(a::text,'UTF8')),'hex'),false);
  ELSE
   IF a-ARRAY['status','approved_by_user_id','approved_at','posted_at','cancelled_by_user_id','cancelled_at','updated_at'] IS DISTINCT FROM b-ARRAY['status','approved_by_user_id','approved_at','posted_at','cancelled_by_user_id','cancelled_at','updated_at']
    OR NOT (operation='execute' AND NEW.approved_by_user_id=app.current_user_id() AND NEW.approved_at IS NOT NULL AND NEW.posted_at IS NOT NULL AND a-ARRAY['status','approved_by_user_id','approved_at','posted_at','updated_at'] IS NOT DISTINCT FROM b-ARRAY['status','approved_by_user_id','approved_at','posted_at','updated_at']
     OR operation='delete' AND OLD.status IN ('draft','verified','posted') AND NEW.cancelled_by_user_id=app.current_user_id() AND NEW.cancelled_at IS NOT NULL AND a-ARRAY['status','cancelled_by_user_id','cancelled_at','updated_at'] IS NOT DISTINCT FROM b-ARRAY['status','cancelled_by_user_id','cancelled_at','updated_at']
     OR operation='edit' AND OLD.status='draft' AND NEW.status='verified' AND a-ARRAY['status','updated_at'] IS NOT DISTINCT FROM b-ARRAY['status','updated_at']) THEN RAISE EXCEPTION 'Back Pay transition unavailable' USING ERRCODE='42501';END IF;
  END IF;
 ELSE
  SELECT * INTO run FROM public.back_pay_run WHERE id=NEW.run_id AND tenant_id=app.current_tenant_id() FOR UPDATE;
  IF run.id IS NULL OR NOT app.data_permission_matches(NEW.employment_id) OR NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.id=NEW.employment_id AND e.tenant_id=run.tenant_id AND app.is_admin_for(e.company_id) AND app.access_financial_action_employment('payroll',e.id,CASE WHEN TG_OP='INSERT' THEN 'add' ELSE 'edit' END)) THEN RAISE EXCEPTION 'Back Pay subject unavailable' USING ERRCODE='42501';END IF;
  IF TG_OP='INSERT' THEN
   IF run.status<>'draft' OR NEW.posted_txn_id IS NOT NULL OR NOT app.access_backpay_action(run.company_id,'add') OR app.financial_letter_born('back_pay_run',run.id) IS DISTINCT FROM 'add' THEN RAISE EXCEPTION 'Back Pay calculation source unavailable' USING ERRCODE='42501';END IF;
  ELSE
   IF a-'posted_txn_id' IS DISTINCT FROM b-'posted_txn_id' OR NEW.posted_txn_id IS NOT DISTINCT FROM OLD.posted_txn_id THEN RAISE EXCEPTION 'Back Pay source evidence is immutable' USING ERRCODE='42501';END IF;
   operation:=CASE WHEN NEW.posted_txn_id IS NULL THEN 'delete' ELSE 'execute' END;
   IF NOT app.access_backpay_action(run.company_id,operation) OR operation='execute' AND (run.status NOT IN ('draft','verified') OR OLD.posted_txn_id IS NOT NULL) OR operation='delete' AND run.status<>'posted' THEN RAISE EXCEPTION 'Back Pay posting transition unavailable' USING ERRCODE='42501';END IF;
   txn:=coalesce(NEW.posted_txn_id,OLD.posted_txn_id);
   -- Freeze the complete net before cancellation clears any source links. Each source row stays
   -- immutable; a posted transaction cannot later be substituted for a different employee/period.
   SELECT round(sum(l.difference),2),min(l.affected_period) INTO total,period FROM public.back_pay_line l WHERE l.tenant_id=run.tenant_id AND l.run_id=run.id AND l.employment_id=NEW.employment_id AND l.affected_period=NEW.affected_period AND NOT l.needs_review;
   SELECT to_jsonb(t) INTO source FROM public.payroll_individual_txn t WHERE t.id=txn AND t.tenant_id=run.tenant_id AND t.employment_id=NEW.employment_id AND t.company_id=run.company_id AND t.pay_period=run.target_pay_period AND t.consumed_batch_id IS NULL;
   IF source IS NULL OR operation='execute' AND NOT EXISTS(SELECT 1 FROM app.financial_individual_effect e WHERE e.transaction_id=pg_current_xact_id() AND e.tenant_id=run.tenant_id AND e.user_id=app.current_user_id() AND e.row_id=txn AND e.before_row='{}'::jsonb AND e.after_hash=encode(sha256(convert_to(source::text,'UTF8')),'hex')) THEN RAISE EXCEPTION 'Back Pay posting source unavailable' USING ERRCODE='42501';END IF;
   IF total IS NULL OR abs(total)<0.01 OR NEW.needs_review THEN RAISE EXCEPTION 'Back Pay net unavailable' USING ERRCODE='42501';END IF;
   INSERT INTO app.financial_backpay_posting VALUES(pg_current_xact_id(),run.tenant_id,app.current_user_id(),run.id,txn,NEW.employment_id,period,total,operation,encode(sha256(convert_to(source::text,'UTF8')),'hex')) ON CONFLICT DO NOTHING;
  END IF;
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.access_backpay_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER financial_backpay_action BEFORE INSERT OR UPDATE OR DELETE ON back_pay_run FOR EACH ROW EXECUTE FUNCTION app.access_backpay_guard();
CREATE TRIGGER financial_backpay_action BEFORE INSERT OR UPDATE OR DELETE ON back_pay_line FOR EACH ROW EXECUTE FUNCTION app.access_backpay_guard();
CREATE TRIGGER financial_backpay_birth AFTER INSERT ON back_pay_run FOR EACH ROW EXECUTE FUNCTION app.financial_letter_record_birth();
CREATE FUNCTION app.financial_backpay_birth_finish() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_LEVEL='ROW' THEN
  UPDATE app.financial_backpay_birth SET completed=true WHERE transaction_id=pg_current_xact_id() AND tenant_id=NEW.tenant_id AND user_id=app.current_user_id() AND run_id=NEW.id AND company_id=NEW.company_id AND row_hash=encode(sha256(convert_to(to_jsonb(NEW)::text,'UTF8')),'hex');
 ELSE
  DELETE FROM app.financial_backpay_birth WHERE transaction_id=pg_current_xact_id() AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND NOT completed;
 END IF;RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION app.financial_backpay_birth_finish() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER financial_backpay_birth_finish AFTER INSERT ON back_pay_run FOR EACH ROW EXECUTE FUNCTION app.financial_backpay_birth_finish();
CREATE TRIGGER financial_backpay_birth_cleanup AFTER INSERT ON back_pay_run FOR EACH STATEMENT EXECUTE FUNCTION app.financial_backpay_birth_finish();
CREATE TRIGGER financial_receipts_prune AFTER INSERT ON app.financial_backpay_birth FOR EACH ROW EXECUTE FUNCTION app.financial_receipts_prune();
CREATE FUNCTION app.financial_backpay_birth_validate() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM app.financial_backpay_birth proof JOIN public.back_pay_run run ON run.id=proof.run_id AND run.tenant_id=proof.tenant_id AND run.company_id=proof.company_id AND run.created_by_user_id=proof.user_id
 WHERE proof.transaction_id=NEW.transaction_id AND proof.tenant_id=NEW.tenant_id AND proof.user_id=NEW.user_id AND proof.run_id=NEW.run_id AND proof.completed
 AND proof.transaction_id=pg_current_xact_id() AND proof.tenant_id=app.current_tenant_id() AND proof.user_id=app.current_user_id()
 AND EXISTS(SELECT 1 FROM public.domain_event audit WHERE audit.tenant_id=proof.tenant_id AND audit.aggregate_type='back-pay-run' AND audit.aggregate_id=proof.run_id AND audit.event_type='back-pay.calculated' AND audit.actor_type='user' AND audit.actor_id=proof.user_id AND app.financial_audit_written(audit.id))) THEN RAISE EXCEPTION 'Back Pay birth did not complete' USING ERRCODE='42501';END IF;
 RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION app.financial_backpay_birth_validate() FROM PUBLIC,ai_hr_app;
CREATE CONSTRAINT TRIGGER financial_backpay_birth_complete AFTER INSERT ON app.financial_backpay_birth DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.financial_backpay_birth_validate();


CREATE TRIGGER financial_receipts_prune AFTER INSERT ON app.financial_backpay_posting FOR EACH ROW EXECUTE FUNCTION app.financial_receipts_prune();
--> statement-breakpoint
CREATE FUNCTION app.financial_backpay_posting_approved(p_before jsonb,p_after jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app.financial_backpay_posting proof JOIN public.back_pay_run run ON run.id=proof.run_id AND run.tenant_id=proof.tenant_id
 LEFT JOIN public.pay_component component ON component.id=(coalesce(p_after->>'component_id',p_before->>'component_id'))::uuid AND component.tenant_id=run.tenant_id
 WHERE proof.transaction_id=pg_current_xact_id() AND proof.tenant_id=app.current_tenant_id() AND proof.user_id=app.current_user_id()
 AND proof.row_id=coalesce(p_after->>'id',p_before->>'id')::uuid
 AND app.access_backpay_action(run.company_id,proof.mode) AND app.data_permission_matches(proof.employment_id)
 AND (proof.mode='execute' AND p_before='{}'::jsonb AND run.status='posted' AND run.approved_by_user_id=proof.user_id AND EXISTS(SELECT 1 FROM public.back_pay_line l WHERE l.tenant_id=proof.tenant_id AND l.run_id=proof.run_id AND l.posted_txn_id=proof.row_id AND l.employment_id=proof.employment_id AND l.affected_period=proof.affected_period)
  OR proof.mode='delete' AND p_after='{}'::jsonb AND run.status='cancelled' AND run.cancelled_by_user_id=proof.user_id AND NOT EXISTS(SELECT 1 FROM public.back_pay_line l WHERE l.tenant_id=proof.tenant_id AND l.posted_txn_id=proof.row_id))
 AND proof.source_hash=encode(sha256(convert_to(coalesce(nullif(p_after,'{}'::jsonb),p_before)::text,'UTF8')),'hex')
 AND (proof.mode='delete' OR (
 coalesce(nullif(p_after,'{}'::jsonb),p_before)->>'company_id'=run.company_id::text
 AND coalesce(nullif(p_after,'{}'::jsonb),p_before)->>'pay_period'=run.target_pay_period
 AND coalesce(nullif(p_after,'{}'::jsonb),p_before)->>'employment_id'=proof.employment_id::text
 AND coalesce(nullif(p_after,'{}'::jsonb),p_before)->>'kind'=CASE WHEN proof.amount>=0 THEN 'earning' ELSE 'deduction' END
 AND (coalesce(nullif(p_after,'{}'::jsonb),p_before)->>'amount')::numeric=abs(proof.amount)
 AND component.code=CASE WHEN proof.amount>=0 THEN 'BACKPAY' ELSE 'BACKPAY_RECOVERY' END
 AND coalesce(nullif(p_after,'{}'::jsonb),p_before)->>'txn_date'=run.target_pay_period||'-01'
 AND coalesce(nullif(p_after,'{}'::jsonb),p_before)->>'notes'='Back pay '||proof.affected_period||' (run '||left(run.id::text,8)||')'
 AND coalesce(nullif(p_after,'{}'::jsonb),p_before)->>'consumed_batch_id' IS NULL
 AND coalesce(nullif(p_after,'{}'::jsonb),p_before)->>'consumed_at' IS NULL
 AND (coalesce(nullif(p_after,'{}'::jsonb),p_before)->>'batch_id' IS NULL OR EXISTS(SELECT 1 FROM public.payroll_batch batch WHERE batch.tenant_id=run.tenant_id AND batch.id=(coalesce(nullif(p_after,'{}'::jsonb),p_before)->>'batch_id')::uuid AND batch.company_id=run.company_id AND batch.pay_period=run.target_pay_period AND batch.run_type='regular' AND batch.status='draft'))
 ))
 AND EXISTS(SELECT 1 FROM public.domain_event audit WHERE audit.tenant_id=proof.tenant_id AND audit.aggregate_id=run.id AND audit.aggregate_type='back-pay-run' AND audit.actor_id=proof.user_id AND audit.event_type=CASE WHEN proof.mode='execute' THEN 'back-pay.posted' ELSE 'back-pay.cancelled' END AND app.financial_audit_written(audit.id)));
$$;
REVOKE ALL ON FUNCTION app.financial_backpay_posting_approved(jsonb,jsonb) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.financial_delegate_payroll_backpay(t uuid,u uuid,cap text,co uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT app.financial_function_native(t,u,'function.payroll.backPay.'||substring(cap from '[^.]+$'),co,true); $$;
REVOKE ALL ON FUNCTION app.financial_delegate_payroll_backpay(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
SELECT app.register_function_action('payroll.backPay',operation,'company','payroll.'||CASE WHEN operation='execute' THEN 'edit' ELSE operation END,'app.financial_delegate_payroll_backpay','{"moduleKey":"payroll","labelKey":"payroll.backPay.title","kind":"submenu","course":"administrative","screenKey":"payroll","href":"/payroll/back-pay","employeeBearing":true}'::jsonb)
FROM unnest(ARRAY['view','add','edit','delete','execute']) operation;

--> statement-breakpoint
CREATE FUNCTION app.financial_backpay_subjects_allowed(p_run uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT NOT EXISTS(SELECT 1 FROM public.back_pay_line line WHERE line.run_id=p_run AND line.tenant_id=app.current_tenant_id() AND NOT app.data_permission_matches(line.employment_id));
$$;
REVOKE ALL ON FUNCTION app.financial_backpay_subjects_allowed(uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.financial_backpay_scope_allowed(p_run uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.back_pay_run run WHERE run.id=p_run AND run.tenant_id=app.current_tenant_id()
 AND app.access_backpay_action(run.company_id,'view')
 AND app.financial_backpay_subjects_allowed(run.id));
$$;
REVOKE ALL ON FUNCTION app.financial_backpay_scope_allowed(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.financial_backpay_scope_allowed(uuid) TO ai_hr_app;
CREATE FUNCTION app.financial_backpay_row_read(p_row jsonb) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 RETURN app.principal_snapshot_current() AND p_row->>'tenant_id'=app.current_tenant_id()::text
 AND app.access_backpay_action((p_row->>'company_id')::uuid,'view')
 AND (EXISTS(SELECT 1 FROM public.back_pay_run run WHERE run.id=(p_row->>'id')::uuid AND run.tenant_id=app.current_tenant_id() AND run.company_id=(p_row->>'company_id')::uuid)
  OR EXISTS(SELECT 1 FROM app.financial_backpay_birth proof WHERE proof.transaction_id=pg_current_xact_id() AND proof.tenant_id=app.current_tenant_id() AND proof.user_id=app.current_user_id() AND proof.run_id=(p_row->>'id')::uuid AND proof.company_id=(p_row->>'company_id')::uuid AND proof.row_hash=encode(sha256(convert_to(p_row::text,'UTF8')),'hex')))
 AND app.financial_backpay_subjects_allowed((p_row->>'id')::uuid);
END;
$$;
REVOKE ALL ON FUNCTION app.financial_backpay_row_read(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.financial_backpay_row_read(jsonb) TO ai_hr_app;
-- The public predicate first proves an actual native-visible root or its exact private proposed
-- birth. The raw subject predicate has no application EXECUTE or guessed-ID existence oracle.
CREATE POLICY financial_backpay_read ON back_pay_run AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(app.financial_backpay_row_read(to_jsonb(back_pay_run)));
CREATE POLICY financial_backpay_read ON back_pay_line AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(app.financial_backpay_scope_allowed(run_id) AND app.data_permission_matches(employment_id));

--> statement-breakpoint
-- First-use Back Pay pay items are a finite consequence of the admitted posting command. Runtime
-- supplies only the actual run and one fixed kind; it cannot submit catalogue values or mint proofs.
CREATE TABLE app.financial_backpay_catalog_effect(
 transaction_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,run_id uuid NOT NULL,
 component_id uuid NOT NULL,after_hash text NOT NULL,PRIMARY KEY(transaction_id,tenant_id,user_id,run_id,component_id)
);
ALTER TABLE app.financial_backpay_catalog_effect ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.financial_backpay_catalog_effect FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.backpay_component(p_run uuid,p_kind text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE run public.back_pay_run;component public.pay_component;wanted_code text;
BEGIN
 IF NOT app.financial_human_principal_current() THEN RAISE EXCEPTION 'Back Pay actor unavailable' USING ERRCODE='42501';END IF;
 PERFORM app.access_workforce_write_lock();
 PERFORM pg_advisory_xact_lock(hashtextextended(app.current_tenant_id()::text||':pay-component-catalog',0));
 SELECT * INTO run FROM public.back_pay_run WHERE id=p_run AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF p_kind IS NULL OR p_kind NOT IN ('earning','deduction') OR run.id IS NULL OR run.status NOT IN ('draft','verified')
 OR NOT app.access_backpay_action(run.company_id,'execute') OR NOT app.financial_backpay_scope_allowed(run.id) THEN RAISE EXCEPTION 'Back Pay pay item source unavailable' USING ERRCODE='42501';END IF;
 wanted_code:=CASE p_kind WHEN 'earning' THEN 'BACKPAY' ELSE 'BACKPAY_RECOVERY' END;
 SELECT * INTO component FROM public.pay_component c WHERE c.tenant_id=run.tenant_id AND c.code=wanted_code;
 IF FOUND THEN RETURN component.id;END IF;
 INSERT INTO public.pay_component(tenant_id,code,name,kind,included_in_epf,included_in_socso_eis,included_in_pcb,included_in_hrdf_base,is_non_payable,prorates,pcb_remuneration_type,pcb_exemption_code,display_category)
 VALUES(run.tenant_id,wanted_code,CASE p_kind WHEN 'earning' THEN 'Back Pay (Arrears)' ELSE 'Back Pay Recovery' END,
  CASE p_kind WHEN 'earning' THEN 'allowance'::public.pay_component_kind ELSE 'deduction'::public.pay_component_kind END,
  true,true,true,true,false,false,NULL,NULL,CASE p_kind WHEN 'earning' THEN 'allowance' ELSE 'deduction' END)
 RETURNING * INTO component;
 INSERT INTO app.financial_backpay_catalog_effect VALUES(pg_current_xact_id(),run.tenant_id,app.current_user_id(),run.id,component.id,encode(sha256(convert_to(to_jsonb(component)::text,'UTF8')),'hex'));
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
 VALUES(run.tenant_id,'pay-component',component.id,'pay-component.created','user',app.current_user_id(),jsonb_build_object('code',wanted_code,'reason','back-pay-first-use'));
 RETURN component.id;
END;
$$;
REVOKE ALL ON FUNCTION app.backpay_component(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.backpay_component(uuid,text) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.financial_backpay_catalog_run_complete(p_run uuid,p_component uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND EXISTS(SELECT 1 FROM public.back_pay_run run
 WHERE run.id=p_run AND run.tenant_id=app.current_tenant_id() AND run.status='posted' AND run.approved_by_user_id=app.current_user_id()
 AND app.access_backpay_action(run.company_id,'execute') AND app.financial_backpay_scope_allowed(run.id)
 AND EXISTS(SELECT 1 FROM public.domain_event audit WHERE audit.tenant_id=run.tenant_id AND audit.aggregate_id=run.id AND audit.aggregate_type='back-pay-run' AND audit.actor_type='user' AND audit.actor_id=app.current_user_id() AND audit.event_type='back-pay.posted' AND app.financial_audit_written(audit.id))
 AND EXISTS(SELECT 1 FROM public.domain_event audit WHERE audit.tenant_id=run.tenant_id AND audit.aggregate_id=p_component AND audit.aggregate_type='pay-component' AND audit.actor_type='user' AND audit.actor_id=app.current_user_id() AND audit.event_type='pay-component.created' AND audit.payload->>'reason'='back-pay-first-use' AND app.financial_audit_written(audit.id)));
$$;
REVOKE ALL ON FUNCTION app.financial_backpay_catalog_run_complete(uuid,uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.financial_backpay_catalog_approved(p_before jsonb,p_after jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT (p_before IS NULL OR p_before='{}'::jsonb) AND p_after IS NOT NULL
 AND EXISTS(SELECT 1 FROM app.financial_backpay_catalog_effect proof WHERE proof.transaction_id=pg_current_xact_id()
 AND proof.tenant_id=app.current_tenant_id() AND proof.user_id=app.current_user_id() AND proof.component_id=(p_after->>'id')::uuid
 AND proof.after_hash=encode(sha256(convert_to(p_after::text,'UTF8')),'hex') AND app.financial_backpay_catalog_run_complete(proof.run_id,proof.component_id));
$$;
REVOKE ALL ON FUNCTION app.financial_backpay_catalog_approved(jsonb,jsonb) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.financial_backpay_catalog_finish() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW.transaction_id<>pg_current_xact_id() OR NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NEW.user_id IS DISTINCT FROM app.current_user_id()
 OR NOT app.financial_backpay_catalog_run_complete(NEW.run_id,NEW.component_id) THEN RAISE EXCEPTION 'Back Pay catalogue consequence is incomplete' USING ERRCODE='42501';END IF;
 RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION app.financial_backpay_catalog_finish() FROM PUBLIC,ai_hr_app;
CREATE CONSTRAINT TRIGGER financial_backpay_catalog_complete AFTER INSERT ON app.financial_backpay_catalog_effect DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.financial_backpay_catalog_finish();
CREATE TRIGGER financial_receipts_prune AFTER INSERT ON app.financial_backpay_catalog_effect FOR EACH ROW EXECUTE FUNCTION app.financial_receipts_prune();

--> statement-breakpoint
CREATE FUNCTION app.financial_delegate_letterreports(t uuid,u uuid,cap text,co uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT app.financial_function_native(t,u,'function.letterReports.'||substring(cap from '[^.]+$'),co,true); $$;
CREATE FUNCTION app.financial_delegate_myletters(t uuid,u uuid,cap text,co uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT app.financial_function_native(t,u,'function.myLetters.'||substring(cap from '[^.]+$'),co,true); $$;
CREATE FUNCTION app.financial_delegate_lettersignature(t uuid,u uuid,cap text,co uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT app.financial_function_native(t,u,'function.letterSettings.signature.'||substring(cap from '[^.]+$'),co,true); $$;
REVOKE ALL ON FUNCTION app.financial_delegate_letterreports(uuid,uuid,text,uuid),app.financial_delegate_myletters(uuid,uuid,text,uuid),app.financial_delegate_lettersignature(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
SELECT app.register_function_action('letterReports','view','company','letters.view','app.financial_delegate_letterreports','{"moduleKey":"letters","labelKey":"nav.letterReports","kind":"screen","course":"administrative","screenKey":"letterReports","href":"/letters/reports","employeeBearing":true}'::jsonb);
SELECT app.register_function_action('myLetters','view','tenant',NULL,'app.financial_delegate_myletters','{"moduleKey":"letters","labelKey":"nav.myLetters","kind":"screen","course":"own","screenKey":"myLetters","href":"/me/letters","employeeBearing":false}'::jsonb);
SELECT app.register_function_action('myLetters','execute','tenant',NULL,'app.financial_delegate_myletters','{"moduleKey":"letters","labelKey":"nav.myLetters","kind":"screen","course":"own","screenKey":"myLetters","href":"/me/letters","employeeBearing":false}'::jsonb);
SELECT app.register_function_action('letterSettings.signature','view','company',NULL,'app.financial_delegate_lettersignature','{"moduleKey":"letters","labelKey":"letters.settings.signature","kind":"native_acl","course":"own","href":"/letters/settings","employeeBearing":false}'::jsonb);
SELECT app.register_function_action('letterSettings.signature','add','company',NULL,'app.financial_delegate_lettersignature','{"moduleKey":"letters","labelKey":"letters.settings.signature","kind":"native_acl","course":"own","href":"/letters/settings","employeeBearing":false}'::jsonb);
--> statement-breakpoint
CREATE FUNCTION app.letter_function_action(p_key text,p_operation text,p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT p_key IN ('letterFields','letterTemplates','letterGenerate','letterApproval','letterRegister','letterReports','letterSettings','letterSettings.signature')
 AND app.financial_function_native(app.current_tenant_id(),app.current_user_id(),'function.'||p_key||'.'||p_operation,p_company,true)
 AND app.function_action_allowed(p_key,p_operation,p_company)
 AND (p_key<>'letterApproval' OR p_operation<>'approve' OR app.financial_letter_same_purpose_not_denied(app.current_tenant_id(),app.current_user_id(),'letters.approve',p_company));
$$;
REVOKE ALL ON FUNCTION app.letter_function_action(text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.letter_function_action(text,text,uuid) TO ai_hr_app;
CREATE FUNCTION app.letter_recipient_function_action(p_operation text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT p_operation IN ('view','execute')
 AND app.financial_function_native(app.current_tenant_id(),app.current_user_id(),'function.myLetters.'||p_operation,NULL,true)
 AND app.function_action_allowed('myLetters',p_operation,NULL);
$$;
REVOKE ALL ON FUNCTION app.letter_recipient_function_action(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.letter_recipient_function_action(text) TO ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.financial_letter_function_for_user(p_tenant uuid,p_user uuid,p_key text,p_operation text,p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app.access_function_action action JOIN public.access_capability capability ON capability.id=action.capability_id
 WHERE action.function_key=p_key AND action.operation=p_operation
 AND (p_key<>'letterApproval' OR p_operation<>'approve' OR app.financial_letter_same_purpose_not_denied(p_tenant,p_user,'letters.approve',p_company))
 AND app.financial_function_native(p_tenant,p_user,capability.id,p_company,false)
 AND (NOT capability.supported OR jsonb_array_length(capability.bindings)>0 AND app.access_allowed_for_tenant(p_tenant,p_user,capability.id,p_company)));
$$;
REVOKE ALL ON FUNCTION app.financial_letter_function_for_user(uuid,uuid,text,text,uuid) FROM PUBLIC,ai_hr_app;
-- The native Approve primitive also owns an independent own-signature image course. Each actual
-- mutation below chooses its exact source, so one does not lend the other's denied action.
CREATE OR REPLACE FUNCTION app.access_letter_action_for_user(p_tenant uuid,p_user uuid,p_company uuid,p_native text,p_operation text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT p_operation IN ('view','add','edit','delete','approve','issue') AND app.letter_native_permission_for_user_at(p_tenant,p_user,p_company,p_native)
 AND CASE
 WHEN p_native='approve' THEN p_operation='approve' AND (app.financial_letter_function_for_user(p_tenant,p_user,'letterApproval','approve',p_company) OR app.financial_letter_function_for_user(p_tenant,p_user,'letterSettings.signature','add',p_company) OR app.financial_letter_function_for_user(p_tenant,p_user,'letterSettings.signature','view',p_company))
 WHEN p_native='read' THEN p_operation='view' AND (app.financial_letter_capability_allowed_for(p_tenant,p_user,'letters.view',p_company) OR app.financial_letter_function_for_user(p_tenant,p_user,'letterApproval','view',p_company))
 ELSE app.financial_letter_capability_allowed_for(p_tenant,p_user,'letters.view',p_company)
 AND app.financial_letter_capability_allowed_for(p_tenant,p_user,'letters.'||p_operation,p_company)
 AND CASE p_native
  WHEN 'generate' THEN app.financial_letter_function_for_user(p_tenant,p_user,'letterGenerate',p_operation,p_company)
  WHEN 'settings' THEN app.financial_letter_function_for_user(p_tenant,p_user,'letterSettings',p_operation,p_company)
  WHEN 'issue' THEN app.financial_letter_function_for_user(p_tenant,p_user,'letterRegister',p_operation,p_company)
  WHEN 'report' THEN p_operation='view' AND app.financial_letter_function_for_user(p_tenant,p_user,'letterReports','view',p_company)
  ELSE p_native='template' END END;
$$;
CREATE OR REPLACE FUNCTION app.access_letter_action(p_company uuid,p_native text,p_operation text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.financial_human_principal_current() AND app.letter_current_native_permission(app.current_tenant_id(),app.current_user_id(),p_company,p_native)
 AND app.access_letter_action_for_user(app.current_tenant_id(),app.current_user_id(),p_company,p_native,p_operation)
 AND CASE
 WHEN p_native='approve' THEN app.letter_function_action('letterApproval','approve',p_company) OR app.letter_function_action('letterSettings.signature','add',p_company) OR app.letter_function_action('letterSettings.signature','view',p_company)
 WHEN p_native='read' THEN app.financial_letter_capability_allowed_current('letters.view',p_company) OR app.letter_function_action('letterApproval','view',p_company)
 ELSE app.financial_letter_capability_allowed_current('letters.view',p_company) AND app.financial_letter_capability_allowed_current('letters.'||p_operation,p_company)
 AND CASE p_native WHEN 'generate' THEN app.letter_function_action('letterGenerate',p_operation,p_company)
 WHEN 'settings' THEN app.letter_function_action('letterSettings',p_operation,p_company)
 WHEN 'issue' THEN app.letter_function_action('letterRegister',p_operation,p_company)
 WHEN 'report' THEN app.letter_function_action('letterReports','view',p_company) ELSE p_native='template' END END;
$$;
CREATE OR REPLACE FUNCTION app.letter_permission(co uuid,cap text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.access_letter_action(co,cap,CASE cap WHEN 'approve' THEN 'approve' WHEN 'issue' THEN 'issue' ELSE 'view' END);
$$;
--> statement-breakpoint
CREATE FUNCTION app.financial_letter_native_function(p_native text,p_operation text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE p_native WHEN 'generate' THEN 'letterGenerate' WHEN 'approve' THEN 'letterApproval' WHEN 'issue' THEN 'letterRegister' WHEN 'settings' THEN 'letterSettings' END;
$$;
REVOKE ALL ON FUNCTION app.financial_letter_native_function(text,text) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.access_letter_recipient_function_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.access_workforce_storage_owner() THEN RETURN NEW;END IF;
 IF TG_TABLE_NAME='letter_access_token' THEN
  IF NOT app.letter_recipient_function_action('view') THEN RAISE EXCEPTION 'Own letter access unavailable' USING ERRCODE='42501';END IF;
 ELSE
  IF NOT app.letter_recipient_function_action(CASE WHEN NEW.kind='viewed' THEN 'view' ELSE 'execute' END) THEN RAISE EXCEPTION 'Own letter action unavailable' USING ERRCODE='42501';END IF;
 END IF;RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.access_letter_recipient_function_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER financial_letter_recipient_function BEFORE INSERT ON letter_recipient_event FOR EACH ROW EXECUTE FUNCTION app.access_letter_recipient_function_guard();
CREATE TRIGGER financial_letter_recipient_function BEFORE INSERT ON letter_access_token FOR EACH ROW EXECUTE FUNCTION app.access_letter_recipient_function_guard();
CREATE POLICY financial_letter_token_read ON letter_access_token AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(app.letter_recipient_function_action('view'));
--> statement-breakpoint
-- These actual recipient readers keep their unchanged tenant/person/current-artifact conditions.
DO $$DECLARE signature text;body text;needle text:='app.is_self_person(e.person_id)';BEGIN
 FOREACH signature IN ARRAY ARRAY['app.letter_can_read(uuid)','app.letter_recipient_mode(uuid)','app.letter_recipient_link_minutes(uuid)'] LOOP
  SELECT pg_get_functiondef(to_regprocedure(signature)) INTO body;
  IF body IS NULL OR (length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'Recipient source binding drift: %',signature;END IF;
  EXECUTE replace(body,needle,'(app.is_self_person(e.person_id) AND app.letter_recipient_function_action(''view''))');
 END LOOP;
END $$;

--> statement-breakpoint
CREATE CONSTRAINT TRIGGER financial_letter_recipient_function_final AFTER INSERT ON letter_recipient_event DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.access_letter_recipient_function_guard();
CREATE CONSTRAINT TRIGGER financial_letter_recipient_function_final AFTER INSERT ON letter_access_token DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.access_letter_recipient_function_guard();
CREATE FUNCTION app.letter_settings_record_read(p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.letter_function_action('letterSettings','view',p_company)
 AND app.letter_current_native_permission(app.current_tenant_id(),app.current_user_id(),p_company,'settings');
$$;
REVOKE ALL ON FUNCTION app.letter_settings_record_read(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.letter_settings_record_read(uuid) TO ai_hr_app;
CREATE POLICY financial_letter_function_read ON letter_record AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(
 app.letter_function_action('letterGenerate','view',company_id)
 OR app.letter_function_action('letterRegister','view',company_id)
 OR app.letter_function_action('letterReports','view',company_id)
 OR app.letter_settings_record_read(company_id)
 OR app.letter_function_action('letterApproval','view',company_id) AND app.letter_staff_scope(company_id,created_by,batch_id,id)
 OR state IN ('issued','void') AND app.letter_recipient_function_action('view') AND EXISTS(SELECT 1 FROM public.employment self WHERE self.id=employment_id AND self.tenant_id=letter_record.tenant_id AND app.is_self_person(self.person_id))
);
--> statement-breakpoint
-- Reminder eligibility repeats the exact assigned Approval course rather than borrowing the
-- distinct own-signature primitive which uses the same legacy native Approve ACL.
DO $$DECLARE body text;needle text:='NOT app.letter_permission_for_user_at(wanted_tenant,j.recipient_user_id,l.company_id,''approve'')';BEGIN
 SELECT pg_get_functiondef('identity_email.letter_job_current(uuid,uuid)'::regprocedure) INTO body;
 IF body IS NULL OR (length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'Assigned letter reminder binding drift';END IF;
 EXECUTE replace(body,needle,needle||' OR NOT app.financial_letter_function_for_user(wanted_tenant,j.recipient_user_id,''letterApproval'',''approve'',l.company_id)');
END $$;

--> statement-breakpoint
CREATE POLICY financial_letter_signature_read ON letter_asset AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(kind<>'signature' OR owner_user_id=app.current_user_id() AND app.letter_function_action('letterSettings.signature','view',company_id));

--> statement-breakpoint
-- A native role ACL applies to future accounts too. An actor with Department/Grade/etc predicates
-- cannot create a role-wide administrative reader for unknown future employees in the company.
CREATE FUNCTION app.financial_letter_native_acl_company_ceiling(p_company uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE rules jsonb;
BEGIN
 IF NOT app.principal_snapshot_current() THEN RETURN false;END IF;
 IF NOT EXISTS(SELECT 1 FROM public.user_data_permission_assignment a WHERE a.tenant_id=app.current_tenant_id() AND a.user_id=app.current_user_id()) THEN RETURN true;END IF;
 SELECT revision.rules INTO rules FROM public.user_data_permission_assignment a JOIN public.data_permission_profile profile ON profile.id=a.profile_id AND profile.tenant_id=a.tenant_id AND profile.enabled AND profile.retired_at IS NULL
 JOIN public.data_permission_revision revision ON revision.id=profile.active_revision_id AND revision.profile_id=profile.id AND revision.tenant_id=profile.tenant_id
 WHERE a.tenant_id=app.current_tenant_id() AND a.user_id=app.current_user_id();
 IF rules IS NULL OR NOT app.data_permission_rules_valid(rules) THEN RETURN false;END IF;
 IF (rules->>'legacyCompany')::boolean THEN RETURN true;END IF;
 RETURN NOT EXISTS(SELECT 1 FROM jsonb_array_elements(rules->'predicates') field WHERE field->>'field'<>'company')
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(rules->'predicates') field CROSS JOIN LATERAL jsonb_array_elements_text(field->'values') selected(value) WHERE field->>'field'='company' AND app.access_scope_covers(selected.value::uuid,p_company,app.current_tenant_id()));
END;
$$;
REVOKE ALL ON FUNCTION app.financial_letter_native_acl_company_ceiling(uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.financial_letter_delegate_cell(p_key text,p_operation text,p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.letter_function_action(p_key,p_operation,p_company) AND EXISTS(SELECT 1 FROM app.access_function_action action JOIN public.access_capability capability ON capability.id=action.capability_id
 WHERE action.function_key=p_key AND action.operation=p_operation AND (NOT capability.supported OR app.access_can_delegate(capability.id,p_company)));
$$;
REVOKE ALL ON FUNCTION app.financial_letter_delegate_cell(text,text,uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.financial_letter_native_grant_ceiling() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE value jsonb:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;co uuid:=(value->>'company_id')::uuid;role_name text:=value->>'role';native text:=value->>'capability';granting boolean;recipient uuid;key text;operation text;keys text[];operations text[];
BEGIN
 IF app.access_workforce_storage_owner() THEN IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;END IF;
 PERFORM app.access_workforce_write_lock();
 IF value->>'tenant_id' IS DISTINCT FROM app.current_tenant_id()::text OR NOT app.principal_snapshot_current() THEN RAISE EXCEPTION 'Letter native grant source unavailable' USING ERRCODE='42501';END IF;
 granting:=CASE WHEN TG_OP='DELETE' THEN role_name IN ('hr_admin','super_admin') ELSE (value->>'allowed')::boolean END;
 IF TG_WHEN='BEFORE' AND granting THEN
  IF NOT app.letter_current_native_permission(app.current_tenant_id(),app.current_user_id(),co,native) THEN RAISE EXCEPTION 'Letter native authority ceiling' USING ERRCODE='42501';END IF;
  CASE native
  WHEN 'read' THEN keys:=ARRAY['letterFields','letterTemplates','letterGenerate','letterApproval','letterRegister','letterReports'];operations:=ARRAY['view'];
  WHEN 'template' THEN keys:=ARRAY['letterFields','letterTemplates'];operations:=ARRAY['view','add','edit','delete'];
  WHEN 'generate' THEN keys:=ARRAY['letterGenerate'];operations:=ARRAY['view','add','edit','delete'];
  WHEN 'approve' THEN keys:=ARRAY['letterApproval'];operations:=ARRAY['view','approve'];
  WHEN 'issue' THEN keys:=ARRAY['letterRegister'];operations:=ARRAY['view','issue','delete'];
  WHEN 'report' THEN keys:=ARRAY['letterReports'];operations:=ARRAY['view'];
  WHEN 'settings' THEN keys:=ARRAY['letterSettings'];operations:=ARRAY['view','add','edit','delete'];
  ELSE RAISE EXCEPTION 'Unknown native Letter authority' USING ERRCODE='42501';END CASE;
  FOREACH key IN ARRAY keys LOOP FOREACH operation IN ARRAY operations LOOP
   IF NOT app.financial_letter_delegate_cell(key,operation,co) THEN RAISE EXCEPTION 'Letter function delegation ceiling' USING ERRCODE='42501';END IF;
  END LOOP;END LOOP;
  IF native='template' AND NOT app.financial_letter_delegate_cell('letterTemplates','approve',co) OR native='approve' AND (NOT app.financial_letter_delegate_cell('letterSettings.signature','view',co) OR NOT app.financial_letter_delegate_cell('letterSettings.signature','add',co)) THEN RAISE EXCEPTION 'Letter function delegation ceiling' USING ERRCODE='42501';END IF;
  IF native IN ('read','generate','issue','report') AND NOT app.financial_letter_native_acl_company_ceiling(co) THEN RAISE EXCEPTION 'Letter future recipient data ceiling' USING ERRCODE='42501';END IF;
 END IF;
 -- The role's actual before and after recipients are checked against their retained administrative
 -- profile; own/assigned-only recipients keep their independent course. No group or override is minted.
 FOR recipient IN SELECT DISTINCT assignment.app_user_id FROM public.role_assignment assignment JOIN public.app_user account ON account.id=assignment.app_user_id AND account.tenant_id=assignment.tenant_id AND account.archived_at IS NULL
 WHERE assignment.tenant_id=app.current_tenant_id() AND assignment.role::text=role_name AND app.access_scope_covers(assignment.company_id,co,assignment.tenant_id) LOOP
  IF NOT app.data_permission_function_target_ceiling(recipient) THEN RAISE EXCEPTION 'Letter recipient data ceiling' USING ERRCODE='42501';END IF;
 END LOOP;
 IF TG_WHEN='AFTER' THEN
  FOR recipient IN SELECT DISTINCT assignment.app_user_id FROM public.role_assignment assignment JOIN public.app_user account ON account.id=assignment.app_user_id AND account.tenant_id=assignment.tenant_id AND account.archived_at IS NULL
  WHERE assignment.tenant_id=app.current_tenant_id() AND assignment.role::text=role_name AND app.access_scope_covers(assignment.company_id,co,assignment.tenant_id) LOOP
   PERFORM app.access_refresh_native_defaults(recipient);
  END LOOP;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.financial_letter_native_grant_ceiling() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER financial_letter_native_grant_before BEFORE INSERT OR UPDATE OR DELETE ON letter_capability_grant FOR EACH ROW EXECUTE FUNCTION app.financial_letter_native_grant_ceiling();
CREATE TRIGGER financial_letter_native_grant_after AFTER INSERT OR UPDATE OR DELETE ON letter_capability_grant FOR EACH ROW EXECUTE FUNCTION app.financial_letter_native_grant_ceiling();

--> statement-breakpoint
-- OneHR's Performance Partner is a distinct native course, not Financial/PerformanceComp authority.
-- Pure assessment_admin_for remains the arbitrary stored-target owner. CURRENT native callers also
-- prove the actual claimed role/scope, so retained global Employee cannot lend a narrowed-away HR seat.
CREATE FUNCTION app.performance_current_native_roles(p_company uuid,p_roles text[]) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.financial_human_principal_current() AND EXISTS(SELECT 1 FROM public.app_user account
 JOIN public.role_assignment stored ON stored.app_user_id=account.id AND stored.tenant_id=account.tenant_id
 JOIN app.current_grants() claimed ON claimed.role=stored.role::text
 WHERE account.id=app.current_user_id() AND account.tenant_id=app.current_tenant_id() AND account.archived_at IS NULL AND NOT app.login_blocked(account.id)
 AND stored.role::text=ANY(p_roles)
 AND (p_company IS NULL AND stored.company_id IS NULL AND claimed.company_id IS NULL
  OR p_company IS NOT NULL AND app.access_scope_covers(stored.company_id,p_company,account.tenant_id) AND app.access_scope_covers(claimed.company_id,p_company,account.tenant_id)));
$$;
REVOKE ALL ON FUNCTION app.performance_current_native_roles(uuid,text[]) FROM PUBLIC,ai_hr_app;
CREATE OR REPLACE FUNCTION app.onehr_admin(wanted_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.assessment_admin_for(app.current_user_id(),wanted_company)
 AND app.performance_current_native_roles(wanted_company,ARRAY['hr_admin','super_admin','performance_comp_partner','performance_partner']);
$$;
CREATE OR REPLACE FUNCTION app.onehr_admin_nonpartner(wanted_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.performance_current_native_roles(wanted_company,ARRAY['hr_admin','super_admin','performance_comp_partner']);
$$;
CREATE OR REPLACE FUNCTION app.onehr_partner_for(wanted_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.performance_current_native_roles(wanted_company,ARRAY['performance_partner']);
$$;
CREATE OR REPLACE FUNCTION app.onehr_admin_anywhere() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.onehr_admin(NULL) OR EXISTS(SELECT 1 FROM app.current_grants() claimed WHERE claimed.company_id IS NOT NULL
 AND claimed.role IN ('hr_admin','super_admin','performance_comp_partner','performance_partner') AND app.onehr_admin(claimed.company_id));
$$;
REVOKE ALL ON FUNCTION app.onehr_admin_nonpartner(uuid) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
-- Generic cycle administration belongs to perf-comp administrators. OneHR Partner's
-- native no-op row lock remains separate and cannot authorize changing this kernel row.
CREATE FUNCTION app.financial_delegate_performance_cycles(t uuid,u uuid,cap text,co uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.financial_function_native(t,u,'function.performance.cycles.'||substring(cap from '[^.]+$'),co,true);
$$;
REVOKE ALL ON FUNCTION app.financial_delegate_performance_cycles(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
SELECT app.register_function_action('performance.cycles',operation,'company','performance_compensation.'||operation,'app.financial_delegate_performance_cycles',
 '{"moduleKey":"performance_compensation","labelKey":"performance.list.title","kind":"submenu","course":"administrative","screenKey":"performance","href":"/performance","employeeBearing":true}'::jsonb)
FROM unnest(ARRAY['view','add','edit']) operation;
CREATE FUNCTION app.performance_cycle_function_action(co uuid,operation text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT operation IN ('view','add','edit') AND app.financial_function_native(app.current_tenant_id(),app.current_user_id(),'function.performance.cycles.'||operation,co,true)
 AND app.access_financial_action_company('performance_compensation',co,operation)
 AND CASE WHEN co IS NOT NULL THEN app.function_action_allowed('performance.cycles','view',co) AND app.function_action_allowed('performance.cycles',operation,co)
 ELSE app.financial_letter_capability_allowed_current('function.performance.cycles.view',NULL)
 AND app.financial_letter_capability_allowed_current('function.performance.cycles.'||operation,NULL) END;
$$;
REVOKE ALL ON FUNCTION app.performance_cycle_function_action(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.performance_cycle_function_action(uuid,text) TO ai_hr_app;
CREATE FUNCTION app.financial_performance_cycle_row_allowed(d jsonb,operation text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE co uuid:=(d->>'company_id')::uuid;selected text;
BEGIN
 IF d->>'tenant_id' IS DISTINCT FROM app.current_tenant_id()::text OR NOT app.performance_cycle_function_action(co,operation) THEN RETURN false;END IF;
 -- The independently supplied eligibility company filter cannot widen either source scope.
 FOR selected IN SELECT jsonb_array_elements_text(coalesce(d->'eligibility_rules'->'companyIds','[]'::jsonb)) LOOP
  IF NOT app.performance_cycle_function_action(selected::uuid,operation) THEN RETURN false;END IF;
 END LOOP;
 RETURN NOT EXISTS(SELECT 1 FROM public.performance_review r JOIN public.employment e ON e.id=r.employment_id AND e.tenant_id=r.tenant_id
  WHERE r.tenant_id=app.current_tenant_id() AND r.cycle_id=(d->>'id')::uuid
  AND (NOT app.performance_cycle_function_action(e.company_id,operation) OR NOT app.data_permission_matches(e.id)));
END;
$$;
REVOKE ALL ON FUNCTION app.financial_performance_cycle_row_allowed(jsonb,text) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.financial_performance_cycle_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE operation text:=CASE TG_OP WHEN 'INSERT' THEN 'add' WHEN 'UPDATE' THEN 'edit' ELSE 'delete' END;
BEGIN
 IF app.access_workforce_storage_owner() THEN RETURN coalesce(NEW,OLD);END IF;
 PERFORM app.access_workforce_write_lock();
 IF TG_OP='UPDATE' AND NEW IS NOT DISTINCT FROM OLD AND app.onehr_cycle_admin(OLD.id) THEN RETURN NEW;END IF;
 IF TG_OP<>'INSERT' AND NOT app.financial_performance_cycle_row_allowed(to_jsonb(OLD),operation)
 OR TG_OP<>'DELETE' AND NOT app.financial_performance_cycle_row_allowed(to_jsonb(NEW),operation)
 THEN RAISE EXCEPTION 'Performance cycle action unavailable' USING ERRCODE='42501';END IF;
 RETURN coalesce(NEW,OLD);
END;
$$;
REVOKE ALL ON FUNCTION app.financial_performance_cycle_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER z_financial_performance_cycle_guard BEFORE INSERT OR UPDATE OR DELETE ON review_cycle FOR EACH ROW EXECUTE FUNCTION app.financial_performance_cycle_guard();

--> statement-breakpoint
-- OneHR setup has its own native course. Performance Partner must not acquire the
-- unrelated Performance & Compensation family or its generic cycle writers.
CREATE FUNCTION app.financial_delegate_onehr_setup(t uuid,u uuid,cap text,co uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.financial_function_native(t,u,'function.performance.onehr.setup.'||substring(cap from '[^.]+$'),co,true);
$$;
REVOKE ALL ON FUNCTION app.financial_delegate_onehr_setup(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
SELECT app.register_function_action('performance.onehr.setup',operation,'company',NULL,'app.financial_delegate_onehr_setup',
 '{"moduleKey":"performance_compensation","labelKey":"onehr.policy","kind":"native_acl","course":"administrative","screenKey":"performance","href":"/performance","employeeBearing":true}'::jsonb)
FROM unnest(ARRAY['view','add','edit']) operation;
CREATE FUNCTION app.onehr_setup_function_action(co uuid,operation text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.financial_function_native(app.current_tenant_id(),app.current_user_id(),'function.performance.onehr.setup.'||operation,co,true)
 AND CASE WHEN co IS NOT NULL THEN app.function_action_allowed('performance.onehr.setup','view',co) AND app.function_action_allowed('performance.onehr.setup',operation,co)
 ELSE app.financial_letter_capability_allowed_current('function.performance.onehr.setup.view',NULL)
 AND app.financial_letter_capability_allowed_current('function.performance.onehr.setup.'||operation,NULL) END;
$$;
REVOKE ALL ON FUNCTION app.onehr_setup_function_action(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onehr_setup_function_action(uuid,text) TO ai_hr_app;
CREATE FUNCTION app.financial_onehr_setup_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE native public.review_cycle%ROWTYPE;operation text:=CASE TG_OP WHEN 'INSERT' THEN 'add' ELSE 'edit' END;profile jsonb;selected text;subject public.employment%ROWTYPE;
BEGIN
 IF app.access_workforce_storage_owner() THEN RETURN NEW;END IF;
 PERFORM app.access_workforce_write_lock();
 SELECT * INTO native FROM public.review_cycle c WHERE c.id=NEW.cycle_id AND c.tenant_id=app.current_tenant_id();
 IF NOT FOUND OR NEW.tenant_id IS DISTINCT FROM native.tenant_id OR TG_OP='UPDATE' AND (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.cycle_id IS DISTINCT FROM OLD.cycle_id)
 OR NOT app.onehr_cycle_admin(native.id) OR NOT app.onehr_setup_function_action(native.company_id,operation) THEN
  RAISE EXCEPTION 'OneHR setup action unavailable' USING ERRCODE='42501';END IF;
 IF EXISTS(SELECT 1 FROM public.performance_review r JOIN public.employment e ON e.id=r.employment_id AND e.tenant_id=r.tenant_id
 WHERE r.cycle_id=native.id AND r.tenant_id=native.tenant_id AND (NOT app.onehr_setup_function_action(e.company_id,operation) OR NOT app.data_permission_matches(e.id))) THEN
  RAISE EXCEPTION 'OneHR setup recipient scope unavailable' USING ERRCODE='42501';END IF;
 FOR profile IN SELECT value FROM jsonb_array_elements(coalesce(NEW.policy->'profiles','[]'::jsonb)||coalesce(CASE WHEN TG_OP='UPDATE' THEN OLD.policy->'profiles' END,'[]'::jsonb)) LOOP
  IF profile->>'companyId' IS NOT NULL AND NOT app.onehr_setup_function_action((profile->>'companyId')::uuid,operation) THEN RAISE EXCEPTION 'OneHR profile company unavailable' USING ERRCODE='42501';END IF;
  FOR selected IN SELECT jsonb_array_elements_text(coalesce(profile->'employmentIds','[]'::jsonb)) LOOP
   SELECT * INTO subject FROM public.employment e WHERE e.id=selected::uuid AND e.tenant_id=native.tenant_id AND e.voided_at IS NULL;
   IF NOT FOUND OR NOT app.onehr_setup_function_action(subject.company_id,operation) OR NOT app.data_permission_matches(subject.id) THEN RAISE EXCEPTION 'OneHR profile recipient unavailable' USING ERRCODE='42501';END IF;
  END LOOP;
 END LOOP;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.financial_onehr_setup_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER financial_onehr_setup_guard BEFORE INSERT OR UPDATE ON performance_onehr_cycle FOR EACH ROW EXECUTE FUNCTION app.financial_onehr_setup_guard();

--> statement-breakpoint
-- Purpose-bound setup projection. A generic cycle/roster reader is not relabelled
-- as setup View, and participant readers retain their separate native policy use.
CREATE FUNCTION app.onehr_setup_read(p_cycle uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE native public.review_cycle%ROWTYPE;config public.performance_onehr_cycle%ROWTYPE;profile jsonb;selected text;subject public.employment%ROWTYPE;
BEGIN
 SELECT * INTO native FROM public.review_cycle c WHERE c.id=p_cycle AND c.tenant_id=app.current_tenant_id();
 IF NOT FOUND OR NOT app.onehr_cycle_admin(native.id) OR NOT app.onehr_setup_function_action(native.company_id,'view') THEN RETURN NULL;END IF;
 SELECT * INTO config FROM public.performance_onehr_cycle c WHERE c.cycle_id=native.id AND c.tenant_id=native.tenant_id;
 IF NOT FOUND OR EXISTS(SELECT 1 FROM public.performance_review r JOIN public.employment e ON e.id=r.employment_id AND e.tenant_id=r.tenant_id
 WHERE r.cycle_id=native.id AND r.tenant_id=native.tenant_id AND (NOT app.onehr_setup_function_action(e.company_id,'view') OR NOT app.data_permission_matches(e.id))) THEN RETURN NULL;END IF;
 FOR profile IN SELECT value FROM jsonb_array_elements(coalesce(config.policy->'profiles','[]'::jsonb)) LOOP
  IF profile->>'companyId' IS NOT NULL AND NOT app.onehr_setup_function_action((profile->>'companyId')::uuid,'view') THEN RETURN NULL;END IF;
  FOR selected IN SELECT jsonb_array_elements_text(coalesce(profile->'employmentIds','[]'::jsonb)) LOOP
   SELECT * INTO subject FROM public.employment e WHERE e.id=selected::uuid AND e.tenant_id=native.tenant_id AND e.voided_at IS NULL;
   IF NOT FOUND OR NOT app.onehr_setup_function_action(subject.company_id,'view') OR NOT app.data_permission_matches(subject.id) THEN RETURN NULL;END IF;
  END LOOP;
 END LOOP;
 RETURN jsonb_build_object('cycleId',native.id,'companyId',native.company_id,'revision',config.revision,'policy',config.policy);
END;
$$;
REVOKE ALL ON FUNCTION app.onehr_setup_read(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onehr_setup_read(uuid) TO ai_hr_app;

--> statement-breakpoint
-- Task identity is a bounded read owner, never an exception on the raw masters or
-- administrative projections. Preserve historical self and actual assigned work.
CREATE FUNCTION app.onehr_self_employment(p_employment uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.financial_human_principal_current() AND EXISTS(SELECT 1 FROM public.employment e JOIN public.app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id
 WHERE e.id=p_employment AND e.tenant_id=app.current_tenant_id() AND u.id=app.current_user_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id));
$$;
REVOKE ALL ON FUNCTION app.onehr_self_employment(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onehr_self_employment(uuid) TO ai_hr_app;
CREATE OR REPLACE FUNCTION app.onehr_review_header(wanted_review uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('reviewerEmploymentId',r.reviewer_employment_id,'closedAt',r.closed_at,'name',p.full_name,
 'ownEmploymentIds',(SELECT coalesce(jsonb_agg(own.id),'[]'::jsonb) FROM public.employment own WHERE own.person_id=u.person_id AND own.tenant_id=u.tenant_id))
 FROM public.performance_review r JOIN public.performance_onehr_cycle config ON config.cycle_id=r.cycle_id AND config.tenant_id=r.tenant_id
 JOIN public.employment e ON e.id=r.employment_id AND e.tenant_id=r.tenant_id JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
 JOIN public.app_user u ON u.id=app.current_user_id() AND u.tenant_id=r.tenant_id
 WHERE r.id=wanted_review AND r.tenant_id=app.current_tenant_id() AND app.financial_human_principal_current() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
 AND (e.person_id=u.person_id OR app.onehr_manager(r.id) OR app.onehr_effective_reviewer(r.id) OR app.onehr_moderator(r.id)
 OR app.onehr_cycle_admin(r.cycle_id) AND app.onehr_admin(e.company_id) AND app.data_permission_matches(e.id));
$$;
--> statement-breakpoint
-- Administration can no longer recover an excluded master through the old role-only
-- projection. The exact participant header above remains its separate native source.
CREATE OR REPLACE FUNCTION app.onehr_employment_facts() RETURNS TABLE(id uuid,tenant_id uuid,person_id uuid,company_id uuid,employee_code text,grade_id uuid,hired_on date,confirmation_date date,terminated_on date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT e.id,e.tenant_id,e.person_id,e.company_id,e.employee_code,e.grade_id,e.hired_on,e.confirmation_date,e.terminated_on FROM public.employment e
 WHERE cardinality((SELECT app.onehr_partner_company_ids()))>0 AND e.tenant_id=app.current_tenant_id()
 AND e.company_id=ANY((SELECT app.onehr_partner_company_ids())::uuid[]) AND app.data_permission_matches(e.id);
$$;
CREATE OR REPLACE FUNCTION app.onehr_assignment_facts() RETURNS TABLE(id uuid,tenant_id uuid,employment_id uuid,department_id uuid,position_id uuid,valid_from date,valid_to date,superseded_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT a.id,a.tenant_id,a.employment_id,a.department_id,a.position_id,a.valid_from,a.valid_to,a.superseded_at FROM public.assignment a JOIN public.employment e ON e.id=a.employment_id AND e.tenant_id=a.tenant_id
 WHERE cardinality((SELECT app.onehr_partner_company_ids()))>0 AND a.tenant_id=app.current_tenant_id()
 AND e.company_id=ANY((SELECT app.onehr_partner_company_ids())::uuid[]) AND app.data_permission_matches(e.id);
$$;
CREATE OR REPLACE FUNCTION app.onehr_person_labels(employment_ids uuid[]) RETURNS TABLE(employment_id uuid,person_id uuid,full_name text,preferred_name text,employee_code text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT e.id,p.id,p.full_name,p.preferred_name,e.employee_code FROM public.employment e JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
 WHERE e.id=ANY(employment_ids) AND e.tenant_id=app.current_tenant_id() AND app.onehr_admin(e.company_id) AND app.data_permission_matches(e.id);
$$;

--> statement-breakpoint
-- Native unit/assignment facts have one tenant-parameterized owner. Current native
-- wrappers preserve their exact source; target-user floors never impersonate a caller.
CREATE FUNCTION app.financial_onehr_unit_placement(target_tenant uuid,wanted_employment uuid) RETURNS TABLE(company_id uuid,department_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(cur.company_id,e.company_id),cur.department_id
 FROM employment e LEFT JOIN LATERAL (
  SELECT a.company_id,a.department_id FROM assignment a
  WHERE a.employment_id=e.id AND a.tenant_id=e.tenant_id AND a.superseded_at IS NULL
   AND a.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
   AND (a.valid_to IS NULL OR a.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
  ORDER BY a.valid_from DESC,a.id LIMIT 1) cur ON true
 WHERE e.id=wanted_employment AND e.tenant_id=target_tenant
$$;
REVOKE ALL ON FUNCTION app.financial_onehr_unit_placement(uuid,uuid) FROM PUBLIC,ai_hr_app;
CREATE OR REPLACE FUNCTION app.assessment_unit_placement(wanted_employment uuid) RETURNS TABLE(company_id uuid,department_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT * FROM app.financial_onehr_unit_placement(app.current_tenant_id(),wanted_employment); $$;
CREATE FUNCTION app.financial_onehr_unit_excluded(target_tenant uuid,wanted_cycle uuid, wanted_employment uuid, extra_company uuid, extra_department uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce((
  SELECT CASE
   WHEN c.status='closed' THEN EXISTS(SELECT 1 FROM performance_assessment_unit_exclusion_pin p
    WHERE p.tenant_id=c.tenant_id AND p.cycle_id=c.id AND p.employment_id=wanted_employment)
   WHEN extra_company IS NULL AND NOT EXISTS(SELECT 1 FROM performance_assessment_unit_exclusion x
    WHERE x.tenant_id=c.tenant_id AND x.cycle_id=c.id AND x.ended_at IS NULL) THEN false
   ELSE EXISTS(SELECT 1 FROM app.financial_onehr_unit_placement(target_tenant,wanted_employment) pl
    WHERE EXISTS(SELECT 1 FROM performance_assessment_unit_exclusion x
      WHERE x.tenant_id=c.tenant_id AND x.cycle_id=c.id AND x.ended_at IS NULL
       AND x.company_id=pl.company_id AND (x.department_id IS NULL OR x.department_id=pl.department_id))
     OR extra_company IS NOT NULL AND extra_company=pl.company_id AND (extra_department IS NULL OR extra_department=pl.department_id))
  END
  FROM review_cycle c WHERE c.id=wanted_cycle AND c.tenant_id=target_tenant),false)
$$;
REVOKE ALL ON FUNCTION app.financial_onehr_unit_excluded(uuid,uuid,uuid,uuid,uuid) FROM PUBLIC,ai_hr_app;
CREATE OR REPLACE FUNCTION app.assessment_unit_excluded_as(wanted_cycle uuid, wanted_employment uuid, extra_company uuid, extra_department uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT app.financial_onehr_unit_excluded(app.current_tenant_id(),wanted_cycle,wanted_employment,extra_company,extra_department); $$;
CREATE FUNCTION app.financial_onehr_unit_step_up(target_tenant uuid,wanted_cycle uuid, wanted_from uuid, stop_person uuid, extra_company uuid, extra_department uuid) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE today date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date; cur uuid:=wanted_from; nxt employment;
BEGIN
 FOR depth IN 1..6 LOOP
  nxt:=NULL;
  SELECT m.* INTO nxt FROM reporting_line l JOIN employment m ON m.id=l.manager_employment_id AND m.tenant_id=l.tenant_id
   WHERE l.tenant_id=target_tenant AND l.subordinate_employment_id=cur AND l.line_type='administrative' AND l.superseded_at IS NULL
    AND l.valid_from<=today AND (l.valid_to IS NULL OR l.valid_to>today)
   ORDER BY l.valid_from DESC,l.id LIMIT 1;
  IF nxt.id IS NULL OR nxt.terminated_on IS NOT NULL AND nxt.terminated_on<=today OR nxt.person_id IS NOT DISTINCT FROM stop_person THEN RETURN NULL; END IF;
  IF NOT app.financial_onehr_unit_excluded(target_tenant,wanted_cycle,nxt.id,extra_company,extra_department) THEN RETURN nxt.id; END IF;
  cur:=nxt.id;
 END LOOP;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.financial_onehr_unit_step_up(uuid,uuid,uuid,uuid,uuid,uuid) FROM PUBLIC,ai_hr_app;
CREATE OR REPLACE FUNCTION app.onehr_unit_step_up(wanted_cycle uuid, wanted_from uuid, stop_person uuid, extra_company uuid, extra_department uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT app.financial_onehr_unit_step_up(app.current_tenant_id(),wanted_cycle,wanted_from,stop_person,extra_company,extra_department); $$;
CREATE FUNCTION app.financial_onehr_effective_reviewer_of(target_tenant uuid,wanted_review uuid, extra_company uuid, extra_department uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN m.id IS NULL OR m.terminated_on IS NOT NULL AND m.terminated_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date THEN NULL
  WHEN NOT app.financial_onehr_unit_excluded(target_tenant,r.cycle_id,m.id,extra_company,extra_department) THEN m.id
  ELSE app.financial_onehr_unit_step_up(target_tenant,r.cycle_id,m.id,s.person_id,extra_company,extra_department) END
 FROM performance_review r JOIN employment s ON s.id=r.employment_id AND s.tenant_id=r.tenant_id
 LEFT JOIN employment m ON m.id=r.reviewer_employment_id AND m.tenant_id=r.tenant_id
 WHERE r.id=wanted_review AND r.tenant_id=target_tenant
$$;
REVOKE ALL ON FUNCTION app.financial_onehr_effective_reviewer_of(uuid,uuid,uuid,uuid) FROM PUBLIC,ai_hr_app;
CREATE OR REPLACE FUNCTION app.onehr_effective_reviewer_of_as(wanted_review uuid, extra_company uuid, extra_department uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT app.financial_onehr_effective_reviewer_of(app.current_tenant_id(),wanted_review,extra_company,extra_department); $$;
CREATE FUNCTION app.financial_onehr_manager_for(target_tenant uuid,target_user uuid,wanted_review uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM performance_review r JOIN employment e ON e.id=r.reviewer_employment_id AND e.tenant_id=r.tenant_id JOIN employment s ON s.id=r.employment_id AND s.tenant_id=r.tenant_id JOIN app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id WHERE r.id=wanted_review AND r.tenant_id=target_tenant AND u.id=target_user AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) AND e.person_id<>s.person_id AND (e.terminated_on IS NULL OR e.terminated_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) AND NOT app.financial_onehr_unit_excluded(target_tenant,r.cycle_id,e.id,NULL,NULL))
$$;
REVOKE ALL ON FUNCTION app.financial_onehr_manager_for(uuid,uuid,uuid) FROM PUBLIC,ai_hr_app;
CREATE OR REPLACE FUNCTION app.onehr_manager(wanted_review uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT app.financial_onehr_manager_for(app.current_tenant_id(),app.current_user_id(),wanted_review); $$;
CREATE FUNCTION app.financial_onehr_effective_reviewer_for(target_tenant uuid,target_user uuid,wanted_review uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM performance_review r
  JOIN employment s ON s.id=r.employment_id AND s.tenant_id=r.tenant_id
  JOIN employment m ON m.id=app.financial_onehr_effective_reviewer_of(target_tenant,r.id,NULL,NULL) AND m.tenant_id=r.tenant_id
  JOIN app_user u ON u.person_id=m.person_id AND u.tenant_id=m.tenant_id
  WHERE r.id=wanted_review AND r.tenant_id=target_tenant AND u.id=target_user
   AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) AND m.person_id<>s.person_id
   AND (m.terminated_on IS NULL OR m.terminated_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date))
$$;
REVOKE ALL ON FUNCTION app.financial_onehr_effective_reviewer_for(uuid,uuid,uuid) FROM PUBLIC,ai_hr_app;
CREATE OR REPLACE FUNCTION app.onehr_effective_reviewer(wanted_review uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT app.financial_onehr_effective_reviewer_for(app.current_tenant_id(),app.current_user_id(),wanted_review); $$;
CREATE FUNCTION app.financial_onehr_moderator_for(target_tenant uuid,target_user uuid,wanted_review uuid,wanted_kpi uuid DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM performance_onehr_review r JOIN performance_review pr ON pr.id=r.review_id JOIN employment sub ON sub.id=r.employment_id JOIN app_user u ON u.id=target_user AND u.tenant_id=r.tenant_id CROSS JOIN LATERAL jsonb_array_elements(r.kpis) k CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_array_length(coalesce(k->'approvalChain','[]'::jsonb))>0 THEN k->'approvalChain' ELSE jsonb_build_array(jsonb_build_object('employmentId',k->>'moderatorEmploymentId','at',NULL)) END) WITH ORDINALITY step(v,idx) JOIN employment m ON m.id=(step.v->>'employmentId')::uuid AND m.tenant_id=r.tenant_id AND m.person_id=u.person_id
 WHERE r.review_id=wanted_review AND r.tenant_id=target_tenant AND (wanted_kpi IS NULL OR k->>'id'=wanted_kpi::text AND coalesce((k->>'locked')::boolean,false)=false AND step.v->>'at' IS NULL AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(k->'approvalChain','[]'::jsonb)) WITH ORDINALITY earlier(v,idx) WHERE earlier.idx<step.idx AND earlier.v->>'at' IS NULL)) AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) AND sub.person_id<>m.person_id AND NOT app.financial_onehr_unit_excluded(target_tenant,r.cycle_id,m.id,NULL,NULL) AND (m.terminated_on IS NULL OR m.terminated_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) AND (k->>'moderatorSource'='matrix' OR m.id=pr.reviewer_employment_id OR EXISTS(SELECT 1 FROM reporting_line l WHERE l.subordinate_employment_id=sub.id AND l.manager_employment_id=m.id AND l.line_type IN ('functional','project','dotted') AND l.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (l.valid_to IS NULL OR l.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) AND l.superseded_at IS NULL)))
$$;
REVOKE ALL ON FUNCTION app.financial_onehr_moderator_for(uuid,uuid,uuid,uuid) FROM PUBLIC,ai_hr_app;
CREATE OR REPLACE FUNCTION app.onehr_moderator(wanted_review uuid,wanted_kpi uuid DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT app.financial_onehr_moderator_for(app.current_tenant_id(),app.current_user_id(),wanted_review,wanted_kpi); $$;

--> statement-breakpoint
CREATE FUNCTION app.financial_onehr_review_course_for(t uuid,u uuid,wanted_review uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN subject.person_id=account.person_id THEN 'self'
  WHEN app.financial_onehr_manager_for(t,u,review.id) OR app.financial_onehr_effective_reviewer_for(t,u,review.id) OR app.financial_onehr_moderator_for(t,u,review.id,NULL) THEN 'assigned' END
 FROM public.performance_review review JOIN public.performance_onehr_cycle config ON config.cycle_id=review.cycle_id AND config.tenant_id=review.tenant_id
 JOIN public.employment subject ON subject.id=review.employment_id AND subject.tenant_id=review.tenant_id
 JOIN public.app_user account ON account.id=u AND account.tenant_id=review.tenant_id
 WHERE review.id=wanted_review AND review.tenant_id=t AND account.archived_at IS NULL AND NOT app.login_blocked(account.id);
$$;
REVOKE ALL ON FUNCTION app.financial_onehr_review_course_for(uuid,uuid,uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.financial_delegate_onehr_review(t uuid,u uuid,cap text,co uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.financial_function_native(t,u,cap,co,true);
$$;
REVOKE ALL ON FUNCTION app.financial_delegate_onehr_review(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
SELECT app.register_function_action(key,'view','company',NULL,'app.financial_delegate_onehr_review',jsonb_build_object(
 'moduleKey','performance_compensation','labelKey',label,'kind','native_acl','course',course,'href','/performance/workspace','employeeBearing',false))
FROM (VALUES('performance.onehr.selfReview','onehr.nativeWorkflow','own'),('performance.onehr.assignedReview','onehr.assignments','assigned')) definition(key,label,course);
CREATE FUNCTION app.onehr_review_task_view(wanted_review uuid,wanted_course text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.financial_human_principal_current() AND wanted_course IN ('self','assigned') AND EXISTS(SELECT 1 FROM public.performance_review review JOIN public.employment subject ON subject.id=review.employment_id AND subject.tenant_id=review.tenant_id
 WHERE review.id=wanted_review AND review.tenant_id=app.current_tenant_id()
 AND app.financial_onehr_review_course_for(review.tenant_id,app.current_user_id(),review.id)=wanted_course
 AND app.function_action_allowed(CASE wanted_course WHEN 'self' THEN 'performance.onehr.selfReview' ELSE 'performance.onehr.assignedReview' END,'view',subject.company_id));
$$;
REVOKE ALL ON FUNCTION app.onehr_review_task_view(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onehr_review_task_view(uuid,text) TO ai_hr_app;
CREATE FUNCTION app.onehr_review_task_header(wanted_review uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('reviewerEmploymentId',review.reviewer_employment_id,'closedAt',review.closed_at,'name',person.full_name,
 'ownEmploymentIds',(SELECT coalesce(jsonb_agg(own.id),'[]'::jsonb) FROM public.employment own WHERE own.person_id=account.person_id AND own.tenant_id=account.tenant_id))
 FROM public.performance_review review JOIN public.performance_onehr_cycle config ON config.cycle_id=review.cycle_id AND config.tenant_id=review.tenant_id
 JOIN public.employment subject ON subject.id=review.employment_id AND subject.tenant_id=review.tenant_id JOIN public.person person ON person.id=subject.person_id AND person.tenant_id=subject.tenant_id
 JOIN public.app_user account ON account.id=app.current_user_id() AND account.tenant_id=review.tenant_id
 WHERE review.id=wanted_review AND review.tenant_id=app.current_tenant_id() AND app.financial_human_principal_current() AND account.archived_at IS NULL AND NOT app.login_blocked(account.id)
 AND CASE WHEN subject.person_id=account.person_id THEN app.onehr_review_task_view(review.id,'self')
 WHEN app.onehr_manager(review.id) OR app.onehr_effective_reviewer(review.id) OR app.onehr_moderator(review.id) THEN app.onehr_review_task_view(review.id,'assigned')
 ELSE app.onehr_cycle_admin(review.cycle_id) AND app.onehr_admin(subject.company_id) AND app.data_permission_matches(subject.id) END;
$$;
REVOKE ALL ON FUNCTION app.onehr_review_task_header(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onehr_review_task_header(uuid) TO ai_hr_app;

--> statement-breakpoint
-- Native course classification is independent of canonical permission. A denied
-- administrator cannot fall back to a participant projection.
CREATE FUNCTION app.performance_cycle_native_admin(p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.financial_function_native(app.current_tenant_id(),app.current_user_id(),'function.performance.cycles.view',p_company,true);
$$;
REVOKE ALL ON FUNCTION app.performance_cycle_native_admin(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.performance_cycle_native_admin(uuid) TO ai_hr_app;

--> statement-breakpoint
-- One native batch subset owner: unsuperseded department assignees UNION explicit
-- employments. This deliberately preserves the existing absence of an assignment date filter.
CREATE FUNCTION app.financial_payroll_scope_ids(p_tenant uuid,p_scope jsonb) RETURNS uuid[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF coalesce(jsonb_array_length(p_scope->'departmentIds'),0)=0 AND coalesce(jsonb_array_length(p_scope->'employmentIds'),0)=0 THEN RETURN NULL;END IF;
 RETURN ARRAY(SELECT member.id FROM (
  SELECT value::uuid AS id FROM jsonb_array_elements_text(coalesce(p_scope->'employmentIds','[]'::jsonb))
  UNION SELECT assignment.employment_id FROM public.assignment assignment WHERE assignment.tenant_id=p_tenant AND assignment.superseded_at IS NULL
  AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(coalesce(p_scope->'departmentIds','[]'::jsonb)) department(value) WHERE department.value::uuid=assignment.department_id)
 ) member ORDER BY member.id);
END;
$$;
REVOKE ALL ON FUNCTION app.financial_payroll_scope_ids(uuid,jsonb) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.payroll_scope_employment_ids(p_scope jsonb) RETURNS uuid[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE members uuid[]:=app.financial_payroll_scope_ids(app.current_tenant_id(),p_scope);
BEGIN
 IF members IS NULL THEN RETURN NULL;END IF;
 IF NOT app.principal_snapshot_current() OR EXISTS(SELECT 1 FROM unnest(members) member(id) WHERE NOT app.access_financial_action_employment('payroll',member.id,'view'))
 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(coalesce(p_scope->'departmentIds','[]'::jsonb)) selected(value)
 WHERE NOT EXISTS(SELECT 1 FROM public.department department WHERE department.id=selected.value::uuid AND department.tenant_id=app.current_tenant_id() AND app.access_financial_action_company('payroll',department.company_id,'view'))) THEN
  RAISE EXCEPTION 'Payroll subset source unavailable' USING ERRCODE='42501';END IF;
 RETURN members;
END;
$$;
REVOKE ALL ON FUNCTION app.payroll_scope_employment_ids(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.payroll_scope_employment_ids(jsonb) TO ai_hr_app;

--> statement-breakpoint
-- The canonical reservation cutoff source. Existing linked claims retain their original
-- batch/payroll custody and never re-resolve a later company default.
CREATE FUNCTION app.financial_claim_cutoff_source(t uuid,co uuid,period text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE config public.company_payroll_config%ROWTYPE;policy public.payroll_policy%ROWTYPE;settings jsonb;frequency text;frequency_block jsonb;anchor numeric;month_start date;window_start date;window_end date;day_number integer;
BEGIN
 IF period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' OR NOT EXISTS(SELECT 1 FROM public.company company WHERE company.id=co AND company.tenant_id=t) THEN RAISE EXCEPTION 'Claim cutoff source unavailable' USING ERRCODE='42501';END IF;
 month_start:=(period||'-01')::date;
 SELECT * INTO config FROM public.company_payroll_config actual WHERE actual.company_id=co AND actual.tenant_id=t;
 IF config.default_payroll_policy_id IS NOT NULL THEN SELECT * INTO policy FROM public.payroll_policy actual WHERE actual.id=config.default_payroll_policy_id AND actual.tenant_id=t;END IF;
 IF policy.id IS NOT NULL AND policy.status='active' THEN settings:=policy.config;END IF;
 IF settings->'cutOff'->>'mode'='custom' AND jsonb_typeof(settings->'cutOff'->'anchorDay')='number' THEN
  frequency:=coalesce(settings->>'frequency','monthly');
  IF frequency<>'monthly' THEN frequency_block:=settings->'cutOff'->'perFrequency'->frequency;END IF;
  anchor:=coalesce((frequency_block->'perType'->>'claim')::numeric,(settings->'cutOff'->'perType'->>'claim')::numeric,(frequency_block->>'anchorDay')::numeric,(settings->'cutOff'->>'anchorDay')::numeric);
 ELSE anchor:=config.claim_cut_off_day;END IF;
 IF anchor IS NULL THEN window_start:=month_start;window_end:=(month_start+interval '1 month')::date-1;
 ELSE
  day_number:=least(28,greatest(1,trunc(anchor)::integer));
  window_start:=(month_start-interval '1 month')::date+day_number-1;window_end:=month_start+day_number-2;
 END IF;
 RETURN jsonb_build_object('tenantId',t,'companyId',co,'period',period,'start',window_start,'end',window_end,
  'active',window_start<>month_start OR window_end<>(month_start+interval '1 month')::date-1,
  'companyConfig',CASE WHEN config.company_id IS NULL THEN NULL ELSE to_jsonb(config) END,
  'policy',CASE WHEN policy.id IS NULL THEN NULL ELSE to_jsonb(policy) END);
END;
$$;
REVOKE ALL ON FUNCTION app.financial_claim_cutoff_source(uuid,uuid,text) FROM PUBLIC,ai_hr_app;
CREATE TABLE app.financial_claim_source_custody(
 transaction_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,batch_id uuid NOT NULL,claim_id uuid NOT NULL,source_kind text NOT NULL CHECK(source_kind IN ('reserve','linked-approved','linked-paid')),
 source_row jsonb NOT NULL,source_hash text NOT NULL,batch_row jsonb NOT NULL,batch_hash text NOT NULL,cutoff_source jsonb,
 PRIMARY KEY(transaction_id,tenant_id,user_id,batch_id,claim_id,source_kind,source_hash,batch_hash)
);
ALTER TABLE app.financial_claim_source_custody ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.financial_claim_source_custody FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.financial_claim_sources_capture(p_batch uuid,p_kind text,p_status text) RETURNS TABLE(id uuid,employment_id uuid,amount numeric,decided_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE batch public.payroll_batch%ROWTYPE;candidate public.claim_request%ROWTYPE;members uuid[];operation text;cutoff jsonb;upper_bound timestamptz;
BEGIN
 IF NOT app.financial_human_principal_current() THEN RAISE EXCEPTION 'Payroll claim actor unavailable' USING ERRCODE='42501';END IF;
 PERFORM app.access_workforce_write_lock();
 SELECT * INTO batch FROM public.payroll_batch actual WHERE actual.id=p_batch AND actual.tenant_id=app.current_tenant_id() FOR UPDATE;
 operation:=CASE WHEN app.financial_batch_intent_allowed(p_batch,'edit') THEN 'edit' WHEN app.financial_batch_intent_allowed(p_batch,'delete') THEN 'delete' END;
 IF batch.id IS NULL OR batch.status NOT IN ('draft','processed') OR p_kind IS NULL OR p_kind NOT IN ('reserve','linked') OR p_status IS NULL OR p_status NOT IN ('approved','paid')
 OR p_kind='reserve' AND (p_status<>'approved' OR batch.status<>'draft' OR operation IS DISTINCT FROM 'edit')
 OR operation IS NULL OR NOT app.financial_batch_subjects_allowed(batch.id) OR NOT app.function_action_allowed('payroll.process','view',batch.company_id)
 THEN RAISE EXCEPTION 'Payroll claim source unavailable' USING ERRCODE='42501';END IF;
 IF p_kind='reserve' THEN
  members:=app.financial_payroll_scope_ids(batch.tenant_id,batch.scope);
  cutoff:=app.financial_claim_cutoff_source(batch.tenant_id,batch.company_id,batch.pay_period);
  IF (cutoff->>'active')::boolean THEN upper_bound:=((cutoff->>'end')||'T23:59:59.999Z')::timestamptz;END IF;
 END IF;
 FOR candidate IN SELECT claim.* FROM public.claim_request claim JOIN public.employment subject ON subject.id=claim.employment_id AND subject.tenant_id=claim.tenant_id
  WHERE claim.tenant_id=batch.tenant_id AND claim.status::text=p_status AND claim.employment_id=ANY((SELECT app.visible_employment_ids())::uuid[])
  AND (p_kind='reserve' AND claim.taxable AND claim.payroll_batch_id IS NULL AND subject.company_id=batch.company_id AND (members IS NULL OR subject.id=ANY(members)) AND (upper_bound IS NULL OR claim.decided_at<=upper_bound)
   OR p_kind='linked' AND claim.payroll_batch_id=batch.id)
  ORDER BY claim.id FOR UPDATE OF claim
 LOOP
  IF NOT app.access_financial_action_employment('payroll',candidate.employment_id,operation) THEN RAISE EXCEPTION 'Payroll claim subject unavailable' USING ERRCODE='42501';END IF;
  INSERT INTO app.financial_claim_source_custody VALUES(pg_current_xact_id(),batch.tenant_id,app.current_user_id(),batch.id,candidate.id,
   CASE WHEN p_kind='reserve' THEN 'reserve' ELSE 'linked-'||p_status END,to_jsonb(candidate),encode(sha256(convert_to(to_jsonb(candidate)::text,'UTF8')),'hex'),to_jsonb(batch),encode(sha256(convert_to(to_jsonb(batch)::text,'UTF8')),'hex'),cutoff) ON CONFLICT DO NOTHING;
  id:=candidate.id;employment_id:=candidate.employment_id;amount:=candidate.amount;decided_at:=candidate.decided_at;RETURN NEXT;
 END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION app.financial_claim_sources_capture(uuid,text,text) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.payroll_claim_prefill_sources(p_batch uuid) RETURNS TABLE(id uuid,employment_id uuid,amount numeric,decided_at timestamptz)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT * FROM app.financial_claim_sources_capture(p_batch,'reserve','approved'); $$;
CREATE FUNCTION app.payroll_claim_linked_sources(p_batch uuid,p_status text) RETURNS TABLE(id uuid,employment_id uuid,amount numeric,decided_at timestamptz)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT * FROM app.financial_claim_sources_capture(p_batch,'linked',p_status); $$;
REVOKE ALL ON FUNCTION app.payroll_claim_prefill_sources(uuid),app.payroll_claim_linked_sources(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.payroll_claim_prefill_sources(uuid),app.payroll_claim_linked_sources(uuid,text) TO ai_hr_app;
CREATE TRIGGER financial_receipts_prune AFTER INSERT ON app.financial_claim_source_custody FOR EACH ROW EXECUTE FUNCTION app.financial_receipts_prune();

-- Finite financial writes consume actual locked native sources; the app never receives claim metadata.
CREATE TABLE app.financial_claim_port_effect(
 transaction_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,batch_id uuid NOT NULL,claim_id uuid NOT NULL,mode text NOT NULL,
 before_row jsonb NOT NULL,after_row jsonb NOT NULL,source_hash text NOT NULL,
 PRIMARY KEY(transaction_id,tenant_id,user_id,claim_id,source_hash,mode)
);
ALTER TABLE app.financial_claim_port_effect ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.financial_claim_port_effect FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.financial_claim_port_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW.transaction_id<>pg_current_xact_id() OR NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NEW.user_id IS DISTINCT FROM app.current_user_id()
 OR NOT app.financial_claim_payment_approved(NEW.claim_id,NEW.before_row,NEW.after_row)
 OR NOT EXISTS(SELECT 1 FROM app.financial_claim_source_custody source WHERE source.transaction_id=NEW.transaction_id AND source.tenant_id=NEW.tenant_id AND source.user_id=NEW.user_id AND source.batch_id=NEW.batch_id AND source.claim_id=NEW.claim_id
 AND source.source_hash=NEW.source_hash AND source.source_row=NEW.before_row AND source.source_kind=CASE NEW.mode WHEN 'reserve' THEN 'reserve' WHEN 'unpay' THEN 'linked-paid' ELSE 'linked-approved' END)
 THEN RAISE EXCEPTION 'Payroll claim consequence incomplete' USING ERRCODE='42501';END IF;
 RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION app.financial_claim_port_complete() FROM PUBLIC,ai_hr_app;
CREATE CONSTRAINT TRIGGER financial_claim_port_complete AFTER INSERT ON app.financial_claim_port_effect DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.financial_claim_port_complete();
CREATE TRIGGER financial_receipts_prune AFTER INSERT ON app.financial_claim_port_effect FOR EACH ROW EXECUTE FUNCTION app.financial_receipts_prune();
CREATE FUNCTION app.payroll_claim_apply(p_batch uuid,p_mode text,p_claims uuid[] DEFAULT NULL,p_employments uuid[] DEFAULT NULL) RETURNS TABLE(id uuid,employment_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE candidate public.claim_request%ROWTYPE;changed public.claim_request%ROWTYPE;actual_ids uuid[];period text;before_row jsonb;wanted_source_kind text;
BEGIN
 IF NOT app.financial_human_principal_current() THEN RAISE EXCEPTION 'Payroll claim actor unavailable' USING ERRCODE='42501';END IF;
 IF p_mode IS NULL OR p_mode NOT IN ('reserve','pay','unpay','requeue') OR p_mode='reserve' AND p_claims IS NULL
 OR p_claims IS NOT NULL AND (array_position(p_claims,NULL) IS NOT NULL OR cardinality(p_claims)<>(SELECT count(DISTINCT value) FROM unnest(p_claims) value))
 OR p_employments IS NOT NULL AND array_position(p_employments,NULL) IS NOT NULL
 THEN RAISE EXCEPTION 'Payroll claim operation unavailable' USING ERRCODE='42501';END IF;
 -- This source owner acquires Access before actual batch and deterministic claim locks,
 -- repeats current native intent/data ceilings and seals real cutoff only for new reservations.
 SELECT coalesce(array_agg(source.id ORDER BY source.id),'{}'::uuid[]) INTO actual_ids
 FROM app.financial_claim_sources_capture(p_batch,CASE p_mode WHEN 'reserve' THEN 'reserve' ELSE 'linked' END,CASE p_mode WHEN 'unpay' THEN 'paid' ELSE 'approved' END) source
 WHERE (p_claims IS NULL OR source.id=ANY(p_claims)) AND (p_employments IS NULL OR source.employment_id=ANY(p_employments));
 IF p_claims IS NOT NULL AND cardinality(actual_ids)<>cardinality(p_claims) THEN RAISE EXCEPTION 'Payroll claim source changed' USING ERRCODE='42501';END IF;
 SELECT batch.pay_period INTO period FROM public.payroll_batch batch WHERE batch.id=p_batch AND batch.tenant_id=app.current_tenant_id();
 wanted_source_kind:=CASE p_mode WHEN 'reserve' THEN 'reserve' WHEN 'unpay' THEN 'linked-paid' ELSE 'linked-approved' END;
 FOR candidate IN SELECT claim.* FROM public.claim_request claim WHERE claim.tenant_id=app.current_tenant_id() AND claim.id=ANY(actual_ids) ORDER BY claim.id FOR UPDATE
 LOOP
  before_row:=to_jsonb(candidate);
  IF NOT EXISTS(SELECT 1 FROM app.financial_claim_source_custody source WHERE source.transaction_id=pg_current_xact_id() AND source.tenant_id=candidate.tenant_id AND source.user_id=app.current_user_id() AND source.batch_id=p_batch AND source.claim_id=candidate.id AND source.source_kind=wanted_source_kind AND source.source_row=before_row)
  THEN RAISE EXCEPTION 'Payroll claim source changed' USING ERRCODE='42501';END IF;
  IF p_mode='reserve' THEN
   UPDATE public.claim_request claim SET payroll_batch_id=p_batch WHERE claim.id=candidate.id AND claim.tenant_id=candidate.tenant_id RETURNING claim.* INTO changed;
  ELSIF p_mode='pay' THEN
   UPDATE public.claim_request claim SET status='paid',paid_at=now(),payout_ref='payroll:'||period WHERE claim.id=candidate.id AND claim.tenant_id=candidate.tenant_id RETURNING claim.* INTO changed;
  ELSIF p_mode='unpay' THEN
   UPDATE public.claim_request claim SET status='approved',paid_at=NULL,payout_ref=NULL WHERE claim.id=candidate.id AND claim.tenant_id=candidate.tenant_id RETURNING claim.* INTO changed;
  ELSE
   UPDATE public.claim_request claim SET payroll_batch_id=NULL WHERE claim.id=candidate.id AND claim.tenant_id=candidate.tenant_id RETURNING claim.* INTO changed;
  END IF;
  IF changed.id IS NULL THEN RAISE EXCEPTION 'Payroll claim write unavailable' USING ERRCODE='42501';END IF;
  INSERT INTO app.financial_claim_port_effect VALUES(pg_current_xact_id(),candidate.tenant_id,app.current_user_id(),p_batch,candidate.id,p_mode,before_row,to_jsonb(changed),encode(sha256(convert_to(before_row::text,'UTF8')),'hex'));
  id:=changed.id;employment_id:=changed.employment_id;RETURN NEXT;
 END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION app.payroll_claim_apply(uuid,text,uuid[],uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.payroll_claim_apply(uuid,text,uuid[],uuid[]) TO ai_hr_app;
-- Reset custody hashes every locked actual row, including non-paid linked rows, without returning content.
CREATE FUNCTION app.payroll_claim_source_hashes(p_batch uuid) RETURNS TABLE(id uuid,source_hash text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE candidate public.claim_request%ROWTYPE;operation text;batch_company uuid;
BEGIN
 IF NOT app.financial_human_principal_current() THEN RAISE EXCEPTION 'Payroll claim actor unavailable' USING ERRCODE='42501';END IF;
 PERFORM app.access_workforce_write_lock();
 SELECT batch.company_id INTO batch_company FROM public.payroll_batch batch WHERE batch.id=p_batch AND batch.tenant_id=app.current_tenant_id() AND batch.status IN ('draft','processed') FOR UPDATE;
 operation:=CASE WHEN app.financial_batch_intent_allowed(p_batch,'edit') THEN 'edit' WHEN app.financial_batch_intent_allowed(p_batch,'delete') THEN 'delete' END;
 IF batch_company IS NULL OR operation IS NULL OR NOT app.financial_batch_subjects_allowed(p_batch) OR NOT app.function_action_allowed('payroll.process','view',batch_company) THEN RAISE EXCEPTION 'Payroll claim source unavailable' USING ERRCODE='42501';END IF;
 FOR candidate IN SELECT claim.* FROM public.claim_request claim WHERE claim.tenant_id=app.current_tenant_id() AND claim.payroll_batch_id=p_batch AND claim.employment_id=ANY((SELECT app.visible_employment_ids())::uuid[]) ORDER BY claim.id LIMIT 10001 FOR UPDATE NOWAIT
 LOOP
  IF NOT app.access_financial_action_employment('payroll',candidate.employment_id,operation) THEN RAISE EXCEPTION 'Payroll claim subject unavailable' USING ERRCODE='42501';END IF;
  id:=candidate.id;source_hash:=encode(sha256(convert_to(to_jsonb(candidate)::text,'UTF8')),'hex');RETURN NEXT;
 END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION app.payroll_claim_source_hashes(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.payroll_claim_source_hashes(uuid) TO ai_hr_app;


--> statement-breakpoint
-- Actual BEFORE-row custody permits only its own INSERT RETURNING row; successful
-- materialization and the real complete-batch event must still close in this transaction.
CREATE TABLE app.financial_letter_proposed_birth(
 transaction_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,letter_id uuid NOT NULL,company_id uuid NOT NULL,employment_id uuid NOT NULL,batch_id uuid NOT NULL,row_hash text NOT NULL,completed boolean NOT NULL DEFAULT false,
 PRIMARY KEY(transaction_id,tenant_id,user_id,letter_id)
);
ALTER TABLE app.financial_letter_proposed_birth ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.financial_letter_proposed_birth FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.financial_letter_proposed_birth_capture() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.current_user_id() IS NULL THEN RETURN NEW;END IF;
 IF NOT app.principal_snapshot_current() OR NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NEW.created_by IS DISTINCT FROM app.current_user_id()
 OR NOT app.letter_function_action('letterGenerate','add',NEW.company_id) OR NOT app.letter_function_action('letterGenerate','view',NEW.company_id)
 OR NOT app.access_letter_action(NEW.company_id,'generate','add') OR NOT app.data_permission_matches(NEW.employment_id)
 OR NEW.confidential AND NOT app.can_admin_payroll_for(NEW.company_id)
 OR NOT EXISTS(SELECT 1 FROM public.letter_generation_batch parent JOIN public.employment subject ON subject.id=NEW.employment_id AND subject.tenant_id=parent.tenant_id AND subject.company_id=parent.company_id
 WHERE parent.id=NEW.batch_id AND parent.tenant_id=NEW.tenant_id AND parent.company_id=NEW.company_id AND parent.created_by=NEW.created_by
 AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(parent.selection->'employmentIds') selected(value) WHERE selected.value=subject.id::text))
 OR EXISTS(SELECT 1 FROM public.letter_record existing WHERE existing.id=NEW.id)
 THEN RAISE EXCEPTION 'Letter proposed birth unavailable' USING ERRCODE='42501';END IF;
 INSERT INTO app.financial_letter_proposed_birth VALUES(pg_current_xact_id(),NEW.tenant_id,app.current_user_id(),NEW.id,NEW.company_id,NEW.employment_id,NEW.batch_id,encode(sha256(convert_to(to_jsonb(NEW)::text,'UTF8')),'hex'),false);
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.financial_letter_proposed_birth_capture() FROM PUBLIC,ai_hr_app;
-- Sort after the native letter_insert_binding trigger, which validates the draft and parent.
CREATE TRIGGER z_financial_letter_proposed_birth BEFORE INSERT ON letter_record FOR EACH ROW EXECUTE FUNCTION app.financial_letter_proposed_birth_capture();
CREATE FUNCTION app.financial_letter_proposed_birth_finish() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_LEVEL='ROW' THEN
  UPDATE app.financial_letter_proposed_birth SET completed=true WHERE transaction_id=pg_current_xact_id() AND tenant_id=NEW.tenant_id AND user_id=app.current_user_id() AND letter_id=NEW.id AND row_hash=encode(sha256(convert_to(to_jsonb(NEW)::text,'UTF8')),'hex');
 ELSE
  DELETE FROM app.financial_letter_proposed_birth WHERE transaction_id=pg_current_xact_id() AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND NOT completed;
 END IF;
 RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION app.financial_letter_proposed_birth_finish() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER financial_letter_proposed_birth_finish AFTER INSERT ON letter_record FOR EACH ROW EXECUTE FUNCTION app.financial_letter_proposed_birth_finish();
CREATE TRIGGER financial_letter_proposed_birth_cleanup AFTER INSERT ON letter_record FOR EACH STATEMENT EXECUTE FUNCTION app.financial_letter_proposed_birth_finish();
CREATE FUNCTION app.letter_record_birth_read(p_row jsonb) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT app.principal_snapshot_current() OR p_row->>'tenant_id' IS DISTINCT FROM app.current_tenant_id()::text OR p_row->>'created_by' IS DISTINCT FROM app.current_user_id()::text THEN RETURN false;END IF;
 RETURN EXISTS(SELECT 1 FROM app.financial_letter_proposed_birth proof WHERE proof.transaction_id=pg_current_xact_id() AND proof.tenant_id=app.current_tenant_id() AND proof.user_id=app.current_user_id()
 AND proof.letter_id=(p_row->>'id')::uuid AND proof.company_id=(p_row->>'company_id')::uuid AND proof.employment_id=(p_row->>'employment_id')::uuid AND proof.batch_id=(p_row->>'batch_id')::uuid AND proof.row_hash=encode(sha256(convert_to(p_row::text,'UTF8')),'hex')
 AND app.letter_function_action('letterGenerate','view',proof.company_id) AND app.letter_function_action('letterGenerate','add',proof.company_id) AND app.access_letter_action(proof.company_id,'generate','add') AND app.data_permission_matches(proof.employment_id)
 AND (NOT (p_row->>'confidential')::boolean OR app.can_admin_payroll_for(proof.company_id)));
END;
$$;
REVOKE ALL ON FUNCTION app.letter_record_birth_read(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.letter_record_birth_read(jsonb) TO ai_hr_app;
ALTER POLICY letter_record_read ON letter_record USING(tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() AND
 ((app.letter_permission(company_id,'read') AND app.letter_staff_scope(company_id,created_by,batch_id,id) AND (NOT confidential OR app.can_admin_payroll_for(company_id))) OR
 (state IN ('issued','void') AND EXISTS(SELECT 1 FROM public.employment self WHERE self.id=employment_id AND self.tenant_id=letter_record.tenant_id AND app.is_self_person(self.person_id))) OR app.letter_record_birth_read(to_jsonb(letter_record))));
CREATE FUNCTION app.financial_letter_proposed_birth_validate() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM app.financial_letter_proposed_birth proof JOIN public.letter_record actual ON actual.id=proof.letter_id AND actual.tenant_id=proof.tenant_id AND actual.company_id=proof.company_id AND actual.employment_id=proof.employment_id AND actual.batch_id=proof.batch_id AND actual.created_by=proof.user_id
 JOIN public.letter_generation_batch parent ON parent.id=proof.batch_id AND parent.tenant_id=proof.tenant_id AND parent.created_by=proof.user_id
 WHERE proof.transaction_id=NEW.transaction_id AND proof.tenant_id=NEW.tenant_id AND proof.user_id=NEW.user_id AND proof.letter_id=NEW.letter_id AND proof.completed
 AND proof.transaction_id=pg_current_xact_id() AND proof.tenant_id=app.current_tenant_id() AND proof.user_id=app.current_user_id()
 AND app.letter_function_action('letterGenerate','add',proof.company_id) AND app.data_permission_matches(proof.employment_id)
 AND EXISTS(SELECT 1 FROM public.domain_event audit WHERE audit.tenant_id=proof.tenant_id AND audit.aggregate_type='letter' AND audit.aggregate_id=proof.batch_id AND audit.event_type='letter.batch.created' AND audit.actor_type='user' AND audit.actor_id=proof.user_id AND app.financial_audit_written(audit.id)
 AND (audit.payload->>'count')::integer=jsonb_array_length(parent.selection->'employmentIds') AND (audit.payload->>'count')::integer=(SELECT count(*) FROM public.letter_record member WHERE member.batch_id=proof.batch_id AND member.tenant_id=proof.tenant_id))) THEN
  RAISE EXCEPTION 'Letter birth did not complete' USING ERRCODE='42501';END IF;
 RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION app.financial_letter_proposed_birth_validate() FROM PUBLIC,ai_hr_app;
CREATE CONSTRAINT TRIGGER financial_letter_proposed_birth_complete AFTER INSERT ON app.financial_letter_proposed_birth DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.financial_letter_proposed_birth_validate();
CREATE TRIGGER financial_receipts_prune AFTER INSERT ON app.financial_letter_proposed_birth FOR EACH ROW EXECUTE FUNCTION app.financial_receipts_prune();

--> statement-breakpoint
-- Queued reminder metadata has a separate native dispatcher course. No raw
-- recipient or assessment-row exception is added to the generic data policies.
-- Actual maintenance credentials enroll one cycle or actual queued source before
-- APP downgrade. A role/tenant GUC cannot create or widen this private custody.
CREATE TABLE app.financial_onehr_worker_source(
 transaction_id xid8 NOT NULL,tenant_id uuid NOT NULL,session_login name NOT NULL,source_kind text NOT NULL,source_id uuid NOT NULL,
 cycle_id uuid NOT NULL,review_id uuid,recipient_id uuid,event_id uuid,
 PRIMARY KEY(transaction_id,tenant_id,session_login,source_kind,source_id)
);
ALTER TABLE app.financial_onehr_worker_source ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.financial_onehr_worker_source FROM PUBLIC,ai_hr_app;
CREATE TABLE app.financial_onehr_source_context(
 transaction_id xid8 NOT NULL,tenant_id uuid NOT NULL,session_login name NOT NULL,scope_key text NOT NULL,mode text NOT NULL,
 recipient_id uuid,run_id uuid,cycle_id uuid,user_ids uuid[],event_id uuid,allow_write boolean NOT NULL DEFAULT false,depth integer NOT NULL DEFAULT 1,
 PRIMARY KEY(transaction_id,tenant_id,session_login,scope_key)
);
ALTER TABLE app.financial_onehr_source_context ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.financial_onehr_source_context FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.onehr_worker_queue_cycle(t uuid,c uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.access_workforce_storage_owner() AND app.current_user_id() IS NULL AND nullif(current_setting('app.agent_principal_id',true),'') IS NULL
 AND t=app.current_tenant_id() AND EXISTS(SELECT 1 FROM app.financial_onehr_worker_source proof WHERE proof.transaction_id=pg_current_xact_id() AND proof.tenant_id=t AND proof.session_login=session_user AND proof.source_kind='cycle' AND proof.cycle_id=c);
$$;
REVOKE ALL ON FUNCTION app.onehr_worker_queue_cycle(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onehr_worker_queue_cycle(uuid,uuid) TO ai_hr_app;
CREATE FUNCTION app.onehr_reminder_source_run_read(t uuid,r uuid,c uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.onehr_worker_queue_cycle(t,c) OR EXISTS(SELECT 1 FROM app.financial_onehr_source_context scope WHERE scope.transaction_id=pg_current_xact_id() AND scope.tenant_id=t AND scope.session_login=session_user
 AND (scope.run_id=r OR scope.mode='cooldown' AND scope.cycle_id=c));
$$;
REVOKE ALL ON FUNCTION app.onehr_reminder_source_run_read(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onehr_reminder_source_run_read(uuid,uuid,uuid) TO ai_hr_app;
CREATE FUNCTION app.onehr_reminder_source_recipient_read(t uuid,r uuid,parent uuid,u uuid,event uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app.financial_onehr_source_context scope WHERE scope.transaction_id=pg_current_xact_id() AND scope.tenant_id=t AND scope.session_login=session_user
 AND (scope.recipient_id=r AND (scope.run_id IS NULL OR scope.run_id=parent) AND (scope.event_id IS NULL OR scope.event_id=event) AND (scope.user_ids IS NULL OR u=ANY(scope.user_ids))
 OR scope.mode='cooldown' AND u=ANY(scope.user_ids) AND EXISTS(SELECT 1 FROM public.performance_assessment_reminder_run run WHERE run.id=parent AND run.tenant_id=t AND run.cycle_id=scope.cycle_id)))
 OR EXISTS(SELECT 1 FROM public.performance_assessment_reminder_run run WHERE run.id=parent AND run.tenant_id=t AND app.onehr_worker_queue_cycle(t,run.cycle_id));
$$;
REVOKE ALL ON FUNCTION app.onehr_reminder_source_recipient_read(uuid,uuid,uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onehr_reminder_source_recipient_read(uuid,uuid,uuid,uuid,uuid) TO ai_hr_app;
CREATE FUNCTION app.onehr_reminder_source_recipient_write(t uuid,r uuid,parent uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app.financial_onehr_source_context scope WHERE scope.transaction_id=pg_current_xact_id() AND scope.tenant_id=t AND scope.session_login=session_user AND scope.mode='recipient' AND scope.recipient_id=r AND scope.run_id=parent AND scope.allow_write);
$$;
REVOKE ALL ON FUNCTION app.onehr_reminder_source_recipient_write(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onehr_reminder_source_recipient_write(uuid,uuid,uuid) TO ai_hr_app;
CREATE POLICY financial_onehr_run_read ON public.performance_assessment_reminder_run FOR SELECT USING(app.onehr_reminder_source_run_read(tenant_id,id,cycle_id));
CREATE POLICY financial_onehr_recipient_read ON public.performance_assessment_reminder_recipient FOR SELECT USING(app.onehr_reminder_source_recipient_read(tenant_id,id,run_id,user_id,source_event_id));
CREATE POLICY financial_onehr_recipient_update ON public.performance_assessment_reminder_recipient FOR UPDATE
 USING(app.onehr_reminder_source_recipient_write(tenant_id,id,run_id)) WITH CHECK(app.onehr_reminder_source_recipient_write(tenant_id,id,run_id));
CREATE POLICY financial_onehr_run_queue ON public.performance_assessment_reminder_run FOR INSERT
 WITH CHECK(app.onehr_worker_queue_cycle(tenant_id,cycle_id) AND actor_user_id IS NULL AND mode='automatic' AND send_day IS NOT NULL);
CREATE FUNCTION app.onehr_worker_queue_recipient(row_data jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT row_data->'tasks'='[]'::jsonb AND row_data->>'mail_words' IS NULL AND row_data->>'prepared_at' IS NULL AND row_data->>'prepared_until' IS NULL
 AND row_data->>'outcome' IN ('queued','noConsent','cooldown') AND EXISTS(
 SELECT 1 FROM public.performance_assessment_reminder_run run JOIN public.app_user account ON account.id=(row_data->>'user_id')::uuid AND account.tenant_id=run.tenant_id
 WHERE run.id=(row_data->>'run_id')::uuid AND run.tenant_id=(row_data->>'tenant_id')::uuid AND run.actor_user_id IS NULL AND run.mode='automatic'
 AND app.onehr_worker_queue_cycle(run.tenant_id,run.cycle_id) AND account.archived_at IS NULL AND NOT app.login_blocked(account.id)
 AND (row_data->>'employment_id' IS NULL OR EXISTS(SELECT 1 FROM public.employment employment WHERE employment.id=(row_data->>'employment_id')::uuid AND employment.tenant_id=run.tenant_id AND employment.person_id=account.person_id))
 AND (row_data->>'outcome'<>'queued' AND row_data->>'source_event_id' IS NULL OR EXISTS(SELECT 1 FROM public.domain_event event WHERE event.id=(row_data->>'source_event_id')::uuid AND event.tenant_id=run.tenant_id AND event.aggregate_id=(row_data->>'id')::uuid AND event.aggregate_type='assessment-reminder' AND event.event_type='assessment.reminder-queued' AND event.actor_type='system' AND event.actor_id IS NULL)));
$$;
REVOKE ALL ON FUNCTION app.onehr_worker_queue_recipient(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onehr_worker_queue_recipient(jsonb) TO ai_hr_app;
CREATE POLICY financial_onehr_recipient_queue ON public.performance_assessment_reminder_recipient FOR INSERT WITH CHECK(app.onehr_worker_queue_recipient(to_jsonb(performance_assessment_reminder_recipient.*)));
CREATE FUNCTION app.financial_onehr_recipient_context_begin(p_recipient uuid,p_write boolean DEFAULT false,p_owner boolean DEFAULT false) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE parent uuid;cycle uuid;
BEGIN
 IF app.current_user_id() IS NOT NULL THEN RETURN false;END IF;
 IF nullif(current_setting('app.agent_principal_id',true),'') IS NOT NULL THEN RAISE EXCEPTION 'OneHR worker principal unavailable' USING ERRCODE='42501';END IF;
 IF NOT(p_owner AND app.access_workforce_storage_owner()) AND NOT EXISTS(SELECT 1 FROM app.financial_onehr_worker_source proof WHERE proof.transaction_id=pg_current_xact_id() AND proof.tenant_id=app.current_tenant_id() AND proof.session_login=session_user AND proof.recipient_id=p_recipient AND app.financial_onehr_worker_allowed(proof.cycle_id,NULL,p_recipient)) THEN RETURN false;END IF;
 INSERT INTO app.financial_onehr_source_context(transaction_id,tenant_id,session_login,scope_key,mode,recipient_id,allow_write) VALUES(pg_current_xact_id(),app.current_tenant_id(),session_user,'recipient:'||p_recipient,'recipient',p_recipient,p_write)
 ON CONFLICT(transaction_id,tenant_id,session_login,scope_key) DO UPDATE SET depth=financial_onehr_source_context.depth+1,allow_write=financial_onehr_source_context.allow_write OR excluded.allow_write;
 SELECT recipient.run_id INTO parent FROM public.performance_assessment_reminder_recipient recipient WHERE recipient.id=p_recipient AND recipient.tenant_id=app.current_tenant_id();
 UPDATE app.financial_onehr_source_context scope SET run_id=parent WHERE scope.transaction_id=pg_current_xact_id() AND scope.tenant_id=app.current_tenant_id() AND scope.session_login=session_user AND scope.scope_key='recipient:'||p_recipient;
 RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION app.financial_onehr_recipient_context_begin(uuid,boolean,boolean) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.financial_onehr_recipient_context_end(p_recipient uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 UPDATE app.financial_onehr_source_context scope SET depth=depth-1 WHERE scope.transaction_id=pg_current_xact_id() AND scope.tenant_id=app.current_tenant_id() AND scope.session_login=session_user AND scope.scope_key='recipient:'||p_recipient;
 DELETE FROM app.financial_onehr_source_context scope WHERE scope.transaction_id=pg_current_xact_id() AND scope.tenant_id=app.current_tenant_id() AND scope.session_login=session_user AND scope.scope_key='recipient:'||p_recipient AND scope.depth=0;
END;
$$;
REVOKE ALL ON FUNCTION app.financial_onehr_recipient_context_end(uuid) FROM PUBLIC,ai_hr_app;
CREATE TRIGGER financial_receipts_prune AFTER INSERT ON app.financial_onehr_source_context FOR EACH ROW EXECUTE FUNCTION app.financial_receipts_prune();

CREATE FUNCTION app.financial_onehr_worker_enroll(p_kind text,p_source uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE cycle_id uuid;review_id uuid;recipient_id uuid;event_id uuid;opened uuid;
BEGIN
 IF NOT app.access_workforce_storage_owner() OR app.current_user_id() IS NOT NULL OR nullif(current_setting('app.agent_principal_id',true),'') IS NOT NULL
 OR app.current_tenant_id() IS NULL OR p_kind IS NULL OR p_kind NOT IN ('cycle','event','recipient') THEN RAISE EXCEPTION 'OneHR worker connection unavailable' USING ERRCODE='42501';END IF;
 IF p_kind='cycle' THEN
  SELECT cycle.id INTO cycle_id FROM public.review_cycle cycle JOIN public.performance_onehr_cycle config ON config.cycle_id=cycle.id AND config.tenant_id=cycle.tenant_id
  WHERE cycle.id=p_source AND cycle.tenant_id=app.current_tenant_id() AND cycle.status IN ('open','calibration');
 ELSE
  IF p_kind='recipient' THEN
   PERFORM app.financial_onehr_recipient_context_begin(p_source,false,true);opened:=p_source;
   SELECT recipient.source_event_id INTO event_id FROM public.performance_assessment_reminder_recipient recipient WHERE recipient.id=p_source AND recipient.tenant_id=app.current_tenant_id();
  ELSE event_id:=p_source;SELECT event.aggregate_id INTO opened FROM public.domain_event event WHERE event.id=event_id AND event.tenant_id=app.current_tenant_id() AND event.event_type='assessment.reminder-queued' AND event.aggregate_type='assessment-reminder';
   IF opened IS NOT NULL THEN PERFORM app.financial_onehr_recipient_context_begin(opened,false,true);END IF;END IF;
  SELECT run.cycle_id,recipient.id INTO cycle_id,recipient_id FROM public.domain_event event
  JOIN public.performance_assessment_reminder_recipient recipient ON recipient.id=event.aggregate_id AND recipient.source_event_id=event.id AND recipient.tenant_id=event.tenant_id
  JOIN public.performance_assessment_reminder_run run ON run.id=recipient.run_id AND run.tenant_id=recipient.tenant_id
  WHERE event.id=event_id AND event.tenant_id=app.current_tenant_id() AND event.event_type='assessment.reminder-queued' AND event.aggregate_type='assessment-reminder'
  AND event.actor_id IS NOT DISTINCT FROM run.actor_user_id;
  IF cycle_id IS NULL AND p_kind='event' THEN
   SELECT review.cycle_id,review.review_id INTO cycle_id,review_id FROM public.domain_event event
   JOIN public.performance_onehr_review review ON review.review_id=event.aggregate_id AND review.tenant_id=event.tenant_id
   WHERE event.id=event_id AND event.tenant_id=app.current_tenant_id() AND event.aggregate_type='onehr'
   AND (event.event_type IN ('onehr.results-submitted','onehr.competencies-submitted','onehr.plan-shared') OR event.event_type='onehr.kpi-approval-needed' AND event.payload->>'phase' IN ('setting','results'));
  END IF;
 END IF;
 IF cycle_id IS NULL THEN IF opened IS NOT NULL THEN PERFORM app.financial_onehr_recipient_context_end(opened);END IF;RETURN;END IF;
 INSERT INTO app.financial_onehr_worker_source VALUES(pg_current_xact_id(),app.current_tenant_id(),session_user,p_kind,p_source,cycle_id,review_id,recipient_id,event_id) ON CONFLICT DO NOTHING;
 IF opened IS NOT NULL THEN PERFORM app.financial_onehr_recipient_context_end(opened);END IF;
END;
$$;
REVOKE ALL ON FUNCTION app.financial_onehr_worker_enroll(text,uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.financial_onehr_worker_allowed(p_cycle uuid,p_review uuid DEFAULT NULL,p_recipient uuid DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.current_user_id() IS NULL AND nullif(current_setting('app.agent_principal_id',true),'') IS NULL AND EXISTS(
 SELECT 1 FROM app.financial_onehr_worker_source proof JOIN public.review_cycle cycle ON cycle.id=proof.cycle_id AND cycle.tenant_id=proof.tenant_id
 JOIN public.performance_onehr_cycle config ON config.cycle_id=cycle.id AND config.tenant_id=cycle.tenant_id
 WHERE proof.transaction_id=pg_current_xact_id() AND proof.tenant_id=app.current_tenant_id() AND proof.session_login=session_user
 AND proof.cycle_id=p_cycle AND cycle.status IN ('open','calibration')
 AND (p_recipient IS NOT NULL AND proof.recipient_id=p_recipient
 OR p_recipient IS NULL AND p_review IS NOT NULL AND (proof.review_id=p_review OR (proof.source_kind='cycle' OR proof.recipient_id IS NOT NULL) AND EXISTS(SELECT 1 FROM public.performance_review review WHERE review.id=p_review AND review.cycle_id=proof.cycle_id AND review.tenant_id=proof.tenant_id))
 OR p_recipient IS NULL AND p_review IS NULL AND (proof.source_kind='cycle' OR proof.recipient_id IS NOT NULL)));
$$;
REVOKE ALL ON FUNCTION app.financial_onehr_worker_allowed(uuid,uuid,uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.onehr_worker_access(p_cycle uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT app.financial_onehr_worker_allowed(p_cycle,NULL,NULL); $$;
REVOKE ALL ON FUNCTION app.onehr_worker_access(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onehr_worker_access(uuid) TO ai_hr_app;
CREATE TRIGGER financial_receipts_prune AFTER INSERT ON app.financial_onehr_worker_source FOR EACH ROW EXECUTE FUNCTION app.financial_receipts_prune();
-- No parameterless tenant worker authority remains. Existing raw dispatcher RLS
-- branches cannot be revived by an issued finite source proof.
CREATE OR REPLACE FUNCTION app.assessment_dispatcher_scope() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT false; $$;

CREATE FUNCTION app.onehr_reminder_dispatch_source(p_recipient uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('recipient',jsonb_build_object('id',recipient.id,'userId',recipient.user_id,'employmentId',recipient.employment_id,'outcome',recipient.outcome),
 'run',jsonb_build_object('id',run.id,'tenantId',run.tenant_id,'cycleId',run.cycle_id,'mode',run.mode),
 'tenantEpoch',coalesce((SELECT epoch.revision FROM public.performance_assessment_reminder_epoch epoch WHERE epoch.tenant_id=run.tenant_id AND epoch.scope_id='00000000-0000-0000-0000-000000000000'),0),
 'cycleEpoch',coalesce((SELECT epoch.revision FROM public.performance_assessment_reminder_epoch epoch WHERE epoch.tenant_id=run.tenant_id AND epoch.scope_id=run.cycle_id),0))
 FROM public.performance_assessment_reminder_recipient recipient JOIN public.performance_assessment_reminder_run run ON run.id=recipient.run_id AND run.tenant_id=recipient.tenant_id
 JOIN public.performance_onehr_cycle config ON config.cycle_id=run.cycle_id AND config.tenant_id=run.tenant_id
 JOIN public.employment subject ON subject.id=recipient.employment_id AND subject.tenant_id=recipient.tenant_id
 JOIN public.domain_event event ON event.id=recipient.source_event_id AND event.tenant_id=recipient.tenant_id AND event.aggregate_id=recipient.id AND event.aggregate_type='assessment-reminder' AND event.event_type='assessment.reminder-queued' AND event.actor_id IS NOT DISTINCT FROM run.actor_user_id
 WHERE recipient.id=p_recipient AND recipient.tenant_id=app.current_tenant_id()
 AND (app.financial_onehr_worker_allowed(run.cycle_id,NULL,recipient.id) OR app.principal_snapshot_current() AND app.onehr_cycle_admin(run.cycle_id) AND app.onehr_admin(subject.company_id) AND app.data_permission_matches(subject.id));
$$;
REVOKE ALL ON FUNCTION app.onehr_reminder_dispatch_source(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onehr_reminder_dispatch_source(uuid) TO ai_hr_app;
CREATE TABLE app.financial_onehr_prepared_source(
 tenant_id uuid NOT NULL,recipient_id uuid PRIMARY KEY REFERENCES public.performance_assessment_reminder_recipient(id) ON DELETE CASCADE,user_id uuid NOT NULL,cycle_id uuid NOT NULL,review_ids uuid[] NOT NULL,
 tasks_hash text NOT NULL,prepared_at timestamptz NOT NULL,prepared_until timestamptz NOT NULL
);
ALTER TABLE app.financial_onehr_prepared_source ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.financial_onehr_prepared_source FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.onehr_reminder_dispatch_update(p_recipient uuid,p_expected jsonb,p_outcome text,p_tasks jsonb,p_words jsonb,p_until timestamptz,p_tenant_epoch bigint,p_cycle_epoch bigint,p_review_ids uuid[] DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source jsonb;recipient public.performance_assessment_reminder_recipient%ROWTYPE;now_at timestamptz;deadline timestamptz;boundary timestamptz;words jsonb:=nullif(p_words,'null'::jsonb);
BEGIN
 IF nullif(current_setting('app.agent_principal_id',true),'') IS NOT NULL THEN RAISE EXCEPTION 'OneHR worker principal unavailable' USING ERRCODE='42501';END IF;
 IF app.current_agent_principal() IS NOT NULL THEN RAISE EXCEPTION 'OneHR worker principal unavailable' USING ERRCODE='42501';END IF;
 PERFORM app.access_workforce_write_lock();
 source:=app.onehr_reminder_dispatch_source(p_recipient);IF source IS NULL OR source IS DISTINCT FROM p_expected THEN RETURN false;END IF;
 SELECT * INTO recipient FROM public.performance_assessment_reminder_recipient actual WHERE actual.id=p_recipient AND actual.tenant_id=app.current_tenant_id() FOR UPDATE;
 source:=app.onehr_reminder_dispatch_source(p_recipient);
 IF source IS NULL OR source IS DISTINCT FROM p_expected OR recipient.outcome<>'queued' THEN RETURN false;END IF;
 IF p_outcome IS NULL OR p_outcome NOT IN ('queued','changed','noPendingWork','noConsent','cooldown') THEN RAISE EXCEPTION 'Reminder projection outcome unavailable' USING ERRCODE='42501';END IF;
 IF p_outcome<>'queued' THEN
  DELETE FROM app.financial_onehr_prepared_source sealed WHERE sealed.recipient_id=recipient.id AND sealed.tenant_id=recipient.tenant_id;
  UPDATE public.performance_assessment_reminder_recipient actual SET outcome=p_outcome,tasks='[]',mail_words=NULL,prepared_at=NULL,prepared_until=NULL WHERE actual.id=recipient.id;
  RETURN true;
 END IF;
 now_at:=clock_timestamp();deadline:=now_at+interval '60 seconds';
 SELECT min(module.expires_at) INTO boundary FROM public.tenant_module module WHERE module.tenant_id=recipient.tenant_id AND module.expires_at>now_at;IF boundary IS NOT NULL THEN deadline:=least(deadline,boundary);END IF;
 SELECT min(cell.value::timestamptz) INTO boundary FROM public.performance_onehr_cycle config CROSS JOIN LATERAL jsonb_each(coalesce(config.policy->'windows','{}'::jsonb)) window_entry CROSS JOIN LATERAL jsonb_each_text(window_entry.value) cell
 WHERE config.cycle_id=(source->'run'->>'cycleId')::uuid AND config.tenant_id=recipient.tenant_id AND cell.key IN ('opensAt','closesAt') AND cell.value::timestamptz>now_at;IF boundary IS NOT NULL THEN deadline:=least(deadline,boundary);END IF;
 IF p_until IS NULL OR p_until<=now_at OR p_until>deadline OR p_tenant_epoch IS DISTINCT FROM (source->>'tenantEpoch')::bigint OR p_cycle_epoch IS DISTINCT FROM (source->>'cycleEpoch')::bigint
 OR jsonb_typeof(p_tasks) IS DISTINCT FROM 'array' OR jsonb_array_length(p_tasks) NOT BETWEEN 1 AND 16 OR octet_length(p_tasks::text)>20000
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_tasks) task WHERE jsonb_typeof(task)<>'object' OR task-ARRAY['key','count','closesAt','people']<>'{}'::jsonb OR NOT task ?& ARRAY['key','count','closesAt']
 OR task->>'key' NOT IN ('own_results','own_checkin','own_competency','own_plan','feedback','team_setting','team_results','team_competency','team_plan','team_career','hod_performance','hod_potential','bu_performance','bu_potential','bg_talent','group_performance')
 OR jsonb_typeof(task->'count') IS DISTINCT FROM 'number' OR (task->>'count')::numeric NOT BETWEEN 1 AND 1000000 OR (task->>'count')::numeric<>trunc((task->>'count')::numeric)
 OR task->'closesAt'<>'null'::jsonb AND jsonb_typeof(task->'closesAt') IS DISTINCT FROM 'string'
 OR task ? 'people' AND (jsonb_typeof(task->'people') IS DISTINCT FROM 'array' OR jsonb_array_length(task->'people')>3 OR EXISTS(SELECT 1 FROM jsonb_array_elements(task->'people') name WHERE jsonb_typeof(name)<>'string' OR length(name#>>'{}') NOT BETWEEN 1 AND 200)))
 OR words IS NOT NULL AND (jsonb_typeof(words)<>'object' OR NOT app.access_command_keys(words,ARRAY['subject','opening']) OR NOT words ?& ARRAY['subject','opening'] OR jsonb_typeof(words->'subject')<>'string' OR jsonb_typeof(words->'opening')<>'string' OR length(words->>'subject') NOT BETWEEN 1 AND 20000 OR length(words->>'opening') NOT BETWEEN 1 AND 30000 OR words->>'subject' ~ E'[\r\n]')
 THEN RAISE EXCEPTION 'Reminder bounded projection unavailable' USING ERRCODE='42501';END IF;
 IF p_review_ids IS NULL OR cardinality(p_review_ids)>100000 OR array_position(p_review_ids,NULL) IS NOT NULL OR cardinality(p_review_ids)<>(SELECT count(DISTINCT id) FROM unnest(p_review_ids) id)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_tasks) task WHERE task->>'key' IN ('own_results','own_checkin','own_competency','own_plan','team_setting','team_results','team_competency','team_plan','team_career')) AND cardinality(p_review_ids)=0
 OR EXISTS(SELECT 1 FROM unnest(p_review_ids) wanted(id) WHERE NOT EXISTS(SELECT 1 FROM public.performance_onehr_review review WHERE review.review_id=wanted.id AND review.cycle_id=(source->'run'->>'cycleId')::uuid AND review.tenant_id=recipient.tenant_id AND app.financial_onehr_target_task_view(review.tenant_id,recipient.user_id,review.review_id)))
 THEN RAISE EXCEPTION 'Reminder task source unavailable' USING ERRCODE='42501';END IF;
 INSERT INTO app.financial_onehr_prepared_source VALUES(recipient.tenant_id,recipient.id,recipient.user_id,(source->'run'->>'cycleId')::uuid,p_review_ids,
 encode(sha256(convert_to(jsonb_build_object('tasks',p_tasks,'words',words)::text,'UTF8')),'hex'),now_at,p_until)
 ON CONFLICT(recipient_id) DO UPDATE SET user_id=excluded.user_id,cycle_id=excluded.cycle_id,review_ids=excluded.review_ids,tasks_hash=excluded.tasks_hash,prepared_at=excluded.prepared_at,prepared_until=excluded.prepared_until WHERE financial_onehr_prepared_source.tenant_id=excluded.tenant_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Reminder task source changed' USING ERRCODE='42501';END IF;
 UPDATE public.performance_assessment_reminder_recipient actual SET tasks=p_tasks,mail_words=words,prepared_at=now_at,prepared_until=p_until,tenant_epoch=p_tenant_epoch,cycle_epoch=p_cycle_epoch WHERE actual.id=recipient.id;
 RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION app.onehr_reminder_dispatch_update(uuid,jsonb,text,jsonb,jsonb,timestamptz,bigint,bigint,uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onehr_reminder_dispatch_update(uuid,jsonb,text,jsonb,jsonb,timestamptz,bigint,bigint,uuid[]) TO ai_hr_app;
-- The delayed-notice reader needs workflow flags and actual assigned IDs, never
-- raw self/manager answers, KPI amounts, review text or a stored performance band.
-- Notification eligibility belongs to each actual recipient, never to the dispatcher.
CREATE FUNCTION app.financial_onehr_target_task_view(t uuid,u uuid,r uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce((SELECT c.supported=false OR app.access_allowed_for_tenant(t,u,c.id,subject.company_id)
 FROM public.performance_review review JOIN public.employment subject ON subject.id=review.employment_id AND subject.tenant_id=review.tenant_id
 CROSS JOIN LATERAL (SELECT app.financial_onehr_review_course_for(t,u,review.id) AS course) native
 JOIN app.access_function_action action ON action.function_key=CASE native.course WHEN 'self' THEN 'performance.onehr.selfReview' WHEN 'assigned' THEN 'performance.onehr.assignedReview' END AND action.operation='view'
 JOIN public.access_capability c ON c.id=action.capability_id
 WHERE review.id=r AND review.tenant_id=t AND native.course IN ('self','assigned')),false);
$$;
REVOKE ALL ON FUNCTION app.financial_onehr_target_task_view(uuid,uuid,uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.onehr_review_task_recipient_access(p_cycle uuid,p_user uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(jsonb_object_agg(review.id::text,(SELECT coalesce(jsonb_agg(account.id ORDER BY account.id),'[]'::jsonb)
 FROM public.app_user account WHERE account.tenant_id=review.tenant_id AND (p_user IS NULL OR account.id=p_user)
 AND app.financial_onehr_target_task_view(review.tenant_id,account.id,review.id))),'{}'::jsonb)
 FROM public.performance_review review JOIN public.performance_onehr_cycle config ON config.cycle_id=review.cycle_id AND config.tenant_id=review.tenant_id
 JOIN public.employment subject ON subject.id=review.employment_id AND subject.tenant_id=review.tenant_id
 JOIN public.review_cycle cycle ON cycle.id=review.cycle_id AND cycle.tenant_id=review.tenant_id
 WHERE review.cycle_id=p_cycle AND review.tenant_id=app.current_tenant_id() AND cycle.status IN ('open','calibration')
 AND (app.financial_onehr_worker_allowed(cycle.id,NULL,NULL) OR app.principal_snapshot_current() AND app.onehr_cycle_admin(cycle.id) AND app.onehr_admin(subject.company_id) AND app.data_permission_matches(subject.id)) AND app.assessment_review_participates(review.id);
$$;
REVOKE ALL ON FUNCTION app.onehr_review_task_recipient_access(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onehr_review_task_recipient_access(uuid,uuid) TO ai_hr_app;

CREATE FUNCTION app.onehr_review_notice_source(p_review uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH source AS MATERIALIZED (
  SELECT assessment.*,review.reviewer_employment_id,review.closed_at,cycle.period_end,config.policy,
   app.financial_onehr_effective_reviewer_of(review.tenant_id,review.id,NULL,NULL) AS effective_reviewer,
   app.onehr_moderator_choices(review.id) AS moderators
  FROM public.performance_onehr_review assessment JOIN public.performance_review review ON review.id=assessment.review_id AND review.tenant_id=assessment.tenant_id
  JOIN public.review_cycle cycle ON cycle.id=review.cycle_id AND cycle.tenant_id=review.tenant_id JOIN public.performance_onehr_cycle config ON config.cycle_id=cycle.id AND config.tenant_id=cycle.tenant_id
  WHERE review.id=p_review AND review.tenant_id=app.current_tenant_id() AND cycle.status IN ('open','calibration') AND app.assessment_review_participates(review.id)
  AND (app.financial_onehr_worker_allowed(cycle.id,review.id,NULL) OR app.onehr_review_header(review.id) IS NOT NULL)
 ), candidates AS (
  SELECT (moderator->>'id')::uuid AS id FROM source CROSS JOIN LATERAL jsonb_array_elements(source.moderators) moderator
  UNION SELECT effective_reviewer FROM source WHERE effective_reviewer IS NOT NULL
 )
 SELECT jsonb_build_object('reviewId',source.review_id,'employmentId',source.employment_id,'reviewerEmploymentId',source.effective_reviewer,
 'policy',jsonb_build_object('kind',source.policy->'kind','modules',source.policy->'modules','windows',source.policy->'windows'),
 'frozen',source.closed_at IS NOT NULL OR EXISTS(SELECT 1 FROM public.performance_onehr_result result WHERE result.review_id=source.review_id AND result.tenant_id=source.tenant_id),
 'moderatorIds',(SELECT coalesce(jsonb_agg(moderator->'id'),'[]'::jsonb) FROM jsonb_array_elements(source.moderators) moderator),
 'liveIds',(SELECT coalesce(jsonb_agg(DISTINCT employment.id ORDER BY employment.id),'[]'::jsonb) FROM candidates JOIN public.employment employment ON employment.id=candidates.id AND employment.tenant_id=source.tenant_id
 JOIN public.app_user account ON account.person_id=employment.person_id AND account.tenant_id=employment.tenant_id WHERE account.archived_at IS NULL AND NOT app.login_blocked(account.id) AND (employment.terminated_on IS NULL OR employment.terminated_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) AND NOT app.assessment_unit_out(source.cycle_id,employment.id)
 AND app.financial_onehr_target_task_view(source.tenant_id,account.id,source.review_id)
 -- Employment-addressed notices are visible to every active account of that person.
 AND NOT EXISTS(SELECT 1 FROM public.app_user other WHERE other.tenant_id=employment.tenant_id AND other.person_id=employment.person_id
 AND other.archived_at IS NULL AND NOT app.login_blocked(other.id) AND NOT app.financial_onehr_target_task_view(source.tenant_id,other.id,source.review_id))),
 'facts',jsonb_build_object('competenciesAssigned',jsonb_array_length(source.competencies)>0,'competencyStatus',source.competency_status,'resultsSubmitted',source.results_submitted_at IS NOT NULL,'managerPerformance',NULL,'managerComplete',source.manager_performance IS NOT NULL,
 'planStatus',(SELECT plan.status FROM public.performance_onehr_plan plan WHERE plan.tenant_id=source.tenant_id AND plan.employment_id=source.employment_id AND plan.plan_year=extract(year from source.period_end)::integer+CASE WHEN source.policy->>'kind'='year_end' THEN 1 ELSE 0 END),
 'kpis',(SELECT coalesce(jsonb_agg(jsonb_build_object('hrOwned',coalesce((kpi->>'hrOwned')::boolean,false),'setting',kpi->'setting','locked',kpi->'locked','moderatorEmploymentId',kpi->'moderatorEmploymentId','checkIn',kpi->'checkIn' IS NOT NULL AND kpi->'checkIn'<>'null'::jsonb,
 'approvalChain',(SELECT coalesce(jsonb_agg(jsonb_build_object('employmentId',step->'employmentId','at',step->'at') ORDER BY position),'[]'::jsonb) FROM jsonb_array_elements(coalesce(kpi->'approvalChain','[]'::jsonb)) WITH ORDINALITY item(step,position)),
 'settingApprovals',(SELECT coalesce(jsonb_agg(jsonb_build_object('action',step->'action') ORDER BY position),'[]'::jsonb) FROM jsonb_array_elements(coalesce(kpi->'settingApprovals','[]'::jsonb)) WITH ORDINALITY item(step,position))) ORDER BY position),'[]'::jsonb) FROM jsonb_array_elements(source.kpis) WITH ORDINALITY item(kpi,position)))) FROM source;
$$;
REVOKE ALL ON FUNCTION app.onehr_review_notice_source(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onehr_review_notice_source(uuid) TO ai_hr_app;

--> statement-breakpoint
-- Frozen provenance is not a participant field API. Existence guards and released
-- bands have distinct bounded readers, so a manager needs no raw result row grant.
CREATE FUNCTION app.financial_onehr_result_admin(p_review uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND EXISTS(SELECT 1 FROM public.performance_review review
 JOIN public.employment subject ON subject.id=review.employment_id AND subject.tenant_id=review.tenant_id
 JOIN public.performance_onehr_cycle config ON config.cycle_id=review.cycle_id AND config.tenant_id=review.tenant_id
 WHERE review.id=p_review AND review.tenant_id=app.current_tenant_id() AND app.onehr_cycle_admin(review.cycle_id)
 AND app.onehr_admin(subject.company_id) AND app.data_permission_matches(subject.id));
$$;
REVOKE ALL ON FUNCTION app.financial_onehr_result_admin(uuid) FROM PUBLIC,ai_hr_app;
ALTER FUNCTION app.onehr_result_card(uuid) RENAME TO financial_onehr_native_result_card;
REVOKE ALL ON FUNCTION app.financial_onehr_native_result_card(uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.onehr_result_card(wanted_review uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.financial_onehr_native_result_card(wanted_review) WHERE app.principal_snapshot_current() AND EXISTS(
 SELECT 1 FROM public.performance_review review WHERE review.id=wanted_review AND review.tenant_id=app.current_tenant_id()
 AND (app.onehr_self_employment(review.employment_id) OR app.financial_onehr_result_admin(review.id)));
$$;
REVOKE ALL ON FUNCTION app.onehr_result_card(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onehr_result_card(uuid) TO ai_hr_app;
CREATE FUNCTION app.onehr_review_frozen(wanted_review uuid) RETURNS TABLE(id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT result.id FROM public.performance_onehr_result result WHERE result.review_id=wanted_review AND result.tenant_id=app.current_tenant_id()
 AND app.onehr_review_header(result.review_id) IS NOT NULL;
$$;
REVOKE ALL ON FUNCTION app.onehr_review_frozen(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onehr_review_frozen(uuid) TO ai_hr_app;
CREATE OR REPLACE FUNCTION app.onehr_frozen_visible(wanted_review uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH r AS (SELECT review.review_id,review.tenant_id,app.onehr_self_employment(review.employment_id) AS own
 FROM public.performance_onehr_review review WHERE review.review_id=wanted_review AND review.tenant_id=app.current_tenant_id() AND app.principal_snapshot_current()),
 v AS (SELECT r.review_id,r.tenant_id,NOT r.own AND app.financial_onehr_result_admin(r.review_id) AS admin,
 CASE WHEN r.own THEN NULL ELSE app.onehr_leader_role(r.review_id) END AS leader FROM r)
 SELECT jsonb_build_object(
 'performance',coalesce(v.admin OR v.leader IN ('bg','group') OR v.leader IS NOT NULL AND rel.performance_leader_released_at IS NOT NULL,false),
 'potential',coalesce(v.admin OR v.leader IN ('bg','group') OR v.leader IS NOT NULL AND rel.potential_leader_released_at IS NOT NULL,false),
 'talent',coalesce(v.admin OR v.leader IN ('bg','group') OR v.leader IS NOT NULL AND rel.talent_leader_released_at IS NOT NULL,false))
 FROM v LEFT JOIN public.performance_assessment_release rel ON rel.review_id=v.review_id AND rel.tenant_id=v.tenant_id;
$$;
CREATE FUNCTION app.onehr_task_result_card(wanted_review uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result public.performance_onehr_result%ROWTYPE;visible jsonb;card jsonb;
BEGIN
 IF app.onehr_review_task_header(wanted_review) IS NULL THEN RETURN NULL;END IF;
 card:=app.onehr_result_card(wanted_review);IF card IS NOT NULL THEN RETURN card;END IF;
 -- The former raw result policy admitted the actual line manager only. A KPI
 -- approver or administrative role outside its data profile gains no new course.
 IF NOT app.onehr_manager(wanted_review) THEN RETURN NULL;END IF;
 SELECT * INTO result FROM public.performance_onehr_result actual WHERE actual.review_id=wanted_review AND actual.tenant_id=app.current_tenant_id();
 IF result.id IS NULL THEN RETURN NULL;END IF;
 visible:=app.onehr_frozen_visible(wanted_review);
 RETURN jsonb_build_object('id',result.id,'digest',result.digest,'frozen',true,
 'performanceReleasedAt',result.performance_released_at,'potentialReleasedAt',result.potential_released_at,'talentReleasedAt',result.talent_released_at,'feedbackReleasedAt',result.feedback_released_at,
 'result',jsonb_build_object('performance',CASE WHEN (visible->>'performance')::boolean THEN result.result->'performance' END,
 'potential',CASE WHEN (visible->>'potential')::boolean THEN result.result->'potential' END,'talent',CASE WHEN (visible->>'talent')::boolean THEN result.result->'talent' END,
 'performanceSource',CASE WHEN (visible->>'performance')::boolean THEN result.result->'performanceSource' END,'potentialSource',CASE WHEN (visible->>'potential')::boolean THEN result.result->'potentialSource' END,
 'feedback',CASE WHEN result.feedback_released_at IS NOT NULL THEN result.result->'feedback' ELSE '[]'::jsonb END,
 'anonymousFeedback',CASE WHEN result.feedback_released_at IS NOT NULL THEN result.result->'anonymousFeedback' END));
END;
$$;
REVOKE ALL ON FUNCTION app.onehr_task_result_card(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onehr_task_result_card(uuid) TO ai_hr_app;
CREATE FUNCTION app.onehr_report_result(wanted_review uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('id',result.id,'digest',result.digest,
 'performance',CASE WHEN (visible.value->>'performance')::boolean THEN result.result->'performance' END,
 'potential',CASE WHEN (visible.value->>'potential')::boolean THEN result.result->'potential' END,
 'talent',CASE WHEN (visible.value->>'talent')::boolean THEN result.result->'talent' END)
 FROM public.performance_onehr_result result CROSS JOIN LATERAL (SELECT app.onehr_frozen_visible(wanted_review) AS value) visible
 WHERE result.review_id=wanted_review AND result.tenant_id=app.current_tenant_id() AND app.principal_snapshot_current()
 AND NOT app.onehr_self_employment(result.employment_id) AND (app.financial_onehr_result_admin(wanted_review) OR app.onehr_manager(wanted_review));
$$;
REVOKE ALL ON FUNCTION app.onehr_report_result(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onehr_report_result(uuid) TO ai_hr_app;
CREATE FUNCTION app.onehr_result_administration(wanted_review uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT app.financial_onehr_result_admin(wanted_review); $$;
REVOKE ALL ON FUNCTION app.onehr_result_administration(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onehr_result_administration(uuid) TO ai_hr_app;
CREATE POLICY financial_onehr_result_read ON public.performance_onehr_result AS RESTRICTIVE FOR SELECT TO ai_hr_app
 USING(tenant_id=app.current_tenant_id() AND app.onehr_result_administration(review_id));

--> statement-breakpoint
-- Current source ceilings apply to the administrative arm. Actual assigned
-- calibration and review courses remain independent of administrative profiles.
CREATE FUNCTION app.financial_onehr_named_source_allowed(p_review uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND EXISTS(SELECT 1 FROM public.performance_review review
 WHERE review.id=p_review AND review.tenant_id=app.current_tenant_id() AND NOT app.onehr_self_employment(review.employment_id)
 AND (app.financial_onehr_result_admin(review.id) OR app.onehr_manager(review.id) OR app.onehr_effective_reviewer(review.id)
 OR EXISTS(SELECT 1 FROM public.performance_onehr_calibration_entry entry JOIN public.performance_onehr_calibration session ON session.id=entry.session_id AND session.tenant_id=entry.tenant_id
 WHERE entry.review_id=review.id AND entry.tenant_id=review.tenant_id AND app.onehr_calibration_reviewer(session.id,app.current_user_id()))));
$$;
REVOKE ALL ON FUNCTION app.financial_onehr_named_source_allowed(uuid) FROM PUBLIC,ai_hr_app;
ALTER FUNCTION app.onehr_assessment_inputs(uuid) RENAME TO financial_onehr_native_assessment_inputs;
CREATE OR REPLACE FUNCTION app.financial_onehr_native_assessment_inputs(wanted_review uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('reviewId',r.review_id,'employmentId',r.employment_id,'companyId',r.company_id,'department',coalesce((SELECT d.name FROM assignment a JOIN department d ON d.id=a.department_id AND d.tenant_id=a.tenant_id WHERE a.employment_id=e.id AND a.tenant_id=e.tenant_id AND a.superseded_at IS NULL AND a.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (a.valid_to IS NULL OR a.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) ORDER BY a.valid_from DESC,a.id LIMIT 1),''),'businessGroupId',coalesce((SELECT c.parent_company_id::text FROM company c WHERE c.id=r.company_id AND c.tenant_id=r.tenant_id),''),'businessGroup',coalesce((SELECT g.legal_name FROM company c JOIN company g ON g.id=c.parent_company_id AND g.tenant_id=c.tenant_id WHERE c.id=r.company_id AND c.tenant_id=r.tenant_id),''),'grade',r.grade,'name',p.full_name,'performance',CASE WHEN pm.ok THEN r.manager_performance END,'managerScore',CASE WHEN pm.ok THEN r.manager_score END,'finalized',EXISTS(SELECT 1 FROM performance_onehr_result f WHERE f.review_id=r.review_id),'competencyStatus',r.competency_status,'competencyAssigned',jsonb_array_length(r.competencies)>0,'selfCompetencies',CASE WHEN r.competency_status IN ('submitted','reviewed') THEN r.competencies ELSE '[]'::jsonb END,'submittedKpis',CASE WHEN r.results_submitted_at IS NOT NULL AND pm.ok THEN r.kpis ELSE '[]'::jsonb END,'competencies',CASE WHEN r.competency_status='reviewed' THEN r.competencies ELSE '[]'::jsonb END,'principles',coalesce((SELECT jsonb_agg(jsonb_build_object('principle',q.principle,'pct',q.pct)) FROM (SELECT st->>'principle' principle,100*sum(CASE WHEN a.answers->>(st->>'id')='yes' THEN CASE WHEN (st->>'future')::boolean THEN 1.5 ELSE 1 END ELSE 0 END)/nullif(sum(CASE WHEN (st->>'future')::boolean THEN 1.5 ELSE 1 END),0) pct FROM performance_onehr_panel a CROSS JOIN LATERAL jsonb_array_elements(r.statements) st WHERE a.review_id=r.review_id AND a.submitted_at IS NOT NULL AND a.archived_at IS NULL GROUP BY st->>'principle') q),'[]'::jsonb),'leadership',coalesce((SELECT jsonb_agg(jsonb_build_object('score',app.onehr_adjusted_score(a.request_id,(SELECT sum(CASE WHEN a.answers->>(st->>'id')='yes' THEN CASE WHEN (st->>'future')::boolean THEN 1.5 ELSE 1 END ELSE 0 END) FROM jsonb_array_elements(r.statements) st),(SELECT sum(CASE WHEN (st->>'future')::boolean THEN 1.5 ELSE 1 END) FROM jsonb_array_elements(r.statements) st)),'max',(SELECT sum(CASE WHEN (st->>'future')::boolean THEN 1.5 ELSE 1 END) FROM jsonb_array_elements(r.statements) st))) FROM performance_onehr_panel a WHERE a.review_id=r.review_id AND a.submitted_at IS NOT NULL AND a.archived_at IS NULL),'[]'::jsonb))
 FROM performance_onehr_review r JOIN employment e ON e.id=r.employment_id AND e.tenant_id=r.tenant_id JOIN person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
 CROSS JOIN LATERAL (SELECT (app.financial_onehr_result_admin(r.review_id) OR app.onehr_manager(r.review_id) OR EXISTS(SELECT 1 FROM performance_onehr_calibration_entry ce JOIN performance_onehr_calibration cs ON cs.id=ce.session_id WHERE ce.review_id=r.review_id AND (app.financial_onehr_result_admin(r.review_id) OR app.onehr_calibration_reviewer(cs.id,app.current_user_id())) AND NOT app.is_self_person(p.id))) AS ok OFFSET 0) pm
 WHERE r.review_id=wanted_review AND r.tenant_id=app.current_tenant_id() AND NOT app.is_self_person(p.id) AND (pm.ok OR app.onehr_effective_reviewer(r.review_id))
$$;
REVOKE ALL ON FUNCTION app.financial_onehr_native_assessment_inputs(uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.onehr_assessment_inputs(wanted_review uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.financial_onehr_native_assessment_inputs(wanted_review) WHERE app.financial_onehr_named_source_allowed(wanted_review);
$$;
REVOKE ALL ON FUNCTION app.onehr_assessment_inputs(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onehr_assessment_inputs(uuid) TO ai_hr_app;
ALTER FUNCTION app.onehr_decisions(uuid) RENAME TO financial_onehr_native_decisions;
CREATE OR REPLACE FUNCTION app.financial_onehr_native_decisions(wanted_review uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('tier',s.tier,'mode',s.mode,'performance',e.performance,'potential',e.potential,'performanceLocked',app.assessment_calibration_axis_confirmed(s.tier,e.performance_locked_at,s.performance_locked_at),'potentialLocked',app.assessment_calibration_axis_confirmed(s.tier,e.potential_locked_at,s.potential_locked_at),'locked',app.assessment_calibration_axis_confirmed(s.tier,e.locked_at,s.locked_at),'pipConfirmed',s.pip_locked_at IS NOT NULL,'promotionConfirmed',s.promotion_locked_at IS NOT NULL,'pip',coalesce((a.actions->>'pip')::boolean,false),'promotion',coalesce((a.actions->>'promotion')::boolean,false),'specialReward',coalesce((a.actions->>'specialReward')::boolean,false)) ORDER BY CASE s.tier WHEN 'hod' THEN 1 WHEN 'bu' THEN 2 WHEN 'bg' THEN 3 WHEN 'group' THEN 4 ELSE 5 END),'[]'::jsonb)
 FROM performance_onehr_calibration_entry e JOIN performance_onehr_calibration s ON s.id=e.session_id AND s.tenant_id=e.tenant_id JOIN performance_review r ON r.id=e.review_id AND r.tenant_id=e.tenant_id JOIN employment emp ON emp.id=e.employment_id AND emp.tenant_id=e.tenant_id
 LEFT JOIN performance_assessment_talent a ON a.review_id=e.review_id AND a.tenant_id=e.tenant_id
 WHERE e.review_id=wanted_review AND e.tenant_id=app.current_tenant_id() AND NOT app.is_self_person(emp.person_id) AND (app.financial_onehr_result_admin(r.id) OR app.onehr_manager(r.id) OR EXISTS(SELECT 1 FROM performance_onehr_calibration_entry ce WHERE ce.review_id=r.id AND (app.financial_onehr_result_admin(r.id) OR app.onehr_calibration_reviewer(ce.session_id,app.current_user_id()))))
$$;
REVOKE ALL ON FUNCTION app.financial_onehr_native_decisions(uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.onehr_decisions(wanted_review uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN app.financial_onehr_named_source_allowed(wanted_review) THEN app.financial_onehr_native_decisions(wanted_review) ELSE '[]'::jsonb END;
$$;
REVOKE ALL ON FUNCTION app.onehr_decisions(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onehr_decisions(uuid) TO ai_hr_app;
ALTER FUNCTION app.onehr_moderator_choices(uuid) RENAME TO financial_onehr_native_moderator_choices;
REVOKE ALL ON FUNCTION app.financial_onehr_native_moderator_choices(uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.onehr_moderator_choices(wanted_review uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN app.financial_onehr_worker_allowed((SELECT review.cycle_id FROM public.performance_review review WHERE review.id=wanted_review AND review.tenant_id=app.current_tenant_id()),wanted_review,NULL) OR app.onehr_review_header(wanted_review) IS NOT NULL THEN app.financial_onehr_native_moderator_choices(wanted_review) ELSE '[]'::jsonb END;
$$;
REVOKE ALL ON FUNCTION app.onehr_moderator_choices(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onehr_moderator_choices(uuid) TO ai_hr_app;
CREATE OR REPLACE FUNCTION app.assessment_career_access(wanted_employment uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND EXISTS(SELECT 1 FROM public.employment subject WHERE subject.id=wanted_employment AND subject.tenant_id=app.current_tenant_id()
 AND (app.onehr_self_employment(subject.id) OR app.onehr_admin(subject.company_id) AND app.data_permission_matches(subject.id)
 OR EXISTS(SELECT 1 FROM public.performance_onehr_review review JOIN public.review_cycle cycle ON cycle.id=review.cycle_id AND cycle.tenant_id=review.tenant_id
 WHERE review.employment_id=subject.id AND review.tenant_id=subject.tenant_id AND cycle.status IN ('open','calibration') AND (app.onehr_effective_reviewer(review.review_id) OR app.onehr_moderator(review.review_id)))));
$$;
CREATE FUNCTION app.financial_onehr_career_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE admin_course boolean;own_course boolean;placeholder boolean;cycle_status text;
BEGIN
 IF app.access_workforce_storage_owner() THEN RETURN NEW;END IF;
 IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NOT app.principal_snapshot_current() THEN RAISE EXCEPTION 'Career principal unavailable' USING ERRCODE='42501';END IF;
 admin_course:=app.financial_onehr_result_admin(NEW.review_id);own_course:=app.onehr_self_employment(NEW.employment_id);
 SELECT cycle.status::text INTO cycle_status FROM public.performance_review review JOIN public.review_cycle cycle ON cycle.id=review.cycle_id AND cycle.tenant_id=review.tenant_id WHERE review.id=NEW.review_id AND review.tenant_id=NEW.tenant_id AND review.employment_id=NEW.employment_id;
 IF cycle_status IS NULL OR NOT admin_course AND cycle_status NOT IN ('open','calibration') THEN RAISE EXCEPTION 'Career period unavailable' USING ERRCODE='42501';END IF;
 placeholder:=TG_OP='INSERT' AND NOT own_course AND (app.onehr_effective_reviewer(NEW.review_id) OR app.onehr_moderator(NEW.review_id)) AND NEW.career=jsonb_build_object('aspiration','','mobility',NULL,'mobilityNote','','targetProfileId',NULL,'selfProfileId',NULL);
 IF NOT admin_course AND NOT own_course AND NOT placeholder AND (TG_OP='INSERT' OR NEW.career IS DISTINCT FROM OLD.career) THEN RAISE EXCEPTION 'Career administrative data unavailable' USING ERRCODE='42501';END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.financial_onehr_career_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER z_financial_onehr_career_guard BEFORE INSERT OR UPDATE ON public.performance_assessment_career_profile FOR EACH ROW EXECUTE FUNCTION app.financial_onehr_career_guard();

--> statement-breakpoint
-- Administrative deltas use their actual data floor even when the same actor
-- independently sees the row as its subject or assigned reviewer.
CREATE FUNCTION app.financial_onehr_administrative_delta_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE administrative boolean:=false;
BEGIN
 IF app.access_workforce_storage_owner() THEN RETURN NEW;END IF;
 IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NOT app.principal_snapshot_current() THEN RAISE EXCEPTION 'OneHR principal unavailable' USING ERRCODE='42501';END IF;
 IF TG_TABLE_NAME='performance_onehr_plan' THEN
  administrative:=TG_OP='UPDATE' AND OLD.status<>'draft' AND NEW.status='draft';
 ELSE
  IF TG_OP='INSERT' THEN administrative:=true;
  ELSE administrative:=NEW.profile_id IS DISTINCT FROM OLD.profile_id OR NEW.profile_match IS DISTINCT FROM OLD.profile_match OR NEW.statements IS DISTINCT FROM OLD.statements
  OR (SELECT coalesce(jsonb_agg(item-ARRAY['self','selfRemark','manager','managerRemark'] ORDER BY position),'[]'::jsonb) FROM jsonb_array_elements(NEW.competencies) WITH ORDINALITY source(item,position))
   IS DISTINCT FROM (SELECT coalesce(jsonb_agg(item-ARRAY['self','selfRemark','manager','managerRemark'] ORDER BY position),'[]'::jsonb) FROM jsonb_array_elements(OLD.competencies) WITH ORDINALITY source(item,position));END IF;
  IF TG_OP='UPDATE' AND NEW.kpis IS DISTINCT FROM OLD.kpis THEN
   administrative:=administrative OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.kpis) current_kpi
    LEFT JOIN LATERAL (SELECT previous FROM jsonb_array_elements(OLD.kpis) previous WHERE previous->>'id'=current_kpi->>'id') old_kpi ON true
    WHERE (current_kpi->>'moderatorSource'='matrix' AND (current_kpi->>'moderatorSource' IS DISTINCT FROM old_kpi.previous->>'moderatorSource' OR current_kpi->>'moderatorEmploymentId' IS DISTINCT FROM old_kpi.previous->>'moderatorEmploymentId'))
    OR coalesce((current_kpi->>'hrOwned')::boolean,false) IS DISTINCT FROM coalesce((old_kpi.previous->>'hrOwned')::boolean,false))
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(OLD.kpis) previous WHERE coalesce((previous->>'hrOwned')::boolean,false) AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.kpis) current_kpi WHERE current_kpi->>'id'=previous->>'id' AND current_kpi=previous));
  END IF;
 END IF;
 IF administrative AND NOT app.financial_onehr_result_admin(NEW.review_id) THEN RAISE EXCEPTION 'OneHR administrative data unavailable' USING ERRCODE='42501';END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.financial_onehr_administrative_delta_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER z_financial_onehr_administrative_delta_guard BEFORE INSERT OR UPDATE ON public.performance_onehr_review FOR EACH ROW EXECUTE FUNCTION app.financial_onehr_administrative_delta_guard();
CREATE TRIGGER z_financial_onehr_administrative_delta_guard BEFORE UPDATE ON public.performance_onehr_plan FOR EACH ROW EXECUTE FUNCTION app.financial_onehr_administrative_delta_guard();

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.assessment_pending_work(wanted_cycle uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH cycle AS MATERIALIZED (
  SELECT c.*,cfg.policy FROM review_cycle c JOIN performance_onehr_cycle cfg ON cfg.cycle_id=c.id AND cfg.tenant_id=c.tenant_id
  WHERE c.id=wanted_cycle AND c.tenant_id=app.current_tenant_id() AND c.status IN ('open','calibration')
   AND (app.financial_onehr_worker_allowed(wanted_cycle,NULL,NULL) OR app.principal_snapshot_current() AND app.onehr_cycle_admin(c.id))
 ), reviews AS MATERIALIZED (
  SELECT r.*,p.reviewer_employment_id,p.closed_at,e.person_id,person.full_name,
   (SELECT coalesce(jsonb_agg(mc ORDER BY mc->>'id'),'[]'::jsonb) FROM jsonb_array_elements(app.onehr_moderator_choices(r.review_id)) mc WHERE NOT app.assessment_unit_excluded(r.cycle_id,(mc->>'id')::uuid)) AS moderators,
   CASE WHEN app.assessment_unit_excluded(r.cycle_id,p.reviewer_employment_id) THEN app.onehr_effective_reviewer_of(r.review_id) ELSE p.reviewer_employment_id END AS effective_reviewer_employment_id,
   EXISTS(SELECT 1 FROM performance_onehr_result f WHERE f.review_id=r.review_id AND f.tenant_id=r.tenant_id) AS frozen
  FROM cycle c JOIN performance_onehr_review r ON r.cycle_id=c.id AND r.tenant_id=c.tenant_id
  JOIN performance_review p ON p.id=r.review_id AND p.tenant_id=r.tenant_id
  JOIN employment e ON e.id=r.employment_id AND e.tenant_id=r.tenant_id JOIN person ON person.id=e.person_id AND person.tenant_id=e.tenant_id
  WHERE app.assessment_review_participates(r.review_id) AND (app.financial_onehr_worker_allowed(wanted_cycle,NULL,NULL) OR app.onehr_admin(r.company_id) AND app.data_permission_matches(r.employment_id))
 ), panels AS MATERIALIZED (
  SELECT p.request_id,p.peer_employment_id,p.review_id FROM performance_onehr_panel p JOIN reviews r ON r.review_id=p.review_id AND r.tenant_id=p.tenant_id
  WHERE p.archived_at IS NULL AND p.submitted_at IS NULL AND NOT r.frozen AND r.closed_at IS NULL
 ), sessions AS MATERIALIZED (
  SELECT s.* FROM cycle c JOIN performance_onehr_calibration s ON s.cycle_id=c.id AND s.tenant_id=c.tenant_id
  WHERE app.financial_onehr_worker_allowed(wanted_cycle,NULL,NULL) OR app.onehr_admin(s.company_id) AND NOT EXISTS(SELECT 1 FROM public.performance_onehr_calibration_entry protected WHERE protected.session_id=s.id AND protected.tenant_id=s.tenant_id AND NOT app.data_permission_matches(protected.employment_id))
 ), candidates AS (
  SELECT employment_id AS id FROM reviews UNION SELECT effective_reviewer_employment_id FROM reviews
  UNION SELECT (m->>'id')::uuid FROM reviews r CROSS JOIN LATERAL jsonb_array_elements(r.moderators) m
  UNION SELECT peer_employment_id FROM panels
  UNION SELECT e.id FROM sessions s CROSS JOIN LATERAL unnest(s.reviewer_user_ids||app.onehr_calibration_seat_users(s.id)) uid
   JOIN app_user u ON u.id=uid AND u.tenant_id=s.tenant_id JOIN employment e ON e.person_id=u.person_id AND e.tenant_id=u.tenant_id
 ), actors AS MATERIALIZED (
  SELECT u.id,u.person_id,p.full_name,array_agg(e.id ORDER BY e.id) AS employment_ids,
   app.assessment_admin_for(u.id,(SELECT company_id FROM cycle)) AS cycle_admin
  FROM app_user u JOIN person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id JOIN employment e ON e.person_id=p.id AND e.tenant_id=p.tenant_id
  WHERE u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
   AND e.blacklisted_at IS NULL AND (LEAST(e.resignation_date,e.last_working_date,e.terminated_on) IS NULL OR (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date<=LEAST(e.resignation_date,e.last_working_date,e.terminated_on))
   AND EXISTS(SELECT 1 FROM candidates candidate WHERE candidate.id=e.id)
  GROUP BY u.id,u.person_id,p.full_name
 )
 SELECT jsonb_build_object(
  'cycle',jsonb_build_object('id',c.id,'companyId',c.company_id,'name',c.name,'periodEnd',c.period_end,'policy',jsonb_build_object('kind',c.policy->'kind','modules',c.policy->'modules','windows',c.policy->'windows')),
  'actors',coalesce((SELECT jsonb_agg(jsonb_build_object('userId',a.id,'personId',a.person_id,'name',a.full_name,'employmentIds',a.employment_ids,'cycleAdmin',a.cycle_admin) ORDER BY a.id) FROM actors a),'[]'::jsonb),
  'reviews',coalesce((SELECT jsonb_agg(jsonb_build_object('id',r.review_id,'companyId',r.company_id,'employmentId',r.employment_id,'personId',r.person_id,'name',r.full_name,'reviewerEmploymentId',r.effective_reviewer_employment_id,'moderatorIds',(SELECT coalesce(jsonb_agg(m->'id' ORDER BY m->>'id'),'[]'::jsonb) FROM jsonb_array_elements(r.moderators) m),'frozen',r.frozen OR r.closed_at IS NOT NULL,
   'facts',jsonb_build_object('competenciesAssigned',jsonb_array_length(r.competencies)>0,'competencyStatus',r.competency_status,'resultsSubmitted',r.results_submitted_at IS NOT NULL,'managerPerformance',r.manager_performance,
    'planStatus',(SELECT p.status FROM performance_onehr_plan p WHERE p.tenant_id=r.tenant_id AND p.employment_id=r.employment_id AND p.plan_year=extract(year from c.period_end)::integer+CASE WHEN c.policy->>'kind'='year_end' THEN 1 ELSE 0 END),
    'kpis',(SELECT coalesce(jsonb_agg(jsonb_build_object('hrOwned',coalesce((k->>'hrOwned')::boolean,false),'setting',k->'setting','locked',k->'locked','moderatorEmploymentId',k->'moderatorEmploymentId','checkIn',k->'checkIn' IS NOT NULL AND k->'checkIn'<>'null'::jsonb,
     'approvalChain',(SELECT coalesce(jsonb_agg(jsonb_build_object('employmentId',step->'employmentId','at',step->'at') ORDER BY i),'[]'::jsonb) FROM jsonb_array_elements(coalesce(k->'approvalChain','[]'::jsonb)) WITH ORDINALITY q(step,i)),
     'settingApprovals',(SELECT coalesce(jsonb_agg(jsonb_build_object('action',step->'action') ORDER BY i),'[]'::jsonb) FROM jsonb_array_elements(coalesce(k->'settingApprovals','[]'::jsonb)) WITH ORDINALITY q(step,i))) ORDER BY i),'[]'::jsonb) FROM jsonb_array_elements(r.kpis) WITH ORDINALITY q(k,i)))) ORDER BY r.review_id) FROM reviews r),'[]'::jsonb),
  'panels',coalesce((SELECT jsonb_agg(jsonb_build_object('id',p.request_id,'employmentId',p.peer_employment_id,'reviewId',p.review_id) ORDER BY p.request_id) FROM panels p),'[]'::jsonb),
  'sessions',coalesce((SELECT jsonb_agg(jsonb_build_object('id',s.id,'companyId',s.company_id,'tier',s.tier,'reviewerUserIds',(SELECT coalesce(jsonb_agg(ru.uid ORDER BY ru.uid),'[]'::jsonb) FROM (SELECT DISTINCT uid FROM unnest(s.reviewer_user_ids||app.onehr_calibration_seat_users(s.id)) uid) ru WHERE app.onehr_calibration_reviewer(s.id,ru.uid)),'adminUserIds',(SELECT coalesce(jsonb_agg(a.id ORDER BY a.id),'[]'::jsonb) FROM actors a WHERE app.assessment_admin_for(a.id,s.company_id)),
   'lockedAt',s.locked_at,'performanceLockedAt',s.performance_locked_at,'potentialLockedAt',s.potential_locked_at,
   'entries',app.assessment_calibration_work(s.id)) ORDER BY s.id) FROM sessions s),'[]'::jsonb)) FROM cycle c
$$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.financial_onehr_native_moderator_choices(wanted_review uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',m.id,'name',p.full_name,'personId',m.person_id)),'[]'::jsonb) FROM performance_review r JOIN employment sub ON sub.id=r.employment_id AND sub.tenant_id=r.tenant_id JOIN employment m ON m.tenant_id=r.tenant_id JOIN person p ON p.id=m.person_id WHERE r.id=wanted_review AND r.tenant_id=app.current_tenant_id() AND (app.onehr_review_header(r.id) IS NOT NULL OR app.financial_onehr_result_admin(r.id) OR app.financial_onehr_worker_allowed(r.cycle_id,r.id,NULL)) AND sub.person_id<>m.person_id AND (m.terminated_on IS NULL OR m.terminated_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) AND (EXISTS(SELECT 1 FROM performance_onehr_review rr, jsonb_array_elements(rr.kpis) k WHERE rr.review_id=r.id AND k->>'moderatorSource'='matrix' AND k->>'moderatorEmploymentId'=m.id::text) OR m.id=r.reviewer_employment_id OR EXISTS(SELECT 1 FROM reporting_line l WHERE l.subordinate_employment_id=sub.id AND l.manager_employment_id=m.id AND l.line_type IN ('functional','project','dotted') AND l.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (l.valid_to IS NULL OR l.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) AND l.superseded_at IS NULL))
$$;

CREATE FUNCTION app.onehr_reminder_cooldowns(p_cycle uuid,p_users uuid[],p_except uuid DEFAULT NULL) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH graph AS MATERIALIZED (SELECT app.assessment_pending_work(p_cycle) AS value),actors AS (
 SELECT (actor->>'userId')::uuid AS id FROM graph CROSS JOIN LATERAL jsonb_array_elements(coalesce(graph.value->'actors','[]'::jsonb)) actor)
 SELECT coalesce(array_agg(DISTINCT recipient.user_id),'{}'::uuid[]) FROM public.performance_assessment_reminder_recipient recipient
 JOIN actors ON actors.id=recipient.user_id JOIN public.performance_assessment_reminder_run run ON run.id=recipient.run_id AND run.tenant_id=recipient.tenant_id
 LEFT JOIN public.notification_delivery delivery ON delivery.source_event_id=recipient.source_event_id AND delivery.recipient_user_id=recipient.user_id AND delivery.channel='email'
 WHERE recipient.tenant_id=app.current_tenant_id() AND run.cycle_id=p_cycle AND recipient.user_id=ANY(p_users) AND (p_except IS NULL OR recipient.id<>p_except)
 AND (delivery.status='sent' AND delivery.sent_at>now()-interval '20 hours' OR delivery.status='pending' OR delivery.last_error='uncertain' OR recipient.outcome='queued' AND delivery.id IS NULL AND recipient.created_at>now()-interval '20 hours');
$$;
REVOKE ALL ON FUNCTION app.onehr_reminder_cooldowns(uuid,uuid[],uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onehr_reminder_cooldowns(uuid,uuid[],uuid) TO ai_hr_app;

--> statement-breakpoint
ALTER FUNCTION app.onehr_reminder_dispatch_source(uuid) RENAME TO financial_onehr_dispatch_source_native;
REVOKE ALL ON FUNCTION app.financial_onehr_dispatch_source_native(uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.onehr_reminder_dispatch_source(p_recipient uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE opened boolean;source jsonb;
BEGIN
 opened:=app.financial_onehr_recipient_context_begin(p_recipient,false,false);
 source:=app.financial_onehr_dispatch_source_native(p_recipient);
 IF opened THEN PERFORM app.financial_onehr_recipient_context_end(p_recipient);END IF;
 RETURN source;
END;
$$;
REVOKE ALL ON FUNCTION app.onehr_reminder_dispatch_source(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onehr_reminder_dispatch_source(uuid) TO ai_hr_app;
ALTER FUNCTION app.onehr_reminder_dispatch_update(uuid,jsonb,text,jsonb,jsonb,timestamptz,bigint,bigint,uuid[]) RENAME TO financial_onehr_dispatch_update_native;
REVOKE ALL ON FUNCTION app.financial_onehr_dispatch_update_native(uuid,jsonb,text,jsonb,jsonb,timestamptz,bigint,bigint,uuid[]) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.onehr_reminder_dispatch_update(p_recipient uuid,p_expected jsonb,p_outcome text,p_tasks jsonb,p_words jsonb,p_until timestamptz,p_tenant_epoch bigint,p_cycle_epoch bigint,p_review_ids uuid[] DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE opened boolean;changed boolean;
BEGIN
 IF nullif(current_setting('app.agent_principal_id',true),'') IS NOT NULL THEN RAISE EXCEPTION 'OneHR worker principal unavailable' USING ERRCODE='42501';END IF;
 IF app.current_agent_principal() IS NOT NULL THEN RAISE EXCEPTION 'OneHR worker principal unavailable' USING ERRCODE='42501';END IF;
 opened:=app.financial_onehr_recipient_context_begin(p_recipient,true,false);
 changed:=app.financial_onehr_dispatch_update_native(p_recipient,p_expected,p_outcome,p_tasks,p_words,p_until,p_tenant_epoch,p_cycle_epoch,p_review_ids);
 IF opened THEN PERFORM app.financial_onehr_recipient_context_end(p_recipient);END IF;
 RETURN changed;
END;
$$;
REVOKE ALL ON FUNCTION app.onehr_reminder_dispatch_update(uuid,jsonb,text,jsonb,jsonb,timestamptz,bigint,bigint,uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onehr_reminder_dispatch_update(uuid,jsonb,text,jsonb,jsonb,timestamptz,bigint,bigint,uuid[]) TO ai_hr_app;
ALTER FUNCTION app.onehr_reminder_cooldowns(uuid,uuid[],uuid) RENAME TO financial_onehr_cooldowns_native;
REVOKE ALL ON FUNCTION app.financial_onehr_cooldowns_native(uuid,uuid[],uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.onehr_reminder_cooldowns(p_cycle uuid,p_users uuid[],p_except uuid DEFAULT NULL) RETURNS uuid[]
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE users uuid[];result uuid[];
BEGIN
 SELECT coalesce(array_agg((actor->>'userId')::uuid),'{}'::uuid[]) INTO users FROM jsonb_array_elements(coalesce(app.assessment_pending_work(p_cycle)->'actors','[]'::jsonb)) actor WHERE (actor->>'userId')::uuid=ANY(p_users);
 IF cardinality(users)=0 THEN RETURN '{}'::uuid[];END IF;
 INSERT INTO app.financial_onehr_source_context(transaction_id,tenant_id,session_login,scope_key,mode,cycle_id,user_ids)
 VALUES(pg_current_xact_id(),app.current_tenant_id(),session_user,'cooldown:'||p_cycle,'cooldown',p_cycle,users);
 result:=app.financial_onehr_cooldowns_native(p_cycle,users,p_except);
 DELETE FROM app.financial_onehr_source_context scope WHERE scope.transaction_id=pg_current_xact_id() AND scope.tenant_id=app.current_tenant_id() AND scope.session_login=session_user AND scope.scope_key='cooldown:'||p_cycle;
 RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION app.onehr_reminder_cooldowns(uuid,uuid[],uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onehr_reminder_cooldowns(uuid,uuid[],uuid) TO ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.financial_onehr_prepared_current(t uuid,r uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app.financial_onehr_prepared_source sealed JOIN public.performance_assessment_reminder_recipient recipient ON recipient.id=sealed.recipient_id AND recipient.tenant_id=sealed.tenant_id AND recipient.user_id=sealed.user_id
 JOIN public.performance_assessment_reminder_run run ON run.id=recipient.run_id AND run.tenant_id=recipient.tenant_id AND run.cycle_id=sealed.cycle_id
 WHERE sealed.tenant_id=t AND sealed.recipient_id=r AND sealed.prepared_at=recipient.prepared_at AND sealed.prepared_until=recipient.prepared_until AND sealed.prepared_until>now()
 AND sealed.tasks_hash=encode(sha256(convert_to(jsonb_build_object('tasks',recipient.tasks,'words',recipient.mail_words)::text,'UTF8')),'hex')
 AND NOT EXISTS(SELECT 1 FROM unnest(sealed.review_ids) source(id) WHERE NOT app.financial_onehr_target_task_view(sealed.tenant_id,sealed.user_id,source.id)));
$$;
REVOKE ALL ON FUNCTION app.financial_onehr_prepared_current(uuid,uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.financial_onehr_relay_begin(p_delivery uuid,p_token uuid,p_issuer text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid;r uuid;u uuid;e uuid;parent uuid;cycle uuid;
BEGIN
 SELECT delivery.tenant_id,event.aggregate_id,target.user_id,event.id INTO t,r,u,e FROM public.notification_delivery delivery
 JOIN identity_email.delivery_target(p_delivery,p_token,p_issuer) target ON target.user_id=delivery.recipient_user_id
 JOIN public.domain_event event ON event.id=delivery.source_event_id AND event.tenant_id=delivery.tenant_id AND event.event_type='assessment.reminder-queued' AND event.aggregate_type='assessment-reminder'
 WHERE delivery.id=p_delivery;
 IF t IS NULL THEN RETURN NULL;END IF;
 INSERT INTO app.financial_onehr_source_context(transaction_id,tenant_id,session_login,scope_key,mode,recipient_id,user_ids,event_id)
 VALUES(pg_current_xact_id(),t,session_user,'relay:'||p_delivery,'relay',r,ARRAY[u],e);
 SELECT recipient.run_id INTO parent FROM public.performance_assessment_reminder_recipient recipient WHERE recipient.id=r AND recipient.tenant_id=t AND recipient.user_id=u AND recipient.source_event_id=e;
 UPDATE app.financial_onehr_source_context scope SET run_id=parent WHERE scope.transaction_id=pg_current_xact_id() AND scope.tenant_id=t AND scope.session_login=session_user AND scope.scope_key='relay:'||p_delivery;
 SELECT run.cycle_id INTO cycle FROM public.performance_assessment_reminder_run run WHERE run.id=parent AND run.tenant_id=t;
 UPDATE app.financial_onehr_source_context scope SET cycle_id=cycle WHERE scope.transaction_id=pg_current_xact_id() AND scope.tenant_id=t AND scope.session_login=session_user AND scope.scope_key='relay:'||p_delivery;
 IF parent IS NULL OR cycle IS NULL THEN
  DELETE FROM app.financial_onehr_source_context scope WHERE scope.transaction_id=pg_current_xact_id() AND scope.tenant_id=t AND scope.session_login=session_user AND scope.scope_key='relay:'||p_delivery;RETURN NULL;
 END IF;
 RETURN t;
END;
$$;
REVOKE ALL ON FUNCTION app.financial_onehr_relay_begin(uuid,uuid,text) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.financial_onehr_relay_end(t uuid,p_delivery uuid) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 DELETE FROM app.financial_onehr_source_context scope WHERE scope.transaction_id=pg_current_xact_id() AND scope.tenant_id=t AND scope.session_login=session_user AND scope.scope_key='relay:'||p_delivery;
$$;
REVOKE ALL ON FUNCTION app.financial_onehr_relay_end(uuid,uuid) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION identity_email.assessment_tasks(p_id uuid,p_token uuid,p_issuer text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE bound_tenant uuid;payload jsonb;
 prior_tenant text:=coalesce(current_setting('app.tenant_id',true),'');
 prior_user text:=coalesce(current_setting('app.user_id',true),'');
 prior_roles text:=coalesce(current_setting('app.roles',true),'');
 prior_grants text:=coalesce(current_setting('app.grants',true),'');
BEGIN
 bound_tenant:=app.financial_onehr_relay_begin(p_id,p_token,p_issuer);
 IF bound_tenant IS NULL THEN RETURN NULL;END IF;
 PERFORM set_config('app.tenant_id',bound_tenant::text,true),set_config('app.user_id','',true),
  set_config('app.roles','',true),set_config('app.grants','[]',true);

 SELECT jsonb_build_object('tasks',r.tasks,'words',r.mail_words) INTO payload FROM notification_delivery d
 JOIN identity_email.delivery_target(p_id,p_token,p_issuer) target ON target.user_id=d.recipient_user_id
 JOIN domain_event ev ON ev.id=d.source_event_id AND ev.tenant_id=d.tenant_id AND ev.event_type='assessment.reminder-queued'
 JOIN performance_assessment_reminder_recipient r ON r.source_event_id=ev.id AND r.id=ev.aggregate_id AND r.tenant_id=d.tenant_id AND r.user_id=target.user_id
 JOIN performance_assessment_reminder_run run ON run.id=r.run_id AND run.tenant_id=r.tenant_id
 JOIN review_cycle c ON c.id=run.cycle_id AND c.tenant_id=run.tenant_id AND c.status IN ('open','calibration')
 WHERE d.id=p_id AND r.outcome='queued' AND r.prepared_until>now() AND r.prepared_at>now()-interval '60 seconds'
 AND r.tenant_epoch=coalesce((SELECT revision FROM performance_assessment_reminder_epoch WHERE tenant_id=r.tenant_id AND scope_id='00000000-0000-0000-0000-000000000000'),0)
 AND r.cycle_epoch=coalesce((SELECT revision FROM performance_assessment_reminder_epoch WHERE tenant_id=r.tenant_id AND scope_id=c.id),0)
 AND app.financial_onehr_prepared_current(r.tenant_id,r.id) AND jsonb_array_length(r.tasks)>0 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.tasks) task WHERE task->>'closesAt' IS NOT NULL AND (task->>'closesAt')::timestamptz<=now())
;
 PERFORM app.financial_onehr_relay_end(bound_tenant,p_id);
 PERFORM set_config('app.tenant_id',prior_tenant,true),set_config('app.user_id',prior_user,true),
  set_config('app.roles',prior_roles,true),set_config('app.grants',prior_grants,true);
 RETURN payload;
EXCEPTION WHEN OTHERS THEN
 RAISE;
END $$;
REVOKE ALL ON FUNCTION identity_email.assessment_tasks(uuid,uuid,text) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
-- This narrow context exists only inside the finite native port, and is erased
-- before it returns. It never makes a NULL-role caller a data-profile principal.
ALTER POLICY data_permission_subject_read ON public.performance_assessment_reminder_recipient
 USING(employment_id IS NULL OR app.data_permission_record_read(employment_id) OR app.onehr_reminder_source_recipient_read(tenant_id,id,run_id,user_id,source_event_id));

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.assessment_review_participates(wanted_review uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM performance_review r JOIN review_cycle c ON c.id=r.cycle_id AND c.tenant_id=r.tenant_id
  JOIN employment e ON e.id=r.employment_id AND e.tenant_id=r.tenant_id
  JOIN performance_assessment_participation p ON p.cycle_id=r.cycle_id AND p.employment_id=r.employment_id AND p.tenant_id=r.tenant_id
  WHERE r.id=wanted_review AND r.tenant_id=app.current_tenant_id()
   AND (c.status='closed' OR e.terminated_on IS NULL OR e.terminated_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
   AND (NOT (EXISTS(SELECT 1 FROM performance_assessment_unit_exclusion x WHERE x.tenant_id=r.tenant_id AND x.cycle_id=r.cycle_id AND x.ended_at IS NULL) OR EXISTS(SELECT 1 FROM performance_assessment_unit_exclusion_pin xp WHERE xp.tenant_id=r.tenant_id AND xp.cycle_id=r.cycle_id))
    OR NOT app.assessment_unit_excluded(r.cycle_id,r.employment_id) OR EXISTS(SELECT 1 FROM performance_onehr_result f WHERE f.review_id=r.id AND f.tenant_id=r.tenant_id))
   AND CASE WHEN p.override='add' THEN true WHEN p.override='remove' THEN false ELSE p.eligible_at_open END
   AND (app.financial_onehr_worker_allowed(r.cycle_id,r.id,NULL) OR app.can_see_employment(e.id) OR app.onehr_cycle_admin(r.cycle_id) OR app.onehr_manager(r.id)
    OR (EXISTS(SELECT 1 FROM performance_assessment_unit_exclusion x WHERE x.tenant_id=r.tenant_id AND x.cycle_id=r.cycle_id AND x.ended_at IS NULL) OR EXISTS(SELECT 1 FROM performance_assessment_unit_exclusion_pin xp WHERE xp.tenant_id=r.tenant_id AND xp.cycle_id=r.cycle_id)) AND app.onehr_effective_reviewer(r.id)
    OR app.onehr_moderator(r.id)
    OR EXISTS(SELECT 1 FROM performance_onehr_panel panel JOIN employment peer ON peer.id=panel.peer_employment_id AND peer.tenant_id=panel.tenant_id JOIN app_user actor ON actor.person_id=peer.person_id AND actor.tenant_id=peer.tenant_id WHERE panel.review_id=r.id AND panel.tenant_id=r.tenant_id AND panel.archived_at IS NULL AND actor.id=app.current_user_id() AND actor.archived_at IS NULL AND NOT app.login_blocked(actor.id) AND (peer.terminated_on IS NULL OR peer.terminated_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date))
    OR EXISTS(SELECT 1 FROM performance_onehr_calibration_entry ce WHERE ce.review_id=r.id AND ce.tenant_id=r.tenant_id AND app.onehr_calibration_access(ce.session_id))))
$$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.onehr_calibration_reviewer(wanted_session uuid, wanted_user uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM performance_onehr_calibration s JOIN app_user u ON u.id=wanted_user AND u.tenant_id=s.tenant_id
  WHERE s.id=wanted_session AND s.tenant_id=app.current_tenant_id() AND s.tier<>'final'
   AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
   AND (u.id=app.current_user_id() OR app.financial_onehr_worker_allowed(s.cycle_id,NULL,NULL) OR app.onehr_admin(s.company_id))
   AND (u.id=ANY(s.reviewer_user_ids) AND (NOT (EXISTS(SELECT 1 FROM performance_assessment_unit_exclusion x WHERE x.tenant_id=s.tenant_id AND x.cycle_id=s.cycle_id AND x.ended_at IS NULL) OR EXISTS(SELECT 1 FROM performance_assessment_unit_exclusion_pin xp WHERE xp.tenant_id=s.tenant_id AND xp.cycle_id=s.cycle_id))
     OR NOT app.onehr_user_unit_excluded(s.cycle_id,u.id)) OR u.id=ANY(app.onehr_calibration_seat_users(s.id))))
$$;

--> statement-breakpoint
-- Routing facts under FORCE RLS are visible only during the bounded graph owner.
ALTER TABLE app.financial_onehr_source_context ADD COLUMN session_ids uuid[];
CREATE FUNCTION app.onehr_reminder_graph_fact_read(t uuid,kind text,row_data jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app.financial_onehr_source_context scope JOIN public.performance_onehr_calibration session ON session.id=ANY(scope.session_ids) AND session.tenant_id=scope.tenant_id
 WHERE scope.transaction_id=pg_current_xact_id() AND scope.tenant_id=t AND scope.session_login=session_user AND scope.mode='graph'
 AND CASE kind
 WHEN 'group' THEN session.calibration_group_id=(row_data->>'id')::uuid
 WHEN 'groupMember' THEN session.calibration_group_id=(row_data->>'group_id')::uuid
 WHEN 'seat' THEN session.anchor_kind=row_data->>'seat_type' AND (session.anchor_kind='group_chief' AND session.calibration_group_id=(row_data->>'calibration_group_id')::uuid OR session.anchor_kind IN ('bu_ceo','bg_ceo') AND session.company_id=(row_data->>'company_id')::uuid)
 WHEN 'hod' THEN EXISTS(SELECT 1 FROM public.performance_onehr_calibration_entry entry WHERE entry.session_id=session.id AND entry.tenant_id=t AND entry.employment_id=(row_data->>'subject_employment_id')::uuid)
 ELSE false END);
$$;
REVOKE ALL ON FUNCTION app.onehr_reminder_graph_fact_read(uuid,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onehr_reminder_graph_fact_read(uuid,text,jsonb) TO ai_hr_app;
CREATE POLICY financial_onehr_group_source ON public.performance_calibration_group FOR SELECT USING(app.onehr_reminder_graph_fact_read(tenant_id,'group',to_jsonb(performance_calibration_group.*)));
CREATE POLICY financial_onehr_group_member_source ON public.performance_calibration_group_member FOR SELECT USING(app.onehr_reminder_graph_fact_read(tenant_id,'groupMember',to_jsonb(performance_calibration_group_member.*)));
CREATE POLICY financial_onehr_seat_source ON public.performance_leader_seat FOR SELECT USING(app.onehr_reminder_graph_fact_read(tenant_id,'seat',to_jsonb(performance_leader_seat.*)));
CREATE POLICY financial_onehr_hod_source ON public.performance_hod_assignment FOR SELECT USING(app.onehr_reminder_graph_fact_read(tenant_id,'hod',to_jsonb(performance_hod_assignment.*)));
ALTER FUNCTION app.assessment_pending_work(uuid) RENAME TO financial_onehr_pending_work_native;
REVOKE ALL ON FUNCTION app.financial_onehr_pending_work_native(uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.assessment_pending_work(wanted_cycle uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE sessions uuid[];value jsonb;worker boolean;
BEGIN
 worker:=app.financial_onehr_worker_allowed(wanted_cycle,NULL,NULL);
 IF NOT worker AND NOT(app.principal_snapshot_current() AND app.onehr_cycle_admin(wanted_cycle)) THEN RETURN NULL;END IF;
 SELECT coalesce(array_agg(session.id),'{}'::uuid[]) INTO sessions FROM public.performance_onehr_calibration session
 WHERE session.cycle_id=wanted_cycle AND session.tenant_id=app.current_tenant_id()
 AND CASE WHEN worker THEN true ELSE app.onehr_admin(session.company_id) AND NOT EXISTS(SELECT 1 FROM public.performance_onehr_calibration_entry protected WHERE protected.session_id=session.id AND protected.tenant_id=session.tenant_id AND NOT app.data_permission_matches(protected.employment_id)) END;
 INSERT INTO app.financial_onehr_source_context(transaction_id,tenant_id,session_login,scope_key,mode,cycle_id,session_ids)
 VALUES(pg_current_xact_id(),app.current_tenant_id(),session_user,'graph:'||wanted_cycle,'graph',wanted_cycle,sessions);
 value:=app.financial_onehr_pending_work_native(wanted_cycle);
 DELETE FROM app.financial_onehr_source_context scope WHERE scope.transaction_id=pg_current_xact_id() AND scope.tenant_id=app.current_tenant_id() AND scope.session_login=session_user AND scope.scope_key='graph:'||wanted_cycle;
 RETURN value;
END;
$$;
REVOKE ALL ON FUNCTION app.assessment_pending_work(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assessment_pending_work(uuid) TO ai_hr_app;

CREATE OR REPLACE FUNCTION app.assessment_unit_out(wanted_cycle uuid,wanted_employment uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT (app.financial_onehr_worker_allowed(wanted_cycle,NULL,NULL) OR app.onehr_cycle_admin(wanted_cycle)
 OR EXISTS(SELECT 1 FROM app.financial_onehr_worker_source proof JOIN public.performance_review review ON review.id=proof.review_id AND review.tenant_id=proof.tenant_id AND review.cycle_id=proof.cycle_id
 WHERE proof.transaction_id=pg_current_xact_id() AND proof.tenant_id=app.current_tenant_id() AND proof.session_login=session_user AND proof.cycle_id=wanted_cycle
 AND app.financial_onehr_worker_allowed(wanted_cycle,review.id,NULL)
 AND (review.employment_id=wanted_employment OR app.financial_onehr_effective_reviewer_of(review.tenant_id,review.id,NULL,NULL)=wanted_employment OR EXISTS(SELECT 1 FROM jsonb_array_elements(app.onehr_moderator_choices(review.id)) choice WHERE choice->>'id'=wanted_employment::text))))
 AND app.assessment_unit_excluded(wanted_cycle,wanted_employment);
$$;

--> statement-breakpoint
ALTER POLICY data_permission_subject_read ON public.performance_calibration_group_member
 USING(employment_id IS NULL OR app.data_permission_record_read(employment_id) OR app.onehr_reminder_graph_fact_read(tenant_id,'groupMember',to_jsonb(performance_calibration_group_member.*)));

--> statement-breakpoint
-- A task reader receives the native fields for its actual course. Raw subject
-- storage retains the ordinary data-profile policy and cannot be used as a fallback.
CREATE FUNCTION app.onehr_review_task_fields(wanted_review uuid) RETURNS SETOF public.performance_onehr_review
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source public.performance_onehr_review%ROWTYPE;projected jsonb;own boolean;administrator boolean;manager boolean;moderator boolean;reviewer boolean;own_ids uuid[];
BEGIN
 IF app.onehr_review_task_header(wanted_review) IS NULL THEN RETURN;END IF;
 SELECT * INTO source FROM public.performance_onehr_review actual WHERE actual.review_id=wanted_review AND actual.tenant_id=app.current_tenant_id();IF source.review_id IS NULL THEN RETURN;END IF;
 own:=app.onehr_self_employment(source.employment_id);administrator:=NOT own AND app.financial_onehr_result_admin(source.review_id);
 manager:=NOT own AND app.onehr_manager(source.review_id);moderator:=NOT own AND NOT manager AND app.onehr_moderator(source.review_id);reviewer:=NOT own AND NOT manager AND app.onehr_effective_reviewer(source.review_id);
 SELECT coalesce(array_agg(employment.id),'{}'::uuid[]) INTO own_ids FROM public.employment employment JOIN public.app_user account ON account.person_id=employment.person_id AND account.tenant_id=employment.tenant_id WHERE account.id=app.current_user_id() AND account.tenant_id=source.tenant_id;
 SELECT jsonb_object_agg(field.key,field.value) INTO projected FROM jsonb_each(to_jsonb(source)) field WHERE field.key=ANY(ARRAY[
 'review_id','tenant_id','cycle_id','employment_id','company_id','grade','kpis','competencies','statements','profile_id','profile_match','results_submitted_at','competency_status',
 'manager_performance','manager_score','manager_remark','self_remark','manager_remark_by_user_id','competency_self_sections','competency_manager_sections','competency_self_remark','competency_manager_remark','submitted_proof','revision','created_at']);
 IF (moderator OR reviewer) AND NOT administrator THEN
  projected:=projected||jsonb_build_object('kpis',(SELECT coalesce(jsonb_agg(kpi ORDER BY position),'[]'::jsonb) FROM jsonb_array_elements(source.kpis) WITH ORDINALITY item(kpi,position)
   WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_array_length(coalesce(kpi->'approvalChain','[]'::jsonb))>0 THEN kpi->'approvalChain' ELSE jsonb_build_array(jsonb_build_object('employmentId',kpi->>'moderatorEmploymentId')) END) step WHERE (step->>'employmentId')::uuid=ANY(own_ids))),
   'manager_performance',NULL,'manager_score',NULL,'manager_remark','','manager_remark_by_user_id',NULL,'self_remark','','submitted_proof','[]'::jsonb);
 END IF;
 IF moderator AND NOT reviewer AND NOT administrator THEN projected:=projected||jsonb_build_object('competencies','[]'::jsonb,'statements','[]'::jsonb,'competency_self_sections','{}'::jsonb,'competency_manager_sections','{}'::jsonb,'competency_self_remark','','competency_manager_remark','');END IF;
 RETURN QUERY SELECT (jsonb_populate_record(NULL::public.performance_onehr_review,projected)).*;
END;
$$;
REVOKE ALL ON FUNCTION app.onehr_review_task_fields(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onehr_review_task_fields(uuid) TO ai_hr_app;

-- Unapplied BOARD setup owner. Tenant catalogues are distinct from company payroll operations.
INSERT INTO public.access_capability(id,scope,supported,bindings)
 SELECT 'payroll_configuration.'||operation,'tenant',false,'[]'::jsonb FROM unnest(ARRAY['view','add','edit','delete']) operation;
INSERT INTO app.access_default_capability_grant(legacy_key,capability_id)
 SELECT 'hr_admin','payroll_configuration.'||operation FROM unnest(ARRAY['view','add','edit','delete']) operation;
--> statement-breakpoint
CREATE FUNCTION app.financial_setup_legacy_allowed(t uuid,u uuid,cap text,co uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT co IS NULL AND cap IN ('payroll_configuration.view','payroll_configuration.add','payroll_configuration.edit','payroll_configuration.delete')
 AND EXISTS(SELECT 1 FROM public.app_user a JOIN public.role_assignment r ON r.tenant_id=a.tenant_id AND r.app_user_id=a.id
 WHERE a.tenant_id=t AND a.id=u AND a.archived_at IS NULL AND NOT app.login_blocked(a.id) AND r.role::text IN ('hr_admin','super_admin'));
$$;
CREATE FUNCTION app.financial_setup_delegation_allowed(t uuid,u uuid,cap text,co uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.financial_setup_legacy_allowed(t,u,cap,co);
$$;
REVOKE ALL ON FUNCTION app.financial_setup_legacy_allowed(uuid,uuid,text,uuid),app.financial_setup_delegation_allowed(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.financial_setup_catalog_action(p_operation text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT p_operation IN ('view','add','edit','delete') AND app.principal_snapshot_current() AND app.is_admin()
 AND app.financial_setup_legacy_allowed(app.current_tenant_id(),app.current_user_id(),'payroll_configuration.'||p_operation,NULL)
 AND CASE WHEN EXISTS(SELECT 1 FROM public.access_capability WHERE id='payroll_configuration.'||p_operation AND supported)
 THEN app.access_allowed_for(app.current_user_id(),'payroll_configuration.'||p_operation,NULL) ELSE true END;
$$;
REVOKE ALL ON FUNCTION app.financial_setup_catalog_action(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.financial_setup_catalog_action(text) TO ai_hr_app;
--> statement-breakpoint
DO $$DECLARE key text;operation text;BEGIN
 FOREACH key IN ARRAY ARRAY['payComponents.catalogue','payComponents.formulaBuilder'] LOOP
  FOREACH operation IN ARRAY ARRAY['view','add','edit','delete'] LOOP
   PERFORM app.register_function_action(key,operation,'tenant','payroll_configuration.'||operation,'app.financial_setup_delegation_allowed',
    jsonb_build_object('moduleKey','payroll','labelKey',CASE WHEN key='payComponents.catalogue' THEN 'admin.users.screen.payComponents' ELSE 'payFormula.title' END,
     'kind','submenu','course','administrative','screenKey','payComponents','href',CASE WHEN key='payComponents.catalogue' THEN '/admin/pay-components' ELSE '/payroll/formula-builder' END));
  END LOOP;
 END LOOP;
END;$$;
CREATE FUNCTION app.financial_setup_catalog_function(p_key text,p_operation text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT p_key IN ('payComponents.catalogue','payComponents.formulaBuilder') AND app.financial_setup_catalog_action(p_operation)
 AND app.function_action_allowed(p_key,p_operation,NULL);
$$;
REVOKE ALL ON FUNCTION app.financial_setup_catalog_function(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.financial_setup_catalog_function(text,text) TO ai_hr_app;
-- Native history ACL is distinct from catalogue maintenance and independent payroll reading.
CREATE FUNCTION app.financial_history_native(t uuid,u uuid,kind text,co uuid,live boolean) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE admitted boolean;selected uuid;
BEGIN
 IF kind IS NULL OR live IS NULL OR kind NOT IN ('view','import','revert') THEN RETURN false;END IF;
 IF (CASE WHEN live THEN app.financial_letter_current_legacy_allowed(t,u,'payroll.view',co)
  ELSE app.financial_letter_legacy_allowed(t,u,'payroll.view',co) END) IS NOT TRUE THEN RETURN false;END IF;
 IF kind='view' THEN RETURN true;END IF;
 WITH configured AS(SELECT role,allowed,company_id FROM public.payroll_permission_grant WHERE tenant_id=t AND permission_key='payroll.history.'||kind AND (company_id=co OR company_id IS NULL)),
 effective AS(SELECT role,allowed FROM configured WHERE company_id=co OR company_id IS NULL AND NOT EXISTS(SELECT 1 FROM configured WHERE company_id=co)),
 candidates AS(SELECT DISTINCT r.role::text AS role FROM public.role_assignment r WHERE r.tenant_id=t AND r.app_user_id=u
  AND (co IS NULL AND r.company_id IS NULL OR co IS NOT NULL AND app.access_scope_covers(r.company_id,co,t))
  AND (NOT live OR EXISTS(SELECT 1 FROM app.current_grants() claimed WHERE claimed.role=r.role::text AND (co IS NULL AND claimed.company_id IS NULL OR co IS NOT NULL AND app.access_scope_covers(claimed.company_id,co,t)))))
 SELECT CASE WHEN EXISTS(SELECT 1 FROM effective) THEN EXISTS(SELECT 1 FROM candidates c JOIN effective a ON a.role::text=c.role AND a.allowed WHERE NOT EXISTS(SELECT 1 FROM effective denied WHERE denied.role::text=c.role AND NOT denied.allowed))
 ELSE EXISTS(SELECT 1 FROM candidates WHERE role IN ('hr_admin','super_admin')) END INTO admitted;
 IF admitted IS NOT TRUE THEN RETURN false;END IF;
 -- NULL is a future/global course: the tenant ACL and every existing company must both admit it.
 IF co IS NULL THEN
  FOR selected IN SELECT id FROM public.company WHERE tenant_id=t AND archived_at IS NULL LOOP
   IF NOT app.financial_history_native(t,u,kind,selected,live) THEN RETURN false;END IF;
  END LOOP;
 END IF;
 RETURN true;
END;$$;
REVOKE ALL ON FUNCTION app.financial_history_native(uuid,uuid,text,uuid,boolean) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.financial_history_delegation_allowed(t uuid,u uuid,cap text,co uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT cap IN ('payroll.view','payroll.add','payroll.edit','payroll.delete') AND app.financial_history_native(t,u,
 CASE substring(cap from '[^.]+$') WHEN 'view' THEN 'view' WHEN 'delete' THEN 'revert' ELSE 'import' END,co,true);
$$;
REVOKE ALL ON FUNCTION app.financial_history_delegation_allowed(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
SELECT app.register_function_action('payroll.historyImport',operation,'company','payroll.'||operation,'app.financial_history_delegation_allowed',
 '{"moduleKey":"payroll","labelKey":"payroll.historyImport.title","kind":"submenu","course":"administrative","screenKey":"payroll","href":"/payroll/history-import","employeeBearing":true}'::jsonb)
FROM unnest(ARRAY['view','add','edit','delete']) operation;
CREATE FUNCTION app.financial_history_function_action(co uuid,operation text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT operation IN ('view','add','edit','delete') AND app.financial_history_native(app.current_tenant_id(),app.current_user_id(),
  CASE operation WHEN 'view' THEN 'view' WHEN 'delete' THEN 'revert' ELSE 'import' END,co,true)
 AND CASE WHEN co IS NULL THEN app.financial_letter_capability_allowed_current('payroll.'||operation,NULL)
  AND app.financial_letter_capability_allowed_current('function.payroll.historyImport.view',NULL)
  AND app.financial_letter_capability_allowed_current('function.payroll.historyImport.'||operation,NULL)
 ELSE app.access_financial_action_company('payroll',co,operation)
  AND app.function_action_allowed('payroll.historyImport','view',co) AND app.function_action_allowed('payroll.historyImport',operation,co) END;
$$;
REVOKE ALL ON FUNCTION app.financial_history_function_action(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.financial_history_function_action(uuid,text) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.financial_setup_function_legacy_allowed(t uuid,u uuid,cap text,co uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app.access_function_action a WHERE a.capability_id=cap AND a.function_key IN ('payComponents.catalogue','payComponents.formulaBuilder')
  AND app.financial_setup_legacy_allowed(t,u,a.parent_capability,co))
 OR EXISTS(SELECT 1 FROM app.access_function_action a WHERE a.capability_id=cap AND a.function_key='payroll.historyImport'
  AND app.financial_history_native(t,u,CASE a.operation WHEN 'view' THEN 'view' WHEN 'delete' THEN 'revert' ELSE 'import' END,co,false));
$$;
REVOKE ALL ON FUNCTION app.financial_setup_function_legacy_allowed(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.financial_setup_current_legacy_allowed(t uuid,u uuid,cap text,co uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT t=app.current_tenant_id() AND u=app.current_user_id() AND app.principal_snapshot_current() AND app.is_admin()
 AND app.financial_setup_legacy_allowed(t,u,cap,co);
$$;
CREATE FUNCTION app.financial_setup_function_current_legacy_allowed(t uuid,u uuid,cap text,co uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app.access_function_action a WHERE a.capability_id=cap AND a.function_key IN ('payComponents.catalogue','payComponents.formulaBuilder')
  AND app.financial_setup_current_legacy_allowed(t,u,a.parent_capability,co))
 OR EXISTS(SELECT 1 FROM app.access_function_action a WHERE a.capability_id=cap AND a.function_key='payroll.historyImport'
  AND app.financial_history_native(t,u,CASE a.operation WHEN 'view' THEN 'view' WHEN 'delete' THEN 'revert' ELSE 'import' END,co,true));
$$;
REVOKE ALL ON FUNCTION app.financial_setup_current_legacy_allowed(uuid,uuid,text,uuid),app.financial_setup_function_current_legacy_allowed(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE TABLE app.financial_setup_birth(xact_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,kind text NOT NULL,row_id uuid NOT NULL,PRIMARY KEY(xact_id,tenant_id,user_id,kind,row_id));
ALTER TABLE app.financial_setup_birth ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.financial_setup_birth FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.financial_setup_born(p_kind text,p_row uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app.financial_setup_birth b WHERE b.xact_id=pg_current_xact_id() AND b.tenant_id=app.current_tenant_id() AND b.user_id=app.current_user_id() AND b.kind=p_kind AND b.row_id=p_row);
$$;
CREATE FUNCTION app.financial_setup_remember_birth() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 DELETE FROM app.financial_setup_birth WHERE xact_id<pg_snapshot_xmin(pg_current_snapshot());
 IF NOT app.access_workforce_storage_owner() THEN INSERT INTO app.financial_setup_birth VALUES(pg_current_xact_id(),NEW.tenant_id,app.current_user_id(),TG_TABLE_NAME,NEW.id) ON CONFLICT DO NOTHING;END IF;RETURN NULL;
END;$$;
REVOKE ALL ON FUNCTION app.financial_setup_born(text,uuid),app.financial_setup_remember_birth() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER financial_setup_successful_birth AFTER INSERT ON pay_formula FOR EACH ROW EXECUTE FUNCTION app.financial_setup_remember_birth();
CREATE TRIGGER financial_setup_successful_birth AFTER INSERT ON pay_component FOR EACH ROW EXECUTE FUNCTION app.financial_setup_remember_birth();
CREATE TRIGGER financial_setup_successful_birth AFTER INSERT ON payroll_batch FOR EACH ROW EXECUTE FUNCTION app.financial_setup_remember_birth();
CREATE TRIGGER financial_setup_successful_birth AFTER INSERT ON pay_period FOR EACH ROW EXECUTE FUNCTION app.financial_setup_remember_birth();
CREATE TRIGGER financial_setup_successful_birth AFTER INSERT ON employee_loan FOR EACH ROW EXECUTE FUNCTION app.financial_setup_remember_birth();
--> statement-breakpoint
CREATE FUNCTION app.financial_setup_standard_cycle(p_row jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.organisation_company_born((p_row->>'company_id')::uuid)
 AND (p_row->>'archived_at') IS NULL AND coalesce((p_row->>'sort_order')::integer,-1) BETWEEN 0 AND 5
 AND EXISTS(SELECT 1 FROM (VALUES
 ('Monthly','ME','regular',NULL::text,0),('Bonus','BO','bonus',NULL::text,1),('Off-cycle','OC','off_cycle',NULL::text,2),
 ('Adjustment','AD','adjustment',NULL::text,3),('Advance Salary','AS','off_cycle','Advance Salary',4),('Mid-Month','MM','off_cycle','Mid-Month',5)) standard(name,code,run_type,remarks,sort_order)
 WHERE p_row->>'name'=standard.name AND p_row->>'code'=standard.code AND p_row->>'run_type'=standard.run_type
 AND p_row->>'remarks' IS NOT DISTINCT FROM standard.remarks AND (p_row->>'sort_order')::integer=standard.sort_order);
$$;
REVOKE ALL ON FUNCTION app.financial_setup_standard_cycle(jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.financial_setup_write_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE b jsonb:=CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END;a jsonb:=CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END;r jsonb:=coalesce(a,b);
 op text:=CASE TG_OP WHEN 'INSERT' THEN 'add' WHEN 'DELETE' THEN 'delete' ELSE 'edit' END;co uuid;subject uuid;root uuid;catalogue boolean:=false;independent boolean:=false;
BEGIN
 IF app.access_workforce_storage_owner() THEN RETURN NULL;END IF;
 PERFORM app.access_workforce_write_lock();
 IF (r->>'tenant_id')::uuid IS DISTINCT FROM app.current_tenant_id() OR NOT app.principal_snapshot_current()
 OR (a IS NOT NULL AND b IS NOT NULL AND (a->>'id' IS DISTINCT FROM b->>'id' OR a->>'tenant_id' IS DISTINCT FROM b->>'tenant_id')) THEN RAISE EXCEPTION 'Financial setup principal unavailable' USING ERRCODE='42501';END IF;
 IF TG_OP='UPDATE' AND b->>'archived_at' IS NULL AND a->>'archived_at' IS NOT NULL THEN op:='delete';END IF;
 IF TG_TABLE_NAME='payroll_cycle' AND TG_OP='INSERT' AND app.financial_setup_standard_cycle(a) THEN RETURN NULL;END IF;
 IF TG_TABLE_NAME='pay_component' THEN
  IF TG_OP='INSERT' AND (a->>'resolution_order')::integer<>0 THEN RAISE EXCEPTION 'Catalogue rank must be derived' USING ERRCODE='42501';END IF;
  IF TG_OP='UPDATE' AND b->'resolution_order' IS DISTINCT FROM a->'resolution_order' THEN
   IF NOT app.financial_catalog_rank_effect_allowed(b,a) THEN RAISE EXCEPTION 'Catalogue rank requires its exact native derivation' USING ERRCODE='42501';END IF;RETURN NULL;
  END IF;
 END IF;
 IF TG_TABLE_NAME='pay_component' AND TG_OP='INSERT' AND app.financial_backpay_catalog_approved(b,a) THEN RETURN NULL;END IF;
 IF TG_TABLE_NAME IN ('pay_component','payroll_import_code','pay_formula','pay_formula_revision','pay_formula_event','pay_formula_accumulation') THEN
  catalogue:=true;
  IF TG_TABLE_NAME='pay_formula_revision' THEN op:=CASE WHEN app.financial_setup_born('pay_formula',(r->>'formula_id')::uuid) THEN 'add' ELSE 'edit' END;END IF;
  IF TG_TABLE_NAME='pay_formula_event' THEN
   op:=CASE WHEN r->>'kind'='deleted' THEN 'delete' WHEN app.financial_setup_born('pay_formula',(r->>'formula_id')::uuid) THEN 'add' ELSE 'edit' END;
   IF r->>'kind'='linked' AND app.financial_setup_born('pay_component',(r->>'component_id')::uuid) THEN op:='add';END IF;
  END IF;
  IF TG_TABLE_NAME='pay_formula_accumulation' AND TG_OP='INSERT' AND EXISTS(SELECT 1 FROM public.pay_formula_accumulation prior WHERE prior.tenant_id=app.current_tenant_id() AND prior.code=r->>'code' AND prior.ordinal<(r->>'ordinal')::integer) THEN op:='edit';END IF;
 ELSIF TG_TABLE_NAME='payroll_cycle' THEN
  co:=(r->>'company_id')::uuid;
 ELSIF TG_TABLE_NAME IN ('payroll_policy','payroll_anomaly_config','payroll_permission_grant') THEN
  co:=(r->>'company_id')::uuid;catalogue:=co IS NULL OR TG_TABLE_NAME='payroll_permission_grant';
  IF TG_TABLE_NAME='payroll_policy' AND NOT app.is_admin_for(co) THEN RAISE EXCEPTION 'Native payroll policy administration unavailable' USING ERRCODE='42501';END IF;
  IF TG_TABLE_NAME='payroll_permission_grant' AND NOT app.is_admin() THEN RAISE EXCEPTION 'Native payroll permission administration unavailable' USING ERRCODE='42501';END IF;
 ELSIF TG_TABLE_NAME IN ('company_payroll_config','payslip_information_setting','leave_encashment_policy') THEN co:=(r->>'company_id')::uuid;op:='edit';
  IF TG_TABLE_NAME IN ('company_payroll_config','leave_encashment_policy') AND NOT app.is_admin_for(co) THEN RAISE EXCEPTION 'Native company configuration unavailable' USING ERRCODE='42501';END IF;
 ELSIF TG_TABLE_NAME='employee_cp38' THEN
  subject:=(r->>'employment_id')::uuid;
  IF NOT app.is_admin() THEN RAISE EXCEPTION 'Native CP38 administration unavailable' USING ERRCODE='42501';END IF;
  IF TG_OP='UPDATE' AND b->>'superseded_at' IS NULL AND a->>'superseded_at' IS NOT NULL THEN op:='delete';END IF;
 ELSIF TG_TABLE_NAME IN ('pcb_payment','statutory_report') THEN
  co:=(r->>'company_id')::uuid;
  -- A payment reference records/corrects one fixed month/stream cell, including first materialization.
  IF TG_TABLE_NAME='pcb_payment' AND TG_OP<>'DELETE' THEN op:='edit';END IF;
 ELSIF TG_TABLE_NAME='employee_loan' THEN
  IF TG_OP='UPDATE' AND to_regprocedure('app.financial_payroll_loan_counter_approved(jsonb,jsonb)') IS NOT NULL THEN
   EXECUTE 'SELECT app.financial_payroll_loan_counter_approved($1,$2)' INTO independent USING b,a;
   IF independent THEN RETURN NULL;END IF;
  END IF;
  subject:=(r->>'employment_id')::uuid;
  IF NOT app.can_admin_employment(subject) OR TG_OP='UPDATE' AND (b->>'employment_id') IS DISTINCT FROM (a->>'employment_id') AND NOT app.can_admin_employment((b->>'employment_id')::uuid) THEN RAISE EXCEPTION 'Native loan administration unavailable' USING ERRCODE='42501';END IF;
  IF TG_OP='UPDATE' AND b->>'status' IS DISTINCT FROM 'cancelled' AND a->>'status'='cancelled' THEN op:='delete';END IF;
 ELSIF TG_TABLE_NAME='pay_formula_test' THEN co:=(r->>'company_id')::uuid;subject:=(r->>'employment_id')::uuid;op:='view';
  IF NOT app.financial_setup_catalog_function('payComponents.formulaBuilder','edit') THEN RAISE EXCEPTION 'Formula test editing unavailable' USING ERRCODE='42501';END IF;
 ELSIF TG_TABLE_NAME IN ('payroll_tax_basis_preview','payroll_tax_basis_batch','payroll_tax_basis_event','payroll_tax_basis_revision') THEN
  co:=(r->>'company_id')::uuid;subject:=(r->>'employment_id')::uuid;op:='edit';
  IF NOT app.access_financial_action_company('payroll',co,'edit') OR subject IS NOT NULL AND NOT app.data_permission_matches(subject) THEN RAISE EXCEPTION 'Tax correction subject action unavailable' USING ERRCODE='42501';END IF;
  IF TG_TABLE_NAME='payroll_tax_basis_preview' THEN
   IF NOT app.financial_tax_preview_visible(r->'preview') THEN RAISE EXCEPTION 'Tax correction packet unavailable' USING ERRCODE='42501';END IF;
  ELSIF TG_TABLE_NAME='payroll_tax_basis_batch' THEN
   IF NOT EXISTS(SELECT 1 FROM public.payroll_tax_basis_preview p WHERE p.id=(r->>'preview_id')::uuid AND p.tenant_id=app.current_tenant_id() AND app.financial_tax_preview_visible(p.preview)) THEN RAISE EXCEPTION 'Tax correction preview unavailable' USING ERRCODE='42501';END IF;
  END IF;
  RETURN NULL;
 ELSE RAISE EXCEPTION 'Unknown financial setup owner' USING ERRCODE='42501';END IF;
 IF catalogue THEN
  IF NOT app.financial_setup_catalog_function(CASE WHEN TG_TABLE_NAME IN ('pay_formula','pay_formula_revision','pay_formula_accumulation') OR TG_TABLE_NAME='pay_formula_event' AND r->>'kind' IS DISTINCT FROM 'linked' THEN 'payComponents.formulaBuilder' ELSE 'payComponents.catalogue' END,op) THEN RAISE EXCEPTION 'Payroll catalogue action unavailable' USING ERRCODE='42501';END IF;
 ELSE
  IF subject IS NOT NULL THEN
   IF NOT app.access_financial_action_employment('payroll',subject,op) THEN RAISE EXCEPTION 'Financial subject action unavailable' USING ERRCODE='42501';END IF;
  ELSIF NOT app.access_financial_action_company('payroll',co,op) THEN RAISE EXCEPTION 'Financial company action unavailable' USING ERRCODE='42501';END IF;
  IF TG_OP='UPDATE' AND b->>'company_id' IS DISTINCT FROM a->>'company_id' AND NOT app.access_financial_action_company('payroll',(b->>'company_id')::uuid,op) THEN RAISE EXCEPTION 'Financial source scope unavailable' USING ERRCODE='42501';END IF;
  IF TG_OP='UPDATE' AND b->>'employment_id' IS DISTINCT FROM a->>'employment_id' AND NOT app.access_financial_action_employment('payroll',(b->>'employment_id')::uuid,op) THEN RAISE EXCEPTION 'Financial original subject unavailable' USING ERRCODE='42501';END IF;
 END IF;
 RETURN NULL;
END;$$;
REVOKE ALL ON FUNCTION app.financial_setup_write_guard() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
DO $$DECLARE name text;BEGIN
 FOREACH name IN ARRAY ARRAY['pay_component','payroll_import_code','payroll_cycle','payroll_policy','company_payroll_config','payslip_information_setting','payroll_anomaly_config','payroll_permission_grant','leave_encashment_policy','pay_formula','pay_formula_revision','pay_formula_event','pay_formula_accumulation','pay_formula_test','employee_loan','employee_cp38','pcb_payment','statutory_report','payroll_tax_basis_preview','payroll_tax_basis_batch','payroll_tax_basis_event','payroll_tax_basis_revision'] LOOP
 EXECUTE format('CREATE CONSTRAINT TRIGGER financial_setup_action AFTER INSERT OR UPDATE OR DELETE ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.financial_setup_write_guard()',name);
 END LOOP;
END;$$;
--> statement-breakpoint
-- TP1 is person-owned: its independent declaration course must not borrow administrative authority.
CREATE FUNCTION app.financial_tp1_admin_action(p_person uuid,p_operation text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND app.is_admin() AND EXISTS(
  SELECT 1 FROM public.employment e WHERE e.tenant_id=app.current_tenant_id() AND e.person_id=p_person AND e.voided_at IS NULL
   AND app.data_permission_matches(e.id) AND app.access_financial_action_company('payroll',e.company_id,p_operation));
$$;
REVOKE ALL ON FUNCTION app.financial_tp1_admin_action(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.financial_tp1_admin_action(uuid,text) TO ai_hr_app;
CREATE FUNCTION app.financial_tp1_write_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE b jsonb:=CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END;
 a jsonb:=CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END;r jsonb:=coalesce(a,b);
 op text:=CASE TG_OP WHEN 'INSERT' THEN 'add' WHEN 'DELETE' THEN 'delete' ELSE 'edit' END;
 own_declaration boolean:=false;
BEGIN
 IF app.access_workforce_storage_owner() THEN RETURN NULL;END IF;
 PERFORM app.access_workforce_write_lock();
 IF (r->>'tenant_id')::uuid IS DISTINCT FROM app.current_tenant_id() OR NOT app.principal_snapshot_current()
 OR (a IS NOT NULL AND b IS NOT NULL AND (a->>'id' IS DISTINCT FROM b->>'id' OR a->>'tenant_id' IS DISTINCT FROM b->>'tenant_id' OR a->>'person_id' IS DISTINCT FROM b->>'person_id')) THEN
  RAISE EXCEPTION 'TP1 principal unavailable' USING ERRCODE='42501';END IF;
 IF TG_OP='UPDATE' AND b->>'status' IS DISTINCT FROM 'cancelled' AND a->>'status'='cancelled' THEN op:='delete';END IF;
 IF TG_OP<>'DELETE' AND app.is_self_person((a->>'person_id')::uuid) THEN
  -- Own submission appends a declaration; own draft save changes only editable declaration fields.
  own_declaration:=a->>'status' IN ('draft','submitted') AND a->>'approved_by' IS NULL AND a->>'approved_at' IS NULL
   AND a->>'approved_month' IS NULL AND a->>'approved_year' IS NULL AND a->>'approver_position' IS NULL
   AND (TG_OP='INSERT' OR b->>'status'='draft' AND a->>'status'='draft'
    AND (a-ARRAY['tp1_amount','categories','deduction_month'])=(b-ARRAY['tp1_amount','categories','deduction_month']));
 END IF;
 IF own_declaration THEN RETURN NULL;END IF;
 IF NOT app.financial_tp1_admin_action((r->>'person_id')::uuid,op) THEN RAISE EXCEPTION 'TP1 administrative action unavailable' USING ERRCODE='42501';END IF;
 RETURN NULL;
END;$$;
REVOKE ALL ON FUNCTION app.financial_tp1_write_guard() FROM PUBLIC,ai_hr_app;
CREATE CONSTRAINT TRIGGER financial_tp1_action AFTER INSERT OR UPDATE OR DELETE ON public.tp1_relief DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.financial_tp1_write_guard();
--> statement-breakpoint
-- Definition reads used by the calculation owner retain their distinct read predicate. The builder
-- itself, including validation/generation, consumes this explicit catalogue purpose.
CREATE OR REPLACE FUNCTION app.pay_formula_catalog_access() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.financial_setup_catalog_function('payComponents.formulaBuilder','view');
$$;

--> statement-breakpoint
CREATE TABLE app.financial_loan_intent(xact_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,loan_id uuid NOT NULL,operation text NOT NULL CHECK(operation IN ('add','edit','delete')),before_row jsonb NOT NULL,PRIMARY KEY(xact_id,tenant_id,user_id,loan_id));
ALTER TABLE app.financial_loan_intent ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.financial_loan_intent FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.financial_loan_begin(p_loan uuid,p_operation text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE target public.employee_loan%ROWTYPE;
BEGIN
 PERFORM app.access_workforce_write_lock();
 SELECT * INTO target FROM public.employee_loan WHERE id=p_loan AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND OR p_operation NOT IN ('add','edit','delete') OR NOT app.access_financial_action_employment('payroll',target.employment_id,p_operation) OR NOT app.can_admin_employment(target.employment_id)
 OR p_operation='add' AND NOT app.financial_setup_born('employee_loan',target.id) THEN RAISE EXCEPTION 'Loan action unavailable' USING ERRCODE='42501';END IF;
 DELETE FROM app.financial_loan_intent WHERE xact_id<pg_snapshot_xmin(pg_current_snapshot());
 INSERT INTO app.financial_loan_intent VALUES(pg_current_xact_id(),target.tenant_id,app.current_user_id(),target.id,p_operation,to_jsonb(target)) ON CONFLICT DO NOTHING;
END;$$;
REVOKE ALL ON FUNCTION app.financial_loan_begin(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.financial_loan_begin(uuid,text) TO ai_hr_app;
CREATE FUNCTION app.financial_loan_schedule_approved(p_before jsonb,p_after jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r jsonb:=coalesce(p_after,p_before);proof app.financial_loan_intent%ROWTYPE;target public.employee_loan%ROWTYPE;
BEGIN
 IF p_after IS NULL OR r->>'tenant_id' IS DISTINCT FROM app.current_tenant_id()::text THEN RETURN false;END IF;
 SELECT * INTO proof FROM app.financial_loan_intent i WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=app.current_tenant_id() AND i.user_id=app.current_user_id() AND i.loan_id=(r->>'loan_id')::uuid;
 IF NOT FOUND THEN RETURN false;END IF;
 SELECT * INTO target FROM public.employee_loan WHERE id=proof.loan_id AND tenant_id=proof.tenant_id;
 IF NOT FOUND OR target.employment_id::text IS DISTINCT FROM r->>'employment_id' OR NOT app.access_financial_action_employment('payroll',target.employment_id,proof.operation) THEN RETURN false;END IF;
 IF p_before IS NULL THEN RETURN proof.operation='add' AND app.financial_setup_born('employee_loan',target.id)
  AND p_after->>'status'='scheduled' AND (p_after->>'applied_amount')::numeric=0 AND p_after->>'reserved_batch_id' IS NULL AND p_after->>'applied_batch_id' IS NULL AND p_after->>'applied_at' IS NULL;END IF;
 IF (p_before-'due_amount'-'status') IS DISTINCT FROM (p_after-'due_amount'-'status') OR (p_before->>'applied_amount')::numeric<>0 OR p_before->>'applied_batch_id' IS NOT NULL OR p_before->>'applied_at' IS NOT NULL THEN RETURN false;END IF;
 IF p_before->>'status'='scheduled' AND p_after->>'status' IN ('scheduled','skipped') AND proof.operation='edit' THEN RETURN true;END IF;
 RETURN p_before->>'status' IN ('scheduled','reserved') AND p_after->>'status'='skipped'
  AND p_after->>'due_amount' IS NOT DISTINCT FROM p_before->>'due_amount'
  AND ((proof.operation='edit' AND target.status='settled') OR (proof.operation='delete' AND target.status='cancelled'));
END;$$;
REVOKE ALL ON FUNCTION app.financial_loan_schedule_approved(jsonb,jsonb) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.financial_history_permission(p_company uuid,p_kind text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT p_kind IN ('import','revert') AND app.financial_history_native(app.current_tenant_id(),app.current_user_id(),p_kind,p_company,true);
$$;
REVOKE ALL ON FUNCTION app.financial_history_permission(uuid,text) FROM PUBLIC,ai_hr_app;
CREATE TABLE app.financial_history_intent(
 xact_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,attempt_id uuid NOT NULL,company_id uuid NOT NULL,employment_id uuid NOT NULL,
 period text NOT NULL,cycle_id uuid NOT NULL,operation text NOT NULL CHECK(operation IN ('add','edit','delete')),planned jsonb NOT NULL,
 PRIMARY KEY(xact_id,tenant_id,user_id,attempt_id,company_id,employment_id,period,cycle_id)
);
ALTER TABLE app.financial_history_intent ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.financial_history_intent FROM PUBLIC,ai_hr_app;
CREATE TABLE app.financial_history_noop(xact_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,attempt_id uuid NOT NULL,plan_hash text NOT NULL,PRIMARY KEY(xact_id,tenant_id,user_id,attempt_id));
ALTER TABLE app.financial_history_noop ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.financial_history_noop FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.financial_history_begin(p_attempt uuid,p_keys jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source public.payroll_history_import_attempt%ROWTYPE;k jsonb;planned jsonb;op text;co uuid;subject uuid;starts date;ends date;
BEGIN
 PERFORM app.access_workforce_write_lock();
 IF jsonb_typeof(p_keys) IS DISTINCT FROM 'array' OR jsonb_array_length(p_keys)>10000 OR octet_length(p_keys::text)>2097152 THEN RAISE EXCEPTION 'History selection unavailable' USING ERRCODE='22023';END IF;
 SELECT * INTO source FROM public.payroll_history_import_attempt WHERE id=p_attempt AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND OR NOT app.principal_snapshot_current() OR coalesce((source.plan->'counts'->>'invalid')::integer,1)<>0 OR jsonb_typeof(source.plan->'rows') IS DISTINCT FROM 'array' OR source.plan->'issues' IS DISTINCT FROM '[]'::jsonb
 OR EXISTS(SELECT 1 FROM public.payroll_history_import_event WHERE attempt_id=source.id AND kind IN ('confirmed','reverted')) THEN RAISE EXCEPTION 'History source changed' USING ERRCODE='42501';END IF;
 DELETE FROM app.financial_history_intent WHERE xact_id<pg_snapshot_xmin(pg_current_snapshot());
 IF jsonb_array_length(p_keys)=0 THEN
  IF jsonb_array_length(source.plan->'rows') NOT BETWEEN 1 AND 10000 THEN RAISE EXCEPTION 'History unchanged source unavailable' USING ERRCODE='42501';END IF;
  FOR planned IN SELECT value FROM jsonb_array_elements(source.plan->'rows') LOOP
   co:=(planned->>'companyId')::uuid;subject:=(planned->>'employmentId')::uuid;
   IF planned->>'operation' IS DISTINCT FROM 'unchanged' OR NOT app.financial_history_permission(co,'import') OR NOT app.financial_history_function_action(co,'view') OR NOT app.data_permission_matches(subject) THEN RAISE EXCEPTION 'History unchanged subject unavailable' USING ERRCODE='42501';END IF;
   IF NOT EXISTS(SELECT 1 FROM public.payroll_history_import_record r JOIN public.payroll_history_import_revision v ON v.record_id=r.id AND v.tenant_id=r.tenant_id JOIN public.payroll_history_import_snapshot s ON s.record_id=r.id AND s.tenant_id=r.tenant_id AND s.id=v.snapshot_id
    WHERE r.tenant_id=source.tenant_id AND r.id=(planned->>'recordId')::uuid AND r.company_id=co AND r.employment_id=subject AND r.period=planned->>'period' AND r.cycle_id=(planned->>'cycleId')::uuid
     AND v.id=(planned->>'expectedRevisionId')::uuid AND s.id=(planned->>'expectedSnapshotId')::uuid AND s.value_hash=planned->>'valueHash' AND s."values"=planned->'values'
     AND NOT EXISTS(SELECT 1 FROM public.payroll_history_import_revision newer WHERE newer.record_id=r.id AND newer.tenant_id=r.tenant_id AND newer.ordinal>v.ordinal))
   AND NOT EXISTS(SELECT 1 FROM public.payslip s JOIN public.payroll_batch b ON b.id=s.batch_id AND b.tenant_id=s.tenant_id
    WHERE planned->>'recordId' IS NULL AND s.tenant_id=source.tenant_id AND s.id=(planned->>'expectedOrdinaryPayslipId')::uuid AND s.employment_id=subject AND b.company_id=co AND b.pay_period=planned->>'period' AND (b.payroll_cycle_id IS NULL OR b.payroll_cycle_id=(planned->>'cycleId')::uuid) AND b.status='closed' AND b.history_import_attempt_id IS NULL AND app.payroll_history_effective(s.id)
     AND s.basic_salary=(planned->'values'->>'basicSalary')::numeric AND s.allowance=(planned->'values'->>'allowance')::numeric AND s.overtime_pay=(planned->'values'->>'overtimePay')::numeric AND s.bonus=(planned->'values'->>'bonus')::numeric AND s.gross_pay=(planned->'values'->>'grossPay')::numeric
     AND s.other_deductions=(planned->'values'->>'otherDeductions')::numeric AND s.total_deductions=(planned->'values'->>'totalDeductions')::numeric AND s.net_pay=(planned->'values'->>'netPay')::numeric AND s.employer_cost=(planned->'values'->>'employerCost')::numeric AND s.statutory=planned->'values'->'statutory')
   THEN RAISE EXCEPTION 'History unchanged result changed' USING ERRCODE='42501';END IF;
  END LOOP;
  DELETE FROM app.financial_history_noop WHERE xact_id<pg_snapshot_xmin(pg_current_snapshot());
  INSERT INTO app.financial_history_noop VALUES(pg_current_xact_id(),source.tenant_id,app.current_user_id(),source.id,encode(sha256(convert_to(source.plan::text,'UTF8')),'hex'));
  RETURN;
 END IF;
 FOR k IN SELECT value FROM jsonb_array_elements(p_keys) LOOP
  IF jsonb_typeof(k) IS DISTINCT FROM 'object' OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(k)key) IS DISTINCT FROM ARRAY['companyId','cycleId','employmentId','period'] THEN RAISE EXCEPTION 'History row key unavailable' USING ERRCODE='22023';END IF;
  SELECT item.value INTO STRICT planned FROM jsonb_array_elements(source.plan->'rows') AS item(value) WHERE item.value->>'companyId'=k->>'companyId' AND item.value->>'employmentId'=k->>'employmentId' AND item.value->>'period'=k->>'period' AND item.value->>'cycleId'=k->>'cycleId';
  IF coalesce(planned->>'operation','') NOT IN ('create','replace') OR jsonb_typeof(planned->'values') IS DISTINCT FROM 'object' OR planned->>'valueHash' IS NULL THEN RAISE EXCEPTION 'History row unavailable' USING ERRCODE='42501';END IF;
  co:=(k->>'companyId')::uuid;subject:=(k->>'employmentId')::uuid;op:=CASE WHEN planned->>'operation'='create' THEN 'add' ELSE 'edit' END;
  IF co IS NULL OR subject IS NULL OR k->>'cycleId' IS NULL OR coalesce(k->>'period','') !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' THEN RAISE EXCEPTION 'History key unavailable' USING ERRCODE='22023';END IF;
  starts:=(k->>'period'||'-01')::date;ends:=(starts+interval '1 month'-interval '1 day')::date;
  IF NOT app.financial_history_permission(co,'import') OR NOT app.financial_history_function_action(co,op) OR NOT app.data_permission_matches(subject)
   OR NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.id=subject AND e.tenant_id=source.tenant_id AND e.voided_at IS NULL AND (e.company_id=co OR EXISTS(SELECT 1 FROM public.assignment a WHERE a.employment_id=e.id AND a.tenant_id=e.tenant_id AND a.company_id=co AND a.superseded_at IS NULL AND a.valid_from<=ends AND (a.valid_to IS NULL OR a.valid_to>starts)))) THEN RAISE EXCEPTION 'History subject action unavailable' USING ERRCODE='42501';END IF;
  INSERT INTO app.financial_history_intent VALUES(pg_current_xact_id(),source.tenant_id,app.current_user_id(),source.id,co,subject,k->>'period',(k->>'cycleId')::uuid,op,planned);
 END LOOP;
END;$$;
REVOKE ALL ON FUNCTION app.financial_history_begin(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.financial_history_begin(uuid,jsonb) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.financial_history_kernel_approved(p_table text,p_before jsonb,p_after jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r jsonb:=coalesce(p_after,p_before);batch public.payroll_batch%ROWTYPE;proof app.financial_history_intent%ROWTYPE;expected jsonb;counted integer;
BEGIN
 IF p_after IS NULL OR p_table NOT IN ('pay_period','payroll_batch','payslip') OR r->>'tenant_id' IS DISTINCT FROM app.current_tenant_id()::text OR NOT app.principal_snapshot_current() THEN RETURN false;END IF;
 IF p_table='pay_period' THEN
  IF NOT EXISTS(SELECT 1 FROM app.financial_history_intent i WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=app.current_tenant_id() AND i.user_id=app.current_user_id() AND i.company_id=(r->>'company_id')::uuid AND i.period=r->>'period' AND i.operation IN ('add','edit') AND app.financial_history_function_action(i.company_id,i.operation) AND app.data_permission_matches(i.employment_id)) THEN RETURN false;END IF;
  IF p_before IS NULL THEN RETURN p_after->>'status'='open';END IF;
  RETURN (p_after-'status')=(p_before-'status') AND p_after->>'status'='closed'
   AND NOT EXISTS(SELECT 1 FROM public.payroll_batch b WHERE b.tenant_id=app.current_tenant_id() AND b.pay_period_id=(r->>'id')::uuid AND NOT app.financial_batch_subjects_allowed(b.id));
 END IF;
 IF p_table='payroll_batch' THEN
  SELECT * INTO proof FROM app.financial_history_intent i WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=app.current_tenant_id() AND i.user_id=app.current_user_id() AND i.attempt_id=(r->>'history_import_attempt_id')::uuid AND i.company_id=(r->>'company_id')::uuid AND i.period=r->>'pay_period' AND i.cycle_id=(r->>'payroll_cycle_id')::uuid LIMIT 1;
  IF NOT FOUND OR proof.operation NOT IN ('add','edit') OR NOT app.access_financial_action_company('payroll',proof.company_id,proof.operation) OR NOT app.financial_setup_born('payroll_batch',(r->>'id')::uuid) THEN RETURN false;END IF;
  IF p_before IS NULL THEN RETURN p_after->>'status'='draft' AND p_after->>'run_type'='adjustment' AND (p_after->>'employee_count')::integer=0 AND p_after->>'totals' IS NULL AND p_after->>'remarks'='Imported payroll history';END IF;
  SELECT count(*)::integer,jsonb_build_object('gross',sum((i.planned->'values'->>'grossPay')::numeric),'net',sum((i.planned->'values'->>'netPay')::numeric),
   'epfEmployee',sum(coalesce((i.planned->'values'->'statutory'->>'epfEmployee')::numeric,0)),'epfEmployer',sum(coalesce((i.planned->'values'->'statutory'->>'epfEmployer')::numeric,0)),
   'socsoEmployee',sum(coalesce((i.planned->'values'->'statutory'->>'socsoEmployee')::numeric,0)),'socsoEmployer',sum(coalesce((i.planned->'values'->'statutory'->>'socsoEmployer')::numeric,0)),
   'eisEmployee',sum(coalesce((i.planned->'values'->'statutory'->>'eisEmployee')::numeric,0)),'eisEmployer',sum(coalesce((i.planned->'values'->'statutory'->>'eisEmployer')::numeric,0)),
   'pcb',sum(coalesce((i.planned->'values'->'statutory'->>'pcb')::numeric,0))) INTO counted,expected
   FROM app.financial_history_intent i WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=proof.tenant_id AND i.user_id=proof.user_id AND i.attempt_id=proof.attempt_id AND i.company_id=proof.company_id AND i.period=proof.period AND i.cycle_id=proof.cycle_id;
  RETURN (p_after-'status'-'employee_count'-'totals')=(p_before-'status'-'employee_count'-'totals') AND p_before->>'status'='draft' AND p_after->>'status'='closed' AND (p_after->>'employee_count')::integer=counted AND p_after->'totals'=expected;
 END IF;
 SELECT * INTO batch FROM public.payroll_batch WHERE id=(r->>'batch_id')::uuid AND tenant_id=app.current_tenant_id();
 IF NOT FOUND OR batch.history_import_attempt_id IS NULL OR p_before IS NOT NULL THEN RETURN false;END IF;
 SELECT * INTO proof FROM app.financial_history_intent i WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=batch.tenant_id AND i.user_id=app.current_user_id() AND i.attempt_id=batch.history_import_attempt_id AND i.company_id=batch.company_id AND i.employment_id=(r->>'employment_id')::uuid AND i.period=batch.pay_period AND i.cycle_id=batch.payroll_cycle_id;
 IF NOT FOUND OR proof.operation NOT IN ('add','edit') OR NOT app.access_financial_action_company('payroll',proof.company_id,proof.operation) OR NOT app.data_permission_matches(proof.employment_id) THEN RETURN false;END IF;
 expected:=jsonb_build_object('basicSalary',r->>'basic_salary','allowance',r->>'allowance','overtimePay',r->>'overtime_pay','bonus',r->>'bonus','grossPay',r->>'gross_pay','statutory',r->'statutory','otherDeductions',r->>'other_deductions','totalDeductions',r->>'total_deductions','netPay',r->>'net_pay','employerCost',r->>'employer_cost');
 RETURN expected=proof.planned->'values';
END;$$;
REVOKE ALL ON FUNCTION app.financial_history_kernel_approved(text,jsonb,jsonb) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.financial_history_intent_completed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW.operation='delete' THEN
  IF NOT EXISTS(SELECT 1 FROM public.payroll_history_import_revision v JOIN public.payroll_history_import_event e ON e.attempt_id=v.attempt_id AND e.tenant_id=v.tenant_id AND e.kind='reverted' AND e.actor_id=NEW.user_id
   WHERE app.financial_history_row_written('payroll_history_import_revision',to_jsonb(v)) AND app.financial_history_row_written('payroll_history_import_event',to_jsonb(e)) AND v.tenant_id=NEW.tenant_id AND v.attempt_id=NEW.attempt_id AND v.record_id=(NEW.planned->>'recordId')::uuid AND v.kind='revert' AND v.previous_revision_id=(NEW.planned->>'expectedRevisionId')::uuid AND v.snapshot_id IS NOT DISTINCT FROM (NEW.planned->>'restoreSnapshotId')::uuid
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(e.changes) item WHERE item->>'recordId'=v.record_id::text AND item->>'revisionId'=v.id::text AND item->>'snapshotId' IS NOT DISTINCT FROM NEW.planned->>'restoreSnapshotId'))
  THEN RAISE EXCEPTION 'History revert native effect/audit incomplete' USING ERRCODE='42501';END IF;RETURN NULL;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.payroll_history_import_record r
  JOIN public.payroll_history_import_revision v ON v.record_id=r.id AND v.tenant_id=r.tenant_id
  JOIN public.payroll_history_import_snapshot s ON s.id=v.snapshot_id AND s.record_id=r.id AND s.tenant_id=r.tenant_id
  JOIN public.payroll_history_import_event e ON e.attempt_id=v.attempt_id AND e.tenant_id=r.tenant_id AND e.kind='confirmed' AND e.actor_id=NEW.user_id
  WHERE app.financial_history_row_written('payroll_history_import_revision',to_jsonb(v)) AND app.financial_history_row_written('payroll_history_import_snapshot',to_jsonb(s)) AND app.financial_history_row_written('payroll_history_import_event',to_jsonb(e)) AND r.tenant_id=NEW.tenant_id AND r.company_id=NEW.company_id AND r.employment_id=NEW.employment_id AND r.period=NEW.period AND r.cycle_id=NEW.cycle_id
   AND v.attempt_id=NEW.attempt_id AND v.kind IN ('import','correction') AND s."values"=NEW.planned->'values' AND s.value_hash=NEW.planned->>'valueHash'
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(e.changes) changed WHERE changed->>'recordId'=r.id::text AND changed->>'revisionId'=v.id::text AND changed->>'snapshotId'=s.id::text))
 THEN RAISE EXCEPTION 'History native effect/audit incomplete' USING ERRCODE='42501';END IF;
 RETURN NULL;
END;$$;
REVOKE ALL ON FUNCTION app.financial_history_intent_completed() FROM PUBLIC,ai_hr_app;
CREATE CONSTRAINT TRIGGER financial_history_completed AFTER INSERT ON app.financial_history_intent DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.financial_history_intent_completed();
CREATE FUNCTION app.financial_history_noop_completed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW.xact_id<>pg_current_xact_id() OR NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NEW.user_id IS DISTINCT FROM app.current_user_id()
 OR NOT EXISTS(SELECT 1 FROM public.payroll_history_import_event e WHERE e.tenant_id=NEW.tenant_id AND e.attempt_id=NEW.attempt_id AND e.actor_id=NEW.user_id AND e.kind='confirmed' AND e.changes='[]'::jsonb AND app.financial_history_row_written('payroll_history_import_event',to_jsonb(e)))
 THEN RAISE EXCEPTION 'History unchanged confirmation incomplete' USING ERRCODE='42501';END IF;
 RETURN NULL;
END;$$;
REVOKE ALL ON FUNCTION app.financial_history_noop_completed() FROM PUBLIC,ai_hr_app;
CREATE CONSTRAINT TRIGGER financial_history_noop_completed AFTER INSERT ON app.financial_history_noop DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.financial_history_noop_completed();

--> statement-breakpoint
-- Original upload bytes and precomputed preview values cannot be partly redacted. Mixed hidden
-- subjects refuse the complete retained packet; unknown source-only rows remain the uploader's own.
CREATE FUNCTION app.financial_history_plan_visible(p_plan jsonb,p_creator uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE item jsonb;subject text;company text;
BEGIN
 IF NOT app.principal_snapshot_current() OR NOT EXISTS(SELECT 1 FROM public.company co WHERE co.tenant_id=app.current_tenant_id() AND app.financial_history_function_action(co.id,'view')) OR jsonb_typeof(p_plan->'rows') IS DISTINCT FROM 'array' OR jsonb_array_length(p_plan->'rows')>10000 THEN RETURN false;END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(p_plan->'rows') LOOP
  subject:=item->>'employmentId';company:=nullif(item->>'companyId','');
  IF company IS NOT NULL AND (company !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR NOT app.financial_history_function_action(company::uuid,'view')) THEN RETURN false;END IF;
  IF subject IS NULL OR subject='' THEN IF p_creator IS DISTINCT FROM app.current_user_id() THEN RETURN false;END IF;
  ELSIF subject !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR NOT app.data_permission_matches(subject::uuid) THEN RETURN false;END IF;
 END LOOP;RETURN true;
END;$$;
REVOKE ALL ON FUNCTION app.financial_history_plan_visible(jsonb,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.financial_history_plan_visible(jsonb,uuid) TO ai_hr_app;
-- All attempt consumers (including actor labels and event RLS) share the actual packet ceiling.
CREATE OR REPLACE FUNCTION app.payroll_history_attempt_access(subject uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND EXISTS(SELECT 1 FROM public.payroll_history_import_attempt a
 WHERE a.id=subject AND a.tenant_id=app.current_tenant_id() AND(a.created_by=app.current_user_id() OR cardinality(a.company_ids)>0)
 AND app.financial_history_plan_visible(a.plan,a.created_by)
 AND NOT EXISTS(SELECT 1 FROM unnest(a.company_ids) selected(company_id) WHERE NOT app.financial_history_function_action(selected.company_id,'view'))
 AND(cardinality(a.company_ids)>0 OR EXISTS(SELECT 1 FROM public.company co WHERE co.tenant_id=a.tenant_id AND app.financial_history_function_action(co.id,'view'))));
$$;
--> statement-breakpoint
CREATE POLICY financial_history_packet_read ON public.payroll_history_import_attempt AS RESTRICTIVE FOR SELECT TO ai_hr_app
 USING(app.financial_history_plan_visible(plan,created_by));
CREATE POLICY financial_history_subject_read ON public.payroll_history_import_record AS RESTRICTIVE FOR SELECT TO ai_hr_app
 USING(app.data_permission_matches(employment_id) AND app.financial_history_function_action(company_id,'view'));
--> statement-breakpoint
CREATE FUNCTION app.financial_tax_preview_visible(p_preview jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE item jsonb;subject text;
BEGIN
 IF NOT app.principal_snapshot_current() OR jsonb_typeof(p_preview->'employees') IS DISTINCT FROM 'array' OR jsonb_array_length(p_preview->'employees')>10000 THEN RETURN false;END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(p_preview->'employees') LOOP
  subject:=item->>'id';
  IF subject IS NULL OR subject !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR NOT app.data_permission_matches(subject::uuid) THEN RETURN false;END IF;
 END LOOP;RETURN true;
END;$$;
REVOKE ALL ON FUNCTION app.financial_tax_preview_visible(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.financial_tax_preview_visible(jsonb) TO ai_hr_app;
CREATE POLICY financial_tax_packet_read ON public.payroll_tax_basis_preview AS RESTRICTIVE FOR SELECT TO ai_hr_app
 USING(app.financial_tax_preview_visible(preview));
CREATE POLICY financial_tax_batch_read ON public.payroll_tax_basis_batch AS RESTRICTIVE FOR SELECT TO ai_hr_app
 USING(EXISTS(SELECT 1 FROM public.payroll_tax_basis_preview p WHERE p.id=preview_id AND p.tenant_id=payroll_tax_basis_batch.tenant_id));
CREATE POLICY financial_tax_event_read ON public.payroll_tax_basis_event AS RESTRICTIVE FOR SELECT TO ai_hr_app
 USING(EXISTS(SELECT 1 FROM public.payroll_tax_basis_batch b WHERE b.id=batch_id AND b.tenant_id=payroll_tax_basis_event.tenant_id));
CREATE POLICY financial_tax_revision_read ON public.payroll_tax_basis_revision AS RESTRICTIVE FOR SELECT TO ai_hr_app
 USING(app.data_permission_matches(employment_id) OR app.principal_snapshot_current() AND EXISTS(SELECT 1 FROM public.employment own WHERE own.id=employment_id AND own.tenant_id=payroll_tax_basis_revision.tenant_id AND app.is_self_person(own.person_id)));

--> statement-breakpoint
CREATE FUNCTION app.financial_catalog_reference_read() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND EXISTS(SELECT 1 FROM public.company c WHERE c.tenant_id=app.current_tenant_id() AND app.access_financial_action_company('payroll',c.id,'view'));
$$;
CREATE FUNCTION app.financial_formula_runtime_read(p_formula uuid,p_trace boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND EXISTS(SELECT 1 FROM public.pay_formula f WHERE f.id=p_formula AND f.tenant_id=app.current_tenant_id()
 AND (app.financial_catalog_reference_read() AND EXISTS(SELECT 1 FROM public.pay_component c WHERE c.tenant_id=f.tenant_id AND c.archived_at IS NULL AND c.rule->>'kind'='formula_builder' AND c.rule->>'formulaId'=f.formula_id)
 OR p_trace AND EXISTS(SELECT 1 FROM public.pay_formula_evaluation e WHERE e.formula_id=f.id AND e.tenant_id=f.tenant_id AND app.pay_formula_trace_access(e.company_id,e.employment_id,e.read_requirements))));
$$;
REVOKE ALL ON FUNCTION app.financial_catalog_reference_read(),app.financial_formula_runtime_read(uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.financial_catalog_reference_read(),app.financial_formula_runtime_read(uuid,boolean) TO ai_hr_app;
DROP POLICY formula_read ON public.pay_formula;
CREATE POLICY formula_read ON public.pay_formula FOR SELECT USING(tenant_id=app.current_tenant_id() AND (app.financial_setup_catalog_action('view') OR app.financial_formula_runtime_read(id,true)));
DROP POLICY formula_read ON public.pay_formula_revision;
CREATE POLICY formula_read ON public.pay_formula_revision FOR SELECT USING(tenant_id=app.current_tenant_id() AND (app.financial_setup_catalog_action('view') OR app.financial_formula_runtime_read(formula_id,true)));
DROP POLICY formula_read ON public.pay_formula_event;
CREATE POLICY formula_read ON public.pay_formula_event FOR SELECT USING(tenant_id=app.current_tenant_id() AND (app.financial_setup_catalog_action('view') OR app.financial_formula_runtime_read(formula_id,false)));
DROP POLICY formula_read ON public.pay_formula_accumulation;
CREATE POLICY formula_read ON public.pay_formula_accumulation FOR SELECT USING(tenant_id=app.current_tenant_id() AND (app.financial_setup_catalog_action('view') OR app.financial_catalog_reference_read()));
--> statement-breakpoint
CREATE FUNCTION app.financial_formula_materialization_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.access_workforce_storage_owner() THEN RETURN NULL;END IF;
 IF TG_OP<>'INSERT' OR NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NEW.actor_id IS DISTINCT FROM app.current_user_id()
 OR NOT app.financial_batch_intent_allowed(NEW.batch_id,'edit') OR NOT app.access_financial_action_company('payroll',NEW.company_id,'edit')
 OR NOT app.data_permission_matches(NEW.employment_id) OR NOT app.pay_formula_trace_access(NEW.company_id,NEW.employment_id,NEW.read_requirements)
 OR NOT EXISTS(SELECT 1 FROM public.pay_formula_revision r WHERE r.id=NEW.revision_id AND r.formula_id=NEW.formula_id AND r.tenant_id=NEW.tenant_id AND r.content_hash=NEW.payload->>'contentHash')
 OR NOT EXISTS(SELECT 1 FROM public.payroll_batch b JOIN public.payslip p ON p.batch_id=b.id AND p.tenant_id=b.tenant_id WHERE b.id=NEW.batch_id AND b.tenant_id=NEW.tenant_id AND b.company_id=NEW.company_id AND b.pay_period=NEW.period AND b.status IN ('processed','closed') AND p.employment_id=NEW.employment_id)
 THEN RAISE EXCEPTION 'Formula calculation materialization unavailable' USING ERRCODE='42501';END IF;
 RETURN NULL;
END;$$;
REVOKE ALL ON FUNCTION app.financial_formula_materialization_guard() FROM PUBLIC,ai_hr_app;
CREATE CONSTRAINT TRIGGER financial_formula_materialization AFTER INSERT OR UPDATE OR DELETE ON public.pay_formula_evaluation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.financial_formula_materialization_guard();

--> statement-breakpoint
CREATE FUNCTION app.financial_history_revert_begin(p_attempt uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source public.payroll_history_import_attempt%ROWTYPE;event public.payroll_history_import_event%ROWTYPE;item jsonb;r public.payroll_history_import_record%ROWTYPE;current_revision public.payroll_history_import_revision%ROWTYPE;prior public.payroll_history_import_revision%ROWTYPE;
BEGIN
 PERFORM app.access_workforce_write_lock();
 SELECT * INTO source FROM public.payroll_history_import_attempt WHERE id=p_attempt AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND OR NOT app.principal_snapshot_current() THEN RAISE EXCEPTION 'History source unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO event FROM public.payroll_history_import_event WHERE attempt_id=source.id AND tenant_id=source.tenant_id AND kind='confirmed';
 IF NOT FOUND OR jsonb_typeof(event.changes) IS DISTINCT FROM 'array' OR jsonb_array_length(event.changes) NOT BETWEEN 1 AND 10000
 OR EXISTS(SELECT 1 FROM public.payroll_history_import_event WHERE attempt_id=source.id AND kind='reverted') THEN RAISE EXCEPTION 'History revert changed' USING ERRCODE='42501';END IF;
 DELETE FROM app.financial_history_intent WHERE xact_id<pg_snapshot_xmin(pg_current_snapshot());
 FOR item IN SELECT value FROM jsonb_array_elements(event.changes) LOOP
  SELECT * INTO r FROM public.payroll_history_import_record WHERE id=(item->>'recordId')::uuid AND tenant_id=source.tenant_id FOR UPDATE;
  IF NOT FOUND OR NOT app.financial_history_permission(r.company_id,'revert') OR NOT app.financial_history_function_action(r.company_id,'delete') OR NOT app.data_permission_matches(r.employment_id) THEN RAISE EXCEPTION 'History revert subject unavailable' USING ERRCODE='42501';END IF;
  SELECT * INTO current_revision FROM public.payroll_history_import_revision WHERE record_id=r.id AND tenant_id=r.tenant_id ORDER BY ordinal DESC LIMIT 1;
  IF NOT FOUND OR current_revision.id::text IS DISTINCT FROM item->>'revisionId' THEN RAISE EXCEPTION 'History revision changed' USING ERRCODE='40001';END IF;
  prior:=NULL;
  IF item->>'previousRevisionId' IS NOT NULL THEN
   SELECT * INTO prior FROM public.payroll_history_import_revision WHERE id=(item->>'previousRevisionId')::uuid AND record_id=r.id AND tenant_id=r.tenant_id;
   IF NOT FOUND THEN RAISE EXCEPTION 'Prior history revision unavailable' USING ERRCODE='42501';END IF;
  END IF;
  INSERT INTO app.financial_history_intent VALUES(pg_current_xact_id(),r.tenant_id,app.current_user_id(),source.id,r.company_id,r.employment_id,r.period,r.cycle_id,'delete',jsonb_build_object('operation','revert','recordId',r.id,'expectedRevisionId',current_revision.id,'restoreSnapshotId',prior.snapshot_id));
 END LOOP;
END;$$;
REVOKE ALL ON FUNCTION app.financial_history_revert_begin(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.financial_history_revert_begin(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.financial_history_write_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r jsonb:=to_jsonb(NEW);target public.payroll_history_import_record%ROWTYPE;proof app.financial_history_intent%ROWTYPE;company uuid;attempt uuid;
BEGIN
 IF app.access_workforce_storage_owner() THEN RETURN NULL;END IF;
 PERFORM app.access_workforce_write_lock();
 IF TG_OP<>'INSERT' OR NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NOT app.principal_snapshot_current() THEN RAISE EXCEPTION 'History write unavailable' USING ERRCODE='42501';END IF;
 IF TG_TABLE_NAME='payroll_history_import_attempt' THEN
  IF (r->>'created_by')::uuid IS DISTINCT FROM app.current_user_id() OR NOT EXISTS(SELECT 1 FROM public.company co WHERE co.tenant_id=app.current_tenant_id() AND app.financial_history_function_action(co.id,'view')) OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(r->'company_ids') selected(id) WHERE NOT app.financial_history_permission(selected.id::uuid,'import') OR NOT app.financial_history_function_action(selected.id::uuid,'view')) THEN RAISE EXCEPTION 'History upload unavailable' USING ERRCODE='42501';END IF;
  RETURN NULL;
 END IF;
 IF TG_TABLE_NAME='payroll_history_import_event' THEN
  IF (r->>'actor_id')::uuid IS DISTINCT FROM app.current_user_id() THEN RAISE EXCEPTION 'History actor unavailable' USING ERRCODE='42501';END IF;
  IF r->>'kind' IN ('failed','revert_failed') THEN
   IF NOT EXISTS(SELECT 1 FROM public.payroll_history_import_attempt a WHERE a.id=(r->>'attempt_id')::uuid AND a.tenant_id=app.current_tenant_id() AND app.financial_history_plan_visible(a.plan,a.created_by)) THEN RAISE EXCEPTION 'History source unavailable' USING ERRCODE='42501';END IF;RETURN NULL;END IF;
  IF r->>'kind'='confirmed' AND r->'changes'='[]'::jsonb AND EXISTS(SELECT 1 FROM app.financial_history_noop noop_receipt JOIN public.payroll_history_import_attempt a ON a.id=noop_receipt.attempt_id AND a.tenant_id=noop_receipt.tenant_id WHERE noop_receipt.xact_id=pg_current_xact_id() AND noop_receipt.tenant_id=app.current_tenant_id() AND noop_receipt.user_id=app.current_user_id() AND noop_receipt.attempt_id=(r->>'attempt_id')::uuid AND noop_receipt.plan_hash=encode(sha256(convert_to(a.plan::text,'UTF8')),'hex')) THEN RETURN NULL;END IF;
  IF NOT EXISTS(SELECT 1 FROM app.financial_history_intent i WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=NEW.tenant_id AND i.user_id=app.current_user_id() AND i.attempt_id=(r->>'attempt_id')::uuid AND ((r->>'kind'='confirmed' AND i.operation IN ('add','edit')) OR (r->>'kind'='reverted' AND i.operation='delete'))) THEN RAISE EXCEPTION 'History completion owner unavailable' USING ERRCODE='42501';END IF;
  RETURN NULL;
 END IF;
 IF TG_TABLE_NAME='payroll_history_import_record' THEN target:=NEW;
 ELSE SELECT * INTO target FROM public.payroll_history_import_record WHERE id=(r->>'record_id')::uuid AND tenant_id=NEW.tenant_id;END IF;
 IF target.id IS NULL THEN RAISE EXCEPTION 'History record unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO proof FROM app.financial_history_intent i WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=target.tenant_id AND i.user_id=app.current_user_id() AND i.company_id=target.company_id AND i.employment_id=target.employment_id AND i.period=target.period AND i.cycle_id=target.cycle_id;
 IF NOT FOUND OR NOT app.financial_history_function_action(target.company_id,proof.operation) OR NOT app.data_permission_matches(target.employment_id) OR NOT app.financial_history_permission(target.company_id,CASE WHEN proof.operation='delete' THEN 'revert' ELSE 'import' END) THEN RAISE EXCEPTION 'History logical action unavailable' USING ERRCODE='42501';END IF;
 IF TG_TABLE_NAME='payroll_history_import_revision' AND (r->>'attempt_id')::uuid IS DISTINCT FROM proof.attempt_id THEN RAISE EXCEPTION 'History attempt mismatch' USING ERRCODE='42501';END IF;
 IF proof.operation='delete' THEN
  IF TG_TABLE_NAME<>'payroll_history_import_revision' OR r->>'kind'<>'revert' OR (r->>'previous_revision_id') IS DISTINCT FROM (proof.planned->>'expectedRevisionId') OR (r->>'snapshot_id') IS DISTINCT FROM (proof.planned->>'restoreSnapshotId') THEN RAISE EXCEPTION 'History revert effect mismatch' USING ERRCODE='42501';END IF;
 END IF;
 RETURN NULL;
END;$$;
REVOKE ALL ON FUNCTION app.financial_history_write_guard() FROM PUBLIC,ai_hr_app;
DO $$DECLARE name text;BEGIN
 FOREACH name IN ARRAY ARRAY['payroll_history_import_attempt','payroll_history_import_record','payroll_history_import_snapshot','payroll_history_import_revision','payroll_history_import_event'] LOOP
 EXECUTE format('CREATE CONSTRAINT TRIGGER financial_history_action AFTER INSERT OR UPDATE OR DELETE ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.financial_history_write_guard()',name);
 END LOOP;
END;$$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.payroll_tax_basis_permission(target uuid,permission text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 WITH configured AS (SELECT role,allowed,company_id FROM public.payroll_permission_grant WHERE tenant_id=app.current_tenant_id() AND permission_key=permission AND (company_id=target OR company_id IS NULL)),
 effective AS (SELECT role,allowed FROM configured WHERE (company_id=target AND EXISTS(SELECT 1 FROM configured WHERE company_id=target)) OR (company_id IS NULL AND NOT EXISTS(SELECT 1 FROM configured WHERE company_id=target)))
 SELECT permission IN ('payroll.tax-basis.view','payroll.tax-basis.recalculate') AND app.principal_snapshot_current() AND app.can_admin_payroll_for(target) AND (permission='payroll.tax-basis.view' OR app.access_financial_action_company('payroll',target,'edit')) AND
 CASE WHEN EXISTS(SELECT 1 FROM effective) THEN EXISTS(SELECT 1 FROM effective a WHERE a.allowed AND app.has_role_for(a.role,target) AND NOT EXISTS(SELECT 1 FROM effective d WHERE d.role=a.role AND NOT d.allowed))
 ELSE app.has_role_for('hr_admin',target) OR app.has_role_for('super_admin',target) END
$$;

--> statement-breakpoint
CREATE TABLE app.financial_history_written(xact_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,kind text NOT NULL,row_id uuid NOT NULL,row_hash text NOT NULL,PRIMARY KEY(xact_id,tenant_id,user_id,kind,row_id));
ALTER TABLE app.financial_history_written ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.financial_history_written FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.financial_history_capture_written() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.access_workforce_storage_owner() THEN RETURN NULL;END IF;
 DELETE FROM app.financial_history_written WHERE xact_id<pg_snapshot_xmin(pg_current_snapshot());
 INSERT INTO app.financial_history_written VALUES(pg_current_xact_id(),NEW.tenant_id,app.current_user_id(),TG_TABLE_NAME,NEW.id,encode(sha256(convert_to(to_jsonb(NEW)::text,'UTF8')),'hex'));
 RETURN NULL;
END;$$;
CREATE FUNCTION app.financial_history_row_written(p_kind text,p_row jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app.financial_history_written w WHERE w.xact_id=pg_current_xact_id() AND w.tenant_id=app.current_tenant_id() AND w.user_id=app.current_user_id() AND w.kind=p_kind AND w.row_id=(p_row->>'id')::uuid AND w.row_hash=encode(sha256(convert_to(p_row::text,'UTF8')),'hex'));
$$;
REVOKE ALL ON FUNCTION app.financial_history_capture_written(),app.financial_history_row_written(text,jsonb) FROM PUBLIC,ai_hr_app;
DO $$DECLARE name text;BEGIN
 FOREACH name IN ARRAY ARRAY['payroll_history_import_snapshot','payroll_history_import_revision','payroll_history_import_event'] LOOP
 EXECUTE format('CREATE TRIGGER financial_history_written AFTER INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION app.financial_history_capture_written()',name);
 END LOOP;
END;$$;

--> statement-breakpoint
-- Final ordered delegation composition. Execution may preserve ANY native Letter course;
-- delegation of a family cell must prove ALL represented native operations in current claims.
CREATE FUNCTION app.access_financial_current_delegation_floor(t uuid,u uuid,cap text,co uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE native_operation text;selected_company uuid;
BEGIN
 IF t IS DISTINCT FROM app.current_tenant_id() OR u IS DISTINCT FROM app.current_user_id() OR NOT app.principal_snapshot_current() THEN RETURN false;END IF;
 IF app.financial_letter_native_operations(cap) IS NULL THEN RETURN app.financial_letter_current_legacy_allowed(t,u,cap,co);END IF;
 IF co IS NULL THEN
  IF NOT EXISTS(SELECT 1 FROM app.current_grants() g WHERE g.role IN ('hr_admin','super_admin') AND g.company_id IS NULL) THEN RETURN false;END IF;
  FOR selected_company IN SELECT c.id FROM public.company c WHERE c.tenant_id=t AND c.archived_at IS NULL LOOP
   IF NOT app.access_financial_current_delegation_floor(t,u,cap,selected_company) THEN RETURN false;END IF;
  END LOOP;RETURN true;
 END IF;
 FOREACH native_operation IN ARRAY app.financial_letter_native_operations(cap) LOOP
  IF NOT app.letter_current_native_permission(t,u,co,native_operation) THEN RETURN false;END IF;
 END LOOP;RETURN true;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_financial_current_delegation_floor(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.access_can_delegate(p_capability text,p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.access_capability c
  JOIN public.app_user u ON u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id()
  WHERE c.id=p_capability
   AND (p_capability !~ '^(payroll|performance_compensation|letters)\.' OR app.financial_letter_delegation_allowed(u.tenant_id,u.id,p_capability,p_company) AND app.access_financial_current_delegation_floor(u.tenant_id,u.id,p_capability,p_company))
   AND (p_capability !~ '^(organisation|settings)\.' OR app.organisation_settings_delegation_allowed(u.tenant_id,u.id,p_capability,p_company)
    AND app.organisation_settings_current_legacy_allowed(u.tenant_id,u.id,p_capability,p_company)
    AND (p_capability NOT LIKE 'settings.%' OR app.is_group_admin()))
   AND (p_capability !~ '^(claims|leave|attendance)(_configuration)?\.' OR app.module_action_delegation_allowed(u.tenant_id,u.id,p_capability,p_company))
   AND (p_capability NOT LIKE 'payroll_configuration.%' OR p_company IS NULL AND app.financial_setup_delegation_allowed(u.tenant_id,u.id,p_capability,NULL) AND app.financial_setup_current_legacy_allowed(u.tenant_id,u.id,p_capability,NULL))
   AND app.access_function_delegation_floor(p_capability,p_company) AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(c.prerequisites) needed(id) LEFT JOIN public.access_capability prerequisite ON prerequisite.id=needed.id WHERE prerequisite.id IS NULL OR NOT app.access_can_delegate(needed.id,CASE WHEN prerequisite.scope='tenant' THEN NULL ELSE p_company END)) AND app.access_current_capability_source(p_capability,p_company) AND (p_capability NOT IN ('workforce.add','workforce.edit','workforce.delete','workforce.maintain') OR CASE WHEN p_company IS NULL THEN app.is_group_admin() ELSE app.is_admin_for(p_company) END) AND (p_capability !~ '^.+\.(add|edit|delete|approve|issue|execute)$' OR app.access_can_delegate(regexp_replace(p_capability,'[^.]+$','view'),p_company)) AND c.supported AND jsonb_array_length(c.bindings)>0
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
-- The derived rank owner accepts no proposed rank or graph. It computes only the actual stored
-- graph under the same Access/catalogue lock as native maintenance. Runtime callers cannot open
-- a receipt context, write a proof or nominate another tenant. Every physical rank mutation is
-- witnessed separately, including savepoints and a write followed by restoration.
CREATE TABLE app.financial_catalog_source(
 xact_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,row_id uuid NOT NULL,
 operation text NOT NULL,code text NOT NULL,before_hash text NOT NULL,after_hash text NOT NULL,
 PRIMARY KEY(xact_id,tenant_id,user_id,row_id,before_hash,after_hash)
);
CREATE TABLE app.financial_catalog_event(xact_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,row_id uuid NOT NULL,event_id uuid NOT NULL,event_type text NOT NULL,PRIMARY KEY(xact_id,tenant_id,user_id,event_id));
CREATE TABLE app.financial_catalog_rank_open(xact_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,call_id uuid NOT NULL,PRIMARY KEY(xact_id,tenant_id,user_id));
CREATE TABLE app.financial_catalog_rank_effect(xact_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,call_id uuid NOT NULL,row_id uuid NOT NULL,before_hash text NOT NULL,after_hash text NOT NULL,PRIMARY KEY(xact_id,tenant_id,user_id,call_id,row_id,before_hash,after_hash));
ALTER TABLE app.financial_catalog_source ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.financial_catalog_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.financial_catalog_rank_open ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.financial_catalog_rank_effect ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.financial_catalog_source,app.financial_catalog_event,app.financial_catalog_rank_open,app.financial_catalog_rank_effect FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.financial_catalog_statement_lock() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT app.access_workforce_storage_owner() THEN
  PERFORM app.access_workforce_write_lock();
  PERFORM pg_advisory_xact_lock(hashtextextended(app.current_tenant_id()::text||':pay-component-catalog',0));
 END IF;RETURN NULL;
END;$$;
CREATE TRIGGER a00_financial_catalog_lock BEFORE INSERT OR UPDATE OR DELETE ON public.pay_component FOR EACH STATEMENT EXECUTE FUNCTION app.financial_catalog_statement_lock();
CREATE FUNCTION app.financial_catalog_capture() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE before_row jsonb:=CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
 after_row jsonb:=CASE WHEN TG_OP='DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;
 selected jsonb:=CASE WHEN TG_OP='DELETE' THEN before_row ELSE after_row END;call uuid;operation text;
BEGIN
 IF app.access_workforce_storage_owner() OR app.current_user_id() IS NULL THEN RETURN NULL;END IF;
 SELECT call_id INTO call FROM app.financial_catalog_rank_open WHERE xact_id=pg_current_xact_id() AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id();
 IF call IS NOT NULL THEN
  IF TG_OP<>'UPDATE' OR before_row-'resolution_order' IS DISTINCT FROM after_row-'resolution_order' THEN RAISE EXCEPTION 'Catalogue rank effect changed source facts' USING ERRCODE='42501';END IF;
  INSERT INTO app.financial_catalog_rank_effect VALUES(pg_current_xact_id(),app.current_tenant_id(),app.current_user_id(),call,(selected->>'id')::uuid,encode(sha256(convert_to(before_row::text,'UTF8')),'hex'),encode(sha256(convert_to(after_row::text,'UTF8')),'hex')) ON CONFLICT DO NOTHING;
 ELSE
  operation:=CASE WHEN TG_OP='INSERT' THEN 'add' WHEN TG_OP='DELETE' OR TG_OP='UPDATE' AND before_row->>'archived_at' IS NULL AND after_row->>'archived_at' IS NOT NULL THEN 'delete' ELSE 'edit' END;
  INSERT INTO app.financial_catalog_source VALUES(pg_current_xact_id(),app.current_tenant_id(),app.current_user_id(),(selected->>'id')::uuid,operation,selected->>'code',encode(sha256(convert_to(before_row::text,'UTF8')),'hex'),encode(sha256(convert_to(after_row::text,'UTF8')),'hex')) ON CONFLICT DO NOTHING;
 END IF;RETURN NULL;
END;$$;
CREATE TRIGGER financial_catalog_source AFTER INSERT OR UPDATE OR DELETE ON public.pay_component FOR EACH ROW EXECUTE FUNCTION app.financial_catalog_capture();
CREATE FUNCTION app.financial_catalog_capture_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT app.access_workforce_storage_owner() AND NEW.tenant_id=app.current_tenant_id() AND NEW.actor_type='user' AND NEW.actor_id=app.current_user_id() AND NEW.aggregate_type='pay-component' AND NEW.event_type IN ('pay-component.created','pay-component.updated','pay-component.archived','pay-component.unarchived','pay-component.deleted') THEN
  INSERT INTO app.financial_catalog_event VALUES(pg_current_xact_id(),NEW.tenant_id,NEW.actor_id,NEW.aggregate_id,NEW.id,NEW.event_type) ON CONFLICT DO NOTHING;
 END IF;RETURN NEW;
END;$$;
CREATE TRIGGER financial_catalog_event AFTER INSERT ON public.domain_event FOR EACH ROW EXECUTE FUNCTION app.financial_catalog_capture_event();
--> statement-breakpoint
-- Storage-order projection of the canonical typed graph: explicit component operands and builder
-- dependencies, plus fixed_allowances edges to eligible live ORP members. Missing references have
-- rank zero as in planResolutionOrder; a cycle yields NULL and never writes partial ranks.
CREATE FUNCTION app.financial_catalog_expected_ranks() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE nodes jsonb;dependencies jsonb:='{}'::jsonb;ranks jsonb:='{}'::jsonb;node record;dep text;deps text[];operand jsonb;formula jsonb;candidate record;ready boolean;rank integer;progress boolean;round integer;
BEGIN
 SELECT coalesce(jsonb_object_agg(upper(btrim(code)),to_jsonb(c)),'{}'::jsonb) INTO nodes FROM public.pay_component c WHERE tenant_id=app.current_tenant_id();
 IF (SELECT count(*) FROM jsonb_object_keys(nodes))<>(SELECT count(*) FROM public.pay_component WHERE tenant_id=app.current_tenant_id()) THEN RAISE EXCEPTION 'Ambiguous catalogue code' USING ERRCODE='42501';END IF;
 FOR node IN SELECT key,value FROM jsonb_each(nodes) ORDER BY key LOOP
  formula:=node.value->'rule';deps:=ARRAY[]::text[];
  IF formula->>'kind'='percent_of' AND formula->>'base'='component' THEN deps:=array_append(deps,upper(btrim(formula->>'componentCode')));END IF;
  IF formula->>'kind'='formula_builder' THEN
   FOR dep IN SELECT jsonb_array_elements_text(coalesce(formula->'dependencies','[]'::jsonb)) LOOP deps:=array_append(deps,upper(btrim(dep)));END LOOP;
  END IF;
  IF formula->>'kind'='formula' THEN
   FOR operand IN SELECT formula->'start' UNION ALL SELECT term->'operand' FROM jsonb_array_elements(coalesce(formula->'terms','[]'::jsonb)) term LOOP
    IF operand->>'ref'='component' THEN deps:=array_append(deps,upper(btrim(operand->>'code')));END IF;
    IF operand->>'ref'='fixed_allowances' THEN
     FOR candidate IN SELECT key,value FROM jsonb_each(nodes) WHERE key<>node.key LOOP
      IF candidate.value->>'archived_at' IS NULL AND candidate.key<>'BASIC' AND candidate.key<>ALL(ARRAY['EPF','EPF_EMPLOYEE','EPF_EMPLOYER','KWSP','SOCSO','SOCSO_EMPLOYEE','SOCSO_EMPLOYER','PERKESO','EIS','EIS_EMPLOYEE','EIS_EMPLOYER','SIP','PCB','MTD','CP38','HRDF','HRDF_LEVY','HRDC','ZAKAT']) AND candidate.value->>'kind' NOT IN ('contribution','deduction') AND (candidate.value->>'rule' IS NULL OR candidate.value->'rule'->>'kind'='fixed') AND coalesce((candidate.value->>'orp_overtime')::boolean,candidate.value->>'kind'='allowance') THEN deps:=array_append(deps,candidate.key);END IF;
     END LOOP;
    END IF;
   END LOOP;
  END IF;
  SELECT coalesce(array_agg(DISTINCT value ORDER BY value),ARRAY[]::text[]) INTO deps FROM unnest(deps) value WHERE value IS NOT NULL AND value<>'';
  dependencies:=dependencies||jsonb_build_object(node.key,to_jsonb(deps));
 END LOOP;
 FOR round IN 1..greatest(1,(SELECT count(*)::integer FROM jsonb_object_keys(nodes))) LOOP
  progress:=false;
  FOR node IN SELECT key,value FROM jsonb_each(dependencies) ORDER BY key LOOP
   IF ranks ? node.key THEN CONTINUE;END IF;ready:=true;rank:=0;
   FOR dep IN SELECT jsonb_array_elements_text(node.value) LOOP
    IF nodes ? dep AND NOT ranks ? dep THEN ready:=false;EXIT;END IF;
    rank:=greatest(rank,coalesce((ranks->>dep)::integer,0)+1);
   END LOOP;
   IF ready THEN ranks:=ranks||jsonb_build_object(node.key,rank);progress:=true;END IF;
  END LOOP;
  IF (SELECT count(*) FROM jsonb_object_keys(ranks))=(SELECT count(*) FROM jsonb_object_keys(nodes)) THEN RETURN ranks;END IF;
  IF NOT progress THEN RETURN NULL;END IF;
 END LOOP;RETURN NULL;
END;$$;
CREATE FUNCTION app.financial_catalog_rank_effect_allowed(p_before jsonb,p_after jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT p_before-'resolution_order'=p_after-'resolution_order' AND EXISTS(SELECT 1 FROM app.financial_catalog_rank_effect effect WHERE effect.xact_id=pg_current_xact_id() AND effect.tenant_id=app.current_tenant_id() AND effect.user_id=app.current_user_id() AND effect.row_id=(p_after->>'id')::uuid AND effect.before_hash=encode(sha256(convert_to(p_before::text,'UTF8')),'hex') AND effect.after_hash=encode(sha256(convert_to(p_after::text,'UTF8')),'hex'));
$$;
CREATE FUNCTION app.financial_catalog_rank_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE ranks jsonb;
BEGIN
 IF NEW.xact_id<>pg_current_xact_id() OR NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NEW.user_id IS DISTINCT FROM app.current_user_id() OR NOT app.principal_snapshot_current() THEN RAISE EXCEPTION 'Catalogue rank source unavailable' USING ERRCODE='42501';END IF;
 IF NOT EXISTS(SELECT 1 FROM app.financial_catalog_source source JOIN app.financial_catalog_event audit USING(xact_id,tenant_id,user_id,row_id) WHERE source.xact_id=NEW.xact_id AND source.tenant_id=NEW.tenant_id AND source.user_id=NEW.user_id AND app.financial_setup_catalog_function('payComponents.catalogue',source.operation) AND audit.event_type=CASE source.operation WHEN 'add' THEN 'pay-component.created' WHEN 'delete' THEN CASE WHEN source.after_hash=encode(sha256(convert_to('{}','UTF8')),'hex') THEN 'pay-component.deleted' ELSE 'pay-component.archived' END ELSE CASE WHEN audit.event_type='pay-component.unarchived' THEN 'pay-component.unarchived' ELSE 'pay-component.updated' END END) THEN RAISE EXCEPTION 'Catalogue rank requires its actual maintenance source and audit' USING ERRCODE='42501';END IF;
 ranks:=app.financial_catalog_expected_ranks();
 IF ranks IS NULL OR EXISTS(SELECT 1 FROM public.pay_component c WHERE c.tenant_id=NEW.tenant_id AND c.resolution_order IS DISTINCT FROM (ranks->>upper(btrim(c.code)))::integer) THEN RAISE EXCEPTION 'Catalogue graph changed after rank derivation' USING ERRCODE='42501';END IF;RETURN NULL;
END;$$;
CREATE CONSTRAINT TRIGGER financial_catalog_rank_complete AFTER INSERT ON app.financial_catalog_rank_effect DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.financial_catalog_rank_complete();
CREATE FUNCTION app.financial_catalog_recompute_order() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE ranks jsonb;node record;call uuid:=gen_random_uuid();storage_owner boolean:=app.access_workforce_storage_owner();
BEGIN
 IF NOT storage_owner THEN
  PERFORM app.access_workforce_write_lock();
  IF NOT app.financial_setup_catalog_function('payComponents.catalogue','view') OR NOT EXISTS(SELECT 1 FROM app.financial_catalog_source source WHERE source.xact_id=pg_current_xact_id() AND source.tenant_id=app.current_tenant_id() AND source.user_id=app.current_user_id() AND app.financial_setup_catalog_function('payComponents.catalogue',source.operation)) THEN RAISE EXCEPTION 'Catalogue derivation source unavailable' USING ERRCODE='42501';END IF;
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(app.current_tenant_id()::text||':pay-component-catalog',0));
 ranks:=app.financial_catalog_expected_ranks();IF ranks IS NULL THEN RETURN;END IF;
 DELETE FROM app.financial_catalog_source WHERE xact_id<pg_snapshot_xmin(pg_current_snapshot());
 DELETE FROM app.financial_catalog_event WHERE xact_id<pg_snapshot_xmin(pg_current_snapshot());
 DELETE FROM app.financial_catalog_rank_effect WHERE xact_id<pg_snapshot_xmin(pg_current_snapshot());
 DELETE FROM app.financial_catalog_rank_open WHERE xact_id<pg_snapshot_xmin(pg_current_snapshot());
 IF NOT storage_owner THEN INSERT INTO app.financial_catalog_rank_open VALUES(pg_current_xact_id(),app.current_tenant_id(),app.current_user_id(),call);END IF;
 FOR node IN SELECT id,code,resolution_order FROM public.pay_component WHERE tenant_id=app.current_tenant_id() ORDER BY id FOR UPDATE LOOP
  IF node.resolution_order IS DISTINCT FROM (ranks->>upper(btrim(node.code)))::integer THEN UPDATE public.pay_component SET resolution_order=(ranks->>upper(btrim(node.code)))::integer WHERE id=node.id AND tenant_id=app.current_tenant_id();END IF;
 END LOOP;
 IF NOT storage_owner THEN DELETE FROM app.financial_catalog_rank_open WHERE xact_id=pg_current_xact_id() AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND call_id=call;END IF;
END;$$;
REVOKE ALL ON FUNCTION app.financial_catalog_statement_lock(),app.financial_catalog_capture(),app.financial_catalog_capture_event(),app.financial_catalog_expected_ranks(),app.financial_catalog_rank_effect_allowed(jsonb,jsonb),app.financial_catalog_rank_complete(),app.financial_catalog_recompute_order() FROM PUBLIC,ai_hr_app;
GRANT EXECUTE ON FUNCTION app.financial_catalog_recompute_order() TO ai_hr_app;

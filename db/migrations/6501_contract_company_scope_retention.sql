-- Forward repair: preserve existing rows, single FKs and company deletion actions.
-- Same native retention owner; no private table grants, permission changes or historical SQL edits.
DO $retention$
DECLARE prior pg_catalog.pg_proc; after_row pg_catalog.pg_proc; definition text; expected text; replacement text; app_role oid; digest_owner oid;
BEGIN
 SELECT * INTO STRICT prior FROM pg_catalog.pg_proc WHERE oid='app.replan_retained_company_in_use(uuid)'::regprocedure;
 SELECT oid INTO STRICT app_role FROM pg_catalog.pg_roles WHERE rolname='ai_hr_app';
 SELECT relowner INTO STRICT digest_owner FROM pg_catalog.pg_class WHERE oid='app.contract_system_digest'::regclass;
 expected:=$old$
 SELECT COALESCE(app.principal_snapshot_current() AND app.is_admin_for(wanted_company)
  AND EXISTS(SELECT 1 FROM public.company c WHERE c.id=wanted_company AND c.tenant_id=app.current_tenant_id()),false)
  AND (
   EXISTS(SELECT 1 FROM public.contract_case h WHERE h.tenant_id=app.current_tenant_id() AND h.company_id=wanted_company)
   OR EXISTS(SELECT 1 FROM public.contract_configuration h WHERE h.tenant_id=app.current_tenant_id() AND h.company_id=wanted_company)
   OR EXISTS(SELECT 1 FROM public.contract_retirement_custody h WHERE h.tenant_id=app.current_tenant_id() AND h.company_id=wanted_company)
   OR EXISTS(SELECT 1 FROM public.contract_role_assignment h WHERE h.tenant_id=app.current_tenant_id() AND h.company_id=wanted_company)
   OR EXISTS(SELECT 1 FROM public.contract_template h WHERE h.tenant_id=app.current_tenant_id() AND h.company_id=wanted_company)
   OR EXISTS(SELECT 1 FROM public.contract_term h WHERE h.tenant_id=app.current_tenant_id() AND h.company_id=wanted_company)
   OR EXISTS(SELECT 1 FROM public.contract_workflow h WHERE h.tenant_id=app.current_tenant_id() AND h.company_id=wanted_company)
   OR EXISTS(SELECT 1 FROM public.document_signing_document h WHERE h.tenant_id=app.current_tenant_id() AND h.company_id=wanted_company)
   OR EXISTS(SELECT 1 FROM public.payroll_tax_basis_replacement h WHERE h.tenant_id=app.current_tenant_id() AND h.company_id=wanted_company)
   OR EXISTS(SELECT 1 FROM public.probation_access h WHERE h.tenant_id=app.current_tenant_id() AND h.company_id=wanted_company)
   OR EXISTS(SELECT 1 FROM public.probation_activation h WHERE h.tenant_id=app.current_tenant_id() AND h.company_id=wanted_company)
   OR EXISTS(SELECT 1 FROM public.probation_builder_definition h WHERE h.tenant_id=app.current_tenant_id() AND h.company_id=wanted_company)
   OR EXISTS(SELECT 1 FROM public.probation_case h WHERE h.tenant_id=app.current_tenant_id() AND h.company_id=wanted_company)
   OR EXISTS(SELECT 1 FROM public.probation_configuration h WHERE h.tenant_id=app.current_tenant_id() AND h.company_id=wanted_company)
   OR EXISTS(SELECT 1 FROM public.probation_cutover h WHERE h.tenant_id=app.current_tenant_id() AND h.company_id=wanted_company)
   OR EXISTS(SELECT 1 FROM public.probation_intake_entry h WHERE h.tenant_id=app.current_tenant_id() AND h.company_id=wanted_company)
   OR EXISTS(SELECT 1 FROM public.probation_intake_evidence h WHERE h.tenant_id=app.current_tenant_id() AND h.company_id=wanted_company)
   OR EXISTS(SELECT 1 FROM public.probation_offline_final_proposal h WHERE h.tenant_id=app.current_tenant_id() AND h.company_id=wanted_company)
   OR EXISTS(SELECT 1 FROM public.contract_role_assignment h JOIN public.business_unit source ON source.id=h.business_unit_id AND source.tenant_id=h.tenant_id WHERE source.tenant_id=app.current_tenant_id() AND source.company_id=wanted_company)
   OR EXISTS(SELECT 1 FROM public.probation_access h JOIN public.business_unit source ON source.id=h.business_unit_id AND source.tenant_id=h.tenant_id WHERE source.tenant_id=app.current_tenant_id() AND source.company_id=wanted_company)
   OR EXISTS(SELECT 1 FROM public.probation_access h JOIN public.department source ON source.id=h.department_id AND source.tenant_id=h.tenant_id WHERE source.tenant_id=app.current_tenant_id() AND source.company_id=wanted_company)
  );
$old$;
 replacement:=$new$
 SELECT COALESCE(app.principal_snapshot_current() AND app.is_admin_for(wanted_company)
  AND EXISTS(SELECT 1 FROM public.company c WHERE c.id=wanted_company AND c.tenant_id=app.current_tenant_id()),false)
  AND (
   EXISTS(SELECT 1 FROM public.contract_case h WHERE h.tenant_id=app.current_tenant_id() AND h.company_id=wanted_company)
   OR EXISTS(SELECT 1 FROM public.contract_configuration h WHERE h.tenant_id=app.current_tenant_id() AND h.company_id=wanted_company)
   OR EXISTS(SELECT 1 FROM public.contract_retirement_custody h WHERE h.tenant_id=app.current_tenant_id() AND h.company_id=wanted_company)
   OR EXISTS(SELECT 1 FROM public.contract_role_assignment h WHERE h.tenant_id=app.current_tenant_id() AND h.company_id=wanted_company)
   OR EXISTS(SELECT 1 FROM public.contract_template h WHERE h.tenant_id=app.current_tenant_id() AND h.company_id=wanted_company)
   OR EXISTS(SELECT 1 FROM public.contract_term h WHERE h.tenant_id=app.current_tenant_id() AND h.company_id=wanted_company)
   OR EXISTS(SELECT 1 FROM public.contract_workflow h WHERE h.tenant_id=app.current_tenant_id() AND h.company_id=wanted_company)
   OR EXISTS(SELECT 1 FROM public.document_signing_document h WHERE h.tenant_id=app.current_tenant_id() AND h.company_id=wanted_company)
   OR EXISTS(SELECT 1 FROM public.payroll_tax_basis_replacement h WHERE h.tenant_id=app.current_tenant_id() AND h.company_id=wanted_company)
   OR EXISTS(SELECT 1 FROM public.probation_access h WHERE h.tenant_id=app.current_tenant_id() AND h.company_id=wanted_company)
   OR EXISTS(SELECT 1 FROM public.probation_activation h WHERE h.tenant_id=app.current_tenant_id() AND h.company_id=wanted_company)
   OR EXISTS(SELECT 1 FROM public.probation_builder_definition h WHERE h.tenant_id=app.current_tenant_id() AND h.company_id=wanted_company)
   OR EXISTS(SELECT 1 FROM public.probation_case h WHERE h.tenant_id=app.current_tenant_id() AND h.company_id=wanted_company)
   OR EXISTS(SELECT 1 FROM public.probation_configuration h WHERE h.tenant_id=app.current_tenant_id() AND h.company_id=wanted_company)
   OR EXISTS(SELECT 1 FROM public.probation_cutover h WHERE h.tenant_id=app.current_tenant_id() AND h.company_id=wanted_company)
   OR EXISTS(SELECT 1 FROM public.probation_intake_entry h WHERE h.tenant_id=app.current_tenant_id() AND h.company_id=wanted_company)
   OR EXISTS(SELECT 1 FROM public.probation_intake_evidence h WHERE h.tenant_id=app.current_tenant_id() AND h.company_id=wanted_company)
   OR EXISTS(SELECT 1 FROM public.probation_offline_final_proposal h WHERE h.tenant_id=app.current_tenant_id() AND h.company_id=wanted_company)
   OR EXISTS(SELECT 1 FROM public.contract_role_assignment h JOIN public.business_unit source ON source.id=h.business_unit_id AND source.tenant_id=h.tenant_id WHERE source.tenant_id=app.current_tenant_id() AND source.company_id=wanted_company)
   OR EXISTS(SELECT 1 FROM public.probation_access h JOIN public.business_unit source ON source.id=h.business_unit_id AND source.tenant_id=h.tenant_id WHERE source.tenant_id=app.current_tenant_id() AND source.company_id=wanted_company)
   OR EXISTS(SELECT 1 FROM public.probation_access h JOIN public.department source ON source.id=h.department_id AND source.tenant_id=h.tenant_id WHERE source.tenant_id=app.current_tenant_id() AND source.company_id=wanted_company)
   OR EXISTS(SELECT 1 FROM app.contract_system_digest h WHERE h.tenant_id=app.current_tenant_id() AND h.company_id=wanted_company)
  );
$new$;
 IF prior.prosrc IS DISTINCT FROM expected
 OR encode(sha256(convert_to(prior.prosrc,'UTF8')),'hex') IS DISTINCT FROM '40f101a574fce8bb7c3631545db0f963040971b6118564af4132bd01f497fa92'
 OR prior.proowner IS DISTINCT FROM digest_owner OR prior.proowner IS DISTINCT FROM current_user::regrole::oid OR prior.proowner=app_role
 OR prior.prolang IS DISTINCT FROM (SELECT oid FROM pg_catalog.pg_language WHERE lanname='sql')
 OR prior.prosecdef IS DISTINCT FROM true OR prior.provolatile IS DISTINCT FROM 's'
 OR prior.prokind IS DISTINCT FROM 'f' OR prior.proretset IS DISTINCT FROM false OR prior.prorettype IS DISTINCT FROM 'boolean'::regtype
 OR prior.pronargs IS DISTINCT FROM 1 OR prior.pronargdefaults IS DISTINCT FROM 0 OR prior.provariadic IS DISTINCT FROM 0::oid
 OR prior.proargtypes::text IS DISTINCT FROM ('uuid'::regtype::oid)::text OR prior.proargnames IS DISTINCT FROM ARRAY['wanted_company']::text[]
 OR prior.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']::text[]
 OR NOT pg_catalog.has_function_privilege(app_role,prior.oid,'EXECUTE')
 OR EXISTS(SELECT 1 FROM pg_catalog.aclexplode(coalesce(prior.proacl,pg_catalog.acldefault('f',prior.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE')
 OR pg_catalog.pg_has_role(app_role,prior.proowner,'MEMBER') OR pg_catalog.pg_has_role(app_role,prior.proowner,'USAGE') OR pg_catalog.pg_has_role(app_role,prior.proowner,'SET')
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE oid=app_role AND (rolsuper OR rolbypassrls OR rolcreaterole))
 OR (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid='app.contract_system_digest'::regclass) IS DISTINCT FROM true
 OR pg_catalog.has_table_privilege(app_role,'app.contract_system_digest','SELECT')
 THEN RAISE EXCEPTION 'Expected exact native lifecycle retention owner and closed digest boundary'; END IF;
 definition:=pg_catalog.pg_get_functiondef(prior.oid);
 IF length(definition)-length(replace(definition,expected,''))<>length(expected) THEN
  RAISE EXCEPTION 'Expected one exact retention function body';
 END IF;
 -- pg_get_functiondef preserves the actual signature and all declared attributes. Only the body changes.
 EXECUTE replace(definition,expected,replacement);
 SELECT * INTO STRICT after_row FROM pg_catalog.pg_proc WHERE oid=prior.oid;
 IF (to_jsonb(after_row)-'prosrc') IS DISTINCT FROM (to_jsonb(prior)-'prosrc')
 OR after_row.prosrc IS DISTINCT FROM replacement
 OR encode(sha256(convert_to(after_row.prosrc,'UTF8')),'hex') IS DISTINCT FROM '01ce52f540bce675ee5abcb0010323c01e32ac68d23d716cf7cc9bfd43ee9707'
 OR pg_catalog.pg_get_functiondef(prior.oid) IS DISTINCT FROM replace(definition,expected,replacement)
 THEN RAISE EXCEPTION 'Retention replacement changed native metadata or unexpected source bytes'; END IF;
END $retention$;
--> statement-breakpoint
ALTER TABLE app.contract_system_digest ADD CONSTRAINT contract_system_digest_company_tenant_fk
 FOREIGN KEY(company_id,tenant_id) REFERENCES public.company(id,tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.contract_access_member ADD CONSTRAINT contract_access_member_company_tenant_fk
 FOREIGN KEY(company_id,tenant_id) REFERENCES public.company(id,tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.contract_shared_settings ADD CONSTRAINT contract_shared_settings_company_tenant_fk
 FOREIGN KEY(company_id,tenant_id) REFERENCES public.company(id,tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE app.contract_system_digest VALIDATE CONSTRAINT contract_system_digest_company_tenant_fk;
--> statement-breakpoint
ALTER TABLE public.contract_access_member VALIDATE CONSTRAINT contract_access_member_company_tenant_fk;
--> statement-breakpoint
ALTER TABLE public.contract_shared_settings VALIDATE CONSTRAINT contract_shared_settings_company_tenant_fk;
--> statement-breakpoint

CREATE FUNCTION app.financial_setup_bindings_complete() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 WITH expected(relation,trigger_name,handler,trigger_type,deferred) AS (
  SELECT 'public.'||relation,'financial_history_action','app.financial_history_write_guard()'::regprocedure,29,true
  FROM unnest(ARRAY['payroll_history_import_attempt','payroll_history_import_record','payroll_history_import_snapshot',
   'payroll_history_import_revision','payroll_history_import_event']) e(relation)
  UNION ALL
  SELECT 'public.'||relation,'financial_setup_action','app.financial_setup_write_guard()'::regprocedure,29,true
  FROM unnest(ARRAY['payroll_cycle','payroll_policy','company_payroll_config','payslip_information_setting',
   'payroll_anomaly_config','payroll_permission_grant','leave_encashment_policy','employee_loan','employee_cp38',
   'pcb_payment','statutory_report','payroll_tax_basis_preview','payroll_tax_basis_batch',
   'payroll_tax_basis_event','payroll_tax_basis_revision']) e(relation)
  UNION ALL
  SELECT 'public.'||relation,'financial_history_written','app.financial_history_capture_written()'::regprocedure,5,false
  FROM unnest(ARRAY['payroll_history_import_snapshot','payroll_history_import_revision','payroll_history_import_event']) e(relation)
  UNION ALL VALUES
   ('public.tp1_relief','financial_tp1_action','app.financial_tp1_write_guard()'::regprocedure,29,true),
   ('public.loan_repayment','financial_loan_repayment_action','app.access_financial_loan_repayment_guard()'::regprocedure,29,true),
   ('app.financial_history_intent','financial_history_completed','app.financial_history_intent_completed()'::regprocedure,5,true),
   ('app.financial_history_noop','financial_history_noop_completed','app.financial_history_noop_completed()'::regprocedure,5,true)
 )
 SELECT app.pay_component_catalogue_bindings_complete() AND app.payroll_operations_bindings_complete()
 AND NOT EXISTS (
  SELECT FROM expected e WHERE NOT EXISTS (
   SELECT FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
   CROSS JOIN pg_class owner_table
   WHERE t.tgrelid=to_regclass(e.relation) AND t.tgname=e.trigger_name AND t.tgfoid=e.handler
    AND t.tgtype=e.trigger_type AND t.tgenabled IN ('O','A') AND t.tgdeferrable=e.deferred AND t.tginitdeferred=e.deferred
    AND owner_table.oid='public.access_capability'::regclass
    AND p.proowner=owner_table.relowner AND p.prosecdef AND NOT has_function_privilege('ai_hr_app',p.oid,'EXECUTE')
  )
 ) AND NOT EXISTS (
  SELECT FROM (VALUES('app.financial_history_intent'),('app.financial_history_noop'),('app.financial_history_written')) AS proof(relation)
  WHERE has_table_privilege('ai_hr_app',proof.relation,'SELECT,INSERT,UPDATE,DELETE')
 );
$$;
REVOKE ALL ON FUNCTION app.financial_setup_bindings_complete() FROM PUBLIC,ai_hr_app;

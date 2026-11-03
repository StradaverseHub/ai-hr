CREATE FUNCTION app.payroll_operations_bindings_complete() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 WITH kernel(relation) AS (
  VALUES ('payroll_batch'),('pay_period'),('payslip'),('payroll_input'),('payroll_batch_component'),
   ('payroll_statutory_adjustment'),('payroll_status_history'),('payroll_employee_result_history'),
   ('payroll_reprocess_job'),('payroll_step_up_challenge')
 ), expected(relation,trigger_name,handler,trigger_type,deferred) AS (
  SELECT 'public.'||relation,'financial_kernel_action','app.access_payroll_kernel_guard()'::regprocedure,29,true FROM kernel
  UNION ALL SELECT 'public.'||relation,'a_financial_kernel_context','app.financial_kernel_context_record()'::regprocedure,29,false FROM kernel
  UNION ALL VALUES
   ('public.compensation','financial_action_write','app.access_financial_write_guard()'::regprocedure,29,true),
   ('public.employee_statutory_my','financial_statutory_action_write','app.access_financial_statutory_guard()'::regprocedure,29,true),
   ('public.employment_pay_component','financial_fixed_action','app.access_fixed_payroll_guard()'::regprocedure,29,true),
   ('public.payroll_individual_txn','financial_individual_action','app.access_individual_payroll_guard()'::regprocedure,29,true),
   ('public.payroll_individual_txn','financial_individual_effect','app.financial_individual_record()'::regprocedure,29,false),
   ('public.back_pay_run','financial_backpay_action','app.access_backpay_guard()'::regprocedure,31,false),
   ('public.back_pay_line','financial_backpay_action','app.access_backpay_guard()'::regprocedure,31,false),
   ('app.financial_backpay_birth','financial_backpay_birth_complete','app.financial_backpay_birth_validate()'::regprocedure,5,true),
   ('app.financial_backpay_catalog_effect','financial_backpay_catalog_complete','app.financial_backpay_catalog_finish()'::regprocedure,5,true),
   ('app.financial_claim_port_effect','financial_claim_port_complete','app.financial_claim_port_complete()'::regprocedure,5,true)
 )
 SELECT NOT EXISTS (
  SELECT FROM expected e WHERE NOT EXISTS (
   SELECT FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
   CROSS JOIN pg_class owner_table
   WHERE t.tgrelid=to_regclass(e.relation) AND t.tgname=e.trigger_name AND t.tgfoid=e.handler
    AND t.tgtype=e.trigger_type AND t.tgenabled IN ('O','A') AND t.tgdeferrable=e.deferred AND t.tginitdeferred=e.deferred
    AND owner_table.oid='public.access_capability'::regclass
    AND p.proowner=owner_table.relowner AND p.prosecdef AND NOT has_function_privilege('ai_hr_app',p.oid,'EXECUTE')
  )
 ) AND NOT has_table_privilege('ai_hr_app','app.financial_kernel_context','SELECT,INSERT,UPDATE,DELETE');
$$;
REVOKE ALL ON FUNCTION app.payroll_operations_bindings_complete() FROM PUBLIC,ai_hr_app;

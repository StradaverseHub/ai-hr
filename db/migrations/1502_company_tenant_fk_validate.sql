-- Tenant-isolation defence in depth, part 3 of 3 (ADR-0174): check the data, then validate the 1501
-- company/tenant keys.
--
-- Each key is validated in its own subtransaction, so one offending table does not hide the others. A
-- row whose tenant_id differs from its company's tenant is reported with its table and the first
-- offending key, and the migration then fails as a whole: the installation stays on its previous journal
-- row. Nothing is rewritten or deleted automatically; such a row is a data defect for its owner to
-- review. VALIDATE reads past row-level security, as every foreign-key check does, so FORCE RLS tables
-- are checked completely whichever role runs the migration.
--
-- VALIDATE takes SHARE UPDATE EXCLUSIVE on each table and ROW SHARE on company. Pending migrations install
-- in one transaction, so when 1501 lands in the same run its locks (writes wait, reads continue) are held
-- until the commit; the scans use company's (id, tenant_id) unique index.
DO $tenant_company_validate$
DECLARE
  target text;
  constraint_name text;
  problem text;
  report text[] := ARRAY[]::text[];
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'public.access_group_grant',
    'public.access_membership',
    'public.access_user_override',
    'public.ai_agent_promotion',
    'public.app_invitation',
    'public.app_manual_identity_enrollment',
    'public.assignment',
    'public.attendance_allowance_policy',
    'public.attendance_allowance_result',
    'public.attendance_allowance_result_revision',
    'public.attendance_allowance_transfer',
    'public.attendance_allowance_version',
    'public.attendance_group_policy_revision',
    'public.attendance_overtime_calculation',
    'public.attendance_overtime_calculation_evidence',
    'public.attendance_overtime_line',
    'public.attendance_overtime_personnel_context',
    'public.attendance_overtime_policy_part',
    'public.attendance_overtime_source',
    'public.attendance_policy',
    'public.attendance_policy_attested_effect',
    'public.attendance_policy_final_receipt',
    'public.attendance_policy_request_contract',
    'public.attendance_rule',
    'public.attendance_workflow_request',
    'public.attendance_workflow_setting',
    'public.attendance_workflow_template',
    'public.back_pay_run',
    'public.bank_payment_export',
    'public.business_unit',
    'public.clocking_location_company',
    'public.company_bank_profile',
    'public.company_logo',
    'public.company_payroll_config',
    'public.company_statutory_authority',
    'public.company_statutory_my',
    'public.contract_case',
    'public.contract_configuration',
    'public.contract_retirement_custody',
    'public.contract_role_assignment',
    'public.contract_template',
    'public.contract_term',
    'public.contract_workflow',
    'public.cost_center',
    'public.department',
    'public.document_signing_document',
    'public.employee_draft',
    'public.employee_home_configuration_revision',
    'public.employee_id_config',
    'public.employee_import_evaluation_attempt',
    'public.employee_import_evaluation_run_membership',
    'public.employee_import_run',
    'public.employment',
    'public.employment_cost_allocation_set',
    'public.employment_tax_scheme_my',
    'public.employment_tax_selection_my',
    'public.holiday',
    'public.import_attempt_item',
    'public.information_payslip_snapshot',
    'public.it_asset',
    'public.it_asset_request',
    'public.it_provision_def',
    'public.it_requisition',
    'public.job_document',
    'public.job_document_form',
    'public.label_company_assignment',
    'public.lc_case',
    'public.lc_company_config',
    'public.lc_onboarding_case',
    'public.lc_onboarding_case_revision',
    'public.lc_onboarding_private',
    'public.lc_onboarding_private_revision',
    'public.lc_staff',
    'public.lc_step_def',
    'public.lc_v9_case',
    'public.lc_v9_case_revision',
    'public.lc_v9_email_delivery',
    'public.lc_v9_file',
    'public.lc_v9_payroll_handover',
    'public.leave_approval_policy',
    'public.leave_encashment_policy',
    'public.letter_asset',
    'public.letter_automation_rule_version',
    'public.letter_capability_grant',
    'public.letter_generation_batch',
    'public.letter_job',
    'public.letter_merge_field_version',
    'public.letter_policy_version',
    'public.letter_record',
    'public.letter_template',
    'public.letter_template_version',
    'public.location',
    'public.mobile_offline_context',
    'public.notification',
    'public.overtime_pattern_version_company',
    'public.overtime_source_settlement',
    'public.pay_formula_evaluation',
    'public.pay_formula_test',
    'public.pay_period',
    'public.payroll_anomaly_config',
    'public.payroll_attendance_allowance_source',
    'public.payroll_batch',
    'public.payroll_cycle',
    'public.payroll_history_import_record',
    'public.payroll_individual_txn',
    'public.payroll_permission_grant',
    'public.payroll_policy',
    'public.payroll_tax_basis_batch',
    'public.payroll_tax_basis_event',
    'public.payroll_tax_basis_preview',
    'public.payroll_tax_basis_replacement',
    'public.payroll_tax_basis_revision',
    'public.payslip_information_setting',
    'public.pcb_payment',
    'public.performance_assessment_catalogue',
    'public.performance_assessment_profit_achievement',
    'public.performance_assessment_unit_exclusion',
    'public.performance_kpi_library',
    'public.performance_leader_seat',
    'public.performance_onehr_calibration',
    'public.performance_onehr_review',
    'public.personnel_import_assistance_attempt',
    'public.position',
    'public.probation_access',
    'public.probation_activation',
    'public.probation_builder_definition',
    'public.probation_case',
    'public.probation_configuration',
    'public.probation_cutover',
    'public.probation_intake_entry',
    'public.probation_intake_evidence',
    'public.probation_offline_final_proposal',
    'public.replacement_holiday',
    'public.replacement_holiday_policy',
    'public.replacement_holiday_revision',
    'public.review_cycle',
    'public.reward_company_exclusion',
    'public.reward_policy_group_target',
    'public.reward_unit',
    'public.role_assignment',
    'public.shift',
    'public.statutory_report',
    'public.teras_outcome_record',
    'public.toil_policy',
    'app.assistant_own_leave_review',
    'app.attendance_policy_company_epoch'
  ] LOOP
    constraint_name := pg_catalog.split_part(target, '.', 2) || '_company_tenant_fk';
    BEGIN
      EXECUTE pg_catalog.format('ALTER TABLE %s VALIDATE CONSTRAINT %I', target::regclass, constraint_name);
    EXCEPTION WHEN foreign_key_violation THEN
      GET STACKED DIAGNOSTICS problem = PG_EXCEPTION_DETAIL;
      report := report || pg_catalog.format('%s: %s', target, problem);
    END;
  END LOOP;
  IF pg_catalog.cardinality(report) > 0 THEN
    RAISE EXCEPTION 'Rows reference a company of another tenant; review them before validating'
      USING ERRCODE = 'foreign_key_violation', DETAIL = pg_catalog.array_to_string(report, '; ');
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname LIKE '%\_company\_tenant\_fk' AND contype = 'f' AND NOT convalidated
      AND confrelid = 'public.company'::regclass
  ) THEN
    RAISE EXCEPTION 'A company/tenant key is still not validated' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
END $tenant_company_validate$;

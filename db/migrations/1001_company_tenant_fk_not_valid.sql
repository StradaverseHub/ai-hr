-- Tenant-isolation defence in depth, part 2 of 3 (ADR-0174): every tenant-scoped table that stores a
-- `company_id` ties it to a company of the SAME tenant. Until now these tables referenced `company(id)`
-- alone, so a writer in tenant A could store a row naming tenant B's company id (for example a group
-- admin's department: its policy asks `app.is_admin_for(company_id)`, which answers from grants). Such a
-- row never exposed B's data, but it is a dangling cross-tenant reference. The composite key
-- `company(id, tenant_id)` exists since 0313 for exactly this; four tables already use it.
--
-- NOT VALID: existing rows are not scanned here; 1002 checks the data and validates. Every INSERT and
-- every UPDATE of company_id or tenant_id is checked from this migration on. Writers were reviewed:
-- application writes stamp the session tenant under RLS, company moves and reparenting stay inside one
-- tenant, and nothing updates company.tenant_id. MATCH SIMPLE keeps a NULL company_id (group-wide rows)
-- valid. Each ON DELETE action mirrors the table's existing company FK, so deleting a company behaves
-- exactly as before; the existing single-column FKs stay. No grant, policy or column changes.
--
-- The set is every table with tenant_id, company_id and a company_id -> company(id) FK in the journal
-- before 1000 (146). test/tenant-company-fk.test.ts fails if a table with that shape lacks the key.
ALTER TABLE public.access_group_grant ADD CONSTRAINT access_group_grant_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.access_membership ADD CONSTRAINT access_membership_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.access_user_override ADD CONSTRAINT access_user_override_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ai_agent_promotion ADD CONSTRAINT ai_agent_promotion_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.app_invitation ADD CONSTRAINT app_invitation_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.app_manual_identity_enrollment ADD CONSTRAINT app_manual_identity_enrollment_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.assignment ADD CONSTRAINT assignment_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.attendance_allowance_policy ADD CONSTRAINT attendance_allowance_policy_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.attendance_allowance_result ADD CONSTRAINT attendance_allowance_result_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.attendance_allowance_result_revision ADD CONSTRAINT attendance_allowance_result_revision_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.attendance_allowance_transfer ADD CONSTRAINT attendance_allowance_transfer_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.attendance_allowance_version ADD CONSTRAINT attendance_allowance_version_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.attendance_group_policy_revision ADD CONSTRAINT attendance_group_policy_revision_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE RESTRICT NOT VALID;
--> statement-breakpoint
ALTER TABLE public.attendance_overtime_calculation ADD CONSTRAINT attendance_overtime_calculation_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE RESTRICT NOT VALID;
--> statement-breakpoint
ALTER TABLE public.attendance_overtime_calculation_evidence ADD CONSTRAINT attendance_overtime_calculation_evidence_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.attendance_overtime_line ADD CONSTRAINT attendance_overtime_line_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE RESTRICT NOT VALID;
--> statement-breakpoint
ALTER TABLE public.attendance_overtime_personnel_context ADD CONSTRAINT attendance_overtime_personnel_context_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE RESTRICT NOT VALID;
--> statement-breakpoint
ALTER TABLE public.attendance_overtime_policy_part ADD CONSTRAINT attendance_overtime_policy_part_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE RESTRICT NOT VALID;
--> statement-breakpoint
ALTER TABLE public.attendance_overtime_source ADD CONSTRAINT attendance_overtime_source_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE RESTRICT NOT VALID;
--> statement-breakpoint
ALTER TABLE public.attendance_policy ADD CONSTRAINT attendance_policy_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.attendance_policy_attested_effect ADD CONSTRAINT attendance_policy_attested_effect_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.attendance_policy_final_receipt ADD CONSTRAINT attendance_policy_final_receipt_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE RESTRICT NOT VALID;
--> statement-breakpoint
ALTER TABLE public.attendance_policy_request_contract ADD CONSTRAINT attendance_policy_request_contract_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE RESTRICT NOT VALID;
--> statement-breakpoint
ALTER TABLE public.attendance_rule ADD CONSTRAINT attendance_rule_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.attendance_workflow_request ADD CONSTRAINT attendance_workflow_request_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.attendance_workflow_setting ADD CONSTRAINT attendance_workflow_setting_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.attendance_workflow_template ADD CONSTRAINT attendance_workflow_template_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.back_pay_run ADD CONSTRAINT back_pay_run_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.bank_payment_export ADD CONSTRAINT bank_payment_export_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.business_unit ADD CONSTRAINT business_unit_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.clocking_location_company ADD CONSTRAINT clocking_location_company_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.company_bank_profile ADD CONSTRAINT company_bank_profile_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.company_logo ADD CONSTRAINT company_logo_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.company_payroll_config ADD CONSTRAINT company_payroll_config_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.company_statutory_authority ADD CONSTRAINT company_statutory_authority_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.company_statutory_my ADD CONSTRAINT company_statutory_my_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.contract_case ADD CONSTRAINT contract_case_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.contract_configuration ADD CONSTRAINT contract_configuration_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.contract_retirement_custody ADD CONSTRAINT contract_retirement_custody_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.contract_role_assignment ADD CONSTRAINT contract_role_assignment_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.contract_template ADD CONSTRAINT contract_template_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.contract_term ADD CONSTRAINT contract_term_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.contract_workflow ADD CONSTRAINT contract_workflow_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.cost_center ADD CONSTRAINT cost_center_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.department ADD CONSTRAINT department_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.document_signing_document ADD CONSTRAINT document_signing_document_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.employee_draft ADD CONSTRAINT employee_draft_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.employee_home_configuration_revision ADD CONSTRAINT employee_home_configuration_revision_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.employee_id_config ADD CONSTRAINT employee_id_config_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.employee_import_evaluation_attempt ADD CONSTRAINT employee_import_evaluation_attempt_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.employee_import_evaluation_run_membership ADD CONSTRAINT employee_import_evaluation_run_membership_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.employee_import_run ADD CONSTRAINT employee_import_run_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.employment ADD CONSTRAINT employment_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.employment_cost_allocation_set ADD CONSTRAINT employment_cost_allocation_set_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.employment_tax_scheme_my ADD CONSTRAINT employment_tax_scheme_my_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.employment_tax_selection_my ADD CONSTRAINT employment_tax_selection_my_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.holiday ADD CONSTRAINT holiday_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.import_attempt_item ADD CONSTRAINT import_attempt_item_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.information_payslip_snapshot ADD CONSTRAINT information_payslip_snapshot_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.it_asset ADD CONSTRAINT it_asset_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.it_asset_request ADD CONSTRAINT it_asset_request_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.it_provision_def ADD CONSTRAINT it_provision_def_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.it_requisition ADD CONSTRAINT it_requisition_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.job_document ADD CONSTRAINT job_document_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.job_document_form ADD CONSTRAINT job_document_form_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.label_company_assignment ADD CONSTRAINT label_company_assignment_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.lc_case ADD CONSTRAINT lc_case_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.lc_company_config ADD CONSTRAINT lc_company_config_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.lc_onboarding_case ADD CONSTRAINT lc_onboarding_case_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.lc_onboarding_case_revision ADD CONSTRAINT lc_onboarding_case_revision_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.lc_onboarding_private ADD CONSTRAINT lc_onboarding_private_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.lc_onboarding_private_revision ADD CONSTRAINT lc_onboarding_private_revision_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.lc_staff ADD CONSTRAINT lc_staff_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.lc_step_def ADD CONSTRAINT lc_step_def_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.lc_v9_case ADD CONSTRAINT lc_v9_case_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.lc_v9_case_revision ADD CONSTRAINT lc_v9_case_revision_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.lc_v9_email_delivery ADD CONSTRAINT lc_v9_email_delivery_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.lc_v9_file ADD CONSTRAINT lc_v9_file_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.lc_v9_payroll_handover ADD CONSTRAINT lc_v9_payroll_handover_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.leave_approval_policy ADD CONSTRAINT leave_approval_policy_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.leave_encashment_policy ADD CONSTRAINT leave_encashment_policy_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.letter_asset ADD CONSTRAINT letter_asset_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.letter_automation_rule_version ADD CONSTRAINT letter_automation_rule_version_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.letter_capability_grant ADD CONSTRAINT letter_capability_grant_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.letter_generation_batch ADD CONSTRAINT letter_generation_batch_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.letter_job ADD CONSTRAINT letter_job_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.letter_merge_field_version ADD CONSTRAINT letter_merge_field_version_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.letter_policy_version ADD CONSTRAINT letter_policy_version_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.letter_record ADD CONSTRAINT letter_record_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.letter_template ADD CONSTRAINT letter_template_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.letter_template_version ADD CONSTRAINT letter_template_version_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.location ADD CONSTRAINT location_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.mobile_offline_context ADD CONSTRAINT mobile_offline_context_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.notification ADD CONSTRAINT notification_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.overtime_pattern_version_company ADD CONSTRAINT overtime_pattern_version_company_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE RESTRICT NOT VALID;
--> statement-breakpoint
ALTER TABLE public.overtime_source_settlement ADD CONSTRAINT overtime_source_settlement_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE RESTRICT NOT VALID;
--> statement-breakpoint
ALTER TABLE public.pay_formula_evaluation ADD CONSTRAINT pay_formula_evaluation_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.pay_formula_test ADD CONSTRAINT pay_formula_test_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.pay_period ADD CONSTRAINT pay_period_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_anomaly_config ADD CONSTRAINT payroll_anomaly_config_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_attendance_allowance_source ADD CONSTRAINT payroll_attendance_allowance_source_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_batch ADD CONSTRAINT payroll_batch_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_cycle ADD CONSTRAINT payroll_cycle_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_history_import_record ADD CONSTRAINT payroll_history_import_record_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_individual_txn ADD CONSTRAINT payroll_individual_txn_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_permission_grant ADD CONSTRAINT payroll_permission_grant_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_policy ADD CONSTRAINT payroll_policy_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_tax_basis_batch ADD CONSTRAINT payroll_tax_basis_batch_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_tax_basis_event ADD CONSTRAINT payroll_tax_basis_event_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_tax_basis_preview ADD CONSTRAINT payroll_tax_basis_preview_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_tax_basis_replacement ADD CONSTRAINT payroll_tax_basis_replacement_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_tax_basis_revision ADD CONSTRAINT payroll_tax_basis_revision_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payslip_information_setting ADD CONSTRAINT payslip_information_setting_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.pcb_payment ADD CONSTRAINT pcb_payment_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.performance_assessment_catalogue ADD CONSTRAINT performance_assessment_catalogue_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.performance_assessment_profit_achievement ADD CONSTRAINT performance_assessment_profit_achievement_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.performance_assessment_unit_exclusion ADD CONSTRAINT performance_assessment_unit_exclusion_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.performance_kpi_library ADD CONSTRAINT performance_kpi_library_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.performance_leader_seat ADD CONSTRAINT performance_leader_seat_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.performance_onehr_calibration ADD CONSTRAINT performance_onehr_calibration_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.performance_onehr_review ADD CONSTRAINT performance_onehr_review_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.personnel_import_assistance_attempt ADD CONSTRAINT personnel_import_assistance_attempt_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.position ADD CONSTRAINT position_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.probation_access ADD CONSTRAINT probation_access_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.probation_activation ADD CONSTRAINT probation_activation_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.probation_builder_definition ADD CONSTRAINT probation_builder_definition_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.probation_case ADD CONSTRAINT probation_case_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.probation_configuration ADD CONSTRAINT probation_configuration_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.probation_cutover ADD CONSTRAINT probation_cutover_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.probation_intake_entry ADD CONSTRAINT probation_intake_entry_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.probation_intake_evidence ADD CONSTRAINT probation_intake_evidence_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.probation_offline_final_proposal ADD CONSTRAINT probation_offline_final_proposal_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.replacement_holiday ADD CONSTRAINT replacement_holiday_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.replacement_holiday_policy ADD CONSTRAINT replacement_holiday_policy_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.replacement_holiday_revision ADD CONSTRAINT replacement_holiday_revision_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.review_cycle ADD CONSTRAINT review_cycle_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.reward_company_exclusion ADD CONSTRAINT reward_company_exclusion_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.reward_policy_group_target ADD CONSTRAINT reward_policy_group_target_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.reward_unit ADD CONSTRAINT reward_unit_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.role_assignment ADD CONSTRAINT role_assignment_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.shift ADD CONSTRAINT shift_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.statutory_report ADD CONSTRAINT statutory_report_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.teras_outcome_record ADD CONSTRAINT teras_outcome_record_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.toil_policy ADD CONSTRAINT toil_policy_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT assistant_own_leave_review_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE app.attendance_policy_company_epoch ADD CONSTRAINT attendance_policy_company_epoch_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE CASCADE NOT VALID;

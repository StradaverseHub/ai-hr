-- The complete publisher binds the closed action registry in one transaction.
-- Repeat the storage-owned readiness checks as one restricted database predicate.
CREATE FUNCTION app.access_all_function_bindings_complete() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT app.financial_letter_bindings_complete()
  AND app.letter_operations_bindings_complete()
  AND app.payroll_operations_bindings_complete()
  AND app.performance_cycle_bindings_complete()
  AND app.onehr_plan_acknowledgement_bindings_complete()
  AND app.onehr_panel_feedback_bindings_complete()
  AND app.onehr_review_bindings_complete()
  AND app.organisation_settings_bindings_complete()
  AND app.financial_setup_bindings_complete()
  AND app.pay_component_catalogue_bindings_complete()
  AND app.workforce_imports_bindings_complete()
  AND app.workforce_drafts_bindings_complete()
  AND app.workforce_import_revert_bindings_complete()
  AND app.workforce_records_bindings_complete()
  AND app.profile_maintenance_bindings_complete()
  AND app.employee_master_view_bindings_complete()
  AND app.employee_master_definition_bindings_complete()
  AND app.report_category_bindings_complete()
  AND app.claim_configuration_bindings_complete()
  AND app.leave_configuration_bindings_complete()
  AND app.attendance_schedule_bindings_complete()
  AND app.attendance_shift_bindings_complete()
  AND app.clocking_site_bindings_complete()
  AND app.attendance_schedule_controls_bindings_complete()
  AND app.leave_employee_records_delete_bindings_complete()
  AND app.leave_own_application_bindings_complete()
  AND app.leave_on_behalf_application_bindings_complete()
  AND app.leave_approval_template_bindings_complete()
  AND app.leave_approval_company_bindings_complete()
  AND app.claim_own_bindings_complete()
  AND app.claim_decision_bindings_complete()
  AND app.claim_administration_bindings_complete()
  AND app.notice_author_bindings_complete()
  AND app.lifecycle_assigned_task_bindings_complete()
  AND app.lifecycle_delivery_bindings_complete()
  AND app.lifecycle_hr_removal_bindings_complete()
  AND app.rewards_read_bindings_complete()
  AND app.rewards_entry_bindings_complete()
  AND app.rewards_decision_bindings_complete()
  AND app.rewards_cancellation_bindings_complete()
  AND app.rewards_posting_bindings_complete()
  AND NOT EXISTS (
   SELECT FROM app.access_function_action action
   JOIN app.access_function_definition definition USING (function_key)
   LEFT JOIN public.access_capability capability ON capability.id=action.capability_id
   LEFT JOIN public.access_capability parent ON parent.id=action.parent_capability
   WHERE capability.id IS NULL OR capability.scope<>definition.scope
    OR action.parent_capability IS NOT NULL AND (parent.id IS NULL OR parent.scope<>definition.scope)
  );
$$;
REVOKE ALL ON FUNCTION app.access_all_function_bindings_complete() FROM PUBLIC,ai_hr_app;

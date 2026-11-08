/** Infrastructure annotations never remove files or grant release authority. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {validatePostgresEvidence} from './postgres-evidence.mjs';
import {CI_POLICY} from './policy-version.mjs';
import {NATIVE_HELPER_SOURCES} from './native-next-helper-sources.mjs';
import {REWARDS_NATIVE_SOURCES} from './rewards-native-sources.mjs';
import {EMPLOYEE_LIFECYCLE_PROFILE,employeeLifecycleFile} from './employee-lifecycle-profile.mjs';
import {EMPLOYEE_LIFECYCLE_SOURCES,assertEmployeeLifecycleSourceClosure} from './employee-lifecycle-sources.mjs';
export const SINGLETON_VERSION=1;
const measured=[
 'test/access-editor-native-owner-presentation.test.ts',
 'test/analytics-termination-lateral.test.ts',
 'test/attendance-shared-submission-bridge.test.ts',
 'test/employee-choice-assignment-membership-plan.test.ts',
 'test/employee-choice-organisation-plan.test.ts',
 'test/leave-inquiry-read-cost.test.ts',
 'test/module-read-jit-diagnostic.test.ts',
 'test/payroll-audit-processing-rc.test.ts',
 'test/rewards-audit-policy-native.test.ts',
 'test/rewards-audited-read-prototype.test.ts',
 'test/performance/attendance-punch-index.profile.test.ts',
 'test/performance/claims-preview-index.profile.test.ts',
 'test/performance/leave-pending-index.profile.test.ts',
 'test/performance/personnel-narrow-overview.test.ts',
 'test/performance/personnel-narrow-production.test.ts',
 'test/performance/personnel-native-list-plan.test.ts',
 'test/performance/personnel-retained-million.test.ts',
 'test/performance/workforce-bounded-read-plan.test.ts',
];
export const SINGLETON_FILES=Object.freeze({
 ...Object.fromEntries(measured.map(file=>[file,'controlled-database-v1'])),
 ...Object.fromEntries(EMPLOYEE_LIFECYCLE_PROFILE.files.map(({file})=>[file,'controlled-database-v1'])),
 'test/runtime-ready-admission-native.test.ts':'linux-systemd-nginx-v1',
 'test/notification-worker-lifecycle.test.ts':'notification-cluster-v1',
 'test/notification-worker-native-plan-diagnostic.test.ts':'notification-cluster-v1',
 'test/runtime-next-admission-native.test.ts':'linux-next-postgres-v1',
});
export const singletonProfile=file=>Object.hasOwn(SINGLETON_FILES,file)?SINGLETON_FILES[file]:null;
export const nativeNextUnit=unit=>unit?.singleton?.profile==='linux-next-postgres-v1';
export const singletonControllerPath=(unit,workspace,runId)=>nativeNextUnit(unit)?'/var/lib/aihr-native-controller/'+runId+'/automation':workspace+'/automation';
export const singletonJobName=unit=>nativeNextUnit(unit)?`native-test (${unit.id})`:unit.kind==='browser'?`browser (${unit.engine})`:`test (${unit.id})`;
export const singletonKind=profile=>profile==='linux-systemd-nginx-v1'?'nodb':'db';
export function assertSingletonSelection(files){assert(!files.some(file=>singletonProfile(file))||files.length===1,'Infrastructure-sensitive focused tests require an actual sole-file selection');}
export function assertSingletonCoverage(suite,read){
 for(const file of suite){
  const text=read(file),profile=singletonProfile(file);
  const focusedGuard=/AIHR_FOCUSED_(?:TESTS|SUITE_CAPACITY|EVIDENCE_DIR)/.test(text)&&/\.(?:skipIf|runIf)\s*\(/.test(text);
  assert(!focusedGuard,'Focused-only conditional cases require registered full-CI singleton admission: '+file);
  if(profile){
   if(employeeLifecycleFile(file)){
    const helper=read('test/performance/employee-choice-lifecycle-admission.ts');
    assert(/^import \{admitEmployeeChoiceLifecycle\} from '\.\/performance\/employee-choice-lifecycle-admission';$/m.test(text),'Closed lifecycle entry must import the actual shared owner');
    const lines=text.split('\n'),direct="admitEmployeeChoiceLifecycle('"+file+"');",declaration="const file='"+file+"';",combined="const file='"+file+"',lifecycle=admitEmployeeChoiceLifecycle(file);";
    const line=lines.findIndex(value=>value.startsWith(direct)||value===combined||value==='const lifecycle=admitEmployeeChoiceLifecycle(file);'&&lines.includes(declaration));
    const call=line>=0?lines.slice(0,line).join('\n').length:-1;
    const firstCase=/\b(?:beforeAll|beforeEach|afterAll|it|test)\s*\(/.exec(text)?.index??Infinity;
    assert(call>=0&&call<firstCase,'Closed lifecycle entry must actually admit its exact complete file before hooks');
    assert(/export function admitEmployeeChoiceLifecycle\(file:string\)\{\s*const admission=admitSingletonTest\(file\);/.test(helper),'Shared lifecycle owner must FIRST perform actual singleton admission');
   }else assert(/\badmitSingletonTest\s*\(/.test(text),'Registered singleton lacks actual full/focused admission: '+file);
  }
 }
}
export const singletonDescriptor=file=>{const profile=singletonProfile(file);return profile?{version:SINGLETON_VERSION,profile,workers:1,isolation:profile==='linux-next-postgres-v1'?'job-host-and-postgres-cluster':profile==='linux-systemd-nginx-v1'?'job-host':'job-postgres-cluster'}:null;};
export function assertSingletonUnit(unit){
 assert(unit&&unit.files?.length===1,'Singleton unit requires exactly one complete test file');
 const expected=singletonDescriptor(unit.files[0]);assert(expected,'Unregistered singleton file');
 assert.deepEqual(unit.singleton,expected,'Changed singleton execution profile');assert.equal(unit.kind,singletonKind(expected.profile));
 return expected;
}
// Fixed reviewed component closure. These are source bindings, not privileges,
// new profiles, skip exemptions or permission to execute an arbitrary candidate.
const componentSources=Object.freeze({
 // Actual external-AST import graph plus explicit migration/duration/locked-install inputs.
 // The nine common singleton members are supplied below exactly once.
 'test/module-read-jit-diagnostic.test.ts':Object.freeze([
  ".github/ci/candidate-environment.mjs",".github/ci/db-duration-hints.json",".github/ci/db-scheduling.mjs",
  ".github/ci/employee-lifecycle-profile.json",".github/ci/employee-lifecycle-profile.mjs",".github/ci/employee-lifecycle-sources.mjs",
  ".github/ci/native-next-helper-sources.mjs",".github/ci/native-next-installation.mjs",".github/ci/notification-catalogue-replay.mjs",
  ".github/ci/postgres-evidence.mjs",".github/ci/rewards-native-sources.mjs","core/absence-days.ts",
  "core/access-configuration-lock.ts","core/agent-action-pause-scope.ts","core/agent-action-pause.ts",
  "core/agent-proposal.ts","core/ai-centre-control.ts","core/ai-config.ts","core/ai-governance.ts",
  "core/ai-principal.ts","core/ai-provider-authority.ts","core/ai-provider-readiness.ts",
  "core/ai-provider-snapshot.ts","core/ai-read-transaction.ts","core/ai-spend-capability.ts",
  "core/ai-spend-task.ts","core/analytics.ts","core/approvals.ts",
  "core/assistant-actions/performance-postimage-proof.ts","core/assistant-grant.ts","core/assistant-question-budget.ts",
  "core/attendance-allowance-context.ts","core/attendance-allowance-selection.ts","core/attendance-allowance.ts",
  "core/attendance-application-history.ts","core/attendance-application-review.ts","core/attendance-calc.ts",
  "core/attendance-card-import.ts","core/attendance-card.ts","core/attendance-clock-data.ts",
  "core/attendance-clock-read.ts","core/attendance-clock-subject.ts","core/attendance-clock.ts",
  "core/attendance-clocking-import.ts","core/attendance-derive.ts","core/attendance-device.ts",
  "core/attendance-explain.ts","core/attendance-group-policy.ts","core/attendance-policy-schedule.ts",
  "core/attendance-punch-change.ts","core/attendance-rotation.ts","core/attendance-rule.ts",
  "core/attendance-shortfall.ts","core/attendance-timeline.ts","core/attendance-trace.ts",
  "core/attendance-workflow.ts","core/attendance.ts","core/audit-chain-arming.ts",
  "core/back-pay.ts","core/benefit-scheme.ts","core/carrier-principal.ts",
  "core/clocking-location.ts","core/closed-payroll-correction-authority.ts","core/comp.ts",
  "core/company-organisation.ts","core/company-refs.ts","core/company-tier.ts",
  "core/contract-record-authority.ts","core/cost-allocation-import.ts","core/cp38.ts",
  "core/credit-ot-overlap.ts","core/delegated-request-effect.ts","core/dependents.ts",
  "core/duplicate-person.ts","core/ea-override.ts","core/email-design/service.ts",
  "core/emergency-contacts.ts","core/employee-code-claims.ts","core/employee-id-config.ts",
  "core/employment-company.ts","core/employment-cost-allocations.ts","core/employment-status-sql.ts",
  "core/employment-status.ts","core/entitlement-archive.ts","core/entitlement-scheme-view.ts",
  "core/entitlement-template.ts","core/entitlement-types.ts","core/entitlements.ts",
  "core/ess-view.ts","core/exit-date-authority.ts","core/hire-correction.ts",
  "core/holiday-calendar-read.ts","core/holiday-replacement-read.ts","core/holidays.ts",
  "core/import-history.ts","core/individual-import-job.ts","core/individual-txn-import.ts",
  "core/individual-txn-status.ts","core/information-correction-history.ts","core/information-correction.ts",
  "core/knowledge-base.ts","core/leave-adjustment.ts","core/leave-approval-consolidation.ts",
  "core/leave-approval-policy.ts","core/leave-approval-template.ts","core/leave-bf-import.ts",
  "core/leave-charge.ts","core/leave-compute.ts","core/leave-credit-history.ts",
  "core/leave-credit-live.ts","core/leave-credit-request.ts","core/leave-dependency-lock.ts",
  "core/leave-encashment.ts","core/leave-escalation.ts","core/leave-formula.ts",
  "core/leave-generation.ts","core/leave-group-origin-sql.ts","core/leave-history-import.ts",
  "core/leave-import.ts","core/leave-inquiry.ts","core/leave-ledger-archive.ts",
  "core/leave-org-criteria.ts","core/leave-override.ts","core/leave-split-review.ts",
  "core/leave-type-refs.ts","core/leave.ts","core/loans-compute.ts",
  "core/loans.ts","core/mobile-clock-attempt.ts","core/mobile-clock-policy.ts",
  "core/mobile-integrity-key.ts","core/mobile-submission-state.ts","core/module-gate.ts",
  "core/module-presentation-read.ts","core/movement-attachments.ts","core/movement-kinds.ts",
  "core/movement-type-controls.ts","core/movement-type.ts","core/movement.ts",
  "core/my-leave.ts","core/my-team-scope.ts","core/org-chart-window.ts",
  "core/org-chart.ts","core/org-criteria.ts","core/org.ts",
  "core/organisation-write-policy.ts","core/own-person.ts","core/pay-component-catalog-lock.ts",
  "core/pay-components.ts","core/pay-display-category.ts","core/pay-formula-ai.ts",
  "core/pay-formula-personnel.ts","core/pay-formula-runtime.ts","core/pay-formula.ts",
  "core/pay-rule-ai.ts","core/pay-rule.ts","core/payroll-anomaly-detectors.ts",
  "core/payroll-anomaly.ts","core/payroll-attendance-allowance.ts","core/payroll-audit/append.ts",
  "core/payroll-audit/inputs.ts","core/payroll-closed-runs.ts","core/payroll-config.ts",
  "core/payroll-coverage.ts","core/payroll-cycle.ts","core/payroll-employment-eligibility.ts",
  "core/payroll-formula-inputs.ts","core/payroll-history-import.ts","core/payroll-history-lock.ts",
  "core/payroll-history-revisions.ts","core/payroll-individual-txn.ts","core/payroll-leave.ts",
  "core/payroll-overtime-pattern.ts","core/payroll-period-lock.ts","core/payroll-permissions-admin.ts",
  "core/payroll-policy-config.ts","core/payroll-policy.ts","core/payroll-readiness.ts",
  "core/payroll-run-group.ts","core/payroll-run-selection.ts","core/payroll-self-metadata.ts",
  "core/payroll-tax-basis-notices.ts","core/payroll-tax-basis-read.ts","core/payroll-tax-basis.ts",
  "core/payroll-txn-import.ts","core/payroll-view.ts","core/payroll.ts",
  "core/payslip-cp38-line.ts","core/payslip-earning-lines.ts","core/payslip-information.ts",
  "core/payslip-recompute.ts","core/payslip-segment.ts","core/pcb-exemptions.ts",
  "core/pcb-explain.ts","core/pcb-payment.ts","core/performance-provider-source.ts",
  "core/performance.ts","core/person-photo.ts","core/personnel-private-search.ts",
  "core/personnel-quality.ts","core/personnel-read-bounds.ts","core/probation-effect-authority.ts",
  "core/profile-attachments.ts","core/profile-edit-policy.ts","core/profile-edit.ts",
  "core/profile-options.ts","core/profile-routing.ts","core/profile.ts",
  "core/qualifications.ts","core/read-composition-principal.ts","core/read.ts",
  "core/replacement-eligibility.ts","core/replacement-request.ts","core/reporting.ts",
  "core/roster-write-batches.ts","core/roster.ts","core/schedule-group-controls.ts",
  "core/schedule-shift-eligibility.ts","core/shift-arrangement-resolve.ts","core/shift-arrangement.ts",
  "core/shift-break-rules.ts","core/shift-ot-window.ts","core/state-vocabulary.ts",
  "core/statutory-authority.ts","core/statutory-filed.ts","core/statutory-source-lock.ts",
  "core/system-labels.ts","core/tax-relief.ts","core/tenant-settings.ts",
  "core/termination-reason-catalog.ts","core/termination-reason.ts","core/toil.ts",
  "core/tp3.ts","core/week-pattern.ts","core/workforce-access.ts",
  "core/workforce-code.ts","db/admission.ts","db/background-read-admission.ts",
  "db/capacity.ts","db/client.ts","db/events.ts",
  "db/migrations/0000_luxuriant_anita_blake.sql","db/migrations/0001_rls_grants_constraints.sql","db/migrations/0002_role_gate_structural_writes.sql",
  "db/migrations/0003_crazy_mole_man.sql","db/migrations/0004_slice1_comp_statutory_rls.sql","db/migrations/0005_tiresome_newton_destine.sql",
  "db/migrations/0006_holiday_rls.sql","db/migrations/0007_brief_masked_marvel.sql","db/migrations/0008_attendance_rls.sql",
  "db/migrations/0009_nervous_nehzno.sql","db/migrations/0010_payroll_rls.sql","db/migrations/0011_payroll_immutability.sql",
  "db/migrations/0012_principal_bootstrap.sql","db/migrations/0013_payroll_batch_rls_tighten.sql","db/migrations/0014_company_hierarchy_statutory.sql",
  "db/migrations/0015_company_tree_helpers_rls.sql","db/migrations/0016_company_scoped_authz.sql","db/migrations/0017_fix_employment_self_policy.sql",
  "db/migrations/0018_employment_cost_allocation.sql","db/migrations/0019_archivable_entities.sql","db/migrations/0020_role_assignment_super_admin_guard.sql",
  "db/migrations/0021_employee_tax_profile.sql","db/migrations/0022_payroll_input.sql","db/migrations/0023_role_assignment_subdelegation.sql",
  "db/migrations/0024_payroll_bonus.sql","db/migrations/0025_payslip_days_worked.sql","db/migrations/0026_statutory_report.sql",
  "db/migrations/0027_attendance_time_engine.sql","db/migrations/0028_attendance_correction.sql","db/migrations/0029_greedy_butterfly.sql",
  "db/migrations/0030_org_catalog_integrity.sql","db/migrations/0031_leave_type_code_integrity.sql","db/migrations/0032_famous_giant_girl.sql",
  "db/migrations/0033_chunky_redwing.sql","db/migrations/0034_wet_the_spike.sql","db/migrations/0035_performance_rls.sql",
  "db/migrations/0036_true_senator_kelly.sql","db/migrations/0037_domain_event_subject_rls.sql","db/migrations/0038_powerful_vision.sql",
  "db/migrations/0039_kb_rls.sql","db/migrations/0040_cool_microchip.sql","db/migrations/0041_onboarding_fns.sql",
  "db/migrations/0042_faulty_hellion.sql","db/migrations/0043_gorgeous_wolfpack.sql","db/migrations/0044_statutory_ruleset_rls.sql",
  "db/migrations/0045_easy_cobalt_man.sql","db/migrations/0046_statutory_pack_rls.sql","db/migrations/0047_slow_gargoyle.sql",
  "db/migrations/0048_claims_rls.sql","db/migrations/0049_bored_nebula.sql","db/migrations/0050_performance_goal_rls.sql",
  "db/migrations/0051_harsh_albert_cleary.sql","db/migrations/0052_performance_checkin_rls.sql","db/migrations/0053_heavy_magma.sql",
  "db/migrations/0054_peer_feedback_rls.sql","db/migrations/0055_slow_kabuki.sql","db/migrations/0056_shocking_tarantula.sql",
  "db/migrations/0057_calibration_rls.sql","db/migrations/0058_chunky_beast.sql","db/migrations/0059_ai_provider_config_rls.sql",
  "db/migrations/0060_compensation_read_admin_or_self.sql","db/migrations/0061_sleepy_nehzno.sql","db/migrations/0062_jittery_kronos.sql",
  "db/migrations/0063_minor_red_shift.sql","db/migrations/0064_sour_the_hunter.sql","db/migrations/0065_pay_component_rls.sql",
  "db/migrations/0066_curly_cable.sql","db/migrations/0067_pay_period_rls.sql","db/migrations/0068_epf_citizenship.sql",
  "db/migrations/0069_designated_paymaster.sql","db/migrations/0070_drop_paymaster_fk.sql","db/migrations/0071_pay_component_grants.sql",
  "db/migrations/0072_company_bank_profile.sql","db/migrations/0073_pii_key.sql","db/migrations/0074_audit_hash_chain.sql",
  "db/migrations/0075_shift_roster.sql","db/migrations/0076_toil.sql","db/migrations/0077_toil_expiry_action.sql",
  "db/migrations/0078_notification_engine.sql","db/migrations/0079_notification_cursor_sequence.sql","db/migrations/0080_pay_component_ea_rounding.sql",
  "db/migrations/0081_company_payroll_config.sql","db/migrations/0082_payroll_batch_scope.sql","db/migrations/0083_leave_eligibility.sql",
  "db/migrations/0084_leave_mandatory_documents.sql","db/migrations/0085_leave_multi_approval.sql","db/migrations/0086_leave_approval_policy.sql",
  "db/migrations/0087_state_holidays.sql","db/migrations/0088_leave_type_i18n.sql","db/migrations/0089_leave_cycle.sql",
  "db/migrations/0090_job_grades.sql","db/migrations/0091_resignation_request.sql","db/migrations/0092_statutory_component_override.sql",
  "db/migrations/0093_feedback_module.sql","db/migrations/0094_feedback_deployed_status.sql","db/migrations/0095_payroll_config_cutoffs.sql",
  "db/migrations/0096_performance_lifecycle.sql","db/migrations/0097_leave_duration.sql","db/migrations/0098_leave_document_config.sql",
  "db/migrations/0099_job_function_partner_roles.sql","db/migrations/0100_holiday_groups.sql","db/migrations/0101_claim_item_rate_config.sql",
  "db/migrations/0102_tp1_self_relief.sql","db/migrations/0103_pay_component_rule.sql","db/migrations/0104_feedback_refute_reopen.sql",
  "db/migrations/0105_leave_payroll_impact.sql","db/migrations/0106_emergency_leave_link.sql","db/migrations/0107_employment_provisional_end.sql",
  "db/migrations/0108_hierarchy_visibility.sql","db/migrations/0109_hierarchy_visibility_rls.sql","db/migrations/0110_employment_review.sql",
  "db/migrations/0111_location_master_data.sql","db/migrations/0112_org_holiday_hierarchy.sql","db/migrations/0113_replacement_leave_controls.sql",
  "db/migrations/0114_payroll_ot_breakdown.sql","db/migrations/0115_fixed_transaction.sql","db/migrations/0116_payroll_individual_txn.sql",
  "db/migrations/0117_employee_cp38.sql","db/migrations/0118_employee_statutory_zakat.sql","db/migrations/0119_ea_override.sql",
  "db/migrations/0120_loan_management.sql","db/migrations/0121_rls_leak_fixes.sql","db/migrations/0122_ot_source_provenance.sql",
  "db/migrations/0123_toil_first_schedule_consent.sql","db/migrations/0124_emergency_unpaid_consent.sql","db/migrations/0125_maternity_allowance_s37.sql",
  "db/migrations/0126_holiday_tentative.sql","db/migrations/0127_payroll_policy.sql","db/migrations/0128_payroll_policy_rls.sql",
  "db/migrations/0129_hourly_leave_period.sql","db/migrations/0130_payroll_policy_config.sql","db/migrations/0131_leave_per_date_approval.sql",
  "db/migrations/0132_partial_leave_cancellation.sql","db/migrations/0133_leave_backdating_limit.sql","db/migrations/0134_leave_policy_company_scope.sql",
  "db/migrations/0135_location_holiday_calendars.sql","db/migrations/0136_business_unit_master.sql","db/migrations/0137_employee_dependent.sql",
  "db/migrations/0138_leave_partial_approval_single_aggregate.sql","db/migrations/0139_shift_template.sql","db/migrations/0140_shift_weekly_pattern.sql",
  "db/migrations/0141_feedback_restore.sql","db/migrations/0142_half_day_schedule.sql","db/migrations/0143_leave_encashment.sql",
  "db/migrations/0144_clocking_locations_geofencing.sql","db/migrations/0145_org_catalog_description.sql","db/migrations/0146_attendance_request_management.sql",
  "db/migrations/0147_leave_type_custom_messages.sql","db/migrations/0148_review_cycle_eligibility_rules.sql","db/migrations/0149_leave_approval_rule_matrix.sql",
  "db/migrations/0150_payroll_cycle_master.sql","db/migrations/0151_real_auth_workos.sql","db/migrations/0152_fixed_transaction_run_type.sql",
  "db/migrations/0153_company_logo.sql","db/migrations/0154_attendance_allowance.sql","db/migrations/0155_leave_type_expiry.sql",
  "db/migrations/0156_resignation_request_attachment.sql","db/migrations/0157_shared_system_labels.sql","db/migrations/0158_tp1_relief_categories.sql",
  "db/migrations/0159_leave_type_min_advance_days.sql","db/migrations/0160_probation_reminders_review_documents.sql","db/migrations/0161_employment_default_shift.sql",
  "db/migrations/0162_shift_grace_and_type.sql","db/migrations/0163_shift_ot_rule.sql","db/migrations/0164_claim_limits_by_grade.sql",
  "db/migrations/0165_custom_report.sql","db/migrations/0166_compensation_remarks.sql","db/migrations/0167_compensation_updated_at.sql",
  "db/migrations/0168_person_profile_fields.sql","db/migrations/0169_leave_type_description.sql","db/migrations/0170_leave_approval_templates.sql",
  "db/migrations/0171_org_heads_for_approval.sql","db/migrations/0172_payroll_cycle_description.sql","db/migrations/0173_payroll_status_control.sql",
  "db/migrations/0174_payroll_policy_defaults_release.sql","db/migrations/0175_holiday_group_inheritance.sql","db/migrations/0176_individual_txn_period_keyed.sql",
  "db/migrations/0177_individual_txn_component.sql","db/migrations/0178_leave_type_ess_view_config.sql","db/migrations/0179_leave_type_visual_config.sql",
  "db/migrations/0180_profile_option.sql","db/migrations/0181_leave_type_day_type_inclusion.sql","db/migrations/0182_leave_type_leave_unit.sql",
  "db/migrations/0183_job_grade_name_uq.sql","db/migrations/0184_employment_info_fields.sql","db/migrations/0185_dependent_family_fields.sql",
  "db/migrations/0186_employee_document.sql","db/migrations/0187_payroll_policy_code.sql","db/migrations/0188_shift_type.sql",
  "db/migrations/0189_system_label_short_code.sql","db/migrations/0190_leave_year_config.sql","db/migrations/0191_leave_year_opening_rule.sql",
  "db/migrations/0192_leave_type_employee_visibility.sql","db/migrations/0193_leave_type_ess_placement.sql","db/migrations/0194_holiday_master_fields_and_group_holiday.sql",
  "db/migrations/0195_company_general_profile.sql","db/migrations/0196_delegation_self_service_rls.sql","db/migrations/0197_shift_shared_library.sql",
  "db/migrations/0198_socso_eis_statutory_controls.sql","db/migrations/0199_bank_custom_holder.sql","db/migrations/0200_identity_tax_controls.sql",
  "db/migrations/0201_socso_eis_category.sql","db/migrations/0202_pay_period_unlock_escape.sql","db/migrations/0203_employer_bears_epf.sql",
  "db/migrations/0204_attendance_rule_library.sql","db/migrations/0205_benefit_scheme.sql","db/migrations/0206_profile_option_description.sql",
  "db/migrations/0207_dashboard_layout.sql","db/migrations/0208_leave_type_duplicate_application_policy.sql","db/migrations/0209_leave_type_allow_negative_balance.sql",
  "db/migrations/0210_nationality_full_iso_seed.sql","db/migrations/0211_employee_id_config.sql","db/migrations/0212_dashboard_card_config.sql",
  "db/migrations/0213_dashboard_layout_shape_and_shortcuts.sql","db/migrations/0214_employee_passport_identity.sql","db/migrations/0215_person_permanent_correspondence_address.sql",
  "db/migrations/0216_employment_join_date.sql","db/migrations/0217_employment_dates_units.sql","db/migrations/0218_leave_approval_policy_grade_group.sql",
  "db/migrations/0219_assignment_business_unit.sql","db/migrations/0220_scheme_leave_combined_limit.sql","db/migrations/0225_leave_type_probation_eligibility.sql",
  "db/migrations/0230_delegation_scope_reason.sql","db/migrations/0240_employment_blacklist.sql","db/migrations/0241_leave_formula_explanation.sql",
  "db/migrations/0245_leave_entitlement_recalc_audit.sql","db/migrations/0250_dependent_child_relief.sql","db/migrations/0255_leave_calendar_rename.sql",
  "db/migrations/0261_employee_id_template_fields.sql","db/migrations/0265_attendance_multi_punch.sql","db/migrations/0270_employment_payment_method.sql",
  "db/migrations/0275_company_bank_multi_account.sql","db/migrations/0276_company_statutory_authority.sql","db/migrations/0277_compensation_delete_guard.sql",
  "db/migrations/0279_user_archive_and_login_block.sql","db/migrations/0280_job_run.sql","db/migrations/0281_fix_consume_invitation_ambiguous.sql",
  "db/migrations/0282_leave_year_delete_guard.sql","db/migrations/0286_delegation_org_scope.sql","db/migrations/0287_leave_approval_escalation.sql",
  "db/migrations/0288_approval_history.sql","db/migrations/0289_pay_component_label.sql","db/migrations/0290_compensation_pay_mode_term.sql",
  "db/migrations/0293_dependent_education_fields.sql","db/migrations/0294_operator_role.sql","db/migrations/0295_operator_console.sql",
  "db/migrations/0296_employee_dashboard_fixed_row.sql","db/migrations/0297_pay_component_pcb_classification.sql","db/migrations/0298_shared_labels_criteria_backfill.sql",
  "db/migrations/0299_dashboard_card_audience.sql","db/migrations/0300_person_salutation.sql","db/migrations/0301_passport_issuing_country.sql",
  "db/migrations/0302_employee_device.sql","db/migrations/0303_leave_type_year_cycle_override.sql","db/migrations/0304_person_phone_fields.sql",
  "db/migrations/0305_dependent_relationship_options.sql","db/migrations/0306_subject_to_hrdf.sql","db/migrations/0307_company_default_currency.sql",
  "db/migrations/0308_employee_qualification.sql","db/migrations/0309_backfill_dob_from_ic.sql","db/migrations/0310_leave_type_year_cycle_override_a2c.sql",
  "db/migrations/0311_company_default_payroll_cycle.sql","db/migrations/0312_invitation_privilege_escalation.sql","db/migrations/0313_module_entitlements.sql",
  "db/migrations/0314_toil_accrual_payroll_partner_read.sql","db/migrations/0315_job_grade_description.sql","db/migrations/0316_leave_balance_source_and_upl.sql",
  "db/migrations/0317_feedback_blocked_status.sql","db/migrations/0318_feedback_plan_revision.sql","db/migrations/0319_attendance_rule_tenant_wide.sql",
  "db/migrations/0320_approval_history_count.sql","db/migrations/0321_feedback_attachment_stage.sql","db/migrations/0322_person_emergency_contact_register.sql",
  "db/migrations/0323_feedback_block_answer.sql","db/migrations/0324_payroll_settings_relocation.sql","db/migrations/0325_leave_type_rule_columns.sql",
  "db/migrations/0327_shared_leave_group_max_days_per_application.sql","db/migrations/0329_movement_scheduled_apply_once.sql","db/migrations/0330_pay_component_resolution_order.sql",
  "db/migrations/0331_employee_status_state_machine.sql","db/migrations/0332_review_cycle_include_probation.sql","db/migrations/0333_annual_carry_expiry_six_months.sql",
  "db/migrations/0334_leave_type_rules_repoint_guard.sql","db/migrations/0335_scheme_category_rounding_thresholds_application_limits.sql","db/migrations/0337_employee_draft.sql",
  "db/migrations/0338_termination_movement.sql","db/migrations/0340_movement_event_type.sql","db/migrations/0341_import_history_and_disabled_individual.sql",
  "db/migrations/0342_leave_shared_group.sql","db/migrations/0343_leave_type_max_consecutive.sql","db/migrations/0344_leave_type_country.sql",
  "db/migrations/0345_module_change_request.sql","db/migrations/0346_company_statutory_tier.sql","db/migrations/0347_usage_snapshot_unique.sql",
  "db/migrations/0348_feedback_reporter_label.sql","db/migrations/0349_leave_type_carry_percent.sql","db/migrations/0350_tenant_closure_and_suspension_windows.sql",
  "db/migrations/0351_platform_plane.sql","db/migrations/0352_leave_limit_period_and_negative_floor.sql","db/migrations/0353_leave_adjustment_batch.sql",
  "db/migrations/0354_toil_accrual_request_approval_dates.sql","db/migrations/0355_employee_id_manual_override_default_on.sql","db/migrations/0356_disabled_spouse_and_child_relief_table.sql",
  "db/migrations/0357_leave_adjustment_batch_grants.sql","db/migrations/0358_leave_type_rounding_bands.sql","db/migrations/0365_leave_type_override_rules.sql",
  "db/migrations/0370_drop_leave_type_expiry.sql","db/migrations/0375_leave_type_accrual_day_and_unconfigured.sql","db/migrations/0376_leave_type_earning_method_clearout.sql",
  "db/migrations/0380_replacement_leave_config.sql","db/migrations/0381_replacement_leave_request.sql","db/migrations/0385_leave_year_config_reset.sql",
  "db/migrations/0386_carry_percent_clears_cap.sql","db/migrations/0387_leave_type_role.sql","db/migrations/0388_employment_contract_information.sql",
  "db/migrations/0390_notice_board.sql","db/migrations/0391_notice_dashboard_card.sql","db/migrations/0392_claim_draft_status.sql",
  "db/migrations/0393_pay_component_display_category.sql","db/migrations/0394_attendance_calc_stage1.sql","db/migrations/0395_attendance_ot_split_backfill.sql",
  "db/migrations/0396_entitlement_template_and_eligibility.sql","db/migrations/0397_entitlement_reset_archive.sql","db/migrations/0398_entitlement_reset_archive_capture.sql",
  "db/migrations/0399_leave_generation_run.sql","db/migrations/0400_leave_generation_run_item.sql","db/migrations/0403_payroll_recalc_mark.sql",
  "db/migrations/0404_leave_calendar_off_dashboard.sql","db/migrations/0406_feedback_attachment_plan_stage.sql","db/migrations/0408_claim_mileage_rate_and_form_field.sql",
  "db/migrations/0409_eligibility_rule_company_scoped_write.sql","db/migrations/0410_entitlement_reset_drop_old_layers.sql","db/migrations/0411_attendance_calc_trace.sql",
  "db/migrations/0413_back_pay.sql","db/migrations/0414_rounding_bands_two_decimals.sql","db/migrations/0415_employee_draft_reserved_code.sql",
  "db/migrations/0416_leave_ledger_reset_archive.sql","db/migrations/0417_shift_general_fields.sql","db/migrations/0418_shift_ot_window.sql",
  "db/migrations/0419_clocking_location_radius_and_link.sql","db/migrations/0420_location_branch.sql","db/migrations/0421_employment_shift_arrangement.sql",
  "db/migrations/0422_payroll_policy_deduct_absent_days.sql","db/migrations/0424_plan_ot.sql","db/migrations/0425_payroll_anomaly.sql",
  "db/migrations/0426_fixed_transaction_no_overlap.sql","db/migrations/0427_payroll_import_codes.sql","db/migrations/0428_claim_block_limit_and_mileage_type.sql",
  "db/migrations/0429_shift_cutoff_and_day_kinds.sql","db/migrations/0430_payroll_statutory_adjustment.sql","db/migrations/0432_individual_txn_source.sql",
  "db/migrations/0433_employee_list_columns.sql","db/migrations/0434_attendance_request_remark_kind_attachment.sql","db/migrations/0435_claim_policy_claim_item.sql",
  "db/migrations/0436_roster_assignment_delete_guard.sql","db/migrations/0437_individual_txn_consumed.sql","db/migrations/0438_leave_shared_group_ess_placement.sql",
  "db/migrations/0439_ot_rounding_mode.sql","db/migrations/0440_assignment_company.sql","db/migrations/0441_individual_txn_intended_cycle.sql",
  "db/migrations/0443_payroll_cycle_updated_at.sql","db/migrations/0446_payslip_coverage_dates.sql","db/migrations/0447_leave_type_min_advance_day_type.sql",
  "db/migrations/0448_tp1_status_values.sql","db/migrations/0449_tp1_approval.sql","db/migrations/0450_statutory_old_ic_and_country_code.sql",
  "db/migrations/0451_assistant_substrate.sql","db/migrations/0452_agent_proposal_ledger.sql","db/migrations/0453_custom_report_app_grant.sql",
  "db/migrations/0454_anomaly_finding_proposal_link.sql","db/migrations/0455_domain_event_recent_idx.sql","db/migrations/0456_pay_item_orp_flags.sql",
  "db/migrations/0457_shift_colour_flex_break.sql","db/migrations/0458_profile_change_decision_reason.sql","db/migrations/0459_clocking_location_shared.sql",
  "db/migrations/0460_entitlement_reset_archive_layers.sql","db/migrations/0461_clocking_location_report_label.sql","db/migrations/0462_leave_type_default_entitlement_table.sql",
  "db/migrations/0463_recalc_audit_grade_and_effective_date.sql","db/migrations/0464_employment_attendance_rule_id.sql","db/migrations/0465_tenant_suspension_window_control_plane.sql",
  "db/migrations/0466_statutory_report_filing.sql","db/migrations/0467_leave_approval_step_fixed_approver.sql","db/migrations/0468_leave_approval_step_alternates.sql",
  "db/migrations/0469_leave_credit_register.sql","db/migrations/0470_payroll_run_exists.sql","db/migrations/0471_cancel_approved_leave.sql",
  "db/migrations/0472_own_leave_request_approvers.sql","db/migrations/0473_rounding_bands_inclusive_ranges.sql","db/migrations/0474_employment_card_id.sql",
  "db/migrations/0475_entitlement_rounding.sql","db/migrations/0476_pcb_payment.sql","db/migrations/0479_payroll_input_ot_derivation.sql",
  "db/migrations/0480_employee_tp3.sql","db/migrations/0482_system_testing.sql","db/migrations/0483_schedule_group_working_week.sql",
  "db/migrations/0484_location_drop_holiday_calendar.sql","db/migrations/0485_marriage_leave.sql","db/migrations/0486_toil_extended_hours_on_workday.sql",
  "db/migrations/0487_leave_credit_claim_lines.sql","db/migrations/0488_tp3_section_d_lp.sql","db/migrations/0489_tp3_exemption_used.sql",
  "db/migrations/0490_leave_history_import.sql","db/migrations/0491_epf_manual_amount.sql","db/migrations/0492_payslip_statutory_admin_or_self.sql",
  "db/migrations/0497_leave_bf_import.sql","db/migrations/0498_own_reporting_managers.sql","db/migrations/0499_ea_signatory.sql",
  "db/migrations/0500_attendance_clock_evidence.sql","db/migrations/0502_payslip_information.sql","db/migrations/0503_employment_tax_scheme_my.sql",
  "db/migrations/0504_tax_scheme_historical_employer.sql","db/migrations/0505_employment_tax_selection_my.sql","db/migrations/0506_pay_component_vola.sql",
  "db/migrations/0507_attendance_attention_review.sql","db/migrations/0508_my_team_authorized_subject_set.sql","db/migrations/0509_person_tax_circumstance.sql",
  "db/migrations/0510_employee_draft_company_scope.sql","db/migrations/0511_company_delete_authority.sql","db/migrations/0512_own_replacement_request_deciders.sql",
  "db/migrations/0513_payslip_information_payment_fields.sql","db/migrations/0514_fixed_transaction_payroll_cycle.sql","db/migrations/0515_set_based_visibility.sql",
  "db/migrations/0516_lifecycle_module.sql","db/migrations/0517_clocking_location_companies.sql","db/migrations/0518_clocking_file_import.sql",
  "db/migrations/0519_shift_flexible_break_to_rows.sql","db/migrations/0520_web_clocking_photo_setting.sql","db/migrations/0521_tenant_mobile_design.sql",
  "db/migrations/0522_mobile_visual_composer.sql","db/migrations/0523_deployment_identity.sql","db/migrations/0524_rewards.sql",
  "db/migrations/0525_identity_email_administration.sql","db/migrations/0526_manual_identity_enrollment.sql","db/migrations/0527_workflow_email.sql",
  "db/migrations/0528_attendance_punch_corrections.sql","db/migrations/0529_onehr_native.sql","db/migrations/0530_attendance_payroll_entity_protection.sql",
  "db/migrations/0531_attendance_rotation.sql","db/migrations/0532_attendance_allowance_periods.sql","db/migrations/0533_attendance_approval_workflow.sql",
  "db/migrations/0534_persisted_audit_chain.sql","db/migrations/0535_hr_orchestrator.sql","db/migrations/0536_web_clock_optional_location.sql",
  "db/migrations/0537_attendance_day_adjustments.sql","db/migrations/0539_clock_removal_and_location_evidence.sql","db/migrations/0540_performance_journey_parity.sql",
  "db/migrations/0541_ai_control_centre.sql","db/migrations/0542_account_email_failures.sql","db/migrations/0543_embedded_authentication.sql",
  "db/migrations/0544_own_earned_credit_actors.sql","db/migrations/0545_schedule_configuration.sql","db/migrations/0546_employee_master_reports.sql",
  "db/migrations/0547_replacement_public_holidays.sql","db/migrations/0548_attendance_hierarchy_approval.sql","db/migrations/0549_employee_master_delivery.sql",
  "db/migrations/0550_system_label_company_criteria.sql","db/migrations/0551_overtime_patterns.sql","db/migrations/0552_employee_master_internal_delivery.sql",
  "db/migrations/0553_report_occurrence_write_privileges.sql","db/migrations/0558_board_set_based_visibility.sql","db/migrations/0559_replacement_holiday_company_retention.sql",
  "db/migrations/0560_employee_profile_edit_scope.sql","db/migrations/0561_versioned_system_testing.sql","db/migrations/0564_onboarding_v31.sql",
  "db/migrations/0565_pay_component_import_state.sql","db/migrations/0566_label_import_tenant_code_collision.sql","db/migrations/0568_ai_user_default_allowance.sql",
  "db/migrations/0569_employment_test_record.sql","db/migrations/0570_attendance_participant_approval.sql","db/migrations/0571_ess_profile_policy_routes.sql",
  "db/migrations/0572_leave_payroll_followup.sql","db/migrations/0573_employment_holiday_calendar.sql","db/migrations/0574_card_assignment_import_guard.sql",
  "db/migrations/0575_attendance_request_participant_review.sql","db/migrations/0576_principal_snapshot_current.sql","db/migrations/0578_ess_photo_approval.sql",
  "db/migrations/0579_configurable_access.sql","db/migrations/0580_reward_policy_groups.sql","db/migrations/0581_attendance_group_policy.sql",
  "db/migrations/0582_employee_home_notice_integrity.sql","db/migrations/0583_employee_home_person_privacy.sql","db/migrations/0584_employee_home_sharing.sql",
  "db/migrations/0585_home_team_calendar.sql","db/migrations/0586_employee_home_greetings.sql","db/migrations/0590_attendance_policy_execution.sql",
  "db/migrations/0591_my_tp3_private_drafts.sql","db/migrations/0592_attendance_workflow_v4.sql","db/migrations/0593_my_ea_source_eligibility.sql",
  "db/migrations/0594_people_nric_policy.sql","db/migrations/0595_job_description_documents.sql","db/migrations/0596_rewards_review_maintenance.sql",
  "db/migrations/0597_employment_cost_allocations.sql","db/migrations/0598_cost_allocation_criteria_guard.sql","db/migrations/0599_board3_company_retention.sql",
  "db/migrations/0600_login_presentation.sql","db/migrations/0601_operator_customer_workspace.sql","db/migrations/0602_payroll_history_revisions.sql",
  "db/migrations/0603_letter_lifecycle.sql","db/migrations/0610_performance_partner_role.sql","db/migrations/0611_performance_partner_access.sql",
  "db/migrations/0612_standalone_user_enrollment.sql","db/migrations/0613_request_abuse_budgets.sql","db/migrations/0620_onehr_panel_manager_anonymity.sql",
  "db/migrations/0621_ai_action_controls.sql","db/migrations/0622_own_leave_review_store.sql","db/migrations/0623_openrouter_provider_options.sql",
  "db/migrations/0624_assistant_disclosure.sql","db/migrations/0625_provider_readiness.sql","db/migrations/0626_module_agent_feedback.sql",
  "db/migrations/0627_module_agent_improvement.sql","db/migrations/0628_employee_import_ai_evaluation.sql","db/migrations/0629_lifecycle_acknowledgement_source.sql",
  "db/migrations/0630_testing_execution_source.sql","db/migrations/0631_payroll_close_source.sql","db/migrations/0632_statutory_source_ownership.sql",
  "db/migrations/0633_geofence_reported_uncertainty.sql","db/migrations/0634_mobile_integrity_challenges.sql","db/migrations/0635_mobile_integrity_keys.sql",
  "db/migrations/0636_mobile_android_key_custody.sql","db/migrations/0640_onehr_plan_reviewer_scope.sql","db/migrations/0641_account_email_delivery_history.sql",
  "db/migrations/0642_module_specialist_diagnostic_playbook.sql","db/migrations/0646_reward_calendar.sql","db/migrations/0647_mobile_offline_attendance.sql",
  "db/migrations/0648_ai_concurrency_controls.sql","db/migrations/0649_ai_provider_accounting_summary.sql","db/migrations/0650_ai_native_outcomes.sql",
  "db/migrations/0651_ai_spend_controls.sql","db/migrations/0652_performance_provider_source_custody.sql","db/migrations/0653_claims_provider_source_custody.sql",
  "db/migrations/0654_ai_optional_usd_policy.sql","db/migrations/0655_assistant_conversation_candidates.sql","db/migrations/0656_assistant_transcript_retention.sql",
  "db/migrations/0657_ai_integration_repairs.sql","db/migrations/0658_assistant_exchange_continuation.sql","db/migrations/0660_payroll_history_adopt_ordinary.sql",
  "db/migrations/0661_ai_gateway_provider.sql","db/migrations/0662_ai_group_allowance.sql","db/migrations/0663_onehr_leader_seats.sql",
  "db/migrations/0664_onehr_hod_department_view.sql","db/migrations/0665_onehr_two_step_release.sql","db/migrations/0666_onehr_leader_status.sql",
  "db/migrations/0667_onehr_unit_exclusion.sql","db/migrations/0668_people_duplicate_email_policy.sql","db/migrations/0670_ai_orchestrator_wave1_receipts.sql",
  "db/migrations/0671_ai_orchestrator_wave1b_decisions.sql","db/migrations/0672_ai_agent_principal.sql","db/migrations/0673_mobile_push_tokens.sql",
  "db/migrations/0674_assistant_outcome_measurement.sql","db/migrations/0675_import_attempt_history.sql","db/migrations/0676_employment_import_void.sql",
  "db/migrations/0677_ai_hr_prepared_actions.sql","db/migrations/0678_ai_connection_probe_ledger.sql","db/migrations/0679_email_templates_r2.sql",
  "db/migrations/0680_rewards_exclusions_history.sql","db/migrations/0681_rewards_approval_participation.sql","db/migrations/0682_epf_manual_percentage.sql",
  "db/migrations/0683_profile_field_approvals.sql","db/migrations/0684_ocbc_bank_payment_exports.sql","db/migrations/0685_bank_import_jobs.sql",
  "db/migrations/0686_ai_provider_custody_owner_rls.sql","db/migrations/0687_assistant_question_budget.sql","db/migrations/0688_payroll_txn_import_attempts.sql",
  "db/migrations/0689_rewards_unit_governance.sql","db/migrations/0690_rewards_policy_pair_membership.sql","db/migrations/0691_bank_import_point_read.sql",
  "db/migrations/0696_feedback_menu_operator_switch.sql","db/migrations/0697_epf_topup_percentage.sql","db/migrations/0698_information_only_corrections.sql",
  "db/migrations/0713_lifecycle_v9.sql","db/migrations/0714_lifecycle_v9_email.sql","db/migrations/0715_lifecycle_v9_email_assets.sql",
  "db/migrations/0716_lifecycle_v9_events.sql","db/migrations/0717_lifecycle_v9_delivery_review.sql","db/migrations/0718_lifecycle_v9_employment_class.sql",
  "db/migrations/0719_lifecycle_v9_business_recipients.sql","db/migrations/0720_lifecycle_v9_self_equipment.sql","db/migrations/0721_movement_settings_catalog.sql",
  "db/migrations/0722_movement_type_controls.sql","db/migrations/0728_feedback_release_evidence.sql","db/migrations/0800_pay_formula_builder.sql",
  "db/migrations/0811_pay_formula_company_retention.sql","db/migrations/0812_ai_feature_switch_owner.sql","db/migrations/0813_assistant_action_kind.sql",
  "db/migrations/0814_ai_provider_change_gate.sql","db/migrations/0815_assistant_learning_loop_scope.sql","db/migrations/0816_ai_agent_action_pause.sql",
  "db/migrations/0817_automatic_chasers.sql","db/migrations/0818_delegated_approvals.sql","db/migrations/0819_automatic_followups.sql",
  "db/migrations/0820_template_feature_switch_owner.sql","db/migrations/0821_delegated_leave_review_receipts.sql","db/migrations/0822_assistant_qualification_maintenance.sql",
  "db/migrations/0823_assistant_employee_draft_activation.sql","db/migrations/0824_assistant_compensation_maintenance.sql","db/migrations/0825_assistant_emergency_contact_maintenance.sql",
  "db/migrations/0826_assistant_workforce_profile_maintenance.sql","db/migrations/0827_assistant_family_maintenance.sql","db/migrations/0828_assistant_bank_maintenance.sql",
  "db/migrations/0829_assistant_document_metadata.sql","db/migrations/0830_assistant_employee_code_maintenance.sql","db/migrations/0831_assistant_passport_maintenance.sql",
  "db/migrations/0832_assistant_payment_method_maintenance.sql","db/migrations/0833_assistant_fixed_item_archive.sql","db/migrations/0834_assistant_tp3_opening_maintenance.sql",
  "db/migrations/0835_assistant_cost_allocation_maintenance.sql","db/migrations/0836_assistant_personnel_review_navigation.sql","db/migrations/0837_assistant_attendance_schedule_group.sql",
  "db/migrations/0838_assistant_performance_goal_approval.sql","db/migrations/0839_assistant_rewards_cancel_review.sql","db/migrations/0840_assistant_personnel_profile_request_rejection.sql",
  "db/migrations/0841_assistant_position_archive_custody.sql","db/migrations/0842_assistant_payroll_reopen_review.sql","db/migrations/0843_assistant_lifecycle_offboarding_step_review.sql",
  "db/migrations/0844_assistant_performance_checkin_cancel.sql","db/migrations/0845_assistant_attendance_day_schedule_correction.sql","db/migrations/0846_native_ess_bank_direct_purpose.sql",
  "db/migrations/0847_assistant_performance_checkin_complete_custody.sql","db/migrations/0848_assistant_rewards_cycle_calendar_review.sql","db/migrations/0849_assistant_lifecycle_offboarding_step_undo.sql",
  "db/migrations/0850_assistant_department_archive_custody.sql","db/migrations/0851_assistant_payroll_reset_review.sql","db/migrations/0852_assistant_employee_id_template_status_custody.sql",
  "db/migrations/0853_onboarding_draft_discard_absence_context.sql","db/migrations/0854_assistant_performance_checkin_schedule_custody.sql","db/migrations/0855_assistant_rewards_annual_return_review.sql",
  "db/migrations/0856_assistant_lifecycle_offboarding_case_cancel.sql","db/migrations/0857_assistant_performance_review_postimage_proof.sql","db/migrations/0858_assistant_people_general_policy_custody.sql",
  "db/migrations/0859_assistant_employee_draft_discard_custody.sql","db/migrations/0860_assistant_payroll_review_draft_delete_compatibility.sql","db/migrations/0861_assistant_review_body_pending_parent.sql",
  "db/migrations/0863_assistant_bank_effect_closure.sql","db/migrations/0864_assistant_catalogue_effect_closure.sql","db/migrations/0865_assistant_company_retention_references.sql",
  "db/migrations/0873_movement_exit_payroll_preservation.sql","db/migrations/0874_payroll_tax_basis_corrections.sql","db/migrations/0875_reward_access_request_read_role.sql",
  "db/migrations/0876_epf_manual_percentage_zero.sql","db/migrations/0898_session_idle_timeout.sql","db/migrations/0899_entra_workforce.sql",
  "db/migrations/0924_teras_outcome_record_mandates.sql","db/migrations/0925_teras_rule_version_labels.sql","db/migrations/0926_teras_worker_registry.sql",
  "db/migrations/0927_teras_conversation_switch.sql","db/migrations/0928_teras_outcome_private_turns.sql","db/migrations/0929_teras_review_services.sql",
  "db/migrations/0935_password_account_unlock.sql","db/migrations/0946_draft_creation_cohort_custody.sql","db/migrations/0947_rewards_access_approval_exemptions.sql",
  "db/migrations/0948_document_signing.sql","db/migrations/0949_probation_confirmation.sql","db/migrations/0950_contract_management.sql",
  "db/migrations/0951_payroll_reprocess_correction_lineage.sql","db/migrations/0953_lifecycle_service_info_intents.sql","db/migrations/2000_teras_chats.sql",
  "db/migrations/2001_private_cases.sql","db/migrations/2002_teras_loops.sql","db/migrations/2003_letter_requests.sql",
  "db/migrations/2004_teras_loop_autonomy.sql","db/migrations/2005_teras_payroll_cycle_loops.sql","db/migrations/2006_payroll_audit_loop.sql",
  "db/migrations/2007_teras_capacity_baseline.sql","db/migrations/2008_own_payroll_cut_off.sql","db/migrations/2009_teras_living_handbook.sql",
  "db/migrations/2010_teras_learning_loops.sql","db/migrations/2011_payroll_loops_hardening.sql","db/migrations/2013_payroll_learned_baseline.sql",
  "db/migrations/2100_employment_helper_tenant_pin.sql","db/migrations/2101_company_tenant_fk_not_valid.sql","db/migrations/2102_company_tenant_fk_validate.sql",
  "db/migrations/2103_system_performance_read_guards.sql","db/migrations/2104_contract_navigation_role_guards.sql","db/migrations/2105_authorization_navigation_plans.sql",
  "db/migrations/2106_account_management_subject.sql","db/migrations/2107_probation_module_permission.sql","db/migrations/2108_rewards_entity_classification.sql",
  "db/migrations/2109_org_chart_roots.sql","db/migrations/2110_pay_formula_personnel_registry.sql","db/migrations/2111_probation_personnel_mapping.sql",
  "db/migrations/2124_ai_control_navigation_candidates.sql","db/migrations/2125_approval_subject_batch.sql","db/migrations/2126_company_organisation_tagging.sql",
  "db/migrations/2127_personnel_filter_search.sql","db/migrations/2128_organisation_account_admission.sql","db/migrations/2129_personnel_native_paging.sql",
  "db/migrations/2130_approved_company_retention.sql","db/migrations/2131_ai_read_only_metadata_locks.sql","db/migrations/2132_ai_metadata_claim_preview_index.sql",
  "db/migrations/2133_ai_action_read_only_lock.sql","db/migrations/2134_claim_visibility_set_membership.sql","db/migrations/2135_profile_presentation_read_lock.sql",
  "db/migrations/2136_grant_admin_role_precheck.sql","db/migrations/2137_home_peer_cohort_batch.sql","db/migrations/2138_ai_pause_company_discovery.sql",
  "db/migrations/2139_workforce_bounded_read_plan.sql","db/migrations/2141_approval_nonadmin_visibility_batch.sql","db/migrations/2200_job_architecture.sql",
  "db/migrations/2201_job_architecture_documents.sql","db/migrations/2202_job_architecture_profile.sql","db/migrations/2203_rewards_libraries_pat.sql",
  "db/migrations/2204_rewards_plan_setup.sql","db/migrations/2205_rewards_review_creation.sql","db/migrations/2206_rewards_role_permissions.sql",
  "db/migrations/2207_reward_advisor.sql","db/migrations/2208_rewards_uploaded_awards.sql","db/migrations/2209_company_registration_classification.sql",
  "db/migrations/2210_personnel_projection_reuse.sql","db/migrations/2211_company_retention_approved_expansion.sql","db/migrations/2212_payroll_audit_claim_lookup_indexes.sql",
  "db/migrations/2250_rewards_whole_group_grants.sql","db/migrations/2251_company_display_group.sql","db/migrations/2252_probation_navigation_capability_probe.sql",
  "db/migrations/2300_retire_job_architecture_workflows.sql","db/migrations/2301_attendance_workflow_submission_shared_lock.sql","db/migrations/2302_company_ancestry_early_exit.sql",
  "db/migrations/2303_admin_grant_direct_scan.sql","db/migrations/2304_payroll_grant_direct_scan.sql","db/migrations/2403_personnel_bounded_overview.sql",
  "db/migrations/2404_payroll_reconciliation_remark.sql","db/migrations/2405_rewards_review_activity.sql","db/migrations/2406_payroll_reconciliation_generation.sql",
  "db/migrations/2450_personnel_search_projection.sql","db/migrations/2451_personnel_company_filter_choices.sql","db/migrations/2460_payroll_individual_import_queue.sql",
  "db/migrations/2503_attendance_pending_visible_headers.sql","db/migrations/2504_notification_event_processing.sql","db/migrations/2505_workforce_picker_facts.sql",
  "db/migrations/2506_notification_receipt_retention.sql","db/migrations/2507_attendance_header_column_grants.sql","db/migrations/2508_notification_receipt_grants.sql",
  "db/migrations/2509_principal_statement_plan_reuse.sql","db/migrations/2510_capability_statement_plan_reuse.sql","db/migrations/2600_onboarding_current_personnel.sql",
  "db/migrations/2701_personnel_typed_overview_filter_fields.sql","db/migrations/2903_notification_receipt_cycle_authority.sql","db/migrations/3001_employment_membership_initplan.sql",
  "db/migrations/3100_pay_formula_saved_availability.sql","db/migrations/3101_attendance_shared_workflow.sql","db/migrations/3102_assignment_membership_initplan.sql",
  "db/migrations/3103_access_editor_presentation.sql","db/migrations/3110_attendance_workflow_owner_rls.sql","db/migrations/3200_ai_centre_controls.sql","db/migrations/3201_ai_centre_function_coverage.sql","db/migrations/3210_attendance_shared_workflow_submission_lock.sql",
  "db/migrations/3211_access_editor_native_owner_presentation.sql","db/migrations/3500_ai_centre_architecture_compatibility.sql","db/migrations/3501_ai_centre_mandate_write_order.sql","db/migrations/meta/_journal.json","db/payroll-audit-schema.ts",
  "db/schema.ts","db/tenant-mutation.ts","db/tenant-write-admission.ts",
  "db/workload.ts","drizzle.config.ts","i18n/config.ts",
  "lib/ai-centre/loop-attribution.ts","lib/ai/agent-action-registry.ts","lib/ai/agent-action-tiers.ts",
  "lib/ai/assistant-action-catalogue.ts","lib/ai/assistant-action-proposal-hints.ts","lib/ai/assistant-answer-explanations.ts",
  "lib/ai/assistant-answer-plan.ts","lib/ai/assistant-conversation-candidate.ts","lib/ai/assistant-conversation-holdouts.ts",
  "lib/ai/assistant-conversation-system.ts","lib/ai/assistant-tool-catalogue.ts","lib/ai/centre-activity.ts","lib/ai/conversation-input.ts",
  "lib/ai/crypto.ts","lib/ai/draft-input.ts","lib/ai/employee-import-human-handoff.ts",
  "lib/ai/evidence-selection.ts","lib/ai/features.ts","lib/ai/governance.ts",
  "lib/ai/grounded-tool-presentation.ts","lib/ai/human-plan-holdouts.ts","lib/ai/image-input.ts",
  "lib/ai/image-protocol.ts","lib/ai/index.ts","lib/ai/job-architecture-policy.ts",
  "lib/ai/leave-answer-evidence.ts","lib/ai/lifecycle-offboarding-human-handoff.ts","lib/ai/module-agent-actions.ts",
  "lib/ai/module-agent-prompt-candidate.ts","lib/ai/module-agent-prompt-holdouts.ts","lib/ai/module-agent-routing.ts",
  "lib/ai/module-agents.ts","lib/ai/module-human-handoffs.ts","lib/ai/module-job-presentation.ts",
  "lib/ai/module-jobs.ts","lib/ai/module-specialist-followup-cases.ts","lib/ai/module-specialist-followup.ts",
  "lib/ai/module-specialist-holdouts.ts","lib/ai/module-specialists.ts","lib/ai/native-insight-outline.ts",
  "lib/ai/provider-analysis-bands.ts","lib/ai/provider-analysis-coverage.ts","lib/ai/provider-analysis-policy.ts",
  "lib/ai/provider-analysis-result.ts","lib/ai/provider-assistant-policy.ts","lib/ai/provider-data-approvals.ts",
  "lib/ai/provider-data-reviews.ts","lib/ai/provider-data-source-manifest.ts","lib/ai/provider-egress.ts",
  "lib/ai/provider-evaluation-receipt.ts","lib/ai/provider-policy-shape.ts","lib/ai/provider-privacy-error.ts",
  "lib/ai/provider-privacy-request.ts","lib/ai/provider-protocol.ts","lib/ai/provider-snapshot-policy.ts",
  "lib/ai/provider-task-registry.ts","lib/ai/provider-workload-policy.ts","lib/ai/providers/anthropic.ts",
  "lib/ai/providers/gateway-options.ts","lib/ai/providers/gateway.ts","lib/ai/providers/google.ts",
  "lib/ai/providers/openai.ts","lib/ai/providers/openrouter-accounting.ts","lib/ai/providers/openrouter-completion.ts",
  "lib/ai/providers/openrouter-configuration.ts","lib/ai/providers/openrouter-fixed-free-carrier.ts","lib/ai/providers/openrouter-fixed-metered-carrier.ts",
  "lib/ai/providers/openrouter-policy.ts","lib/ai/providers/openrouter-spend-evidence.ts","lib/ai/providers/openrouter-transport.ts",
  "lib/ai/providers/openrouter.ts","lib/ai/registry.ts","lib/ai/rewards-advisor-policy.ts",
  "lib/ai/run-accounting.ts","lib/ai/spend-allocation.ts","lib/ai/spend-receipt.ts",
  "lib/ai/teras-harness-policy.ts","lib/ai/types.ts","lib/ai/usage.ts",
  "lib/allowance-employee-expression.ts","lib/approval-history.ts","lib/assessment-reminder-mail.ts",
  "lib/assigned-work.ts","lib/assistant-actions/own-leave-contract.ts","lib/assistant-actions/reviewed-payroll-reopen-contract.ts",
  "lib/attendance-allowance-expression.ts","lib/attendance-allowance-rules.ts","lib/attendance-allowance-vocabulary.ts",
  "lib/attendance-break-count.ts","lib/attendance-csv.ts","lib/attendance-day-review.ts",
  "lib/attendance-group-policy.ts","lib/attendance-history-filter.ts","lib/attendance-photo-setting.ts",
  "lib/attendance-photo.ts","lib/attendance-policy-attested-trace.ts","lib/attendance-policy-calendar.ts",
  "lib/attendance-policy-clocks.ts","lib/attendance-policy-intervals.ts","lib/attendance-policy-plan-dates.ts",
  "lib/attendance-policy-unclocked-work.ts","lib/attendance-progress.ts","lib/attendance-removal.ts",
  "lib/attendance-workflow-config.ts","lib/attendance-workflow-v3.ts","lib/attendance-workflow-v4.ts",
  "lib/attendance-workflow.ts","lib/audit-format.ts","lib/authz-model.ts",
  "lib/bank-import-job.ts","lib/borang-8a.ts","lib/borang-8b.ts",
  "lib/borang-a.ts","lib/calendar-date.ts","lib/calendar-window.ts",
  "lib/card-import-workbook.ts","lib/card-import.ts","lib/clock-attempt.ts",
  "lib/clock-command-context.ts","lib/clocking-file.ts","lib/company-delete.ts",
  "lib/completed-years.ts","lib/cost-allocation-import.ts","lib/countries.ts",
  "lib/cp39-form.ts","lib/csv.ts","lib/currencies.ts",
  "lib/custom-holder.ts","lib/database-error-token.ts","lib/date-time-formatter.ts",
  "lib/db-error.ts","lib/delegation-scope.ts","lib/dependent-identity.ts",
  "lib/dependent-vocabulary.ts","lib/email-design/asset-limits.ts","lib/email-design/assets.ts",
  "lib/email-design/model.ts","lib/emergency-contact-vocabulary.ts","lib/employee-choice.ts",
  "lib/employee-code.ts","lib/employee-home-search.ts","lib/employee-search.ts",
  "lib/employment-confirmation.ts","lib/employment-cost-allocation.ts","lib/employment-period.ts",
  "lib/entitlement-edit-mode.ts","lib/entitlement-status.ts","lib/entitlement-table-order.ts",
  "lib/epf-mode-map.ts","lib/extended-hours.ts","lib/family-child-relief-rule.json",
  "lib/family-child-relief-rule.ts","lib/full-flexi-time.ts","lib/geofence-assessment.ts",
  "lib/hr-date.ts","lib/import-file.ts","lib/import-history.ts",
  "lib/import-schema.ts","lib/individual-import-job.ts","lib/individual-txn-import-contract.ts",
  "lib/information-correction.ts","lib/internal-auth/account-state.ts","lib/internal-auth/config.ts",
  "lib/internal-auth/credential.ts","lib/internal-auth/crypto.ts","lib/internal-auth/errors.ts",
  "lib/internal-auth/organisation-admission-proof.ts","lib/internal-auth/organisation-admission.ts","lib/internal-auth/password-admission.ts",
  "lib/internal-auth/password-policy.ts","lib/internal-auth/record-store.ts","lib/internal-auth/store.ts",
  "lib/knowledge-search.ts","lib/leave-approval-kinds.ts","lib/leave-bf-import-schema.ts",
  "lib/leave-credit-day-type.ts","lib/leave-credit-history.ts","lib/leave-credit-register.ts",
  "lib/leave-groups.ts","lib/leave-history-import-schema.ts","lib/leave-import-schema.ts",
  "lib/leave-inquiry-picker.ts","lib/leave-inquiry-query.ts","lib/leave-inquiry.ts",
  "lib/leave-summary-explain.ts","lib/mobile-android-clock-policy.ts","lib/mobile-android-enrollment.ts",
  "lib/mobile-android-key-policy.ts","lib/mobile-api/pack-form.ts","lib/mobile-clock-integrity.ts",
  "lib/mobile-clock-rollout-policy.ts","lib/mobile-key-enrollment.ts","lib/mobile-offline-clock.ts",
  "lib/mobile-offline-context.ts","lib/mobile-offline-errors.ts","lib/movement-field-rules.ts",
  "lib/movement-pending-input.ts","lib/my-banks.ts","lib/my-team-query.ts",
  "lib/my-tp3-eligibility.ts","lib/notification-email-model.ts","lib/nric-policy-message.ts",
  "lib/org-chart-model.ts","lib/org-chart-window.ts","lib/organisation-choice-label.ts",
  "lib/overtime-duration-input.ts","lib/overtime-duration.ts","lib/overtime-pattern-binding.ts",
  "lib/overtime-pattern-evaluate.ts","lib/overtime-pattern-model.ts","lib/overtime-pattern-result.ts",
  "lib/overtime-pattern-schema.ts","lib/overtime-pattern-starters.ts","lib/overtime-recorded-work.ts",
  "lib/overtime-records.ts","lib/pagination.ts","lib/password-policy.ts",
  "lib/pay-component-contract.ts","lib/pay-component-import.ts","lib/pay-formula-ai.ts",
  "lib/pay-formula-diagnostics.ts","lib/pay-formula-language.ts","lib/pay-formula-model.ts",
  "lib/pay-formula-personnel.ts","lib/pay-formula-registry.ts","lib/pay-formula-sample.ts",
  "lib/payment-methods.ts","lib/payroll-basic.ts","lib/payroll-comparison-result.ts",
  "lib/payroll-comparison-source.ts","lib/payroll-history-import-schema.ts","lib/payroll-history-revisions.ts",
  "lib/payroll-period-comparison.ts","lib/payroll-permissions.ts","lib/payroll-proration.ts",
  "lib/payroll-publication.ts","lib/payroll-reconciliation-items.ts","lib/payroll-run-selection.ts",
  "lib/payroll-tax-basis-notices.ts","lib/payroll-tax-basis.ts","lib/payroll-txn-import-schema.ts",
  "lib/pcb2ii-form.ts","lib/performance-help-catalogue.json","lib/person-vocabulary.ts",
  "lib/personnel-choice-vocabulary.ts","lib/personnel-csv.ts","lib/personnel-ess-contract.ts",
  "lib/personnel-ess-model.ts","lib/personnel-ess-visibility.ts","lib/personnel-field-label.ts",
  "lib/personnel-field-registry.ts","lib/personnel-history.ts","lib/personnel-import-assistance.ts",
  "lib/personnel-import-contract.ts","lib/personnel-import-evaluation.ts","lib/personnel-report-value.ts",
  "lib/profile-attachment.ts","lib/profile-edit-policy-value.ts","lib/profile-photo-limits.ts",
  "lib/profile-photo-proposal.ts","lib/profile-policy-fingerprint.ts","lib/profile-requestable-fields.ts",
  "lib/profile-routing-policy.ts","lib/profile-submission-policy.ts","lib/public-error.ts",
  "lib/roster-month.ts","lib/roster-selection.ts","lib/schedule-exception.ts",
  "lib/settle-read-group.ts","lib/shared-leave-balance.ts","lib/shift-visual.ts",
  "lib/sip-contribution.ts","lib/spreadsheet-archive.ts","lib/spreadsheet.ts",
  "lib/statutory-authorities.ts","lib/system-label-definition.ts","lib/system-label-head-choice.ts",
  "lib/toil-dated-credit.ts","lib/transaction-effective-date.ts","lib/unfinished-name.ts",
  "lib/xlsx-list-validation.ts","localization/child-qualification.ts","localization/country-pack.ts",
  "localization/my/bank-files/bnm-codes.ts","localization/my/borang-8a.ts","localization/my/borang-8b.ts",
  "localization/my/borang-a.ts","localization/my/child-relief.ts","localization/my/client.ts",
  "localization/my/company-registration-readiness.ts","localization/my/company-statutory.ts","localization/my/config-sections.ts",
  "localization/my/cp39-file.ts","localization/my/cp39-form.ts","localization/my/ea-noncash.ts",
  "localization/my/ea-reporting.ts","localization/my/ea-routing.ts","localization/my/epf-election.ts",
  "localization/my/epf-topup-conversion-db.ts","localization/my/epf-topup-conversion.ts","localization/my/holidays.ts",
  "localization/my/ic-dob.ts","localization/my/index.ts","localization/my/leave.ts",
  "localization/my/multicycle-worksheet.ts","localization/my/multicycle.ts","localization/my/ocbc-file.ts",
  "localization/my/ocbc-payment.ts","localization/my/passport.ts","localization/my/pay-components.ts",
  "localization/my/payroll.ts","localization/my/pcb2ii.ts","localization/my/provision.ts",
  "localization/my/reports.ts","localization/my/sip-contribution.ts","localization/my/socso-eis.ts",
  "localization/my/statutory-config.ts","localization/my/statutory-identity.ts","localization/my/statutory-month-wage.ts",
  "localization/my/statutory-tables.ts","localization/my/statutory.ts","localization/my/tax-basis-replay.ts",
  "localization/my/tax-circumstance.ts","localization/my/tax-scheme-declarations.ts","localization/my/tax-selection-codes.ts",
  "localization/my/tax-selection.ts","localization/noncash-benefits.ts","localization/registry.client.ts",
  "localization/registry.ts","messages/en.json","messages/ms.json",
  "messages/ta.json","messages/th.json","messages/vi.json",
  "messages/zh.json","package.json","packs/attendance/day-adjustment.ts",
  "packs/attendance/day-schedule-effects.ts","packs/attendance/day-schedule-preview.ts","packs/attendance/exceptions.ts",
  "packs/attendance/history-decisions.ts","packs/attendance/mobile-offline-adjudicator.ts","packs/attendance/mobile-offline-settings.ts",
  "packs/attendance/mobile-offline-snapshot.ts","packs/attendance/my-calendar.ts","packs/attendance/overtime-calculation.ts",
  "packs/attendance/overtime-input.ts","packs/attendance/overtime-patterns.ts","packs/attendance/overtime-records.ts",
  "packs/attendance/overtime-toil.ts","packs/attendance/policy-approval-input.ts","packs/attendance/policy-approved-plan-quantity.ts",
  "packs/attendance/policy-attested-work-input.ts","packs/attendance/policy-attested-work-source.ts","packs/attendance/policy-captured-coverage.ts",
  "packs/attendance/policy-cash-replay.ts","packs/attendance/policy-clock-input.ts","packs/attendance/policy-clock-measurements.ts",
  "packs/attendance/policy-clock-replay.ts","packs/attendance/policy-count-attribution.ts","packs/attendance/policy-coverage.ts",
  "packs/attendance/policy-duration-replay.ts","packs/attendance/policy-duration.ts","packs/attendance/policy-execution-proposal.ts",
  "packs/attendance/policy-final-raw-input.ts","packs/attendance/policy-financial-contract.ts","packs/attendance/policy-formula-input.ts",
  "packs/attendance/policy-formula-source.ts","packs/attendance/policy-import-input.ts","packs/attendance/policy-manual-duration.ts",
  "packs/attendance/policy-partition.ts","packs/attendance/policy-plan-input.ts","packs/attendance/policy-plan-submission.ts",
  "packs/attendance/policy-pricing-proposal.ts","packs/attendance/policy-proposal-parts.ts","packs/attendance/policy-raw-day.ts",
  "packs/attendance/policy-raw-figures.ts","packs/attendance/policy-raw-input.ts","packs/attendance/policy-selection.ts",
  "packs/attendance/policy-source-reservation-coverage.ts","packs/attendance/policy-toil-dated-qualification.ts","packs/attendance/policy-trace-binding.ts",
  "packs/attendance/policy-work-input.ts","packs/attendance/service.ts","packs/attendance/unclocked-work-setup.ts",
  "packs/catalog.ts","packs/leave/service.ts","packs/payroll/ai-rule-proposal.ts",
  "packs/payroll/history.ts","packs/payroll/pay-averages.ts","packs/payroll/reward-provenance.ts",
  "packs/payroll/service.ts","packs/performance/mobile-review.ts","packs/performance/onehr/admin-agent-service.ts",
  "packs/performance/onehr/admin-context.ts","packs/performance/onehr/admin-report-model.ts","packs/performance/onehr/admin-report-service.ts",
  "packs/performance/onehr/admin-report-xlsx.ts","packs/performance/onehr/admin-sections.ts","packs/performance/onehr/ai-settings.ts",
  "packs/performance/onehr/ai-usage.ts","packs/performance/onehr/ai.ts","packs/performance/onehr/analysis-source.ts",
  "packs/performance/onehr/architecture-model.ts","packs/performance/onehr/architecture-service.ts","packs/performance/onehr/calibration-command-model.ts",
  "packs/performance/onehr/calibration-conversation.ts","packs/performance/onehr/calibration-curve-model.ts","packs/performance/onehr/calibration-fit-model.ts",
  "packs/performance/onehr/calibration-list-model.ts","packs/performance/onehr/calibration-list.ts","packs/performance/onehr/calibration-query-model.ts",
  "packs/performance/onehr/career-command-model.ts","packs/performance/onehr/career-draft-model.ts","packs/performance/onehr/career-draft-service.ts",
  "packs/performance/onehr/career-model.ts","packs/performance/onehr/catalogue-default-model.ts","packs/performance/onehr/catalogue-default-service.ts",
  "packs/performance/onehr/check-ins-door.ts","packs/performance/onehr/competency-band.ts","packs/performance/onehr/competency-guide-model.ts",
  "packs/performance/onehr/competency-insight-model.ts","packs/performance/onehr/competency-insight-service.ts","packs/performance/onehr/competency-insight-source.json",
  "packs/performance/onehr/competency-section-model.ts","packs/performance/onehr/conversation.ts","packs/performance/onehr/department-view-model.ts",
  "packs/performance/onehr/department-view.ts","packs/performance/onehr/development-suggestion-model.ts","packs/performance/onehr/development-suggestion-service.ts",
  "packs/performance/onehr/draft-model.ts","packs/performance/onehr/employment-projection.ts","packs/performance/onehr/evidence-command-model.ts",
  "packs/performance/onehr/evidence-extraction.ts","packs/performance/onehr/evidence-figure-model.ts","packs/performance/onehr/evidence-file-model.ts",
  "packs/performance/onehr/evidence-model.ts","packs/performance/onehr/evidence-reading.ts","packs/performance/onehr/feedback-conversation.ts",
  "packs/performance/onehr/feedback-report.ts","packs/performance/onehr/final-band-model.ts","packs/performance/onehr/framework-model.ts",
  "packs/performance/onehr/framework.json","packs/performance/onehr/frozen-visibility.ts","packs/performance/onehr/guide-model.ts",
  "packs/performance/onehr/guide-screen-source.json","packs/performance/onehr/guide-screen.ts","packs/performance/onehr/guide-service.ts",
  "packs/performance/onehr/help.ts","packs/performance/onehr/home-cards.ts","packs/performance/onehr/idp-fit-context.ts",
  "packs/performance/onehr/idp-fit-model.ts","packs/performance/onehr/idp-fit-service.ts","packs/performance/onehr/idp-fit-source.json",
  "packs/performance/onehr/import-model.ts","packs/performance/onehr/insight-assessment.ts","packs/performance/onehr/insight-grounding.ts",
  "packs/performance/onehr/insight-prompt.ts","packs/performance/onehr/insight-service.ts","packs/performance/onehr/insight-source.ts",
  "packs/performance/onehr/insight-vocabulary.json","packs/performance/onehr/journey-model.ts","packs/performance/onehr/leader-roster-service.ts",
  "packs/performance/onehr/leader-seat-model.ts","packs/performance/onehr/leader-seat-service.ts","packs/performance/onehr/leader-status-service.ts",
  "packs/performance/onehr/literal-command-parser.ts","packs/performance/onehr/manager-command-model.ts","packs/performance/onehr/model.ts",
  "packs/performance/onehr/overview-model.ts","packs/performance/onehr/overview-service.ts","packs/performance/onehr/panel-admin-service.ts",
  "packs/performance/onehr/panel-build-model.ts","packs/performance/onehr/participation-model.ts","packs/performance/onehr/participation-service.ts",
  "packs/performance/onehr/performance-home-model.ts","packs/performance/onehr/performance-home-service.ts","packs/performance/onehr/performance-insight-model.ts",
  "packs/performance/onehr/person-labels.ts","packs/performance/onehr/personal-record-model.ts","packs/performance/onehr/personal-record-service.ts",
  "packs/performance/onehr/potential-insight-model.ts","packs/performance/onehr/potential-insight-service.ts","packs/performance/onehr/potential-insight-source.json",
  "packs/performance/onehr/profit-service.ts","packs/performance/onehr/progress-model.ts","packs/performance/onehr/progress-service.ts",
  "packs/performance/onehr/provider-source-authority.ts","packs/performance/onehr/provider-source-draft.ts","packs/performance/onehr/rating-record-model.ts",
  "packs/performance/onehr/rating-record-service.ts","packs/performance/onehr/rating-record-xlsx.ts","packs/performance/onehr/record-insight-model.ts",
  "packs/performance/onehr/record-insight-service.ts","packs/performance/onehr/record-insight-source.json","packs/performance/onehr/release-model.ts",
  "packs/performance/onehr/release-service.ts","packs/performance/onehr/reminder-model.ts","packs/performance/onehr/reminder-preparation.ts",
  "packs/performance/onehr/reminder-projection.ts","packs/performance/onehr/reminder-service.ts","packs/performance/onehr/reminder-work.ts",
  "packs/performance/onehr/review-command-ai.ts","packs/performance/onehr/review-command-model.ts","packs/performance/onehr/rewrite-model.ts",
  "packs/performance/onehr/rewrite-service.ts","packs/performance/onehr/service.ts","packs/performance/onehr/setting-command-model.ts",
  "packs/performance/onehr/setting-default-model.ts","packs/performance/onehr/setting-suggestion-model.ts","packs/performance/onehr/source-numeric.ts",
  "packs/performance/onehr/tab-model.ts","packs/performance/onehr/tab-service.ts","packs/performance/onehr/talent-board-model.ts",
  "packs/performance/onehr/talent-insight-model.ts","packs/performance/onehr/talent-insight-service.ts","packs/performance/onehr/talent-insight-source.json",
  "packs/performance/onehr/talent-model.ts","packs/performance/onehr/talent-move-model.ts","packs/performance/onehr/talent-person-service.ts",
  "packs/performance/onehr/talent-service.ts","packs/performance/onehr/talent-trail-model.ts","packs/performance/onehr/tasks.ts",
  "packs/performance/onehr/unit-exclusion-model.ts","packs/performance/onehr/unit-exclusion-screen.ts","packs/performance/onehr/unit-exclusion-service.ts",
  "packs/performance/onehr/workspace-model.ts","packs/performance/onehr/written-remarks-model.ts","packs/performance/onehr/written-remarks-service.ts",
  "packs/performance/onehr/written-remarks-source.json","packs/performance/service.ts","packs/registry.ts",
  "pnpm-lock.yaml","scripts/lib/discard-premigration.ts","scripts/migrate-with-focused-prerequisites.ts",
  "scripts/seed-catalogs.ts","scripts/test-duration-order.mjs","scripts/test-duration-sequencer.mjs",
  "test/fixtures/notification-worker/canonical-inventory.ts","test/fixtures/notification-worker/final-catalogue-replay-prerequisite.ts","test/fixtures/notification-worker/replay-prefix-ownership.ts",
  "test/harness-reset-errors.ts","test/harness.ts","test/helpers/native-read-observer.ts","test/helpers/personnel-draft-discard-ci-role-fixture.ts",
  "test/performance/module-read-jit-probe.ts","test/performance/personnel-native-fixture.ts","test/profile.ts",
  "tsconfig.json",
 ]),
 ...Object.fromEntries(EMPLOYEE_LIFECYCLE_PROFILE.files.map(({file})=>[file,assertEmployeeLifecycleSourceClosure(EMPLOYEE_LIFECYCLE_SOURCES)])),
 'test/rewards-audit-policy-native.test.ts':Object.freeze(['.github/ci/rewards-native-sources.mjs',...REWARDS_NATIVE_SOURCES]),
 'test/rewards-audited-read-prototype.test.ts':Object.freeze(['.github/ci/rewards-native-sources.mjs',...REWARDS_NATIVE_SOURCES]),
 'test/attendance-shared-submission-bridge.test.ts':Object.freeze([
  'db/migrations/0592_attendance_workflow_v4.sql','db/migrations/3101_attendance_shared_workflow.sql',
  'db/migrations/3110_attendance_workflow_owner_rls.sql','db/migrations/3210_attendance_shared_workflow_submission_lock.sql',
  'test/harness.ts','db/client.ts','db/schema.ts','core/attendance-workflow.ts','core/attendance.ts','core/org.ts','lib/hr-date.ts',
  'test/helpers/attendance-bridge-fixture.ts','test/helpers/attendance-bridge-owned-phase.ts',
  'test/helpers/attendance-bridge-owner-catalogue.ts','test/helpers/attendance-bridge-owner-process.ts',
  'test/helpers/attendance-bridge-owner-proof.ts','test/helpers/attendance-bridge-owner-protocol.ts',
  'test/helpers/attendance-bridge-owner-worker.ts','test/helpers/attendance-bridge-pidfd.py','test/helpers/attendance-bridge-pidfd.ts',
 ]),
 'test/access-editor-native-owner-presentation.test.ts':Object.freeze([
  'db/migrations/3211_access_editor_native_owner_presentation.sql',
  'test/fixtures/access-editor-native-owner.ts','test/fixtures/access-editor-cleanup-lifetime.ts','test/fixtures/access-editor-catalogue-diagnostic.ts','test/fixtures/access-editor-owner-dependencies.ts',
  'test/fixtures/access-editor-owned-work.ts','test/fixtures/access-editor-original739-journal.json',
  'test/fixtures/access-editor-locked-baseline.ts',
 ]),
 'test/notification-worker-native-plan-diagnostic.test.ts':Object.freeze([
  'test/harness.ts','lib/notification-worker/lifecycle.ts','lib/notification-worker/projection.ts',
  'lib/assessment-reminder-mail.ts','test/fixtures/notification-worker/owner-fixture.ts',
  'test/fixtures/notification-worker/database.ts','test/fixtures/notification-worker/diagnostic-ownership.ts',
  'test/fixtures/notification-worker/plan-logging.ts','test/fixtures/notification-worker/auto-explain.ts',
  'test/fixtures/notification-worker/admission-plan-summary.ts',
  'test/fixtures/notification-worker/lifecycle.sql','test/fixtures/notification-worker/projection.sql',
  'test/fixtures/notification-worker/assessment.sql','test/fixtures/notification-worker/process.sql',
  'test/fixtures/notification-worker/query-shape.sql','test/fixtures/notification-worker/exact-source.sql',
 ]),
});
/** Bounds complete source hashing only; this never admits a path or a profile.
 * The native Rewards closure imports the complete 4.73 MB Tamil catalogue.
 * All other sources, including unknown or noncanonical spellings, retain 4 MiB.
 * @param {string} file exact repository-relative source member */
export function singletonSourceMaximum(file){return file==='messages/ta.json'?8*1024*1024:4*1024*1024;}
export function singletonSources(unit){
 assertSingletonUnit(unit);
 const sources=[unit.files[0],'test/helpers/ci-singleton-admission.ts','.github/ci/singleton-protocol.mjs','.github/ci/policy-version.mjs',
  'vitest.config.ts','vitest.nodb.config.ts',...(componentSources[unit.files[0]]??[]),...(unit.kind==='db'?['test/db-names.ts','test/global-setup.ts','test/env.ts']:['deploy/admission/test_native.py']),
  ...(nativeNextUnit(unit)?[...Object.values(NATIVE_HELPER_SOURCES),'.github/ci/native-next-helper-sources.mjs','.github/ci/native-next-build-packet.mjs',
   '.github/ci/native-next-installation.mjs','.github/ci/native-next-build-inputs.mjs','.github/ci/candidate-environment.mjs','.github/ci/build-artifact.mjs',
   'test/helpers/native-next-fixture.ts','scripts/performance/native-next-boot-browser.mjs',
   'scripts/performance/fixture-workload.mjs','scripts/performance/next-source-proof.mjs',
   '.github/ci/native-controller-bootstrap.py','.github/ci/native-controller-owner.mjs','.github/ci/prepare-runner.sh',
   '.github/ci/run-unit.mjs','.github/ci/plan.mjs','.github/ci/singleton-profiles.mjs',
   '.github/actions/setup-alpha/action.yml','.github/workflows/alpha-staging.yml',
   'scripts/migrate-with-focused-prerequisites.ts','scripts/lib/discard-premigration.ts','test/helpers/personnel-draft-discard-ci-role-fixture.ts']:[])].sort();
 return employeeLifecycleFile(unit.files[0])?[...new Set(sources)]:sources;
}
export const protocolHash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fullSha=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const positive=value=>typeof value==='string'&&/^[1-9][0-9]*$/.test(value);
export function assertNoSingletonHints(env){assert(!Object.keys(env).some(key=>key.startsWith('AIHR_CI_SINGLETON_')),'Inherited singleton admission hints are forbidden');}
export function validateSingletonDatabaseUrls(env,database){
 for(const [key,user]of Object.entries({DATABASE_URL:'ai_hr_app',TEST_DATABASE_URL:'ai_hr_app',MIGRATION_DATABASE_URL:'postgres',TEST_MIGRATION_DATABASE_URL:'postgres'})){
  const value=new URL(env[key]);assert(['postgres:','postgresql:'].includes(value.protocol));assert.equal(value.hostname,'127.0.0.1');assert.equal(value.port,'5433');assert.equal(value.pathname,'/'+database);assert.equal(value.username,user);assert.equal(value.search,'');assert.equal(value.hash,'');
 }
}
export function validateNativeHostPrerequisite(p){
 assert(p&&Object.keys(p).sort().join('|')==='kind|nginxPath|nginxSha256|nginxVersion|pid1|platform|sudoUid|systemdVersion');
 assert.equal(p.kind,'actual-job-systemd-nginx');assert.equal(p.platform,'linux');assert.equal(p.pid1,'systemd');assert.equal(p.sudoUid,'0');
 assert.equal(p.nginxPath,'/usr/sbin/nginx');assert(digest(p.nginxSha256));assert(/^nginx version: nginx\//.test(p.nginxVersion));assert(/^systemd [0-9]+/.test(p.systemdVersion));
}
/** Metadata structure only. The provisioning owner authenticates actual GitHub
 * producer/job/artifact bytes before issuing this conjunction; callers cannot
 * turn a host-only or DB-only receipt into the hybrid execution capability. */
export function validateNativeBuildPrerequisite(p,expected){
 assert(p&&Object.keys(p).sort().join('|')==='archiveSha256|artifactDigest|artifactId|attempt|controller|kind|manifestSha256|nextBuildId|producerJobId|provenanceSha256|runId|source');
 assert.equal(p.kind,'same-run-canonical-next-build');
 for(const key of ['source','controller'])assert.equal(p[key],expected[key]);
 assert.equal(p.runId,String(expected.runId));assert.equal(p.attempt,String(expected.attempt));assert.equal(p.attempt,'1');
 for(const key of ['artifactId','producerJobId'])assert(positive(p[key]));
 for(const key of ['archiveSha256','manifestSha256','provenanceSha256'])assert(digest(p[key]));
 assert(/^sha256:[a-f0-9]{64}$/.test(p.artifactDigest));assert(/^[A-Za-z0-9_-]{1,512}$/.test(p.nextBuildId));
}
export function validateSingletonBinding(binding,plan,unit,witness){
 const descriptor=assertSingletonUnit(unit);
 assert(binding&&Object.keys(binding).sort().join('|')===['schemaVersion','mode','candidate','controller','runId','attempt','unit','fingerprint','file','profile','sourceHashes','evidenceDirectory','prerequisites'].sort().join('|'),'Closed singleton binding required');
 assert.equal(binding.schemaVersion,1);assert.equal(binding.mode,'full-ci-singleton');
 assert.equal(plan.policyVersion,CI_POLICY);
 const {fingerprint,...body}=plan;assert.equal(protocolHash(body),fingerprint,'Actual complete plan fingerprint differs');
 assert(fullSha(plan.sha)&&fullSha(plan.controller)&&digest(plan.fingerprint));
 assert.equal(binding.candidate,plan.sha);assert.equal(binding.controller,plan.controller);assert.equal(binding.fingerprint,plan.fingerprint);
 assert.equal(binding.unit,unit.id);assert.equal(binding.file,unit.files[0]);assert.equal(binding.profile,descriptor.profile);
 assert(witness&&positive(String(witness.runId))&&String(witness.attempt)==='1','Authenticated first-attempt full-CI context required');
 assert.equal(binding.runId,String(witness.runId));assert.equal(binding.attempt,'1');
 assert.deepEqual(binding.sourceHashes,plan.singletonSources?.[unit.id],'Singleton source binding differs');
 assert.deepEqual(Object.keys(binding.sourceHashes??{}).sort(),singletonSources(unit));
 for(const value of Object.values(binding.sourceHashes))assert(digest(value),'Invalid singleton source hash');
 assert(typeof binding.evidenceDirectory==='string'&&binding.evidenceDirectory.startsWith('/')&&!binding.evidenceDirectory.includes('\0'));
 const p=binding.prerequisites;
 if(unit.kind==='db'){
  assert(p&&Object.keys(p).sort().join('|')===(nativeNextUnit(unit)?'build|database|host|kind|workers':'database|kind|workers'));
  assert.equal(p.kind,nativeNextUnit(unit)?'fresh-job-next-systemd-nginx-postgres':'fresh-job-postgres-cluster');assert.equal(p.workers,1);
  assert.equal(p.database?.name,`aihr-ci-${binding.runId}-${binding.attempt}-${unit.id}`,'Cluster belongs to another job unit');
  validatePostgresEvidence(p.database,plan.execution);
  if(nativeNextUnit(unit)){
   validateNativeHostPrerequisite(p.host);
   validateNativeBuildPrerequisite(p.build,{source:plan.sha,controller:plan.controller,runId:binding.runId,attempt:binding.attempt});
  }
 }else validateNativeHostPrerequisite(p);
 return true;
}
/** Environment is admission context, not API authentication. The release verifier
 * separately authenticates workflow/job/artifact provenance against GitHub. */
export function validateSingletonHost({env,event,layout,plan,unit}){
 assertSingletonUnit(unit);
 assert.equal(plan.units.filter(row=>row.id===unit.id).length,1);assert.deepEqual(plan.units.find(row=>row.id===unit.id),unit);
 for(const [key,value]of Object.entries({GITHUB_ACTIONS:'true',CI:'true',RUNNER_ENVIRONMENT:'github-hosted',RUNNER_OS:'Linux',GITHUB_REPOSITORY:'StradaverseHub/ai-hr',GITHUB_REPOSITORY_ID:'1333414856',GITHUB_WORKFLOW:'alpha-staging-ci',GITHUB_JOB:nativeNextUnit(unit)?'native-test':'test',GITHUB_RUN_ATTEMPT:'1'}))assert.equal(env[key],value,key);
 assert(positive(env.GITHUB_RUN_ID));assert.equal(env.AIHR_CI_HEAD,plan.sha);assert.equal(env.AIHR_CI_CONTROL_HEAD,plan.controller);assert.equal(env.GITHUB_SHA,plan.controller);
 assert.equal(layout.platform,'linux');assert.equal(layout.sourceHead,plan.sha);assert.equal(layout.controllerHead,plan.controller);assert.equal(layout.sourceClean,true);assert.equal(layout.controllerClean,true);
 assert.equal(layout.source,layout.workspace+'/source');assert.equal(layout.automation,singletonControllerPath(unit,layout.workspace,env.GITHUB_RUN_ID));assert.equal(layout.cwd,layout.source);assert.equal(layout.evidence,layout.temp+'/aihr-ci');
 assert(!Object.keys(env).some(key=>key.startsWith('AIHR_FOCUSED_')),'Focused and full singleton intent cannot mix');
 assert(env.TEST_DB_NAMESPACE===undefined||env.TEST_DB_NAMESPACE==='');
 assert.equal(event?.repository?.full_name,'StradaverseHub/ai-hr');assert.equal(String(event.repository.id),'1333414856');
 const prefix='StradaverseHub/ai-hr/.github/workflows/alpha-staging.yml@';assert(env.GITHUB_WORKFLOW_REF?.startsWith(prefix));const ref=env.GITHUB_WORKFLOW_REF.slice(prefix.length);
 if(env.GITHUB_EVENT_NAME==='workflow_dispatch'){assert(/^refs\/heads\/[A-Za-z0-9_./-]+$/.test(ref));if(event.inputs?.expected_sha)assert.equal(event.inputs.expected_sha,plan.sha);}
 else if(env.GITHUB_EVENT_NAME==='push'){assert.equal(ref,'refs/heads/alpha');assert.equal(event.ref,ref);assert.equal(event.after,plan.sha);assert.equal(plan.sha,plan.controller);}
 else if(env.GITHUB_EVENT_NAME==='pull_request'){const pr=event.pull_request;assert(pr&&pr.draft===false);assert.equal(pr.base?.ref,'alpha');assert.equal(pr.head?.repo?.full_name,'StradaverseHub/ai-hr');assert.equal(String(pr.head.repo.id),'1333414856');assert.equal(pr.head.sha,plan.sha);assert.equal(pr.merge_commit_sha,plan.controller);assert(positive(String(event.number)));assert.equal(ref,`refs/pull/${event.number}/merge`);}
 else assert.fail('Unsupported full-CI singleton event');
}

/** Independently authenticated release bytes must match the build actually
 * exercised by every native Next unit. Source equality alone is insufficient. */
export function assertNativeBuildMatches(plan,reports,packet,artifact,producerJobId){
 const units=plan.units.filter(nativeNextUnit);if(!units.length)return true;
 assert.equal(packet.kind,'AUTHENTICATED_CI_BUILD_PACKET_NOT_DEPLOYMENT');assert.equal(packet.canonicalCandidateInputsVerified,true);
 assert.equal(packet.source,plan.sha);assert.equal(packet.controller,plan.controller);
 assert.equal(artifact?.name,'production-build-v1');assert(positive(String(artifact.id))&&positive(String(producerJobId)));
 for(const unit of units){
  const matches=reports.filter(report=>report?.id===unit.id);assert.equal(matches.length,1,'Missing exact native build unit report');
  const p=matches[0].singleton?.prerequisites?.build;
  validateNativeBuildPrerequisite(p,{source:plan.sha,controller:plan.controller,runId:String(packet.runId),attempt:'1'});
  assert.equal(p.artifactId,String(artifact.id));assert.equal(p.artifactDigest,artifact.digest);assert.equal(p.producerJobId,String(producerJobId));
  for(const key of ['nextBuildId','archiveSha256','manifestSha256','provenanceSha256'])assert.equal(p[key],packet[key],'Native tests exercised another compiled build: '+key);
 }
 return true;
}

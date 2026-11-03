// employees.profile_request.reject implements non-own pending scalar-request rejection only; approve/photo/evidence/register paths remain native.
/** Generic tickStepAction remains backlog: onboarding/outcome variants exceed the bounded offboarding action. */
// Bounded hand TP3 opening review leaves broader setTp3Action/form exports backlog.
// Payment-method MY/other-employment review is bounded; the broad legacy export remains backlog.
/** Passport review covers existing MY profiles only. Broad setPassportAction stays backlog:approve for no-row and legacy-country paths. */
/** Bank Information subset is registered separately. Legacy setBankAction stays backlog:approve because its MY fallback is broader than the supported actual-country review. */
/** ADR-0151 §4.2 — every human entry point that can change data, classified for the orchestrator.
 * The tier ceiling also constrains runtime preparation and confirmation. Each owning service
 * keeps its own authorization; the agent reaches an effect only through a registered module action.
 *
 * Keys are server-action files ("use server") mapped export by export, and route files (suffix `#route`)
 * mapped by HTTP method. test/agent-capability-inventory.test.ts fails when an entry point is added, renamed
 * or removed without updating this list, which is how a new screen reaches the agent's backlog in the same
 * change (§4.6a).
 *
 *   registered:<action>  the agent already prepares this effect through that module action
 *   backlog:<tier>       not yet available to the agent; <tier> is the highest tier it may ever get
 *   handoff:<reason>     stays a link to the human screen by policy (§4.4)
 *   internal:<reason>    not a user capability (the Assistant itself, presentation, another client)
 *
 * backlog:automatic is reserved for reads: the test refuses it for a function that revalidates a page or
 * whose name is not a read verb. The initial classification (28 Oct 2026) was derived from names and paths
 * and reviewed for sensitive categories; a tier is fixed when the entry is actually registered.
 */
import {AGENT_ACTIONS,type AgentActionId,type AgentActionOf} from './agent-action-registry';

export {type AgentTier} from './agent-action-tiers';
import type {AgentTier} from './agent-action-tiers';
/** private_case (ADR-0173): a person's own private case and its handlers' acts. The AI never reads, prepares or acts on
 * a case; a routed sensitive turn only links the form. */
export const AGENT_HANDOFF_REASONS=['access_and_authentication','ai_governance','platform_operator','privacy_erasure','payroll_reversal','employment_exit_or_discipline','private_case'] as const;
export const AGENT_INTERNAL_REASONS=['assistant_surface','session_and_presentation','other_client_same_service'] as const;
export type AgentHandoffReason=(typeof AGENT_HANDOFF_REASONS)[number];
export type AgentInternalReason=(typeof AGENT_INTERNAL_REASONS)[number];
export type AgentCapabilityClass=`registered:${AgentActionId}`|`backlog:${Exclude<AgentTier,'handoff'>}`|`handoff:${AgentHandoffReason}`|`internal:${AgentInternalReason}`;

/** Highest tier each registered module action may use (§4.4), derived from lib/ai/agent-action-registry.ts
 * (WP7). Every one is Confirm, Approve or Handoff today; raising a ceiling is a reviewed change to the
 * registry entry and its app.assistant_action_kind row, with its evidence window (§4.6e). */
export const AGENT_ACTION_TIER_CEILING=Object.freeze(Object.fromEntries(AGENT_ACTIONS.map(action=>[action.id,action.policy.tier]))) as {readonly [K in AgentActionId]:AgentActionOf<K>['policy']['tier']};

/** Category classification is independent of the execution tier. Sensitive entries cannot acquire
 * Automatic authority: the registry's policy type makes a never-Automatic category paired with Automatic a
 * compile error, assertAgentTierPolicy refuses it at runtime, and app.assistant_action_kind refuses it in SQL. */
export const AGENT_ACTION_CATEGORY=Object.freeze(Object.fromEntries(AGENT_ACTIONS.map(action=>[action.id,action.policy.category]))) as {readonly [K in AgentActionId]:AgentActionOf<K>['policy']['category']};
export type RegisteredAgentActionPolicies={[K in AgentActionId]:AgentActionOf<K>['policy']};

export const AGENT_CAPABILITY_INVENTORY:Readonly<Record<string,Readonly<Record<string,AgentCapabilityClass>>>>=Object.freeze({
 "app/admin/settings/login/password-policy-actions.ts":{"savePasswordPolicyAction":"handoff:access_and_authentication"},
 "app/admin/settings/login/remembered-mfa-actions.ts":{"saveRememberedMfaAction":"handoff:access_and_authentication"},
 "app/admin/security-center/password-policy/actions.ts":{"saveFullPasswordPolicy":"handoff:access_and_authentication"},
 "app/admin/users/password-unlock-actions.ts":{"unlockPasswordAccountAction":"handoff:access_and_authentication"},
 "app/lifecycle/probation/intake/[employmentId]/evidence/route.ts#route":{"POST":"backlog:approve"},
 "app/lifecycle/probation/actions.ts":{"addFollowup":"backlog:approve","adjudicateOfflineFinal":"handoff:employment_exit_or_discipline","admitCase":"backlog:approve","applyDateShift":"backlog:approve","approveCutover":"handoff:platform_operator","approveLegacyReconciliation":"handoff:platform_operator","assignAccess":"handoff:access_and_authentication","bootstrapPreparer":"handoff:access_and_authentication","overrideRoute":"handoff:access_and_authentication","performReview":"handoff:employment_exit_or_discipline","prepareCutover":"handoff:platform_operator","prepareDefaults":"backlog:approve","prepareLetter":"backlog:approve","previewLetter":"backlog:automatic","previewWorkflow":"backlog:automatic","proposeOfflineFinal":"handoff:employment_exit_or_discipline","readPublicationRetirement":"backlog:automatic","reconcileDates":"backlog:approve","releaseLetter":"handoff:employment_exit_or_discipline","replaceSigner":"handoff:access_and_authentication","requestDateShift":"backlog:approve","requestLegacyReconciliation":"handoff:platform_operator","retirePublication":"backlog:approve","saveConfiguration":"backlog:approve","saveDraft":"backlog:approve","saveLetterTemplate":"backlog:approve","saveWorkflow":"backlog:approve","signLetter":"handoff:employment_exit_or_discipline","stageIntake":"backlog:approve","supersedeDateShift":"backlog:approve"},
 "app/lifecycle/probation/[id]/[partId]/evidence/route.ts#route":{"POST":"backlog:approve"},
 "app/lifecycle/contracts/workflows/actions.ts":{"previewWorkflowAction":"backlog:automatic","saveWorkflowAction":"backlog:approve"},
 "app/lifecycle/contracts/templates/actions.ts":{"exportTemplatesAction":"backlog:approve","publishTemplateAction":"backlog:approve","saveTemplateAction":"backlog:approve"},
 "app/lifecycle/contracts/actions.ts":{"readContractLetterEditor":"backlog:automatic","readContractRetirementContext":"backlog:automatic","runContractCommand":"handoff:employment_exit_or_discipline"},
 "app/lifecycle/v9/email-assets/route.ts#route":{"POST":"backlog:confirm"},
 "app/lifecycle/v9/files/[caseId]/route.ts#route":{"POST":"handoff:employment_exit_or_discipline"},
 "app/lifecycle/v9/actions.ts":{"setupV9":"handoff:access_and_authentication","saveV9Config":"handoff:access_and_authentication","createV9Offboarding":"handoff:employment_exit_or_discipline","commandV9":"handoff:employment_exit_or_discipline","readV9Case":"backlog:automatic","readV9Email":"backlog:automatic","readV9Workflow":"backlog:automatic","readV9UpdatedEmail":"backlog:automatic"},
 "app/me/lifecycle/actions.ts":{"saveOwnLifecycleDocument":"backlog:confirm","updateOwnLifecycleTask":"backlog:confirm","reportOwnLifecycleReturn":"backlog:confirm","updateOwnLifecycleReturn":"backlog:confirm","saveOwnLifecycleEquipmentReceipt":"backlog:confirm"},
 // HR correction effects stay unregistered and require an Approve review before any future integration.
 "app/admin/personnel/information-correction-actions.ts":{"informationContextAction":"backlog:approve","previewInformationAction":"backlog:automatic","saveInformationAction":"backlog:approve","previewInformationUploadAction":"backlog:approve","confirmInformationUploadAction":"backlog:approve"},
  "app/payroll/setup/corrections-actions.ts": {"savePayrollCorrections": "handoff:payroll_reversal"},
 "app/admin/scheduled-actions/actions.ts":{"configureRunnerAction":"handoff:platform_operator"},
 "app/admin/settings/email-templates/actions.ts":{"saveEmailDesignAction":"backlog:confirm","loadEmailDesignHistoryAction":"backlog:automatic","uploadEmailDesignAssetAction":"backlog:confirm","sendEmailDesignTestAction":"backlog:confirm"},
 "app/admin/actions.ts":{"archiveBusinessUnitAction":"backlog:confirm","archiveClockingLocationAction":"backlog:confirm","archiveCompanyAction":"backlog:confirm","archiveCostCenterAction":"backlog:confirm","archiveDepartmentAction":"backlog:confirm","archiveLeaveTypeAction":"backlog:confirm","archiveLocationAction":"backlog:confirm","archivePositionAction":"backlog:confirm","archiveUserAction":"handoff:access_and_authentication","assignRoleAction":"handoff:access_and_authentication","closeReplacementLeaveYearAction":"backlog:confirm","countEmployeesInScopeAction":"backlog:automatic","createBusinessUnitAction":"backlog:confirm","createClockingLocationAction":"backlog:confirm","createCompanyAction":"backlog:confirm","createCostCenterAction":"backlog:confirm","createDepartmentAction":"backlog:confirm","createGradeGroupAction":"backlog:confirm","createHolidayGroupAction":"backlog:confirm","createLeaveSharedGroupAction":"backlog:confirm","createLeaveTypeAction":"backlog:confirm","createLocationAction":"backlog:confirm","createPositionAction":"backlog:confirm","deleteClockingLocationAction":"backlog:confirm","deleteCompanyAction":"backlog:confirm","deleteCostCenterAction":"backlog:confirm","deleteDepartmentAction":"backlog:confirm","deleteGradeGroupAction":"backlog:confirm","deleteHolidayAction":"backlog:confirm","deleteHolidayGroupAction":"backlog:confirm","deleteLeaveSharedGroupAction":"backlog:confirm","deleteLeaveTypeAction":"backlog:confirm","deletePositionAction":"backlog:confirm","inviteUserAction":"handoff:access_and_authentication","openLeaveYearAction":"backlog:confirm","previewEarnedAccrualAction":"backlog:automatic","removeCompanyBankProfileAction":"backlog:confirm","removeCompanyLogoAction":"backlog:confirm","removeCompanyStatutoryAuthorityAction":"backlog:confirm","restoreClockingLocationAction":"backlog:confirm","restoreLocationAction":"backlog:confirm","revokeInvitationAction":"handoff:access_and_authentication","revokeRoleAction":"handoff:access_and_authentication","runEarnedAccrualAction":"backlog:confirm","runToilExpiryAction":"backlog:confirm","saveCompanyGeneralTabAction":"backlog:confirm","saveHolidayAction":"backlog:confirm","setAssistantGrantAction":"handoff:access_and_authentication","setAttendancePolicyAction":"backlog:confirm","setCompanyBankProfileAction":"backlog:confirm","setCompanyLogoAction":"backlog:confirm","setCompanyParentAction":"backlog:confirm","setCompanyStatutoryAction":"backlog:confirm","setCompanyStatutoryAuthorityAction":"backlog:confirm","setLeaveEncashmentPolicyAction":"backlog:confirm","setLeaveHalfDayFullDeductionCompaniesAction":"backlog:confirm","setLeaveTypeRulesAction":"backlog:confirm","setToilPolicyAction":"backlog:confirm","updateBusinessUnitAction":"backlog:confirm","updateClockingLocationAction":"backlog:confirm","updateCompanyAction":"backlog:confirm","updateCompanyDefaultCycleAction":"backlog:confirm","updateCostCenterAction":"backlog:confirm","updateDepartmentAction":"backlog:confirm","updateGradeGroupAction":"backlog:confirm","updateHolidayGroupAction":"backlog:confirm","updateLeaveSharedGroupAction":"backlog:confirm","updateLeaveTypeAction":"backlog:confirm","updateLocationAction":"backlog:confirm","updatePositionAction":"backlog:confirm"},
 "app/admin/ai/actions.ts":{"disableAiAction":"handoff:ai_governance","evaluateProviderCandidateAction":"handoff:ai_governance","removeAiProviderConfigAction":"handoff:ai_governance","saveAiProviderConfigAction":"handoff:ai_governance","setActiveProviderAction":"handoff:ai_governance","testConnectionAction":"handoff:ai_governance"},
 "app/admin/attendance-allowance/actions.ts":{"archiveAllowancePolicyAction":"backlog:confirm","previewAllowanceEmployeeSelection":"backlog:automatic","saveAllowancePolicyFormAction":"backlog:confirm","searchAllowanceEmployeeValues":"backlog:automatic","searchAllowanceEmployees":"backlog:automatic","setAllowanceStatusAction":"backlog:confirm","transferAllowanceAction":"backlog:confirm"},
 "app/admin/attendance-policy/device-actions.ts":{"revokeDeviceAction":"backlog:confirm"},
 "app/admin/attendance-policy/offline-clocking-actions.ts":{"saveOfflineClockingAction":"backlog:confirm"},
 "app/admin/attendance-policy/rule-actions.ts":{"copyAttendanceRuleAction":"backlog:confirm","createAttendanceRuleAction":"backlog:confirm","deleteAttendanceRuleAction":"backlog:confirm","saveScheduleGroupGeneralAction":"backlog:confirm","setAttendanceRuleStatusAction":"backlog:confirm","updateAttendanceRuleAction":"backlog:confirm"},
 "app/admin/attendance/approval-workflow/actions.ts":{"previewAttendanceWorkflowAction":"backlog:automatic","restoreAttendanceWorkflowAction":"backlog:confirm","retireAttendanceWorkflowAction":"backlog:confirm","saveAttendanceWorkflowAction":"backlog:confirm","setAttendanceWorkflowEnabledAction":"backlog:confirm"},
 "app/admin/attendance/file-mappings/actions.ts":{"deleteClockingMappingAction":"backlog:confirm","duplicateClockingMappingAction":"backlog:confirm","saveClockingMappingAction":"backlog:confirm","setClockingMappingActiveAction":"backlog:confirm"},
 "app/admin/attendance/schedule-assignment/actions.ts":{"bulkAssignScheduleGroupAction":"backlog:confirm","removeScheduleArrangementAction":"backlog:confirm","saveScheduleAssignmentAction":"backlog:confirm","setScheduleGroupAssignmentAction":"registered:attendance.schedule_group.maintain"},
 "app/admin/attendance/schedule/actions.ts":{"saveScheduleGroupAttendanceAction":"backlog:confirm","saveScheduleGroupControlAction":"backlog:confirm","saveScheduleGroupOvertimeAction":"backlog:confirm","saveScheduleGroupWeekAction":"backlog:confirm"},
 "app/admin/attendance/schedule/rotation-actions.ts":{"saveRotationAction":"backlog:confirm"},
 "app/admin/attendance/settings/overtime-patterns/actions.ts":{"activateOvertimeAction":"backlog:confirm","archiveOvertimeAction":"backlog:confirm","calculateOvertimeDayAction":"backlog:automatic","closeOvertimeAssignmentAction":"backlog:confirm","forkOvertimeDraftAction":"backlog:confirm","initializeOvertimeStartersAction":"backlog:confirm","overtimeChoicesAction":"backlog:confirm","overtimePositionChoicesAction":"backlog:confirm","previewOvertimeEmployeeAction":"backlog:automatic","previewOvertimeSampleAction":"backlog:automatic","readOvertimeTransferAction":"backlog:automatic","saveOvertimeAssignmentAction":"backlog:confirm","saveOvertimeDraftAction":"backlog:confirm","stopOvertimeAction":"backlog:confirm","transferOvertimePayrollAction":"backlog:confirm","validateOvertimeAction":"backlog:automatic"},
 "app/admin/attendance/shift-actions.ts":{"archiveShiftAction":"backlog:confirm","copyShiftAction":"backlog:confirm","createShiftAction":"backlog:confirm","deleteShiftAction":"backlog:confirm","saveShiftPayAction":"backlog:confirm","unarchiveShiftAction":"backlog:confirm","updateShiftAction":"backlog:confirm"},
 "app/admin/card-assignment/actions.ts":{"saveCardIdAction":"backlog:confirm"},
 "app/admin/card-assignment/import/route.ts#route":{"POST":"backlog:confirm"},
 "app/admin/claims/actions.ts":{"archiveClaimFormFieldAction":"backlog:confirm","archiveClaimItemAction":"backlog:confirm","archiveClaimTypeAction":"backlog:confirm","createClaimFormFieldAction":"backlog:confirm","createClaimItemAction":"backlog:confirm","createClaimTypeAction":"backlog:confirm","deleteClaimTypeAction":"backlog:confirm","moveClaimFormFieldAction":"backlog:confirm","updateClaimFormFieldAction":"backlog:confirm","updateClaimItemAction":"backlog:confirm","updateClaimTypeAction":"backlog:confirm"},
 "app/admin/claims/limits/actions.ts":{"setGradeClaimLimitsAction":"backlog:confirm"},
 "app/admin/claims/mileage/actions.ts":{"setMileageRateTableAction":"backlog:confirm"},
 "app/admin/claims/reimbursements/actions.ts":{"markReimbursementsPaidAction":"backlog:approve"},
 "app/admin/holidays/replacements/actions.ts":{"adjustReplacementAction":"backlog:confirm","saveReplacementPolicyAction":"backlog:confirm"},
 "app/admin/job-descriptions/actions.ts":{"configureAction":"backlog:confirm","removeAttachmentAction":"backlog:confirm","saveDraftAction":"backlog:confirm","transitionAction":"backlog:confirm","uploadAction":"backlog:confirm"},
 "app/admin/leave-approval/actions.ts":{"assignApprovalTemplateAction":"backlog:approve","deleteApprovalTemplateAction":"backlog:approve","duplicateApprovalTemplateAction":"backlog:approve","saveApprovalTemplateAction":"backlog:approve","saveLeaveEscalationPolicyAction":"backlog:approve","setApprovalTemplateActiveAction":"backlog:approve","setTenantDefaultTemplateAction":"backlog:approve","unassignApprovalTemplateAction":"backlog:approve"},
 "app/admin/leave-config/bf-import/actions.ts":{"commitLeaveBfImportAction":"backlog:approve","reverseLeaveBfImportAction":"backlog:approve","validateLeaveBfImportAction":"backlog:automatic"},
 "app/admin/leave-config/earned-accrual/actions.ts":{"previewEarnedAccrualWithReasonAction":"backlog:automatic"},
 "app/admin/leave-config/history-import/actions.ts":{"commitLeaveHistoryImportAction":"backlog:approve","validateLeaveHistoryImportAction":"backlog:automatic"},
 "app/admin/leave-config/leave-credit/actions.ts":{"grantLeaveCreditRowsAction":"registered:toil.credit.grant","leaveCreditGrantClaimReviewAction":"backlog:approve","leaveCreditGrantContextAction":"backlog:approve","leaveCreditGrantDayFactsAction":"backlog:approve","reverseLeaveCreditAction":"backlog:approve"},
 "app/admin/leave/adjustments/actions.ts":{"applyLeaveAdjustmentAction":"registered:leave.adjustment.apply","previewLeaveAdjustmentAction":"backlog:automatic","reverseLeaveAdjustmentAction":"backlog:approve"},
 "app/admin/leave/entitlements/templates/actions.ts":{"countEligibilityTargetsAction":"backlog:automatic","createEligibilityRuleAction":"backlog:approve","createEntitlementTemplateAction":"backlog:approve","deleteEligibilityRuleAction":"backlog:approve","deleteEntitlementTemplateAction":"backlog:approve","retireEligibilityRuleAction":"backlog:approve","retireEntitlementTemplateAction":"backlog:approve","setLeaveTypeDefaultTemplateAction":"backlog:approve","updateEligibilityRuleAction":"backlog:approve","updateEntitlementTemplateAction":"backlog:approve"},
 "app/admin/leave/generate/actions.ts":{"previewLeaveGenerationAction":"backlog:automatic"},
 "app/admin/leave/import/actions.ts":{"commitLeaveImportAction":"backlog:approve","validateLeaveImportAction":"backlog:automatic"},
 "app/admin/lifecycle/actions.ts":{"loadDefaultsAction":"backlog:automatic","resetStepsAction":"backlog:confirm","saveCatalogueAction":"backlog:confirm","saveCompanyAction":"backlog:confirm","saveFieldsAction":"backlog:confirm","saveProvisionsAction":"backlog:confirm","saveStepsAction":"backlog:confirm","setStaffAction":"backlog:confirm"},
 "app/admin/loans/actions.ts":{"amendLoanAction":"backlog:approve","cancelLoanAction":"backlog:approve","createLoanAction":"backlog:approve","resumeLoanAction":"backlog:approve","settleLoanAction":"backlog:approve","suspendLoanAction":"backlog:approve"},
 "app/admin/notice-board/[id]/attachments/route.ts#route":{"POST":"backlog:confirm"},
 "app/admin/notice-board/actions.ts":{"archiveNoticeAction":"backlog:confirm","createNoticeAction":"backlog:confirm","deleteNoticeAction":"backlog:confirm","duplicateNoticeAction":"backlog:confirm","publishNoticeAction":"backlog:confirm","restoreNoticeAction":"backlog:confirm","updateNoticeAction":"backlog:confirm"},
 "app/admin/organization/statutory-tab-actions.ts":{"saveCompanyStatutoryTabAction":"backlog:confirm"},
 "app/admin/pay-components/actions.ts":{"archiveComponentAction":"backlog:confirm","createComponentAction":"registered:typed_pay_components.create","deleteComponentAction":"backlog:confirm","draftPayRuleAction":"backlog:confirm","previewPayRuleAction":"backlog:automatic","searchPreviewEmployeesAction":"backlog:automatic","seedCatalogAction":"backlog:confirm","updateComponentAction":"backlog:confirm"},
 "app/admin/pay-components/import/route.ts#route":{"POST":"backlog:confirm"},
 "app/admin/payroll-config/actions.ts":{"savePayrollConfigAction":"backlog:confirm"},
 "app/admin/payroll-cycle/actions.ts":{"copyCycleAction":"backlog:confirm","deleteCycleAction":"backlog:confirm","seedCatalogAction":"backlog:confirm","setActiveAction":"backlog:confirm","upsertCycleAction":"backlog:confirm"},
 "app/admin/payroll-permissions/actions.ts":{"deletePayrollPermissionAction":"handoff:access_and_authentication","setPayrollPermissionAction":"handoff:access_and_authentication"},
 "app/admin/payroll-policy/actions.ts":{"assignPolicyAction":"backlog:confirm","copyPolicyAction":"backlog:confirm","createPolicyAction":"backlog:confirm","deletePolicyAction":"backlog:confirm","setStatusAction":"backlog:confirm","updatePolicyAction":"backlog:confirm"},
 "app/admin/personnel/[employmentId]/actions.ts":{"addDelegationAction":"backlog:approve","changeEmploymentCompanyAction":"backlog:approve","correctHireDetailsAction":"backlog:approve","createMovementEventAction":"registered:employees.movement.transfer","deleteEmployeeDocumentAction":"backlog:approve","editCompensationAction":"registered:employees.compensation.maintain","editMovementEventAction":"backlog:approve","endDelegationAction":"backlog:approve","removePersonPhotoAction":"backlog:approve","replaceEmployeeDocumentAction":"backlog:approve","reverseMovementEventAction":"backlog:approve","saveAttendanceTabAction":"backlog:approve","saveBankStatutoryTabAction":"backlog:approve","saveCardIdFieldAction":"backlog:approve","saveJobTabAction":"backlog:approve","savePayrollTabAction":"backlog:approve","saveProfileTabAction":"backlog:approve","setBankAction":"backlog:approve","setClockingControlAction":"backlog:approve","setCompensationAction":"registered:employees.compensation.maintain","setComplianceFieldsAction":"backlog:approve","setContactAddressAction":"backlog:approve","setDefaultShiftAction":"backlog:approve","setDirectSuperiorAction":"registered:org.reporting.change","setEmploymentBlacklistAction":"handoff:employment_exit_or_discipline","setEmploymentComponentAction":"backlog:approve","setEmploymentHolidayCalendarAction":"backlog:approve","setEmploymentInfoAction":"backlog:approve","setEmploymentScheduleGroupAction":"backlog:approve","setIcAction":"backlog:approve","setLocationAction":"backlog:approve","setOthersStatutoryAction":"backlog:approve","setPassportAction":"backlog:approve","setPaymentMethodAction":"backlog:approve","setPersonAction":"backlog:approve","setPersonPhotoAction":"backlog:approve","setStatutoryAction":"registered:country-my.statutory.update","setTaxAction":"backlog:approve","setTp3Action":"backlog:approve","supersedeCompensationAction":"registered:employees.compensation.maintain","updateEmployeeDocumentMetaAction":"registered:employees.document_metadata.maintain","uploadEmployeeDocumentAction":"backlog:approve","saveMovementPageAction":"backlog:approve"},
 // employees.cost_allocation.maintain is a bounded complete replace/clear review. These broad native
 // exports retain backlog status: oversized or incompletely visible timelines/catalogs hand off.
 "app/admin/personnel/[employmentId]/cost-allocation-actions.ts":{"previewCostAllocationsAction":"backlog:automatic","readCostAllocationsAction":"backlog:automatic","saveCostAllocationsAction":"backlog:approve"},
 "app/admin/personnel/[employmentId]/cp38-actions.ts":{"addCp38Action":"backlog:approve","editCp38Action":"backlog:approve","terminateCp38Action":"backlog:approve"},
 "app/admin/personnel/[employmentId]/dependent-actions.ts":{"addDependentAction":"registered:employees.family.maintain","archiveDependentAction":"registered:employees.family.maintain","editDependentAction":"registered:employees.family.maintain"},
 "app/admin/personnel/[employmentId]/emergency-contact-actions.ts":{"addEmergencyContactAction":"registered:employees.emergency_contact.maintain","deleteEmergencyContactAction":"registered:employees.emergency_contact.maintain","editEmergencyContactAction":"registered:employees.emergency_contact.maintain"},
 "app/admin/personnel/[employmentId]/encashment-actions.ts":{"adjustEncashmentAction":"backlog:approve","unfreezeEncashmentAction":"backlog:approve"},
 "app/admin/personnel/[employmentId]/holiday-calendar-actions.ts":{"saveHolidayCalendarAssignmentAction":"backlog:approve"},
 "app/admin/personnel/[employmentId]/incentive-actions.ts":{"revokeIncentiveDeclarationAction":"backlog:approve","saveIncentiveDeclarationAction":"backlog:approve"},
 "app/admin/personnel/[employmentId]/qualification-actions.ts":{"addQualificationAction":"registered:employees.qualification.maintain","archiveQualificationAction":"registered:employees.qualification.maintain","editQualificationAction":"registered:employees.qualification.maintain"},
 "app/admin/personnel/[employmentId]/tax-selection-actions.ts":{"savePayrollTaxSelectionAction":"backlog:approve"},
 // Profile person/update sections are supported by employees.workforce_profile.maintain; this composite
 // export also reaches qualification/emergency/dependent kinds, which remain distinct pending parity.
 "app/admin/personnel/[employmentId]/workforce-record-actions.ts":{"saveWorkforceCodeAction":"registered:employees.code.maintain","saveWorkforceRecordAction":"backlog:approve"},
 "app/admin/personnel/actions.ts":{"decideProfileChangeAction":"backlog:approve"},
 "app/admin/personnel/column-actions.ts":{"resetEmployeeColumnsAction":"backlog:approve","saveEmployeeColumnsAction":"backlog:approve"},
 "app/admin/personnel/import/actions.ts":{"associateReusedEmployeeImportHeaderAction":"backlog:approve","beginEmployeeImportEvaluationAction":"backlog:approve","commitImportAction":"registered:employees.import","eraseOwnImportEvaluationMetadataAction":"handoff:privacy_erasure","prepareEmployeeImportEvaluationCommitAction":"backlog:approve","recordEmployeeImportEvaluationTelemetryAction":"backlog:approve","reopenEmployeeImportEvaluationAction":"backlog:approve","validateImportAction":"backlog:automatic"},
 "app/admin/personnel/import/assistance-actions.ts":{"assistPersonnelImportHeadersAction":"backlog:approve","preparePersonnelImportHeadersAction":"backlog:approve","reopenPersonnelImportHeadersAction":"backlog:approve"},
 "app/admin/personnel/import/bank-statutory/jobs/[jobId]/route.ts#route":{"POST":"backlog:approve","PUT":"backlog:approve"},
 "app/admin/personnel/import/bank-statutory/jobs/route.ts#route":{"POST":"backlog:approve"},
 "app/admin/personnel/import/bank-statutory/upload/route.ts#route":{"POST":"backlog:approve"},
 "app/admin/personnel/import/cost-allocation-actions.ts":{"allocationImportReferencesAction":"backlog:approve","allocationWorkbookReferencesAction":"backlog:approve","confirmAllocationImportAction":"backlog:approve"},
 "app/admin/personnel/import/cost-allocation/upload/route.ts#route":{"POST":"backlog:approve"},
 "app/admin/personnel/import/employee/upload/route.ts#route":{"POST":"internal:other_client_same_service"},
 "app/admin/personnel/import/history/actions.ts":{"previewImportRevertAction":"backlog:automatic","revertImportAction":"backlog:approve"},
 "app/admin/personnel/import/movement-actions.ts":{"commitMovementAction":"backlog:approve","movementCatalogAction":"backlog:approve","previewMovementAction":"backlog:automatic"},
 "app/admin/personnel/import/movement/route.ts#route":{"POST":"backlog:approve"},
 "app/admin/personnel/import/section-actions.ts":{"commitSectionAction":"backlog:approve","registerRecordsAction":"backlog:approve","validateSectionAction":"backlog:automatic"},
 "app/admin/personnel/new/actions.ts":{"checkEmployeeCodeAction":"backlog:automatic","createDraftAction":"backlog:approve","createEmployeeAction":"backlog:approve","discardDraftAction":"backlog:approve","saveDraftAction":"backlog:approve"},
 "app/admin/personnel/profile-changes/actions.ts":{"decideProfileChangeAction":"backlog:approve","rerouteProfileChangeAction":"backlog:approve"},
 "app/admin/privacy/actions.ts":{"erasePersonPiiAction":"handoff:privacy_erasure"},
 "app/admin/privacy/case-handlers/actions.ts":{"designateCaseHandlerAction":"handoff:access_and_authentication","revokeCaseHandlerAction":"handoff:access_and_authentication"},
 "app/admin/rewards/access/actions.ts":{"decideRewardAccessRequestAction":"handoff:access_and_authentication","previewRewardAccessBatchAction":"backlog:automatic","previewRewardAccessCopyAction":"backlog:automatic","saveRewardAccessBatchAction":"handoff:access_and_authentication"},
 "app/admin/rewards/actions.ts":{"cancelRewardAction":"registered:rewards.cancel_review"},
 "app/admin/rewards/shared/actions.ts":{"changeSharedRewardExclusionAction":"backlog:confirm","loadSharedRewardTakenAction":"backlog:automatic","saveSharedRewardPolicyAction":"backlog:confirm"},
 "app/admin/settings/actions.ts":{"archiveBusinessUnitAction":"backlog:confirm","archiveCostCenterAction":"backlog:confirm","archiveDepartmentAction":"backlog:confirm","archivePositionAction":"backlog:confirm","assignLabelCompaniesAction":"backlog:confirm","copyLabelsToCompaniesAction":"backlog:confirm","createBusinessUnitAction":"backlog:confirm","createCostCenterAction":"backlog:confirm","createDepartmentAction":"backlog:confirm","createPositionAction":"backlog:confirm","deleteCostCenterAction":"backlog:confirm","deleteDepartmentAction":"backlog:confirm","deletePositionAction":"backlog:confirm","removeJobGradeGridAction":"backlog:confirm","restoreJobGradeGridAction":"backlog:confirm","saveJobGradesGridAction":"backlog:confirm","saveLabelsGridAction":"backlog:confirm","setCompanySharedLabelsAction":"backlog:confirm","setLabelCriteriaAction":"backlog:confirm","setLabelGlobalAction":"backlog:confirm","unassignLabelCompaniesAction":"backlog:confirm","updateBusinessUnitAction":"backlog:confirm","updateCostCenterAction":"backlog:confirm","updateDepartmentAction":"backlog:confirm","updatePositionAction":"backlog:confirm"},
 "app/admin/settings/dashboard/actions.ts":{"createCardAction":"backlog:confirm","deleteCardAction":"backlog:confirm","setStatusAction":"backlog:confirm","updateCardAction":"backlog:confirm"},
 "app/admin/settings/dashboard/home-actions.ts":{"saveHomeConfigurationAction":"backlog:confirm"},
 "app/admin/settings/entra/actions.ts":{"saveEntra":"handoff:access_and_authentication","testEntra":"handoff:access_and_authentication","bindEntra":"handoff:access_and_authentication","retryEntra":"handoff:access_and_authentication","reconcileEntra":"handoff:access_and_authentication"},
 "app/admin/settings/email/actions.ts":{"activateEmailDraft":"handoff:access_and_authentication","saveEmailDraft":"handoff:access_and_authentication","saveEmailRetention":"handoff:access_and_authentication","testEmailDraft":"handoff:access_and_authentication"},
 "app/admin/settings/email/demo-actions.ts":{"testDemoSmtpConnection":"internal:session_and_presentation"},
 "app/admin/settings/employee-id/actions.ts":{"createConfigAction":"backlog:confirm","deleteConfigAction":"backlog:confirm","setStatusAction":"backlog:confirm","updateConfigAction":"backlog:confirm"},
 "app/admin/settings/hiring-defaults/actions.ts":{"saveHiringDefaultsAction":"backlog:confirm"},
 "app/admin/settings/login/actions.ts":{"saveLoginPresentationAction":"handoff:access_and_authentication","saveSessionPolicyAction":"handoff:access_and_authentication"},
 "app/admin/settings/movement/actions.ts":{"deleteMovementEventTypeAction":"backlog:confirm","deleteTerminationReasonAction":"backlog:confirm","saveMovementEventTypeAction":"backlog:confirm","saveTerminationReasonAction":"backlog:confirm","setMovementEventTypeActiveAction":"backlog:confirm","setTerminationReasonActiveAction":"backlog:confirm"},
 "app/admin/settings/notifications/actions.ts":{"retryAccountEmailAction":"backlog:confirm","retryWorkflowEmail":"backlog:confirm","saveWorkflowEmailPolicy":"backlog:confirm"},
 "app/admin/settings/people-general/actions.ts":{"savePeopleGeneralAction":"backlog:confirm"},
 "app/admin/settings/profile-requests/actions.ts":{"previewNamedProfileRoutingAction":"backlog:automatic","saveNamedProfileRoutingAction":"backlog:confirm","saveOwnPhotoSettingAction":"backlog:confirm","saveProfileRequestApproverAction":"backlog:confirm","saveProfileRequestFieldsAction":"backlog:confirm"},
 "app/admin/settings/system-labels/errors/route.ts#route":{"POST":"backlog:confirm"},
 "app/admin/settings/system-labels/import-actions.ts":{"importLabelsAction":"backlog:confirm","previewLabelsAction":"backlog:automatic"},
 "app/admin/settings/system-labels/import/route.ts#route":{"POST":"backlog:confirm"},
 "app/admin/settings/system-labels/profile-options/actions.ts":{"createProfileOptionAction":"backlog:confirm","deleteProfileOptionAction":"backlog:confirm","removeProfileOptionAction":"backlog:confirm","saveProfileOptionsAction":"backlog:confirm","seedProfileOptionsAction":"backlog:confirm","setProfileOptionActiveAction":"backlog:confirm","updateProfileOptionAction":"backlog:confirm"},
 "app/admin/system-testing/actions.ts":{"createTestCaseAction":"backlog:confirm","raiseRunAsFeedbackAction":"backlog:confirm","recordTestRunAction":"backlog:confirm","updateTestCaseAction":"backlog:confirm"},
 "app/admin/system-testing/workspace-actions.ts":{"assignTestingCaseAction":"backlog:confirm","beginTestingExecutionAction":"backlog:confirm","confirmTestingCatalogueAction":"backlog:confirm","raiseLegacyTestingFeedbackAction":"backlog:confirm","raiseTestingFeedbackAction":"backlog:confirm","requestTestingRetestAction":"backlog:confirm","saveTestingInstructionAction":"backlog:confirm","saveTestingObservationAction":"registered:system_testing.execution.save"},
 "app/admin/users/access/actions.ts":{"previewAccessConfigurationAction":"handoff:access_and_authentication","saveAccessConfigurationAction":"handoff:access_and_authentication"},
 "app/admin/users/manual-actions.ts":{"cancelManualAccountAction":"handoff:access_and_authentication","createManualAccountAction":"handoff:access_and_authentication","resumeManualAccountAction":"handoff:access_and_authentication"},
 "app/api/assistant/module-actions/route.ts#route":{"POST":"internal:assistant_surface"},
 "app/api/assistant/own-leave/route.ts#route":{"POST":"internal:assistant_surface"},
 "app/api/attendance/clock/route.ts#route":{"POST":"internal:other_client_same_service"},
 "app/api/home/greetings/route.ts#route":{"POST":"internal:session_and_presentation"},
 "app/api/home/interactions/route.ts#route":{"POST":"internal:session_and_presentation"},
 "app/api/mobile/v1/clock-attempts/route.ts#route":{"POST":"internal:other_client_same_service"},
 "app/api/mobile/v1/clock-device/route.ts#route":{"POST":"internal:other_client_same_service"},
 "app/api/mobile/v1/clock-location/route.ts#route":{"POST":"internal:other_client_same_service"},
 "app/api/mobile/v1/clock/route.ts#route":{"POST":"internal:other_client_same_service"},
 "app/api/mobile/v1/integrity/enrollment/begin/route.ts#route":{"POST":"internal:other_client_same_service"},
 "app/api/mobile/v1/integrity/enrollment/complete/route.ts#route":{"POST":"internal:other_client_same_service"},
 "app/api/mobile/v1/integrity/key-receipt/route.ts#route":{"POST":"internal:other_client_same_service"},
 "app/api/mobile/v1/integrity/revoke/route.ts#route":{"POST":"internal:other_client_same_service"},
 "app/api/mobile/v1/leave-preview/route.ts#route":{"POST":"internal:other_client_same_service"},
 "app/api/mobile/v1/leave-requests/route.ts#route":{"POST":"internal:other_client_same_service"},
 "app/api/mobile/v1/submission-abandon/route.ts#route":{"POST":"internal:other_client_same_service"},
 "app/api/mobile/v2/attendance/applications/[id]/withdraw/route.ts#route":{"POST":"internal:other_client_same_service"},
 "app/api/mobile/v2/attendance/corrections/route.ts#route":{"POST":"internal:other_client_same_service"},
 "app/api/mobile/v2/attendance/overtime-plans/route.ts#route":{"POST":"internal:other_client_same_service"},
 "app/api/mobile/v2/attendance/replacement-leave/route.ts#route":{"POST":"internal:other_client_same_service"},
 "app/api/mobile/v2/claims/[id]/cancel/route.ts#route":{"POST":"internal:other_client_same_service"},
 "app/api/mobile/v2/claims/[id]/delete/route.ts#route":{"POST":"internal:other_client_same_service"},
 "app/api/mobile/v2/claims/drafts/route.ts#route":{"POST":"internal:other_client_same_service"},
 "app/api/mobile/v2/claims/drafts/submit/route.ts#route":{"POST":"internal:other_client_same_service"},
 "app/api/mobile/v2/claims/route.ts#route":{"POST":"internal:other_client_same_service"},
 "app/api/mobile/v2/documents/share-events/route.ts#route":{"POST":"internal:other_client_same_service"},
 "app/api/mobile/v2/integrity/android/clock/begin/route.ts#route":{"POST":"internal:other_client_same_service"},
 "app/api/mobile/v2/integrity/android/clock/complete/route.ts#route":{"POST":"internal:other_client_same_service"},
 "app/api/mobile/v2/integrity/android/enrollment/begin/route.ts#route":{"POST":"internal:other_client_same_service"},
 "app/api/mobile/v2/integrity/android/enrollment/complete/route.ts#route":{"POST":"internal:other_client_same_service"},
 "app/api/mobile/v2/integrity/android/offline/claim/route.ts#route":{"POST":"internal:other_client_same_service"},
 "app/api/mobile/v2/integrity/android/offline/context/close/route.ts#route":{"POST":"internal:other_client_same_service"},
 "app/api/mobile/v2/integrity/android/offline/context/route.ts#route":{"POST":"internal:other_client_same_service"},
 "app/api/mobile/v2/integrity/ios/clock/begin/route.ts#route":{"POST":"internal:other_client_same_service"},
 "app/api/mobile/v2/integrity/ios/clock/complete/route.ts#route":{"POST":"internal:other_client_same_service"},
 "app/api/mobile/v2/integrity/ios/offline/claim/route.ts#route":{"POST":"internal:other_client_same_service"},
 "app/api/mobile/v2/integrity/ios/offline/context/close/route.ts#route":{"POST":"internal:other_client_same_service"},
 "app/api/mobile/v2/integrity/ios/offline/context/route.ts#route":{"POST":"internal:other_client_same_service"},
 "app/api/mobile/v2/integrity/key-receipt/route.ts#route":{"POST":"internal:other_client_same_service"},
 "app/api/mobile/v2/integrity/revoke/route.ts#route":{"POST":"internal:other_client_same_service"},
 "app/api/mobile/v2/leave/requests/[id]/cancellation/route.ts#route":{"POST":"internal:other_client_same_service"},
 "app/api/mobile/v2/leave/requests/[id]/withdraw/route.ts#route":{"POST":"internal:other_client_same_service"},
 "app/api/mobile/v2/notifications/read/route.ts#route":{"POST":"internal:other_client_same_service"},
 "app/api/mobile/v2/profile/changes/route.ts#route":{"POST":"internal:other_client_same_service"},
 "app/api/mobile/v2/push/enrollment/route.ts#route":{"POST":"internal:other_client_same_service"},
 "app/api/mobile/v2/push/revoke/route.ts#route":{"POST":"internal:other_client_same_service"},
 "app/api/mobile/v2/pack-workspaces/[kind]/[id]/decision/route.ts#route":{"POST":"internal:other_client_same_service"},
 "app/api/mobile/v2/request-workspaces/[kind]/[id]/decision/route.ts#route":{"POST":"internal:other_client_same_service"},
 "app/api/mobile/v2/review-workspaces/[kind]/[id]/decision/route.ts#route":{"POST":"internal:other_client_same_service"},
 "app/api/mobile/v2/tasks/[kind]/[id]/decision/route.ts#route":{"POST":"internal:other_client_same_service"},
 "app/approvals/actions.ts":{"approveClaimAction":"registered:approvals.claim.decide","approveCorrectionAction":"registered:approvals.attendance.decide","approveLeaveAction":"registered:approvals.leave.decide","approveProfileChangeAction":"backlog:approve","bulkDecideAction":"backlog:approve","decideLeaveCancellationAction":"backlog:approve","decideLeaveDateAction":"backlog:approve","decideLeaveDatesAction":"backlog:approve","decideResignationAction":"handoff:employment_exit_or_discipline","decideReviewAction":"backlog:approve","submitManagerEvaluationAction":"backlog:approve"},
 "app/assistant/actions.ts":{"askAssistantAction":"internal:assistant_surface"},
 "app/assistant/file-import-actions.ts":{"prepareAssistantImportAction":"internal:assistant_surface"},
 "app/assistant/agent-review-actions.ts":{"createAgentCandidateAction":"internal:assistant_surface","createConversationCandidateAction":"internal:assistant_surface","eraseConversationMetadataAction":"internal:assistant_surface","evaluateAgentCandidateAction":"internal:assistant_surface","evaluateConversationCandidateAction":"internal:assistant_surface","promoteAgentCandidateAction":"internal:assistant_surface","promoteConversationCandidateAction":"internal:assistant_surface","rollbackAgentCandidateAction":"internal:assistant_surface","tryAgentCandidateAction":"internal:assistant_surface"},
 "app/assistant/feedback-actions.ts":{"eraseAgentFeedbackAction":"internal:assistant_surface","saveAgentFeedbackAction":"internal:assistant_surface"},
 "app/assistant/governed-job-actions.ts":{"runGovernedPlanAction":"internal:assistant_surface"},
 "app/assistant/history-privacy-actions.ts":{"eraseAssistantHistoryAction":"internal:assistant_surface"},
 "app/assistant/import-privacy-actions.ts":{"eraseImportPreparationHistoryAction":"internal:assistant_surface"},
 "app/assistant/job-feedback-actions.ts":{"eraseGovernedJobFeedbackAction":"internal:assistant_surface","saveGovernedJobFeedbackAction":"internal:assistant_surface"},
 "app/analytics/ai-actions.ts":{"readProtectedAnalysisAction":"backlog:automatic"},
 "app/assistant/leave-apply-proposal-actions.ts":{"confirmLeaveApplyProposalAction":"internal:assistant_surface","editLeaveApplyProposalAction":"internal:assistant_surface"},
 "app/assistant/attendance-request-proposal-actions.ts":{"confirmAttendanceRequestProposalAction":"internal:assistant_surface","editAttendanceRequestProposalAction":"internal:assistant_surface"},
 "app/assistant/toil-request-proposal-actions.ts":{"confirmToilRequestProposalAction":"internal:assistant_surface","editToilRequestProposalAction":"internal:assistant_surface"},
 "app/assistant/assigned-decision-proposal-actions.ts":{"confirmAssignedDecisionProposalAction":"internal:assistant_surface","editAssignedDecisionProposalAction":"internal:assistant_surface"},
 // AI v2 Phase 1 slice 3: the own letter request card prepared in chat (core/assistant-actions/letter-request-proposal-confirm.ts).
 "app/assistant/letter-request-proposal-actions.ts":{"confirmLetterRequestProposalAction":"internal:assistant_surface","editLetterRequestProposalAction":"internal:assistant_surface"},
 "app/assistant/own-change-proposal-actions.ts":{"confirmOwnChangeProposalAction":"internal:assistant_surface","editOwnChangeProposalAction":"internal:assistant_surface"},
 "app/assistant/chat-import-actions.ts":{"confirmChatImportAction":"internal:assistant_surface"},
 "app/assistant/loop-clock-out-actions.ts":{"confirmMissedClockOutAction":"internal:assistant_surface"},
 "app/assistant/capacity-actions.ts":{"setCapacityBaselineAction":"handoff:ai_governance"},
 // AI v2 Phase 2 P2-5: the Living Handbook (AI Centre › Policies). People write, confirm and approve policies; the AI never does.
 "app/assistant/policy-actions.ts":{"applyScheduledPolicyValueAction":"handoff:ai_governance","approvePolicyAction":"handoff:ai_governance","createPolicyAction":"handoff:ai_governance","decidePolicyValueAction":"handoff:ai_governance","draftFromVersionAction":"handoff:ai_governance","markTextOnlyAction":"handoff:ai_governance","prepareFromDriftAction":"handoff:ai_governance","readPolicyValuesAction":"handoff:ai_governance","returnPolicyAction":"handoff:ai_governance","saveDraftAction":"handoff:ai_governance","submitPolicyAction":"handoff:ai_governance"},
 // AI v2 Phase 2 P2-6: the learning loops. A card's Confirm/Edit/Discard and an answer's mark record a learning signal for the
 // person's own turn (assistant surface); every other command is an administrator's AI quality decision (AI governance).
 "app/assistant/learning-actions.ts":{"approveCandidateAction":"handoff:ai_governance","decideProposalAction":"handoff:ai_governance","dismissSignalAction":"handoff:ai_governance","editCandidateAction":"handoff:ai_governance","exportCandidateAction":"handoff:ai_governance","markAnswerAction":"internal:assistant_surface","promoteSignalAction":"handoff:ai_governance","recordCardSignalAction":"internal:assistant_surface","reopenCandidateAction":"handoff:ai_governance","reopenSignalAction":"handoff:ai_governance","revertProposalAction":"handoff:ai_governance","setGapStatusAction":"handoff:ai_governance","withdrawCandidateAction":"handoff:ai_governance"},
 // AI v2 Phase 2 P2-1: the employee's own Undo of a clock-out the missed clock-outs loop set (core/loops/undo.ts).
 "app/assistant/loop-undo-actions.ts":{"undoOwnLoopAction":"internal:assistant_surface"},
 "app/assistant/launcher-actions.ts":{"askFromLauncherAction":"internal:assistant_surface","askFromWorkspaceAction":"internal:assistant_surface","loadEarlierChatAction":"internal:assistant_surface","loadMoreChatsAction":"internal:assistant_surface","openStoredChatAction":"internal:assistant_surface","chatImportOfferedAction":"internal:assistant_surface"},
 "app/assistant/chat-actions.ts":{"chatRetentionAction":"internal:assistant_surface","deleteChatAction":"internal:assistant_surface","eraseAllChatsAction":"internal:assistant_surface","listChatsAction":"internal:assistant_surface","setChatRetentionAction":"handoff:ai_governance"},
 "app/assistant/module-plan-actions.ts":{"eraseModuleProposalsAction":"internal:assistant_surface","evaluateHumanPlannerAction":"internal:assistant_surface","proposeModulePlanAction":"internal:assistant_surface"},
 "app/assistant/native-outcome-actions.ts":{"eraseNativeOutcomesAction":"internal:assistant_surface","recordNativeOutcomeAction":"internal:assistant_surface","reopenNativeOutcomeAction":"internal:assistant_surface"},
 "app/assistant/specialist-review-actions.ts":{"createSpecialistCandidateAction":"internal:assistant_surface","evaluateSpecialistCandidateAction":"internal:assistant_surface","promoteSpecialistCandidateAction":"internal:assistant_surface","rollbackSpecialistCandidateAction":"internal:assistant_surface","runSpecialistJobAction":"internal:assistant_surface"},
 "app/attendance/actions.ts":{"decideCorrectionAction":"registered:approvals.attendance.decide"},
 "app/attendance/application-history/actions.ts":{"attendanceHistoryAction":"backlog:confirm","attendanceHistoryBulkAction":"backlog:confirm"},
 "app/attendance/application-history/offline-actions.ts":{"resolveOfflineClaimAction":"backlog:approve"},
 "app/attendance/clock/actions.ts":{"clockInAction":"backlog:confirm","clockOutAction":"backlog:confirm","requestClockRemovalAction":"backlog:confirm"},
 "app/attendance/import/actions.ts":{"commitClockingImportAction":"backlog:confirm","validateClockingImportAction":"backlog:automatic"},
 "app/attendance/individual/[date]/actions.ts":{"adminCorrectAttendanceDayAction":"backlog:confirm","rejectAttendanceDayApplicationAction":"backlog:approve","saveAttendanceClockDataAction":"backlog:confirm","saveAttendanceDayChangesAction":"backlog:confirm","saveAttendanceDayScheduleAction":"registered:attendance.day_schedule.correct","submitUnclockedAttendanceWorkAction":"backlog:confirm"},
 "app/attendance/my-records/[date]/actions.ts":{"requestOwnAttendanceDayAction":"registered:attendance.correction.request"},
 "app/attendance/recompute/actions.ts":{"applyRecomputeAction":"backlog:confirm","previewRecomputeAction":"backlog:confirm"},
 "app/auth-actions.ts":{"logoutAction":"handoff:access_and_authentication","requestPasswordResetAction":"handoff:access_and_authentication","signOutUnlinkedAction":"handoff:access_and_authentication"},
 "app/cases/actions.ts":{"addPrivateCaseNoteAction":"handoff:private_case","setPrivateCaseStatusAction":"handoff:private_case"},
 "app/claims/actions.ts":{"cancelClaimAction":"registered:claims.cancel","deleteDraftAction":"backlog:confirm","submitClaimAction":"backlog:confirm","submitDraftsAction":"registered:claims.submit"},
 "app/control-tower/actions/actions.ts":{"approveAgentActionAction":"handoff:ai_governance"},
 "app/control-tower/agents/actions.ts":{"applyBulkAssistantAction":"handoff:ai_governance","clearGroupAllowanceAction":"handoff:ai_governance","clearUserAllowanceAction":"handoff:ai_governance","setAiAllowanceAction":"handoff:ai_governance","setAiFeatureAction":"handoff:ai_governance","setAiFeatureCapAction":"handoff:ai_governance","setAgentActionPauseAction":"handoff:ai_governance","setAiSpendBudgetAction":"handoff:ai_governance","setAssistantPermissionAction":"handoff:ai_governance","setGroupAllowanceAction":"handoff:ai_governance"},
 "app/control-tower/agents/launcher-actions.ts":{"setAssistantLauncherAction":"handoff:ai_governance"},
 "app/control-tower/loops/actions.ts":{"setLoopPauseAction":"handoff:ai_governance","setLoopSwitchAction":"handoff:ai_governance"},
 "app/control-tower/loops/loop_payroll_audit/actions.ts":{"captureAuditNowAction":"handoff:ai_governance","disposeAuditFindingAction":"handoff:ai_governance","grantAuditReaderAction":"handoff:access_and_authentication","recordCorrectionCauseAction":"handoff:ai_governance","revokeAuditReaderAction":"handoff:access_and_authentication","setAuditSettingsAction":"handoff:ai_governance"},
 "app/control-tower/loops/payroll-cycle/actions.ts":{"decideThresholdProposalAction":"handoff:ai_governance","recordSwingDispositionAction":"handoff:ai_governance","setPayrollLoopSettingAction":"handoff:ai_governance"},
 // AI v2 Phase 2 P2-1: a loop's level per company (group administrators) and HR's undo of an automatic loop action.
 "app/control-tower/loops/autonomy-actions.ts":{"changeLoopLimitsAction":"handoff:ai_governance","reviewLoopSampleAction":"handoff:ai_governance","setLoopLevelAction":"handoff:ai_governance","undoLoopActionFromDetailAction":"handoff:ai_governance"},
 "app/control-tower/orchestrator-actions.ts":{"refreshOrchestrationAction":"handoff:ai_governance"},
 "app/dashboard-layout-actions.ts":{"resetDashboardLayoutAction":"internal:session_and_presentation","saveDashboardLayoutAction":"internal:session_and_presentation"},
 "app/delegations/actions.ts":{"createSelfDelegationAction":"backlog:confirm","hrCreateDelegationAction":"backlog:confirm","hrEditDelegationAction":"backlog:confirm","hrRevokeDelegationAction":"backlog:confirm","loadDelegationContextAction":"backlog:automatic","loadEligibleDelegatesAction":"backlog:automatic","revokeSelfDelegationAction":"backlog:confirm"},
 "app/feedback/actions.ts":{"answerBlockingQuestionAction":"backlog:confirm","approveFeedbackPlanAction":"backlog:approve","bulkReviewAction":"backlog:confirm","cancelFeedbackAction":"backlog:confirm","contestFeedbackPlanAction":"backlog:confirm","generateFeedbackPlanNowAction":"backlog:confirm","refuteDeploymentAction":"backlog:confirm","restoreFeedbackAction":"backlog:confirm","submitFeedbackAction":"backlog:confirm"},
 "app/i18n-actions.ts":{"setLocale":"internal:session_and_presentation"},
 "app/identity-actions.ts":{"actAs":"handoff:access_and_authentication","signOutDemo":"handoff:access_and_authentication"},
 "app/invite/[token]/activate/actions.ts":{"switchInvitationAccount":"handoff:access_and_authentication"},
 "app/knowledge-base/actions.ts":{"archiveDocumentAction":"backlog:confirm","createArticleAction":"registered:knowledge_base.article.create","restoreDocumentAction":"backlog:confirm","updateDocumentAction":"backlog:confirm","uploadFileAction":"backlog:confirm"},
 "app/leave/actions.ts":{"adminCancelLeaveAction":"backlog:confirm","cancelOwnLeaveAction":"registered:leave.cancel","decideReplacementLeaveRequestAction":"registered:approvals.toil.decide","editLeaveAction":"registered:leave.edit","leaveApplySummaryAction":"backlog:confirm","leaveCreditDayKindAction":"backlog:confirm","leaveCreditExtendedDayAction":"backlog:confirm","previewLeaveDeductionAction":"backlog:automatic","requestLeaveAction":"registered:leave.apply","requestLeaveCancellationAction":"backlog:confirm","submitReplacementLeaveRequestAction":"registered:toil.replacement.request"},
 "app/leave/credit/actions.ts":{"cancelLeaveCreditRequestAction":"backlog:confirm","leaveCreditClaimReviewAction":"backlog:confirm","leaveCreditDayFactsAction":"backlog:confirm","submitLeaveCreditRequestAction":"backlog:confirm"},
 "app/letters/approval/actions.ts":{"bulkApprove":"backlog:approve","decideApproval":"backlog:approve","delegateApproval":"backlog:confirm"},
 "app/letters/fields/actions.ts":{"saveField":"backlog:confirm"},
 "app/letters/generate/actions.ts":{"createGeneration":"backlog:confirm","declineLetterRequestAction":"backlog:approve","updateGeneration":"backlog:confirm"},
 "app/letters/register/actions.ts":{"updateRegister":"backlog:confirm"},
 "app/letters/settings/actions.ts":{"savePolicySettings":"backlog:confirm","uploadLetterAsset":"backlog:confirm"},
 "app/letters/settings/request-actions.ts":{"saveLetterRequestOptionsAction":"backlog:confirm"},
 "app/letters/settings/automation/actions.ts":{"saveAutomationSettings":"backlog:confirm"},
 "app/letters/templates/actions.ts":{"previewTemplate":"backlog:automatic","saveTemplate":"backlog:confirm","updateTemplate":"backlog:confirm"},
 "app/lifecycle/actions.ts":{"acknowledgeAction":"registered:lifecycle.acknowledgement.submit","advanceAssetRequestAction":"backlog:confirm","bulkAssetStatusAction":"backlog:confirm","cancelAssetRequestAction":"backlog:confirm","cancelCaseAction":"backlog:confirm","cancelRequisitionAction":"backlog:confirm","commentAction":"backlog:confirm","createAssetRequestAction":"backlog:confirm","createOffboardingAction":"backlog:confirm","createOnboardingAction":"backlog:confirm","createRequisitionAction":"backlog:confirm","decideAssetRequestAction":"backlog:approve","decideRequisitionAction":"backlog:approve","handlerAction":"backlog:confirm","importCommitAction":"backlog:confirm","importPreviewAction":"backlog:confirm","loadCatalogueAction":"backlog:automatic","outcomeAction":"backlog:confirm","provisionAction":"backlog:confirm","registerAssetAction":"backlog:confirm","reopenCaseAction":"backlog:confirm","returnAssetsAction":"backlog:confirm","tickStepAction":"backlog:confirm","undoStepAction":"backlog:confirm","updateAssetAction":"backlog:confirm","updateCaseAction":"backlog:confirm","updateRequisitionAction":"backlog:confirm"},
 "app/lifecycle/onboarding/v31-actions.ts":{"changeOnboarding":"backlog:confirm","loadOnboardingTask":"backlog:automatic","markOnboardingSeen":"backlog:confirm","saveOnboardingChecklistTasks":"backlog:confirm","saveOnboardingConfig":"backlog:confirm","setupOnboarding":"backlog:confirm","writeOnboardingNote":"backlog:confirm"},
 "app/login/entra/[operation]/route.ts#route":{"POST":"handoff:access_and_authentication"},
 "app/login/api/[operation]/route.ts#route":{"POST":"handoff:access_and_authentication"},
 "app/login/as/route.ts#route":{"POST":"handoff:access_and_authentication"},
 "app/me/actions.ts":{"localizeLeaveError":"backlog:confirm","myCancelAttendanceRequest":"backlog:confirm","myCancelLeave":"registered:leave.cancel","myCheckIn":"backlog:confirm","myCheckOut":"backlog:confirm","myCreateGoal":"backlog:confirm","myDeclinePeerFeedback":"backlog:confirm","myEditGoal":"backlog:confirm","myEditLeave":"registered:leave.edit","myPreviewLeaveDeduction":"backlog:automatic","myRequestCorrection":"registered:attendance.correction.request","myRequestLeave":"registered:leave.apply","myRequestLeaveCancellation":"backlog:confirm","myRequestOvertime":"registered:attendance.overtime.request","myRequestProfileChange":"backlog:confirm","mySubmitPeerFeedback":"backlog:confirm","mySubmitResignation":"handoff:employment_exit_or_discipline","myTp1FormAction":"backlog:confirm","myUpdateContact":"backlog:confirm","myUpdateGoalProgress":"backlog:confirm","myWithdrawOvertimePlan":"backlog:confirm","myWithdrawResignation":"handoff:employment_exit_or_discipline"},
 "app/me/cases/actions.ts":{"openPrivateCaseAction":"handoff:private_case"},
 "app/me/home/actions.ts":{"saveHomePreferencesAction":"backlog:confirm"},
 "app/me/home/privacy-actions.ts":{"saveHomePersonPrivacyAction":"backlog:confirm"},
 "app/me/letters/actions.ts":{"confirmMyLetter":"backlog:confirm","openMyLetter":"backlog:confirm","requestLetterAction":"backlog:confirm"},
 "app/me/notifications/actions.ts":{"saveMyLetterEmailPreferences":"backlog:confirm","saveMyWorkflowEmailPreferences":"registered:notifications.email_preferences.save"},
 "app/me/own-photo-action.ts":{"saveOwnPhotoAction":"backlog:confirm"},
 "app/me/profile-edit-actions.ts":{"readMyProfileMovementAction":"backlog:automatic","saveMyProfileEditAction":"backlog:confirm"},
 "app/me/tp3/actions.ts":{"myTp3FormAction":"backlog:confirm"},
 "app/mobile-preview/actions.ts":{"changeMobileDesignAction":"internal:session_and_presentation"},
 "app/notices/actions.ts":{"acknowledgeNoticeAction":"backlog:confirm","dismissNoticePopupAction":"backlog:confirm","markNoticeViewedAction":"backlog:confirm"},
 "app/notification-actions.ts":{"markAllNotificationsReadAction":"backlog:confirm","markNotificationReadAction":"backlog:confirm"},
 "app/onboarding-actions.ts":{"completeOnboardingAction":"internal:session_and_presentation"},
 "app/operator/actions.ts":{"changeCustomerModuleAction":"handoff:platform_operator","createCustomerAction":"handoff:platform_operator","renameCustomerAction":"handoff:platform_operator","requestReissueAction":"handoff:platform_operator","revealActivationUrlAction":"handoff:platform_operator","setCustomerFeedbackMenuAction":"handoff:platform_operator","submitCustomerAction":"handoff:platform_operator"},
 "app/payroll/[batchId]/import-actions.ts":{"commitComponentImportAction":"backlog:approve","dryRunComponentImportAction":"backlog:approve"},
 "app/payroll/[batchId]/leave-followup-actions.ts":{"resolveLeavePayrollExceptionAction":"backlog:approve"},
 "app/payroll/actions.ts":{"closeAction":"registered:payroll.close","deleteDraftBatchAction":"backlog:approve","evaluateAnomaliesAction":"backlog:approve","generateAction":"backlog:approve","narrateAnomalyAction":"backlog:approve","prefillClaimsAction":"backlog:approve","prefillFixedZakatAction":"backlog:approve","prefillLoansAction":"backlog:approve","prefillOvertimeAction":"backlog:approve","prefillShiftDifferentialAction":"backlog:approve","prefillTp1Action":"backlog:approve","proposeHypothesesAction":"backlog:approve","removeEmployeePayrollAction":"handoff:payroll_reversal","reprocessSelectedAction":"backlog:approve","resetAction":"registered:payroll.reset","resolveAnomalyAction":"backlog:approve","setPayrollInputAction":"backlog:approve","transferAllowancesAction":"backlog:approve","unlockAction":"registered:payroll.reopen"},
 "app/payroll/back-pay/actions.ts":{"approveAndPostBackPayAction":"backlog:approve","calculateBackPayAction":"backlog:approve","cancelBackPayAction":"backlog:approve","verifyBackPayAction":"backlog:approve"},
 "app/payroll/configuration/actions.ts":{"archiveStatutoryAction":"backlog:approve","archiveStatutoryComponentAction":"backlog:approve","saveStatutoryAction":"backlog:approve","setStatutoryComponentAction":"backlog:approve"},
 "app/payroll/history-import/upload/route.ts#route":{"POST":"backlog:approve"},
 "app/payroll/payment-submission/bank-file/route.ts#route":{"POST":"backlog:approve"},
 "app/payroll/history-import/workflow-actions.ts":{"confirmHistoryUploadAction":"backlog:approve","previewHistoryRevertAction":"backlog:automatic","revertHistoryUploadAction":"handoff:payroll_reversal"},
 // Formula configuration remains native-only; these are inventory ceilings, not registered agent effects.
 // Tax-basis corrections change closed-payroll tax history: the effects stay human, like Payroll Corrections.
 "app/payroll/income-tax-recalculation/actions.ts":{"previewTaxBasisAction":"backlog:approve","confirmTaxBasisAction":"handoff:payroll_reversal","continueTaxBasisAction":"handoff:payroll_reversal","recoverTaxBasisAction":"handoff:payroll_reversal"},
 "app/payroll/formula-builder/actions.ts":{"draftFormulaAction":"backlog:confirm","saveFormulaAction":"backlog:approve","testFormulaAction":"backlog:approve","sampleFormulaAction":"backlog:approve","formulaStateAction":"backlog:approve","deleteFormulaAction":"backlog:approve","saveAccumulationAction":"backlog:approve","searchFormulaEmployeesAction":"backlog:automatic","listFormulaBatchesAction":"backlog:automatic"},
 "app/payroll/payslip-information/actions.ts":{"copyPayslipInformation":"backlog:approve","savePayslipInformation":"backlog:approve"},
 "app/payroll/pcb-payment-actions.ts":{"recordPcbPaymentAction":"backlog:approve"},
 "app/payroll/process/actions.ts":{"checkPayrollCycleReadiness":"backlog:automatic","checkUnattachedForSelection":"backlog:automatic","createRunAction":"registered:multi_cycle_payroll.create_run","fetchPayrollRunEmployees":"backlog:automatic","resumeRunAction":"backlog:approve","runMultiCompanyAction":"backlog:approve","savePayrollDraftsAction":"backlog:approve","validatePayrollSelection":"backlog:automatic"},
 "app/payroll/reports/actions.ts":{"markFiledAction":"backlog:approve","recordReportAction":"backlog:approve","reverseFilingAction":"handoff:payroll_reversal"},
 "app/payroll/reports/ea/[employmentId]/actions.ts":{"amendEaFieldAction":"backlog:approve","clearEaFieldAction":"backlog:approve"},
 "app/payroll/statutory-adjustment/actions.ts":{"previewAdjustmentAction":"backlog:automatic","revertAdjustmentAction":"backlog:approve","saveAdjustmentAction":"backlog:approve"},
 "app/payroll/statutory-forms/[formId]/actions.ts":{"recordReportAction":"backlog:approve"},
 "app/payroll/transactions/deductions-actions.ts":{"adminApproveTp1":"backlog:approve","adminCancelTp1":"backlog:approve","adminDeleteTp1":"backlog:approve","adminDiscardTp1Draft":"backlog:approve","adminRejectTp1":"backlog:approve","adminTp1FormAction":"backlog:approve","saveTp1Action":"backlog:approve"},
 "app/payroll/transactions/fixed/actions.ts":{"archiveFixedTransactionAction":"registered:employees.fixed_item.archive","createFixedTransactionAction":"backlog:approve","endFixedTransactionAction":"backlog:approve","updateFixedTransactionAction":"backlog:approve"},
 "app/payroll/transactions/import-excel/individual-actions.ts":{"validateIndividualImportAction":"backlog:confirm","confirmIndividualImportAction":"backlog:approve","revertIndividualImportAction":"handoff:payroll_reversal"},
 "app/payroll/transactions/import-excel/actions.ts":{"commitTxnImportAction":"backlog:approve","validateTxnImportAction":"backlog:automatic"},
 "app/payroll/transactions/individual/actions.ts":{"createIndividualTxnAction":"backlog:approve","createIndividualTxnDayGridAction":"backlog:approve","deleteIndividualTxnAction":"backlog:approve","fetchBatchImpactAction":"backlog:automatic","fetchEmployeeTxnPanelAction":"backlog:automatic","fetchTxnDetailAction":"backlog:automatic","previewTxnAmountAction":"backlog:automatic","previewTxnAmountsAction":"backlog:automatic","updateIndividualTxnAction":"backlog:approve"},
 "app/payroll/transactions/tp3/actions.ts":{"deleteTp3Action":"backlog:approve","saveTp3Action":"backlog:approve"},
 "app/payroll/transactions/zakat/election-actions.ts":{"saveZakatElectionAction":"backlog:approve"},
 "app/performance/actions.ts":{"acknowledgeAction":"registered:performance.review.acknowledge","approveGoalAction":"backlog:approve","calibrateAction":"backlog:confirm","cancelCheckInAction":"registered:performance.checkin.cancel","closeAction":"backlog:confirm","closeReviewAction":"backlog:confirm","commitCalibrationAction":"backlog:confirm","completeCheckInAction":"registered:performance.checkin.complete","createCycleAction":"backlog:confirm","declineAction":"backlog:confirm","draftManagerReviewAction":"backlog:confirm","enactAction":"backlog:confirm","linkGoalAction":"backlog:confirm","lockGoalSettingAction":"backlog:confirm","openCalibrationAction":"backlog:confirm","openCycleAction":"backlog:confirm","previewEligibilityAction":"backlog:automatic","proposeCalibrationAction":"backlog:confirm","proposeGoalsAction":"backlog:confirm","releaseAction":"backlog:confirm","requestPeerFeedbackAction":"backlog:confirm","scheduleCheckInAction":"backlog:confirm","submitManagerAction":"backlog:confirm","submitSelfAction":"backlog:confirm","submitStageManagerAction":"backlog:confirm","submitStageSelfAction":"backlog:confirm","unlinkGoalAction":"backlog:confirm","uploadAttachmentAction":"backlog:confirm"},
 "app/performance/assessment-reminder-actions.ts":{"assessmentReminderAction":"backlog:confirm","assessmentReminderPersonPreviewAction":"backlog:confirm","assessmentReminderPreviewAction":"backlog:confirm"},
 "app/performance/assessment-rewrite-actions.ts":{"rewriteAssessmentFieldAction":"backlog:confirm"},
 "app/performance/leaders/actions.ts":{"addCalibrationGroupMembersAction":"backlog:confirm","applyHodChangeAction":"backlog:approve","appointLeaderSeatAction":"backlog:approve","calibrationGroupMembersAction":"backlog:confirm","createCalibrationGroupAction":"backlog:confirm","endCalibrationGroupMemberAction":"backlog:confirm","endLeaderSeatAction":"backlog:approve","generateCalibrationScopesAction":"backlog:confirm","previewHodChangeAction":"backlog:automatic","renameCalibrationGroupAction":"backlog:confirm"},
 "app/performance/onehr-actions.ts":{"agreeDepartmentAction":"backlog:confirm","applyCalibrationFitAction":"backlog:confirm","applyCareerPlanDraftAction":"backlog:confirm","applyDevelopmentSuggestionsAction":"backlog:confirm","askPerformanceGuideAction":"backlog:confirm","assessmentArchitectureAction":"backlog:confirm","assessmentCalibrationPersonAction":"backlog:confirm","assessmentCompanyKpiAction":"backlog:confirm","assessmentCompetencyInsightAction":"backlog:confirm","assessmentGenerateProfilesAction":"backlog:confirm","assessmentIdpFitAction":"backlog:confirm","assessmentInsightAction":"backlog:confirm","assessmentKpiImportAction":"backlog:confirm","assessmentPanelsBuildAction":"backlog:confirm","assessmentPanelsImportAction":"backlog:confirm","assessmentPotentialInsightAction":"backlog:confirm","assessmentRecordInsightAction":"backlog:confirm","assessmentTalentInsightAction":"backlog:confirm","assessmentTalentPersonAction":"backlog:confirm","assessmentWrittenRemarksAction":"backlog:confirm","bulkReleaseAction":"backlog:approve","calibrationConversationAction":"backlog:confirm","captureRatingRecordsAction":"backlog:confirm","careerPlanDraftAction":"backlog:confirm","changeGroupBandAction":"backlog:confirm","developmentSuggestionsAction":"backlog:confirm","enableOnehrAction":"backlog:confirm","finalBandsAction":"backlog:confirm","keepCompetencyReflectionAction":"backlog:confirm","lockGroupPeopleAction":"backlog:confirm","onehrCalibrationAction":"backlog:confirm","onehrCycleAction":"backlog:confirm","onehrDraftAction":"backlog:confirm","onehrFeedbackAction":"backlog:confirm","onehrReviewAction":"backlog:confirm","performanceAdminAskAction":"backlog:confirm","performanceAdminAssistantAction":"backlog:confirm","performanceAdminToolAction":"backlog:confirm","performanceGuideExportAction":"backlog:confirm","performanceGuideReportAction":"backlog:confirm","previewCalibrationFitAction":"backlog:automatic","reviewConversationAction":"backlog:confirm","saveAssessmentDraftAction":"backlog:confirm","saveAssessmentKpiSettingAction":"backlog:confirm","saveAssessmentTalentRemarkAction":"backlog:confirm","saveCalibrationBandAction":"backlog:confirm"},
 "app/performance/unit-exclusion-actions.ts":{"endUnitExclusionAction":"backlog:confirm","previewUnitExclusionAction":"backlog:automatic","saveUnitExclusionAction":"backlog:confirm"},
 "app/reports/actions.ts":{"deleteReportAction":"backlog:confirm","draftReport":"backlog:confirm","duplicateReportAction":"backlog:confirm","previewReport":"backlog:automatic","saveAsTemplateAction":"backlog:confirm","saveReportAction":"backlog:confirm","setSharedAction":"backlog:confirm","toggleFavouriteAction":"backlog:confirm"},
 "app/reports/employee-master/actions.ts":{"deleteEmployeeMaster":"backlog:confirm","duplicateEmployeeMaster":"backlog:confirm","masterScheduleRecipients":"backlog:confirm","previewEmployeeMaster":"backlog:automatic","saveEmployeeMaster":"backlog:confirm","saveMasterSchedule":"backlog:confirm"},
 "app/reports/employee-master/export/route.ts#route":{"POST":"backlog:confirm"},
 "app/reports/export/route.ts#route":{"POST":"backlog:confirm"},
 "app/reports/payroll-comparison/actions.ts":{"createPayrollComparisonSampleAction":"backlog:confirm","savePayrollComparisonAction":"backlog:confirm"},
 "app/rewards/governance-actions.ts":{"unitInputsAction":"backlog:approve","exemptionAction":"backlog:approve","confirmGovernanceAction":"backlog:approve","seniorAwardAction":"backlog:approve"},
 "app/rewards/policy-grid-actions.ts":{"loadPreviousRewardPolicyMatrices":"backlog:automatic"},
 "app/rewards/actions.ts":{"calendarAction":"registered:rewards.calendar.update","createRewardAction":"backlog:approve","decideAction":"backlog:approve","deleteRewardAction":"backlog:approve","entryAction":"backlog:approve","importFactsAction":"backlog:approve","importOnehrAction":"backlog:approve","lumpAction":"backlog:approve","memberAction":"backlog:approve","offcycleAction":"backlog:approve","payWindowKeepAction":"backlog:approve","policyAction":"backlog:approve","postAction":"registered:rewards.post","previewRewardAccessAction":"backlog:automatic","previewRewardLumpAction":"backlog:automatic","previewRewardMultiplierAction":"backlog:automatic","previewSeniorMembershipAction":"backlog:automatic","previewSourceRefreshAction":"backlog:automatic","saveRewardAccessAction":"backlog:approve","saveRewardMultiplierAction":"backlog:approve","saveSeniorMembershipAction":"backlog:approve","saveSourceRefreshAction":"backlog:approve"},
 "app/rewards/approvals/actions.ts":{"boardDecideAction":"backlog:approve","sendReadyAction":"backlog:approve"},
 "app/roster/actions.ts":{"accrueToilAction":"backlog:confirm","assignCellAction":"backlog:confirm","bulkAssignAction":"backlog:confirm","copyRosterAction":"backlog:confirm","generateRosterAction":"backlog:confirm","rowAssignAction":"backlog:confirm","saveRosterRowAction":"backlog:confirm"},
 "app/roster/import/actions.ts":{"commitRosterImportAction":"backlog:confirm","dryRunRosterImportAction":"backlog:confirm"},
 "app/scope-actions.ts":{"setCompanyScope":"internal:session_and_presentation"},
 "app/system-testing/executions/[id]/attachments/route.ts#route":{"POST":"backlog:confirm"},
 "app/ui-theme-actions.ts":{"setUiTheme":"internal:session_and_presentation"},
});

/** ADR-0151 §4.5 — what the named agent principal runs unattended: Automatic-tier specialists only, each
 * behind its existing tenant switch and attributed to the administrator who switched it on. These are not
 * human entry points, so they are listed here rather than in the inventory above. Adding one is a reviewed
 * change to this list (core/agent-principal.ts derives its switches from it) and to migration 0672's policies. */
export const AGENT_PRINCIPAL_SPECIALISTS=Object.freeze({
 readiness_reminders:{tier:'automatic',setting:'notifications.readiness_nudge_enabled',service:'core/readiness-nudge.ts#sweepReadinessNudges',effect:'reminder to the employee or HR about a missing record field'},
 claims_triage:{tier:'automatic',setting:'claims.input_triage_enabled',service:'core/input-triage.ts#triagePendingClaims',effect:'question to the claimant; not admitted to a model under the principal'},
 // WP13 (R18): fixed-template reminders only; the registry's Automatic entries name these specialists.
 approval_chasers:{tier:'automatic',setting:'notifications.approval_chasers_enabled',service:'core/automatic-chasers.ts#runApprovalChasers',effect:'reminder to the current approver of an overdue claim, attendance correction or replacement leave request'},
 review_chasers:{tier:'automatic',setting:'notifications.review_chasers_enabled',service:'core/automatic-chasers.ts#runReviewChasers',effect:'reminder to the manager or HR about a probation, contract or internship review undecided after its end date'},
 clock_reminders:{tier:'automatic',setting:'notifications.missing_clock_reminders_enabled',service:'core/automatic-followups.ts#runAutomaticFollowups',effect:'Remind employees when no clock-in is recorded for the previous scheduled working day. This never attests work or changes Attendance.'},
 document_reminders:{tier:'automatic',setting:'notifications.passport_expiry_reminders_enabled',service:'core/automatic-followups.ts#runAutomaticFollowups',effect:'Remind the employee and authorised HR about a recorded passport expiry within 30 calendar days. No file is read or changed.'},
 lifecycle_chasers:{tier:'automatic',setting:'notifications.lifecycle_step_chasers_enabled',service:'core/automatic-followups.ts#runAutomaticFollowups',effect:'Remind current lifecycle staff about actionable incomplete steps after three working days without a workflow transition. No task is completed.'},
} as const satisfies Record<'readiness_reminders'|'claims_triage'|'approval_chasers'|'review_chasers'|'clock_reminders'|'document_reminders'|'lifecycle_chasers',{tier:'automatic';setting:string;service:string;effect:string}>);

/** AI v2 Phase 2 P2-1 — what each AI Centre loop does at each level it may reach, run as the agent principal for its
 * sponsor. Levels above Prepare exist only for the loops whose cap allows them (core/loops/autonomy.ts, enforced in code and
 * in migration 0963); test/teras-loop-autonomy-registry.test.ts keeps this list, the agent registry and the cap in step.
 * Pay, employment status, access, discipline and statutory filing loops never go above Prepare. */
const WATCH='Records what it finds for the company; shows nobody a card and changes no record';
export const AGENT_LOOP_LEVELS=Object.freeze({
 loop_probation_ending:{0:WATCH,1:'Prepares a confirmation review card for HR; HR records the decision'},
 loop_payroll_inputs:{0:WATCH,1:'Prepares a Today card for payroll administrators listing what blocks the payroll run'},
 loop_missing_employee_data:{0:WATCH,1:'Prepares a request card for the employee to fill in their own missing details',
  2:'Sends the employee the request itself, within the company\'s nightly limit; changes no record; HR can withdraw it within the undo window',
  3:'As Level 2; HR reviews a weekly sample of at least 10% and at least 5 requests instead of every one'},
 loop_missed_clock_outs:{0:WATCH,1:'Prepares a correction card for the employee, who confirms or changes the time',
  2:'Sets the clock-out to the roster end through the attendance owner when the chosen condition holds, within the nightly limit; tells the employee; never creates overtime; undone by the employee or HR within the window',
  3:'As Level 2; HR reviews a weekly sample of at least 10% and at least 5 fixes instead of every one'},
 loop_document_expiry:{0:WATCH,1:'Prepares a Today card for HR and a reminder card for the employee to renew the passport'},
 // AI v2 P2-2a and P2-2b: pay and statutory filing, so Prepare at most in every company.
 loop_salary_payroll:{0:WATCH,1:'Prepares each payroll run\'s checks for payroll HR (exceptions, net swing, rule versions, bank file against net pay); a person runs, approves and closes payroll'},
 loop_payroll_audit:{0:WATCH,1:'Captures each run\'s evidence and prepares control findings for payroll HR; a person files with EPF, PERKESO and LHDN and records each disposition'},
} as const satisfies Record<'loop_probation_ending'|'loop_payroll_inputs'|'loop_missing_employee_data'|'loop_missed_clock_outs'|'loop_document_expiry'|'loop_salary_payroll'|'loop_payroll_audit',Readonly<Partial<Record<0|1|2|3,string>>>>);

/** Counts by class, for a Control Tower coverage view and for measuring how the backlog moves. */
export function agentCapabilityCoverage(){
 const counts:Record<string,number>={};
 for(const entries of Object.values(AGENT_CAPABILITY_INVENTORY))for(const value of Object.values(entries)){const kind=value.split(':')[0];counts[kind]=(counts[kind]??0)+1;}
 return Object.freeze(counts);
}

/** Deterministic entry list from the existing closed inventory, also used by the count view. */
export function agentBacklogEntries() {
 const rows: {source:string;entry:string;tier:Exclude<AgentTier,'handoff'>}[]=[];
 for(const [source,entries] of Object.entries(AGENT_CAPABILITY_INVENTORY))for(const [entry,value] of Object.entries(entries)){
  const [kind,tier]=value.split(':');
  if(kind==='backlog')rows.push({source,entry,tier:tier as Exclude<AgentTier,'handoff'>});
 }
 return rows.sort((a,b)=>a.source.localeCompare(b.source,'en')||a.entry.localeCompare(b.entry,'en'));
}

/** Backlog entry points by the highest tier each may ever get, so the coverage view shows which part shrinks. */
export function agentBacklogByTier(){
 const counts:Record<Exclude<AgentTier,'handoff'>,number>={automatic:0,confirm:0,approve:0};
 for(const row of agentBacklogEntries())counts[row.tier]++;
 return Object.freeze(counts);
}

/**
 * The automation floor (ADR 2026-11-15-probation-shared-automation, decision 2 and build step 0).
 *
 * Every trigger, condition, step, recipient, block and field capability that the three existing builder engines
 * accept today. The shared automation engine must keep every entry: a module moved onto it may not lose a capability
 * its users can configure now. `test/automation-floor-inventory.test.ts` proves each list equals what the engine
 * accepts, read from the engine's own runtime schema or validator, so the floor cannot drift from the code.
 *
 * Entries are only ever added. Removing one needs an owner decision recorded in an ADR, because it removes something
 * a tenant may already have configured. Dependency-free data: safe for server, worker and client graphs.
 */
export const AUTOMATION_FLOOR = {
  /** On/Off Boarding V9 (`lib/lifecycle-v9-validation.ts` v9ConfigSchema). Modules `onb` and `off`. */
  lifecycleV9: {
    modules: ['onb', 'off'],
    triggerEvents: ['submitted', 'hrSigned', 'docSigned', 'taskDone', 'fileUploaded', 'manual', 'beforeJoin', 'afterJoin', 'beforeLWD', 'afterLWD'],
    triggerOptions: ['days', 'workdays', 'repeat', 'skipIf'],
    skipIf: ['', 'noPre', 'allDocsDone', 'task:<id>'],
    conditionFields: ['businessGroup', 'company', 'department', 'grade', 'employmentType', 'title', 'caseType', 'joinWithin'],
    conditionOps: ['is', 'isNot', 'lt', 'gte'],
    stepTypes: ['doc', 'waitSign', 'waitFile', 'email', 'notify'],
    waitSignBy: ['hr', 'employee'],
    recipientRoles: ['employeeWork', 'employeePersonal', 'employee', 'supervisor', 'pbp', 'ta', 'peopleOps', 'taskOwners', 'hrSignatory', 'starter'],
    recipientForms: ['person:<uuid>', 'group:<name>', 'address:<email>'],
    workflowStatuses: ['draft', 'published', 'retired'],
    templateTypes: ['Form', 'Letter', 'Acknowledgement', 'Attachment'],
    templateHrStep: ['none', 'before', 'after'],
    templateRuleFields: ['businessGroup', 'company', 'department', 'grade', 'employmentType', 'title', 'caseType'],
    blockTypes: ['letterhead', 'heading', 'subheading', 'text', 'fields', 'field', 'table', 'signature'],
    fieldTypes: ['text', 'textarea', 'select', 'date', 'checkbox', 'phone', 'email', 'number', 'table'],
    fieldOwners: ['employee', 'hr', 'pmLocked'],
    taskAssignees: ['group', 'manager', 'employee'],
    taskModes: ['rr', 'manual'],
    bpRuleFields: ['businessGroup', 'company', 'department'],
    /** Email template options beside id, name, module, subject and body (v9ConfigSchema `emails`). */
    emailOptions: ['active', 'sender', 'cc', 'files', 'images', 'links', 'attachments', 'slots', 'recipientReview', 'bodyDoc'],
    /** Email merge fields: the Personnel fields (`lib/lifecycle-v9-personnel-merge-fields.ts`) and the run's own words. */
    mergeFields: ['employee.empNo', 'employee.name', 'employee.icNo', 'race', 'religion', 'nationality', 'gender', 'marital', 'employee.passportNo',
      'email', 'mobile', 'homePhone', 'personalEmail', 'address', 'company.name', 'employee.department', 'employee.position', 'employee.supervisor',
      'joiner.joinDate', 'leaver.lastDay', 'owner.name', 'pending.tasks', 'pending.count'],
  },
  /** Contract staff (`lib/contract-management-workflow.ts` contractWorkflowSchema). Module `contract_staff`. */
  contractStaff: {
    triggerEvents: ['beforeContractEnd', 'decisionSubmitted', 'approvalRejected', 'signatureDeclined'],
    triggerRepeatUntil: ['none', 'decision', 'acceptance'],
    conditionFields: ['decision', 'contractType', 'businessGroup', 'payChanges', 'termMonths', 'daysToEnd'],
    conditionOps: ['is', 'isNot', 'gte', 'lt'],
    stepTypes: ['request_approval', 'generate_document', 'wait_signature', 'update_record', 'start_offboarding', 'notify'],
    /** Every step type above carries its own `conditions` (step-level conditions). */
    stepConditions: true,
    approverTypes: ['employee_record', 'role_group', 'named_employee'],
    approverRecordFields: ['manager', 'pbp', 'ceo', 'hod', 'employee'],
    approverRoleGroups: ['rewards', 'gbs', 'legal'],
    approvalQuorum: ['any', 'all'],
    documentTemplateTypes: ['renewal', 'end', 'declined', 'retirement'],
    signatureTimingSource: ['company', 'workflow'],
  },
  /** Probation (`lib/probation-workflow.ts`). Module `probation`, notify-only today. */
  probation: {
    triggerEvents: ['kpi_assigned', 'kpi_reminder', 'kpi_overdue', 'review_issued', 'review_reminder', 'review_due', 'approval_pending', 'letter_released', 'letter_signing_pending', 'letter_release_pending', 'letter_returned', 'overdue_summary'],
    conditionFields: ['businessGroupId', 'businessUnitId', 'departmentId', 'grade', 'part'],
    stepTypes: ['notify'],
    recipientRoles: ['employee', 'lm', 'hod', 'pbp', 'gbs'],
    mergeFields: ['employeeName', 'employeeCode', 'part', 'dueOn', 'endOn', 'companyName'],
  },
} as const;

export type AutomationFloor = typeof AUTOMATION_FLOOR;

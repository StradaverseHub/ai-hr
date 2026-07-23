import type { WorkflowMatrixLabels } from './workflow-matrix';
import type { StepListLabels } from './step-list-editor';

/** The subset of a next-intl translator the label builders need (server getTranslations / client t). */
type Translator = (key: string) => string;

/**
 * e1a51aea: the WorkflowMatrix label bag, extracted from the Approval tab page so the per-type Approval
 * Workflow sub-step (the entitlements page's server-composed slot) builds the IDENTICAL bag without
 * duplicating ~60 key mappings — one source, two consumers, no drift. Keys live in the `leaveApproval`
 * namespace (all 6 locales).
 */
export function buildStepListLabels(t: Translator): StepListLabels {
  return {
    chain: t('chain'),
    empty: t('empty'),
    manager: t('manager'),
    departmentHead: t('departmentHead'),
    businessUnitHead: t('businessUnitHead'),
    hr: t('hr'),
    hrManager: t('hrManager'),
    payroll: t('payroll'),
    customRole: t('customRole'),
    add: t('add'),
    moveUp: t('moveUp'),
    moveDown: t('moveDown'),
    remove: t('remove'),
    dragToReorder: t('dragToReorder'),
  };
}

export function buildWorkflowMatrixLabels(t: Translator): WorkflowMatrixLabels {
  return {
    workflowsTitle: t('workflowsTitle'),
    workflowsHint: t('workflowsHint'),
    addWorkflow: t('addWorkflow'),
    colCompany: t('company'),
    colLeaveType: t('leaveType'),
    colGradeGroup: t('gradeGroup'),
    colWorkflowType: t('workflowType'),
    colConditions: t('conditions'),
    view: t('viewWorkflow'),
    edit: t('editRule'),
    delete: t('archiveRule'),
    deleteConfirm: t('archiveConfirm'),
    noWorkflows: t('noWorkflows'),
    anyScope: t('anyScope'),
    editTitle: t('editWorkflowTitle'),
    addTitle: t('addWorkflowTitle'),
    basicInfo: t('basicInfo'),
    sectionWorkflowType: t('workflowType'),
    sectionConditions: t('conditions'),
    workflowTypeAuto: t('workflowTypeAuto'),
    workflowTypeAutoHint: t('workflowTypeAutoHint'),
    workflowTypeAutoBadge: t('workflowTypeAutoBadge'),
    advancedOverride: t('advancedOverride'),
    advancedOverrideHint: t('advancedOverrideHint'),
    workflowTypeDefault: t('workflowTypeDefault'),
    workflowTypeCustom: t('workflowTypeCustom'),
    workflowTypeDefaultHint: t('workflowTypeDefaultHint'),
    workflowTypeCustomHint: t('workflowTypeCustomHint'),
    selectTemplate: t('selectTemplate'),
    noActiveTemplates: t('noActiveTemplates'),
    addCondition: t('addCondition'),
    conditionField: t('conditionField'),
    conditionOperator: t('conditionOperator'),
    conditionValue: t('conditionValue'),
    leaveDuration: t('leaveDuration'),
    opGreaterThan: t('opGreaterThan'),
    opLessThan: t('opLessThan'),
    opBetween: t('opBetween'),
    valueDays: t('valueDays'),
    advancedScope: t('advancedScope'),
    company: t('company'),
    ruleName: t('ruleName'),
    ruleNamePlaceholder: t('ruleNamePlaceholder'),
    leaveType: t('leaveType'),
    gradeGroup: t('gradeGroup'),
    businessUnit: t('businessUnit'),
    department: t('department'),
    position: t('position'),
    jobGrade: t('jobGrade'),
    employmentType: t('employmentType'),
    save: t('save'),
    cancel: t('cancel'),
    saveConfirmTitle: t('saveConfirmTitle'),
    saveConfirmBody: t('saveConfirmBody'),
    saveConfirm: t('saveConfirm'),
    workflowTypeDefaultBadge: t('workflowTypeDefaultBadge'),
    workflowTypeCustomBadge: t('workflowTypeCustomBadge'),
    fullTime: t('employmentType_full_time'),
    partTime: t('employmentType_part_time'),
    contract: t('employmentType_contract'),
    intern: t('employmentType_intern'),
    step: buildStepListLabels(t),
  };
}

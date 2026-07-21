import { getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { listCompanies, listDepartments, listJobGrades, listLeaveTypes } from '@/core/read';
import { listBusinessUnits, listPositions } from '@/core/admin';
import { getLeaveApprovalPolicy, getLeaveEscalationPolicy, listLeaveApprovalRules } from '@/core/leave-approval-policy';
import { listApprovalTemplates, listTemplateAssignments } from '@/core/leave-approval-template';
import { listGradeGroups } from '@/core/benefit-scheme';
import { Card, ErrorBanner, PageHeader, SectionHeader } from '@/components/ui';
import { LeaveTabs } from '@/components/leave-tabs';
import { LeaveApprovalEditor } from '../../leave-approval/editor';
import { LeaveEscalationEditor, type EscalationLabels } from '../../leave-approval/escalation-editor';
import { ApprovalTemplateManager, type TemplateManagerLabels } from '../../leave-approval/template-manager';
import { WorkflowMatrix, type WorkflowMatrixLabels } from '../../leave-approval/workflow-matrix';
import {
  archiveLeaveApprovalRuleAction,
  assignApprovalTemplateAction,
  deleteApprovalTemplateAction,
  duplicateApprovalTemplateAction,
  saveApprovalTemplateAction,
  saveLeaveApprovalPolicyAction,
  saveLeaveApprovalRuleAction,
  saveLeaveEscalationPolicyAction,
  setApprovalTemplateActiveAction,
  setLeaveMultiApprovalAction,
  setTenantDefaultTemplateAction,
  unassignApprovalTemplateAction,
} from '../../leave-approval/actions';

/**
 * Leave Settings — Approval Workflow tab (0d147b78 — Leave Settings Reorganization).
 *
 * Feature 0d147b78 "centralize everything" (Open Question 1 → option (a)): the former standalone
 * `/admin/leave-approval` page is ABSORBED into this tab. Its editor + rule-builder + actions are
 * reused unchanged (imported from `../../leave-approval/`), so no approval logic changes; the old
 * route now 308-redirects here (`app/admin/leave-approval/page.tsx`). Auth guard is `scopedSession()`
 * exactly as before (RLS trims companies) — deliberately NOT the settings pages' `requireAdmin()`, so
 * company-scoped admins keep seeing only the companies they manage.
 */
export default async function LeaveApprovalTabPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { s, scopeIds } = await scopedSession();
  const t = await getTranslations('leaveApproval');
  const { error } = await searchParams;

  const all = await listCompanies(s);
  const companies = all.filter((c) => scopeIds.includes(c.id));
  const companyIds = companies.map((c) => c.id);

  const [leaveTypesAll, departmentsAll, positionsAll, businessUnitsAll, gradesAll, gradeGroupsAll] = await Promise.all([
    listLeaveTypes(s),
    companyIds.length ? listDepartments(s, { companyIds }) : Promise.resolve([]),
    companyIds.length ? listPositions(s, { companyIds }) : Promise.resolve([]),
    companyIds.length ? listBusinessUnits(s, { companyIds }) : Promise.resolve([]),
    listJobGrades(s),
    listGradeGroups(s),
  ]);

  const rows = await Promise.all(
    companies.map(async (c) => ({
      company: c,
      pol: await getLeaveApprovalPolicy(s, c.id),
      rules: await listLeaveApprovalRules(s, c.id),
      // R51 722904dc — per-company Approval Escalation Settings (shown only when multi-step approval is on).
      esc: await getLeaveEscalationPolicy(s, c.id),
    })),
  );

  // 6fadb036: reusable templates + their assignments (tenant-level; scoped to companies in view).
  const [templates, allAssignments] = await Promise.all([
    listApprovalTemplates(s),
    listTemplateAssignments(s),
  ]);
  const assignments = allAssignments.filter((a) => companyIds.includes(a.companyId));
  const companyMultiApproval: Record<string, boolean> = Object.fromEntries(
    rows.map(({ company, pol }) => [company.id, pol.enabled]),
  );

  const labels = {
    enable: t('enable'),
    enableHint: t('enableHint'),
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
    save: t('save'),
    reason: t('reason'),
    reasonPlaceholder: t('reasonPlaceholder'),
  };
  // R51 722904dc — Approval Escalation Settings card labels; role labels reuse the chain vocabulary.
  const escalationLabels: EscalationLabels = {
    title: t('escalationTitle'),
    hint: t('escalationHint'),
    enable: t('escalationEnable'),
    escalateAfter: t('escalateAfter'),
    workingDaysUnit: t('workingDaysUnit'),
    level: t('escalationLevel'),
    nextLevel: t('escalationNextLevel'),
    specificRole: t('escalationSpecificRole'),
    role: t('escalationRole'),
    notifyNote: t('escalationNotifyNote'),
    save: t('save'),
    reason: t('reason'),
    reasonPlaceholder: t('reasonPlaceholder'),
    roleLabels: {
      direct_manager: t('manager'),
      department_head: t('departmentHead'),
      business_unit_head: t('businessUnitHead'),
      hr_admin: t('hr'),
      hr_manager: t('hrManager'),
      payroll: t('payroll'),
      custom_role: t('customRole'),
    },
  };
  const templateLabels: TemplateManagerLabels = {
    templatesTitle: t('templatesTitle'),
    templatesHint: t('templatesHint'),
    addTemplate: t('addTemplate'),
    editTemplate: t('editTemplate'),
    duplicateTemplate: t('duplicateTemplate'),
    deleteTemplate: t('deleteTemplate'),
    deleteTemplateConfirm: t('deleteTemplateConfirm'),
    deactivateTemplate: t('deactivateTemplate'),
    activateTemplate: t('activateTemplate'),
    templateName: t('templateName'),
    templateNamePlaceholder: t('templateNamePlaceholder'),
    templateDescription: t('templateDescription'),
    statusActive: t('statusActive'),
    statusInactive: t('statusInactive'),
    tenantDefault: t('tenantDefault'),
    tenantDefaultHint: t('tenantDefaultHint'),
    setTenantDefault: t('setTenantDefault'),
    unsetTenantDefault: t('unsetTenantDefault'),
    assignmentsTitle: t('assignmentsTitle'),
    assignmentsHint: t('assignmentsHint'),
    assign: t('assign'),
    assignTemplate: t('assignTemplate'),
    selectTemplate: t('selectTemplate'),
    selectCompanies: t('selectCompanies'),
    selectLeaveTypes: t('selectLeaveTypes'),
    templateCol: t('templateCol'),
    leaveTypeCol: t('leaveType'),
    companyCol: t('company'),
    noTemplates: t('noTemplates'),
    noAssignments: t('noAssignments'),
    unassign: t('unassign'),
    unassignConfirm: t('unassignConfirm'),
    multiApprovalOff: t('multiApprovalOff'),
    enableMultiApproval: t('enableMultiApproval'),
    rolesGatedNote: t('rolesGatedNote'),
    save: t('save'),
    cancel: t('cancel'),
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
  const stepLabels = {
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
  const workflowLabels: WorkflowMatrixLabels = {
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
    step: stepLabels,
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title={t('title')} description={t('description')} />
      <LeaveTabs active="approval" />
      {error && <ErrorBanner message={error} />}

      {companies.length === 0 ? (
        <Card>
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">{t('emptyScope')}</p>
        </Card>
      ) : (
        <>
          <ApprovalTemplateManager
            templates={templates}
            assignments={assignments.map((a) => ({
              ruleId: a.ruleId,
              templateId: a.templateId,
              companyId: a.companyId,
              leaveTypeId: a.leaveTypeId,
            }))}
            companies={companies.map((c) => ({ id: c.id, label: c.name }))}
            leaveTypes={leaveTypesAll.map((x) => ({ id: x.id, label: x.name }))}
            companyMultiApproval={companyMultiApproval}
            actions={{
              saveTemplate: saveApprovalTemplateAction,
              duplicateTemplate: duplicateApprovalTemplateAction,
              setActive: setApprovalTemplateActiveAction,
              deleteTemplate: deleteApprovalTemplateAction,
              setDefault: setTenantDefaultTemplateAction,
              assign: assignApprovalTemplateAction,
              unassign: unassignApprovalTemplateAction,
              setMultiApproval: setLeaveMultiApprovalAction,
            }}
            labels={templateLabels}
          />

          {/* R41 72800eda — the configured workflows summary table + View/Edit popup (across all companies). */}
          <WorkflowMatrix
            rows={rows.flatMap(({ rules }) =>
              rules
                .filter((r) => !isCompanyDefault(r))
                .map((r) => ({
                  id: r.id,
                  companyId: r.companyId,
                  ruleName: r.ruleName,
                  leaveTypeId: r.leaveTypeId,
                  gradeGroupId: r.gradeGroupId,
                  businessUnitId: r.businessUnitId,
                  departmentId: r.departmentId,
                  positionId: r.positionId,
                  gradeId: r.gradeId,
                  employmentType: r.employmentType,
                  minDays: r.minDays,
                  maxDays: r.maxDays,
                  levels: r.levels,
                  templateId: r.templateId,
                })),
            )}
            companies={companies.map((c) => ({ id: c.id, label: c.name }))}
            leaveTypes={leaveTypesAll.map((x) => ({ id: x.id, label: x.name }))}
            gradeGroups={gradeGroupsAll.filter((g) => !g.archived).map((g) => ({ id: g.id, label: g.name }))}
            grades={gradesAll.map((x) => ({ id: x.id, label: `${x.code} — ${x.name}` }))}
            businessUnits={businessUnitsAll.map((x) => ({ id: x.id, label: `${x.code} — ${x.name}`, companyId: x.companyId }))}
            departments={departmentsAll.map((x) => ({ id: x.id, label: x.name, companyId: x.companyId }))}
            positions={positionsAll.map((x) => ({ id: x.id, label: x.title, companyId: x.companyId }))}
            templates={templates.filter((t2) => t2.active).map((t2) => ({ id: t2.id, label: t2.name }))}
            actions={{ save: saveLeaveApprovalRuleAction, archive: archiveLeaveApprovalRuleAction }}
            labels={workflowLabels}
          />

          {/* Company defaults: the base chain + multi-step-approval on/off gate for each company. */}
          {rows.map(({ company, pol, esc }) => (
            <Card key={company.id}>
              <SectionHeader title={company.name} />
              <LeaveApprovalEditor
                companyId={company.id}
                action={saveLeaveApprovalPolicyAction}
                initialEnabled={pol.enabled}
                initialLevels={pol.levels}
                labels={labels}
              />
              {/* R51 722904dc — Approval Escalation Settings, below the chain. Hidden for single-approver
                  companies (no multi-step chain ⇒ no next level to escalate to; the sole approver is very
                  often the HR admin the escalation would notify). */}
              {pol.enabled ? (
                <LeaveEscalationEditor
                  companyId={company.id}
                  action={saveLeaveEscalationPolicyAction}
                  initial={{
                    enabled: esc.enabled,
                    escalateAfterDays: esc.escalateAfterDays,
                    target: esc.target,
                    targetRole: esc.targetRole,
                  }}
                  labels={escalationLabels}
                />
              ) : (
                <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">
                  {t('escalationUnavailableSingleApprover')}
                </p>
              )}
            </Card>
          ))}
        </>
      )}
    </div>
  );
}

/** A rule with every scoping dimension null IS the company default (edited by LeaveApprovalEditor above),
 *  so the rule builder hides it to avoid double-editing. */
function isCompanyDefault(r: {
  leaveTypeId: string | null;
  businessUnitId: string | null;
  departmentId: string | null;
  positionId: string | null;
  gradeId: string | null;
  gradeGroupId: string | null;
  employmentType: string | null;
  minDays: number | null;
  maxDays: number | null;
}): boolean {
  return (
    r.leaveTypeId == null &&
    r.businessUnitId == null &&
    r.departmentId == null &&
    r.positionId == null &&
    r.gradeId == null &&
    r.gradeGroupId == null &&
    r.employmentType == null &&
    r.minDays == null &&
    r.maxDays == null
  );
}

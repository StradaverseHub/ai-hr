import { getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { listCompanies, listDepartments, listJobGrades, listLeaveTypes } from '@/core/read';
import { listBusinessUnits, listPositions } from '@/core/admin';
import { getLeaveApprovalPolicy, listLeaveApprovalRules } from '@/core/leave-approval-policy';
import { listApprovalTemplates, listTemplateAssignments } from '@/core/leave-approval-template';
import { Card, ErrorBanner, PageHeader, SectionHeader } from '@/components/ui';
import { LeaveTabs } from '@/components/leave-tabs';
import { LeaveApprovalEditor } from '../../leave-approval/editor';
import { RuleBuilder, type RuleBuilderLabels } from '../../leave-approval/rule-builder';
import { ApprovalTemplateManager, type TemplateManagerLabels } from '../../leave-approval/template-manager';
import {
  archiveLeaveApprovalRuleAction,
  assignApprovalTemplateAction,
  deleteApprovalTemplateAction,
  duplicateApprovalTemplateAction,
  saveApprovalTemplateAction,
  saveLeaveApprovalPolicyAction,
  saveLeaveApprovalRuleAction,
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

  const [leaveTypesAll, departmentsAll, positionsAll, businessUnitsAll, gradesAll] = await Promise.all([
    listLeaveTypes(s),
    companyIds.length ? listDepartments(s, { companyIds }) : Promise.resolve([]),
    companyIds.length ? listPositions(s, { companyIds }) : Promise.resolve([]),
    companyIds.length ? listBusinessUnits(s, { companyIds }) : Promise.resolve([]),
    listJobGrades(s),
  ]);

  const rows = await Promise.all(
    companies.map(async (c) => ({
      company: c,
      pol: await getLeaveApprovalPolicy(s, c.id),
      rules: await listLeaveApprovalRules(s, c.id),
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
  const ruleLabels: RuleBuilderLabels = {
    rulesTitle: t('rulesTitle'),
    addRule: t('addRule'),
    editRule: t('editRule'),
    archiveRule: t('archiveRule'),
    archiveConfirm: t('archiveConfirm'),
    company: t('company'),
    ruleName: t('ruleName'),
    ruleNamePlaceholder: t('ruleNamePlaceholder'),
    leaveType: t('leaveType'),
    businessUnit: t('businessUnit'),
    department: t('department'),
    position: t('position'),
    jobGrade: t('jobGrade'),
    employmentType: t('employmentType'),
    minDays: t('minDays'),
    maxDays: t('maxDays'),
    anyScope: t('anyScope'),
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
    cancel: t('cancel'),
    noRules: t('noRules'),
    steps: t('steps'),
    fullTime: t('employmentType_full_time'),
    partTime: t('employmentType_part_time'),
    contract: t('employmentType_contract'),
    intern: t('employmentType_intern'),
    reason: t('reason'),
    reasonPlaceholder: t('reasonPlaceholder'),
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
          {rows.map(({ company, pol, rules }) => (
          <Card key={company.id}>
            <SectionHeader title={company.name} />
            <LeaveApprovalEditor
              companyId={company.id}
              action={saveLeaveApprovalPolicyAction}
              initialEnabled={pol.enabled}
              initialLevels={pol.levels}
              labels={labels}
            />
            <RuleBuilder
              companyId={company.id}
              companies={companies.map((c) => ({ id: c.id, label: c.name }))}
              rules={rules.filter((r) => !isCompanyDefault(r) && r.templateId == null)}
              leaveTypes={leaveTypesAll.map((x) => ({ id: x.id, label: x.name }))}
              businessUnits={businessUnitsAll
                .filter((x) => x.companyId === company.id)
                .map((x) => ({ id: x.id, label: `${x.code} — ${x.name}` }))}
              departments={departmentsAll
                .filter((x) => x.companyId === company.id)
                .map((x) => ({ id: x.id, label: x.name }))}
              positions={positionsAll
                .filter((x) => x.companyId === company.id)
                .map((x) => ({ id: x.id, label: x.title }))}
              grades={gradesAll.map((x) => ({ id: x.id, label: `${x.code} — ${x.name}` }))}
              saveAction={saveLeaveApprovalRuleAction}
              archiveAction={archiveLeaveApprovalRuleAction}
              labels={ruleLabels}
            />
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
    r.employmentType == null &&
    r.minDays == null &&
    r.maxDays == null
  );
}

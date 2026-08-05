import { getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { listCompanies, listJobGrades, listLeaveTypes } from '@/core/read';
import { getLeaveEscalationPolicy } from '@/core/leave-approval-policy';
import { listApprovalTemplates, listTemplateAssignments } from '@/core/leave-approval-template';
import { listBenefitSchemes } from '@/core/benefit-scheme';
import { bySchemeDisplayOrder, normalizeSchemeText } from '@/lib/benefit-scheme-label';
// `SectionHeader` was imported here and unused BEFORE 706d34e8 (the two sections use plain <h2>s); dropped
// while this import line was being edited anyway, so the file lints clean.
import { Card, ErrorBanner, PageHeader } from '@/components/ui';
import { LeaveEscalationEditor, type EscalationLabels } from '../../leave-approval/escalation-editor';
import {
  ApprovalAssignmentManager,
  ApprovalTemplateManager,
  type TemplateManagerLabels,
} from '../../leave-approval/template-manager';
import {
  assignApprovalTemplateAction,
  deleteApprovalTemplateAction,
  duplicateApprovalTemplateAction,
  saveApprovalTemplateAction,
  saveLeaveEscalationPolicyAction,
  setApprovalTemplateActiveAction,
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
 *
 * 9b0d99f3 — Approval Workflow Refactoring & Assignment Simplification. The page is split into two
 * headed sections: (1) APPROVAL TEMPLATE CREATION (build the flow and its steps) and (2) ASSIGNMENT
 * TEMPLATE (who it applies to) — the assignments table and the per-company escalation, the latter now a
 * compact one-line-per-company disclosure list instead of a full-height Card per company. Pure
 * presentation: no data model, no resolve/gate path, no action wiring changed.
 *
 * ── 706d34e8 (r155) — THE PER-RULE "Approval Workflows" LIST IS GONE. Read this before adding it back.
 *
 * The page used to end with a WorkflowMatrix: a table of every non-default `leave_approval_policy` row
 * with an Add / Edit / Delete popup posting saveLeaveApprovalRuleAction / archiveLeaveApprovalRuleAction.
 * It was a SECOND editor over the same rows the Assignment Template section above it creates — which is
 * the duplication the reporter named, and the same complaint e4238594 answered by deleting this matrix's
 * embedded twin from the Entitlements page.
 *
 * WHAT MAKES THE REMOVAL SAFE, STATED SO IT CAN BE RE-CHECKED:
 *   - `assignApprovalTemplate` (core/leave-approval-template.ts) INSERTS/UPDATES the very same
 *     `leave_approval_policy` rows, stamping `template_id`. The assignment section is a real maintainer
 *     of these rows, not a view of a different table.
 *   - `listTemplateAssignments` lists EVERY active row with `template_id is not null` — including the
 *     all-wildcard company-default row. So no template-driven rule became invisible, and each one is
 *     still individually unassignable by ruleId inside the grouped list.
 *   - Rows with `template_id IS NULL` are the ONLY ones this matrix could show and the assignment list
 *     cannot. `core/leave-approval-consolidation.ts` calls exactly that set (plus wildcard-leave-type
 *     rows) LEGACY, and 241817ef step 2 converted them on production via
 *     scripts/convert-approval-rules.ts, proving routing identical before and after in one transaction.
 *     A dry run of that script is the standing check: a non-zero legacy count means this removal would
 *     strand configuration and the matrix has to come back before it can be zero again.
 *   - Nothing can create a new template-less rule now, because this was its only entry point.
 *
 * WHAT THE REMOVAL DOES COST, HONESTLY: this matrix was the only surface that could SET or SHOW a rule's
 * business unit / department / position scope, and the only one offering a Custom (per-rule levels) chain.
 * `convertLegacyApprovalRules` PRESERVES those three columns, so a converted row may still carry them —
 * it keeps routing (resolveApprovalChain reads it) and stays listed and removable in the assignment list,
 * but its org scope is no longer displayed or editable. That is a real narrowing of the configuration
 * surface, not a no-op, and it is the thing to re-open if HR reports "I cannot find where this rule is set".
 *
 * The SERVICES are untouched: core/leave-approval-policy.ts keeps createLeaveApprovalRule /
 * updateLeaveApprovalRule / archiveLeaveApprovalRule and every reader, because resolveApprovalChain and
 * core/leave-approval-consolidation.ts still run on these rows. Removing a screen is not removing a service.
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

  // 706d34e8 — departments / positions / business units / grade groups and the per-company RULE list went
  // with the WorkflowMatrix; they fed nothing else on this page. Removing the reads, not just the render,
  // is the point (the e4238594 precedent: an embed's data prep left behind is a fan of queries per render
  // for a screen nobody sees). `gradesAll` and `leaveTypesAll` STAY — the Assign Template form uses both.
  const [leaveTypesAll, gradesAll, schemesAll] = await Promise.all([
    listLeaveTypes(s),
    listJobGrades(s),
    // 22de47c4 — the Assign Template employee scope is the benefit scheme, so the schemes come along.
    listBenefitSchemes(s),
  ]);

  const rows = await Promise.all(
    companies.map(async (c) => ({
      company: c,
      // R51 722904dc — per-company Approval Escalation Settings. r79 0322 — read for EVERY company now:
      // they are no longer hidden behind a per-company multi-step switch, because there is no such switch.
      esc: await getLeaveEscalationPolicy(s, c.id),
    })),
  );

  // 6fadb036: reusable templates + their assignments (tenant-level; scoped to companies in view).
  const [templates, allAssignments] = await Promise.all([
    listApprovalTemplates(s),
    listTemplateAssignments(s),
  ]);
  const assignments = allAssignments.filter((a) => companyIds.includes(a.companyId));

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
    requireMultiStep: t('requireMultiStep'),
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
    // bb3938b9 — the criteria panels and their shared panel controls; 22de47c4 made the employee-scope
    // panel Benefit Schemes (and added the two badges that keep a pre-existing grade-scoped assignment,
    // or an assignment whose scope names no scheme, visible instead of silently mislabelled).
    selectBenefitSchemes: t('selectBenefitSchemes'),
    selectAll: t('selectAll'),
    deselectAll: t('deselectAll'),
    panelNoneMeansAll: t('panelNoneMeansAll'),
    panelPickAtLeastOne: t('panelPickAtLeastOne'),
    noBenefitSchemes: t('noBenefitSchemes'),
    schemeNoGradeGroup: t('schemeNoGradeGroup'),
    legacyGradeScope: t('legacyGradeScope'),
    schemeScopeUnknown: t('schemeScopeUnknown'),
    conditions: t('conditions'),
    addCondition: t('addCondition'),
    conditionOperator: t('conditionOperator'),
    conditionValue: t('conditionValue'),
    opGreaterThan: t('opGreaterThan'),
    opLessThan: t('opLessThan'),
    opBetween: t('opBetween'),
    leaveDuration: t('leaveDuration'),
    valueDays: t('valueDays'),
    templateCol: t('templateCol'),
    leaveTypeCol: t('leaveType'),
    companyCol: t('company'),
    noTemplates: t('noTemplates'),
    noAssignments: t('noAssignments'),
    unassign: t('unassign'),
    unassignConfirm: t('unassignConfirm'),
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
  return (
    <div className="space-y-6">
      <PageHeader title={t('title')} description={t('description')} />
      {error && <ErrorBanner message={error} />}

      {companies.length === 0 ? (
        <Card>
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">{t('emptyScope')}</p>
        </Card>
      ) : (
        <>
          {/* ══ Section 1 — Approval Template Creation: build the flow and its steps. ══ */}
          <section className="space-y-3">
            <div>
              <h2 className="text-base font-semibold">{t('templateCreationTitle')}</h2>
              <p className="text-xs text-muted-foreground">{t('templateCreationHint')}</p>
            </div>
            <ApprovalTemplateManager
              templates={templates}
              actions={{
                saveTemplate: saveApprovalTemplateAction,
                duplicateTemplate: duplicateApprovalTemplateAction,
                setActive: setApprovalTemplateActiveAction,
                deleteTemplate: deleteApprovalTemplateAction,
                setDefault: setTenantDefaultTemplateAction,
              }}
              labels={templateLabels}
            />
            {/* 9b0d99f3 item 3 — the multi-step framing belongs with template creation (a >=2-step
                template IS a multi-step approval). The per-company switch itself stays explicit. */}
            <p className="text-xs text-muted-foreground">{t('multiStepNote')}</p>
          </section>

          {/* ══ Section 2 — Assignment Template: who each flow applies to. ══ */}
          <section className="space-y-3">
            <div>
              <h2 className="text-base font-semibold">{t('assignmentTemplateTitle')}</h2>
              <p className="text-xs text-muted-foreground">{t('assignmentTemplateHint')}</p>
            </div>

            <ApprovalAssignmentManager
              templates={templates}
              assignments={assignments.map((a) => ({
                ruleId: a.ruleId,
                templateId: a.templateId,
                companyId: a.companyId,
                leaveTypeId: a.leaveTypeId,
                gradeId: a.gradeId,
                gradeGroupId: a.gradeGroupId,
                employmentType: a.employmentType,
                minDays: a.minDays,
                maxDays: a.maxDays,
              }))}
              companies={companies.map((c) => ({ id: c.id, label: c.name }))}
              leaveTypes={leaveTypesAll.map((x) => ({ id: x.id, label: x.name }))}
              grades={gradesAll.map((x) => ({ id: x.id, label: `${x.code} — ${x.name}` }))}
              /* 22de47c4 — ACTIVE schemes of the companies in view: an archived scheme matches nobody
                 (resolveEffectiveSchemeId ignores it), so assigning a template to one would look like a
                 routing change that never fires.
                 r76 22de47c4 — the picker now shows `name` ONLY: one line per scheme, the tenant's own
                 words (lib/benefit-scheme-label — whitespace tidied, never re-cased, never rewritten in
                 the database). `label`, which also states the grade group + employment type an assignment
                 writes, is UNCHANGED — it is what the saved-assignments table below names a scheme with,
                 and that surface was not in the item. Ordered by the shared display order so a list of
                 bare names stays scannable: removing the supporting text is what makes a stable order
                 necessary. */
              schemes={schemesAll
                .filter((sc) => sc.status === 'active' && companyIds.includes(sc.companyId))
                .map((sc) => ({
                  id: sc.id,
                  companyId: sc.companyId,
                  gradeGroupId: sc.gradeGroupId,
                  employmentType: sc.employmentType,
                  name: normalizeSchemeText(sc.name),
                  label: `${sc.name} — ${sc.gradeGroupName ?? t('anyScope')} · ${t(`employmentType_${sc.employmentType}` as 'employmentType_full_time')}`,
                }))
                .sort(bySchemeDisplayOrder((sc) => sc.name))}
              actions={{
                assign: assignApprovalTemplateAction,
                unassign: unassignApprovalTemplateAction,
              }}
              labels={templateLabels}
              /* r79 0322 (2.iii, relocated) — Approval Escalation Settings now live INSIDE the Assignment
                 Template card, beside the assignment criteria, instead of in a per-company section of
                 their own. Same editor component, same server action, same company columns: the nightly
                 sweep (core/leave-escalation.ts) reads what it always read, uninterrupted — this moved
                 where the form renders, not what it writes. Every company gets one now; the old
                 "multi-step only" condition went with the switch it depended on. */
              escalation={
                <div className="border-t border-border">
                  <div className="px-4 pb-1 pt-3">
                    <h3 className="text-sm font-semibold">{t('escalationTitle')}</h3>
                    <p className="text-xs text-muted-foreground">{t('escalationSectionHint')}</p>
                  </div>
                  <ul className="divide-y divide-border">
                    {rows.map(({ company, esc }) => (
                      <li key={company.id}>
                        <details className="group">
                          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
                            <span>{company.name}</span>
                            <span aria-hidden className="text-xs text-muted-foreground group-open:rotate-180">
                              ▾
                            </span>
                          </summary>
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
                        </details>
                      </li>
                    ))}
                  </ul>
                </div>
              }
            />

            {/* 706d34e8 — the R41 72800eda "Approval Workflows" summary table + View/Edit/Delete popup
                STOOD HERE and is gone. See this file's header for what made that safe, what it costs, and
                the dry run (scripts/convert-approval-rules.ts) that re-checks the precondition. Nothing
                stands in its place: rev-1 of the e4238594 removal offered a pointer-to-the-other-screen
                placeholder and the reporter rejected it, and the same reasoning applies to a stub here. */}
          </section>
        </>
      )}
    </div>
  );
}

// e1a51aea: the company-default rule detector moved to core/leave-approval-policy.ts
// (isCompanyDefaultApprovalRule) so this page and the per-type Approval Workflow sub-step share ONE filter.

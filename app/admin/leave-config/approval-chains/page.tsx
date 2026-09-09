import { getTranslations } from 'next-intl/server';

import { scopedSession } from '@/lib/scope';
import { listCompanies, listJobGrades, listLeaveTypes } from '@/core/read';
import { getLeaveEscalationPolicy } from '@/core/leave-approval-policy';
import {
  listApprovalTemplates,
  listEligibilityRuleScopes,
  listTemplateAssignments,
} from '@/core/leave-approval-template';
import { Card, ErrorBanner, PageHeader } from '@/components/ui';
import { LeaveConfigMap, leaveConfigScreenTitle } from '@/components/leave-config-map';
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
import { LeaveConfigPreviewNote } from '../preview-note';
import { ApprovalRuleScopes, loadApprovalRuleScopes } from '../approval-readout';

/**
 * a6fe37fc ROUND 4 — APPROVAL CHAINS at its new address (`/admin/leave-config/approval-chains`).
 *
 * ⚠️ IT REPLACES NOTHING YET. `/admin/leave/approval` is untouched, still registered and still what the
 * menu links to; the two are live side by side until Round 5 empties the old page and repoints its
 * address here (docs/design/a6fe37fc-migration-order.md → Round 4 / Round 5).
 *
 * ⚠️ THE ONE PERMISSION EXCEPTION IN THE WHOLE NEW MODULE, AND IT IS DELIBERATE.
 * Every other `/admin/leave-config/` route hangs off the `leaveConfig` screen key behind `requireAdmin`.
 * This one hangs off **`leaveApproval`** and keeps **`scopedSession`**, exactly as the screen it mirrors
 * does — because a company-scoped admin must keep seeing only their own companies (IA §6.4, migration
 * order Round 3's note, and lib/permissions.ts's `leaveApproval` column). Folding it onto `leaveConfig`
 * would MISREPORT one of the two guards and hand a company-scoped admin the whole tenant's companies;
 * `test/function-access.test.ts` derives access from the guard the page actually calls, so the registry
 * and the page have to agree, and `test/leave-config-round4.test.ts` pins the pair by name.
 *
 * ⚠️ THE FLOW IS NOT CHANGING, SO NOTHING IN IT IS RE-IMPLEMENTED (IA §2.3 — one component, several
 * mount points). Templates, assignment and escalation below are the SAME `ApprovalTemplateManager`,
 * `ApprovalAssignmentManager` and `LeaveEscalationEditor` the old page mounts, from the same files, with
 * the same server actions and the same label object. A second copy of the assignment card is the exact
 * defect this item exists to remove.
 *
 * ═══ WHAT IS GENUINELY NEW HERE, AND IT IS A RESTORATION RATHER THAN A REARRANGEMENT ═══
 *
 * The read-only list at the foot, of every active rule whose SCOPE OR CHAIN no other list shows. A
 * rule's business unit / department / position scope and its own chain are STORED, are READ by
 * `resolveApprovalChain`, DECIDE WHO APPROVES, and have been shown NOWHERE since `706d34e8` removed the
 * Workflow Matrix (IA §4.1).
 *
 * ⚠️ IT IS NOT LIMITED TO THE TEMPLATE-LESS ROWS, and that distinction is the whole delivery.
 * `convertLegacyApprovalRules` copies those three org columns onto the rows it expands and stamps a
 * template_id on them, and r94 ran that conversion on production — so on the customer's tenant EVERY
 * org-scoped rule carries a template, and a list filtered to `template_id is null` renders empty on
 * exactly the data the restoration exists for. `loadApprovalRuleScopes` reads both populations.
 *
 * It is a read-out, not that editor coming back — see `../approval-readout.tsx`'s header for the full
 * reasoning, and `test/leave-approval-page-restructure.test.ts` for the case that carries it.
 *
 * A SAVE MADE HERE LANDS ON THE OLD SCREEN — `app/admin/leave-approval/actions.ts` redirects to its own
 * `PAGE` constant (`/admin/leave/approval`) and Round 2's rule 2 still stands: no action changes
 * signature and no new action is written, because re-pointing that constant would move every save on the
 * OLD screen too, which is a Round 5 act. `../preview-note.tsx` says so out loud rather than letting it
 * look like a fault.
 *
 * SERVER COMPONENT, like the page it mirrors: the three client islands receive only serialisable props
 * and server actions, and the read-out is server-rendered markup (test/server-client-boundary.test.ts).
 */
export default async function LeaveConfigApprovalChainsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { s, scopeIds } = await scopedSession();
  const t = await getTranslations('leaveApproval');
  const tr = await getTranslations('admin.leaveConfigApprovalChains');
  const { error } = await searchParams;

  const all = await listCompanies(s);
  const companies = all.filter((c) => scopeIds.includes(c.id));
  const companyIds = companies.map((c) => c.id);

  const [leaveTypesAll, gradesAll, eligibilityRulesAll] = await Promise.all([
    listLeaveTypes(s),
    // The grade list the Assign Template form labels a pre-existing grade-scoped assignment with.
    listJobGrades(s),
    // 22de47c4 / 6e9a126e release three — the named populations an assignment's employee scope is drawn
    // from, ALREADY translated into the two dimensions an assignment writes. The page does not re-derive
    // that translation: one implementation is what stops the picker offering a rule the service refuses.
    listEligibilityRuleScopes(s),
  ]);

  const rows = await Promise.all(
    companies.map(async (c) => ({ company: c, esc: await getLeaveEscalationPolicy(s, c.id) })),
  );

  const [templates, allAssignments] = await Promise.all([
    listApprovalTemplates(s),
    listTemplateAssignments(s),
  ]);
  const assignments = allAssignments.filter((a) => companyIds.includes(a.companyId));

  /* IA §4.1 — the rows whose scope or chain no screen has shown since 706d34e8. Scoped to the companies
     in view by the SAME list the assignments above are filtered by, because `leave_approval_policy` is
     readable tenant-wide and the company filter is what keeps a company-scoped admin inside their own
     scope.

     ⚠️ `templates` IS PASSED IN, ALREADY READ ABOVE. A template-driven rule's effective chain is its
     template's, and this table lists template-driven rules — the converted ones that narrow by business
     unit, department or position. Re-reading the templates inside the loader would be a third round-trip
     for rows sitting in memory two lines up. */
  const ruleScopes = await loadApprovalRuleScopes(s, companies, templates, tr('scopeUnknown'));

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
    selectEligibilityRules: t('selectEligibilityRules'),
    selectAll: t('selectAll'),
    deselectAll: t('deselectAll'),
    panelNoneMeansAll: t('panelNoneMeansAll'),
    panelPickAtLeastOne: t('panelPickAtLeastOne'),
    noEligibilityRules: t('noEligibilityRules'),
    ruleNotAssignable: t('ruleNotAssignable'),
    legacyGradeScope: t('legacyGradeScope'),
    ruleScopeUnknown: t('ruleScopeUnknown'),
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
      <PageHeader
        // The heading is the SAME string the menu shows for this screen — a separate title key per page
        // is how a menu and a heading start disagreeing (components/leave-config-map.tsx).
        title={await leaveConfigScreenTitle('approvalChain')}
        description={tr('pageDescription')}
      />
      {/* The area map. `current="approvalChain"` because this IS that screen — the map names screens, not
          addresses, and Round 5 repoints the entry here. */}
      <LeaveConfigMap current="approvalChain" />
      <LeaveConfigPreviewNote />
      <ErrorBanner message={error} />

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
            <p className="text-xs text-muted-foreground">{t('multiStepNote')}</p>
          </section>

          {/* ══ Section 2 — Assignment Template: who each flow applies to, and the escalation that
              chases it (r79 0322 put the escalation editor inside this card). ══ */}
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
              eligibilityRules={eligibilityRulesAll
                /* A rule naming only companies this admin cannot see is not theirs to assign. `companyIds`
                   itself is passed through UNTRIMMED — trimming it to the visible set would turn such a
                   rule into an empty list, and an empty list means "every company". */
                .filter((r) => r.companyIds.length === 0 || r.companyIds.some((c) => companyIds.includes(c)))
                .map((r) => ({
                  id: r.lineageId,
                  name: r.name,
                  companyIds: r.companyIds,
                  scopes: r.scopes,
                  assignable: r.refusal === null,
                }))}
              actions={{
                assign: assignApprovalTemplateAction,
                unassign: unassignApprovalTemplateAction,
              }}
              labels={templateLabels}
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
          </section>

          {/* ══ Section 3 — THE RESTORATION (IA §4.1). Read-only: no form, no action, no edit. ══ */}
          <ApprovalRuleScopes rows={ruleScopes} />
        </>
      )}
    </div>
  );
}

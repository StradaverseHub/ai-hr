import { getTranslations } from 'next-intl/server';

import { scopedSession } from '@/lib/scope';
import { listCompanies, listEmployeePickOptions, listEmployees, listJobGrades, listLeaveTypes } from '@/core/read';
import { deriveEmploymentStatus } from '@/core/employment-status';
import type { LeaveLevelKind } from '@/lib/leave-approval-kinds';
import { previewApprovalChain } from '@/core/leave';
import { getLeaveEscalationPolicy } from '@/core/leave-approval-policy';
import {
  listApprovalTemplates,
  listEligibilityRuleScopes,
  listTemplateAssignments,
} from '@/core/leave-approval-template';
import { Card, ErrorBanner, PageHeader } from '@/components/ui';
import { LeaveConfigMap, leaveConfigPageHeader } from '@/components/leave-config-map';
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
import { ApprovalRuleScopes, loadApprovalRuleScopes } from '../approval-readout';
import { ApprovalChainPreview, type ChainPreviewLabels } from '../../leave-approval/chain-preview';

/**
 * a6fe37fc — APPROVAL CHAINS (`/admin/leave-config/approval-chains`).
 *
 * ⚠️ ROUND 5 (cutover) HAS HAPPENED: this IS the screen. `/admin/leave/approval` is an unguarded redirect
 * stub pointing here and has left lib/permissions.ts's `leaveApproval` routes; the screen key's `href`
 * moved here too, the sidebar fly-out row and the area map's `approvalChain` entry name this address, and
 * `app/admin/leave-approval/page.tsx` — the older 0d147b78 stub that used to point at the old page — was
 * repointed here in the same commit rather than left chaining through a second stub. The stubs are never
 * deleted; the reporter's bookmarks are why they exist.
 *
 * ⚠️ THE HEADING IS THE MENU'S OWN STRING and the old page's private `leaveApproval.title` ("Leave
 * Approval Chain", against a menu entry reading "Approval chain") is DELETED in all six locales with the
 * page that owned it — the third of the four mismatches IA §1.1 measured. The rest of the `leaveApproval`
 * namespace stays: the template manager, the escalation editor and the Tab 5 read-out all read it.
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
 * A SAVE MADE HERE RETURNS THROUGH ONE HOP — `app/admin/leave-approval/actions.ts` still redirects to
 * its own `PAGE` constant (`/admin/leave/approval`), which is a redirect stub as of a6fe37fc Round 5.
 * Round 2's rule 2 stands: no action changes signature and no new action is written. The constant was
 * left where it is deliberately — the migration order's Round 5 names the redirect constants it moves
 * (app/admin/_redirects.ts's five, and app/admin/actions.ts's LEAVE_REPLACEMENT) and this private one is
 * not among them. So the hop is real and its whole cost is that the stub must forward the query string,
 * or all 17 `?toast=` / `?error=` returns land here blank. test/leave-config-round4.test.ts pins the
 * forwarding loop by name rather than by token. (Before the cutover this was said out loud on the page
 * itself by `../preview-note.tsx`; that component came off at the cutover and was deleted with it,
 * because a real screen telling the administrator it is a preview is worse than no note.)
 *
 * SERVER COMPONENT, like the page it mirrors: the three client islands receive only serialisable props
 * and server actions, and the read-out is server-rendered markup (test/server-client-boundary.test.ts).
 */
export default async function LeaveConfigApprovalChainsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; previewEmployment?: string; previewLeaveType?: string }>;
}) {
  const { s, scopeIds } = await scopedSession();
  const t = await getTranslations('leaveApproval');
  const tr = await getTranslations('admin.leaveConfigApprovalChains');
  const { error, previewEmployment, previewLeaveType } = await searchParams;

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

  const [templates, allAssignments, employeePickOptions] = await Promise.all([
    listApprovalTemplates(s),
    listTemplateAssignments(s),
    /* r293 — the population BOTH the preview's employee box and the builder's named-approver cards draw
       from. The same scoped read the three "pick individually" write paths resolve against (core/read.ts),
       so neither control can name somebody this admin cannot reach. */
    listEmployeePickOptions(s),
  ]);
  /* r293 phase 3 — which of them are no longer an ACTIVE employment. The builder warns on a level naming
     one; the engine does NOT drop such a level, which is precisely why the warning has to exist. Derived
     through the same `deriveEmploymentStatus` every status badge uses rather than a second rule. */
  const employeeStatusRows = await listEmployees(s, companyIds);
  const endedEmploymentIds = employeeStatusRows
    .filter((e) => deriveEmploymentStatus(e) === 'resigned' || deriveEmploymentStatus(e) === 'blacklisted')
    .map((e) => e.employmentId);
  const employeeSearchOptions = employeePickOptions.map((e) => ({
    value: e.id,
    name: e.name,
    employeeCode: e.employeeCode,
  }));
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

  /* Keyed by LEVEL_KINDS value, so a kind added to the vocabulary without a hint renders no hint rather
     than the wrong one. `test/r293-approval-builder.test.ts` pins that every kind has one. */
  const kindHints: Record<LeaveLevelKind, string> = {
    direct_manager: t('hintDirectManager'),
    manager_manager: t('hintManagerManager'),
    department_head: t('hintDepartmentHead'),
    business_unit_head: t('hintBusinessUnitHead'),
    hr_admin: t('hintHr'),
    hr_manager: t('hintHrManager'),
    payroll: t('hintPayroll'),
    custom_role: t('hintCustomRole'),
    specific_employee: t('hintSpecificEmployee'),
  };
  /* ⚠️ A FULL `Record<LeaveLevelKind, …>`, NOT `Record<string, …>`. It was the loose form until the
     r293 phase 3 verify pass, and the screen rendered a raw `specific_employee` where the label belongs —
     tsc, eslint and every guard green, because a missing key in a loose Record is just `undefined`. Found
     by rendering the page and reading the markup with <script> stripped (CLAUDE.md §8). Typed this way, a
     kind added to the vocabulary without a label cannot compile. */
  const kindLabels: Record<LeaveLevelKind, string> = {
    direct_manager: t('manager'),
    manager_manager: t('managerManager'),
    department_head: t('departmentHead'),
    business_unit_head: t('businessUnitHead'),
    hr_admin: t('hr'),
    hr_manager: t('hrManager'),
    payroll: t('payroll'),
    custom_role: t('customRole'),
    specific_employee: t('specificEmployee'),
  };

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
    // r293 — the SAME map the builder and the preview label kinds with. Three copies of one lookup is
    // three places for a new kind to be missed.
    roleLabels: kindLabels,
  };
  /* The five captions the shared employee picker shows. Read once: the builder's named-approver cards and
     the preview's employee box are the same control and must not caption it differently. */
  const employeeSearchLabels = {
    placeholder: t('previewSearchPlaceholder'),
    ariaLabel: t('previewSearchAria'),
    resultsLabel: t('previewSearchResults'),
    noMatches: t('previewSearchNoMatches'),
    clear: t('previewSearchClear'),
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
    managerManager: t('managerManager'),
    specificEmployee: t('specificEmployee'),
    add: t('add'),
    moveUp: t('moveUp'),
    moveDown: t('moveDown'),
    remove: t('remove'),
    dragToReorder: t('dragToReorder'),
    /* r293 builder. `levelN` carries an ICU `{n}`, so it is passed its OWN placeholder back in and the
       client component substitutes it — the app/admin/notice-board/new/page.tsx:102 idiom. A bare
       `t('levelN')` finds no `n`, throws FORMATTING_ERROR and renders the key path behind a green 200. */
    levelTemplate: t('levelN', { n: '{n}' }),
    badgeDynamic: t('badgeDynamic'),
    badgeFixed: t('badgeFixed'),
    flowStart: t('flowStart'),
    flowEnd: t('flowEnd'),
    addLevel: t('addLevel'),
    fixedWarning: t('fixedWarning'),
    fixedApproverEnded: t('fixedApproverEnded'),
    fixedApproverMissing: t('fixedApproverMissing'),
    hints: kindHints,
    employeeSearch: employeeSearchLabels,
    // r293 phase 4 — any-one approval. There is no `mode` label here because there is no stored mode:
    // the radio reads back out of the levels (see StepListEditor's `anyOne`).
    modeTitle: t('modeTitle'),
    modeSequential: t('modeSequential'),
    modeSequentialHint: t('modeSequentialHint'),
    modeAnyOne: t('modeAnyOne'),
    modeAnyOneHint: t('modeAnyOneHint'),
    addAlternate: t('addAlternate'),
    orLabel: t('orLabel'),
    badgeAnyOne: t('badgeAnyOne'),
  };

  /* ══ r293 — the PREVIEW's inputs and its result, resolved server-side from the query string. ══
     `listEmployeePickOptions` is the same scoped population the three "pick individually" write paths
     resolve against (core/read.ts), so the preview can never name somebody this admin cannot reach. The
     leave type defaults to the first in the list rather than to null: a preview needs a type to resolve a
     type-scoped rule, and silently previewing "no leave type" would answer a question nobody asked. */
  const employeeOptions = employeePickOptions;
  const previewLeaveTypeId = previewLeaveType ?? leaveTypesAll[0]?.id ?? null;
  const previewEmploymentId =
    previewEmployment && employeeOptions.some((e) => e.id === previewEmployment) ? previewEmployment : null;
  const previewResult =
    previewEmploymentId && previewLeaveTypeId
      ? await previewApprovalChain(s, { employmentId: previewEmploymentId, leaveTypeId: previewLeaveTypeId })
      : null;
  const previewLabels: ChainPreviewLabels = {
    title: t('previewTitle'),
    hint: t('previewHint'),
    employee: t('previewEmployee'),
    leaveType: t('leaveType'),
    run: t('previewRun'),
    idle: t('previewIdle'),
    noResult: t('previewNoResult'),
    levelTemplate: t('levelN', { n: '{n}' }),
    badgeDynamic: t('badgeDynamic'),
    badgeFixed: t('badgeFixed'),
    flowStart: t('flowStart'),
    flowEnd: t('flowEnd'),
    skipped: t('previewSkipped'),
    skippedNoManager: t('previewSkippedNoManager'),
    skippedNoManagerManager: t('previewSkippedNoManagerManager'),
    skippedNoDepartmentHead: t('previewSkippedNoDepartmentHead'),
    skippedNoBusinessUnitHead: t('previewSkippedNoBusinessUnitHead'),
    sourceRule: t('previewSourceRule'),
    sourceTenantDefault: t('previewSourceTenantDefault'),
    sourceFallback: t('previewSourceFallback'),
    singleApprover: t('previewSingleApprover'),
    allDropped: t('previewAllDropped'),
    fixedApproverEnded: t('previewFixedApproverEnded'),
    notSkippable: t('previewNotSkippable'),
    anyOne: t('previewAnyOne'),
    orLabel: t('orLabel'),
    kindLabels,
  };

  return (
    <div className="space-y-6">
      <PageHeader
        // 10b59703 — the heading is the SUBMENU ROW that opened this page ("Approval Workflow"), through
        // the one helper every Leave Config page uses (components/leave-config-map.tsx). The
        // `leaveApproval` SCREEN label in lib/permissions.ts ("Approval chain") is a different surface
        // and is untouched. The content of this page is unchanged.
        title={(await leaveConfigPageHeader('approvalChain')).title}
        description={tr('pageDescription')}
      />
      {/* The area map. `current="approvalChain"` because this IS that screen — the map names screens, not
          addresses, and the cutover repointed the entry (and the sidebar row) here. */}
      <LeaveConfigMap current="approvalChain" />
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
              employees={employeeSearchOptions}
              endedEmploymentIds={endedEmploymentIds}
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

            {/* r293 — the preview sits UNDER the builder, in the same section, because it answers the
                question the builder raises: "and what will that actually do to a real person's request?"
                It resolves against real org data through the same matcher and the same drop rule the
                submission path uses — see chain-preview.tsx's header for why that is not optional. */}
            <ApprovalChainPreview
              employees={employeeSearchOptions}
              leaveTypes={leaveTypesAll.map((x) => ({ id: x.id, label: x.name }))}
              employmentId={previewEmploymentId}
              leaveTypeId={previewLeaveTypeId}
              result={previewResult}
              labels={previewLabels}
              searchLabels={employeeSearchLabels}
            />
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

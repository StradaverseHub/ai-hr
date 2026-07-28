import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireAdmin, isGroupAdmin, hasGrantFor, withEffectiveGrants } from '@/lib/authz';
import { listLeaveTypes, listCompanies, listJobGrades, listDepartments } from '@/core/read';
import { listAdHocLeaveGrants, listLeavePolicies, listBusinessUnits, listPositions } from '@/core/admin';
import { listLeaveYearConfigs } from '@/core/leave';
import { ORG_ASSIGNMENT_CRITERIA } from '@/core/leave-org-criteria';
import { listAllProfileOptions } from '@/core/profile-options';
// e1a51aea — the Approval Workflow sub-step's data + shared matrix labels (one source with the Approval tab).
import { getLeaveApprovalPolicy, isCompanyDefaultApprovalRule, listLeaveApprovalRules } from '@/core/leave-approval-policy';
import { listApprovalTemplates } from '@/core/leave-approval-template';
import { WorkflowMatrix } from '@/app/admin/leave-approval/workflow-matrix';
import { buildWorkflowMatrixLabels } from '@/app/admin/leave-approval/matrix-labels';
// 4e9a4d59 — the EMBEDDED matrix posts the stay-on-this-type wrappers (the standalone Approvals screen
// keeps the plain actions), so a rule save/delete never bounces HR out of the leave type they're setting up.
import {
  archiveLeaveApprovalRuleFromEntitlementsAction,
  saveLeaveApprovalRuleFromEntitlementsAction,
} from '@/app/admin/leave-approval/actions';
import {
  listGradeGroups,
  listBenefitSchemes,
  listSchemeEntitlements,
  listSchemeCombinedLimits,
} from '@/core/benefit-scheme';
import { BenefitSchemeConfig, type LeaveTypeSchemeEntitlement } from '@/components/benefit-scheme-config';
import type { ServiceBand } from '@/core/leave-compute';
import { countryPacks } from '@/localization/registry';
import { Button, Card, ErrorBanner, Field, PageHeader, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { LeaveTabs } from '@/components/leave-tabs';
import { LeaveTypePanel, type EntitlementPolicy, type LeaveEligibilityRule } from '@/components/leave-type-panel';
import { AddLeaveTypeCancel, LeaveTypeWorkspace } from '@/components/leave-type-workspace';
import { FestiveGrantCard, type FestiveGrantRow } from '@/components/festive-grant-card';
import { EarnedAccrualDialog } from '@/components/leave/earned-accrual-dialog';
import { LeaveRulePreviewDialog } from '@/components/leave/leave-rule-preview-dialog';
import {
  archiveLeaveTypeAction,
  countEmployeesInScopeAction,
  setLeaveHalfDayFullDeductionAction,
  createLeavePoliciesMultiAction,
  createLeaveTypeAction,
  deleteLeavePolicyAction,
  deleteLeaveTypeAction,
  updateLeavePolicyAction,
  saveServiceEntitlementAction,
  updateLeaveTypeAction,
  createGradeGroupAction,
  updateGradeGroupAction,
  deleteGradeGroupAction,
  createBenefitSchemeAction,
  updateBenefitSchemeAction,
  deleteBenefitSchemeAction,
  upsertSchemeEntitlementAction,
  deleteSchemeEntitlementAction,
  copySchemeEntitlementsAction,
  updateSchemeCombinedLimitAction,
  deleteSchemeCombinedLimitAction,
  moveCombinedLimitMemberAction,
  groupSchemeLeaveTypesAction,
} from '../../actions';

/**
 * Leave Settings — Entitlements tab.
 *
 * Feedback 9d8cf621 (Entitlements Setting reorganization): the per-leave-type CONFIGURATION panel now lives
 * here — "one leave type, one full set of settings", exactly where HR expects it. Each `LeaveTypePanel`
 * carries leave-type identity, eligibility, allowed durations, supporting-document config, backdating limit,
 * advance-notice, expiry, the apply-time custom message AND that type's effective-dated entitlement policies
 * (the editable ranges table + the multi-company/grade "Employee Selection" chips). The three other
 * standalone sections are gone (d778d2d3): Run Earned Accrual and
 * Preview a Scenario became compact action buttons opening the SAME tools in dialogs
 * (EarnedAccrualDialog / LeaveRulePreviewDialog — components wrapped unchanged), and the per-company Leave
 * Cycle card moved to the Application Rules tab beside the other company-level calendar rules (its
 * server action is untouched — only the rendering moved). Bulk import is a "+ Import" action
 * button in the page header (e8f2398f) — the standalone page-bottom Card that only linked to
 * /admin/leave/import is gone. The festive / one-off grant tool no longer
 * sits at the page bottom — fd7c8e20 moved it into each type's Entitlement step, preset to the selected
 * type. The whole `LeaveTypePanel` + add-type form moved wholesale from the
 * Types tab, so every sub-form keeps its tri-state marker + hidden `name` intact — no column is wiped on save.
 *
 * 7b945408 (Restructure Entitlements Secondary Workflow): the Entitlement step is now a three-sub-step walk
 * — 1 Benefit Schemes · 2 Service Based Entitlements · 3 Adjustments (the SubStepBar reuse contract).
 * Preview Scenario joins Service Based Entitlements as its checking tool, and Run Accrual joins Adjustments
 * (it processes earned entitlement).
 *
 * b1b81a08 (Grade relocation): the Grades catalogue is no longer maintained anywhere on this page. Grades
 * are organisation-level master data, so add/edit/archive/delete now lives on Settings → System Labels →
 * Organisation Labels beside Departments and Positions. The grade LIST is still read here — it feeds the
 * leave-policy scope dropdown, the preview dialog and the benefit-scheme grade groups — and no grade record
 * was copied, renamed or re-created, so every employment, leave policy, approval rule, claim limit and
 * grade group still points at the same row.
 *
 * 962077a8 (Remove Unnecessary Action Buttons): with the 7b945408 step homes in place, the PageHeader is
 * down to the single page-level action — + Import. Run Accrual and Preview Scenario open ONLY from their
 * sub-steps now (same dialogs, same page-level data prep — nothing duplicated, nothing unreachable).
 */
export default async function LeaveEntitlementsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.leave');
  const { error } = await searchParams;
  const [types, policies, companies, grades, adHocGrants, leaveYearConfigs, gradeGroups, benefitSchemes, schemeEntitlements, schemeCombinedLimits, profileOptionsActive] =
    await Promise.all([
      listLeaveTypes(s, { includeArchived: true }),
      listLeavePolicies(s),
      listCompanies(s),
      // b1b81a08 — grade MANAGEMENT moved to Settings → System Labels → Organisation Labels, but the grade
      // list is still READ here: it feeds gradeOptions (the leave-policy scope dropdown), the preview
      // dialog and BenefitSchemeConfig's grades prop. Archived rows still load so an existing grade-scoped
      // policy can render its grade name; the ACTIVE-only filters below are unchanged.
      listJobGrades(s, { includeArchived: true }),
      listAdHocLeaveGrants(s),
      // Leave Year Configuration (9aa894a4): still read here for the earned-accrual Leave-Year selector; the
      // Leave-Year management card itself relocated to the Application Rules tab (R45 cc816207).
      listLeaveYearConfigs(s),
      // Benefit Scheme & Leave Entitlement (b83c6a3b): the new configuration layer's data.
      listGradeGroups(s),
      listBenefitSchemes(s),
      listSchemeEntitlements(s),
      // Combined Leave Type Limit (R44 4c48fd1f): the per-scheme shared-cap pools.
      listSchemeCombinedLimits(s),
      // Organisation Assignment criteria (Enhance Leave Criteria Configuration): the ACTIVE picker values for
      // the eight org fields come from the SAME master list the profile Organisation Assignment screen reads
      // (data consistency); activeOnly ⇒ deleted/inactive values are never offered as new choices.
      listAllProfileOptions(s, { activeOnly: true }),
    ]);
  // Per-category active option lists for the eight org-assignment criteria, keyed by profile_option category
  // (division / branch / … / category), passed to every LeaveTypePanel. One page-level prep — no N+1 per type.
  const orgAssignmentOptions = Object.fromEntries(
    ORG_ASSIGNMENT_CRITERIA.map((c) => [
      c.category,
      (profileOptionsActive[c.category] ?? []).map((o) => ({ value: o.value, label: o.label })),
    ]),
  );
  const gradeOptions = grades.filter((g) => !g.archivedAt).map((g) => ({ id: g.id, name: g.name }));
  // ADR-0066: companies for the per-policy scope select. companyOptions stays the FULL list — policy writes
  // are separately RLS-gated and must not be narrowed here.
  const companyOptions = companies.map((c) => ({ id: c.id, name: c.name }));
  const effectiveGrants = withEffectiveGrants(s);
  const canGroupWide = isGroupAdmin(effectiveGrants);
  const festiveCompanies = canGroupWide
    ? companyOptions
    : companyOptions.filter((c) => hasGrantFor(effectiveGrants, 'hr_admin', c.id));
  const activeTypeOptions = types.filter((t) => !t.archivedAt).map((t) => ({ id: t.id, name: t.name }));
  const companyNameById = new Map(companies.map((c) => [c.id, c.name]));
  const typeNameById = new Map(types.map((t) => [t.id, t.name]));
  const typeCodeById = new Map(types.map((t) => [t.id, t.code]));
  // Feedback 26e76a9f — "preview a scenario" relocated here from the Types tab (its read-only "Entitlement
  // rules" card was removed as a duplicate configuration point). Same inputs as before: the ACTIVE policy
  // rows from the already-loaded listLeavePolicies result — display-only, no data or logic change.
  // d778d2d3: the checker became the "Preview Scenario" dialog button (LeaveRulePreviewDialog); since
  // 7b945408/962077a8 it opens from the Service Based Entitlements sub-step — this page-level data prep
  // is unchanged and simply feeds the dialog.
  const previewPolicies = policies
    .filter((p) => !p.validTo)
    .map((p) => ({ leaveTypeId: p.leaveTypeId, gradeId: p.gradeId, companyId: p.companyId, accrual: p.accrual }));
  const previewCompanies = companies.map((c) => ({ id: c.id, name: c.name, country: c.country }));
  const recentGrants: FestiveGrantRow[] = adHocGrants.map((g) => ({
    occurredAt: g.occurredAt.toISOString(),
    companyName: g.companyId ? (companyNameById.get(g.companyId) ?? null) : null,
    // fd7c8e20: the raw type id rides along so the embedded card can default-filter the list to its
    // hosting leave type (display filter only — every grant row stays in this one shared array).
    leaveTypeId: g.leaveTypeId ?? null,
    leaveTypeName: g.leaveTypeId ? (typeNameById.get(g.leaveTypeId) ?? null) : null,
    days: g.days,
    count: g.count,
    reason: g.reason,
    effectiveOn: g.effectiveOn,
  }));
  const todayIso = new Date().toISOString().slice(0, 10);
  // feedback 2c7c6385: the Run-Earned-Accrual Leave-Year selector reads the managed leave_year_config
  // records (9aa894a4). When none exist yet, fall back to the current-year..+6 range so the card still
  // works. Default to the current year if configured, else the newest record. (R45 cc816207 — the
  // Leave-Year management card itself now lives on the Application Rules tab; only this earned-accrual
  // selector still reads the configs here.)
  const currentYear = new Date().getUTCFullYear();
  const yearOptions = Array.from({ length: 7 }, (_, i) => currentYear + i);
  const earnedLeaveYears =
    leaveYearConfigs.length > 0
      ? leaveYearConfigs.map((c) => ({ year: c.year, status: c.status }))
      : yearOptions.map((y) => ({ year: y, status: 'draft' }));
  const earnedDefaultYear =
    earnedLeaveYears.find((y) => y.year === currentYear)?.year ?? earnedLeaveYears[0]?.year ?? currentYear;

  // Country-pack entitlement lookup — feeds each type's `floor0` (the day-zero statutory entitlement that
  // drives the entitlement summary and the below-minimum badge). Rung 5c — the entitlement floor comes from
  // the country pack via the registry (union-read interim: the first/only registered pack, matching the
  // rung-5a `countryPacks()` precedent for tenant-level vocabulary with no acting company; per-company
  // narrowing is the second-country rung, ADR-0080 §6). MY-only today ⇒ byte-identical to the old import.
  const packEntitlement = countryPacks()[0]?.leave.entitlement;

  // Group each type's effective-dated policies, newest first, for inline editing.
  const polByType = new Map<string, EntitlementPolicy[]>();
  for (const p of policies) {
    const acc = p.accrual as {
      annualDays?: number;
      carryForwardMax?: number;
      method?: string;
      carryForwardExpiryMonth?: number;
      carryForwardExpiryDay?: number;
      carryForwardExpiryMode?: 'date' | 'months';
      carryForwardExpiryMonths?: number;
      carryForwardEnabled?: boolean;
      carryForwardIncludeEarned?: boolean;
      serviceBands?: ServiceBand[];
      /** b81d3c52 — Rounding Method; absent on every policy that uses No Rounding. */
      roundingMethod?: 'none' | 'up' | 'down';
    } | null;
    const ep: EntitlementPolicy = {
      id: p.id,
      annualDays: Number(acc?.annualDays ?? 0),
      serviceBands: Array.isArray(acc?.serviceBands) && acc.serviceBands.length > 0 ? acc.serviceBands : null,
      carryForwardMax: Math.max(0, Number(acc?.carryForwardMax ?? 0)),
      carryForwardExpiryMonth: acc?.carryForwardExpiryMonth ?? null,
      carryForwardExpiryDay: acc?.carryForwardExpiryDay ?? null,
      carryForwardExpiryMode: acc?.carryForwardExpiryMode === 'months' ? 'months' : 'date',
      carryForwardExpiryMonths: acc?.carryForwardExpiryMonths ?? null,
      carryForwardEnabled: typeof acc?.carryForwardEnabled === 'boolean' ? acc.carryForwardEnabled : null,
      carryForwardIncludeEarned: acc?.carryForwardIncludeEarned ?? false,
      method: acc?.method,
      // b81d3c52 — only the two real methods reach the panel; absent / anything else ⇒ null (No Rounding).
      roundingMethod: acc?.roundingMethod === 'up' || acc?.roundingMethod === 'down' ? acc.roundingMethod : null,
      gradeId: p.gradeId,
      gradeName: p.gradeName,
      companyId: p.companyId,
      companyName: p.companyName,
      validFrom: p.validFrom,
      validTo: p.validTo,
    };
    const arr = polByType.get(p.leaveTypeId);
    if (arr) arr.push(ep);
    else polByType.set(p.leaveTypeId, [ep]);
  }
  for (const arr of polByType.values()) arr.sort((a, b) => b.validFrom.localeCompare(a.validFrom));

  // Restructure (123c1e76): per-type Entitlement card data — each leave type's benefit-scheme entitlement
  // rows, joined with the owning scheme's name and (read-only) any combined-limit pool the type belongs to
  // in that scheme. The SAME already-loaded rows the scoped Benefit Schemes area (6c775d68, below in the
  // same step) renders — filtered by leave type, never duplicated — and the panel's Edit dialog posts the
  // SAME upsert action, so the two surfaces cannot drift.
  const schemeNameById = new Map(benefitSchemes.map((sc) => [sc.id, sc.name]));
  // Feedback 0d1a0cfc — the owning COMPANY name per scheme, so the Service Based Entitlements table's
  // "Benefit scheme" column can name the company beside the scheme (matching the company-grouped Scheme
  // picker). Resolved from the benefitSchemes + companies rows this page already loads — no new query,
  // nothing stored.
  const schemeCompanyNameById = new Map(
    benefitSchemes.map((sc) => [sc.id, companyNameById.get(sc.companyId) ?? null] as const),
  );
  const poolBySchemeType = new Map<string, { name: string; totalLimitDays: number }>();
  for (const cl of schemeCombinedLimits) {
    for (const ltId of cl.leaveTypeIds) {
      poolBySchemeType.set(`${cl.benefitSchemeId}:${ltId}`, { name: cl.name, totalLimitDays: cl.totalLimitDays });
    }
  }
  const schemeEntsByType = new Map<string, LeaveTypeSchemeEntitlement[]>();
  for (const e of schemeEntitlements) {
    const pool = poolBySchemeType.get(`${e.benefitSchemeId}:${e.leaveTypeId}`) ?? null;
    const row: LeaveTypeSchemeEntitlement = {
      id: e.id,
      benefitSchemeId: e.benefitSchemeId,
      schemeName: schemeNameById.get(e.benefitSchemeId) ?? '—',
      companyName: schemeCompanyNameById.get(e.benefitSchemeId) ?? null,
      leaveTypeId: e.leaveTypeId,
      leaveTypeName: e.leaveTypeName,
      serviceBands: e.serviceBands,
      poolName: pool?.name ?? null,
      poolTotalLimitDays: pool?.totalLimitDays ?? null,
    };
    const arr = schemeEntsByType.get(e.leaveTypeId);
    if (arr) arr.push(row);
    else schemeEntsByType.set(e.leaveTypeId, [row]);
  }
  for (const arr of schemeEntsByType.values()) arr.sort((a, b) => a.schemeName.localeCompare(b.schemeName));

  // Move Benefit Schemes into the Entitlement step (feedback 6c775d68): the standalone page-bottom section
  // is gone — BenefitSchemeConfig now renders inside EACH leave type's Entitlement step, scoped to that type
  // (scopeLeaveTypeId). The props are prepared ONCE here from the rows this page already loads and shared by
  // every panel (only the scope id varies) — no per-type reload, no N+1. All scheme data, combined limits
  // and calculations are untouched: this changes where schemes are managed, not how they work.
  const schemeConfigProps = {
    companies: companyOptions,
    grades: grades.filter((g) => !g.archivedAt).map((g) => ({ id: g.id, name: g.name, code: g.code })),
    leaveTypes: activeTypeOptions.map((lt) => ({ id: lt.id, name: lt.name, code: typeCodeById.get(lt.id) ?? '' })),
    gradeGroups: gradeGroups.map((g) => ({ id: g.id, name: g.name, gradeIds: g.gradeIds, archived: g.archived })),
    schemes: benefitSchemes.map((sc) => ({
      id: sc.id,
      companyId: sc.companyId,
      employmentType: sc.employmentType,
      gradeGroupId: sc.gradeGroupId,
      gradeGroupName: sc.gradeGroupName,
      name: sc.name,
      status: sc.status,
    })),
    entitlements: schemeEntitlements.map((e) => ({
      id: e.id,
      benefitSchemeId: e.benefitSchemeId,
      leaveTypeId: e.leaveTypeId,
      leaveTypeName: e.leaveTypeName,
      serviceBands: e.serviceBands,
    })),
    combinedLimits: schemeCombinedLimits.map((cl) => ({
      id: cl.id,
      benefitSchemeId: cl.benefitSchemeId,
      name: cl.name,
      totalLimitDays: cl.totalLimitDays,
      leaveTypeIds: cl.leaveTypeIds,
    })),
    actions: {
      createGradeGroup: createGradeGroupAction,
      updateGradeGroup: updateGradeGroupAction,
      deleteGradeGroup: deleteGradeGroupAction,
      createScheme: createBenefitSchemeAction,
      updateScheme: updateBenefitSchemeAction,
      deleteScheme: deleteBenefitSchemeAction,
      upsertEntitlement: upsertSchemeEntitlementAction,
      deleteEntitlement: deleteSchemeEntitlementAction,
      copyEntitlements: copySchemeEntitlementsAction,
      updateCombinedLimit: updateSchemeCombinedLimitAction,
      deleteCombinedLimit: deleteSchemeCombinedLimitAction,
      // R47 d6f88c2f — DnD grouping writes for the entitlement table.
      moveCombinedLimitMember: moveCombinedLimitMemberAction,
      groupLeaveTypes: groupSchemeLeaveTypesAction,
    },
  };

  // ── Approval Workflow sub-step data (e1a51aea) ────────────────────────────────────────────────────
  // The General step's 5th sub-step embeds the SAME WorkflowMatrix the Approval tab renders, scoped to the
  // hosting leave type. All approval data + the label bag are prepared ONCE here (the benefitSchemeSection
  // precedent — no N+1 per type); only the row filter + defaultLeaveTypeId vary per panel. Company-wide
  // chains and templates stay on the Approval tab (linked from the sub-step) — the per-company default
  // chain is summarised READ-ONLY here.
  const ta = await getTranslations('leaveApproval');
  const companyIds = companies.map((c) => c.id);
  const [departmentsAll, positionsAll, businessUnitsAll, approvalTemplates, approvalPerCompany] = await Promise.all([
    companyIds.length ? listDepartments(s, { companyIds }) : Promise.resolve([]),
    companyIds.length ? listPositions(s, { companyIds }) : Promise.resolve([]),
    companyIds.length ? listBusinessUnits(s, { companyIds }) : Promise.resolve([]),
    listApprovalTemplates(s),
    Promise.all(
      companies.map(async (c) => ({
        company: c,
        pol: await getLeaveApprovalPolicy(s, c.id),
        rules: await listLeaveApprovalRules(s, c.id),
      })),
    ),
  ]);
  // Every non-company-default rule across the in-scope companies, in the matrix's row shape. The per-type
  // slot filters this ONE array — scoped rules (leaveTypeId === the type) render editable in the matrix;
  // wildcard any-type rules (leaveTypeId === null) render read-only with an "applies to all types" badge.
  const approvalRuleRows = approvalPerCompany.flatMap(({ rules }) =>
    rules
      .filter((r) => !isCompanyDefaultApprovalRule(r))
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
  );
  const wildcardApprovalRules = approvalRuleRows.filter((r) => r.leaveTypeId == null);
  // Chain-role labels for the read-only default-chain summary (the Approval tab's vocabulary).
  const approvalRoleLabel: Record<string, string> = {
    direct_manager: ta('manager'),
    department_head: ta('departmentHead'),
    business_unit_head: ta('businessUnitHead'),
    hr_admin: ta('hr'),
    hr_manager: ta('hrManager'),
    payroll: ta('payroll'),
    custom_role: ta('customRole'),
  };
  const approvalMatrixShared = {
    companies: companies.map((c) => ({ id: c.id, label: c.name })),
    leaveTypes: types.map((x) => ({ id: x.id, label: x.name })),
    gradeGroups: gradeGroups.filter((g) => !g.archived).map((g) => ({ id: g.id, label: g.name })),
    grades: grades.map((x) => ({ id: x.id, label: `${x.code} — ${x.name}` })),
    businessUnits: businessUnitsAll.map((x) => ({ id: x.id, label: `${x.code} — ${x.name}`, companyId: x.companyId })),
    departments: departmentsAll.map((x) => ({ id: x.id, label: x.name, companyId: x.companyId })),
    positions: positionsAll.map((x) => ({ id: x.id, label: x.title, companyId: x.companyId })),
    templates: approvalTemplates.filter((t2) => t2.active).map((t2) => ({ id: t2.id, label: t2.name })),
    actions: {
      save: saveLeaveApprovalRuleFromEntitlementsAction,
      archive: archiveLeaveApprovalRuleFromEntitlementsAction,
    },
    labels: buildWorkflowMatrixLabels(ta),
  };

  // ── Half-Day Deduction card (08bc6841) ─────────────────────────────────────────────────────────────
  // Relocated from the Application Rules tab (feedback 31474452's per-company toggle — this is its single
  // home now): rendered as ONE card of the Condition step's Leave Application Rules grid. The rows are
  // per-COMPANY (not per-type), so one node is composed here and shared by every panel (the slot
  // precedent — benefitSchemeSection etc.); each row posts the SAME setLeaveHalfDayFullDeductionAction —
  // only the rendering (and the action's redirect target) moved. The applies-company-wide badge flags
  // that saving here affects every leave type and every application, not just the hosting type.
  const halfDaySection = (
    <div className="space-y-1.5 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">{t('halfDayDeductionTitle')}</span>
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {t('conditionStep.halfDayCompanyWideBadge')}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">{t('halfDayDeductionHelp')}</p>
      <p className="text-xs text-muted-foreground">{t('halfDayDeductionFrozenNote')}</p>
      <ul className="divide-y divide-border">
        {companies.map((c) => (
          <li key={c.id} className="py-2">
            <form
              action={setLeaveHalfDayFullDeductionAction}
              className="flex flex-wrap items-center justify-between gap-3"
            >
              <input type="hidden" name="companyId" value={c.id} />
              <div className="min-w-0">
                <span className="block truncate text-sm font-medium text-foreground">{c.name}</span>
                <span className="text-xs text-muted-foreground">
                  {c.leaveHalfDayFullDeduction ? t('halfDayDeductionOn') : t('halfDayDeductionOff')}
                </span>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="enabled"
                  defaultChecked={!!c.leaveHalfDayFullDeduction}
                  className="size-4 rounded"
                />
                {t('halfDayDeductionToggleLabel')}
              </label>
              <Button type="submit" variant="outline" size="sm">
                {t('save')}
              </Button>
            </form>
          </li>
        ))}
      </ul>
    </div>
  );

  // ── Grade MASTER is no longer maintained here (b1b81a08) ─────────────────────────────────────────
  // Grades are organisation-level master data, so their add/edit/archive/delete surface moved to
  // Settings → System Labels → Organisation Labels, beside Departments / Positions / Cost Centres /
  // Business Units. The old Panel A grade catalogue (its fold cookie and the grade→grade-group DRAG
  // shortcut that rode on it) is gone; the tick-box grade-group membership editor in Panel B is the
  // surviving assignment path and is unaffected. Grade GROUPS and Benefit Schemes stay exactly where they
  // are — only the grade list itself moved.

  // ── Entitlement-step tool slots (7b945408) ───────────────────────────────────────────────────────
  // Preview Scenario joins the Service Based Entitlements sub-step as its checking tool, and Run Accrual
  // joins Adjustments (it processes earned entitlement — it belongs with entitlement adjustments). Both
  // mount the SAME self-contained dialogs the PageHeader cluster used to host (d778d2d3) — one shared node
  // each, fed by the page-level data prep above (no N+1 per type). 962077a8 removed the header buttons, so
  // these sub-step slots are the tools' only mounts now.
  const previewScenarioSection =
    activeTypeOptions.length > 0 && companyOptions.length > 0 ? (
      <div className="space-y-1.5 border-t border-border pt-3">
        <span className="text-xs font-medium text-muted-foreground">{t('previewTitle')}</span>
        <p className="text-xs text-muted-foreground">{t('entitlementStep.previewHint')}</p>
        <LeaveRulePreviewDialog
          leaveTypes={activeTypeOptions.map((o) => ({ id: o.id, name: o.name, code: typeCodeById.get(o.id) ?? '' }))}
          companies={previewCompanies}
          grades={gradeOptions}
          policies={previewPolicies}
        />
      </div>
    ) : null;
  const accrualSection = (
    <div className="space-y-1.5 border-t border-border pt-3">
      <span className="text-xs font-medium text-muted-foreground">{t('runEarnedAccrual')}</span>
      <p className="text-xs text-muted-foreground">{t('entitlementStep.accrualHint')}</p>
      <EarnedAccrualDialog
        companies={festiveCompanies}
        grades={gradeOptions}
        leaveTypes={activeTypeOptions}
        leaveYears={earnedLeaveYears}
        defaultYear={earnedDefaultYear}
      />
    </div>
  );

  // Feedback 1bd9a911 — the workspace's internal left-side Leave Type list is ordered here, on the server,
  // so BOTH the desktop list and the mobile dropdown (they read the same `items` prop) get one ordering and
  // the client keeps its plain `items[0]` default selection. Active types first, then archived ones, each
  // group A–Z case-insensitively. Only the workspace list order changes: `panels` is keyed by id, and the
  // other type-derived arrays (activeTypeOptions, typeNameById, …) are deliberately left alone.
  const workspaceItems = [...types].sort(
    (a, b) =>
      Number(!!a.archivedAt) - Number(!!b.archivedAt) ||
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('pageTitle')}
        description={t('pageDescription')}
        actions={
          /* e8f2398f: Import is a page-level action button (the standard top-right spot). 962077a8: it is
             the ONLY header action now — the Run Accrual and Preview Scenario buttons d778d2d3 parked here
             moved into the Entitlement step's sub-steps (7b945408's accrualSection / previewScenarioSection
             slots above), where the related configuration lives. */
          <Link href="/admin/leave/import" className={btnPrimary}>
            {t('importAction')}
          </Link>
        }
      />
      <LeaveTabs active="entitlements" />
      <ErrorBanner message={error} />

      {/* Feedback 9d8cf621 — per-type configuration + entitlements. "1 leave type, 1 full set of settings".
          Workspace shape (c979aa8b): the stacked collapsible rows became a two-pane workspace — an internal
          left panel listing the types (Add Leave button at the bottom) and a right pane showing the SELECTED
          type's five-step configuration flow (LeaveTypePanel's step bar). Each panel keeps the exact same
          props/actions as before; the client workspace only decides which one is mounted. */}
      <Card data-tour="leave-config">
        <SectionHeader title={t('typesSectionTitle')} count={types.length} />
        <LeaveTypeWorkspace
          items={workspaceItems.map((lt) => ({
            id: lt.id,
            name: lt.name,
            code: lt.code,
            archived: !!lt.archivedAt,
            color: lt.color ?? null,
            icon: lt.icon ?? null,
          }))}
          panels={Object.fromEntries(
            types.map((lt) => [
              lt.id,
              <LeaveTypePanel
                key={lt.id}
                id={lt.id}
              name={lt.name}
              code={lt.code}
              description={lt.description ?? null}
              paid={lt.paid}
              archived={!!lt.archivedAt}
              inUse={lt.inUse}
              isAnnual={lt.code === 'ANNUAL'}
              floor0={packEntitlement?.(lt.code, 0) ?? 0}
              eligibility={(lt.eligibility as LeaveEligibilityRule | null) ?? null}
              orgAssignmentOptions={orgAssignmentOptions}
              durations={(lt.durations as string[] | null) ?? null}
              requiresDocument={lt.requiresDocument}
              mandatoryAfterDays={lt.mandatoryAfterDays ?? null}
              allowedMimeTypes={(lt.allowedMimeTypes as string[] | null) ?? null}
              maxDocBytes={lt.maxDocBytes}
              employeeRemarkRequired={lt.employeeRemarkRequired}
              hrRemarkRequired={lt.hrRemarkRequired}
              backdatingLimitDays={lt.backdatingLimitDays ?? null}
              minAdvanceDays={lt.minAdvanceDays ?? null}
              expiryValue={lt.expiryValue ?? null}
              expiryUnit={lt.expiryUnit ?? null}
              customMessages={(lt.customMessages as Record<string, string> | null) ?? null}
              essViewConfig={(lt.essViewConfig as Record<string, boolean> | null) ?? null}
              formulaExplanations={(lt.formulaExplanations as Record<string, { description?: string; formula?: string; result?: string }> | null) ?? null}
              dayTypeInclusion={(lt.dayTypeInclusion as Record<string, boolean> | null) ?? null}
              color={lt.color ?? null}
              icon={lt.icon ?? null}
              leaveUnit={lt.leaveUnit ?? 'day'}
              yearCycleOverride={lt.yearCycleOverride ?? null}
              probationEligibility={lt.probationEligibility ?? null}
              visibleToEmployee={lt.visibleToEmployee ?? null}
              employeeCanApply={lt.employeeCanApply ?? null}
              essPlacement={lt.essPlacement ?? null}
              counting={lt.counting ?? 'working_days'}
              perDateApproval={lt.perDateApproval ?? false}
              duplicateApplicationPolicy={lt.duplicateApplicationPolicy ?? null}
              allowNegativeBalance={lt.allowNegativeBalance ?? false}
              balanceSourceTypeId={lt.balanceSourceTypeId ?? null}
              allowUnpaidLeave={lt.allowUnpaidLeave ?? false}
              /* Balance Deduction Source (cdf9ca48): the candidates THIS type may point at. Derived from the
                 one page-level `types` read (no N+1): exclude self, exclude archived types, and exclude any
                 type that already borrows — the service refuses chains, so offering one would only produce a
                 rejected save. A type that is already somebody's source is still offered: pointing a second
                 borrower at it is a perfectly ordinary setup (several types all drawing on Annual Leave). */
              balanceSourceOptions={types
                .filter((x) => x.id !== lt.id && !x.archivedAt && x.balanceSourceTypeId == null)
                .map((x) => ({ id: x.id, name: x.name }))}
              policies={polByType.get(lt.id) ?? []}
              grades={gradeOptions}
              companies={companyOptions}
              schemeEntitlements={schemeEntsByType.get(lt.id) ?? []}
              benefitSchemeSection={
                /* 6c775d68: the Benefit Schemes management area, scoped to this leave type, rendered inside
                   the Entitlement step below the per-type table. Shared props (one page-level data prep) +
                   the per-type scope id. b1b81a08: the workbench is now TWO panels — Grade Groups and
                   Assignment. The Grade Master panel moved to Settings → System Labels. */
                <div className="space-y-3 border-t border-border pt-3">
                  <div>
                    <span className="text-xs font-medium text-muted-foreground">{t('benefitSchemeTitle')}</span>
                    <p className="text-xs text-muted-foreground">{t('benefitSchemeHelp')}</p>
                  </div>
                  <BenefitSchemeConfig {...schemeConfigProps} scopeLeaveTypeId={lt.id} />
                </div>
              }
              festiveGrantSection={
                /* fd7c8e20 (ADR-0066): the One-Off / Festive Leave Grant tool, moved from the standalone
                   page-bottom section into the Entitlement step (since 7b945408 it HEADS the Adjustments
                   sub-step, so no top divider). Data prep (festiveCompanies, recentGrants) stays at page
                   level and is shared by every panel — only the preselected leave type varies. -mx-4 lets
                   the card's own px-4 gutters line up with the step's CardContent padding. */
                <div className="space-y-1">
                  <span className="text-xs font-medium text-muted-foreground">{t('festiveTitle')}</span>
                  <div className="-mx-4">
                    <FestiveGrantCard
                      companies={festiveCompanies}
                      canGroupWide={canGroupWide}
                      leaveTypes={activeTypeOptions}
                      recent={recentGrants}
                      defaultDate={todayIso}
                      defaultLeaveTypeId={lt.id}
                    />
                  </div>
                </div>
              }
              approvalWorkflowSection={
                /* e1a51aea: the Approval Workflow sub-step — this type's rules from the SAME rule matrix
                   the Approval tab renders (same actions, shared labels), scoped + seeded to this type;
                   wildcard any-type rules and the per-company default chain are summarised read-only with
                   the Approval tab one click away. */
                <div className="space-y-3">
                  <p className="text-xs text-muted-foreground">{t('approvalStep.hint')}</p>
                  <WorkflowMatrix
                    rows={approvalRuleRows.filter((r) => r.leaveTypeId === lt.id)}
                    defaultLeaveTypeId={lt.id}
                    {...approvalMatrixShared}
                  />
                  <div className="space-y-1.5">
                    <span className="text-xs font-medium text-muted-foreground">{t('approvalStep.wildcardTitle')}</span>
                    {wildcardApprovalRules.length === 0 ? (
                      <p className="rounded-lg bg-background px-3 py-2 text-xs text-muted-foreground">
                        {t('approvalStep.wildcardNone')}
                      </p>
                    ) : (
                      wildcardApprovalRules.map((r) => (
                        <div
                          key={r.id}
                          className="flex flex-wrap items-center gap-2 rounded-lg bg-background px-3 py-2 text-xs"
                        >
                          <span className="font-medium text-foreground">
                            {companyNameById.get(r.companyId) ?? r.companyId}
                          </span>
                          {r.ruleName && <span className="text-muted-foreground">{r.ruleName}</span>}
                          {/* read-only: an any-type rule is shared config — edited on the Approval tab */}
                          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                            {t('approvalStep.wildcardBadge')}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <span className="text-xs font-medium text-muted-foreground">
                      {t('approvalStep.defaultChainTitle')}
                    </span>
                    {approvalPerCompany.map(({ company, pol }) => (
                      <div
                        key={company.id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-background px-3 py-2 text-xs"
                      >
                        <span className="font-medium text-foreground">{company.name}</span>
                        <span className="text-muted-foreground">
                          {pol.enabled
                            ? pol.levels.map((lv) => approvalRoleLabel[lv] ?? lv).join(' → ')
                            : t('approvalStep.defaultChainOff')}
                        </span>
                      </div>
                    ))}
                  </div>
                  <Link
                    href="/admin/leave/approval"
                    className="inline-block text-xs font-medium text-primary underline-offset-2 hover:underline"
                  >
                    {t('approvalStep.openApprovalTab')}
                  </Link>
                </div>
              }
              halfDaySection={halfDaySection}
              previewScenarioSection={previewScenarioSection}
              accrualSection={accrualSection}
              updateTypeAction={updateLeaveTypeAction}
              archiveTypeAction={archiveLeaveTypeAction}
              deleteTypeAction={deleteLeaveTypeAction}
              createPolicyAction={createLeavePoliciesMultiAction}
              updatePolicyAction={updateLeavePolicyAction}
              deletePolicyAction={deleteLeavePolicyAction}
              countInScopeAction={countEmployeesInScopeAction}
              upsertSchemeEntitlementAction={upsertSchemeEntitlementAction}
              saveServiceEntitlementAction={saveServiceEntitlementAction}
              />,
            ]),
          )}
          addForm={
        /* Add Leave Type pop-up (8cc268c4): this form now renders ONLY inside the workspace's "Add Leave Type"
            dialog, never as a page row — so the a9c5870a one-row page grid (six sm columns + the explicit lg
            template) gave way to a modal-width two-column layout: Code/Name share row 1, Description spans the
            full width, Status/Leave Unit share the next row, then Paid, then the standard bottom-right
            Cancel/Save footer. Every posted field (name attr, order, control type — dc3ec3c6's Leave Unit →
            Paid order, fbcadc71's multiline textarea) is unchanged, as is the server action. */
        <form
          action={createLeaveTypeAction}
          className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2"
        >
          {/* In-dialog error surface: a failed save (duplicate code/name…) redirects back with ?error= while
              the dialog is still open (client state survives the soft navigation), so the page-level banner
              would sit hidden BEHIND the modal — mirror the message here where the admin is looking. */}
          {error && (
            <div className="col-span-full">
              <ErrorBanner message={error} />
            </div>
          )}
          <Field label={t('codeLabel')}>
            <input
              name="code"
              required
              placeholder={t('codePlaceholder')}
              title={t('codeHint')}
              className={`${inputCls} uppercase`}
            />
          </Field>
          <Field label={t('nameLabel')}>
            <input name="name" required placeholder={t('namePlaceholder')} className={inputCls} />
          </Field>
          <Field label={t('descriptionLabel')} className="sm:col-span-2">
            {/* Multiline (fbcadc71): textarea so Enter inserts a newline instead of submitting; h-auto/min-h/resize-y
                overrides inputCls's fixed h-9 so it shows ~2 lines, grows via the drag handle, and scrolls on overflow.
                Persistence already stores text with newlines (action only .trim()s the ends). In the dialog's
                two-column grid it spans the full modal width (sm:col-span-2) — the widest slot available. */}
            <textarea
              name="description"
              rows={2}
              placeholder={t('descriptionPlaceholder')}
              className={`${inputCls} h-auto min-h-[3.25rem] resize-y`}
            />
          </Field>
          <Field label={t('statusLabel')}>
            <select name="active" defaultValue="active" className={inputCls}>
              <option value="active">{t('statusActive')}</option>
              <option value="inactive">{t('statusInactive')}</option>
            </select>
          </Field>
          {/* Leave Unit Configuration (e4980382 → dc3ec3c6): Day/Hour select sits BEFORE Paid, mirroring the
              edit form's Leave Unit → Paid order. Default Day. */}
          <Field label={t('leaveUnitLabel')}>
            <select name="leaveUnit" defaultValue="day" className={inputCls}>
              <option value="day">{t('leaveUnitDay')}</option>
              <option value="hour">{t('leaveUnitHour')}</option>
            </select>
          </Field>
          {/* dc3ec3c6: Paid keeps the captioned Field + explicit aria-label pattern the edit form uses
              (components/leave-type-panel.tsx). The old justify-self-end right-pin was a page-row concern
              (it sat beside the Add button); in the dialog grid it aligns naturally with its neighbours.
              defaultChecked stays — dropping it would silently flip every new type's default from Paid to
              Unpaid. */}
          <Field label={t('paidLabel')}>
            <div className="flex h-9 items-center">
              <input type="checkbox" name="paid" defaultChecked aria-label={t('paidLabel')} className="size-4 rounded" />
            </div>
          </Field>
          {/* 8cc268c4: the standard modal footer — Cancel (closes the dialog without saving, via the
              workspace-exported Dialog.Close wrapper) and Save (posts createLeaveTypeAction, whose redirect
              carries #type-<new id> so the workspace selects the new type and dismisses the dialog). */}
          <div className="col-span-full mt-1 flex justify-end gap-2">
            <AddLeaveTypeCancel>{t('cancel')}</AddLeaveTypeCancel>
            <button className={btnPrimary}>{t('save')}</button>
          </div>
        </form>
          }
        />
        <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
          {t.rich('typesHelp', { strong: (chunks) => <span className="font-medium">{chunks}</span> })}
        </p>
      </Card>

      {/* ADR-0041 2E + Grade Management (728a7db6): the grade master no longer sits here at all. b1b81a08
          relocated it out of Leave Config entirely, to Settings → System Labels → Organisation Labels;
          grade GROUPS and benefit schemes stay in the Entitlement step's Benefit Schemes sub-step. */}
    </div>
  );
}

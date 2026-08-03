import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireAdmin, isGroupAdmin, hasGrantFor, withEffectiveGrants } from '@/lib/authz';
import { listLeaveTypes, listCompanies, listJobGrades } from '@/core/read';
import { listAdHocLeaveGrants, listLeavePolicies } from '@/core/admin';
// 1e4eb8af — leaveYearsWithRecords joins the reads here: the relocated Leave Year Configuration section
// needs the same delete pre-check the Application Rules tab used to run.
import { listLeaveYearConfigs, leaveYearsWithRecords } from '@/core/leave';
import { ORG_ASSIGNMENT_CRITERIA } from '@/core/leave-org-criteria';
import { leaveFormulaTemplateFrom, type LeaveFormulaEntry } from '@/core/leave-formula';
import { listAllProfileOptions } from '@/core/profile-options';
// e4238594 — the e1a51aea Approval Workflow imports (WorkflowMatrix, the matrix label builder, the
// approval-policy/template reads and the 4e9a4d59 stay-on-this-type action wrappers) all went with the
// sub-step. This page no longer touches approval configuration at all; /admin/leave/approval owns it.
import { listGradeGroups, listBenefitSchemes, listSchemeEntitlements } from '@/core/benefit-scheme';
// r88 1ef1cf95 — shared leave groups are tenant-level and read from their own module; they are no longer a
// property of a benefit scheme, so they are no longer read through the benefit-scheme one.
import { listLeaveSharedGroups } from '@/core/leave-shared-group';
import { LeaveSharedGroupConfig } from '@/components/leave-shared-group-config';
import { BenefitSchemeConfig, type LeaveTypeSchemeEntitlement } from '@/components/benefit-scheme-config';
import type { ServiceBand } from '@/core/leave-compute';
import { countryPacks } from '@/localization/registry';
import { Badge, Button, Card, ErrorBanner, Field, PageHeader, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
// 10e96227 — the half-day-deduction card's company picker, behind a CLIENT wrapper. This page is a SERVER
// component, and r123 passed ChipMultiSelect's removeLabelFor/countLabelFor closures straight across the
// boundary, which threw at render and took the whole tab down. The wrapper resolves the translator on the
// client side; only serialisable data crosses. See that file's header before changing this.
import { HalfDayCompanyPicker } from '@/components/leave/half-day-company-picker';
import { LeaveTabs } from '@/components/leave-tabs';
// 1e4eb8af — the two leave-year dialogs come along with the relocated section, unchanged.
import { LeaveYearRuleDialog } from '@/components/leave/leave-year-rule-dialog';
import { LeaveYearEditDialog } from '@/components/leave/leave-year-edit-dialog';
import { LeaveTypePanel, type EntitlementPolicy, type LeaveEligibilityRule } from '@/components/leave-type-panel';
import { AddLeaveTypeCancel, LeaveTypeWorkspace } from '@/components/leave-type-workspace';
import { FestiveGrantCard, type FestiveGrantRow } from '@/components/festive-grant-card';
import { EarnedAccrualDialog } from '@/components/leave/earned-accrual-dialog';
import { LeaveRulePreviewDialog } from '@/components/leave/leave-rule-preview-dialog';
import { todayInKualaLumpur } from '@/lib/hr-date';
import {
  archiveLeaveTypeAction,
  countEmployeesInScopeAction,
  setLeaveHalfDayFullDeductionCompaniesAction,
  createLeavePoliciesMultiAction,
  createLeaveTypeAction,
  deleteLeavePolicyAction,
  deleteLeaveTypeAction,
  updateLeavePolicyAction,
  setLeaveTypeRulesAction,
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
  // r88 1ef1cf95 — the tenant-level shared-group writes. The scheme-level combined-limit actions (update /
  // delete / move / group-from-drag) are gone with the surface and the tables they wrote.
  createLeaveSharedGroupAction,
  updateLeaveSharedGroupAction,
  deleteLeaveSharedGroupAction,
  // 1e4eb8af — the four leave-year actions, unchanged: only their redirect target moved to this route.
  upsertLeaveYearConfigAction,
  setLeaveYearStatusAction,
  saveFutureOpeningRuleAction,
  deleteLeaveYearAction,
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
 * 1e4eb8af (Restructure Leave Year Configuration): the Leave Year Configuration table came BACK from the
 * Application Rules tab — that tab is retired — but not to the page bottom: it is composed here as the
 * `leaveYearSection` slot and rendered inside every leave type's Custom Settings step, beside that type's
 * Leave Year Type override. Same records, same actions, same dialogs, same delete guard; only the frame
 * moved, and the leave-year actions redirect back to THIS route. The per-company Leave Cycle card did not
 * come along: it decided the same thing the per-type override decides, so it was retired with the tab.
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
  const [types, policies, companies, grades, adHocGrants, leaveYearConfigs, leaveYearRecordYears, gradeGroups, benefitSchemes, schemeEntitlements, sharedGroups, profileOptionsActive] =
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
      // Leave Year Configuration (9aa894a4): feeds BOTH the earned-accrual Leave-Year selector and — since
      // 1e4eb8af relocated the management card off the retired Application Rules tab — the Leave Year
      // Configuration section inside each type's Custom Settings step.
      listLeaveYearConfigs(s),
      // R45 fd71fa38: years that already have leave records — drives the row Delete button's blocked state.
      leaveYearsWithRecords(s),
      // Benefit Scheme & Leave Entitlement (b83c6a3b): the new configuration layer's data.
      listGradeGroups(s),
      listBenefitSchemes(s),
      listSchemeEntitlements(s),
      // Shared Leave Groups (r88 1ef1cf95): tenant-level groups of leave types sharing one allowance. Read
      // once here and rendered beside Add Leave Type — there is no scheme dimension to scope them by.
      listLeaveSharedGroups(s),
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
  // Smart content reuse (ed17a4f9 §4): the wording template every not-yet-configured leave type is
  // PRE-FILLED from — the first leave type that already carries an Employee Leave View Configuration.
  // Resolved once here off the ALREADY-LOADED `types`, so a tenant with 60 leave types costs no extra query.
  // "First" is `listLeaveTypes`' order, which is alphabetical by the viewer's display name — deterministic,
  // so the same template is offered on every reload rather than whichever row Postgres happened to return.
  // Read-side only: this fills FORM DEFAULTS. Nothing is written unless HR presses Save on a type.
  const formulaTemplate = leaveFormulaTemplateFrom(
    types.map((lt) => lt.formulaExplanations as Record<string, LeaveFormulaEntry> | null),
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
  const todayIso = todayInKualaLumpur();
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
  // a03eff24 — the matrix's ROW identity: the scheme's grade group and employment type. Same already-loaded
  // benefitSchemes rows (listBenefitSchemes left-joins grade_group for the name) — no extra query.
  const schemeAxesById = new Map(
    benefitSchemes.map((sc) => [sc.id, { gradeGroupName: sc.gradeGroupName, employmentType: sc.employmentType }] as const),
  );
  // r88 1ef1cf95: the per-(scheme × type) pool lookup that used to be built here is gone. A shared group no
  // longer belongs to a scheme, so there is nothing scheme-scoped to annotate an entitlement row WITH —
  // group membership is a property of the leave type alone and is shown in the Shared Leave Groups manager.
  const schemeEntsByType = new Map<string, LeaveTypeSchemeEntitlement[]>();
  for (const e of schemeEntitlements) {
    const row: LeaveTypeSchemeEntitlement = {
      id: e.id,
      benefitSchemeId: e.benefitSchemeId,
      schemeName: schemeNameById.get(e.benefitSchemeId) ?? '—',
      companyName: schemeCompanyNameById.get(e.benefitSchemeId) ?? null,
      gradeGroupName: schemeAxesById.get(e.benefitSchemeId)?.gradeGroupName ?? null,
      employmentType: schemeAxesById.get(e.benefitSchemeId)?.employmentType ?? 'full_time',
      leaveTypeId: e.leaveTypeId,
      leaveTypeName: e.leaveTypeName,
      serviceBands: e.serviceBands,
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
      // Feedback 0890a555: the grouping label. MUST be projected or the column renders "Ungrouped" for
      // every scheme and the edit dialog opens empty on a scheme that has one.
      schemeCategory: sc.schemeCategory,
    })),
    entitlements: schemeEntitlements.map((e) => ({
      id: e.id,
      benefitSchemeId: e.benefitSchemeId,
      leaveTypeId: e.leaveTypeId,
      leaveTypeName: e.leaveTypeName,
      serviceBands: e.serviceBands,
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
    },
  };

  // e4238594 removed the Approval Workflow sub-step data block that stood here (e1a51aea). It prepared
  // the WorkflowMatrix rows, the wildcard list, the per-company default chain and the label bag for a
  // per-type embed that duplicated the Approval Workflow tab. The tab renders a strict superset of
  // those rules, so nothing is stranded — and every read above (departments, positions, business units,
  // templates, per-company policies) went with it, which is the point: the duplicate cost a fan of
  // queries on every render of this page.

  // ── Half-Day Deduction card (08bc6841, multi-select since 10e96227) ────────────────────────────────
  // Relocated from the Application Rules tab (feedback 31474452's per-company toggle — this is its single
  // home now): rendered as ONE card of the Condition step's Leave Application Rules grid. The rule is
  // per-COMPANY (not per-type), so one node is composed here and shared by every panel (the slot
  // precedent — benefitSchemeSection etc.). The applies-company-wide badge flags that saving here affects
  // every leave type and every application, not just the hosting type.
  //
  // 10e96227 REPLACED N FORMS WITH ONE. The reporter's complaint was arithmetic: eight companies meant
  // eight rows, eight tickboxes and eight Saves to express a single decision, and the screen grew every
  // time a company was added. It is now one multi-select naming the companies the rule applies to, and one
  // Save. The STORED SHAPE IS UNCHANGED — still one boolean per company — so this is presentation only and
  // needs no migration; what changed is that the post states the whole set instead of one member of it.
  //
  // ⚠️ THERE IS NO SEPARATE "ENABLE" SWITCH, and that is a deliberate departure from the approved plan's
  // wording ("one enable switch and a multi-select"). A master switch has nowhere to live: the schema
  // stores exactly a set of companies, so an OFF switch would have to mean "all companies false" — after
  // which a reload cannot tell it from an empty selection, and any remembered selection silently
  // evaporates. The empty selection already says "applies nowhere", which is the same thing every box
  // unticked said before, so the switch would add a state the database cannot hold. Select all / Clear all
  // give the same one-click reach without inventing one. Recorded for the reporter at deploy time.
  //
  // ⚠️ THE PICKER IS SCOPED TO `adminOnly`, WHICH IS NARROWER THAN THE PAGE'S `companies`. `listCompanies(s)`
  // is tenant-wide, but the company UPDATE policy is admin-for-company — so a company-scoped hr_admin can
  // SEE companies it cannot write. Under the old per-row UI that made one row's Save a silent no-op. Under
  // one authoritative Save it would be actively misleading: unselected-but-unwritable companies would look
  // like a deliberate "turn this off" that never lands. Offering exactly the companies the write can reach
  // keeps the screen and the database in agreement, and core.setLeaveHalfDayFullDeductionCompanies resolves
  // the same `app.is_admin_for` set server-side so a hand-crafted post cannot widen it either.
  // 9861b8a4 — leave types where a negative balance is allowed but no floor has been set. These are the
  // ones whose new approval permission is NOT yet active, listed so the administrator can finish the
  // decision. Archived types are excluded: they configure nothing.
  const negativeBalanceNeedsLimit = types.filter(
    (lt) => lt.allowNegativeBalance === true && lt.maxNegativeBalance == null && !lt.archivedAt,
  );
  const halfDayCompanies = await listCompanies(s, { adminOnly: true });
  const halfDayEnabledCompanyIds = halfDayCompanies.filter((c) => c.leaveHalfDayFullDeduction).map((c) => c.id);
  const halfDaySection = (
    // #f6d3be0b: matches the chrome the Condition · Leave Application Rules cards now use — one surface
    // (border + fill + padding), so the relocated card does not read as a different kind of thing beside them.
    <div className="space-y-2 rounded-lg border border-border bg-background p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">{t('halfDayDeductionTitle')}</span>
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {t('conditionStep.halfDayCompanyWideBadge')}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">{t('halfDayDeductionHelp')}</p>
      <p className="text-xs text-muted-foreground">{t('halfDayDeductionFrozenNote')}</p>
      <form action={setLeaveHalfDayFullDeductionCompaniesAction} className="space-y-2">
        {/* defaultSelected is the CURRENT state, so first render reproduces today's configuration exactly
            and saving an unrelated field on this screen cannot silently rewrite it. */}
        <HalfDayCompanyPicker
          companies={halfDayCompanies.map((c) => ({ value: c.id, label: c.name }))}
          selected={halfDayEnabledCompanyIds}
        />
        {/* Says what an empty selection means, because "no chips" is otherwise indistinguishable from
            "not configured yet" — and here it is a real, saveable decision. */}
        <p className="text-xs text-muted-foreground">{t('halfDayDeductionEmptyNote')}</p>
        <Button type="submit" variant="outline" size="sm">
          {t('save')}
        </Button>
      </form>
    </div>
  );

  // ── Leave Year Configuration records (1e4eb8af) ────────────────────────────────────────────────────
  // Relocated from the retired Application Rules tab into the Custom Settings step of every leave type,
  // joining that type's Leave Year Type override so leave-year decisions are made in ONE place. Same
  // records, same rows, same actions, same dialogs — only the rendering moved (the leave-year actions now
  // redirect back to the Entitlements route; the R64 08bc6841 half-day precedent). The records are
  // TENANT-wide, not per-type, so ONE node is composed here and shared by every panel, and the
  // applies-company-wide badge says out loud that saving here affects every leave type.
  const leaveYearStatusVariant = (status: string) =>
    status === 'open' ? ('success' as const) : status === 'closed' ? ('default' as const) : ('warning' as const);
  // Offer the current year through +6 in the create dropdown; default to the first year with no managed
  // record yet (so repeated "Add" naturally walks forward).
  const configuredYears = new Set(leaveYearConfigs.map((c) => c.year));
  const defaultNewYear = yearOptions.find((y) => !configuredYears.has(y)) ?? currentYear + 1;
  // R45 fd71fa38 — a leave year is deletable only when it is still a DRAFT AND no leave records reference
  // it (the service guard stays authoritative; this only drives the pre-emptive enabled/disabled state and
  // the visible inline reason beside the row).
  const leaveYearRecordYearSet = new Set(leaveYearRecordYears);
  const leaveYearDeletable = (cfg: { year: number; status: string }) =>
    cfg.status === 'draft' && !leaveYearRecordYearSet.has(cfg.year);
  const leaveYearSection = (
    <div className="space-y-1.5 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">{t('leaveYearTitle')}</span>
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {t('conditionStep.halfDayCompanyWideBadge')}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        {t.rich('leaveYearHelp', {
          strong: (chunks) => <span className="font-medium text-foreground">{chunks}</span>,
        })}
      </p>
      <ul className="divide-y divide-border">
        {leaveYearConfigs.length === 0 && (
          <li className="py-4 text-center text-sm text-muted-foreground">{t('noLeaveYears')}</li>
        )}
        {leaveYearConfigs.map((cfg) => (
          <li key={cfg.id} className="flex flex-wrap items-end justify-between gap-4 py-3">
            <div className="flex items-center gap-3">
              <span className="w-14 text-sm font-semibold text-foreground">{cfg.year}</span>
              <Badge variant={leaveYearStatusVariant(cfg.status)}>{t(`leaveYearStatus_${cfg.status}`)}</Badge>
            </div>
            {/* The two control dates, read-only (7903c197) — editing happens in LeaveYearEditDialog so
                nothing saves until Save is pressed inside it. Feedback 4f4d9cff's row order is kept:
                dates, then "Advance Rules" beside the Employee-application-start-date value, then (after
                the justify-between gap) Start / Edit / Delete. */}
            <div className="flex flex-wrap items-end gap-4">
              <div className="w-40">
                <span className="block text-xs font-medium text-muted-foreground">
                  {t('openLeaveYearDateLabel')}
                </span>
                <span className="text-sm text-foreground">{cfg.openLeaveYearDate ?? '—'}</span>
              </div>
              <div className="w-40">
                <span className="block text-xs font-medium text-muted-foreground">
                  {t('employeeApplicationStartDateLabel')}
                </span>
                <span className="text-sm text-foreground">{cfg.employeeApplicationStartDate ?? '—'}</span>
              </div>
              {cfg.status === 'draft' && (
                /* 37088a65 — per-row "Advance Rules" dialog. Draft-only, matching the lifecycle Start
                   button: an ungated trigger would let HR stamp open_leave_year_date onto an open/closed
                   year. The trigger Button is type="button", so it can never submit an adjacent row form. */
                <LeaveYearRuleDialog
                  year={cfg.year}
                  current={{
                    openingRuleEnabled: cfg.openingRuleEnabled,
                    openBeforeAmount: cfg.openBeforeAmount,
                    openBeforeUnit: cfg.openBeforeUnit,
                    openLeaveYearDate: cfg.openLeaveYearDate,
                  }}
                  saveAction={saveFutureOpeningRuleAction}
                />
              )}
            </div>
            {/* Action group, ordered per feedback 4f4d9cff: lifecycle (Start on a draft; Close / Reopen
                keep that slot on open / closed years), then Edit, then Delete last. Draft → Open runs the
                grant sweep; Open → Closed is an informational badge flip (v1); Closed → Draft reopens for
                corrections. */}
            <div className="flex items-end gap-2">
              {cfg.status === 'draft' && (
                <form action={setLeaveYearStatusAction}>
                  <input type="hidden" name="year" value={cfg.year} />
                  <input type="hidden" name="status" value="open" />
                  <Button type="submit" size="sm">
                    {t('openLeaveYear')}
                  </Button>
                </form>
              )}
              {cfg.status === 'open' && (
                <form action={setLeaveYearStatusAction}>
                  <input type="hidden" name="year" value={cfg.year} />
                  <input type="hidden" name="status" value="closed" />
                  <Button type="submit" variant="outline" size="sm">
                    {t('closeLeaveYear')}
                  </Button>
                </form>
              )}
              {cfg.status === 'closed' && (
                <form action={setLeaveYearStatusAction}>
                  <input type="hidden" name="year" value={cfg.year} />
                  <input type="hidden" name="status" value="draft" />
                  <Button type="submit" variant="ghost" size="sm">
                    {t('reopenLeaveYear')}
                  </Button>
                </form>
              )}
              {/* dcd8e32f / 7903c197 — a recognisable EDIT action opening a prefilled pop-up, available on
                  EVERY row whatever its status: HR must stay able to correct dates on an open or closed
                  year. */}
              <LeaveYearEditDialog
                year={cfg.year}
                current={{
                  openLeaveYearDate: cfg.openLeaveYearDate,
                  employeeApplicationStartDate: cfg.employeeApplicationStartDate,
                }}
                saveAction={upsertLeaveYearConfigAction}
              />
              {/* R45 fd71fa38 / f1701466 — Delete is ALWAYS clickable. A blocked row (not draft, or leave
                  records reference the year) renders a plain submit button — clicking posts and the SERVICE
                  guard refuses, its localized message landing in the ErrorBanner + error toast (the message
                  can never drift from the real guard); the inline text stays as a pre-click hint. A
                  deletable row opens the two-step confirm. leaveYearsWithRecords is purely the UX
                  pre-check; a stale render lands on the ErrorBanner with the exact service message. */}
              {leaveYearDeletable(cfg) ? (
                <form action={deleteLeaveYearAction}>
                  <input type="hidden" name="year" value={cfg.year} />
                  <ConfirmSubmit
                    size="sm"
                    variant="ghost"
                    title={t('deleteLeaveYearConfirmTitle')}
                    subtitle={t('deleteLeaveYearTarget', { year: cfg.year })}
                    description={t('deleteLeaveYearConfirmBody')}
                    confirmLabel={t('deleteLeaveYearConfirmButton')}
                    twoStep={{
                      warning: t('deleteLeaveYearWarning'),
                      reasonLegend: t('deleteLeaveYearReasonLegend'),
                      reasonOptions: [
                        { value: 'wrongly_created', label: t('deleteLeaveYearReasonWronglyCreated') },
                        { value: 'duplicate', label: t('deleteLeaveYearReasonDuplicate') },
                      ],
                      name: 'reasons',
                      yesLabel: t('deleteLeaveYearYes'),
                      noLabel: t('deleteLeaveYearNo'),
                    }}
                  >
                    {t('deleteLeaveYear')}
                  </ConfirmSubmit>
                </form>
              ) : (
                <div className="flex items-center gap-2">
                  <form action={deleteLeaveYearAction}>
                    <input type="hidden" name="year" value={cfg.year} />
                    <Button type="submit" variant="ghost" size="sm">
                      {t('deleteLeaveYear')}
                    </Button>
                  </form>
                  <span className="max-w-56 text-xs text-muted-foreground">
                    {cfg.status !== 'draft' ? t('deleteLeaveYearBlockedOpened') : t('deleteLeaveYearBlockedRecords')}
                  </span>
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
      {/* Create / configure an upcoming leave year (year dropdown + two control dates). */}
      <form action={upsertLeaveYearConfigAction} className="flex flex-wrap items-end gap-3 border-t border-border pt-3">
        <Field label={t('yearLabel')}>
          <select name="year" defaultValue={String(defaultNewYear)} className={`${inputCls} w-28`}>
            {yearOptions.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('openLeaveYearDateLabel')}>
          <input type="date" name="openLeaveYearDate" className={`${inputCls} w-44`} />
        </Field>
        <Field label={t('employeeApplicationStartDateLabel')}>
          <input type="date" name="employeeApplicationStartDate" className={`${inputCls} w-44`} />
        </Field>
        <button className={btnPrimary}>{t('addLeaveYear')}</button>
      </form>
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
      {/* 9861b8a4 — THE LIST THE PLAN PROMISED. Allowing a negative balance now unlocks the approval gate,
          but ONLY on a type that also carries a maximum. Types set to Yes with no figure keep behaving
          exactly as they did (approval still refuses below zero), so nothing changed for them — but that
          state is now a decision left half-made, and it must be visible rather than buried inside each
          type's Condition step. Rendered only when the set is non-empty: a permanent empty banner is
          furniture, and furniture stops being read. */}
      {negativeBalanceNeedsLimit.length > 0 && (
        <Card>
          <SectionHeader
            title={t('negativeBalanceNeedsLimitTitle')}
            count={negativeBalanceNeedsLimit.length}
          />
          <div className="space-y-2 px-4 py-3">
            <p className="text-xs text-muted-foreground">{t('negativeBalanceNeedsLimitHelp')}</p>
            <ul className="flex flex-wrap gap-2">
              {negativeBalanceNeedsLimit.map((lt) => (
                <li
                  key={lt.id}
                  className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-foreground"
                >
                  {lt.name}
                </li>
              ))}
            </ul>
          </div>
        </Card>
      )}
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
              // 9816a5ad step 2: the consolidated rules live on the TYPE now, so the Earning Method and
              // Carry Forward sub-steps read and write them here rather than through a policy row.
              // numeric() columns arrive as strings from the driver — Number() them, or the number inputs
              // round-trip a string and the tri-state comparisons in the action misread them.
              typeRules={{
                accrualMethod: lt.accrualMethod ?? null,
                carryForwardEnabled: lt.carryForwardEnabled ?? null,
                carryForwardMax: lt.carryForwardMax == null ? null : Number(lt.carryForwardMax),
                // 7cd914b1: numeric(5,2) — same string-to-number treatment as every other numeric here.
                carryForwardPercent: lt.carryForwardPercent == null ? null : Number(lt.carryForwardPercent),
                carryForwardExpiryMode: (lt.carryForwardExpiryMode as 'date' | 'months' | null) ?? null,
                carryForwardExpiryMonths: lt.carryForwardExpiryMonths ?? null,
                carryForwardExpiryMonth: lt.carryForwardExpiryMonth ?? null,
                carryForwardExpiryDay: lt.carryForwardExpiryDay ?? null,
                carryForwardIncludeEarned: lt.carryForwardIncludeEarned ?? null,
                roundingMethod: (lt.roundingMethod as 'up' | 'down' | 'nearest_half' | null) ?? null,
                // 9f5164d8: numeric(4,3) — same string-to-number treatment as the other numerics above.
                roundingThreshold: lt.roundingThreshold == null ? null : Number(lt.roundingThreshold),
                maxBalanceDays: lt.maxBalanceDays == null ? null : Number(lt.maxBalanceDays),
              }}
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
              maxDaysPerLeaveYear={lt.maxDaysPerLeaveYear == null ? null : Number(lt.maxDaysPerLeaveYear)}
              maxDaysPeriod={lt.maxDaysPeriod ?? null}
              maxConsecutiveDays={lt.maxConsecutiveDays == null ? null : Number(lt.maxConsecutiveDays)}
              maxConsecutiveUnit={
                lt.maxConsecutiveUnit === 'working_days' || lt.maxConsecutiveUnit === 'calendar_days'
                  ? lt.maxConsecutiveUnit
                  : null
              }
              minAdvanceDays={lt.minAdvanceDays ?? null}
              customMessages={(lt.customMessages as Record<string, string> | null) ?? null}
              essViewConfig={(lt.essViewConfig as Record<string, boolean> | null) ?? null}
              formulaExplanations={(lt.formulaExplanations as Record<string, LeaveFormulaEntry> | null) ?? null}
              formulaTemplate={formulaTemplate}
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
              maxNegativeBalance={lt.maxNegativeBalance == null ? null : Number(lt.maxNegativeBalance)}
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
              halfDaySection={halfDaySection}
              leaveYearSection={leaveYearSection}
              previewScenarioSection={previewScenarioSection}
              accrualSection={accrualSection}
              updateTypeAction={updateLeaveTypeAction}
              archiveTypeAction={archiveLeaveTypeAction}
              deleteTypeAction={deleteLeaveTypeAction}
              createPolicyAction={createLeavePoliciesMultiAction}
              updatePolicyAction={updateLeavePolicyAction}
              setTypeRulesAction={setLeaveTypeRulesAction}
              deletePolicyAction={deleteLeavePolicyAction}
              countInScopeAction={countEmployeesInScopeAction}
              upsertSchemeEntitlementAction={upsertSchemeEntitlementAction}
              /* 9816a5ad — Service Based Entitlements now lists BENEFIT SCHEMES per company instead of job
                 grades. Both props are the arrays schemeConfigProps already prepared once at page level, so
                 the sub-step costs no extra query and cannot show a different scheme list than the Benefit
                 Schemes surface beside it. */
              benefitSchemes={schemeConfigProps.schemes}
              gradeGroups={schemeConfigProps.gradeGroups}
              />,
            ]),
          )}
          /* r88 1ef1cf95 — Shared Leave Groups, mounted beside Add Leave Type. It is deliberately NOT scoped
             to the selected leave type: a group spans several types, so scoping it to one would reproduce
             the "configure the shared rule from inside one owner" shape the reporter rejected. The member
             tick list offers every ACTIVE leave type; the at-most-one-group rule is enforced in the database
             and reported by name from the action, never re-derived here. */
          sharedGroups={
            <LeaveSharedGroupConfig
              groups={sharedGroups}
              leaveTypes={activeTypeOptions}
              actions={{
                create: createLeaveSharedGroupAction,
                update: updateLeaveSharedGroupAction,
                remove: deleteLeaveSharedGroupAction,
              }}
            />
          }
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

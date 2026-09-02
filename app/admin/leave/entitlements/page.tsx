import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireAdmin, isGroupAdmin, hasGrantFor, withEffectiveGrants } from '@/lib/authz';
import { listLeaveTypes, listCompanies, listJobGrades } from '@/core/read';
// 4b0e76ae — the Leave Year Configuration section is GONE from Custom Settings, so the two reads that fed
// it (listLeaveYearConfigs / leaveYearsWithRecords) went with it and their services no longer exist. What
// this page still needs from the leave module is the ONE shared entitlement-year range, which the Run
// Earned Accrual selector below and the new /admin/leave/generate page both offer.
import { entitlementYearOptions } from '@/core/leave';
import { ORG_ASSIGNMENT_CRITERIA } from '@/core/leave-org-criteria';
import { leaveFormulaTemplateFrom, type LeaveFormulaEntry } from '@/core/leave-formula';
import { listAllProfileOptions } from '@/core/profile-options';
// e4238594 — the e1a51aea Approval Workflow imports (WorkflowMatrix, the matrix label builder, the
// approval-policy/template reads and the 4e9a4d59 stay-on-this-type action wrappers) all went with the
// sub-step. This page no longer touches approval configuration at all; /admin/leave/approval owns it.
// 6e9a126e release three — `listBenefitSchemes` / `listSchemeEntitlements` are gone from this page with
// the layer they read. f12d77e5 — `listGradeGroups` and the Grade Groups EDITOR have gone from this page
// too, but they MOVED (to Settings → Leave → Approval); they were not deleted. The note at the foot of
// this file says why that distinction is the whole item.
// r88 1ef1cf95 — shared leave groups are tenant-level and read from their own module; they are no longer a
// property of a benefit scheme, so they are no longer read through the benefit-scheme one.
import { listLeaveSharedGroups } from '@/core/leave-shared-group';
import { LeaveSharedGroupConfig } from '@/components/leave-shared-group-config';
import type { LeaveRoundingMethod, RoundingBand } from '@/core/leave-compute';
import { Button, Card, ErrorBanner, Field, PageHeader, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
// 10e96227 — the half-day-deduction card's company picker, behind a CLIENT wrapper. This page is a SERVER
// component, and r123 passed ChipMultiSelect's removeLabelFor/countLabelFor closures straight across the
// boundary, which threw at render and took the whole tab down. The wrapper resolves the translator on the
// client side; only serialisable data crosses. See that file's header before changing this.
import { HalfDayCompanyPicker } from '@/components/leave/half-day-company-picker';
import { LeaveTypePanel, type LeaveEligibilityRule } from '@/components/leave-type-panel';
import { AddLeaveTypeCancel, LeaveTypeWorkspace } from '@/components/leave-type-workspace';
import { EarnedAccrualDialog } from '@/components/leave/earned-accrual-dialog';
// ee6b7c69 — the Entitlement Tables + Employee Eligibility block, defined once beside the standalone screen
// it also serves and mounted here filtered to each panel's own leave type. Reads are loaded ONCE below and
// sliced in memory: this page composes a panel for every leave type, so a block that read for itself would
// cost eleven queries per type.
import {
  EntitlementTablesBlock,
  loadEntitlementTablesData,
} from './templates/entitlement-tables-block';
// r209 — the traffic-light listing. Derived from the SAME page-level `entitlementTablesData` the panels
// below are sliced from, so the card and each type's own Entitlement step can never disagree.
import { leaveConfigHealthAll, tablesReachNobody } from '@/lib/leave-config-health';
import { LeaveConfigHealthCard } from '@/components/leave/leave-config-health';
import {
  archiveLeaveTypeAction,
  setLeaveHalfDayFullDeductionCompaniesAction,
  createLeaveTypeAction,
  deleteLeaveTypeAction,
  setLeaveTypeRulesAction,
  updateLeaveTypeAction,
  // 6e9a126e release three — the policy writes (create / update / delete) and the scheme writes (scheme
  // CRUD, entitlement upsert / delete / copy) went with the tables they wrote, as did
  // countEmployeesInScopeAction's only caller here — the Employee Selection chips on the add-policy form.
  // Who receives an entitlement is now an eligibility rule, counted by countEligibilityTargetsAction on
  // the Entitlement Tables screen. f12d77e5 — the three grade-group writes are no longer imported here
  // either: they are still exported, still called, but from /admin/leave/approval, with their editor.
  // r88 1ef1cf95 — the tenant-level shared-group writes. The scheme-level combined-limit actions (update /
  // delete / move / group-from-drag) are gone with the surface and the tables they wrote.
  createLeaveSharedGroupAction,
  updateLeaveSharedGroupAction,
  deleteLeaveSharedGroupAction,
} from '../../actions';

/**
 * Leave Settings — Entitlements tab.
 *
 * Feedback 9d8cf621 (Entitlements Setting reorganization): the per-leave-type CONFIGURATION panel lives
 * here — "one leave type, one full set of settings", exactly where HR expects it. Each `LeaveTypePanel`
 * carries leave-type identity, eligibility, allowed durations, supporting-document config, backdating limit,
 * advance-notice, expiry and the apply-time custom message. Bulk import is a "+ Import" action button in the
 * page header (e8f2398f). The whole `LeaveTypePanel` + add-type form moved wholesale from the Types tab, so
 * every sub-form keeps its tri-state marker + hidden `name` intact — no column is wiped on save.
 *
 * ⚠️ 6e9a126e RELEASE THREE — THIS PAGE NO LONGER CONFIGURES ENTITLEMENT, AND THAT IS THE POINT.
 * It used to carry three ways to say how many days a leave type grants: the effective-dated per-company /
 * per-grade `leave_policy` timeline (with its multi-company/grade "Employee Selection" chips), the Benefit
 * Schemes workbench, and each scheme's service-tier day table. All three are removed with the tables behind
 * them, together with the Preview Scenario checker that resolved the first of them. The Entitlement step
 * now holds Run Earned Accrual and a link to Entitlement Tables
 * (/admin/leave/entitlements/templates), where a named day table is typed once and an eligibility rule says
 * who receives it. The PageHeader carries the same link plus the read-only Configuration record
 * (/admin/leave/entitlements/archive) — the listing HR retypes the cleared figures from.
 *
 * WHAT THE PAGE STILL OWNS, and what a reader should expect to find: leave TYPE CRUD (the workspace and the
 * Add Leave Type dialog), each type's Condition / Custom Settings steps, the consolidated Earning Method and
 * Carry Forward rules (written to the leave TYPE since 9816a5ad, not to a policy row), Shared Leave Groups,
 * the company-wide Half-Day Deduction card and Run Earned Accrual.
 *
 * f12d77e5 (Remove Grade Groups from the Leave Entitlement framework): Grade Groups are no longer on this
 * page. The card at the bottom MOVED to Settings → Leave → Approval — it was not deleted, and the note
 * where it stood explains why deleting it would have re-routed 205 live approval rules in silence. The
 * Entitlement module is now Entitlement Tables and Employee Eligibility and nothing else, which is what the
 * item asked for; no entitlement figure and no eligibility rule changed.
 *
 * b1b81a08 (Grade relocation): the Grades catalogue is no longer maintained anywhere on this page. Grades
 * are organisation-level master data, so add/edit/archive/delete now lives on Settings → System Labels →
 * Organisation Labels beside Departments and Positions. The grade LIST is still read here — it feeds the
 * Run Earned Accrual selector — and no grade record was copied, renamed or re-created, so every employment,
 * approval rule, claim limit and grade group still points at the same row.
 *
 * 4b0e76ae (Remove Leave Year Configuration): the Leave Year Configuration block is GONE from Custom
 * Settings on every leave type — the year list, the Draft/Open/Closed badge, the Open Leave Year Date, the
 * Employee Application Start Date, Advance Rules, and the Start / Close / Reopen / Edit / Delete / Add
 * buttons, together with the `leaveYearSection` slot, both dialogs and the four writing actions. Generating
 * a year's entitlement — the ONE thing that block did that nothing else could — moved to its own page at
 * /admin/leave/generate in the SAME release, so there is no window in which a leave year cannot be opened.
 * The Run Earned Accrual selector below no longer reads the (now empty, now unwritable) leave_year_config
 * records: it offers the shared computed range, which reaches three years BACK so running earned accrual
 * for a past year stays possible.
 *
 * 962077a8 (Remove Unnecessary Action Buttons): the PageHeader carries no tool buttons. Run Accrual opens
 * ONLY from the Entitlement step, and must not be given a header home again.
 */
export default async function LeaveEntitlementsPage({
  searchParams,
}: {
  // ee6b7c69 — `editTemplate` / `editRule` are the embedded Entitlement Tables' edit state. Kept as SEARCH
  // PARAMS rather than moved into client state: they already work, they survive a reload, and they are the
  // same two params the standalone screen uses, so the one block reads one contract on both mounts.
  searchParams: Promise<{ error?: string; editTemplate?: string; editRule?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.leave');
  // f12d77e5 — the `admin.benefitScheme` translator that headed the Grade Groups card went with the card.
  const { error, editTemplate, editRule } = await searchParams;
  const [types, companies, grades, sharedGroups, profileOptionsActive] =
    await Promise.all([
      listLeaveTypes(s, { includeArchived: true }),
      listCompanies(s),
      // b1b81a08 — grade MANAGEMENT moved to Settings → System Labels → Organisation Labels, but the grade
      // list is still READ here: it feeds the Run Earned Accrual selector. 6e9a126e release three: the
      // leave-policy scope dropdown and the preview dialog that also read it are gone, and f12d77e5 took
      // the Grade Groups membership tick-boxes with the editor — but archived rows still load, because
      // `gradeOptions` filters them out itself and narrowing the query would change what other readers of
      // this list see for no gain.
      listJobGrades(s, { includeArchived: true }),
      // f12d77e5 — `listGradeGroups(s)` STOOD HERE and moved to /admin/leave/approval with its editor. The
      // name came out of the destructure above IN THE SAME EDIT: dropping one without the other silently
      // shifts every later variable by one position and every value on this page is wrong by a slot.
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
  // Active grades — the Run Earned Accrual grade filter. (f12d77e5: the Grade Groups membership tick-boxes
  // were the other reader and they are on the Approval screen now, which builds its own active-grade list.)
  const gradeOptions = grades.filter((g) => !g.archivedAt).map((g) => ({ id: g.id, name: g.name }));
  const companyOptions = companies.map((c) => ({ id: c.id, name: c.name }));
  const effectiveGrants = withEffectiveGrants(s);
  const canGroupWide = isGroupAdmin(effectiveGrants);
  const festiveCompanies = canGroupWide
    ? companyOptions
    : companyOptions.filter((c) => hasGrantFor(effectiveGrants, 'hr_admin', c.id));
  const activeTypeOptions = types.filter((t) => !t.archivedAt).map((t) => ({ id: t.id, name: t.name }));
  // 6e9a126e release three — the Preview Scenario data prep that stood here is GONE with the checker it
  // fed. LeaveRulePreview took the ACTIVE `leave_policy` rows and ran `previewEntitlement` over them, so
  // every figure it could show (the resolved days, the winning policy days) came from a layer this release
  // removes; against the template layer it would have had nothing to resolve and would have answered "—"
  // to every question while still looking like a live checker. It is deleted, not re-pointed — see that
  // component's removal note. The Entitlement Tables screen shows a template's own bands, which is the
  // honest version of the same question.
  // feedback 2c7c6385, re-pointed by 4b0e76ae: the Run-Earned-Accrual Leave-Year selector used to read the
  // managed leave_year_config records (9aa894a4) and fall back to a current-year..+6 range only when none
  // existed. Those records are gone and nothing can write them any more, so the fallback became the ONLY
  // source — and it is now the shared `entitlementYearOptions` range, three years BACK through six forward.
  // The back-reach is the point: the old fallback started at the current year, so a tenant that had 2025
  // configured would have lost the ability to run earned accrual for 2025. The one accepted difference is
  // that the box now opens on the CURRENT year every time rather than on the newest configured record.
  // EarnedLeaveYearOption's `status` is informational only (the card renders just the year), so every
  // computed year carries 'draft' — exactly what the old empty-config fallback already produced.
  const currentYear = new Date().getUTCFullYear();
  const earnedLeaveYears = entitlementYearOptions(currentYear).map((y) => ({ year: y, status: 'draft' }));
  const earnedDefaultYear = currentYear;

  /* 6e9a126e RELEASE THREE — EVERY LINE OF ENTITLEMENT DATA PREP THAT STOOD HERE IS GONE.
   *   - `packEntitlement` (the country pack's day-zero statutory floor) fed each panel's `floor0`, which
   *     existed only to judge the configured figure in the panel header. That figure came from the policy
   *     row; both went, so the floor had nothing left to judge. The statutory minimum belongs beside the
   *     days it warns about, on Entitlement Tables.
   *   - `polByType` unpacked every `leave_policy` row's accrual JSONB (days, service bands, the carry
   *     block, the rounding method) into the panel's editable timeline.
   *   - `schemeNameById` / `schemeCompanyNameById` / `schemeAxesById` / `schemeEntsByType` joined
   *     `scheme_leave_entitlement` rows to their owning scheme's name, company and (grade group ×
   *     employment type) axes for the per-type table and the matrix.
   *   - `schemeConfigProps` was the whole BenefitSchemeConfig workbench's props, prepared once and shared
   *     by every panel.
   * The three tables they read are dropped in this release. Their replacement is not another page-level
   * prep here: it is the Entitlement Tables screen, which loads its own templates and eligibility rules.
   * The grade-group half of `schemeConfigProps` survived release three as `gradeGroupProps`, and the
   * EDITOR has moved twice since: f12d77e5 took it to /admin/leave/approval, and 9a65f808 took it on to
   * Settings → System Labels → Organisation, beside Job Grades. The second move is because the premise of
   * the first stopped holding — a grade group is no longer an approval-routing scope ONLY. This screen's
   * Employee Eligibility rules pick grade groups now, so the two consumers wanted one home between them
   * rather than the editor sitting on either one's screen.
   * None of that brings page-level grade-group data back HERE, which is why nothing was restored above:
   * the rules that pick a group live in the Entitlement Tables block, and that block loads the groups it
   * offers with its own reads, once per page. What a rule stores is still `criteria.gradeIds` — the picker
   * expands the group and no group id is saved (lib/grade-group-coverage.ts). */

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

  // ── Grade MASTER is no longer maintained here (b1b81a08) ─────────────────────────────────────────
  // Grades are organisation-level master data, so their add/edit/archive/delete surface moved to
  // Settings → System Labels → Organisation Labels, beside Departments / Positions / Cost Centres /
  // Business Units. The old Panel A grade catalogue (its fold cookie and the grade→grade-group DRAG
  // shortcut that rode on it) is gone; the tick-box grade-group membership editor in Panel B is the
  // surviving assignment path and is unaffected. Grade GROUPS and Benefit Schemes stay exactly where they
  // are — only the grade list itself moved.

  // ── Entitlement-step slots ───────────────────────────────────────────────────────────────────────
  // 6e9a126e release three: `previewScenarioSection` is gone with LeaveRulePreviewDialog (see the data-prep
  // note above). What the step mounts now is the Entitlement Tables themselves plus Run Accrual — one
  // shared node each, composed here on the server and handed to every panel as a slot.
  //
  // ⚠️ ee6b7c69 — THE POINTER BECAME THE THING IT POINTED AT. Until this item the step held a caption and
  // an "Open Entitlement tables" link to a second screen, because release three had moved every entitlement
  // control off this page. The reporter's complaint was exactly that: entitlement is not set where
  // entitlement is configured. So the tables are now IN the step, filtered to the type being configured,
  // and the link is gone with the `entitlementStep.tablesOpen` key that labelled it. The standalone screen
  // survives and is still linked from this page's header — it is the only place all 24 types can be read
  // side by side — but it is no longer where day-to-day configuration happens.
  //
  // ⚠️ ELEVEN READS, ONCE, FOR THE WHOLE PAGE. `loadEntitlementTablesData` is called here and its result
  // is SLICED per type inside the block. `panels` below composes an entry for every leave type (they are
  // props of a client workspace, so all of them render), and a block that loaded for itself would turn
  // eleven queries into eleven times the number of leave types — 264 on this tenant, for a screen showing
  // one type's tables.
  const entitlementTablesData = await loadEntitlementTablesData(s);
  /**
   * r209 — EVERY LEAVE TYPE'S ANSWER TO "WHY IS THE BALANCE 0.00", ON ONE CARD.
   *
   * The reporter listed nine leave types showing 0.00 and expected one answer; there were three, and every
   * one of them was already recorded and shown nowhere — `accrual_method` NULL on five types (with
   * `accrual_unconfigured` stamped 2026-08-04 and read by no surface), two types with no entitlement table
   * at all, and a single tenant-wide eligibility rule whose `valid_to` was 2026-08-13. This card is the
   * "see all of them at a glance instead of opening each one" the approved plan asks for; the same
   * derivation renders inside each type's Entitlement step beside the tables it is about.
   *
   * Costs nothing new: `entitlementTablesData` is already loaded above for the panels.
   */
  const configHealth = leaveConfigHealthAll({
    leaveTypes: entitlementTablesData.leaveTypes,
    templates: entitlementTablesData.templates,
    rules: entitlementTablesData.rules,
    grades: entitlementTablesData.activeGrades,
    today: entitlementTablesData.today,
  });
  /** The step's own Entitlement Tables, scoped to one type. Per type — the ONE thing on this page that
   *  legitimately cannot be a single shared node, because the filter IS the item. */
  const entitlementTablesSectionFor = (leaveTypeId: string) => (
    <div className="space-y-1.5">
      <p className="text-xs text-muted-foreground">{t('entitlementStep.tablesHint')}</p>
      <EntitlementTablesBlock
        data={entitlementTablesData}
        leaveTypeId={leaveTypeId}
        editTemplate={editTemplate}
        editRule={editRule}
      />
    </div>
  );
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
          <div className="flex items-center gap-3">
            {/* 6e9a126e RELEASE TWO — the reporter's new two-step entitlement setup (a named day table,
                then who gets it). Reached FROM this screen for the same reason the record below is: while
                both layers are live, the entry point belongs beside the old one rather than replacing a
                sidebar row that still leads somewhere real. */}
            <Link href="/admin/leave/entitlements/templates" className="text-sm underline">
              {t('entitlementTablesAction')}
            </Link>
            {/* 6e9a126e — the read-only record of everything the entitlement redesign's release three
                clears. Reachable FROM this screen, as the approved plan says, and deliberately NOT in the
                sidebar: it is a reference document for a migration in progress, not a place anyone works. */}
            <Link href="/admin/leave/entitlements/archive" className="text-sm underline">
              {t('configurationRecordAction')}
            </Link>
            {/* c8052ae3 — the record of the Medical / Hospitalization balance rows the one-off correction
                removes. Beside the configuration record for the same reason that one sits here: both are
                reference documents about a correction in progress, reached from the screen the correction
                is about, and neither belongs in the sidebar. Rendered unconditionally: an empty record
                renders its own "nothing recorded yet" card, and a link that appears only once rows exist
                is a link nobody knows to look for. */}
            <Link href="/admin/leave/entitlements/ledger-archive" className="text-sm underline">
              {t('balanceRecordAction')}
            </Link>
            {/* r242 — THE WAY IN THE REPORTER WENT LOOKING FOR. The Leave Inquiry surface (Employee
                Details / Employee Balances / Employee Leave Record) lives under Leave, and an HR admin
                who wants to look one person's balances up came here, to Leave Config, and found nothing
                pointing at it. This link is the whole of that fix: it opens Employee Balances, whose own
                left-hand rail carries the other two tabs, so one link reaches all three.
                THE ADDRESS IS UNCHANGED ON PURPOSE — 388e53c2 moved the entry point and nothing else,
                precisely so saved links and the export links already in circulation stay valid. This adds
                a second door; it does not move the room. */}
            <Link href="/leave/employee-balances" className="text-sm underline">
              {t('employeeBalancesAction')}
            </Link>
            <Link href="/admin/leave/import" className={btnPrimary}>
              {t('importAction')}
            </Link>
          </div>
        }
      />
      <ErrorBanner message={error} />

      {/* r209 — above the leave-type workspace on purpose: it answers "which of these can produce a balance
          at all", and every panel below assumes that question has already been asked. */}
      <LeaveConfigHealthCard rows={configHealth} />

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
            /* r224 — WHICH LEAVE TYPES ARE NOT REACHING ANYBODY, ON THE LIST YOU PICK THEM FROM.
               `tablesReachNobody` is the r209 finding this page already renders on the card below, read
               rather than recomputed: the badge and the card are one derivation, so the list cannot flag a
               type the card calls healthy. Archived types resolve to no health row and so carry no badge —
               `leaveConfigHealthAll` excludes them deliberately (a permanent red row nobody can clear is
               how a signal stops being read). */
            alert: configHealth.some((h) => h.leaveTypeId === lt.id && tablesReachNobody(h))
              ? t('workspaceReachesNobody')
              : null,
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
              // 4fdb69b2 — what a delete would cascade, by name, for the confirmation. Both come straight
              // from listLeaveTypes; the driver returns a Postgres text[] as a JS array, and the projection
              // coalesces to '{}' so these are never null.
              cascadeApprovalRules={lt.cascadeApprovalRules ?? []}
              cascadeBalanceSourceOf={lt.cascadeBalanceSourceOf ?? []}
              isAnnual={lt.code === 'ANNUAL'}
              // 9816a5ad step 2: the consolidated rules live on the TYPE now, so the Earning Method and
              // Carry Forward sub-steps read and write them here rather than through a policy row.
              // numeric() columns arrive as strings from the driver — Number() them, or the number inputs
              // round-trip a string and the tri-state comparisons in the action misread them.
              typeRules={{
                accrualMethod: lt.accrualMethod ?? null,
                // bc36c768: the credit day, and the NOT-CONFIGURED marker as an ISO STRING. A Date would
                // very likely survive the boundary, but "very likely" is not the standard this file is
                // held to since r123 shipped an unserialisable prop to production — a plain string is
                // unambiguous, and the panel only ever asks whether it is null.
                accrualDay: lt.accrualDay ?? null,
                accrualUnconfigured: lt.accrualUnconfigured ? lt.accrualUnconfigured.toISOString() : null,
                carryForwardEnabled: lt.carryForwardEnabled ?? null,
                carryForwardMax: lt.carryForwardMax == null ? null : Number(lt.carryForwardMax),
                // 7cd914b1: numeric(5,2) — same string-to-number treatment as every other numeric here.
                carryForwardPercent: lt.carryForwardPercent == null ? null : Number(lt.carryForwardPercent),
                carryForwardExpiryMode: (lt.carryForwardExpiryMode as 'date' | 'months' | null) ?? null,
                carryForwardExpiryMonths: lt.carryForwardExpiryMonths ?? null,
                carryForwardExpiryMonth: lt.carryForwardExpiryMonth ?? null,
                carryForwardExpiryDay: lt.carryForwardExpiryDay ?? null,
                carryForwardIncludeEarned: lt.carryForwardIncludeEarned ?? null,
                roundingMethod: (lt.roundingMethod as LeaveRoundingMethod | null) ?? null,
                // 9f5164d8: numeric(4,3) — same string-to-number treatment as the other numerics above.
                roundingThreshold: lt.roundingThreshold == null ? null : Number(lt.roundingThreshold),
                // 8fec719e: jsonb — passed through as a SERIALISABLE value (a plain array of plain
                // objects), which is the only kind of prop a server component may hand a client one. The
                // panel validates the shape itself; a malformed stored table renders as an empty editor
                // rather than throwing on the server.
                roundingBands: (lt.roundingBands as RoundingBand[] | null) ?? null,
                maxBalanceDays: lt.maxBalanceDays == null ? null : Number(lt.maxBalanceDays),
              }}
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
              // 7daac043: narrowed to the closed vocabulary here (the column is plain TEXT + a DB CHECK), so
              // the client panel receives the union it declares and never has to guess at a stray value.
              minAdvanceDayType={
                lt.minAdvanceDayType === 'working_days' || lt.minAdvanceDayType === 'calendar_days'
                  ? lt.minAdvanceDayType
                  : null
              }
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
              // 5ff7daff: the role marker (already on listLeaveTypes since 65f466e2) so the placement select
              // resolves its default the same way the employee's Leave tab does.
              role={lt.role ?? null}
              counting={lt.counting ?? 'working_days'}
              perDateApproval={lt.perDateApproval ?? false}
              duplicateApplicationPolicy={lt.duplicateApplicationPolicy ?? null}
              // Override Leave Application (56910869): a plain array of plain objects — serialisable, so it
              // may cross the server→client boundary (test/server-client-boundary.test.ts).
              overrideRules={lt.overrideRules ?? null}
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
              /* 6e9a126e release three — the entitlement props this panel used to receive are gone with the
                 surfaces they fed: `policies` (the leave_policy timeline), `schemeEntitlements` /
                 `benefitSchemes` / `gradeGroups` (the scheme tables), `benefitSchemeSection` (the workbench
                 slot), `previewScenarioSection`, `floor0`, the three policy write actions,
                 `upsertSchemeEntitlementAction`, and `countInScopeAction` / `grades` / `companies`, which
                 existed only for the add-policy form's Employee Selection chips. */
              halfDaySection={halfDaySection}
              accrualSection={accrualSection}
              entitlementTablesSection={entitlementTablesSectionFor(lt.id)}
              updateTypeAction={updateLeaveTypeAction}
              archiveTypeAction={archiveLeaveTypeAction}
              deleteTypeAction={deleteLeaveTypeAction}
              setTypeRulesAction={setLeaveTypeRulesAction}
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

      {/* ── f12d77e5 — THE GRADE GROUPS CARD STOOD HERE AND IS NOW ON /admin/leave/approval ──────────
          The reporter asked for Grade Groups to be out of the Leave Entitlement framework, and they are:
          nothing on this page reads a grade group, and nothing in `core/entitlement-template.ts` or
          `core/org-criteria.ts` ever did — an entitlement eligibility rule scopes by individual `gradeIds`,
          never by a GROUP. Release three already severed the backend half of the request.

          IT IS A MOVE, NOT A DELETE, AND THAT DISTINCTION IS THE WHOLE ITEM. 205 of the tenant's 261
          `leave_approval_policy` rows carry a non-null `grade_group_id`, and
          core/leave-approval-policy.ts treats a NULL group as a WILDCARD rather than a non-match — so
          clearing the groups would not clear those rules, it would silently widen each one from the grades
          it names to EVERY employee, with no error and nothing on screen to say so. Leave would start
          routing to the wrong approvers. (core/benefit-scheme.ts's `deleteGradeGroup` refuses while any
          rule points at a group, which is the guard that keeps that from happening one group at a time.)

          The card was only ever here by accident: the editor lived inside the deleted BenefitSchemeConfig
          workbench and was parked on the nearest surviving page so the 205 rules would not point at groups
          nobody could create or re-staff. Its real home is the screen that uses it. */}
    </div>
  );
}

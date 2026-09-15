import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { listLeaveTypes, listCompanies } from '@/core/read';
import { ORG_ASSIGNMENT_CRITERIA } from '@/core/leave-org-criteria';
// r288 (686dc512) — THE TWO CONSTANTS THE EARNED SWEEP IS ACTUALLY DECIDED ON, read from the engine that
// decides it. Before this round nothing under app/ or messages/ referenced either, which is precisely the
// gap the item closes: this screen would accept an earned method on a code `accrueEarnedLeave` can never
// reach and say nothing at all. Imported here, on the SERVER, and handed across as plain data — the
// editor is a client island and the engine module pulls the database in.
import { EARNED_METHODS, STANDING_LEAVE_CODES } from '@/core/leave';
import { leaveFormulaTemplateFrom, type LeaveFormulaEntry } from '@/core/leave-formula';
import { listAllProfileOptions } from '@/core/profile-options';
import { listLeaveSharedGroups } from '@/core/leave-shared-group';
import type { LeaveRoundingMethod, RoundingBand } from '@/core/leave-compute';
import { Card, ErrorBanner, Field, PageHeader, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { AddLeaveTypeCancel, LeaveTypeWorkspace } from '@/components/leave-type-workspace';
import { LeaveSharedGroupConfig } from '@/components/leave-shared-group-config';
import {
  EntitlementTablesBlock,
  loadEntitlementTablesData,
} from '../../leave/entitlements/templates/entitlement-tables-block';
// r279 (3fbf7a02) — the health CARD's import LEFT WITH ITS MOUNT (see the note where it was rendered):
// the full listing is its own page now. Its component name is not written here, because four guards grep
// this file for that specifier to prove the mount is gone. `leaveConfigHealthAll` and `tablesReachNobody`
// stay, because the rail's per-type badge below still reads that derivation.
import { leaveConfigHealthAll, tablesReachNobody } from '@/lib/leave-config-health';
import { LeaveConfigMap, leaveConfigPageHeader, leaveConfigScreenHref } from '@/components/leave-config-map';
import { LeaveTypeApprovalReadout, loadLeaveTypeApprovalReadout } from '../approval-readout';
import { LeaveTypeTabs, type LeaveTypeTabsData } from './leave-type-tabs';
import {
  archiveLeaveTypeAction,
  createLeaveSharedGroupAction,
  createLeaveTypeAction,
  deleteLeaveSharedGroupAction,
  deleteLeaveTypeAction,
  setLeaveTypeRulesAction,
  updateLeaveSharedGroupAction,
  updateLeaveTypeAction,
} from '../../actions';

/**
 * a6fe37fc — LEAVE TYPES (`/admin/leave-config/types`). The screen this whole item is about.
 *
 * ⚠️ ROUND 5 (cutover) HAS HAPPENED: this IS the screen, and the one it replaced is GONE.
 * `app/admin/leave/entitlements/page.tsx` (731 lines) is an unguarded redirect stub pointing here and
 * `components/leave-type-panel.tsx` (3,367 lines) was DELETED with it — the four steps, the two
 * `SubStepBar` mountings and the six sub-step keys IA §1.2 names as the real subject of the complaint.
 * The leaveConfig screen key's canonical `href`, the sidebar fly-out's first row, the area map's
 * `leaveTypes` entry and the `ENTITLEMENTS` redirect constant all name this address now; the KEY itself
 * is untouched, so no tenant's stored grant for the area was dropped.
 *
 * WHAT IS DIFFERENT, and it is the whole item: the four steps and six sub-steps of the old panel are
 * FIVE TABS in the order the decisions are made — what the leave type is · who is eligible · what they
 * are entitled to · how it is applied for · who approves it (IA §2). Two settings move onto the type
 * because that is what they are: *Send to payroll module* from Payroll impact (tab 1) and *Per-date
 * approval* from General setting (tab 5). Both were editable in two places through Rounds 2–4, which was
 * the deliberate price of "something works at every point"; the cutover closes that window — *Per-date
 * approval* with this commit, *Send to payroll module* with Payroll impact's own.
 *
 * ⚠️ THE LEFT RAIL IS RE-CREATED, NOT DROPPED. It is the only way to choose a leave type, and the first
 * draft of this item's mockup quietly removed it. It is the SAME `LeaveTypeWorkspace` the old screen
 * mounts — one component, two mount points (IA §2.3's rule), not a second implementation to drift.
 *
 * ⚠️ A SAVE MADE HERE LANDS HERE, ANCHOR AND ALL. Round 2's rule 2 still holds — no server action
 * changed signature and no new action was written — and what the cutover changed is only where they
 * RETURN: `ENTITLEMENTS` (app/admin/_redirects.ts) names this address, so `okEntitlements` /
 * `failEntitlements` land back on the exact leave type that was being configured. That constant HAD to
 * move rather than lean on the stub: those two helpers carry a `#type-<id>` fragment, and a fragment is
 * never sent to the server, so a save routed through a redirect would arrive with nothing selected. The
 * Rounds 2–4 preview note came off in the same commit.
 *
 * ⚠️ TWO PAGE-LEVEL SURFACES IA §3.1's TABLE NEVER LISTED, AND THIS SCREEN NEARLY LOST (r258 fix pass).
 * Both landed BEFORE the design's baseline (main@0c01befc) and the 32-function table was written without
 * them, so the anti-drop guard — which is keyed to that table — could not see them go. They are carried
 * here and the table now lists them as F47 / F48:
 *   · the Employee Balances link (r242 3a3f5a2d), the way in the reporter went looking for;
 *   · the "allowing a negative balance with no limit" list (r126 9861b8a4).
 * The area map and the tour anchor came across with them, for the reasons at their sites below.
 *
 * WHAT IS NOT HERE, and where it IS (IA §3.1, none of it dropped):
 *   · the company-wide Half-Day Deduction card is a COMPANY rule, not a property of a leave type —
 *     which is why it used to be drawn once per leave type. It went to Company rules at the cutover and
 *     to the Special Setting row at the reporter's request (r281, a73d1e14).
 *
 * ⚠️ WHAT CAME BACK, AND WHY IT IS DRAWN WHERE IT IS (r281, cdd7500b). SHARED LEAVE GROUPS is on this
 * screen again, at PAGE level, above the per-type workspace. It was taken off this screen at the cutover
 * because it sat INSIDE that workspace, where it read as a property of the selected leave type while a
 * group spans several; the reporter has since asked for it back here, and that reasoning decides the
 * mount POINT rather than the answer. Page level, not inside the workspace. The three actions moved with
 * it unchanged and return to this screen.
 *   · tab 5's read-only chain read-out is here, and the chain EDITOR is Approval chains.
 */
export default async function LeaveConfigTypesPage({
  searchParams,
}: {
  /** `editTemplate` / `editRule` are the embedded Entitlement Tables' edit state — the same two params
   *  the standalone screen uses, so the one shared block reads one contract on every mount. */
  searchParams: Promise<{ error?: string; editTemplate?: string; editRule?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.leave');
  // r281 (cdd7500b) — the shared-group card's own strings, read where the card is drawn.
  const tGroup = await getTranslations('admin.leave.sharedGroup');
  const { error, editTemplate, editRule } = await searchParams;
  const header = await leaveConfigPageHeader('leaveTypes');

  // 10b59703 — the job-grade list LEFT this read with Run earned accrual, whose scope selector was its
  // only consumer here; Generate Entitlement reads it for the dialog now (generate/page.tsx).
  const [types, companies, profileOptionsActive, sharedGroups] = await Promise.all([
    listLeaveTypes(s, { includeArchived: true }),
    listCompanies(s),
    // The ACTIVE picker values for the eight org fields come from the SAME master list the profile
    // Organisation Assignment screen reads, so deleted/inactive values are never offered as new choices.
    listAllProfileOptions(s, { activeOnly: true }),
    // r281 (cdd7500b) — the shared-group catalogue, for the page-level section below.
    listLeaveSharedGroups(s),
  ]);
  // r281 (cdd7500b) — DERIVED FROM THE READ THIS PAGE ALREADY MAKES, never read again. `types` is every
  // leave type including the archived ones (the workspace rail lists both), and the group's member tick
  // list offers only the ACTIVE ones — the same set `listLeaveTypes(s, { includeArchived: false })` would
  // return. Calling that a second time would be a second derivation of "active leave types", which is the
  // drift this repo keeps paying for.
  const activeTypeOptions = types.filter((lt) => !lt.archivedAt).map((lt) => ({ id: lt.id, name: lt.name }));

  /**
   * r288 (686dc512) — THE THREE TYPE NAMES THE EARNED SWEEP ACTUALLY COVERS, READ FROM THIS TENANT'S OWN
   * ROWS.
   *
   * ⚠️ NOT HARDCODED, and that is the load-bearing part. The three standing CODES are fixed; the NAMES
   * against them are whatever the tenant typed. The account that raised this holds two leave types both
   * called some variant of Annual Leave, so "Annual Leave is not accrued here" would be a riddle on the
   * very account it was written for. The engine's own `type_not_swept` empty state re-reads the rows for
   * the same reason, with this same filter (standing code AND not archived) and this same A–Z order.
   *
   * DERIVED FROM THE READ THIS PAGE ALREADY MAKES — `types` is every leave type including the archived
   * ones — so the warning below costs no query. The archived ones are excluded because the sweep excludes
   * them: an archived ANNUAL is not something the run reaches either. On the reporting account that
   * leaves this list EMPTY, which is true and has a sentence of its own.
   */
  const standingCodes = new Set<string>([...STANDING_LEAVE_CODES]);
  const sweptTypeNames = types
    .filter((lt) => standingCodes.has(lt.code) && !lt.archivedAt)
    .map((lt) => lt.name)
    .sort((a, b) => a.localeCompare(b));
  /** The engine's earned-method family, handed over verbatim rather than respelled in the editor. */
  const earnedMethods = [...EARNED_METHODS];

  // One page-level prep — no N+1 per type.
  const orgAssignmentOptions = Object.fromEntries(
    ORG_ASSIGNMENT_CRITERIA.map((c) => [
      c.category,
      (profileOptionsActive[c.category] ?? []).map((o) => ({ value: o.value, label: o.label })),
    ]),
  );
  // The wording template a not-yet-configured leave type is PRE-FILLED from — the first type that
  // already carries an Employee Leave View Configuration. Read-side only: it fills FORM DEFAULTS.
  const formulaTemplate = leaveFormulaTemplateFrom(
    types.map((lt) => lt.formulaExplanations as Record<string, LeaveFormulaEntry> | null),
  );
  const companyOptions = companies.map((c) => ({ id: c.id, name: c.name }));

  // ⚠️ ELEVEN READS, ONCE, FOR THE WHOLE PAGE. The result is SLICED per type inside the block; a block
  // that loaded for itself would turn eleven queries into eleven times the number of leave types.
  const entitlementTablesData = await loadEntitlementTablesData(s);
  /**
   * r270 fix pass — WHICH leave type the edit link is actually for.
   *
   * `openTab` first shipped as `editRule || editTemplate ? 'entitlement' : undefined` passed to EVERY
   * panel, so arriving by one link also forced tab 3 on every OTHER leave type and made each of them
   * ignore its own stored tab for that page load. Found by the r270 verify pass.
   *
   * The server can tell exactly which type is meant: `editTemplate` is a table lineage, which carries a
   * `leaveTypeId`; `editRule` is a scheme lineage, which names a table lineage, which carries one. A
   * parameter naming something that no longer exists resolves to null and every panel keeps its own tab,
   * which is the right answer for a stale bookmark.
   */
  const editTargetLeaveTypeId = (() => {
    const byLineage = new Map(entitlementTablesData.templates.map((t) => [t.lineageId, t.leaveTypeId]));
    if (editTemplate) return byLineage.get(editTemplate) ?? null;
    if (editRule) {
      const rule = entitlementTablesData.rules.find((r) => r.lineageId === editRule);
      return rule ? (byLineage.get(rule.templateLineageId) ?? null) : null;
    }
    return null;
  })();
  // The traffic-light listing, derived from the SAME data the tabs below are sliced from, so the card
  // and each type's own tab 3 can never disagree (IA §3.1 F2 — one derivation, two places).
  const configHealth = leaveConfigHealthAll({
    leaveTypes: entitlementTablesData.leaveTypes,
    templates: entitlementTablesData.templates,
    rules: entitlementTablesData.rules,
    grades: entitlementTablesData.activeGrades,
    today: entitlementTablesData.today,
  });
  // r126 9861b8a4 — CARRIED FROM THE OLD SCREEN (r258 fix pass). Leave types set to allow a negative
  // balance with NO floor: the approval permission the switch unlocks is not active on them, so the
  // decision is left half-made and must be visible rather than buried inside each type's tab 3. It was
  // absent from IA §3.1's function table (it landed before the design's baseline, main@0c01befc), which
  // is why the anti-drop guard could not see it going missing; §3.1 now lists it as F48.
  // The predicate is the old screen's, character for character — one reading, two screens, until Round 5
  // deletes the old one.
  const negativeBalanceNeedsLimit = types.filter(
    (lt) => lt.allowNegativeBalance === true && lt.maxNegativeBalance == null && !lt.archivedAt,
  );
  /** Tab 3's Entitlement Tables, scoped to one type — the ONE node on this page that legitimately
   *  cannot be shared, because the filter IS the item. */
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
  /**
   * a6fe37fc ROUND 4 — TAB 5's READ-OUT, PREPARED ONCE FOR THE WHOLE PAGE.
   *
   * `loadLeaveTypeApprovalReadout` reads the tenant's active approval rules and templates in ONE
   * `loadApprovalRuleSet` call plus one escalation read per company; every leave type's answer is then
   * `decideApproval` over that set, in memory, with no I/O. A per-type read would turn this into
   * `types × companies × 2` queries on a single render — which is the exact cost the approval replay's
   * fix pass removed from the resolver (core/leave-approval-policy.ts's `ApprovalRuleSet` note).
   */
  const approvalReadout = await loadLeaveTypeApprovalReadout(s, companyOptions);
  /**
   * 10b59703 — RUN EARNED ACCRUAL LEFT THIS TAB. It runs a calculation across employees, so by the
   * reporter's rule for that round it sits with the other run actions rather than inside a leave type's
   * configuration. R64 (7b945408 + 962077a8) had tucked it in here at the reporter's earlier request;
   * the plan says so and offers reject-and-say-so. What stays in the slot is a one-line pointer,
   * resolved through the map so it and the submenu cannot disagree about where the tool is.
   * Server-composed, like every other slot: a plain rendered node crosses the boundary.
   *
   * r281 (09386e29) — THE POINTER'S TARGET MOVED WITH THE TOOL, AND THE SENTENCE MOVED WITH THE TARGET.
   * The tool is a fly-out row and a page of its own now (it was filed under Generate Entitlement, the one
   * operation it must not be confused with). Repointing the href alone would have left a caption reading
   * "…is under Generate Entitlement" while opening somewhere else — the r270 defect, arriving by the
   * fix's own door — so `accrualMovedPointer` was reworded in all six catalogues in the same commit. It
   * no longer names a parent screen at all, because the menu now carries the tool's own name: a pointer
   * that names a location is a second signpost to keep in step, and this one has already gone stale once.
   */
  const accrualPointer = (
    <p className="border-t border-border pt-3 text-xs text-muted-foreground">
      <Link href={leaveConfigScreenHref('earnedAccrual')} className="font-medium text-primary hover:underline">
        {t('entitlementStep.accrualMovedPointer')} →
      </Link>
    </p>
  );

  // The rail's order is decided here, on the server, so the desktop list and the mobile dropdown (one
  // `items` prop) get one ordering: active types first, then archived, each A–Z case-insensitively.
  const workspaceItems = [...types].sort(
    (a, b) =>
      Number(!!a.archivedAt) - Number(!!b.archivedAt) ||
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  );

  return (
    <div className="space-y-6">
      <PageHeader
        // 10b59703 — the heading is the SUBMENU ROW that opened this page ("Entitlements"), and the
        // description is the row's, read through the one helper every Leave Config page uses
        // (components/leave-config-map.tsx). The map item label ("Leave types") is the TAB below.
        title={header.title}
        description={header.description}
        // 5ca446db (r269) — THE HEADER HAS NO `actions` SLOT AT ALL, and the last thing in it was
        // DELIBERATELY REMOVED, not lost.
        //
        // 10b59703 stripped IA §3.1 F5's three header links (Entitlement tables · Configuration record ·
        // Balance record) and the + Import button, keeping the ONE link that left Leave Config —
        // r242 3a3f5a2d's Employee Balances (F47): an underlined Link at the inquiry screen's address,
        // captioned from its own action key under this page's admin.leave namespace. (Neither the href nor
        // the key is quoted here, because the guards on this page grep the SOURCE and a quoted specifier in
        // a comment reads as code — CLAUDE.md §8.) That link is gone now because the reporter asked for the
        // thing it was standing in for: a permanent "Employee Leave Inquiry" row in the Leave Config
        // fly-out (packs/leave/index.ts LEAVE_ADMIN_NAV, last child), which opens the same address.
        //
        // F47'S PROPERTY IS NOT DROPPED — IT IS STRENGTHENED, and that is the only reason removing the
        // link is safe. F47 exists because "an HR admin looking one person's balances up came to Leave
        // Config and found nothing pointing at Leave Inquiry"; a menu row present on every Leave Config
        // screen serves that strictly better than one underlined link on this one page. The three guards
        // that pinned the link (test/r266-leave-config-rows, test/leave-config-types-tabs,
        // test/entitlement-header-actions-removal) were REWRITTEN to assert the row, not deleted, and the
        // caption key under admin.leave was pruned in all six catalogues with its only reader.
        //
        // PageHeader renders nothing when `actions` is absent (components/ui.tsx), so there is no empty
        // wrapper left behind. The address itself is untouched: no route moved, no bookmark broke.
      />
      {/* 10b59703 — the page's own tab row (Leave types · Entitlement tables · Configuration record),
          rendered by the same component that used to draw the nine-screen pill row on every page. The
          left submenu is the only way BETWEEN rows now; this row only moves within Entitlements.
          `current="leaveTypes"` because this IS that tab. */}
      <LeaveConfigMap current="leaveTypes" />
      <ErrorBanner message={error} />

      {/* r279 (3fbf7a02) — THE PAGE-LEVEL LEAVE BALANCE HEALTH CARD STOOD HERE, above the workspace,
          under a comment reading "it answers 'which of these can produce a balance at all', and every
          tab below assumes that question has already been asked". It is DELIBERATELY GONE,

          ⚠️ AND ITS COMPONENT NAME IS NOT SPELLED OUT ANYWHERE IN THIS FILE, deliberately: four guards
          grep this source for that specifier to prove the mount is gone (r209, r270, r266's tabs file
          and r279's own), and a quoted specifier in a comment reads to them as code — CLAUDE.md §8's
          "reword a quoted specifier" rule, learned the same way the pack drift ratchet learned it.
          and it moved rather than went away: Leave Balance Health is its own fly-out row and its own
          page now (`/admin/leave-config/balance-health`). The reporter's complaint was that the one
          screen explaining why a balance reads 0.00 was named nowhere in the menu and could only be
          found by already knowing it was there and scrolling this tab.

          ONE PLACE, NOT TWO: the card is not left here as well, because two copies of one list drift
          apart the moment either is improved — and the sentence above was the argument for it being on
          THIS tab, which is exactly the argument that no longer holds once it has an address.

          ⚠️ `configHealth` IS STILL DERIVED ON THIS PAGE and must be: the leave-type rail below reads it
          for the per-type "reaches nobody" badge (`tablesReachNobody`), and the per-type
          `LeaveConfigHealthNotice` inside each type's Entitlements tab is the scoped arm of the ternary
          in the shared tables block. Both are the warning shown BESIDE the thing it is about, which is
          the half of r209 that deliberately did not move. */}

      {/* ── F3 · Shared leave groups ───────────────────────────────────────────────────────────────────
          r281 (cdd7500b) — BACK ON THIS SCREEN, AND AT PAGE LEVEL, WHICH IS THE WHOLE DISTINCTION.

          The reporter asked for Shared Leave Groups to sit under Leave types rather than under Company
          rules, because a shared group is about leave types. That reading is right. The history that
          matters is not WHETHER it belongs here but WHERE on this screen: it used to sit inside the
          per-leave-type workspace, beside Add Leave Type, where it read as a property of whichever type
          you happened to have selected — and a group spans several types at once, which is exactly the
          shape r88 took it OUT of Benefit Schemes to avoid. So that reasoning is not reversed by this
          move; it is what decides the mount point. The card is drawn HERE, at page level, ABOVE the
          per-type workspace and outside it, so it still reads as a tenant-wide catalogue rather than as a
          setting on the selected type. A page-level section in this slot is a known shape: the
          traffic-light health listing was mounted exactly here until r279 gave it a row of its own.

          The member tick list offers every ACTIVE leave type, derived from the read this page already
          makes. The at-most-one-group-per-type rule is enforced in the DATABASE (unique on
          (tenant, leave_type), migration 0342) and reported by name from the action, never re-derived on
          screen — which is why moving the screen cannot weaken it. */}
      <Card>
        <SectionHeader title={tGroup('title')} count={sharedGroups.length} />
        <div className="space-y-3 px-4 py-3">
          <p className="text-xs text-muted-foreground">{tGroup('help')}</p>
          <div className="max-w-xs">
            <LeaveSharedGroupConfig
              groups={sharedGroups}
              leaveTypes={activeTypeOptions}
              actions={{
                create: createLeaveSharedGroupAction,
                update: updateLeaveSharedGroupAction,
                remove: deleteLeaveSharedGroupAction,
              }}
            />
          </div>
        </div>
      </Card>

      {/* r126 9861b8a4 — THE LIST THE PLAN PROMISED, CARRIED ACROSS (r258 fix pass). Rendered only when the
          set is non-empty: a permanent empty banner is furniture, and furniture stops being read. */}
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

      {/* `data-tour="leave-config"` is the onboarding tour's anchor for the leave-config step
          (lib/module-tours.json → leave · config). Its `route` still names the OLD address, so the step
          still runs there; carrying the anchor means Round 5 repoints one route string and the tour keeps
          working, instead of a tour step that silently finds nothing. */}
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
            // The r209 finding READ rather than recomputed, so the badge and the card are one derivation.
            alert: configHealth.some((h) => h.leaveTypeId === lt.id && tablesReachNobody(h))
              ? t('workspaceReachesNobody')
              : null,
          }))}
          panels={Object.fromEntries(
            types.map((lt) => {
              const data: LeaveTypeTabsData = {
                id: lt.id,
                name: lt.name,
                code: lt.code,
                description: lt.description ?? null,
                paid: lt.paid,
                archived: !!lt.archivedAt,
                inUse: lt.inUse,
                cascadeApprovalRules: lt.cascadeApprovalRules ?? [],
                cascadeBalanceSourceOf: lt.cascadeBalanceSourceOf ?? [],
                eligibility: (lt.eligibility as LeaveTypeTabsData['eligibility']) ?? null,
                durations: (lt.durations as string[] | null) ?? null,
                requiresDocument: lt.requiresDocument,
                mandatoryAfterDays: lt.mandatoryAfterDays ?? null,
                allowedMimeTypes: (lt.allowedMimeTypes as string[] | null) ?? null,
                maxDocBytes: lt.maxDocBytes,
                employeeRemarkRequired: lt.employeeRemarkRequired,
                hrRemarkRequired: lt.hrRemarkRequired,
                backdatingLimitDays: lt.backdatingLimitDays ?? null,
                // numeric() columns arrive as strings from the driver — Number() them, or the number
                // inputs round-trip a string and the tri-state comparisons in the action misread them.
                maxDaysPerLeaveYear: lt.maxDaysPerLeaveYear == null ? null : Number(lt.maxDaysPerLeaveYear),
                maxDaysPeriod: lt.maxDaysPeriod ?? null,
                maxConsecutiveDays: lt.maxConsecutiveDays == null ? null : Number(lt.maxConsecutiveDays),
                maxConsecutiveUnit:
                  lt.maxConsecutiveUnit === 'working_days' || lt.maxConsecutiveUnit === 'calendar_days'
                    ? lt.maxConsecutiveUnit
                    : null,
                minAdvanceDays: lt.minAdvanceDays ?? null,
                minAdvanceDayType:
                  lt.minAdvanceDayType === 'working_days' || lt.minAdvanceDayType === 'calendar_days'
                    ? lt.minAdvanceDayType
                    : null,
                customMessages: (lt.customMessages as Record<string, string> | null) ?? null,
                essViewConfig: (lt.essViewConfig as Record<string, boolean> | null) ?? null,
                formulaExplanations:
                  (lt.formulaExplanations as Record<string, LeaveFormulaEntry> | null) ?? null,
                dayTypeInclusion: (lt.dayTypeInclusion as Record<string, boolean> | null) ?? null,
                color: lt.color ?? null,
                icon: lt.icon ?? null,
                leaveUnit: lt.leaveUnit ?? 'day',
                yearCycleOverride: lt.yearCycleOverride ?? null,
                probationEligibility: lt.probationEligibility ?? null,
                visibleToEmployee: lt.visibleToEmployee ?? null,
                employeeCanApply: lt.employeeCanApply ?? null,
                essPlacement: lt.essPlacement ?? null,
                role: lt.role ?? null,
                counting: lt.counting ?? 'working_days',
                perDateApproval: lt.perDateApproval ?? false,
                duplicateApplicationPolicy: lt.duplicateApplicationPolicy ?? null,
                // A plain array of plain objects — serialisable, so it may cross the boundary.
                overrideRules: lt.overrideRules ?? null,
                allowNegativeBalance: lt.allowNegativeBalance ?? false,
                maxNegativeBalance: lt.maxNegativeBalance == null ? null : Number(lt.maxNegativeBalance),
                balanceSourceTypeId: lt.balanceSourceTypeId ?? null,
                allowUnpaidLeave: lt.allowUnpaidLeave ?? false,
                sendToPayroll: lt.sendToPayroll ?? false,
                rules: {
                  accrualMethod: lt.accrualMethod ?? null,
                  accrualDay: lt.accrualDay ?? null,
                  // An ISO STRING rather than the Date the column holds: a plain string is unambiguously
                  // serialisable across the server/client boundary, and the tabs only ask whether it is null.
                  accrualUnconfigured: lt.accrualUnconfigured ? lt.accrualUnconfigured.toISOString() : null,
                  carryForwardEnabled: lt.carryForwardEnabled ?? null,
                  carryForwardMax: lt.carryForwardMax == null ? null : Number(lt.carryForwardMax),
                  carryForwardPercent:
                    lt.carryForwardPercent == null ? null : Number(lt.carryForwardPercent),
                  carryForwardExpiryMode: (lt.carryForwardExpiryMode as 'date' | 'months' | null) ?? null,
                  carryForwardExpiryMonths: lt.carryForwardExpiryMonths ?? null,
                  carryForwardExpiryMonth: lt.carryForwardExpiryMonth ?? null,
                  carryForwardExpiryDay: lt.carryForwardExpiryDay ?? null,
                  carryForwardIncludeEarned: lt.carryForwardIncludeEarned ?? null,
                  roundingMethod: (lt.roundingMethod as LeaveRoundingMethod | null) ?? null,
                  roundingThreshold: lt.roundingThreshold == null ? null : Number(lt.roundingThreshold),
                  // jsonb — a plain array of plain objects, which is the only kind of prop a server
                  // component may hand a client one. The editor validates the shape itself.
                  roundingBands: (lt.roundingBands as RoundingBand[] | null) ?? null,
                  maxBalanceDays: lt.maxBalanceDays == null ? null : Number(lt.maxBalanceDays),
                },
              };
              return [
                lt.id,
                <LeaveTypeTabs
                  key={lt.id}
                  type={data}
                  /* r288 (686dc512) — a plain object of a boolean and two string arrays. Serialisable,
                     so it may cross into the client island (test/server-client-boundary.test.ts). */
                  sweep={{
                    codeIsSwept: standingCodes.has(lt.code),
                    earnedMethods,
                    sweptTypeNames,
                  }}
                  orgAssignmentOptions={orgAssignmentOptions}
                  /* The candidates THIS type may point at: exclude self, exclude archived, and exclude any
                     type that already borrows — the service refuses chains, so offering one would only
                     produce a rejected save. */
                  balanceSourceOptions={types
                    .filter((x) => x.id !== lt.id && !x.archivedAt && x.balanceSourceTypeId == null)
                    .map((x) => ({ id: x.id, name: x.name }))}
                  formulaTemplate={formulaTemplate}
                  entitlementTablesSection={entitlementTablesSectionFor(lt.id)}
                  /* r270 (995387c6) — the schemes editor is only here now, so a link carrying either edit
                     parameter means "open tab 3", whatever tab this reader last left open. */
                  openTab={lt.id === editTargetLeaveTypeId ? 'entitlement' : undefined}
                  accrualPointer={accrualPointer}
                  /* a6fe37fc Round 4 — tab 5's read-out, sliced per type from the ONE rule set read
                     above. Server-composed and handed across the boundary as a rendered node, exactly
                     like `entitlementTablesSection`: no closure crosses it (r123). */
                  approvalReadoutSection={
                    <LeaveTypeApprovalReadout data={approvalReadout} leaveTypeId={lt.id} />
                  }
                  updateTypeAction={updateLeaveTypeAction}
                  archiveTypeAction={archiveLeaveTypeAction}
                  deleteTypeAction={deleteLeaveTypeAction}
                  setTypeRulesAction={setLeaveTypeRulesAction}
                />,
              ];
            }),
          )}
          addForm={
            /* The SAME create form and the SAME `createLeaveTypeAction` the old screen posts. Its
               redirect carries #type-<new id>, which this workspace reads to select the new type. */
            <form action={createLeaveTypeAction} className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2">
              {/* A failed save redirects back with ?error= while the dialog is still open, so the
                  page-level banner would sit behind the modal — mirror it where the admin is looking. */}
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
              <Field label={t('leaveUnitLabel')}>
                <select name="leaveUnit" defaultValue="day" className={inputCls}>
                  <option value="day">{t('leaveUnitDay')}</option>
                  <option value="hour">{t('leaveUnitHour')}</option>
                </select>
              </Field>
              <Field label={t('paidLabel')}>
                <div className="flex h-9 items-center">
                  <input
                    type="checkbox"
                    name="paid"
                    defaultChecked
                    aria-label={t('paidLabel')}
                    className="size-4 rounded"
                  />
                </div>
              </Field>
              <div className="col-span-full mt-1 flex justify-end gap-2">
                <AddLeaveTypeCancel>{t('cancel')}</AddLeaveTypeCancel>
                <button className={btnPrimary}>{t('save')}</button>
              </div>
            </form>
          }
        />
      </Card>
    </div>
  );
}

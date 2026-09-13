import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { listLeaveTypes, listCompanies } from '@/core/read';
import { ORG_ASSIGNMENT_CRITERIA } from '@/core/leave-org-criteria';
import { leaveFormulaTemplateFrom, type LeaveFormulaEntry } from '@/core/leave-formula';
import { listAllProfileOptions } from '@/core/profile-options';
import type { LeaveRoundingMethod, RoundingBand } from '@/core/leave-compute';
import { Card, ErrorBanner, Field, PageHeader, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { AddLeaveTypeCancel, LeaveTypeWorkspace } from '@/components/leave-type-workspace';
import {
  EntitlementTablesBlock,
  loadEntitlementTablesData,
} from '../../leave/entitlements/templates/entitlement-tables-block';
import { leaveConfigHealthAll, tablesReachNobody } from '@/lib/leave-config-health';
import { LeaveConfigHealthCard } from '@/components/leave/leave-config-health';
import { LeaveConfigMap, leaveConfigPageHeader, leaveConfigScreenHref } from '@/components/leave-config-map';
import { LeaveTypeApprovalReadout, loadLeaveTypeApprovalReadout } from '../approval-readout';
import { LeaveTypeTabs, type LeaveTypeTabsData } from './leave-type-tabs';
import {
  archiveLeaveTypeAction,
  createLeaveTypeAction,
  deleteLeaveTypeAction,
  setLeaveTypeRulesAction,
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
 *   · the company-wide Half-Day Deduction card and Shared Leave Groups are on Company rules
 *     (`/admin/leave-config/company-rules`, F4/F26 and F3). They are a COMPANY and a TENANT rule, not
 *     properties of a leave type — which is why one of them used to be drawn once per leave type. Their
 *     three server actions were repointed at the new `COMPANY_RULES` constant in this same commit, so a
 *     save returns to the screen the setting is actually on rather than to this list.
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
  const { error, editTemplate, editRule } = await searchParams;
  const header = await leaveConfigPageHeader('leaveTypes');

  // 10b59703 — the job-grade list LEFT this read with Run earned accrual, whose scope selector was its
  // only consumer here; Generate Entitlement reads it for the dialog now (generate/page.tsx).
  const [types, companies, profileOptionsActive] = await Promise.all([
    listLeaveTypes(s, { includeArchived: true }),
    listCompanies(s),
    // The ACTIVE picker values for the eight org fields come from the SAME master list the profile
    // Organisation Assignment screen reads, so deleted/inactive values are never offered as new choices.
    listAllProfileOptions(s, { activeOnly: true }),
  ]);

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
   * reporter's rule for this round it sits with the other run action, on Generate Entitlement, next to
   * the generation log (generate/page.tsx). R64 (7b945408 + 962077a8) had tucked it in here at the
   * reporter's earlier request; the plan says so and offers reject-and-say-so. What stays in the slot
   * is a one-line pointer, resolved through the map so it and the submenu cannot disagree about where
   * the tool is. Server-composed, like every other slot: a plain rendered node crosses the boundary.
   */
  const accrualPointer = (
    <p className="border-t border-border pt-3 text-xs text-muted-foreground">
      <Link href={leaveConfigScreenHref('generateEntitlement')} className="font-medium text-primary hover:underline">
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

      {/* Above the workspace on purpose: it answers "which of these can produce a balance at all", and
          every tab below assumes that question has already been asked. */}
      <LeaveConfigHealthCard rows={configHealth} />

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

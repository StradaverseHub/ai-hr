import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireAdmin, isGroupAdmin, hasGrantFor, withEffectiveGrants } from '@/lib/authz';
import { listLeaveTypes, listCompanies, listJobGrades } from '@/core/read';
import { entitlementYearOptions } from '@/core/leave';
import { ORG_ASSIGNMENT_CRITERIA } from '@/core/leave-org-criteria';
import { leaveFormulaTemplateFrom, type LeaveFormulaEntry } from '@/core/leave-formula';
import { listAllProfileOptions } from '@/core/profile-options';
import type { LeaveRoundingMethod, RoundingBand } from '@/core/leave-compute';
import { Card, ErrorBanner, Field, PageHeader, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { AddLeaveTypeCancel, LeaveTypeWorkspace } from '@/components/leave-type-workspace';
import { EarnedAccrualDialog } from '@/components/leave/earned-accrual-dialog';
import {
  EntitlementTablesBlock,
  loadEntitlementTablesData,
} from '../../leave/entitlements/templates/entitlement-tables-block';
import { leaveConfigHealthAll, tablesReachNobody } from '@/lib/leave-config-health';
import { LeaveConfigHealthCard } from '@/components/leave/leave-config-health';
import { LeaveConfigMap, leaveConfigScreenTitle } from '@/components/leave-config-map';
import { LeaveTypeTabs, type LeaveTypeTabsData } from './leave-type-tabs';
import {
  archiveLeaveTypeAction,
  createLeaveTypeAction,
  deleteLeaveTypeAction,
  setLeaveTypeRulesAction,
  updateLeaveTypeAction,
} from '../../actions';

/**
 * a6fe37fc ROUND 2 — LEAVE TYPES, the new module's first screen (`/admin/leave-config/types`).
 *
 * ⚠️ IT REPLACES NOTHING YET. `/admin/leave/entitlements` and `components/leave-type-panel.tsx` are
 * untouched, still registered, still what the menu links to, and still where an administrator works.
 * The plan promised the reporter "something that works at every point", so this round ADDS a screen and
 * removes nothing: the two are live side by side until Round 5 deletes the old one and repoints its
 * address here (docs/design/a6fe37fc-migration-order.md).
 *
 * WHAT IS DIFFERENT, and it is the whole item: the four steps and six sub-steps of the old panel are
 * FIVE TABS in the order the decisions are made — what the leave type is · who is eligible · what they
 * are entitled to · how it is applied for · who approves it (IA §2). Two settings move onto the type
 * because that is what they are: *Send to payroll module* from Payroll impact (tab 1) and *Per-date
 * approval* from General setting (tab 5). NEITHER OLD SCREEN LOSES ITS COPY THIS ROUND — a setting
 * editable in two places for one round is deliberate, both write the same column through the same action
 * and the same marker, and Round 5 closes the window.
 *
 * ⚠️ THE LEFT RAIL IS RE-CREATED, NOT DROPPED. It is the only way to choose a leave type, and the first
 * draft of this item's mockup quietly removed it. It is the SAME `LeaveTypeWorkspace` the old screen
 * mounts — one component, two mount points (IA §2.3's rule), not a second implementation to drift.
 *
 * ⚠️ A SAVE MADE HERE LANDS ON THE OLD SCREEN. Round 2's rule 2 is that no server action changes
 * signature and no new action is written, and every leave-type action redirects to a module constant
 * (`ENTITLEMENTS`, app/admin/_redirects.ts). Re-pointing it would move every save on the OLD screen too,
 * which is a Round 5 act. The note under the heading says so rather than letting it look like a fault.
 *
 * ⚠️ TWO PAGE-LEVEL SURFACES IA §3.1's TABLE NEVER LISTED, AND THIS SCREEN NEARLY LOST (r258 fix pass).
 * Both landed BEFORE the design's baseline (main@0c01befc) and the 32-function table was written without
 * them, so the anti-drop guard — which is keyed to that table — could not see them go. They are carried
 * here and the table now lists them as F47 / F48:
 *   · the Employee Balances link (r242 3a3f5a2d), the way in the reporter went looking for;
 *   · the "allowing a negative balance with no limit" list (r126 9861b8a4).
 * The area map and the tour anchor came across with them, for the reasons at their sites below.
 *
 * WHAT IS NOT HERE, and where it goes (IA §3.1, none of it dropped):
 *   · the company-wide Half-Day Deduction card and Shared Leave Groups — they are COMPANY / tenant
 *     rules, not properties of a leave type, and they land on Company rules in Round 3 (F4/F26, F3).
 *     Both are still live on the old screen meanwhile.
 *   · tab 5's read-only chain read-out (which chain reaches this type, its steps, its escalation) —
 *     Round 4, with the approval editor it reads from.
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
  const tTypes = await getTranslations('admin.leaveConfigTypes');
  const { error, editTemplate, editRule } = await searchParams;

  const [types, companies, grades, profileOptionsActive] = await Promise.all([
    listLeaveTypes(s, { includeArchived: true }),
    listCompanies(s),
    // The grade list feeds the Run Earned Accrual selector; `gradeOptions` filters archived rows itself.
    listJobGrades(s, { includeArchived: true }),
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
  const gradeOptions = grades.filter((g) => !g.archivedAt).map((g) => ({ id: g.id, name: g.name }));
  const companyOptions = companies.map((c) => ({ id: c.id, name: c.name }));
  const effectiveGrants = withEffectiveGrants(s);
  const canGroupWide = isGroupAdmin(effectiveGrants);
  const accrualCompanies = canGroupWide
    ? companyOptions
    : companyOptions.filter((c) => hasGrantFor(effectiveGrants, 'hr_admin', c.id));
  const activeTypeOptions = types.filter((lt) => !lt.archivedAt).map((lt) => ({ id: lt.id, name: lt.name }));
  // The Run-Earned-Accrual year range reaches three years BACK through six forward, so running earned
  // accrual for a past year stays possible. `status` is informational only.
  const currentYear = new Date().getUTCFullYear();
  const earnedLeaveYears = entitlementYearOptions(currentYear).map((y) => ({ year: y, status: 'draft' }));

  // ⚠️ ELEVEN READS, ONCE, FOR THE WHOLE PAGE. The result is SLICED per type inside the block; a block
  // that loaded for itself would turn eleven queries into eleven times the number of leave types.
  const entitlementTablesData = await loadEntitlementTablesData(s);
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
  const accrualSection = (
    <div className="space-y-1.5 border-t border-border pt-3">
      <span className="text-xs font-medium text-muted-foreground">{t('runEarnedAccrual')}</span>
      <p className="text-xs text-muted-foreground">{t('entitlementStep.accrualHint')}</p>
      <EarnedAccrualDialog
        companies={accrualCompanies}
        grades={gradeOptions}
        leaveTypes={activeTypeOptions}
        leaveYears={earnedLeaveYears}
        defaultYear={currentYear}
      />
    </div>
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
        // The heading is the SAME string the menu shows for this screen — a separate title key per page
        // is how a menu and a heading start disagreeing (components/leave-config-map.tsx).
        title={await leaveConfigScreenTitle('leaveTypes')}
        description={tTypes('pageDescription')}
        actions={
          <div className="flex items-center gap-3">
            {/* IA §3.1 F5 — the header links. They point at TODAY'S addresses because that is where those
                screens are until Round 3 builds their replacements and Round 5 repoints them. */}
            <Link href="/admin/leave/entitlements/templates" className="text-sm underline">
              {t('entitlementTablesAction')}
            </Link>
            <Link href="/admin/leave/entitlements/archive" className="text-sm underline">
              {t('configurationRecordAction')}
            </Link>
            <Link href="/admin/leave/entitlements/ledger-archive" className="text-sm underline">
              {t('balanceRecordAction')}
            </Link>
            {/* r242 3a3f5a2d — THE WAY IN THE REPORTER WENT LOOKING FOR, CARRIED ACROSS (r258 fix pass).
                An HR admin who wants to look one person's balances up came here, to Leave Config, and found
                nothing pointing at Leave Inquiry; this link is the whole of that fix, and Employee Balances'
                own rail carries the other two tabs, so one link reaches all three. Dropping it at the Round 5
                cutover would re-create the exact complaint r242 answered — it was missing from IA §3.1
                (it landed before the design's baseline, main@0c01befc) and §3.1 now lists it as F47.
                THE ADDRESS IS UNCHANGED ON PURPOSE: /leave/employee-balances is not a Leave Config screen and
                Round 5 does not move it. */}
            <Link href="/leave/employee-balances" className="text-sm underline">
              {t('employeeBalancesAction')}
            </Link>
            <Link href="/admin/leave/import" className={btnPrimary}>
              {t('importAction')}
            </Link>
          </div>
        }
      />
      {/* The area map, CARRIED ACROSS (r258 fix pass): without it this screen has no way to reach its
          sibling leave-config screens at all, which is a worse map than the one the old screen has.
          `current="leaveTypes"` because this IS that screen — the map names screens, not addresses, and
          Round 5 repoints the entry here. ADDITIVE: everything below it is unchanged. */}
      <LeaveConfigMap current="leaveTypes" />
      {/* Said out loud, because a screen that saves and then navigates somewhere else reads as broken.
          Both halves are true only during Rounds 2–4 and the note goes with them at the cutover. */}
      <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        {tTypes('previewNote')}
      </p>
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
                  accrualSection={accrualSection}
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

import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireAdmin, isGroupAdmin, hasGrantFor, withEffectiveGrants } from '@/lib/authz';
import { listLeaveTypes, listCompanies, listJobGrades } from '@/core/read';
import { listAdHocLeaveGrants, listLeavePolicies } from '@/core/admin';
import { listLeaveYearConfigs } from '@/core/leave';
import { listGradeGroups, listBenefitSchemes, listSchemeEntitlements } from '@/core/benefit-scheme';
import { BenefitSchemeConfig } from '@/components/benefit-scheme-config';
import type { ServiceBand } from '@/core/leave-compute';
import { entitlement } from '@/localization/my/leave';
import { Badge, Button, Card, ErrorBanner, Field, PageHeader, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { LeaveTabs } from '@/components/leave-tabs';
import { LeaveTypePanel, type EntitlementPolicy } from '@/components/leave-type-panel';
import { FestiveGrantCard, type FestiveGrantRow } from '@/components/festive-grant-card';
import { EarnedAccrualCard } from '@/components/earned-accrual-card';
import {
  archiveLeaveTypeAction,
  countEmployeesInScopeAction,
  createLeavePoliciesMultiAction,
  createLeaveTypeAction,
  deleteLeavePolicyAction,
  deleteLeaveTypeAction,
  updateLeavePolicyAction,
  updateLeaveTypeAction,
  upsertLeaveYearConfigAction,
  setLeaveYearStatusAction,
  saveFutureOpeningRuleAction,
  setCompanyLeaveCycleAction,
  createJobGradeAction,
  archiveJobGradeAction,
  updateJobGradeAction,
  deleteJobGradeAction,
  createGradeGroupAction,
  updateGradeGroupAction,
  deleteGradeGroupAction,
  createBenefitSchemeAction,
  updateBenefitSchemeAction,
  deleteBenefitSchemeAction,
  upsertSchemeEntitlementAction,
  deleteSchemeEntitlementAction,
} from '../../actions';
import { GradeCatalog } from '@/components/grade-catalog';

/**
 * Leave Settings — Entitlements tab.
 *
 * Feedback 9d8cf621 (Entitlements Setting reorganization): the per-leave-type CONFIGURATION panel now lives
 * here — "one leave type, one full set of settings", exactly where HR expects it. Each `LeaveTypePanel`
 * carries leave-type identity, eligibility, allowed durations, supporting-document config, backdating limit,
 * advance-notice, expiry, the apply-time custom message AND that type's effective-dated entitlement policies
 * (the editable ranges table + the multi-company/grade "Employee Selection" chips). Beneath it are the
 * company-level entitlement operations re-homed here earlier (0d147b78): leave-year opener + earned-accrual
 * runner, per-company accrual cycle, grade catalog, bulk import, festive grant. The whole `LeaveTypePanel` +
 * add-type form moved wholesale from the Types tab, so every sub-form keeps its tri-state marker + hidden
 * `name` intact — no column is wiped on save.
 */
export default async function LeaveEntitlementsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.leave');
  const { error } = await searchParams;
  const [types, policies, companies, grades, adHocGrants, leaveYearConfigs, gradeGroups, benefitSchemes, schemeEntitlements] =
    await Promise.all([
      listLeaveTypes(s, { includeArchived: true }),
      listLeavePolicies(s),
      listCompanies(s),
      // 728a7db6 — load archived grades too so the management table can show + unarchive them; the leave-type
      // scope dropdown below is filtered to ACTIVE grades only (archived grades can't be assigned to new scopes).
      listJobGrades(s, { includeArchived: true }),
      listAdHocLeaveGrants(s),
      // Leave Year Configuration (9aa894a4): the managed Draft/Open/Closed records driving the Leave-Year table.
      listLeaveYearConfigs(s),
      // Benefit Scheme & Leave Entitlement (b83c6a3b): the new configuration layer's data.
      listGradeGroups(s),
      listBenefitSchemes(s),
      listSchemeEntitlements(s),
    ]);
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
  const recentGrants: FestiveGrantRow[] = adHocGrants.map((g) => ({
    occurredAt: g.occurredAt.toISOString(),
    companyName: g.companyId ? (companyNameById.get(g.companyId) ?? null) : null,
    leaveTypeName: g.leaveTypeId ? (typeNameById.get(g.leaveTypeId) ?? null) : null,
    days: g.days,
    count: g.count,
    reason: g.reason,
    effectiveOn: g.effectiveOn,
  }));
  const todayIso = new Date().toISOString().slice(0, 10);
  const nextYear = new Date().getUTCFullYear() + 1;
  // Leave Year Configuration (9aa894a4): offer the current year through +6 in the create dropdown; default to
  // the first year that does not yet have a managed record (so repeated "Add" naturally walks forward).
  const configuredYears = new Set(leaveYearConfigs.map((c) => c.year));
  const yearOptions = Array.from({ length: 7 }, (_, i) => new Date().getUTCFullYear() + i);
  const defaultNewYear = yearOptions.find((y) => !configuredYears.has(y)) ?? nextYear;
  // Future Leave Year Opening Rule (d9e41725): prefill the rule sub-form from the default year's existing rule
  // (if one is already saved), so re-editing shows the current window instead of blank fields.
  const defaultRule = leaveYearConfigs.find((c) => c.year === defaultNewYear) ?? null;
  // feedback 2c7c6385: the Run-Earned-Accrual Leave-Year selector reads the managed leave_year_config
  // records (9aa894a4). When none exist yet, fall back to the current-year..+6 range so the card still
  // works. Default to the current year if configured, else the newest record.
  const currentYear = new Date().getUTCFullYear();
  const earnedLeaveYears =
    leaveYearConfigs.length > 0
      ? leaveYearConfigs.map((c) => ({ year: c.year, status: c.status }))
      : yearOptions.map((y) => ({ year: y, status: 'draft' }));
  const earnedDefaultYear =
    earnedLeaveYears.find((y) => y.year === currentYear)?.year ?? earnedLeaveYears[0]?.year ?? currentYear;
  const leaveYearStatusVariant = (status: string) =>
    status === 'open' ? ('success' as const) : status === 'closed' ? ('default' as const) : ('warning' as const);

  // Statutory floor display (MY pack): sample the three service bands.
  const floorBands = (code: string) => {
    const days = [...new Set([0, 2, 6].map((y) => entitlement(code, y)))];
    return days[0] === 0 ? null : days.join(' / ');
  };

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

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title={t('pageTitle')} description={t('pageDescription')} />
      <LeaveTabs active="entitlements" />
      <ErrorBanner message={error} />

      {/* Feedback 9d8cf621 — per-type configuration + entitlements. "1 leave type, 1 full set of settings". */}
      <Card data-tour="leave-config">
        <SectionHeader title={t('typesSectionTitle')} count={types.length} />
        <ul className="divide-y divide-border">
          {types.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-muted-foreground">{t('noLeaveTypes')}</li>
          )}
          {types.map((lt) => (
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
              floorLabel={floorBands(lt.code)}
              floor0={entitlement(lt.code, 0)}
              eligibility={(lt.eligibility as { gender?: string | string[]; maritalStatus?: string | string[]; minServiceMonths?: number; minServiceUnit?: 'months' | 'days' } | null) ?? null}
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
              dayTypeInclusion={(lt.dayTypeInclusion as Record<string, boolean> | null) ?? null}
              color={lt.color ?? null}
              icon={lt.icon ?? null}
              leaveUnit={lt.leaveUnit ?? 'day'}
              probationEligibility={lt.probationEligibility ?? null}
              visibleToEmployee={lt.visibleToEmployee ?? null}
              employeeCanApply={lt.employeeCanApply ?? null}
              essPlacement={lt.essPlacement ?? null}
              counting={lt.counting ?? 'working_days'}
              perDateApproval={lt.perDateApproval ?? false}
              duplicateApplicationPolicy={lt.duplicateApplicationPolicy ?? null}
              allowNegativeBalance={lt.allowNegativeBalance ?? false}
              policies={polByType.get(lt.id) ?? []}
              grades={gradeOptions}
              companies={companyOptions}
              updateTypeAction={updateLeaveTypeAction}
              archiveTypeAction={archiveLeaveTypeAction}
              deleteTypeAction={deleteLeaveTypeAction}
              createPolicyAction={createLeavePoliciesMultiAction}
              updatePolicyAction={updateLeavePolicyAction}
              deletePolicyAction={deleteLeavePolicyAction}
              countInScopeAction={countEmployeesInScopeAction}
            />
          ))}
        </ul>
        <form
          action={createLeaveTypeAction}
          className="grid grid-cols-1 items-end gap-3 border-t border-border p-4 sm:grid-cols-6"
        >
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
          <Field label={t('descriptionLabel')}>
            {/* Multiline (fbcadc71): textarea so Enter inserts a newline instead of submitting; h-auto/min-h/resize-y
                overrides inputCls's fixed h-9 so it shows ~3 lines, grows via the drag handle, and scrolls on overflow.
                Persistence already stores text with newlines (action only .trim()s the ends). */}
            <textarea
              name="description"
              rows={3}
              placeholder={t('descriptionPlaceholder')}
              className={`${inputCls} h-auto min-h-[4.5rem] resize-y`}
            />
          </Field>
          <Field label={t('statusLabel')}>
            <select name="active" defaultValue="active" className={inputCls}>
              <option value="active">{t('statusActive')}</option>
              <option value="inactive">{t('statusInactive')}</option>
            </select>
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="paid" defaultChecked className="size-4 rounded" />
            {t('paidLabel')}
          </label>
          {/* Leave Unit Configuration (e4980382): Day/Hour select beside Paid. Default Day. */}
          <Field label={t('leaveUnitLabel')}>
            <select name="leaveUnit" defaultValue="day" className={inputCls}>
              <option value="day">{t('leaveUnitDay')}</option>
              <option value="hour">{t('leaveUnitHour')}</option>
            </select>
          </Field>
          <button className={btnPrimary}>{t('addType')}</button>
        </form>
        <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
          {t.rich('typesHelp', { strong: (chunks) => <span className="font-medium">{chunks}</span> })}
        </p>
      </Card>

      {/* Leave Year Configuration (9aa894a4): the managed Draft → Open → Closed leave-year records. Each row
          carries a status badge, the two control dates (editable), and the lifecycle action. Opening a year
          runs the same grant sweep as before (via setLeaveYearStatusAction → openLeaveYear), so the record
          and the ledger stay in lockstep. Employees can only apply for a FUTURE leave year once it is open
          and past its Employee-Application-Start-Date (enforced in requestLeave). */}
      <Card>
        <SectionHeader title={t('leaveYearTitle')} count={leaveYearConfigs.length} />
        <p className="px-4 pt-3 text-xs text-muted-foreground">
          {t.rich('leaveYearHelp', {
            strong: (chunks) => <span className="font-medium text-foreground">{chunks}</span>,
          })}
        </p>
        <ul className="divide-y divide-border">
          {leaveYearConfigs.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-muted-foreground">{t('noLeaveYears')}</li>
          )}
          {leaveYearConfigs.map((cfg) => (
            <li key={cfg.id} className="flex flex-wrap items-end justify-between gap-4 px-4 py-3">
              <div className="flex items-center gap-3">
                <span className="w-14 text-sm font-semibold text-foreground">{cfg.year}</span>
                <Badge variant={leaveYearStatusVariant(cfg.status)}>{t(`leaveYearStatus_${cfg.status}`)}</Badge>
              </div>
              {/* Edit the two control dates (status unchanged here — the lifecycle action does that). */}
              <form action={upsertLeaveYearConfigAction} className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="year" value={cfg.year} />
                <Field label={t('openLeaveYearDateLabel')}>
                  <input
                    type="date"
                    name="openLeaveYearDate"
                    defaultValue={cfg.openLeaveYearDate ?? ''}
                    className={`${inputCls} w-40`}
                  />
                </Field>
                <Field label={t('employeeApplicationStartDateLabel')}>
                  <input
                    type="date"
                    name="employeeApplicationStartDate"
                    defaultValue={cfg.employeeApplicationStartDate ?? ''}
                    className={`${inputCls} w-40`}
                  />
                </Field>
                <Button type="submit" variant="outline" size="sm">
                  {t('save')}
                </Button>
              </form>
              {/* Lifecycle action. Draft → Open runs the grant sweep; Open → Closed is an informational badge
                  flip (v1); Closed → Draft reopens for corrections. */}
              <div className="flex items-end">
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
              </div>
            </li>
          ))}
        </ul>
        {/* Create / configure an upcoming leave year (year dropdown + two control dates). */}
        <form
          action={upsertLeaveYearConfigAction}
          className="flex flex-wrap items-end gap-3 border-t border-border p-4"
        >
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

        {/* Future Leave Year Opening Rule (d9e41725). HR Admin defines an advance-opening window ("open the
            year N Days/Weeks/Months before it starts") for a chosen Effective Leave Year; on save the system
            COMPUTES open_leave_year_date = 1-Jan-of-year minus that window (UTC-correct calendar math) and
            stamps it on that year's record. v1 is compute-only — enabling the rule sets the date; an automatic
            open-the-year cron is deferred. The hidden `ruleSubmitted` marker + checkbox `enable` follow the
            tri-state sub-form convention so an unchecked box reliably disables the rule. Prefilled from the
            default (next uncofigured) year's existing rule, if any. */}
        <div className="border-t border-border px-4 py-3">
          <h3 className="text-sm font-semibold text-foreground">{t('openingRuleTitle')}</h3>
          <p className="mt-1 max-w-2xl text-xs text-muted-foreground">{t('openingRuleHelp')}</p>
          <form action={saveFutureOpeningRuleAction} className="mt-3 flex flex-wrap items-end gap-3">
            {/* tri-state marker: this sub-form owns the rule columns; its presence means "apply the rule state
                below" (checkbox absent ⇒ disable, not "leave untouched"). */}
            <input type="hidden" name="ruleSubmitted" value="1" />
            <label className="flex items-center gap-2 self-center pt-5 text-sm">
              <input
                type="checkbox"
                name="enable"
                defaultChecked={defaultRule?.openingRuleEnabled ?? false}
                className="size-4 rounded"
              />
              {t('openingRuleEnableLabel')}
            </label>
            <Field label={t('openBeforeAmountLabel')}>
              <input
                type="number"
                name="openBeforeAmount"
                min={1}
                step={1}
                defaultValue={defaultRule?.openBeforeAmount ?? ''}
                placeholder="14"
                className={`${inputCls} w-24`}
              />
            </Field>
            <Field label={t('openBeforeUnitLabel')}>
              <select
                name="openBeforeUnit"
                defaultValue={defaultRule?.openBeforeUnit ?? 'days'}
                className={`${inputCls} w-32`}
              >
                <option value="days">{t('openingUnitDays')}</option>
                <option value="weeks">{t('openingUnitWeeks')}</option>
                <option value="months">{t('openingUnitMonths')}</option>
              </select>
            </Field>
            <Field label={t('effectiveLeaveYearLabel')}>
              <select name="year" defaultValue={String(defaultNewYear)} className={`${inputCls} w-28`}>
                {yearOptions.map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </select>
            </Field>
            <Button type="submit" variant="outline" size="sm">
              {t('save')}
            </Button>
          </form>
          {/* Show the currently-persisted rules so HR sees the computed opening dates at a glance. */}
          {leaveYearConfigs.some((c) => c.openingRuleEnabled) && (
            <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
              {leaveYearConfigs
                .filter((c) => c.openingRuleEnabled)
                .map((c) => (
                  <li key={`rule-${c.id}`}>
                    {t('openingRuleSummary', {
                      year: c.year,
                      amount: c.openBeforeAmount ?? 0,
                      unit: t(
                        c.openBeforeUnit === 'weeks'
                          ? 'openingUnitWeeks'
                          : c.openBeforeUnit === 'months'
                            ? 'openingUnitMonths'
                            : 'openingUnitDays',
                      ),
                      date: c.openLeaveYearDate ?? '—',
                    })}
                  </li>
                ))}
            </ul>
          )}
        </div>

        {/* feedback 2c7c6385 (Run Earned Accrual button): the bare fire-immediately button is replaced with a
            scope + preview/dry-run + confirm review card. Scope axes narrow the shipped idempotent engine;
            the preview is a dry-run that writes nothing yet reports the exact numbers the commit produces.
            The Leave-Year selector reads the managed leave_year_config records (9aa894a4). */}
        <div className="border-t border-border">
          <h3 className="px-4 pt-3 text-sm font-semibold text-foreground">{t('runEarnedAccrual')}</h3>
          <EarnedAccrualCard
            companies={festiveCompanies}
            grades={gradeOptions}
            leaveTypes={activeTypeOptions}
            leaveYears={earnedLeaveYears}
            defaultYear={earnedDefaultYear}
          />
        </div>
      </Card>

      {/* ADR-0040 2D-2: per-company earned-accrual cycle (calendar vs hire anniversary). */}
      <Card>
        <SectionHeader title={t('leaveCycleTitle')} count={companies.length} />
        <p className="px-4 pt-3 text-xs text-muted-foreground">{t('leaveCycleHelp')}</p>
        <ul className="divide-y divide-border">
          {companies.map((c) => (
            <li key={c.id} className="px-4 py-3">
              <form
                action={setCompanyLeaveCycleAction}
                className="flex flex-wrap items-center justify-between gap-3"
              >
                <input type="hidden" name="companyId" value={c.id} />
                <span className="min-w-0 truncate text-sm font-medium text-foreground">{c.name}</span>
                <div className="flex items-center gap-2">
                  <select name="cycle" defaultValue={c.leaveCycle ?? 'calendar'} className={`${inputCls} w-44`}>
                    <option value="calendar">{t('cycleCalendar')}</option>
                    <option value="anniversary">{t('cycleAnniversary')}</option>
                  </select>
                  <Button type="submit" variant="outline" size="sm">
                    {t('save')}
                  </Button>
                </div>
              </form>
            </li>
          ))}
        </ul>
      </Card>

      {/* ADR-0041 2E + Grade Management (728a7db6): the grade master — Code | Name | Rank | Status | Action
          table with Edit / Archive↔Unarchive / Delete. Grade-scoped leave policies reference these grades. */}
      <Card>
        <SectionHeader title={t('gradesTitle')} count={grades.length} />
        <p className="px-4 pt-3 pb-1 text-xs text-muted-foreground">{t('gradesHelp')}</p>
        <GradeCatalog
          grades={grades.map((g) => ({
            id: g.id,
            code: g.code,
            name: g.name,
            rank: g.rank,
            archived: g.archivedAt != null,
            inUse: g.inUse,
          }))}
          actions={{
            create: createJobGradeAction,
            update: updateJobGradeAction,
            archive: archiveJobGradeAction,
            delete: deleteJobGradeAction,
          }}
        />
      </Card>

      {/* Benefit Scheme & Leave Entitlement Configuration (feedback b83c6a3b): a friendlier configuration
          LAYER over the grade-scoped engine, placed AFTER the Grade catalog (which stays unchanged). Grade
          groups + named schemes (Company × Employment Type × Grade Group) + a per-scheme leave-entitlement
          table. Employees resolve to a scheme (auto-match, or a manual override) and the scheme's service-
          band days supersede the grade policy — the EA-1955 floor still applies. */}
      <Card>
        <SectionHeader title={t('benefitSchemeTitle')} count={benefitSchemes.length} />
        <p className="px-4 pt-3 pb-1 text-xs text-muted-foreground">{t('benefitSchemeHelp')}</p>
        <div className="p-4">
          <BenefitSchemeConfig
            companies={companyOptions}
            grades={grades.filter((g) => !g.archivedAt).map((g) => ({ id: g.id, name: g.name, code: g.code }))}
            leaveTypes={activeTypeOptions.map((lt) => ({
              id: lt.id,
              name: lt.name,
              code: types.find((t) => t.id === lt.id)?.code ?? '',
            }))}
            gradeGroups={gradeGroups.map((g) => ({ id: g.id, name: g.name, gradeIds: g.gradeIds, archived: g.archived }))}
            schemes={benefitSchemes.map((sc) => ({
              id: sc.id,
              companyId: sc.companyId,
              employmentType: sc.employmentType,
              gradeGroupId: sc.gradeGroupId,
              gradeGroupName: sc.gradeGroupName,
              name: sc.name,
              status: sc.status,
            }))}
            entitlements={schemeEntitlements.map((e) => ({
              id: e.id,
              benefitSchemeId: e.benefitSchemeId,
              leaveTypeId: e.leaveTypeId,
              leaveTypeName: e.leaveTypeName,
              serviceBands: e.serviceBands,
            }))}
            actions={{
              createGradeGroup: createGradeGroupAction,
              updateGradeGroup: updateGradeGroupAction,
              deleteGradeGroup: deleteGradeGroupAction,
              createScheme: createBenefitSchemeAction,
              updateScheme: updateBenefitSchemeAction,
              deleteScheme: deleteBenefitSchemeAction,
              upsertEntitlement: upsertSchemeEntitlementAction,
              deleteEntitlement: deleteSchemeEntitlementAction,
            }}
          />
        </div>
      </Card>

      {/* Leave Data Import & Migration Tool — bulk-load opening balances / carry-forward / historical leave. */}
      <Card>
        <SectionHeader title={t('importTitle')} />
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-4">
          <p className="max-w-md text-xs text-muted-foreground">{t('importHelp')}</p>
          <Button asChild variant="outline" size="sm">
            <Link href="/admin/leave/import">{t('importLink')}</Link>
          </Button>
        </div>
      </Card>

      {/* ADR-0066: festive / one-off leave grant — hand N extra days to everyone in a company + leave type. */}
      <Card>
        <SectionHeader title={t('festiveTitle')} />
        <FestiveGrantCard
          companies={festiveCompanies}
          canGroupWide={canGroupWide}
          leaveTypes={activeTypeOptions}
          recent={recentGrants}
          defaultDate={todayIso}
        />
      </Card>
    </div>
  );
}

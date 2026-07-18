import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireAdmin, isGroupAdmin, hasGrantFor, withEffectiveGrants } from '@/lib/authz';
import { listLeaveTypes, listCompanies, listJobGrades } from '@/core/read';
import { listAdHocLeaveGrants, listLeavePolicies } from '@/core/admin';
import { listLeaveYearConfigs } from '@/core/leave';
import {
  listGradeGroups,
  listBenefitSchemes,
  listSchemeEntitlements,
  listSchemeCombinedLimits,
} from '@/core/benefit-scheme';
import { BenefitSchemeConfig } from '@/components/benefit-scheme-config';
import type { ServiceBand } from '@/core/leave-compute';
import { entitlement } from '@/localization/my/leave';
import { Button, Card, ErrorBanner, Field, PageHeader, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
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
  copySchemeEntitlementsAction,
  createSchemeCombinedLimitAction,
  updateSchemeCombinedLimitAction,
  deleteSchemeCombinedLimitAction,
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
  const [types, policies, companies, grades, adHocGrants, leaveYearConfigs, gradeGroups, benefitSchemes, schemeEntitlements, schemeCombinedLimits] =
    await Promise.all([
      listLeaveTypes(s, { includeArchived: true }),
      listLeavePolicies(s),
      listCompanies(s),
      // 728a7db6 — load archived grades too so the management table can show + unarchive them; the leave-type
      // scope dropdown below is filtered to ACTIVE grades only (archived grades can't be assigned to new scopes).
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
              formulaExplanations={(lt.formulaExplanations as Record<string, { description?: string; formula?: string; result?: string }> | null) ?? null}
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

      {/* feedback 2c7c6385 (Run Earned Accrual button): the bare fire-immediately button is replaced with a
          scope + preview/dry-run + confirm review card. Scope axes narrow the shipped idempotent engine; the
          preview is a dry-run that writes nothing yet reports the exact numbers the commit produces. The
          Leave-Year selector reads the managed leave_year_config records (9aa894a4). R45 cc816207 — the Leave
          Year card that used to sit above this section relocated to the Application Rules tab; earned accrual
          stays here with Entitlements. */}
      <Card>
        <SectionHeader title={t('runEarnedAccrual')} />
        <div className="border-t border-border">
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
            combinedLimits={schemeCombinedLimits.map((cl) => ({
              id: cl.id,
              benefitSchemeId: cl.benefitSchemeId,
              name: cl.name,
              totalLimitDays: cl.totalLimitDays,
              leaveTypeIds: cl.leaveTypeIds,
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
              copyEntitlements: copySchemeEntitlementsAction,
              createCombinedLimit: createSchemeCombinedLimitAction,
              updateCombinedLimit: updateSchemeCombinedLimitAction,
              deleteCombinedLimit: deleteSchemeCombinedLimitAction,
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

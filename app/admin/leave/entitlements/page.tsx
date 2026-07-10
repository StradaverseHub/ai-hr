import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireAdmin, isGroupAdmin, hasGrantFor, withEffectiveGrants } from '@/lib/authz';
import { listLeaveTypes, listCompanies, listJobGrades } from '@/core/read';
import { listAdHocLeaveGrants, listLeavePolicies } from '@/core/admin';
import type { ServiceBand } from '@/core/leave-compute';
import { entitlement } from '@/localization/my/leave';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { Button, Card, ErrorBanner, Field, PageHeader, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { LeaveTabs } from '@/components/leave-tabs';
import { LeaveTypePanel, type EntitlementPolicy } from '@/components/leave-type-panel';
import { FestiveGrantCard, type FestiveGrantRow } from '@/components/festive-grant-card';
import {
  archiveLeaveTypeAction,
  countEmployeesInScopeAction,
  createLeavePoliciesMultiAction,
  createLeaveTypeAction,
  deleteLeavePolicyAction,
  deleteLeaveTypeAction,
  updateLeavePolicyAction,
  updateLeaveTypeAction,
  openLeaveYearAction,
  runEarnedAccrualAction,
  setCompanyLeaveCycleAction,
  createJobGradeAction,
  archiveJobGradeAction,
} from '../../actions';

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
  const [types, policies, companies, grades, adHocGrants] = await Promise.all([
    listLeaveTypes(s, { includeArchived: true }),
    listLeavePolicies(s),
    listCompanies(s),
    listJobGrades(s),
    listAdHocLeaveGrants(s),
  ]);
  const gradeOptions = grades.map((g) => ({ id: g.id, name: g.name }));
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
              archived={!!lt.archivedAt}
              inUse={lt.inUse}
              isAnnual={lt.code === 'ANNUAL'}
              floorLabel={floorBands(lt.code)}
              floor0={entitlement(lt.code, 0)}
              eligibility={(lt.eligibility as { gender?: string; maritalStatus?: string; minServiceMonths?: number } | null) ?? null}
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
            <input name="description" placeholder={t('descriptionPlaceholder')} className={inputCls} />
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
          <button className={btnPrimary}>{t('addType')}</button>
        </form>
        <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
          {t.rich('typesHelp', { strong: (chunks) => <span className="font-medium">{chunks}</span> })}
        </p>
      </Card>

      <Card>
        <SectionHeader title={t('leaveYearTitle')} />
        <p className="px-4 pt-3 text-xs text-muted-foreground">
          {t.rich('leaveYearHelp', {
            strong: (chunks) => <span className="font-medium text-foreground">{chunks}</span>,
          })}
        </p>
        <form action={openLeaveYearAction} className="flex flex-wrap items-end gap-3 p-4">
          <Field label={t('yearLabel')}>
            <input
              name="year"
              type="number"
              min="2020"
              max="2100"
              required
              defaultValue={nextYear}
              className={`${inputCls} w-28`}
            />
          </Field>
          <button className={btnPrimary}>{t('openLeaveYear')}</button>
        </form>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3">
          <p className="max-w-md text-xs text-muted-foreground">{t('earnedAccrualHelp')}</p>
          <form action={runEarnedAccrualAction}>
            <Button type="submit" variant="outline" size="sm">
              {t('runEarnedAccrual')}
            </Button>
          </form>
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

      {/* ADR-0041 2E: the grade catalog (seniority bands). Grade-scoped leave policies reference these. */}
      <Card>
        <SectionHeader title={t('gradesTitle')} count={grades.length} />
        <p className="px-4 pt-3 text-xs text-muted-foreground">{t('gradesHelp')}</p>
        <ul className="divide-y divide-border">
          {grades.length === 0 && (
            <li className="px-4 py-4 text-center text-xs text-muted-foreground">{t('gradesEmpty')}</li>
          )}
          {grades.map((g) => (
            <li key={g.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-sm font-medium text-foreground">{g.name}</span>
                <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                  {g.code}
                </span>
                <span className="text-xs text-muted-foreground">{t('gradeRank', { rank: g.rank })}</span>
              </div>
              <form action={archiveJobGradeAction}>
                <input type="hidden" name="id" value={g.id} />
                <input type="hidden" name="archived" value="true" />
                <ConfirmSubmit
                  size="sm"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  title={t('archiveGradeConfirmTitle')}
                  description={t('archiveGradeConfirmDescription')}
                  confirmLabel={t('archiveConfirmLabel')}
                >
                  {t('archive')}
                </ConfirmSubmit>
              </form>
            </li>
          ))}
        </ul>
        <form action={createJobGradeAction} className="flex flex-wrap items-end gap-2 border-t border-border p-4">
          <Field label={t('gradeCodeLabel')}>
            <input name="code" required placeholder="EXEC" className={`${inputCls} w-28 uppercase`} />
          </Field>
          <Field label={t('gradeNameLabel')}>
            <input name="name" required placeholder={t('gradeNamePlaceholder')} className={inputCls} />
          </Field>
          <Field label={t('gradeRankLabel')}>
            <input name="rank" type="number" min="0" defaultValue="0" className={`${inputCls} w-20`} />
          </Field>
          <Button type="submit" size="sm">
            {t('addGrade')}
          </Button>
        </form>
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

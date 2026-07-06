import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireAdmin, isGroupAdmin, hasGrantFor, withEffectiveGrants } from '@/lib/authz';
import { listLeaveTypes, listCompanies, listJobGrades } from '@/core/read';
import { listAdHocLeaveGrants } from '@/core/admin';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { Button, Card, ErrorBanner, Field, PageHeader, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { LeaveTabs } from '@/components/leave-tabs';
import { FestiveGrantCard, type FestiveGrantRow } from '@/components/festive-grant-card';
import {
  openLeaveYearAction,
  runEarnedAccrualAction,
  setCompanyLeaveCycleAction,
  createJobGradeAction,
  archiveJobGradeAction,
} from '../../actions';

/**
 * Leave Settings — Entitlements tab (0d147b78 — Leave Settings Reorganization).
 *
 * Company-level entitlement operations, re-homed here from the former single Leave Settings page:
 * the leave-year opener + earned-accrual runner, the per-company accrual cycle (calendar vs
 * anniversary), the grade catalog that grade-scoped policies reference, the bulk import link, and the
 * festive / one-off grant. Per-type entitlement POLICIES (days/carry/bands) stay on the Leave Types
 * tab inside `LeaveTypePanel`, since they are edited per leave type. No action/service change — every
 * form keeps its existing server action, `requireAdmin()` guard preserved verbatim.
 */
export default async function LeaveEntitlementsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.leave');
  const { error } = await searchParams;
  const [types, companies, grades, adHocGrants] = await Promise.all([
    listLeaveTypes(s, { includeArchived: true }),
    listCompanies(s),
    listJobGrades(s),
    listAdHocLeaveGrants(s),
  ]);
  // ADR-0066: festive-grant company picker only offers companies this admin actually administers,
  // so "Select all" always succeeds for a company-scoped admin. hasGrantFor is the exact predicate
  // grantAdHocLeave's authority gate uses, so anything selectable here is guaranteed to pass it.
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

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title={t('pageTitle')} description={t('pageDescription')} />
      <LeaveTabs active="entitlements" />
      <ErrorBanner message={error} />

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

      {/* Leave Data Import & Migration Tool — bulk-load opening balances / carry-forward / historical
          leave from a paste-CSV. Reached from here (like attendance/import and people/import). */}
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

import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { listLeaveTypes, listCompanies, listJobGrades } from '@/core/read';
import { listLeavePolicies } from '@/core/admin';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { entitlement } from '@/localization/my/leave';
import { Button, Card, ErrorBanner, Field, PageHeader, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { LeaveTypePanel, type EntitlementPolicy } from '@/components/leave-type-panel';
import {
  archiveLeaveTypeAction,
  createLeavePolicyAction,
  createLeaveTypeAction,
  deleteLeavePolicyAction,
  deleteLeaveTypeAction,
  openLeaveYearAction,
  runEarnedAccrualAction,
  setCompanyLeaveCycleAction,
  createJobGradeAction,
  archiveJobGradeAction,
  updateLeavePolicyAction,
  updateLeaveTypeAction,
} from '../actions';

export default async function LeaveConfigPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.leave');
  const { error } = await searchParams;
  const [types, policies, companies, grades] = await Promise.all([
    listLeaveTypes(s, { includeArchived: true }),
    listLeavePolicies(s),
    listCompanies(s),
    listJobGrades(s),
  ]);
  const gradeOptions = grades.map((g) => ({ id: g.id, name: g.name }));

  // Statutory floor display (MY pack): sample the three service bands. 6 (not 5)
  // catches the top band on both boundary conventions (annual ≤5 vs sick <5).
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
    } | null;
    const ep: EntitlementPolicy = {
      id: p.id,
      annualDays: Number(acc?.annualDays ?? 0),
      carryForwardMax: Math.max(0, Number(acc?.carryForwardMax ?? 0)),
      carryForwardExpiryMonth: acc?.carryForwardExpiryMonth ?? null,
      carryForwardExpiryDay: acc?.carryForwardExpiryDay ?? null,
      method: acc?.method,
      gradeId: p.gradeId,
      gradeName: p.gradeName,
      validFrom: p.validFrom,
      validTo: p.validTo,
    };
    const arr = polByType.get(p.leaveTypeId);
    if (arr) arr.push(ep);
    else polByType.set(p.leaveTypeId, [ep]);
  }
  for (const arr of polByType.values()) arr.sort((a, b) => b.validFrom.localeCompare(a.validFrom));

  const nextYear = new Date().getUTCFullYear() + 1;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title={t('pageTitle')} description={t('pageDescription')} />
      <ErrorBanner message={error} />

      <Card data-tour="leave-config">
        <SectionHeader title={t('typesSectionTitle')} count={types.length} />
        <ul className="divide-y divide-border">
          {types.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-muted-foreground">{t('noLeaveTypes')}</li>
          )}
          {types.map((t) => (
            <LeaveTypePanel
              key={t.id}
              id={t.id}
              name={t.name}
              code={t.code}
              archived={!!t.archivedAt}
              inUse={t.inUse}
              isAnnual={t.code === 'ANNUAL'}
              floorLabel={floorBands(t.code)}
              floor0={entitlement(t.code, 0)}
              eligibility={(t.eligibility as { gender?: string; maritalStatus?: string; minServiceMonths?: number } | null) ?? null}
              durations={(t.durations as string[] | null) ?? null}
              requiresDocument={t.requiresDocument}
              mandatoryAfterDays={t.mandatoryAfterDays ?? null}
              allowedMimeTypes={(t.allowedMimeTypes as string[] | null) ?? null}
              maxDocBytes={t.maxDocBytes}
              employeeRemarkRequired={t.employeeRemarkRequired}
              hrRemarkRequired={t.hrRemarkRequired}
              paid={t.paid}
              sendToPayroll={t.sendToPayroll}
              policies={polByType.get(t.id) ?? []}
              grades={gradeOptions}
              updateTypeAction={updateLeaveTypeAction}
              archiveTypeAction={archiveLeaveTypeAction}
              deleteTypeAction={deleteLeaveTypeAction}
              createPolicyAction={createLeavePolicyAction}
              updatePolicyAction={updateLeavePolicyAction}
              deletePolicyAction={deleteLeavePolicyAction}
            />
          ))}
        </ul>
        <form
          action={createLeaveTypeAction}
          className="grid grid-cols-1 items-end gap-3 border-t border-border p-4 sm:grid-cols-4"
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
    </div>
  );
}

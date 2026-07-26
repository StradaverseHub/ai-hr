import { getLocale, getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { scopedSession } from '@/lib/scope';
import { listCompanies, listDepartments, listEmployees } from '@/core/read';
import { listShiftsForTenant, rosterForRange, rosterVariance } from '@/core/roster';
import { listToilPolicies } from '@/core/toil';
import { Card, ErrorBanner, PageHeader, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { RosterGrid } from '@/components/roster-grid';
import { ToilElectButton } from '@/components/toil-elect-button';
import { copyRosterAction, generateRosterAction } from './actions';
import { isModuleEnabled } from '@/core/entitlements';

const DAY = 86_400_000;
const mondayOf = (iso: string): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  return new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY).toISOString().slice(0, 10);
};
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/**
 * Roster scheduling (ADR-0032 C3) — build the weekly shift roster for one company's employees. Manager/
 * admin only via RLS (can_admin_employment). Define shifts, then paint them onto the employee × week grid.
 */
export default async function RosterPage({
  searchParams,
}: {
  searchParams: Promise<{ companyId?: string; week?: string; error?: string; generated?: string; copied?: string }>;
}) {
  const { s, scopeIds } = await scopedSession();
  const t = await getTranslations('roster');
  const locale = await getLocale();
  const sp = await searchParams;

  const companies = (await listCompanies(s)).filter((c) => scopeIds.length === 0 || scopeIds.includes(c.id));
  if (companies.length === 0) {
    return (
      <div className="mx-auto max-w-6xl space-y-6">
        <PageHeader title={t('title')} description={t('subtitle')} />
        <Card className="p-4 text-sm text-muted-foreground">{t('noCompanies')}</Card>
      </div>
    );
  }
  const companyId = sp.companyId && companies.some((c) => c.id === sp.companyId) ? sp.companyId : companies[0].id;
  const todayIso = new Date().toISOString().slice(0, 10);
  const weekStart = mondayOf(sp.week && /^\d{4}-\d{2}-\d{2}$/.test(sp.week) ? sp.week : todayIso);
  const weekEnd = addDays(weekStart, 6);

  const [employees, shifts, roster, variance, toilPolicies, departments] = await Promise.all([
    listEmployees(s, [companyId]),
    // R33 f21d6eee — the shared shift library (tenant-wide); any shift can be painted onto any employee.
    listShiftsForTenant(s),
    rosterForRange(s, { from: weekStart, to: weekEnd }),
    rosterVariance(s, { from: weekStart, to: weekEnd, companyIds: [companyId], today: todayIso }),
    listToilPolicies(s, [companyId]),
    listDepartments(s, { companyIds: [companyId] }),
  ]);
  // Success banner for the roster generator: "employments.workingRows.restRows" packed by the action.
  const gen = sp.generated && /^\d+\.\d+\.\d+$/.test(sp.generated) ? sp.generated.split('.').map(Number) : null;
  // R17 3e8350db — success banner for "copy roster": the number of rows copied onto the target window.
  const copiedCount = sp.copied && /^\d+$/.test(sp.copied) ? Number(sp.copied) : null;
  const exceptions = variance.filter((v) => v.kind !== 'on_track');
  // "Bank in lieu" appears on rest-worked rows only when TOIL is on (env kill-switch AND company policy).
  const toilOn = isModuleEnabled(s, 'toil') && (toilPolicies[0]?.enabled ?? false);
  const kindBadge: Record<string, string> = {
    no_show: 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-400',
    late: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400',
    short: 'bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-400',
    rest_worked: 'bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-400',
  };
  const kindLabel: Record<string, string> = {
    no_show: t('kindNoShow'),
    late: t('kindLate'),
    short: t('kindShort'),
    rest_worked: t('kindRestWorked'),
  };
  const activeEmployees = employees.filter((e) => !e.terminatedOn);
  const empIds = new Set(activeEmployees.map((e) => e.employmentId));

  const initial: Record<string, { kind: 'shift'; shiftId: string } | { kind: 'rest' } | null> = {};
  for (const r of roster) {
    if (!empIds.has(r.employmentId)) continue;
    initial[`${r.employmentId}|${r.shiftDate}`] = r.isRestDay
      ? { kind: 'rest' }
      : r.shiftId
        ? { kind: 'shift', shiftId: r.shiftId }
        : null;
  }

  const dowFmt = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' });
  const dayFmt = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const weekDates = Array.from({ length: 7 }, (_, i) => {
    const iso = addDays(weekStart, i);
    const d = new Date(`${iso}T00:00:00Z`);
    return { iso, dow: dowFmt.format(d), day: dayFmt.format(d) };
  });
  const weekHref = (w: string) => `/roster?companyId=${companyId}&week=${w}`;
  const navBtn = 'rounded-md border border-border px-2.5 py-1 text-sm text-foreground hover:bg-muted';

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title={t('title')} description={t('subtitle')} />
      <ErrorBanner message={sp.error} />
      {gen && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-800 dark:border-emerald-500/25 dark:bg-emerald-500/10 dark:text-emerald-300">
          {t('generated', { employees: gen[0], working: gen[1], rest: gen[2] })}
        </div>
      )}
      {copiedCount != null && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-800 dark:border-emerald-500/25 dark:bg-emerald-500/10 dark:text-emerald-300">
          {copiedCount > 0 ? t('copiedDone', { rows: copiedCount }) : t('copiedEmpty')}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        {companies.length > 1 ? (
          <form method="get" className="flex items-center gap-2">
            <input type="hidden" name="week" value={weekStart} />
            <select name="companyId" defaultValue={companyId} className={inputCls}>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <button className={navBtn}>{t('switch')}</button>
          </form>
        ) : (
          <span className="text-sm font-medium">{companies[0].name}</span>
        )}
        <div className="flex items-center gap-2">
          <Link href={weekHref(addDays(weekStart, -7))} className={navBtn} aria-label={t('prevWeek')}>
            ‹
          </Link>
          <span className="text-sm text-muted-foreground">
            {weekDates[0].day} – {weekDates[6].day}
          </span>
          <Link href={weekHref(addDays(weekStart, 7))} className={navBtn} aria-label={t('nextWeek')}>
            ›
          </Link>
          <Link href={weekHref(todayIso)} className={navBtn}>
            {t('thisWeek')}
          </Link>
        </div>
      </div>

      {/* Configurable Multi-Shift Attendance Management: shift setup moved to Attendance Policy (admin-only).
          This screen is now purely for assigning shifts onto the calendar; the hint points anyone who looks
          for shift setup here to its new home. */}
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
          <span className="text-muted-foreground">{t('manageShiftsHint')}</span>
          <Link
            href="/admin/attendance"
            className="font-medium text-primary hover:underline"
          >
            {t('manageShiftsLink')} →
          </Link>
        </div>
      </Card>

      <Card>
        <SectionHeader title={t('generate')} />
        <div className="space-y-3 px-4 py-3">
          {shifts.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('createShiftFirst')}</p>
          ) : (
            <form action={generateRosterAction} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="companyId" value={companyId} />
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                {t('shifts')}
                <select name="shiftId" required className={inputCls}>
                  {shifts.map((sh) => (
                    <option key={sh.id} value={sh.id}>
                      {sh.code ? `${sh.code} · ` : ''}
                      {sh.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                {t('scope')}
                {/* A chosen department wins over the employee multi-select (the action prefers it). */}
                <select name="departmentId" defaultValue="" className={inputCls}>
                  <option value="">{t('scopeEmployees')}</option>
                  {departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {t('scopeDepartment')}: {d.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                {t('employee')}
                <select name="employmentIds" multiple size={4} className={`${inputCls} min-w-44`} aria-label={t('scopeEmployees')}>
                  {activeEmployees.map((e) => (
                    <option key={e.employmentId} value={e.employmentId}>
                      {e.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                {t('dateRange')}
                <span className="flex items-center gap-1.5">
                  <input type="date" name="from" required defaultValue={weekStart} className={inputCls} />
                  <span className="text-xs text-muted-foreground">–</span>
                  <input type="date" name="to" required defaultValue={addDays(weekStart, 27)} className={inputCls} />
                </span>
              </label>
              <button className={btnPrimary}>{t('generate')}</button>
            </form>
          )}
          <p className="text-xs text-muted-foreground">{t('generateHint')}</p>
        </div>
      </Card>

      {/* R17 3e8350db — "Copy roster schedules from previous weeks or months". Copies every roster row from a
          source window forward onto a target window starting at targetFrom, preserving each row's day-offset.
          Scoped to this company's active employees (posted as hidden employmentIds). Defaults: source = the
          previous week, target = the current week. */}
      <Card>
        <SectionHeader title={t('copyTitle')} />
        <div className="space-y-3 px-4 py-3">
          {activeEmployees.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('noEmployees')}</p>
          ) : (
            <form action={copyRosterAction} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="companyId" value={companyId} />
              {activeEmployees.map((e) => (
                <input key={e.employmentId} type="hidden" name="employmentIds" value={e.employmentId} />
              ))}
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                {t('copySource')}
                <span className="flex items-center gap-1.5">
                  <input type="date" name="sourceFrom" required defaultValue={addDays(weekStart, -7)} className={inputCls} />
                  <span className="text-xs text-muted-foreground">–</span>
                  <input type="date" name="sourceTo" required defaultValue={addDays(weekStart, -1)} className={inputCls} />
                </span>
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                {t('copyTargetStart')}
                <input type="date" name="targetFrom" required defaultValue={weekStart} className={inputCls} />
              </label>
              <button className={btnPrimary}>{t('copyButton')}</button>
            </form>
          )}
          <p className="text-xs text-muted-foreground">{t('copyHint')}</p>
        </div>
      </Card>

      <Card>
        <SectionHeader title={t('weeklyRoster')} count={activeEmployees.length} />
        <div className="px-4 py-3">
          {activeEmployees.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('noEmployees')}</p>
          ) : shifts.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('createShiftFirst')}</p>
          ) : (
            <RosterGrid
              weekDates={weekDates}
              employees={activeEmployees.map((e) => ({ employmentId: e.employmentId, name: e.name, code: e.employeeCode }))}
              shifts={shifts.map((sh) => ({ id: sh.id, name: sh.name, startTime: sh.startTime, endTime: sh.endTime }))}
              initial={initial}
            />
          )}
        </div>
      </Card>

      {exceptions.length > 0 && (
        <Card>
          <SectionHeader title={t('varianceTitle')} count={exceptions.length} />
          <ul className="divide-y divide-border">
            {exceptions.map((v) => (
              <li key={`${v.employmentId}|${v.shiftDate}`} className="flex items-center justify-between gap-2 px-4 py-2 text-sm">
                <div className="min-w-0">
                  <span className="font-medium">{v.name}</span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    {v.shiftDate} · {v.shiftName ?? t('rest')}
                  </span>
                </div>
                <span className="flex shrink-0 items-center gap-2">
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${kindBadge[v.kind]}`}>{kindLabel[v.kind]}</span>
                  {toilOn && v.kind === 'rest_worked' && (
                    <ToilElectButton employmentId={v.employmentId} workedDate={v.shiftDate} />
                  )}
                </span>
              </li>
            ))}
          </ul>
          <p className="px-4 pb-3 pt-1 text-xs text-muted-foreground">{t('varianceHint')}</p>
        </Card>
      )}
    </div>
  );
}

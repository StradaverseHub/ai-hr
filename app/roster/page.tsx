import { getLocale, getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { scopedSession } from '@/lib/scope';
import { listCompanies, listEmployees } from '@/core/read';
import { listShifts, rosterForRange, rosterVariance } from '@/core/roster';
import { listToilPolicies } from '@/core/toil';
import { Card, ErrorBanner, PageHeader, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { RosterGrid } from '@/components/roster-grid';
import { ShiftTimeFields } from '@/components/shift-time-fields';
import { ToilElectButton } from '@/components/toil-elect-button';
import { archiveShiftAction, createShiftAction, duplicateShiftAction } from './actions';

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
  searchParams: Promise<{ companyId?: string; week?: string; error?: string }>;
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

  const [employees, shifts, roster, variance, toilPolicies] = await Promise.all([
    listEmployees(s, [companyId]),
    listShifts(s, companyId),
    rosterForRange(s, { from: weekStart, to: weekEnd }),
    rosterVariance(s, { from: weekStart, to: weekEnd, companyIds: [companyId], today: todayIso }),
    listToilPolicies(s, [companyId]),
  ]);
  const exceptions = variance.filter((v) => v.kind !== 'on_track');
  // "Bank in lieu" appears on rest-worked rows only when TOIL is on (env kill-switch AND company policy).
  const toilOn = process.env.TOIL_ENABLED === 'true' && (toilPolicies[0]?.enabled ?? false);
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

      <Card>
        <SectionHeader title={t('shifts')} count={shifts.length} />
        <div className="space-y-3 px-4 py-3">
          {shifts.length > 0 && (
            <ul className="flex flex-wrap gap-2">
              {shifts.map((sh) => (
                <li key={sh.id} className="flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs">
                  <span>
                    {sh.code && <span className="font-medium">{sh.code} · </span>}
                    {sh.name} · {sh.startTime.slice(0, 5)}–{sh.endTime.slice(0, 5)}
                    {sh.crossesMidnight ? ' ⊕' : ''}
                  </span>
                  <form action={duplicateShiftAction}>
                    <input type="hidden" name="shiftId" value={sh.id} />
                    <input type="hidden" name="companyId" value={companyId} />
                    <button className="text-muted-foreground hover:text-foreground" aria-label={t('duplicate')} title={t('duplicate')}>
                      ⧉
                    </button>
                  </form>
                  <form action={archiveShiftAction}>
                    <input type="hidden" name="shiftId" value={sh.id} />
                    <input type="hidden" name="companyId" value={companyId} />
                    <button className="text-rose-600 hover:text-rose-700 dark:text-rose-400" aria-label={t('removeShift')}>
                      ×
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          )}
          <form action={createShiftAction} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="companyId" value={companyId} />
            <input name="name" required placeholder={t('shiftName')} className={`${inputCls} w-40`} />
            <input name="code" required placeholder={t('code')} className={`${inputCls} w-24`} aria-label={t('code')} />
            <ShiftTimeFields />
            <select name="differentialKind" defaultValue="" className={inputCls} aria-label={t('diffLabel')}>
              <option value="">{t('diffNone')}</option>
              <option value="percent">{t('diffPercent')}</option>
              <option value="flat_hourly">{t('diffFlatHourly')}</option>
              <option value="flat_per_shift">{t('diffPerShift')}</option>
            </select>
            <input name="differentialValue" type="number" min={0} step="0.01" placeholder={t('diffValue')} className={`${inputCls} w-24`} aria-label={t('diffValue')} />
            <button className={btnPrimary}>{t('addShift')}</button>
          </form>
          <p className="text-xs text-muted-foreground">{t('shiftHint')}</p>
          <p className="text-xs text-muted-foreground">{t('multiBreakStorageHint')}</p>
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
              employees={activeEmployees.map((e) => ({ employmentId: e.employmentId, name: e.name }))}
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

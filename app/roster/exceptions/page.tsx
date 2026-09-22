import { getLocale, getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { listCompanies } from '@/core/read';
import { isRosterException, rosterVariance } from '@/core/roster';
import { listToilPolicies } from '@/core/toil';
import { isModuleEnabledOrFalse } from '@/core/entitlements';
import { Card, PageHeader, SectionHeader, pageWideCls } from '@/components/ui';
import { ToilElectButton } from '@/components/toil-elect-button';
import { isMonthParam, monthOf, monthRange } from '@/lib/roster-month';
import { todayInKualaLumpur } from '@/lib/hr-date';

/**
 * ROSTER EXCEPTIONS — rostered shifts that did not go to plan (a57f0584 rev 2).
 *
 * WHY IT IS A SCREEN AND NOT A CARD. This was "This week's exceptions", a full listing rendered under the
 * month grid on /roster. Two things were wrong with that. It made the roster pay for rows it was not
 * there to show — every month view serialised every variance row into the RSC payload whether or not
 * anybody scrolled to it — and it put a LIST OF DAYS under a GRID OF DAYS, so the one screen answered two
 * different questions. The roster now carries only the count, on a button; the rows live here.
 *
 * IT IS THE SAME READ. `rosterVariance` is unchanged and `isRosterException` is the one spelling of "not
 * on track" (core/roster.ts), shared with the count behind the button — the number on the button and the
 * number of rows on this page cannot disagree, because neither decides it.
 *
 * SCOPE AND GUARD. `scopedSession`, like /roster itself: a supervisor who may read the roster may read
 * what went wrong on it, and `rosterVariance` is RLS-fenced to the employments this session can see. The
 * company set is the screen's own scoped list narrowed by `?companyId=`, exactly as the roster resolves
 * it, so this page can never span more companies than the roster it was opened from.
 *
 * THE QUERY STRING IS THE WAY BACK. month / companyId / bu / dept / q ride along untouched and Back
 * rebuilds the roster URL from them, so the administrator returns to the month and the narrowing they
 * left — the same contract as the Edit screen beside it.
 *
 * ⚠️ bu / dept / q ARE CARRIED, NOT APPLIED. `rosterVariance` takes companies and a date window, and
 * never took the three employee filters — on /roster this listing was already unfiltered by them. Making
 * them bite here would be a change to what an exception IS, not a move of where it is drawn, and it would
 * silently make this page's count differ from the button's. Left exactly as it was, deliberately.
 */
export default async function RosterExceptionsPage({
  searchParams,
}: {
  searchParams: Promise<{ companyId?: string; month?: string; bu?: string; dept?: string; q?: string }>;
}) {
  const { s, scopeIds } = await scopedSession();
  const t = await getTranslations('roster');
  const locale = await getLocale();
  const sp = await searchParams;

  const companies = (await listCompanies(s)).filter((c) => scopeIds.length === 0 || scopeIds.includes(c.id));
  const companyId = sp.companyId && companies.some((c) => c.id === sp.companyId) ? sp.companyId : null;
  const companyIds = companyId ? [companyId] : companies.map((c) => c.id);
  const todayIso = todayInKualaLumpur();
  const month = isMonthParam(sp.month) ? sp.month : monthOf(todayIso);
  const { from, to } = monthRange(month);

  // The roster's own query string, rebuilt so Back lands on the month and narrowing this was opened from.
  const back = new URLSearchParams({ month });
  if (companyId) back.set('companyId', companyId);
  if (sp.bu) back.set('bu', sp.bu);
  if (sp.dept) back.set('dept', sp.dept);
  if (sp.q) back.set('q', sp.q);

  const [variance, toilPolicies] = await Promise.all([
    rosterVariance(s, { from, to, companyIds, today: todayIso }),
    listToilPolicies(s, companyIds),
  ]);
  const exceptions = variance.filter(isRosterException);

  // "Bank in lieu" appears on rest-worked rows only when TOIL is on (env kill-switch AND company policy).
  const toilOn = isModuleEnabledOrFalse(s, 'toil') && (toilPolicies[0]?.enabled ?? false);
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

  // The same formatter contract as the grid's date headings: Intl in the viewer's locale, never a
  // hardcoded month table. A year is included because this list is read away from the month picker.
  const dateFmt = new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const monthFmt = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' });

  return (
    <div className={pageWideCls}>
      <PageHeader
        title={t('exceptionsTitle')}
        description={t('varianceHint')}
        back={{ href: `/roster?${back.toString()}`, label: t('exceptionsBack') }}
      />
      <Card>
        <SectionHeader title={monthFmt.format(new Date(`${from}T00:00:00Z`))} count={exceptions.length} />
        {exceptions.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">{t('exceptionsNone')}</p>
        ) : (
          <ul className="divide-y divide-border">
            {exceptions.map((v) => (
              <li key={`${v.employmentId}|${v.shiftDate}`} className="flex items-center justify-between gap-2 px-4 py-2 text-sm">
                <div className="min-w-0">
                  <span className="font-medium">{v.name}</span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    {dateFmt.format(new Date(`${v.shiftDate}T00:00:00Z`))} · {v.shiftName ?? t('rest')}
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
        )}
      </Card>
    </div>
  );
}

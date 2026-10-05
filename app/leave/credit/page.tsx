import type { ReactNode } from 'react';
import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { Download } from 'lucide-react';

import { scopedSession } from '@/lib/scope';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { listLeaveTypes, myEmployment } from '@/core/read';
import { isModuleEnabledOrFalse } from '@/core/entitlements';
import { listOwnLeaveCreditHistory } from '@/packs/leave/service';
import { Card, ErrorBanner, PageHeader, btnGhost, pagerPageNumCls, pagerPageNumCurrentCls, pagerStepCls, pagerStepMutedCls } from '@/components/ui';
import { ReplacementAvailabilityNotice } from '@/components/leave/replacement-availability-notice';
import { LeaveCreditHistoryFilterForm, LeaveCreditHistoryTable } from '@/components/leave/leave-credit-history';
import {
  APPROVAL_TABS,
  CREDIT_HISTORY_PAGE_SIZES,
  applyCreditHistoryFilters,
  creditHistoryParams,
  creditHistoryYearOptions,
  isFiltered,
  parseCreditHistoryQuery,
} from '@/lib/leave-credit-history';
import { cancelLeaveCreditRequestAction } from './actions';

/**
 * r389 bc3e203d · MY LEAVE › LEAVE CREDIT HISTORY (`/leave/credit`).
 *
 * ── WHAT THIS ADDRESS WAS, AND WHY IT KEPT THE ADDRESS ──────────────────────────────────────────────────
 * r343 built `/leave/credit` as a second home for the Leave Credit request FORM (the same component the My
 * Leave dialog opens) with the list of submitted requests underneath, reached from a "View my leave credit
 * requests" link beside the button. ba039150 removed the link and the form copy — two places to fill in one
 * form — and kept the list, which was the employee's ONLY list of their own requests (My Leave shows a pending
 * total; the balance card shows approved credits; /leave/history has none). bc3e203d turns that list into
 * this page: the same address (its SCREENS column in lib/permissions.ts is unchanged), now in the My Leave
 * menu, with tabs, filters, the credit's expiry and status, a read-only View panel, Cancel on a pending
 * request, page sizes, an export and a phone layout.
 *
 * ── WHOSE ROWS ───────────────────────────────────────────────────────────────────────────────────────────
 * `listOwnLeaveCreditHistory` resolves the signed-in PERSON's employments itself; nothing on the address can
 * name another employee. Filtering, counting, sorting and paging are lib/leave-credit-history.ts, shared with
 * the export, so the file always holds what the screen shows.
 *
 * ── GATED ON THE `toil` MODULE ENTITLEMENT ───────────────────────────────────────────────────────────────
 * The menu row is hidden without it (components/sidebar.tsx MODULE_OF_HREF); this page repeats the check
 * and explains instead of listing, through r219's notice — a hidden row is not a gate.
 *
 * SERVER COMPONENT. The two islands receive plain data and one server action; no translator and no closure
 * crosses the boundary (test/server-client-boundary.test.ts).
 */
export default async function LeaveCreditHistoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { s: session } = await scopedSession();
  const t = await getTranslations('leaveCreditHistory');
  const tMe = await getTranslations('me');
  const tPage = await getTranslations('pagination');
  const tLeave = await getTranslations('leave');
  const locale = await getLocale();
  const today = todayInKualaLumpur();
  const sp = await searchParams;
  const error = typeof sp.error === 'string' ? sp.error : undefined;

  const me = await myEmployment(session);
  if (!me) {
    return (
      <div className="mx-auto max-w-2xl">
        <Card className="p-8 text-center">
          <h1 className="text-lg font-semibold">{t('title')}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{tMe('notLinked')}</p>
        </Card>
      </div>
    );
  }

  const header = (actions?: ReactNode) => (
    <PageHeader title={t('title')} description={t('description')} actions={actions} />
  );

  if (!isModuleEnabledOrFalse(session, 'toil')) {
    return (
      <div className="space-y-6">
        {header()}
        <ReplacementAvailabilityNotice availability={{ allowed: false, reason: 'module_off' }} audience="self" />
      </div>
    );
  }

  // The Year filter defaults to the CURRENT year (the reporter's "Default: current year"), read off the same
  // Kuala Lumpur clock as everything else on this page; `?year=all` is every year.
  const currentYear = Number(today.slice(0, 4));
  const q = parseCreditHistoryQuery(sp, currentYear);
  const all = await listOwnLeaveCreditHistory(session);
  const { rows, counts } = applyCreditHistoryFilters(all, q.filters);

  // A page past the end (a filter narrowed the list under a deep link) opens the last page, not an empty one.
  const lastPage = Math.max(0, Math.ceil(rows.length / q.size) - 1);
  const page = Math.min(q.page, lastPage);
  const pageRows = rows.slice(page * q.size, page * q.size + q.size);
  const view = { filters: q.filters, page, size: q.size };
  const href = (over: Parameters<typeof creditHistoryParams>[1]) => {
    const qs = creditHistoryParams(view, over, currentYear).toString();
    return qs ? `/leave/credit?${qs}` : '/leave/credit';
  };

  // Names for the leave applications that used a credit — archived types included, because an application
  // made before a type was archived still used the credit.
  const usedTypeIds = new Set(pageRows.flatMap((r) => r.credit?.usage.map((u) => u.leaveTypeId) ?? []));
  const leaveTypeNames: Record<string, string> = {};
  if (usedTypeIds.size > 0) {
    for (const lt of await listLeaveTypes(session, { locale, includeArchived: true }))
      if (usedTypeIds.has(lt.id)) leaveTypeNames[lt.id] = lt.name;
  }
  // Every date in each request, so Cancel can name everything it withdraws — not just the rows on this page.
  const requestDates: Record<string, string[]> = {};
  for (const l of all) (requestDates[l.requestId] ??= []).push(l.workedDate);
  for (const k of Object.keys(requestDates)) requestDates[k].sort();

  const exportQs = creditHistoryParams({ filters: q.filters }, { page: 0, size: CREDIT_HISTORY_PAGE_SIZES[0] }, currentYear).toString();
  const exportHref = `/leave/credit/export${exportQs ? `?${exportQs}` : ''}`;
  const backQs = creditHistoryParams(view, {}, currentYear).toString();
  // Clear returns to the DEFAULTS — the current year, every status, every day type — keeping only the rows per
  // page the reader chose.
  const clearHref = q.size !== CREDIT_HISTORY_PAGE_SIZES[0] ? `/leave/credit?size=${q.size}` : '/leave/credit';

  const from = rows.length === 0 ? 0 : page * q.size + 1;
  const to = Math.min(rows.length, (page + 1) * q.size);
  const firstNum = Math.max(0, Math.min(page - 2, lastPage - 4));
  const pageNums = Array.from({ length: Math.min(5, lastPage + 1) }, (_, i) => firstNum + i);

  return (
    <div className="w-full min-w-0 space-y-4">
      {header(
        rows.length > 0 ? (
          <a href={exportHref} className={`${btnGhost} min-h-11`} data-testid="lch-export" aria-label={t('export')}>
            <Download className="size-4" aria-hidden />
            <span className="hidden sm:inline">{t('export')}</span>
          </a>
        ) : undefined,
      )}

      {error && <ErrorBanner message={error} />}

      <Card className="space-y-4 p-4">
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('approvalStatus')}</p>
          <nav aria-label={t('approvalStatus')} className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1" data-testid="lch-tabs">
            {APPROVAL_TABS.map((tab) => {
              const active = tab === q.filters.tab;
              return (
                <Link
                  key={tab}
                  href={href({ tab, page: 0 })}
                  aria-current={active ? 'page' : undefined}
                  data-tab={tab}
                  className={`inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm transition-colors ${
                    active ? 'border-primary/40 bg-primary/10 font-semibold text-foreground' : 'border-border text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {tab === 'all' ? t('tabAll') : tLeave(`status.${tab}`)}
                  <span className="rounded-full bg-muted px-1.5 text-xs font-semibold tabular-nums text-muted-foreground" data-testid={`lch-count-${tab}`}>
                    {counts[tab]}
                  </span>
                </Link>
              );
            })}
          </nav>
        </div>
        <LeaveCreditHistoryFilterForm
          filters={q.filters}
          years={creditHistoryYearOptions(all, currentYear)}
          size={q.size !== CREDIT_HISTORY_PAGE_SIZES[0] ? q.size : null}
          clearHref={clearHref}
        />
      </Card>

      <Card className="overflow-hidden p-0">
        {pageRows.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground" data-testid="lch-empty">
            {all.length === 0 ? t('empty') : isFiltered(q.filters) ? t('emptyFiltered') : t('emptyTab')}
          </p>
        ) : (
          <LeaveCreditHistoryTable
            rows={pageRows}
            today={today}
            leaveTypeNames={leaveTypeNames}
            requestDates={requestDates}
            cancelAction={cancelLeaveCreditRequestAction}
            back={backQs}
          />
        )}

        {/* Rows per page, position, and the page steps — the shared pager's look and words, with the three
            sizes the reporter asked for (the shared <Pager> offers 25 / 50 / 100 / 200 / All). */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3" data-testid="lch-pager">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>{tPage('rowsPerPage')}</span>
            <span className="inline-flex overflow-hidden rounded-md border border-border">
              {CREDIT_HISTORY_PAGE_SIZES.map((n) => (
                <Link
                  key={n}
                  href={href({ size: n, page: 0 })}
                  aria-current={n === q.size ? 'true' : undefined}
                  className={`min-w-9 px-2 py-1 text-center tabular-nums ${n === q.size ? 'bg-primary text-primary-foreground' : 'text-foreground hover:bg-muted'}`}
                >
                  {n}
                </Link>
              ))}
            </span>
          </div>
          <span className="text-xs tabular-nums text-muted-foreground">
            {from > 0 ? tPage('range', { from, to, total: rows.length }) : tPage('rangeEmpty', { total: rows.length })}
          </span>
          <div className="flex items-center gap-2 text-sm">
            {page > 0 ? <Link href={href({ page: 0 })} className={pagerStepCls}>{tPage('first')}</Link> : <span className={pagerStepMutedCls}>{tPage('first')}</span>}
            {page > 0 ? <Link href={href({ page: page - 1 })} className={pagerStepCls}>{tPage('previous')}</Link> : <span className={pagerStepMutedCls}>{tPage('previous')}</span>}
            {pageNums.map((n) =>
              n === page ? (
                <span key={n} aria-current="page" className={pagerPageNumCurrentCls}>{n + 1}</span>
              ) : (
                <Link key={n} href={href({ page: n })} aria-label={tPage('pageNumber', { n: n + 1 })} className={pagerPageNumCls}>{n + 1}</Link>
              ),
            )}
            {page < lastPage ? <Link href={href({ page: page + 1 })} className={pagerStepCls}>{tPage('next')}</Link> : <span className={pagerStepMutedCls}>{tPage('next')}</span>}
            {page < lastPage ? <Link href={href({ page: lastPage })} className={pagerStepCls}>{tPage('last')}</Link> : <span className={pagerStepMutedCls}>{tPage('last')}</span>}
          </div>
        </div>
      </Card>
    </div>
  );
}

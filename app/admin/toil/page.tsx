import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { requireAdmin } from '@/lib/authz';
import { getScopeIds } from '@/lib/scope';
import { listCompanies, replacementLeaveSummary } from '@/core/read';
import { Card, ErrorBanner, PageHeader, btnPrimary } from '@/components/ui';
import { runToilExpiryAction, closeReplacementLeaveYearAction } from '../actions';
import { isModuleEnabledOrFalse } from '@/core/entitlements';

export default async function ToilPolicyPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    processed?: string;
    converted?: string;
    lapsed?: string;
    skipped?: string;
    closed?: string;
    closedAlready?: string;
    closedProcessed?: string;
    closedConverted?: string;
    closedLapsed?: string;
    closedCarried?: string;
  }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.toilPolicy');
  const { error, processed, converted, lapsed, skipped, closed, closedAlready, closedProcessed, closedConverted, closedLapsed, closedCarried } =
    await searchParams;
  const moduleOn = isModuleEnabledOrFalse(s, 'toil');

  const companies = await listCompanies(s);
  const scopeIds = await getScopeIds(companies.map((c) => c.id));
  const visible = companies.filter((c) => scopeIds.includes(c.id));
  // RL Control Engine (0113): the active-vs-expired ledger split across everyone in scope.
  //
  // READ UNCONDITIONALLY as of ADR-0077 slice 3. It used to be `moduleOn ? … : null`, which is the UI
  // half of the defect that ungating `runToilExpiry` / `closeReplacementLeaveYear` (core/toil.ts) was
  // meant to close: a tenant whose `toil` entitlement lapses (trial end, downgrade, non-payment) still
  // owes its employees the days they already banked — for a First-Schedule-eligible employee that debt
  // is STATUTORY and must convert to pay, never lapse — and hiding the ledger meant an admin could not
  // even SEE the outstanding liability, let alone settle it. Ungating the services alone changed
  // nothing in production, because this page is their ONLY caller (there is no cron; see
  // app/admin/actions.ts runToilExpiryAction). The read itself is ungated (core/read.ts) and costs one
  // query; with no accruals it returns zeros.
  const summary = await replacementLeaveSummary(s, visible.map((c) => c.id));
  // Is there an already-incurred obligation still on the books? `activeAccruals` counts accruals with
  // unspent days remaining, which is exactly what the two sweeps below would settle.
  const outstanding = summary.activeAccruals > 0;
  // WHAT THE ENTITLEMENT STILL GOVERNS is NEW accrual (the policy editor above, and the roster's
  // "bank in lieu" affordance). WHAT IT MUST NOT GOVERN is winding down what was already banked.
  const showSettlement = moduleOn || outstanding;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader title={t('pageTitle')} description={t('pageDescription')} />
      <ErrorBanner message={error} />

      {processed !== undefined && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50/70 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300">
          {Number(processed) === 0
            ? t('processedNone')
            : t('processedBanner', { processed: Number(processed), converted: Number(converted ?? 0), lapsed: Number(lapsed ?? 0) })}
        </div>
      )}

      {/* THE PARTIAL SWEEP, SAID OUT LOUD (review r3). `runToilExpiry` reads only accruals this caller
          can settle (core/toil.ts SETTLEABLE_BY_CALLER) so a dual-scoped operator no longer rolls the
          whole transaction back — but that turns "another company's statutory convert-to-pay is
          overdue and you may not settle it" into the same green banner as "nothing was due". AMBER,
          not emerald: an unsettled statutory obligation is not a success. */}
      {Number(skipped ?? 0) > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50/70 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          {t('processedSkipped', { skipped: Number(skipped) })}
        </div>
      )}

      {closed !== undefined && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50/70 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300">
          {Number(closedAlready) === 1
            ? t('closeAlready')
            : t('closeBanner', {
                processed: Number(closedProcessed ?? 0),
                converted: Number(closedConverted ?? 0),
                lapsed: Number(closedLapsed ?? 0),
                carried: Number(closedCarried ?? 0),
              })}
        </div>
      )}

      {!moduleOn && (
        <div className="rounded-lg border border-amber-200 bg-amber-50/70 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          {outstanding ? t('moduleOffWindDown', { accruals: summary.activeAccruals }) : t('moduleOff')}
        </div>
      )}

      {/*
        THE POLICY EDITOR MOVED (296fc027) — to HR Admin › Leave Config › Replacement Leave, which is now
        the single place replacement leave is CONFIGURED. What is left on this page is the running balance
        LEDGER and the two settlement sweeps, and that division is the wind-down argument made physical
        rather than a tidying-up of tabs.

        WHY THE SWEEPS DID NOT GO WITH IT, which is the thing to preserve if this page is ever edited
        again. `runToilExpiry` and `closeReplacementLeaveYear` are deliberately NOT entitlement-gated
        (core/toil.ts states this at length): a tenant whose `toil` module lapses — trial end, downgrade,
        non-payment — still owes its employees the days they already banked, and for a First-Schedule
        eligible employee that debt is STATUTORY and must convert to pay, never lapse. The configuration
        page is read-only without the module. Moving the settle-and-expire buttons behind it would have
        re-gated, through the UI, the exact obligation that ungating those services exists to protect —
        and this page is their ONLY caller (there is no cron). Configuration and settlement are gated
        differently on purpose, so they live on different screens.

        The read-only-not-hidden reasoning that used to sit here went WITH the form it was about; it is
        reproduced in full at the top of app/admin/leave/replacement/page.tsx.
      */}
      <Card className="p-4">
        <h2 className="text-sm font-semibold text-foreground">{t('configMovedTitle')}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t('configMovedHint')}{' '}
          <Link href="/admin/leave/replacement" className="font-medium text-primary hover:underline">
            {t('configMovedLink')}
          </Link>
        </p>
      </Card>

      {visible.length === 0 && <p className="text-sm text-muted-foreground">{t('noCompanies')}</p>}

      {showSettlement && (
        <Card className="p-4">
          <h2 className="text-sm font-semibold text-foreground">{t('ledgerTitle')}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('ledgerHint')}</p>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label={t('ledgerActive')} value={summary.active} />
            <Stat label={t('ledgerTaken')} value={summary.taken} />
            <Stat label={t('ledgerExpired')} value={summary.expired} />
            <Stat label={t('ledgerConverted')} value={summary.convertedToPay} />
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            {summary.soonestExpiry ? t('ledgerSoonest', { date: summary.soonestExpiry }) : t('ledgerNoneActive')}
          </p>
        </Card>
      )}

      {showSettlement && visible.length > 0 && (
        <Card className="p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-foreground">{t('processTitle')}</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">{t('processHint')}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <form action={runToilExpiryAction}>
                <button className={btnPrimary}>{t('processButton')}</button>
              </form>
              <form action={closeReplacementLeaveYearAction}>
                <button className={btnPrimary}>{t('closeYearButton')}</button>
              </form>
            </div>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">{t('closeYearHint')}</p>
        </Card>
      )}

      <p className="px-1 text-xs text-muted-foreground">{t('footnote')}</p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border bg-muted/30 px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums text-foreground">{value}</div>
    </div>
  );
}

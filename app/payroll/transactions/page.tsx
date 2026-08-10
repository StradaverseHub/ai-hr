import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { Card, PageHeader } from '@/components/ui';
import { isModuleEnabledOrFalse } from '@/core/entitlements';

/**
 * Feature 1.2 — Transaction hub (information architecture over existing payroll capability).
 * Re-surfaces the already-wired transaction functions (Fixed / Individual incl. TP1+zakat) as a
 * card grid under the Payroll module. No schema, no kernel change. Per the approved plan we render
 * ONLY the wired functions — no "coming soon" placeholders for CP38/Loan/EA/Import (those are
 * separate backlog items, each with its own ADR).
 *
 * Flag posture (plan step 1): typed pay components are read by the kernel only when
 * TYPED_PAY_COMPONENTS_ENABLED. When off, components entered via these functions do nothing to the
 * payslip, so we show a visible gated banner rather than implying impact.
 */
export default async function PayrollTransactionsPage() {
  const s = await requireAdmin();
  const t = await getTranslations('payroll.transactions');
  const typedComponentsOn = isModuleEnabledOrFalse(s, 'typed_pay_components');

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title={t('title')} description={t('subtitle')} />

      {!typedComponentsOn && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
          <p className="font-medium">{t('gatedTitle')}</p>
          <p className="mt-1 text-xs">{t('gatedBody')}</p>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Card className="flex flex-col p-5">
          <h2 className="text-base font-semibold">{t('hub.fixedTitle')}</h2>
          <p className="mt-1 flex-1 text-sm text-muted-foreground">{t('hub.fixedDesc')}</p>
          <Link
            href="/payroll/transactions/fixed"
            className="mt-4 inline-flex w-fit items-center rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            {t('hub.fixedCta')}
          </Link>
        </Card>

        <Card className="flex flex-col p-5">
          <h2 className="text-base font-semibold">{t('hub.individualTitle')}</h2>
          <p className="mt-1 flex-1 text-sm text-muted-foreground">{t('hub.individualDesc')}</p>
          <Link
            href="/payroll/transactions/individual"
            className="mt-4 inline-flex w-fit items-center rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            {t('hub.individualCta')}
          </Link>
        </Card>

        <Card className="flex flex-col p-5">
          <h2 className="text-base font-semibold">{t('hub.tp1Title')}</h2>
          <p className="mt-1 flex-1 text-sm text-muted-foreground">{t('hub.tp1Desc')}</p>
          <Link
            href="/payroll/transactions/tp1"
            className="mt-4 inline-flex w-fit items-center rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            {t('hub.tp1Cta')}
          </Link>
        </Card>

        <Card className="flex flex-col p-5">
          <h2 className="text-base font-semibold">{t('hub.zakatTitle')}</h2>
          <p className="mt-1 flex-1 text-sm text-muted-foreground">{t('hub.zakatDesc')}</p>
          <Link
            href="/payroll/transactions/zakat"
            className="mt-4 inline-flex w-fit items-center rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            {t('hub.zakatCta')}
          </Link>
        </Card>

        {/* 7076f8af — the two cards the run screen gave up. The reporter asked for "Import Pay Components
            (CSV)" to live here by name, and for everything you may need to correct before a run is
            calculated to stop being a fixture of the screen a Reset lands on. The adjustment panel's
            primary home is the run flow's Review step; this is its second door. Neither is a new
            capability: both drive the same server actions against the same draft batch. */}
        <Card className="flex flex-col p-5">
          <h2 className="text-base font-semibold">{t('hub.adjustmentsTitle')}</h2>
          <p className="mt-1 flex-1 text-sm text-muted-foreground">{t('hub.adjustmentsDesc')}</p>
          <Link
            href="/payroll/transactions/adjustments"
            className="mt-4 inline-flex w-fit items-center rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            {t('hub.adjustmentsCta')}
          </Link>
        </Card>

        <Card className="flex flex-col p-5">
          <h2 className="text-base font-semibold">{t('hub.componentImportTitle')}</h2>
          <p className="mt-1 flex-1 text-sm text-muted-foreground">{t('hub.componentImportDesc')}</p>
          <Link
            href="/payroll/transactions/import-components"
            className="mt-4 inline-flex w-fit items-center rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            {t('hub.componentImportCta')}
          </Link>
        </Card>

        <Card className="flex flex-col p-5">
          <h2 className="text-base font-semibold">{t('hub.loansTitle')}</h2>
          <p className="mt-1 flex-1 text-sm text-muted-foreground">{t('hub.loansDesc')}</p>
          <Link
            href="/admin/loans"
            className="mt-4 inline-flex w-fit items-center rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            {t('hub.loansCta')}
          </Link>
        </Card>

        {/* Transaction View (feedback a4a05174) was surfaced here as a card; feedback 59178702
            promoted it to a standalone top-level Payroll tab (/payroll/transaction-view), so the
            sub-function entry point under Transactions is intentionally removed. */}

        {/* Feedback 8bf6dfa1: relocated entry point for the (fully built, requireAdmin-gated)
            payroll history import — moved here from the /payroll list header so admin data
            migration sits with the other data-maintenance tools. Unconditional like Loans:
            history import writes its own records, unrelated to TYPED_PAY_COMPONENTS_ENABLED. */}
        <Card className="flex flex-col p-5">
          <h2 className="text-base font-semibold">{t('hub.importHistoryTitle')}</h2>
          <p className="mt-1 flex-1 text-sm text-muted-foreground">{t('hub.importHistoryDesc')}</p>
          <Link
            href="/payroll/history-import"
            className="mt-4 inline-flex w-fit items-center rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            {t('hub.importHistoryCta')}
          </Link>
        </Card>
      </div>
    </div>
  );
}

import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { ErrorBanner, PageHeader } from '@/components/ui';
import { PayrollAdjustmentsPanel } from '../../adjustments-panel';
import { DraftRunPicker, draftRunsInScope, resolveDraftRun } from '../draft-run-picker';

/**
 * Transactions → Payroll Inputs (7076f8af). The draft-run adjustment panel's second home.
 *
 * The reporter asked for the panel to come off the screen a Reset lands on, and it has: its primary home is
 * now the run flow's Review step, which is the moment before the figures are computed. This screen exists
 * because the plan promised it is "also reachable from Transactions" — an operator who wants to bring in
 * approved overtime, approved claims, loan instalments, shift differential, fixed zakat, declared TP1
 * relief or attendance allowances without walking the whole run flow has a door.
 *
 * NOTHING NEW BEHIND IT. Same seven server actions, same batchId contract, same draft-only refusals in the
 * services. What this page adds is only the question the run screen never had to ask: which draft?
 */
export default async function PayrollTransactionsAdjustmentsPage({
  searchParams,
}: {
  searchParams: Promise<{ batchId?: string; error?: string; iPage?: string; iSize?: string }>;
}) {
  await requireAdmin();
  const t = await getTranslations('payroll.transactions');
  const { batchId, error, iPage, iSize } = await searchParams;
  const drafts = await draftRunsInScope();
  // An id that is not a draft in THIS admin's scope resolves to null and the chooser is shown instead —
  // the address bar is never taken at its word.
  const chosen = resolveDraftRun(drafts, batchId) ?? (drafts.length === 1 ? drafts[0] : null);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        title={t('adjustments.title')}
        description={t('adjustments.subtitle')}
        back={{ href: '/payroll/transactions', label: t('title') }}
      />
      <ErrorBanner message={error} />
      <DraftRunPicker drafts={drafts} basePath="/payroll/transactions/adjustments" selectedId={chosen?.id} />
      {chosen && (
        <PayrollAdjustmentsPanel
          batchId={chosen.id}
          returnTo={`/payroll/transactions/adjustments?batchId=${chosen.id}`}
          pager={{
            basePath: '/payroll/transactions/adjustments',
            params: { batchId: chosen.id },
            page: iPage,
            size: iSize,
          }}
        />
      )}
    </div>
  );
}

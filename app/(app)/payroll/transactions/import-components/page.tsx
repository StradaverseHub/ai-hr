import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { Card, PageHeader, SectionHeader } from '@/components/ui';
import { isModuleEnabledOrFalse } from '@/core/entitlements';
import { ComponentImport } from '../../[batchId]/component-import';
import { DraftRunPicker, draftRunsInScope, resolveDraftRun } from '../draft-run-picker';

/**
 * Transactions → Import pay components (CSV) (7076f8af).
 *
 * The reporter asked for this to move "under Payroll, into Transactions", and unlike the adjustment panel
 * it travels to ONE destination: it is deliberately NOT also rendered on the run flow's Review step. The
 * plan promises it comes off the run path entirely, and a bulk CSV load is preparation, not a last look
 * before processing.
 *
 * Same component, same two actions (dry-run preview then commit), same service. `importBatchComponents`
 * refuses a non-draft batch, which is why the chooser only ever offers drafts.
 *
 * The typed-pay-components gate is the run screen's, unchanged: with the flag off, imported components are
 * not read by the kernel, so the screen says so instead of accepting a file that would do nothing.
 */
export default async function PayrollComponentImportPage({
  searchParams,
}: {
  searchParams: Promise<{ batchId?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('payroll.transactions');
  const tb = await getTranslations('payroll.batch');
  const { batchId } = await searchParams;
  const typedComponentsOn = isModuleEnabledOrFalse(s, 'typed_pay_components');
  const drafts = await draftRunsInScope();
  const chosen = resolveDraftRun(drafts, batchId) ?? (drafts.length === 1 ? drafts[0] : null);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        title={t('componentImport.title')}
        description={t('componentImport.subtitle')}
        back={{ href: '/payroll/transactions', label: t('title') }}
      />

      {!typedComponentsOn && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
          <p className="font-medium">{t('gatedTitle')}</p>
          <p className="mt-1 text-xs">{t('gatedBody')}</p>
        </div>
      )}

      <DraftRunPicker drafts={drafts} basePath="/payroll/transactions/import-components" selectedId={chosen?.id} />

      {chosen && typedComponentsOn && (
        <Card>
          <SectionHeader title={tb('componentImport.title')} />
          <div className="px-4 pb-4">
            <p className="mb-3 text-xs text-muted-foreground">{tb('componentImport.description')}</p>
            <ComponentImport batchId={chosen.id} />
          </div>
        </Card>
      )}
    </div>
  );
}

import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { listClaimTypes } from '@/core/claims';
import { Button, Card, ErrorBanner, Field, PageHeader, SectionHeader, inputCls } from '@/components/ui';
import { ClaimTypePanel } from '@/components/claim-type-panel';
import { ClaimsTabs } from '@/components/claims-tabs';
import {
  archiveClaimItemAction,
  archiveClaimTypeAction,
  createClaimItemAction,
  createClaimTypeAction,
  deleteClaimTypeAction,
  updateClaimItemAction,
  updateClaimTypeAction,
} from './actions';

export default async function ClaimsConfigPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.claims');
  const { error } = await searchParams;
  const types = await listClaimTypes(s);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title={t('title')} description={t('subtitle')} />
      <ClaimsTabs active="types" />
      <ErrorBanner message={error} />

      <Card className="overflow-hidden">
        <SectionHeader title={t('typesTitle')} count={types.length} />
        {types.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <ul className="divide-y divide-border">
            {types.map((ct) => (
              <ClaimTypePanel
                key={ct.id}
                id={ct.id}
                code={ct.code}
                name={ct.name}
                description={ct.description}
                defaultTaxable={ct.defaultTaxable}
                requiresReceipt={ct.requiresReceipt}
                maxReceiptAgeDays={ct.maxReceiptAgeDays}
                items={ct.items}
                updateAction={updateClaimTypeAction}
                archiveAction={archiveClaimTypeAction}
                deleteAction={deleteClaimTypeAction}
                createItemAction={createClaimItemAction}
                updateItemAction={updateClaimItemAction}
                archiveItemAction={archiveClaimItemAction}
              />
            ))}
          </ul>
        )}
      </Card>

      <Card className="p-4">
        <h2 className="mb-3 text-sm font-semibold">{t('newTitle')}</h2>
        <form action={createClaimTypeAction} className="grid gap-3 sm:grid-cols-2">
          <Field label={t('codeLabel')}>
            <input name="code" required placeholder="MEDICAL" className={`${inputCls} w-full font-mono uppercase`} />
          </Field>
          <Field label={t('nameLabel')}>
            <input name="name" required placeholder="Medical" className={`${inputCls} w-full`} />
          </Field>
          <label className="flex flex-col gap-1.5 sm:col-span-2">
            <span className="text-xs font-medium text-muted-foreground">{t('descriptionLabel')}</span>
            <textarea name="description" rows={2} className={inputCls} />
          </label>
          <Field label={t('maxReceiptAgeLabel')}>
            <input name="maxReceiptAgeDays" type="number" min="1" step="1" placeholder={t('maxReceiptAgeHint')} className={`${inputCls} w-full`} />
          </Field>
          <div className="flex flex-wrap items-center gap-4 sm:col-span-2">
            <label className="flex h-9 items-center gap-2 text-sm">
              <input type="checkbox" name="defaultTaxable" className="size-4" />
              {t('defaultTaxableLabel')}
            </label>
            <label className="flex h-9 items-center gap-2 text-sm">
              <input type="checkbox" name="requiresReceipt" defaultChecked className="size-4" />
              {t('requiresReceiptLabel')}
            </label>
            <Button type="submit" className="ml-auto">{t('create')}</Button>
          </div>
        </form>
        <p className="mt-3 text-xs text-muted-foreground">{t('taxableHint')}</p>
        <p className="mt-1 text-xs text-muted-foreground">{t('limitsMovedHint')}</p>
      </Card>
    </div>
  );
}

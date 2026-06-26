import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { listClaimTypes } from '@/core/claims';
import { Button, Card, ErrorBanner, Field, PageHeader, SectionHeader, inputCls } from '@/components/ui';
import { ClaimTypePanel } from '@/components/claim-type-panel';
import {
  archiveClaimItemAction,
  archiveClaimTypeAction,
  createClaimItemAction,
  createClaimTypeAction,
  setClaimPolicyAction,
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
      <PageHeader
        title={t('title')}
        description={t('subtitle')}
        actions={
          <a
            href="/admin/claims/reimbursements"
            className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            {t('reimbursementsLink')}
          </a>
        }
      />
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
                defaultTaxable={ct.defaultTaxable}
                requiresReceipt={ct.requiresReceipt}
                policy={ct.policy}
                items={ct.items}
                updateAction={updateClaimTypeAction}
                archiveAction={archiveClaimTypeAction}
                setPolicyAction={setClaimPolicyAction}
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
        <form action={createClaimTypeAction} className="flex flex-wrap items-end gap-3">
          <Field label={t('codeLabel')}>
            <input name="code" required placeholder="MEDICAL" className={`${inputCls} w-36 font-mono uppercase`} />
          </Field>
          <Field label={t('nameLabel')}>
            <input name="name" required placeholder="Medical" className={`${inputCls} w-48`} />
          </Field>
          <label className="flex h-9 items-center gap-2 text-sm">
            <input type="checkbox" name="defaultTaxable" className="size-4" />
            {t('defaultTaxableLabel')}
          </label>
          <label className="flex h-9 items-center gap-2 text-sm">
            <input type="checkbox" name="requiresReceipt" defaultChecked className="size-4" />
            {t('requiresReceiptLabel')}
          </label>
          <Button type="submit">{t('create')}</Button>
        </form>
        <p className="mt-3 text-xs text-muted-foreground">{t('taxableHint')}</p>
      </Card>
    </div>
  );
}

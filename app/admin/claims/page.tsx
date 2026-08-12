import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { CLAIM_FIELD_KINDS, listClaimFormFields, listClaimTypes } from '@/core/claims';
import { Button, Card, ErrorBanner, Field, PageHeader, inputCls } from '@/components/ui';
import { ClaimTypePanel } from '@/components/claim-type-panel';
import { ClaimsTabs } from '@/components/claims-tabs';
import {
  archiveClaimFormFieldAction,
  archiveClaimItemAction,
  archiveClaimTypeAction,
  createClaimFormFieldAction,
  createClaimItemAction,
  createClaimTypeAction,
  deleteClaimTypeAction,
  moveClaimFormFieldAction,
  updateClaimFormFieldAction,
  updateClaimItemAction,
  updateClaimTypeAction,
} from './actions';

export default async function ClaimsConfigPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.claims');
  const { error } = await searchParams;
  const types = await listClaimTypes(s);
  // e7eb5d83 point 2 — one designed-form read per claim type, so the designer can render inside each
  // panel. Production carries four claim types; this is four small reads on a page that already does one
  // per type for its items. If a tenant ever grows this list, fold it into listClaimTypes rather than
  // paginating a config screen.
  const fieldsByType = new Map(
    await Promise.all(
      types.map(async (ct) => [ct.id, await listClaimFormFields(s, { claimTypeId: ct.id })] as const),
    ),
  );

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title={t('title')} description={t('subtitle')} />
      <ClaimsTabs active="types" />
      <ErrorBanner message={error} />

      <Card className="overflow-hidden">
        {/* e7eb5d83 point 1 — the create form used to sit permanently open in a Card of its own below the
            list, with no way to put it away and no "Add new" anywhere. It now lives behind a disclosure
            whose control is the top-right of this card's header.

            NATIVE <details>, NOT A CLIENT ISLAND, and that is deliberate: the form posts a server action,
            so a client island would either drag this page across the RSC boundary or need the action
            passed down as a prop. components/ui has no disclosure primitive, and this needs no state.

            `open={error != null}` is the load-bearing half. createClaimTypeAction redirects back here with
            ?error= on a refusal; with the panel closed by default the message would be visible in the
            banner while the form that produced it was hidden, so the admin would have nothing to correct.
            Any ?error= forces it open — over-opening is harmless, hiding the failing form is not. */}
        <details className="group" open={error != null}>
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 border-b border-border px-4 py-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
            <span>
              {t('typesTitle')}
              <span className="ml-2 text-muted-foreground">({types.length})</span>
            </span>
            <span className="inline-flex h-8 items-center rounded-md border border-input bg-transparent px-3 text-xs font-medium transition-colors hover:bg-accent hover:text-accent-foreground">
              <span className="group-open:hidden">{t('addNewType')}</span>
              <span className="hidden group-open:inline">{t('hideNewType')}</span>
            </span>
          </summary>
          <div className="border-b border-border bg-muted/20 p-4">
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
                <label className="flex h-9 items-center gap-2 text-sm">
                  <input type="checkbox" name="isMileage" className="size-4" />
                  {t('isMileageLabel')}
                </label>
                <Button type="submit" className="ml-auto">{t('create')}</Button>
              </div>
            </form>
            <p className="mt-3 text-xs text-muted-foreground">{t('taxableHint')}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t('limitsMovedHint')}</p>
          </div>
        </details>
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
                isMileage={ct.isMileage}
                items={ct.items}
                formFields={fieldsByType.get(ct.id) ?? []}
                fieldKinds={[...CLAIM_FIELD_KINDS]}
                updateAction={updateClaimTypeAction}
                archiveAction={archiveClaimTypeAction}
                deleteAction={deleteClaimTypeAction}
                createItemAction={createClaimItemAction}
                updateItemAction={updateClaimItemAction}
                archiveItemAction={archiveClaimItemAction}
                createFieldAction={createClaimFormFieldAction}
                updateFieldAction={updateClaimFormFieldAction}
                moveFieldAction={moveClaimFormFieldAction}
                archiveFieldAction={archiveClaimFormFieldAction}
              />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

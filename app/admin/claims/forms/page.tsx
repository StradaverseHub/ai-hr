import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { requireAdmin } from '@/lib/authz';
import { CLAIM_FIELD_KINDS, listClaimFormFields, listClaimTypes } from '@/core/claims';
import { Button, Card, ErrorBanner, Field, PageHeader, SectionHeader, inputCls } from '@/components/ui';
import { ClaimsTabs } from '@/components/claims-tabs';
import {
  archiveClaimFormFieldAction,
  createClaimFormFieldAction,
  moveClaimFormFieldAction,
  updateClaimFormFieldAction,
} from './actions';

/**
 * Claim Form Designer (e7eb5d83) — the one thing of the reporter's three that was genuinely absent. Every
 * claim type asked the same four questions and there was no table anywhere that could say otherwise.
 *
 * ⚠️ THE FOUR BUILT-IN ROWS AT THE TOP ARE NOT DATA. Amount, date, description and the receipt are real
 * columns on claim_request that the per-claim cap / monthly / annual / lifetime arithmetic, the receipt-age
 * window and taxable payroll routing all read. They are rendered here as fixed rows with no Remove control
 * so the admin can SEE the whole form, and the guarantee that they survive is enforced in the service
 * (BUILT_IN_FIELD_KEYS in core/claims.ts refuses their keys), not by the absence of a button — a forged POST
 * reaches the action, not the screen.
 *
 * Selection is in the URL (?claimTypeId=) and validated against the tenant's live claim types, so an
 * unknown or other-tenant id falls back to the first type instead of 500ing or reaching across tenants.
 */
export default async function ClaimFormsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; claimTypeId?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.claims');
  const { error, claimTypeId: rawTypeId } = await searchParams;
  const types = await listClaimTypes(s);
  const selected = types.find((ct) => ct.id === rawTypeId) ?? types[0] ?? null;
  const fields = selected ? await listClaimFormFields(s, { claimTypeId: selected.id }) : [];

  const pillCls = (on: boolean) =>
    `rounded-full border px-3 py-1 text-xs transition-colors ${
      on ? 'border-primary bg-primary/10 font-medium text-primary' : 'border-border text-muted-foreground hover:text-foreground'
    }`;

  // The four that are always on every claim form. Order matches the employee form.
  const builtIns = [
    { key: 'amount', label: t('builtInAmount'), kind: t('fieldKind_money') },
    { key: 'incurredOn', label: t('builtInDate'), kind: t('fieldKind_date') },
    { key: 'description', label: t('builtInDescription'), kind: t('fieldKind_text') },
    { key: 'receipt', label: t('builtInReceipt'), kind: t('fieldKind_file') },
  ];

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title={t('formsTitle')} description={t('formsSubtitle')} />
      <ClaimsTabs active="forms" />
      <ErrorBanner message={error} />

      {selected == null ? (
        <Card className="p-4">
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
        </Card>
      ) : (
        <>
          <Card className="p-4">
            <div className="mb-1.5 text-xs font-medium text-muted-foreground">{t('claimTypeLabel')}</div>
            <div className="flex flex-wrap gap-1.5">
              {types.map((ct) => (
                <Link
                  key={ct.id}
                  href={`/admin/claims/forms?claimTypeId=${encodeURIComponent(ct.id)}`}
                  className={pillCls(ct.id === selected.id)}
                >
                  {ct.name}
                </Link>
              ))}
            </div>
          </Card>

          <Card className="overflow-hidden">
            <SectionHeader title={t('builtInsTitle')} count={builtIns.length} />
            <p className="px-4 pt-3 text-xs text-muted-foreground">{t('builtInsHint')}</p>
            <ul className="divide-y divide-border">
              {builtIns.map((b) => (
                <li key={b.key} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <div>
                    <div className="text-sm font-medium">{b.label}</div>
                    <div className="text-xs text-muted-foreground">{b.kind}</div>
                  </div>
                  <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">{t('builtInBadge')}</span>
                </li>
              ))}
            </ul>
          </Card>

          <Card className="overflow-hidden">
            <SectionHeader title={t('customFieldsTitle')} count={fields.length} />
            {fields.length === 0 ? (
              <p className="px-4 py-6 text-sm text-muted-foreground">{t('noCustomFields')}</p>
            ) : (
              <ul className="divide-y divide-border">
                {fields.map((f, i) => (
                  <li key={f.id} className="space-y-2 px-4 py-3">
                    <form action={updateClaimFormFieldAction} className="grid gap-2 sm:grid-cols-[1fr_9rem_auto]">
                      <input type="hidden" name="id" value={f.id} />
                      <input type="hidden" name="claimTypeId" value={selected.id} />
                      <input name="label" defaultValue={f.label} required className={`${inputCls} w-full`} />
                      <select name="kind" defaultValue={f.kind} className={`${inputCls} w-full`}>
                        {CLAIM_FIELD_KINDS.map((k) => (
                          <option key={k} value={k}>
                            {t(`fieldKind_${k}` as 'fieldKind_text')}
                          </option>
                        ))}
                      </select>
                      <div className="flex items-center gap-2">
                        <label className="flex items-center gap-1.5 text-xs">
                          <input type="checkbox" name="required" defaultChecked={f.required} className="size-4" />
                          {t('fieldRequiredLabel')}
                        </label>
                        <Button type="submit" variant="secondary">{t('save')}</Button>
                      </div>
                      {f.kind === 'select' ? (
                        <label className="flex flex-col gap-1 sm:col-span-3">
                          <span className="text-xs font-medium text-muted-foreground">{t('fieldOptionsLabel')}</span>
                          <textarea name="options" rows={2} defaultValue={f.options.join('\n')} className={inputCls} />
                        </label>
                      ) : (
                        <input type="hidden" name="options" value={f.options.join('\n')} />
                      )}
                    </form>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs text-muted-foreground">{f.fieldKey}</span>
                      <span className="ml-auto flex gap-1">
                        {i > 0 ? (
                          <form action={moveClaimFormFieldAction}>
                            <input type="hidden" name="id" value={f.id} />
                            <input type="hidden" name="claimTypeId" value={selected.id} />
                            <input type="hidden" name="direction" value="up" />
                            <Button type="submit" variant="ghost" aria-label={t('moveUp')}>↑</Button>
                          </form>
                        ) : null}
                        {i < fields.length - 1 ? (
                          <form action={moveClaimFormFieldAction}>
                            <input type="hidden" name="id" value={f.id} />
                            <input type="hidden" name="claimTypeId" value={selected.id} />
                            <input type="hidden" name="direction" value="down" />
                            <Button type="submit" variant="ghost" aria-label={t('moveDown')}>↓</Button>
                          </form>
                        ) : null}
                        <form action={archiveClaimFormFieldAction}>
                          <input type="hidden" name="id" value={f.id} />
                          <input type="hidden" name="claimTypeId" value={selected.id} />
                          <Button type="submit" variant="ghost">{t('removeField')}</Button>
                        </form>
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="p-4">
            <h2 className="mb-3 text-sm font-semibold">{t('addFieldTitle')}</h2>
            <form action={createClaimFormFieldAction} className="grid gap-3 sm:grid-cols-2">
              <input type="hidden" name="claimTypeId" value={selected.id} />
              <Field label={t('fieldLabelLabel')}>
                <input name="label" required placeholder={t('fieldLabelHint')} className={`${inputCls} w-full`} />
              </Field>
              <Field label={t('fieldKindLabel')}>
                <select name="kind" className={`${inputCls} w-full`} defaultValue="text">
                  {CLAIM_FIELD_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {t(`fieldKind_${k}` as 'fieldKind_text')}
                    </option>
                  ))}
                </select>
              </Field>
              <label className="flex flex-col gap-1 sm:col-span-2">
                <span className="text-xs font-medium text-muted-foreground">{t('fieldOptionsLabel')}</span>
                <textarea name="options" rows={2} placeholder={t('fieldOptionsHint')} className={inputCls} />
              </label>
              <div className="flex flex-wrap items-center gap-4 sm:col-span-2">
                <label className="flex h-9 items-center gap-2 text-sm">
                  <input type="checkbox" name="required" className="size-4" />
                  {t('fieldRequiredLabel')}
                </label>
                <Button type="submit" className="ml-auto">{t('addField')}</Button>
              </div>
            </form>
            <p className="mt-3 text-xs text-muted-foreground">{t('formsFooterHint')}</p>
          </Card>
        </>
      )}
    </div>
  );
}

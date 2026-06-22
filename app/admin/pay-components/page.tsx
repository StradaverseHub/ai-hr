import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { requireAdmin } from '@/lib/authz';
import { EA_FORM_LINES, ROUNDING_METHODS, listPayComponents } from '@/core/pay-components';
import { Card, Field, PageHeader, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { archiveComponentAction, deleteComponentAction, seedCatalogAction, upsertComponentAction } from './actions';

const flag = (on: boolean) => (on ? '✓' : '—');
const PAGE = '/admin/pay-components';

export default async function PayComponentsPage({
  searchParams,
}: {
  searchParams: Promise<{ edit?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('payComponents');
  const components = await listPayComponents(s);
  const { edit } = await searchParams;
  const editing = edit ? components.find((c) => c.code === edit) ?? null : null;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title={t('title')} description={t('description')} />

      <p className="rounded-[1.25rem] border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
        {t('previewNotice')}
      </p>

      <Card className="overflow-hidden">
        <div className="flex items-center justify-between gap-3 pr-4">
          <SectionHeader title={t('catalogTitle')} count={components.length} />
          {components.length === 0 && (
            <form action={seedCatalogAction}>
              <button className={btnPrimary}>{t('seedDefaults')}</button>
            </form>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">{t('colCode')}</th>
                <th className="px-4 py-2 font-medium">{t('colName')}</th>
                <th className="px-4 py-2 font-medium">{t('colKind')}</th>
                <th className="px-4 py-2 text-center font-medium">EPF</th>
                <th className="px-4 py-2 text-center font-medium">SOCSO/EIS</th>
                <th className="px-4 py-2 text-center font-medium">PCB</th>
                <th className="px-4 py-2 text-center font-medium">HRDF</th>
                <th className="px-4 py-2 text-center font-medium">{t('colProrates')}</th>
                <th className="px-4 py-2 font-medium">{t('colEaLine')}</th>
                <th className="px-4 py-2 font-medium">{t('colRounding')}</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {components.map((c) => (
                <tr key={c.id} className={editing?.id === c.id ? 'bg-primary/5' : undefined}>
                  <td className="px-4 py-2.5 font-mono text-xs">{c.code}</td>
                  <td className="px-4 py-2.5">{c.name}</td>
                  <td className="px-4 py-2.5 text-muted-foreground">{t(`kind_${c.kind}`)}</td>
                  <td className="px-4 py-2.5 text-center tabular-nums">{flag(c.includedInEpf)}</td>
                  <td className="px-4 py-2.5 text-center tabular-nums">{flag(c.includedInSocsoEis)}</td>
                  <td className="px-4 py-2.5 text-center tabular-nums">{flag(c.includedInPcb)}</td>
                  <td className="px-4 py-2.5 text-center tabular-nums">{flag(c.includedInHrdfBase)}</td>
                  <td className="px-4 py-2.5 text-center tabular-nums">{flag(c.prorates)}</td>
                  <td className="px-4 py-2.5 text-muted-foreground">{c.eaFormLine ? t(`eaLine_${c.eaFormLine}`) : '—'}</td>
                  <td className="px-4 py-2.5 text-muted-foreground">{c.roundingMethod === 'none' ? '—' : t(`rounding_${c.roundingMethod}`)}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center justify-end gap-3">
                      <Link href={`${PAGE}?edit=${c.code}`} className="text-xs font-medium text-primary hover:underline">
                        {t('edit')}
                      </Link>
                      <form action={archiveComponentAction}>
                        <input type="hidden" name="id" value={c.id} />
                        <ConfirmSubmit
                          variant="outline"
                          title={t('archiveTitle')}
                          description={t('archiveDescription', { code: c.code })}
                          confirmLabel={t('archive')}
                          size="sm"
                        >
                          {t('archive')}
                        </ConfirmSubmit>
                      </form>
                      <form action={deleteComponentAction}>
                        <input type="hidden" name="id" value={c.id} />
                        <ConfirmSubmit
                          title={t('deleteTitle')}
                          description={t('deleteDescription', { code: c.code })}
                          confirmLabel={t('delete')}
                          size="sm"
                        >
                          {t('delete')}
                        </ConfirmSubmit>
                      </form>
                    </div>
                  </td>
                </tr>
              ))}
              {components.length === 0 && (
                <tr>
                  <td colSpan={11} className="px-4 py-8 text-center text-muted-foreground">{t('empty')}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <SectionHeader title={editing ? t('editTitle', { code: editing.code }) : t('addTitle')} />
        {/* key forces the uncontrolled form to re-init its defaults when the edit target changes */}
        <form key={editing?.id ?? 'new'} action={upsertComponentAction} className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-3">
          <Field label={t('colCode')}>
            <input
              name="code"
              required
              readOnly={!!editing}
              defaultValue={editing?.code ?? ''}
              placeholder="HOUSING"
              pattern="[A-Za-z0-9_]+"
              className={`${inputCls} font-mono uppercase ${editing ? 'opacity-60' : ''}`}
            />
          </Field>
          <Field label={t('colName')}>
            <input name="name" required defaultValue={editing?.name ?? ''} placeholder={t('namePlaceholder')} className={`${inputCls} sm:col-span-2`} />
          </Field>
          <Field label={t('colKind')}>
            <select name="kind" defaultValue={editing?.kind ?? 'allowance'} className={inputCls}>
              <option value="allowance">{t('kind_allowance')}</option>
              <option value="deduction">{t('kind_deduction')}</option>
              <option value="contribution">{t('kind_contribution')}</option>
              <option value="non_payable">{t('kind_non_payable')}</option>
            </select>
          </Field>
          <Field label={t('colEaLine')}>
            <select name="eaFormLine" defaultValue={editing?.eaFormLine ?? ''} className={inputCls}>
              <option value="">{t('eaLineNone')}</option>
              {EA_FORM_LINES.map((line) => (
                <option key={line} value={line}>{t(`eaLine_${line}`)}</option>
              ))}
            </select>
          </Field>
          <Field label={t('colRounding')}>
            <select name="roundingMethod" defaultValue={editing?.roundingMethod ?? 'none'} className={inputCls}>
              {ROUNDING_METHODS.map((m) => (
                <option key={m} value={m}>{t(`rounding_${m}`)}</option>
              ))}
            </select>
          </Field>
          <div className="flex flex-wrap items-center gap-4 sm:col-span-3">
            {(
              [
                ['includedInEpf', 'EPF', editing?.includedInEpf ?? true],
                ['includedInSocsoEis', 'SOCSO/EIS', editing?.includedInSocsoEis ?? true],
                ['includedInPcb', 'PCB', editing?.includedInPcb ?? true],
                ['includedInHrdfBase', 'HRDF', editing?.includedInHrdfBase ?? false],
                ['prorates', t('colProrates'), editing?.prorates ?? true],
              ] as const
            ).map(([name, label, def]) => (
              <label key={name} className="flex items-center gap-2 text-sm">
                <input type="checkbox" name={name} defaultChecked={def} className="size-4 rounded" />
                {label}
              </label>
            ))}
          </div>
          <p className="text-xs text-muted-foreground sm:col-span-3">{t('flagsHint')}</p>
          <div className="flex items-center gap-3 sm:col-span-3">
            <button className={btnPrimary}>{editing ? t('saveChanges') : t('saveComponent')}</button>
            {editing && (
              <Link href={PAGE} className="text-sm font-medium text-muted-foreground hover:text-foreground">
                {t('cancelEdit')}
              </Link>
            )}
          </div>
        </form>
      </Card>
    </div>
  );
}

import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { listPayComponents } from '@/core/pay-components';
import { Card, Field, PageHeader, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { archiveComponentAction, seedCatalogAction, upsertComponentAction } from './actions';

const flag = (on: boolean) => (on ? '✓' : '—');

export default async function PayComponentsPage() {
  const s = await requireAdmin();
  const t = await getTranslations('payComponents');
  const components = await listPayComponents(s);

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
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {components.map((c) => (
                <tr key={c.id}>
                  <td className="px-4 py-2.5 font-mono text-xs">{c.code}</td>
                  <td className="px-4 py-2.5">{c.name}</td>
                  <td className="px-4 py-2.5 text-muted-foreground">{t(`kind_${c.kind}`)}</td>
                  <td className="px-4 py-2.5 text-center tabular-nums">{flag(c.includedInEpf)}</td>
                  <td className="px-4 py-2.5 text-center tabular-nums">{flag(c.includedInSocsoEis)}</td>
                  <td className="px-4 py-2.5 text-center tabular-nums">{flag(c.includedInPcb)}</td>
                  <td className="px-4 py-2.5 text-center tabular-nums">{flag(c.includedInHrdfBase)}</td>
                  <td className="px-4 py-2.5 text-center tabular-nums">{flag(c.prorates)}</td>
                  <td className="px-4 py-2.5 text-right">
                    <form action={archiveComponentAction}>
                      <input type="hidden" name="id" value={c.id} />
                      <ConfirmSubmit
                        title={t('archiveTitle')}
                        description={t('archiveDescription', { code: c.code })}
                        confirmLabel={t('archive')}
                        size="sm"
                      >
                        {t('archive')}
                      </ConfirmSubmit>
                    </form>
                  </td>
                </tr>
              ))}
              {components.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-muted-foreground">{t('empty')}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <SectionHeader title={t('addTitle')} />
        <form action={upsertComponentAction} className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-3">
          <Field label={t('colCode')}>
            <input name="code" required placeholder="HOUSING" pattern="[A-Za-z0-9_]+" className={`${inputCls} font-mono uppercase`} />
          </Field>
          <Field label={t('colName')}>
            <input name="name" required placeholder={t('namePlaceholder')} className={`${inputCls} sm:col-span-2`} />
          </Field>
          <Field label={t('colKind')}>
            <select name="kind" defaultValue="allowance" className={inputCls}>
              <option value="allowance">{t('kind_allowance')}</option>
              <option value="deduction">{t('kind_deduction')}</option>
              <option value="contribution">{t('kind_contribution')}</option>
              <option value="non_payable">{t('kind_non_payable')}</option>
            </select>
          </Field>
          <div className="flex flex-wrap items-center gap-4 sm:col-span-3">
            {(
              [
                ['includedInEpf', 'EPF', true],
                ['includedInSocsoEis', 'SOCSO/EIS', true],
                ['includedInPcb', 'PCB', true],
                ['includedInHrdfBase', 'HRDF', false],
                ['prorates', t('colProrates'), true],
              ] as const
            ).map(([name, label, def]) => (
              <label key={name} className="flex items-center gap-2 text-sm">
                <input type="checkbox" name={name} defaultChecked={def} className="size-4 rounded" />
                {label}
              </label>
            ))}
          </div>
          <p className="text-xs text-muted-foreground sm:col-span-3">{t('flagsHint')}</p>
          <div className="sm:col-span-3">
            <button className={btnPrimary}>{t('saveComponent')}</button>
          </div>
        </form>
      </Card>
    </div>
  );
}

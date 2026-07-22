import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import type { listPayComponents } from '@/core/pay-components';
import { ROUNDING_METHODS } from '@/core/pay-components';
import type { PayRule } from '@/core/pay-rule';
import { Card, ErrorBanner, Field, PageHeader, btnGhost, btnPrimary, inputCls } from '@/components/ui';
import { PayRuleEditor } from './pay-rule-editor';
import { createComponentAction, updateComponentAction } from './actions';

const LIST = '/admin/pay-components';

export type PayComponentRow = Awaited<ReturnType<typeof listPayComponents>>[number];

/** Input Type is DERIVED from the pay-rule kind (read-only — making it editable is a later change).
 *  null / 'fixed' ⇒ fixed amount, matching the kernel's legacy fixed-amount behaviour. */
const inputTypeOf = (rule: unknown): 'fixed' | 'percent_of' | 'per_day' | 'per_hour' | 'flat_capped' =>
  (rule as PayRule | null)?.kind ?? 'fixed';

/**
 * Pay Code maintenance screen (feedback 911b2886) — the shared Create / Edit form, extracted from the old
 * inline block on the list page and rendered by the dedicated /new and /[code] routes (attendance-rule
 * precedent: rules/rule-form.tsx). Server component: it RENDERS the PayRuleEditor client island as JSX,
 * keeping the RSC boundary clean. Two sections — Basic Information and Payroll Configuration — with a
 * Save / Save & New / Cancel toolbar. `error` comes from the action's redirect-with-error and renders
 * through ErrorBanner above the form (the global ToastFromQuery still fires as well, same as attendance).
 */
export async function ComponentForm({
  component,
  aiEnabled,
  error,
}: {
  component: PayComponentRow | null;
  aiEnabled: boolean;
  error?: string;
}) {
  const t = await getTranslations('payComponents');
  const editing = !!component;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title={editing ? t('editTitle', { code: component!.code }) : t('createTitle')}
        back={{ href: LIST, label: t('backToList') }}
      />
      <ErrorBanner message={error} />

      <form action={editing ? updateComponentAction : createComponentAction} className="space-y-6">
        {/* EA-form-line passthrough: the control left this screen (dedicated statutory module later);
            re-submitting the stored value keeps existing mappings intact on every save. */}
        <input type="hidden" name="eaFormLine" value={component?.eaFormLine ?? ''} />

        <Card className="space-y-3 p-4">
          <h2 className="text-sm font-semibold text-foreground">{t('sectionBasic')}</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label={t('colCode')}>
              <input
                name="code"
                required
                readOnly={editing}
                defaultValue={component?.code ?? ''}
                placeholder="HOUSING"
                pattern="[A-Za-z0-9_]+"
                className={`${inputCls} font-mono uppercase ${editing ? 'opacity-60' : ''}`}
              />
            </Field>
            <Field label={t('colLabel')}>
              <input name="label" defaultValue={component?.label ?? ''} placeholder={t('labelPlaceholder')} className={inputCls} />
            </Field>
            <Field label={t('colName')}>
              <input name="name" required defaultValue={component?.name ?? ''} placeholder={t('namePlaceholder')} className={inputCls} />
            </Field>
            <Field label={t('colKind')}>
              <select name="kind" defaultValue={component?.kind ?? 'allowance'} className={inputCls}>
                <option value="allowance">{t('kind_allowance')}</option>
                <option value="deduction">{t('kind_deduction')}</option>
                <option value="contribution">{t('kind_contribution')}</option>
                <option value="non_payable">{t('kind_non_payable')}</option>
              </select>
            </Field>
            <Field label={t('colInputType')}>
              {/* Read-only, derived from the pay rule below — configure it via the rule editor. */}
              <input readOnly value={t(`inputType_${inputTypeOf(component?.rule ?? null)}`)} className={`${inputCls} opacity-60`} />
            </Field>
            <Field label={t('colStatus')}>
              <input
                readOnly
                value={component?.archivedAt ? t('statusInactive') : t('statusActive')}
                className={`${inputCls} opacity-60`}
              />
            </Field>
            <Field label={t('colRounding')}>
              <select name="roundingMethod" defaultValue={component?.roundingMethod ?? 'none'} className={inputCls}>
                {ROUNDING_METHODS.map((m) => (
                  <option key={m} value={m}>{t(`rounding_${m}`)}</option>
                ))}
              </select>
            </Field>
          </div>
        </Card>

        <Card className="space-y-3 p-4">
          <h2 className="text-sm font-semibold text-foreground">{t('sectionConfig')}</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="flex flex-wrap items-center gap-4 sm:col-span-3">
              {(
                [
                  ['includedInEpf', 'EPF', component?.includedInEpf ?? true],
                  ['includedInSocsoEis', 'SOCSO/EIS', component?.includedInSocsoEis ?? true],
                  ['includedInPcb', 'PCB', component?.includedInPcb ?? true],
                  ['includedInHrdfBase', 'HRDF', component?.includedInHrdfBase ?? false],
                ] as const
              ).map(([name, label, def]) => (
                <label key={name} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name={name} defaultChecked={def} className="size-4 rounded" />
                  {label}
                </label>
              ))}
            </div>
            <p className="text-xs text-muted-foreground sm:col-span-3">{t('flagsHint')}</p>
            {/* Payroll Setup — configurable pay-rule + AI assist. The Prorates checkbox lives inside this island
                (it interacts with per-day/per-hour rules) and is submitted as the form's `prorates` field. */}
            <PayRuleEditor
              code={component?.code ?? ''}
              prorates={component?.prorates ?? true}
              rule={(component?.rule ?? null) as PayRule | null}
              aiEnabled={aiEnabled}
            />
          </div>
        </Card>

        {/* Bottom toolbar — Save, Save & New (saves then reopens a blank screen), Cancel back to the list. */}
        <div className="flex items-center gap-3">
          <button className={btnPrimary}>{editing ? t('saveChanges') : t('saveComponent')}</button>
          <button name="intent" value="saveAndNew" className={btnGhost}>
            {t('saveAndNew')}
          </button>
          <Link href={LIST} className="text-sm font-medium text-muted-foreground hover:text-foreground">
            {t('cancelEdit')}
          </Link>
        </div>
      </form>
    </div>
  );
}

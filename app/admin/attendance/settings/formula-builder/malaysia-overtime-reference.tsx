import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@/components/ui';
import {
  MALAYSIA_STATUTORY_OVERTIME_REFERENCES,
  evaluateMalaysiaStatutoryOvertimeExample,
} from '@/lib/attendance-formula-references';

export function MalaysiaOvertimeReference({ disabled, onCopy }: {
  disabled: boolean;
  onCopy: (code: string) => void;
}) {
  const t = useTranslations('attendanceFormula.malaysiaReference');
  const attendance = useTranslations('attendanceFormula');
  const money = new Intl.NumberFormat(useLocale(), { style: 'currency', currency: 'MYR' });
  return <section className="space-y-3 rounded-lg border border-border p-4">
    <h3 className="font-semibold">{t('title')}</h3>
    <p className="max-w-prose text-sm text-muted-foreground">{t('scope')}</p>
    <p className="max-w-prose text-sm text-muted-foreground">{t('eligibility')}</p>
    <p className="max-w-prose text-sm text-muted-foreground">{t('controls')}</p>
    <p className="max-w-prose text-sm text-muted-foreground">{t('bindingHelp')}</p>
    <div className="divide-y divide-border">
      {MALAYSIA_STATUTORY_OVERTIME_REFERENCES.map(reference => <details key={reference.code} className="py-3">
        <summary className="cursor-pointer font-medium">
          {t(reference.name)} <code className="ml-2 break-all text-xs text-muted-foreground">{reference.code}</code>
        </summary>
        <div className="mt-3 space-y-3">
          <p className="text-sm">{t('metadata', {
            provision: reference.provision,
            day: t('day.' + reference.dayType),
            method: attendance('daily'),
          })}</p>
          <p className="max-w-prose text-sm text-muted-foreground">{t('description.' + reference.name)}</p>
          <pre className="overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-3 font-mono text-xs">{reference.source}</pre>
          <h4 className="text-sm font-medium">{t('requiredInputs')}</h4>
          <dl className="divide-y divide-border text-sm">
            {reference.inputs.map(id => <div key={id} className="grid gap-1 py-2 sm:grid-cols-2">
              <dt><code className="break-all text-xs">{id}</code></dt>
              <dd>{t('input.' + id)}</dd>
            </div>)}
          </dl>
          {reference.examples.map((sample, index) => <div key={index} className="space-y-1 rounded border border-border p-3 text-sm">
            <h4 className="font-medium">{t('example', { basis: t('basis.' + sample.basis) })}</h4>
            <ul className="space-y-1">
              {reference.inputs.map(id => {
                const value = sample.values[id];
                return <li key={id}>{t('input.' + id)} · {typeof value === 'boolean' ? attendance(value ? 'true' : 'false') : value}</li>;
              })}
            </ul>
            <p className="font-medium tabular-nums">{t('result', {
              amount: money.format(Number(evaluateMalaysiaStatutoryOvertimeExample(reference, index))),
            })}</p>
          </div>)}
          <Button type="button" variant="secondary" disabled={disabled} onClick={() => onCopy(reference.code)}>{t('copy')}</Button>
        </div>
      </details>)}
    </div>
    <div className="flex flex-wrap gap-3 text-sm text-primary">
      <a className="underline" href="https://jtksm.mohr.gov.my/sites/default/files/2023-11/Akta%20Kerja%201955%20%28Akta%20265%29.pdf">{t('source')}</a>
      <a className="underline" href="https://jtksm.gov.my/en/acts/list-rules">{t('overtimeLimitSource')}</a>
    </div>
  </section>;
}

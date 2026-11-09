import { useLocale, useTranslations } from 'next-intl';

const ordinaryRate = 3000 / 26;
const hourlyRate = ordinaryRate / 8;
const monthlyWageExamples = [
  { key: 'ordinaryRate', calculation: '3,000 ÷ 26', amount: ordinaryRate },
  { key: 'hourlyRate', calculation: '3,000 ÷ 26 ÷ 8', amount: hourlyRate },
  { key: 'ordinaryDay', calculation: '1.5 × (3,000 ÷ 26 ÷ 8)', amount: hourlyRate * 1.5 },
  { key: 'restDayHalf', calculation: '0.5 × (3,000 ÷ 26)', amount: ordinaryRate * 0.5 },
  { key: 'restDayFull', calculation: '3,000 ÷ 26', amount: ordinaryRate },
  { key: 'restDayOvertime', calculation: '2 × (3,000 ÷ 26 ÷ 8)', amount: hourlyRate * 2 },
  { key: 'publicHolidayWork', calculation: '2 × (3,000 ÷ 26)', amount: ordinaryRate * 2 },
  { key: 'publicHolidayOvertime', calculation: '3 × (3,000 ÷ 26 ÷ 8)', amount: hourlyRate * 3 },
] as const;

/** Worked examples use fictional inputs. Production formulas use the typed evaluator and live sources. */
export function MalaysiaOvertimeReference() {
  const t = useTranslations('attendanceFormula.malaysiaReference');
  const money = new Intl.NumberFormat(useLocale(), { style: 'currency', currency: 'MYR' });
  return <section className="space-y-3 rounded-lg border border-border p-4">
    <h3 className="font-semibold">{t('title')}</h3>
    <p className="max-w-prose text-sm text-muted-foreground">{t('example')}</p>
    <p className="max-w-prose text-sm text-muted-foreground">{t('scope')}</p>
    <dl className="divide-y divide-border text-sm">
      {monthlyWageExamples.map(row => <div key={row.key} className="grid gap-1 py-2 sm:grid-cols-2">
        <dt className="font-medium">{t(row.key)}</dt>
        <dd className="tabular-nums">{row.calculation} = {money.format(row.amount)}</dd>
      </div>)}
    </dl>
    <a className="text-sm text-primary underline" href="https://jtksm.mohr.gov.my/sites/default/files/2023-11/Akta%20Kerja%201955%20%28Akta%20265%29.pdf">{t('source')}</a>
  </section>;
}

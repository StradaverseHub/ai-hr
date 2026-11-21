import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui';

/**
 * c03670cc — Wage Deductions, on the Schedule Group's Attendance tab (moved from General).
 *
 * The ONLY control over `applyDeductions`. It is mounted by the Edit Schedule Attendance section and by
 * Add Schedule's Attendance tab. The start date is stamped by the service (core/attendance-rule.ts
 * resolveDeductionStart) when the switch turns on and is never typed, so a closed payroll month can never
 * pick up a deduction afterwards. `deductionsEditor` is read BY VALUE: with it, an unticked box means OFF;
 * a submission without it (a script, an older form) leaves the switch and its date alone.
 *
 * Synchronous on purpose: it renders identically inside a Server Component page and a client test tree.
 */
export function WageDeductionsCard({ rule, editing }: { rule: { applyDeductions: boolean; deductionsEffectiveFrom: string | null } | null; editing: boolean }) {
  const t = useTranslations('admin.attendanceRule');
  const ts = useTranslations('admin.scheduleConfig');
  const on = rule?.applyDeductions ?? false;
  return <Card className="space-y-3 p-4" data-schedule-wage-deductions="">
    <h2 className="text-sm font-semibold text-foreground">{t('deductionsSectionTitle')}</h2>
    {editing ? <>
      <input type="hidden" name="deductionsEditor" value="1"/>
      <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-border px-3 py-2 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/10">
        <input type="checkbox" name="applyDeductions" defaultChecked={on} className="mt-0.5 h-3.5 w-3.5 accent-primary" />
        <span>
          <span className="font-medium text-foreground">{t('applyDeductionsLabel')}</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">{t('applyDeductionsHint')}</span>
        </span>
      </label>
    </> : <p className="text-sm">{t('applyDeductionsLabel')} · {on ? ts('settingOn') : ts('settingOff')}</p>}
    <p className="text-xs text-muted-foreground">
      {t('deductionsFromLabel')}:{' '}
      <span className="font-medium tabular-nums text-foreground">
        {on ? (rule?.deductionsEffectiveFrom ?? t('deductionsFromNone')) : t('deductionsFromNone')}
      </span>
    </p>
  </Card>;
}

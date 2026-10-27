import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Field, inputCls } from '@/components/ui';
import type { RewardPostingAuthority } from '@/packs/rewards/service';
import { RewardSubmit } from './submit-button';

/**
 * H1 — the Post control of an approved review. `posting` is the review projection's answer from
 * rewardPostingAuthorityTx, the same predicate postRewardUnit's guard uses: the button appears only when the
 * guard would accept, and a payroll seat without HR administration sees why instead of a refusal.
 */
export function RewardPostPanel({ posting, batches, fields, action }: {
  posting: RewardPostingAuthority; batches: { id: string; period: string }[]; fields: ReactNode; action: (f: FormData) => void | Promise<void>;
}) {
  const t = useTranslations('rewards');
  if (posting === 'needs-admin') return <p className="max-w-3xl text-sm text-muted-foreground">{t('postNeedsAdmin')}</p>;
  if (posting !== 'allowed') return null;
  return <form action={action} className="max-w-3xl space-y-3">{fields}
    <p className="text-sm text-muted-foreground">{t('postHelp')}</p>
    <Field label={t('payrollBatch')}><select name="batchId" className={inputCls}><option value="">{t('salaryOnly')}</option>{batches.map(b => <option key={b.id} value={b.id}>{b.period}</option>)}</select></Field>
    {!batches.length && <p className="text-sm text-muted-foreground">{t('noPayrollBatch')}</p>}
    <RewardSubmit type="submit">{t('post')}</RewardSubmit>
  </form>;
}

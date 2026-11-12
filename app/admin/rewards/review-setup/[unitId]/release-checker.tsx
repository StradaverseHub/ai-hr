import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { RewardSubmit } from '@/app/rewards/submit-button';
import { preparationAction } from '@/app/rewards/preparation-actions';

/**
 * 70d5e7c5 — Release to BU CEO, with the reason it is not available yet.
 *
 * INTEGRATION NOTE: this is the only place the set-up screen shows the "doer and checker" rule (a different
 * Group Rewards person must release). That rule is enforced by the server (changeRewardPreparation and the
 * reward_preparation_check_guard trigger) and is being changed in a parallel lane (board item 60f1fdcd:
 * Group Rewards, HR Admin and CTRO release directly). When that lands, drop `independentChecker` here and
 * the server rule together; nothing else on the page depends on it.
 */
export function ReleaseChecker({ fields, canEdit, firstBlocker, expectedRelease, independentChecker }: {
  fields: ReactNode; canEdit: boolean; firstBlocker: string | null; expectedRelease: string | null; independentChecker: boolean;
}) {
  const t = useTranslations('rewardsPreparation');
  const reason = firstBlocker ?? (!expectedRelease ? t('setExpected') : !independentChecker ? t('independent') : t('ready'));
  const disabled = !canEdit || !!firstBlocker || !expectedRelease || !independentChecker;
  return <div className="flex flex-wrap items-center gap-3">
    <form action={preparationAction}>{fields}<input type="hidden" name="kind" value="release" /><RewardSubmit disabled={disabled}>{t('release')}</RewardSubmit></form>
    <p role="status" className="text-sm text-muted-foreground">{reason}</p>
  </div>;
}

import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui';
import type { RewardReturnSeat, RewardRole, RewardStage } from '@/packs/rewards/model';

/** Shared timestamp format for Reward Desk decisions (Kuala Lumpur wall clock). */
export const rewardDecisionTime = (at: string | Date) => new Date(at).toLocaleString('en-MY', { timeZone: 'Asia/Kuala_Lumpur' });

/** Stage text for a review. Returned is derived (draft + latest decision is a return), never stored. */
export function RewardStageLabel({ status, returnedTo }: { status: RewardStage; returnedTo: RewardReturnSeat | null | undefined }) {
  const t = useTranslations('rewards');
  return <>{returnedTo ? t(`returnedTo.${returnedTo}`) : t(`stages.${status}`)}</>;
}

export type ReturnedView = { reason: string; at: string; toSeat: RewardReturnSeat; actorName: string | null; actorRole: RewardRole | null };

export function useRewardActorLabel() {
  const t = useTranslations('rewards');
  return (name: string | null | undefined, role: RewardRole | null | undefined) => name ?? (role ? t(`roles.${role}`) : t('aReviewer'));
}

/** Banner shown on a returned review: who returned it, when, and why. */
export function ReturnedBanner({ returned }: { returned: ReturnedView }) {
  const t = useTranslations('rewards'); const actor = useRewardActorLabel();
  return <Card role="status" aria-label={t(`returnedTo.${returned.toSeat}`)} className="max-w-3xl space-y-2 border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-700 dark:bg-amber-950/40">
    <h2 className="font-semibold">{t(`returnedTo.${returned.toSeat}`)}</h2>
    <p>{t('returnedBy', { actor: actor(returned.actorName, returned.actorRole), date: rewardDecisionTime(returned.at) })}</p>
    <div><p className="font-medium">{t('returnedReason')}</p><p className="whitespace-pre-wrap">{returned.reason}</p></div>
    <p className="text-muted-foreground">{t('returnedNext')}</p>
  </Card>;
}

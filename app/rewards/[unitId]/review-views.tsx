import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui';

/** These links switch views of the same review, preserving ordinary keyboard navigation. */
export function RewardUnitViews({ unitId, selected, setupVisible }: {
  unitId: string; selected: 'review' | 'setup'; setupVisible: boolean;
}) {
  const t = useTranslations('rewardsPreparation');
  if (!setupVisible) return null;
  const review = `/rewards/${unitId}`;
  return <nav aria-label={t('tabs')} className="flex flex-wrap gap-2">
    <Button asChild size="sm" variant={selected === 'review' ? 'default' : 'outline'}>
      <Link href={review} aria-current={selected === 'review' ? 'page' : undefined}>{t('review')}</Link>
    </Button>
    <Button asChild size="sm" variant={selected === 'setup' ? 'default' : 'outline'}>
      <Link href={`${review}/setup`} aria-current={selected === 'setup' ? 'page' : undefined}>{t('setup')}</Link>
    </Button>
  </nav>;
}

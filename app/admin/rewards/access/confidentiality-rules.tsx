import { useTranslations } from 'next-intl';

const rules = ['own', 'ec', 'bg', 'pbp', 'totals', 'derived'] as const;
/** 6fd08f37 — the confidentiality rules every Rewards role is subject to, whatever seat it holds. */
export function RewardConfidentialityRules() {
  const t = useTranslations('rewardsAccess.confidentialityRules');
  return <section className="mt-5 border-t pt-4" aria-label={t('title')}>
    <h3 className="text-sm font-semibold">{t('title')}</h3>
    <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">{rules.map(k => <li key={k}>{t(k)}</li>)}</ul>
  </section>;
}

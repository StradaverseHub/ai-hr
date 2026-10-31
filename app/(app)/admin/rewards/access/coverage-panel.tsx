'use client';
import { useTranslations } from 'next-intl';
import type { RewardAccessAdministration } from '@/packs/rewards/service';
type Review = RewardAccessAdministration['reviews'][number];
/** cd72f915 — required-seat coverage per review, read from the server projection (rewardUnitCoverage). */
export function RewardCoverageBadge({ review }: { review: Review }) {
    const t = useTranslations('rewardsAccess');
    const missing = review.coverage?.missing.length ?? 0;
    return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${missing ? 'bg-destructive/10 text-destructive' : 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'}`}>{missing ? t('rolesMissing', { count: missing }) : t('coverageComplete')}</span>;
}
export function RewardCoveragePanel({ reviews }: { reviews: Review[] }) {
    const t = useTranslations('rewardsAccess'), r = useTranslations('rewards');
    if (!reviews.length) return null;
    return <section className="space-y-3" aria-labelledby="reward-coverage-title"><div><h2 id="reward-coverage-title" className="font-semibold">{t('coverageTitle')}</h2><p className="max-w-3xl text-sm text-muted-foreground">{t('coverageHelp')}</p></div>
  <ul className="space-y-2">{reviews.map(v => <li key={v.id}><details open={!!v.coverage?.missing.length && v.status === 'draft'} className="rounded-lg border p-3"><summary className="flex cursor-pointer flex-wrap items-center gap-2 text-sm"><span className="font-medium">{v.company} / {v.unit} · {v.cycle}</span><RewardCoverageBadge review={v}/><span className="text-xs text-muted-foreground">{r(`stages.${v.status}`)}</span></summary>
   <table className="mt-3 w-full text-sm"><thead><tr className="text-left text-muted-foreground"><th className="py-1 pr-3 font-medium">{t('role')}</th><th className="py-1 font-medium">{t('assigned')}</th></tr></thead><tbody className="divide-y">{(v.coverage?.roles ?? []).map(c => <tr key={c.role}><td className="py-2 pr-3">{r(`roles.${c.role}`)}</td><td className="py-2">{c.activeHolders.length ? <span className="flex flex-wrap gap-1">{c.activeHolders.map(h => <span key={h.userId} className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">{h.name ?? h.email ?? t('unavailable', { id: h.userId })}</span>)}</span> : <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${c.required ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground'}`}>{t(c.required ? 'missingRole' : 'optionalNone')}</span>}</td></tr>)}</tbody></table>
  </details></li>)}</ul>
  <p className="max-w-3xl text-xs text-muted-foreground">{t('coverageRule')}</p>
 </section>;
}

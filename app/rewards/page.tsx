import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { requireModule } from '@/lib/authz';
import { listRewardUnits, rewardSetupChoices } from '@/packs/rewards/service';
import { ErrorBanner, PageHeader, tableWrapCls, theadCls, thCls, tbodyCls } from '@/components/ui';

export default async function RewardsPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  await requireModule('rewards'); const { s, scopeIds } = await scopedSession();
  const t = await getTranslations('rewards'); const { error } = await searchParams;
  const [units, choices] = await Promise.all([listRewardUnits(s, scopeIds), rewardSetupChoices(s, scopeIds)]);
  return <div className="w-full space-y-6">
    <PageHeader title={t('title')} description={t('description')} />
    <ErrorBanner message={error} />
    <div data-tour="rewards-review-units" className={tableWrapCls}><table className="w-full text-sm"><thead className={theadCls}><tr>{['cycle', 'company', 'unit', 'stage', 'action'].map(k => <th key={k} className={thCls}>{t(k)}</th>)}</tr></thead>
      <tbody className={tbodyCls}>{units.map(u => <tr key={u.id}><td className="px-3 py-3 font-medium">{u.cycle} · {t(`kinds.${u.kind}`)}<span className="ml-2 text-muted-foreground">{u.year}</span></td><td className="px-3 py-3">{u.company}</td><td className="px-3 py-3">{u.unit}</td><td className="px-3 py-3">{t(`stages.${u.status}`)}</td><td className="px-3 py-3"><Link className="font-medium text-primary hover:underline" href={`/rewards/${u.id}`}>{t('openReview')}</Link></td></tr>)}</tbody>
    </table>{!units.length && <p className="max-w-2xl px-5 py-10 text-sm text-muted-foreground">{t('empty')}</p>}</div>
    {choices.companies.length > 0 && <Link href="/admin/rewards" className="inline-flex text-sm font-medium text-primary hover:underline">{t('adminTitle')}</Link>}
  </div>;
}

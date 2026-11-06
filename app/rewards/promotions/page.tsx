import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireModule } from '@/lib/authz';
import { getScopeIds, scopedSession } from '@/lib/scope';
import { Card, PageHeader, btnPrimary, inputCls } from '@/components/ui';
import { rewardVisibleCompanies } from '@/packs/rewards/access-policy';
import { rewardPromotionNominations } from '@/packs/rewards/service';

export default async function RewardPromotionsPage({ searchParams }: {
  searchParams: Promise<{ company?: string; year?: string; page?: string }>;
}) {
  await requireModule('rewards');
  const { s } = await scopedSession();
  const [companies, t, nav, filters] = await Promise.all([
    rewardVisibleCompanies(s), getTranslations('rewards'), getTranslations('nav'), searchParams,
  ]);
  const allowed = companies.map(company => company.id);
  const scope = companies.some(company => company.wholeGroup) ? allowed : await getScopeIds(allowed);
  const companyId = filters.company && scope.includes(filters.company) ? filters.company : '';
  const year = typeof filters.year === 'string' && /^20[0-9]{2}$/.test(filters.year) ? Number(filters.year) : undefined;
  const requested = typeof filters.page === 'string' && /^\d{1,5}$/.test(filters.page) ? Number(filters.page) : 1;
  const { year: selectedYear, page, maxPage, nominations, companies: choices } = await rewardPromotionNominations(s, scope, { companyId, year, page: requested });
  const url = (page: number) => '/rewards/promotions?' + new URLSearchParams({
    ...(companyId ? { company: companyId } : {}), year: String(selectedYear), page: String(page),
  });
  return <div className="space-y-5">
    <PageHeader title={t('promotionNominations')} back={{ href: '/rewards', label: nav('rewardsReviewing') }} />
    <Card className="space-y-4 p-4">
      <form method="get" className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1 text-sm">{t('company')}
          <select name="company" className={inputCls} defaultValue={companyId}>
            <option value="">{t('reviewList.all')}</option>
            {choices.map(company => <option key={company.id} value={company.id}>{company.name}</option>)}
          </select>
        </label>
        <label className="grid gap-1 text-sm">{t('year')}
          <input name="year" className={inputCls} type="number" min={2000} max={2099} defaultValue={selectedYear} />
        </label>
        <button className={btnPrimary}>{t('reviewList.apply')}</button>
      </form>
      <div className="overflow-x-auto"><table className="w-full text-left text-sm">
        <thead className="border-y border-border"><tr>{['employee', 'company', 'unit', 'cycle', 'grade', 'decisionReason'].map(key => <th className="p-3" key={key} scope="col">{t(key)}</th>)}</tr></thead>
        <tbody className="divide-y divide-border">{nominations.map(row => <tr key={row.id}>
          <td className="p-3"><Link className="text-primary underline" href={`/rewards/${row.reviewId}?person=${row.id}`}>{row.name}</Link></td>
          <td className="p-3">{row.company}</td><td className="p-3">{row.unit}</td><td className="p-3">{row.cycle}</td>
          <td className="p-3 whitespace-nowrap">{row.grade} → {row.proposed}</td><td className="p-3">{row.reason || '—'}</td>
        </tr>)}
        {!nominations.length && <tr><td className="p-3" colSpan={6}>{t('noPromotionNominations')}</td></tr>}</tbody>
      </table></div>
      {maxPage > 1 && <nav className="flex gap-4 text-sm" aria-label={t('promotionNominations')}>
        {page > 1 && <Link href={url(page - 1)} className="text-primary underline">{t('promotionPrevious')}</Link>}
        <span>{page} / {maxPage}</span>
        {page < maxPage && <Link href={url(page + 1)} className="text-primary underline">{t('promotionNext')}</Link>}
      </nav>}
    </Card>
  </div>;
}

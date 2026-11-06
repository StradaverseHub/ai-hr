import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Card, PageHeader, pageWideCls } from '@/components/ui';
import { requireModule } from '@/lib/authz';
import { scopedSession } from '@/lib/scope';
import { rewardPrelaunchDataCheck } from '@/packs/rewards/data-check';

export default async function RewardsDataCheckPage({ params }: { params: Promise<{ unitId: string }> }) {
  await requireModule('rewards');
  const { s } = await scopedSession();
  const { unitId } = await params;
  const [t, view] = await Promise.all([getTranslations('rewards'), rewardPrelaunchDataCheck(s, unitId)]);
  if (!view) notFound();
  return <div className={pageWideCls}>
    <PageHeader title={t('prelaunchDataCheck')} description={view.company + ' · ' + view.unit}
      back={{ href: `/rewards/${unitId}`, label: t('review') }} />
    <Card className="overflow-x-auto"><table className="w-full text-left text-sm">
      <thead className="border-b border-border"><tr>
        <th className="p-3" scope="col">{t('employee')}</th>
        <th className="p-3" scope="col">{t('grade')}</th>
        <th className="p-3" scope="col">{t('prelaunchDataCheck')}</th>
      </tr></thead>
      <tbody className="divide-y divide-border">{view.rows.map(row => <tr key={row.id}>
        <td className="p-3">{row.employeeCode} · {row.name}</td>
        <td className="p-3">{row.grade || '—'}</td>
        <td className="p-3">{row.reviewed && row.hasRatings && row.grade ? t('dataCheckReady') : t('unverified')}</td>
      </tr>)}
      {!view.rows.length && <tr><td className="p-3" colSpan={3}>{t('noPeople')}</td></tr>}</tbody>
    </table></Card>
  </div>;
}

import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Button, Card, tableWrapCls, thCls, theadCls, tbodyCls } from '@/components/ui';
import type { previewRewardPlanCreation } from '@/packs/rewards/plan-configuration';
import { planAction } from './actions';

export async function RewardPlanCreationOutcome({ count, versionId }: { count: number; versionId: string }) {
  const t = await getTranslations('rewardSetup');
  if (!count) return null;
  return <p className="flex flex-wrap items-center gap-2 text-sm">
    <span>{t('reviewsCreated', { count })}</span><span aria-hidden>·</span>
    <Link className="font-medium text-primary underline underline-offset-2" href={`/rewards/reviews?plan=${versionId}`}>
      {t('openCreatedReviews')}
    </Link>
  </p>;
}

export async function RewardPlanCreationPreview({ preview, names, units, createdCount }: {
  preview: Awaited<ReturnType<typeof previewRewardPlanCreation>>;
  names: ReadonlyMap<string, string>;
  units: ReadonlyMap<string, string>;
  createdCount: number;
}) {
  const [t, config, review] = await Promise.all([
    getTranslations('rewardSetup'), getTranslations('rewardsConfig'), getTranslations('rewards'),
  ]);
  const readyCount = preview.rows.filter(row => row.status === 'ready').length;

  return <section id="creation-preview" aria-labelledby="creation-preview-title" className="scroll-mt-6 space-y-4">
    <h3 id="creation-preview-title" className="font-semibold">{t('creationPreview')}</h3>
    <RewardPlanCreationOutcome count={createdCount} versionId={preview.versionId}/>
    <div className={tableWrapCls}>
      <table className="w-full text-sm">
        <thead className={theadCls}><tr>
          <th scope="col" className={thCls}>{config('columns.companyUnit')}</th>
          <th scope="col" className={thCls}>{t('creationOutcome')}</th>
          <th scope="col" className={thCls}>{t('reason')}</th>
        </tr></thead>
        <tbody className={tbodyCls}>{preview.rows.map(row => <tr key={row.companyId}>
          <th scope="row" className="px-3 py-3 text-left font-medium">
            {names.get(row.companyId) ?? row.companyId}
            {units.has(row.businessUnitId) && <span className="block text-xs font-normal text-muted-foreground">{units.get(row.businessUnitId)}</span>}
          </th>
          <td className="px-3 py-3">{t(row.status)}</td>
          <td className="px-3 py-3">{t(row.reason === 'ready' ? 'creationReady' : row.reason)}
            {row.existingUnitId && <Link className="ml-2 text-primary underline" href={`/rewards/${row.existingUnitId}`}>{review('openReview')}</Link>}
          </td>
        </tr>)}</tbody>
      </table>
    </div>
    {!preview.mayCreate && <p className="rounded-md bg-muted/50 p-3 text-sm">{t('independentCreateHelp')}</p>}
    <form action={planAction}>
      <input name="version" type="hidden" value={preview.versionId}/>
      <input name="digest" type="hidden" value={preview.digest}/>
      <Button name="operation" value="create" disabled={!preview.mayCreate || readyCount === 0}>
        {t('createReviewsCount', { count: readyCount })}
      </Button>
    </form>
  </section>;
}

export async function ApprovedRewardPlans({ plans }: {
  plans: readonly { versionId: string; cycleName: string; revision: number; year: number; createdCount: number }[];
}) {
  const t = await getTranslations('rewardSetup');
  return <Card className="space-y-3 p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="font-semibold">{t('plans')}</h2>
      <Link className="text-sm text-primary underline" href="/admin/rewards/plans">{t('manageRewardPlans')}</Link>
    </div>
    <ul className="divide-y divide-border">
      {plans.map(plan => <li key={plan.versionId} className="flex flex-wrap items-start justify-between gap-3 py-3">
        <div className="space-y-1">
          <p className="font-medium">{plan.cycleName} · {t('version')} {plan.revision}</p>
          <p className="text-sm text-muted-foreground">{plan.year} · {t('approved')}</p>
          <RewardPlanCreationOutcome count={plan.createdCount} versionId={plan.versionId}/>
        </div>
        <Button asChild variant="outline">
          <Link href={`/admin/rewards/plans?version=${plan.versionId}#creation-preview`}>{t('createReviews')}</Link>
        </Button>
      </li>)}
    </ul>
  </Card>;
}

import { getLocale, getTranslations } from 'next-intl/server';
import { Card, btnPrimary, inputCls } from '@/components/ui';
import type { SessionContext } from '@/db/client';
import { rewardReviewActivity } from '@/packs/rewards/activity';
import type { RewardAccessAdministration } from '@/packs/rewards/service';

export async function RewardReviewActivity({ session, value, reviewId, actorId }: {
  session: SessionContext; value: RewardAccessAdministration; reviewId?: string; actorId?: string;
}) {
  const reviews = new Map(value.reviews.map(review => [review.id, review]));
  const users = new Map(value.users.flatMap(user => user.name ? [[user.id, user.name] as const] : []));
  const selected = reviewId && reviews.has(reviewId) ? reviewId : '';
  const actor = actorId && users.has(actorId) ? actorId : '';
  const [t, rewards, locale, entries] = await Promise.all([
    getTranslations('rewardsAccess.reviewActivity'), getTranslations('rewards'), getLocale(),
    rewardReviewActivity(session, selected ? [selected] : [...reviews.keys()], actor || undefined),
  ]);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kuala_Lumpur' });
  return <Card className="space-y-4 p-4">
    <form method="get" className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="tab" value="activity" />
      <label className="grid gap-1 text-sm">{t('review')}
        <select name="review" defaultValue={selected} className={inputCls}>
          <option value="">{rewards('reviewList.all')}</option>
          {[...reviews].map(([id, review]) => <option key={id} value={id}>{review.company} · {review.unit} · {review.cycle}</option>)}
        </select>
      </label>
      <label className="grid gap-1 text-sm">{t('actor')}
        <select name="actor" defaultValue={actor} className={inputCls}>
          <option value="">{rewards('reviewList.all')}</option>
          {[...users].map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
      </label>
      <button className={btnPrimary}>{rewards('reviewList.apply')}</button>
    </form>
    <div className="overflow-x-auto"><table className="w-full text-left text-sm">
      <thead className="border-y border-border"><tr>
        {(['time', 'review', 'actor', 'event', 'reason'] as const).map(key => <th className="p-3" scope="col" key={key}>{t(key)}</th>)}
      </tr></thead>
      <tbody className="divide-y divide-border">{entries.map(entry => <tr key={entry.id}>
        <td className="p-3 whitespace-nowrap">{date.format(entry.time)}</td>
        <td className="p-3">{reviews.get(entry.unitId)?.unit}</td>
        <td className="p-3">{entry.actorName ?? rewards('reviewList.restrictedName')}</td>
        <td className="p-3">{t(`events.${entry.eventType.slice('reward-unit.'.length)}`)}</td>
        <td className="p-3">{entry.reason || '—'}</td>
      </tr>)}
      {!entries.length && <tr><td className="p-3" colSpan={5}>{t('empty')}</td></tr>}</tbody>
    </table></div>
  </Card>;
}

import Link from 'next/link';
import { formatMoney } from '@/lib/money';
import { getLocale, getTranslations } from 'next-intl/server';
import { Card, btnPrimary, inputCls } from '@/components/ui';
import type { SessionContext } from '@/db/client';
import { rewardReviewActivity } from '@/packs/rewards/activity';
import type { RewardAccessAdministration } from '@/packs/rewards/service';

export async function RewardReviewActivity({ session, value, reviewId, actorId, subjectId }: {
  session: SessionContext; value: RewardAccessAdministration; reviewId?: string; actorId?: string; subjectId?: string;
}) {
  const reviews = new Map(value.reviews.map(review => [review.id, review]));
  const users = new Map(value.users.flatMap(user => user.name ? [[user.id, user.name] as const] : []));
  const selected = reviewId && reviews.has(reviewId) ? reviewId : '';
  const actor = actorId && users.has(actorId) ? actorId : '';
  const subject = subjectId && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(subjectId) ? subjectId : undefined;
  const activityUrl = (subjectId?: string) => '/admin/rewards/access?' + new URLSearchParams({tab:'activity', ...(selected?{review:selected}:{}), ...(actor?{actor}:{}), ...(subjectId?{subject:subjectId}:{})});
  const [t, rewards, locale, entries] = await Promise.all([
    getTranslations('rewardsAccess.reviewActivity'), getTranslations('rewards'), getLocale(),
    rewardReviewActivity(session, selected ? [selected] : [...reviews.keys()], actor || undefined, subject),
  ]);
  const changeField = (field: string) => {
    const keys: Record<string,string> = { meritBp:'merit',promotionGrade:'promotionGrade',promotionBp:'promotion',specialBp:'special',multiplierBp:'bonusMultiplier',bonusCents:'bonus',lumpCents:'lumpSum',reason:'businessCase',note:'desk.person.notes',erDecision:'erDecision',pipDecision:'pipDecision',caseReason:'caseReason',withhold:'desk.panel.withheld',currentRoleSummary:'currentRoleSummary',proposedRoleSummary:'proposedRoleSummary' };
    return keys[field] ? rewards(keys[field]) : field;
  };
  const changeValue = (field: string, value: unknown): string => value == null ? '—' : typeof value === 'number' ? field.endsWith('Cents') ? formatMoney(value / 100,'MYR',locale) : field === 'multiplierBp' ? (value / 10000).toFixed(2) : `${(value / 100).toFixed(2)}%` : typeof value === 'object' ? Object.values(value).join('; ') || '—' : ['erDecision','pipDecision'].includes(field) ? rewards(`case.${value}`) : String(value);
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
      {subject && <input type="hidden" name="subject" value={subject} />}
      <button className={btnPrimary}>{rewards('reviewList.apply')}</button>
    </form>
    {subject && <Link className="text-sm text-primary underline" href={activityUrl()}>{t('clearSubject')}</Link>}
    <div className="overflow-x-auto"><table className="w-full text-left text-sm">
      <thead className="border-y border-border"><tr>
        {(['time', 'review', 'actor', 'subject', 'event', 'reason'] as const).map(key => <th className="p-3" scope="col" key={key}>{t(key)}</th>)}
      </tr></thead>
      <tbody className="divide-y divide-border">{entries.map(entry => <tr key={entry.id}>
        <td className="p-3 whitespace-nowrap">{date.format(new Date(entry.time))}</td>
        <td className="p-3">{reviews.get(entry.unitId)?.unit}</td>
        <td className="p-3">{entry.actorName ?? rewards('reviewList.restrictedName')}</td>
        <td className="p-3">{entry.subjectId && entry.subjectName ? <Link className="text-primary underline" href={activityUrl(entry.subjectId)}>{entry.subjectName}</Link> : '—'}</td>
        <td className="p-3">{t(`events.${entry.eventType.slice('reward-unit.'.length)}`)}</td>
        <td className="p-3">{entry.reason || '—'}{entry.changes?.length > 0 && <ul className="mt-2 space-y-1 text-xs text-muted-foreground">{entry.changes.map((change,index) => <li key={index}>{rewards('desk.panel.auditChange',{ field: changeField(change.field), before: changeValue(change.field,change.before), after: changeValue(change.field,change.after) })}</li>)}</ul>}</td>
      </tr>)}
      {!entries.length && <tr><td className="p-3" colSpan={6}>{t('empty')}</td></tr>}</tbody>
    </table></div>
  </Card>;
}

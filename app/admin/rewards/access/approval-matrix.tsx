import { getTranslations } from 'next-intl/server';
import { Card, btnPrimary, inputCls } from '@/components/ui';
import { rewardGroupRoleDirectory } from '@/packs/rewards/group-roles';
import type { SessionContext } from '@/db/client';
import type { RewardAccessAdministration } from '@/packs/rewards/service';

const roles = ['bu', 'bg', 'gr', 'ctro', 'ec'] as const;

export async function RewardApprovalMatrix({ value, cycleId, groupSession }: { value: RewardAccessAdministration; cycleId?: string; groupSession?: SessionContext }) {
  const [t, rewards, access, directory] = await Promise.all([getTranslations('rewardsAccess'), getTranslations('rewards'), getTranslations('rewardsAccessControl'), groupSession ? rewardGroupRoleDirectory(groupSession) : []]);
  const userNames = new Map(value.users.map(user => [user.id, user.name]));
  const cycles = new Map(value.reviews.map(review => [review.cycleId, { name: review.cycle, year: review.year }]));
  const selected = cycleId && cycles.has(cycleId) ? cycleId : '';
  const rows = value.reviews.filter(review => !selected || review.cycleId === selected);
  const activeByUnit = new Map<string, RewardAccessAdministration['members']>();
  for (const member of value.members) {
    if (member.disabled) continue;
    const active = activeByUnit.get(member.unitId) ?? [];
    active.push(member);
    activeByUnit.set(member.unitId, active);
  }
  return <Card className="space-y-4 p-4">
    <p className="text-sm text-muted-foreground">{t('coverageHelp')}</p>
    <form className="flex items-end gap-3" method="get">
      <input type="hidden" name="tab" value="matrix" />
      <label className="grid gap-1 text-sm">{rewards('cycle')}
        <select name="cycle" defaultValue={selected} className={inputCls}>
          <option value="">{rewards('reviewList.all')}</option>
          {[...cycles].map(([id, cycle]) => <option key={id} value={id}>{cycle.name} · {cycle.year}</option>)}
        </select>
      </label>
      <button className={btnPrimary}>{rewards('reviewList.apply')}</button>
    </form>
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="border-y border-border"><tr>
          {(['cycle', 'company', 'unit'] as const).map(label => <th scope="col" className="p-3" key={label}>{rewards(label)}</th>)}
          {roles.map(role => <th scope="col" className="p-3" key={role}>{rewards(`roles.${role}`)}</th>)}
        </tr></thead>
        <tbody className="divide-y divide-border">
          {rows.map(review => <tr key={review.id} className="align-top">
            <td className="p-3">{review.cycle} · {review.year}</td>
            <td className="p-3">{review.company}</td>
            <td className="p-3">{review.unit}</td>
            {roles.map(role => {
              const coverage = review.coverage?.roles.find(seat => seat.role === role);
              const members = activeByUnit.get(review.id)?.filter(member => member.role === role) ?? [];
              const directIds = new Set(members.map(member => member.userId));
              const inherited = directory.filter(grant => grant.role === role && grant.active && grant.eligible && !directIds.has(grant.userId));
              return <td className="p-3" key={role}>{members.length || inherited.length ? <ul className="space-y-1">
                {members.map(member => <li key={member.id}>{member.name ?? rewards('reviewList.restrictedName')}
                  {member.coversUserId && <span className="ml-1 text-xs text-muted-foreground">{access('proxyFor', { name: userNames.get(member.coversUserId) ?? rewards('reviewList.restrictedName') })}</span>}
                </li>)}
                {inherited.map(grant => <li key={grant.userId}>{grant.name} <span className="text-xs text-muted-foreground">({t('wholeGroup.title')})</span></li>)}
              </ul> : coverage?.required && !review.coverage?.missing.includes(role)
                ? t('wholeGroup.title') : t(coverage?.required ? 'missingRole' : 'optionalNone')}</td>;
            })}
          </tr>)}
          {!rows.length && <tr><td className="p-3" colSpan={8}>{rewards('reviewList.noMatches')}</td></tr>}
        </tbody>
      </table>
    </div>
  </Card>;
}

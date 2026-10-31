import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { requireModule } from '@/lib/authz';
import { getRewardCalendar, getRewardConfiguration, getRewardSeniorMembership, rewardSetupChoices } from '@/packs/rewards/service';
import { RewardCalendarForm } from '@/app/(app)/rewards/[unitId]/calendar-form';
import { rewardRoles } from '@/packs/rewards/model';
import { Badge, ErrorBanner, Field, PageHeader, inputCls } from '@/components/ui';
import { PolicyForm, RewardPolicyFields } from '@/app/(app)/rewards/[unitId]/policy-form';
import { RewardSubmit } from '@/app/(app)/rewards/submit-button';
import { memberAction } from '@/app/(app)/rewards/actions';
import { SeniorMembership } from '@/app/(app)/rewards/[unitId]/senior-membership';

export default async function RewardConfigurationPage({ params, searchParams }: {
  params: Promise<{ unitId: string }>;
  searchParams: Promise<{ error?: string; mode?: string }>;
}) {
  await requireModule('rewards');
  // Delegated Group Rewards reviewers retain their existing policy access. The service checks
  // fresh company administration or assigned GR membership, without loading employee pay records.
  const { s, scopeIds } = await scopedSession();
  const { unitId } = await params;
  const { error,mode } = await searchParams;
  const readOnly=mode==='view';
  const t = await getTranslations('rewards');
  const td=await getTranslations('rewardsDeletion'),tc=await getTranslations('rewardsConfig');
  const v = await getRewardConfiguration(s, unitId);
  const choices = await rewardSetupChoices(s, scopeIds);
  const { unit } = v;
  const senior = !readOnly && v.canConfigure ? await getRewardSeniorMembership(s, unitId) : null;
  const calendar = await getRewardCalendar(s, unitId);
  const fields = <><input type="hidden" name="unitId" value={unitId} /><input type="hidden" name="revision" value={unit.revision} /></>;
  return <div className="w-full space-y-6">
    {choices.companies.length > 0 && <Link href="/admin/rewards" className="text-sm text-primary hover:underline">← {t('adminTitle')}</Link>}
    <PageHeader title={`${t('configuration')} · ${v.cycle?.name ?? t('title')} · ${v.name}`} description={`${t(`kinds.${unit.kind}`)} · ${unit.kind === 'annual' && unit.status === 'withdrawn' ? tc('cancelled') : t(`stages.${unit.status}`)}`} />
    <ErrorBanner message={error} />
    {readOnly&&<p className="rounded-md border p-3 text-sm">{td('viewHelp')}</p>}
    {v.policyOrigin&&<p className="rounded-md border p-3 text-sm">{t('sharedPolicy.origin',{name:v.policyOrigin.name,version:v.policyOrigin.revision})}{v.policyOrigin.changed&&<><Badge variant="info" className="ml-2 normal-case">{tc('shared.changedInReview')}</Badge><span className="mt-1 block text-muted-foreground">{t('sharedPolicy.reviewChanged')}</span></>}</p>}
    <section className="space-y-3">
      <h2 className="font-semibold">{t('access')}</h2>
      <p className="max-w-3xl text-sm text-muted-foreground">{t('accessHelp')}</p>
      <ul className="divide-y divide-border">{v.members.map(m => <li key={m.id} className="flex items-center justify-between gap-3 py-2 text-sm">
        <span>{t(`roles.${m.role}`)} · {choices.users.find(u => u.id === m.userId)?.name ?? t('assignedUser')}</span>
        {!readOnly && v.canManageMembers && <form action={memberAction}>{fields}<input type="hidden" name="userId" value={m.userId} /><input type="hidden" name="role" value={m.role} /><input type="hidden" name="remove" value="true" /><RewardSubmit variant="ghost" size="sm" type="submit">{t('remove')}</RewardSubmit></form>}
      </li>)}</ul>
      {!readOnly && v.canManageMembers && <form action={memberAction} className="flex flex-wrap items-end gap-3">{fields}
        <Field label={t('user')}><select required name="userId" className={inputCls}>{choices.users.map(u => <option key={u.id} value={u.id}>{u.name ?? u.email ?? t('administrator')}</option>)}</select></Field>
        <Field label={t('role')}><select name="role" className={inputCls}>{rewardRoles.map(role => <option key={role} value={role}>{t(`roles.${role}`)}</option>)}</select></Field>
        <RewardSubmit type="submit" variant="secondary">{t('assign')}</RewardSubmit>
      </form>}
    </section>
    {unit.kind !== 'annual' && <p className="max-w-3xl text-sm text-muted-foreground">{t('inheritedPolicy')} <Link className="text-primary hover:underline" href={`/admin/rewards/${unit.parentUnitId}`}>{t('annualSource')}</Link></p>}
    {!v.canConfigure && <p className="max-w-3xl text-sm text-muted-foreground">{unit.status === 'draft' ? t('configurationPermission') : t('locked')}</p>}
    <RewardCalendarForm unitId={unitId} revision={calendar.revision} values={calendar.values} canEdit={!readOnly && calendar.canEdit} />
    {senior && <SeniorMembership key={senior.revision} value={senior} />}
    <RewardPolicyContent readOnly={readOnly} canReadPat={v.canReadPat} canConfigure={v.canConfigure} unitId={unitId} revision={unit.revision} policy={unit.policy} />
  </div>;
}

async function RewardPolicyContent({readOnly,canConfigure,canReadPat,unitId,revision,policy}:{readOnly:boolean;canConfigure:boolean;canReadPat:boolean;unitId:string;revision:number;policy:import('@/packs/rewards/model').RewardPolicy}){
 if(readOnly||!canConfigure)return <RewardPolicyFields policy={policy} readOnly unitId={unitId} hideUnitInputs={!canReadPat}/>;
 return <PolicyForm unitId={unitId} revision={revision} policy={policy}/>;
}

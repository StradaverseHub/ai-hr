import Link from 'next/link';
import {notFound} from 'next/navigation';
import {getTranslations} from 'next-intl/server';
import {scopedAdmin} from '@/lib/scope';
import {requireModule} from '@/lib/authz';
import {todayInKualaLumpur} from '@/lib/hr-date';
import {adminCompanies} from '@/core/read';
import {listRewardPolicyGroups,rewardPolicyGroupUsage,rewardSetupChoices,defaultPolicy} from '@/packs/rewards/service';
import {Card,PageHeader} from '@/components/ui';
import {RewardPolicyFields} from '@/app/rewards/[unitId]/policy-form';
import {SharedRewardEditor} from './editor';
import {saveSharedRewardPolicyAction} from './actions';
export default async function SharedRewardPolicyPage({searchParams}:{searchParams:Promise<{group?:string}>}){
 await requireModule('rewards');const {s}=await scopedAdmin(),t=await getTranslations('rewards.sharedPolicy'),{group:groupId}=await searchParams;
 const groups=await listRewardPolicyGroups(s),selected=groupId?groups.find(row=>row.groupId===groupId):null;if(groupId&&!selected)notFound();
 // Deliberately all permitted companies for multi-company setup, rather than the current header filter.
 const companies=await adminCompanies(s),choices=await rewardSetupChoices(s,companies.map(company=>company.id),{includeArchived:true,sharedPolicy:true});
 const policy=selected?.policy??defaultPolicy(Number(todayInKualaLumpur().slice(0,4)));
 const usage=selected?await rewardPolicyGroupUsage(s,selected.groupId):[];
 return <div className="mx-auto max-w-6xl space-y-6"><PageHeader title={t('title')} description={t('description')}/>
  <Link href="/admin/rewards" className="text-sm text-primary hover:underline">{t('backToReviews')}</Link><p className="text-sm text-muted-foreground">{t('currencyHelp')}</p>
  <Card className="space-y-3 p-4"><Link href="/admin/rewards/shared" className="text-sm font-medium text-primary hover:underline">{t('create')}</Link>
   {groups.length?<ul className="grid gap-2 sm:grid-cols-2">{groups.map(group=><li key={group.groupId}><Link href={`/admin/rewards/shared?group=${group.groupId}`} aria-current={selected?.groupId===group.groupId?'page':undefined} className="block rounded-md border px-3 py-2 text-sm hover:bg-muted">{group.name} · {t('version',{version:group.revision})}</Link></li>)}</ul>:<p className="text-sm text-muted-foreground">{t('empty')}</p>}
  </Card>
  {choices.companies.length>0&&<SharedRewardEditor actorUserId={s.userId??''} groupId={selected?.groupId??null} revision={selected?.revision??0} name={selected?.name??''} year={policy.year} targets={selected?.targets??[]} companies={choices.companies} units={choices.units}
   policyFields={<RewardPolicyFields policy={policy} context="shared"/>} saveAction={saveSharedRewardPolicyAction}/>}
  {selected&&<Card className="space-y-3 p-4"><h2 className="font-semibold">{t('usage')}</h2><p className="text-sm text-muted-foreground">{t('usageHelp')}</p>{usage.length?<ul className="divide-y">{usage.map(row=><li key={row.unitId} className="py-2 text-sm"><Link className="text-primary hover:underline" href={`/admin/rewards/${row.unitId}`}>{row.cycle} · {row.company} · {row.businessUnit} · {t('version',{version:row.revision})}</Link></li>)}</ul>:<p className="text-sm text-muted-foreground">{t('unused')}</p>}</Card>}
 </div>;
}

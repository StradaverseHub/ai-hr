import Link from 'next/link';
import {notFound} from 'next/navigation';
import {getTranslations} from 'next-intl/server';
import {scopedAdmin} from '@/lib/scope';
import {requireModule} from '@/lib/authz';
import {todayInKualaLumpur} from '@/lib/hr-date';
import {adminCompanies,companyTree} from '@/core/read';
import {rewardCompanyExclusions,rewardPolicyHistory,rewardPolicyTaken,listRewardPolicyGroups,rewardPolicyGroupUsage,rewardSetupChoices,defaultPolicy} from '@/packs/rewards/service';
import {Card,PageHeader} from '@/components/ui';
import {rewardPolicyMemberships} from '@/packs/rewards/service';
import {RewardPolicyFields} from '@/app/(app)/rewards/[unitId]/policy-form';
import {SharedRewardHistory} from './history';
import {SharedRewardEditor} from './editor';
import {RewardsAdminTabs} from '../admin-tabs';
import {changeSharedRewardExclusionAction,loadSharedRewardTakenAction,saveSharedRewardPolicyAction} from './actions';
export default async function SharedRewardPolicyPage({searchParams}:{searchParams:Promise<{group?:string;versions?:string;version?:string;compare?:string|string[]}>}){
 await requireModule('rewards');const {s}=await scopedAdmin(),t=await getTranslations('rewards.sharedPolicy'),params=await searchParams,{group:groupId}=params;
 const groups=await listRewardPolicyGroups(s),selected=groupId?groups.find(row=>row.groupId===groupId):null;if(groupId&&!selected)notFound();
 // Deliberately all permitted companies for multi-company setup, rather than the current header filter.
 const companies=await adminCompanies(s),choices=await rewardSetupChoices(s,companies.map(company=>company.id),{includeArchived:true,sharedPolicy:true});
 const policy=selected?.policy??defaultPolicy(Number(todayInKualaLumpur().slice(0,4)));
 const tree=await companyTree(s),nodes=new Map(tree.map(node=>[node.id,node]));
 const groupedCompanies=choices.companies.map(company=>{
  const node=nodes.get(company.id),parent=node?.parentId?nodes.get(node.parentId):null;
  const group=parent??(tree.some(child=>child.parentId===company.id)?node:null);
  return {...company,groupId:group?.id??null,groupName:group?.name??null};
 });
 const memberships=await rewardPolicyMemberships(s,choices.companies.map(company=>company.id));
 const taken=await rewardPolicyTaken(s,choices.companies.map(company=>company.id),policy.year);
 const exclusions=await rewardCompanyExclusions(s);
 const selectedHistory=selected&&params.version?await rewardPolicyHistory(s,selected.groupId):[];
 const shownVersion=params.version?selectedHistory.find(row=>row.version.versionId===params.version):null;
 if(params.version&&!shownVersion)notFound();
 const usage=(selected?await rewardPolicyGroupUsage(s,selected.groupId):[]).filter(row=>!shownVersion||row.revision===shownVersion.version.revision);
 return <div className="mx-auto max-w-6xl space-y-6"><PageHeader title={t('title')} description={t('description')}/>
  <RewardsAdminTabs current="shared"/><p className="text-sm text-muted-foreground">{t('currencyHelp')}</p>
  <SharedRewardHistory session={s} groups={groups} groupId={groupId} showVersions={params.versions} versionId={params.version} compare={params.compare} companies={choices.companies} units={choices.units}/>
  {choices.companies.length>0&&<SharedRewardEditor actorUserId={s.userId??''} groupId={selected?.groupId??null} revision={selected?.revision??0} name={selected?.name??''} year={policy.year} targets={selected?.targets??[]} companies={groupedCompanies} units={choices.units} memberships={memberships} initialTaken={taken} loadTakenAction={loadSharedRewardTakenAction} canManageUnits={companies.length>0} exclusions={exclusions} exclusionAction={changeSharedRewardExclusionAction}
   policyFields={<RewardPolicyFields policy={policy} context="shared"/>} saveAction={saveSharedRewardPolicyAction}/>}
  {selected&&<Card id="configuration-usage" className="space-y-3 p-4"><h2 className="font-semibold">{t('usage')}</h2><p className="text-sm text-muted-foreground">{t('usageHelp')}</p>{usage.length?<ul className="divide-y">{usage.map(row=><li key={row.unitId} className="py-2 text-sm"><Link className="text-primary hover:underline" href={`/admin/rewards/${row.unitId}`}>{row.cycle} · {row.company} · {row.businessUnit} · {t('version',{version:row.revision})}</Link></li>)}</ul>:<p className="text-sm text-muted-foreground">{t('unused')}</p>}</Card>}
 </div>;
}

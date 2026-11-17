import { rewardWholeGroupSetupCompanies } from '@/packs/rewards/group-roles';
import { getSession } from '@/lib/session';
import Link from 'next/link';
import {notFound} from 'next/navigation';
import {getTranslations} from 'next-intl/server';
import {scopedAdmin} from '@/lib/scope';
import {requireModule} from '@/lib/authz';
import {adminCompanies} from '@/core/read';
import {rewardPolicyHistory,listRewardPolicyGroups,rewardPolicyGroupUsage,rewardSetupChoices} from '@/packs/rewards/service';
import {Card,PageHeader} from '@/components/ui';
import {SharedRewardHistory} from '../shared/history';
export default async function SharedRewardPolicyPage({searchParams}:{searchParams:Promise<{group?:string;versions?:string;version?:string;compare?:string|string[]}>}){
 await requireModule('rewards');
 const session=await getSession(),wholeGroup=await rewardWholeGroupSetupCompanies(session);
 const {s}=wholeGroup.length?{s:session}:await scopedAdmin(),t=await getTranslations('rewards.sharedPolicy'),params=await searchParams,{group:groupId}=params;
 const groups=await listRewardPolicyGroups(s),selected=groupId?groups.find(row=>row.groupId===groupId):null;if(groupId&&!selected)notFound();
 // Deliberately all permitted companies for multi-company setup, rather than the current header filter.
 const companies=wholeGroup.length?wholeGroup:await adminCompanies(s),choices=await rewardSetupChoices(s,companies.map(company=>company.id),{includeArchived:true,sharedPolicy:true,fields:['units']});
 const selectedHistory=selected&&params.version?await rewardPolicyHistory(s,selected.groupId):[];
 const shownVersion=params.version?selectedHistory.find(row=>row.version.versionId===params.version):null;
 if(params.version&&!shownVersion)notFound();
 const usage=(selected?await rewardPolicyGroupUsage(s,selected.groupId):[]).filter(row=>!shownVersion||row.revision===shownVersion.version.revision);
 return <div className="mx-auto max-w-6xl space-y-6"><PageHeader title={(await getTranslations('rewardsReviewPlans'))('earlierPlans')} description={t('description')}/>
  <p className="text-sm text-muted-foreground">{t('currencyHelp')}</p>
  <SharedRewardHistory session={s} groups={groups} groupId={groupId} showVersions={params.versions} versionId={params.version} compare={params.compare} companies={choices.companies} units={choices.units}/>
  {selected&&<Card id="configuration-usage" className="space-y-3 p-4"><h2 className="font-semibold">{t('usage')}</h2><p className="text-sm text-muted-foreground">{t('usageHelp')}</p>{usage.length?<ul className="divide-y">{usage.map(row=><li key={row.unitId} className="py-2 text-sm"><Link className="text-primary hover:underline" href={`/admin/rewards/${row.unitId}`}>{row.cycle} · {row.company} · {row.businessUnit} · {t('version',{version:row.revision})}</Link></li>)}</ul>:<p className="text-sm text-muted-foreground">{t('unused')}</p>}</Card>}
 </div>;
}

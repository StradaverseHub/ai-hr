import {rewardReviewCompanyGroups,rewardWholeGroupPlans} from '@/packs/rewards/group-roles';
import {rewardNavigation,rewardVisibleCompanies} from '@/packs/rewards/access-policy';
import { ScopedCommandIndex } from '@/components/scoped-command-index';
import {getTranslations} from 'next-intl/server';
import {scopedSession,getScopeIds} from '@/lib/scope';
import {requireModule} from '@/lib/authz';
import {listRewardReviewStatus,rewardSetupChoices} from '@/packs/rewards/service';
import {ErrorBanner,PageHeader} from '@/components/ui';
import type {RewardReviewFilters} from '@/packs/rewards/review-list-model';
import {RewardReviewActions} from '@/app/admin/rewards/review-actions';
import {RewardReviewList} from '../review-list';
export default async function RewardsPage({searchParams}:{searchParams:Promise<RewardReviewFilters&{error?:string;deleted?:string;deletionError?:string;cancelled?:string}>}){
 await requireModule('rewards');
 const {s}=await scopedSession();
 const companies=await rewardVisibleCompanies(s),allowedIds=companies.map(c=>c.id),scopeIds=companies.some(c=>c.wholeGroup)?allowedIds:await getScopeIds(allowedIds);
 const t=await getTranslations('rewards'), nav=await getTranslations('nav'), sp=await searchParams;
 const [list,choices,destinations,plans,companyGroups]=await Promise.all([
   listRewardReviewStatus(s,scopeIds),rewardSetupChoices(s,scopeIds,{fields:[]}),rewardNavigation(s),rewardWholeGroupPlans(s),rewardReviewCompanyGroups(s,scopeIds),
 ]);
 const maintenanceIds=new Set(choices.companies.map(company=>company.id));
 const maintenanceActions=new Map(list.rows.filter(row=>maintenanceIds.has(row.companyId)).map(row=>[row.id,<RewardReviewActions key={row.id} review={row}/>]));
 const [setup,deletion,configuration]=await Promise.all([getTranslations('rewardSetup'),getTranslations('rewardsDeletion'),getTranslations('rewardsConfig')]);
 return <div className="w-full space-y-6"><PageHeader title={nav('rewardsAllReviews')} description={t('description')}/>
  <ScopedCommandIndex entries={list.rows.filter(row=>row.roles.length>0).map(row=>({href:`/rewards/${row.id}`,label:row.unit,context:`${row.company} · ${row.cycle}`}))}/>
  <ErrorBanner message={sp.error}/>
  <ErrorBanner message={sp.deletionError?deletion('error'):undefined}/>
  {sp.deleted==='1'&&<p role="status">{deletion('saved')}</p>}
  {sp.cancelled==='1'&&<p role="status">{configuration('actions.cancelledSaved')}</p>}
  {plans.length>0&&<details className="rounded-lg border border-border p-4">
    <summary className="cursor-pointer font-medium">{setup('plans')} ({plans.length})</summary>
    <ul className="mt-3 divide-y divide-border">
      {plans.map(plan=><li key={plan.id} className="space-y-1 py-3 text-sm">
        <p className="font-medium">{plan.cycle} · {plan.year}</p>
        <p>{t('stage')}: {setup(plan.state)} · {setup('snapshotDate')}: {plan.snapshot}</p>
        <p className="text-muted-foreground">{plan.companies.join(' · ')}</p>
      </li>)}
    </ul>
  </details>}
  <RewardReviewList {...list} canOpenApprovals={destinations.includes('/rewards/approvals')} companyGroups={companyGroups} filters={sp} maintenanceActions={maintenanceActions} canConfigure={choices.companies.length>0}/></div>;
}

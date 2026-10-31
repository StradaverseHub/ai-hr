import {getTranslations} from 'next-intl/server';
import {requireModule} from '@/lib/authz';
import {scopedAdmin} from '@/lib/scope';
import {rewardAccessSingleAdminCompanies,rewardAccessRequests,rewardAccessAdministration} from '@/packs/rewards/service';
import {PageHeader} from '@/components/ui';
import {RewardAccessEditor} from './access-editor';
import {RewardsAdminTabs} from '../admin-tabs';
export default async function RewardAccessPage(){
 await requireModule('rewards');const{s,scopeIds}=await scopedAdmin();const t=await getTranslations('rewardsAccess');
 const value=await rewardAccessAdministration(s,scopeIds),requests=await rewardAccessRequests(s),singleAdminCompanies=await rewardAccessSingleAdminCompanies(s,scopeIds);
 return <div className="w-full space-y-6"><PageHeader title={t('title')} description={t('description')}/><RewardsAdminTabs current="access"/><RewardAccessEditor value={value} requests={requests} singleAdminCompanies={singleAdminCompanies}/></div>;
}

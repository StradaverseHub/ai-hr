import {getTranslations} from 'next-intl/server';
import {requireModule} from '@/lib/authz';
import {scopedSession,getScopeIds} from '@/lib/scope';
import {rewardAccessCompanies,rewardAccessRequests,rewardAccessAdministration} from '@/packs/rewards/service';
import {PageHeader} from '@/components/ui';
import {RewardAccessEditor} from './access-editor';
import {RewardsAdminTabs} from '../admin-tabs';
export default async function RewardAccessPage(){
 await requireModule('rewards');const {s}=await scopedSession(),scopeIds=await getScopeIds((await rewardAccessCompanies(s)).map(c=>c.id));const t=await getTranslations('rewardsAccess');
 const value=await rewardAccessAdministration(s,scopeIds),requests=(await rewardAccessRequests(s)).filter(q=>q.changes.every(c=>value.reviews.some(r=>r.id===c.unitId)));
 return <div className="w-full space-y-6"><PageHeader title={t('title')} description={t('description')}/><RewardsAdminTabs current="access"/><RewardAccessEditor value={value} requests={requests}/></div>;
}

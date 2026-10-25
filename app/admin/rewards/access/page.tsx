import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {requireModule} from '@/lib/authz';
import {scopedAdmin} from '@/lib/scope';
import {rewardAccessAdministration} from '@/packs/rewards/service';
import {PageHeader} from '@/components/ui';
import {RewardAccessEditor} from './access-editor';
export default async function RewardAccessPage(){
 await requireModule('rewards');const{s,scopeIds}=await scopedAdmin();const t=await getTranslations('rewardsAccess');
 const value=await rewardAccessAdministration(s,scopeIds);
 return <div className="w-full space-y-6"><PageHeader title={t('title')} description={t('description')}/><Link href="/admin/rewards" className="text-sm text-primary hover:underline">{t('configuration')}</Link><RewardAccessEditor value={value}/></div>;
}

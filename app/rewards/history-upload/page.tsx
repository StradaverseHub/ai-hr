import Link from 'next/link';
import {notFound} from 'next/navigation';
import {getTranslations} from 'next-intl/server';
import {scopedSession} from '@/lib/scope';
import {requireModule} from '@/lib/authz';
import {PageHeader} from '@/components/ui';
import {rewardHistoryUploadCompanies,latestRewardPersonHistoryImport} from '@/packs/rewards/person-history-upload';
import {RewardHistoryUploadEditor} from './upload-editor';

export default async function RewardHistoryUploadPage(){
 await requireModule('rewards');const{s}=await scopedSession(),companies=await rewardHistoryUploadCompanies(s);
 if(!companies.length)notFound();const t=await getTranslations('rewardsPersonHistoryUpload');
 return <div className="space-y-5">
  <Link href="/rewards" className="text-sm text-primary underline underline-offset-4">{t('back')}</Link>
  <PageHeader title={t('title')} description={t('description')}/>
  <RewardHistoryUploadEditor companies={companies} initialProgress={await latestRewardPersonHistoryImport(s)}/>
 </div>;
}

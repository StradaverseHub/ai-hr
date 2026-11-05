import {rewardAccessPageCompanies,rewardVisibleCompanies,rewardSetupEntry} from '@/packs/rewards/access-policy';
import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {scopedSession,getScopeIds} from '@/lib/scope';
import {requireModule} from '@/lib/authz';
import {listRewardReviewStatus,rewardSetupChoices} from '@/packs/rewards/service';
import {ErrorBanner,PageHeader} from '@/components/ui';
import type {RewardReviewFilters} from '@/packs/rewards/review-list-model';
import {RewardReviewList} from './review-list';
export default async function RewardsPage({searchParams}:{searchParams:Promise<RewardReviewFilters&{error?:string}>}){
 await requireModule('rewards');const {s}=await scopedSession(),scopeIds=await getScopeIds((await rewardVisibleCompanies(s)).map(c=>c.id)),setupEntry=await rewardSetupEntry(s),t=await getTranslations('rewards'),sp=await searchParams;
 const [list,choices]=await Promise.all([listRewardReviewStatus(s,scopeIds),rewardSetupChoices(s,scopeIds,{fields:[]})]),canConfigure=choices.companies.length>0,accessScopes=await rewardAccessPageCompanies(s).catch(()=>[]);
 return <div className="w-full space-y-6"><PageHeader title={t('title')} description={t('description')} actions={<>
  {setupEntry.manage&&<Link href="/admin/rewards/uploaded" className="inline-flex text-sm font-medium text-primary hover:underline">{(await getTranslations('rewardUploaded'))('createTitle')}</Link>}
  <Link href="/rewards/analytics" className="inline-flex text-sm font-medium text-primary hover:underline">{(await getTranslations('rewardAdvisor'))('analytics')}</Link>
  <Link href="/rewards/rules" className="inline-flex text-sm font-medium text-primary hover:underline">{t('rules')}</Link>
  <Link href="/rewards/approvals" className="inline-flex text-sm font-medium text-primary hover:underline">{t('board.open')}</Link>
  {accessScopes.length>0&&<Link href="/admin/rewards/access" className="inline-flex text-sm font-medium text-primary hover:underline">{(await getTranslations('rewardsAccess'))('title')}</Link>}
  {(canConfigure||setupEntry.manage)&&<Link href={setupEntry.manage?'/admin/rewards/plans':'/admin/rewards'} className="inline-flex text-sm font-medium text-primary hover:underline">{t('adminTitle')}</Link>}
  {setupEntry.bootstrap&&<Link href="/admin/rewards/setup-access" className="text-sm font-medium text-primary hover:underline">{(await getTranslations('rewardSetupAccess'))('title')}</Link>}
  {setupEntry.libraries&&<><Link href="/admin/rewards/salary-structures" className="text-sm font-medium text-primary hover:underline">{(await getTranslations('rewardAccessPolicy'))('permissions.salary.view')}</Link><Link href="/admin/rewards/bonus-matrices" className="text-sm font-medium text-primary hover:underline">{(await getTranslations('rewardAccessPolicy'))('permissions.bonus.view')}</Link></>}
 </>}/><ErrorBanner message={sp.error}/><RewardReviewList {...list} filters={sp} canConfigure={canConfigure}/></div>;
}

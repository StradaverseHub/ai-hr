import {RewardReviewActions} from './review-actions';
import {RewardReviewCreateForm} from './create-review-form';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { requireModule } from '@/lib/authz';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { listRewardUnits, rewardSetupChoices,rewardSharedPolicyChoices } from '@/packs/rewards/service';
import { Card, ErrorBanner, PageHeader, SectionHeader, tableWrapCls, theadCls, thCls, tbodyCls } from '@/components/ui';


export default async function RewardsConfigurationPage({ searchParams }: { searchParams: Promise<{ error?: string;sharedError?:string; deleted?:string; deletionError?:string }> }) {
  await requireModule('rewards'); const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('rewards'); const { error,sharedError,deleted,deletionError } = await searchParams;
  const td=await getTranslations('rewardsDeletion');
  const choices = await rewardSetupChoices(s, scopeIds);
  const units = await listRewardUnits(s, choices.companies.map(c => c.id));
  const today = todayInKualaLumpur();
  const shared=await rewardSharedPolicyChoices(s,choices.companies.map(c=>c.id));
  return <div className="w-full space-y-6">
    <div data-tour="rewards-configuration"><PageHeader title={t('adminTitle')} description={t('adminDescription')} /></div>
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <Link href="/admin/rewards/shared" className="text-sm text-primary hover:underline">{t('sharedPolicy.title')}</Link>
      <Link href="/admin/rewards/access" className="text-sm text-primary hover:underline">{(await getTranslations('rewardsAccess'))('title')}</Link>
    </div>
    <ErrorBanner message={error} />
    <ErrorBanner message={deletionError?td('error'):undefined}/>
    {deleted==='1'&&<p role="status" className="rounded-md border p-3 text-sm">{td('saved')}</p>}
    <ErrorBanner message={['invalid','changed','scope','system'].includes(sharedError??'')?t(`sharedPolicy.errors.${sharedError as 'invalid'|'changed'|'scope'|'system'}`):undefined}/>
    <div data-tour="rewards-admin-units" className={tableWrapCls}><table className="w-full text-sm"><thead className={theadCls}><tr>{['cycle', 'company', 'unit', 'stage', 'action'].map(k => <th key={k} className={thCls}>{t(k)}</th>)}</tr></thead>
      <tbody className={tbodyCls}>{units.map(u => <tr key={u.id}><td className="px-3 py-3 font-medium">{u.cycle} · {t(`kinds.${u.kind}`)}<span className="ml-2 text-muted-foreground">{u.year}</span></td><td className="px-3 py-3">{u.company}</td><td className="px-3 py-3">{u.unit}</td><td className="px-3 py-3">{t(`stages.${u.status}`)}</td><td className="px-3 py-3"><RewardReviewActions review={u}/></td></tr>)}</tbody>
    </table>{!units.length && <p className="max-w-2xl px-5 py-10 text-sm text-muted-foreground">{t('adminEmpty')}</p>}</div>
    {choices.companies.length>0&&<Card><SectionHeader title={t('createUnit')}/><RewardReviewCreateForm actorUserId={s.userId??''} today={today} companies={choices.companies} units={choices.units} cycles={choices.cycles} shared={shared}/></Card>}
  </div>;
}

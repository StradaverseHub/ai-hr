import Link from 'next/link';
import {notFound} from 'next/navigation';
import {getTranslations} from 'next-intl/server';
import {requireModule} from '@/lib/authz';
import {uploadedRewardChoices} from '@/packs/rewards/uploaded-awards';
import {RewardSetupError} from '@/packs/rewards/setup-model';
import {PageHeader,Card,Button,inputCls,ErrorBanner} from '@/components/ui';
import {todayInKualaLumpur} from '@/lib/hr-date';
import {createUploadedAction} from './actions';
export default async function NewUploadedReview({searchParams}:{searchParams:Promise<{error?:string;company?:string;year?:string}>}){const session=await requireModule('rewards');
 const [v,t,r,sp]=await Promise.all([
  uploadedRewardChoices(session).catch(error=>{
   if(error instanceof RewardSetupError&&error.code==='forbidden')notFound();
   throw error;
  }),getTranslations('rewardUploaded'),getTranslations('rewards'),searchParams,
 ]);
 return <div className="space-y-5"><Link href="/admin/rewards" className="text-primary underline">← {t('configuration')}</Link><PageHeader title={t('createTitle')} description={t('description')}/><ErrorBanner message={sp.error}/><Card className="p-5"><form action={createUploadedAction} className="grid max-w-3xl gap-4 sm:grid-cols-2"><label className="text-sm">{t('company')}<select name="companyId" defaultValue={sp.company} className={inputCls} required>{v.companies.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label><label className="text-sm">{t('unit')}<select name="businessUnitId" className={inputCls} required>{v.units.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label><label className="text-sm">{t('cycle')}<select name="cycleId" className={inputCls}>{v.canCreateCycle&&<option value="">{r('newCycle')}</option>}{v.cycles.map(c=><option key={c.id} value={c.id}>{c.name} · {c.year}</option>)}</select></label>{v.canCreateCycle&&<label className="text-sm">{t('cycleName')}<input name="cycleName" maxLength={160} placeholder={r('cyclePlaceholder')} className={inputCls}/></label>}<label className="text-sm">{t('year')}<input type="number" name="year" min="2000" max="2200" defaultValue={sp.year??Number(todayInKualaLumpur().slice(0,4))} required className={inputCls}/></label><label className="text-sm">{t('snapshotDate')}<input type="date" name="snapshotDate" max={todayInKualaLumpur()} defaultValue={todayInKualaLumpur()} required className={inputCls}/></label><label className="text-sm sm:col-span-2">{t('reason')}<textarea name="reason" minLength={10} maxLength={2000} required className={inputCls}/></label><Button type="submit">{t('create')}</Button></form></Card></div>;}

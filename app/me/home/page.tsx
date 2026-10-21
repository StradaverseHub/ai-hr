import {getTranslations} from 'next-intl/server';
import {scopedSession} from '@/lib/scope';
import {getEmployeeHomePreferences} from '@/core/dashboard-prefs';
import {listEmployeeHomeCards} from '@/core/dashboard-card-config';
import {PageHeader,Card} from '@/components/ui';
import {HomePreferencesEditor} from '@/components/employee-home/preferences-editor';

export default async function HomePreferencesPage({searchParams}:{searchParams:Promise<{saved?:string}>}){
 const {s}=await scopedSession(),t=await getTranslations('employeeHome.preferences');
 const cards=await listEmployeeHomeCards(s),preferences=await getEmployeeHomePreferences(s,cards),query=await searchParams;
 return <div className="mx-auto max-w-3xl space-y-6"><PageHeader title={t('title')} description={t('intro')} back={{href:'/',label:t('back')}}/>
  {query.saved==='1'&&<p role="status" className="text-sm">{t('saved')}</p>}
  <Card className="p-4 sm:p-6"><HomePreferencesEditor key={JSON.stringify([preferences,cards])} initial={preferences} cards={cards}/></Card>
 </div>;
}

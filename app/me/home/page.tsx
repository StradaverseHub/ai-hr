import {Suspense} from 'react';
import {getTranslations} from 'next-intl/server';
import {scopedSession} from '@/lib/scope';
import {getEmployeeHomePreferences} from '@/core/dashboard-prefs';
import {listEmployeeHomeCards} from '@/core/dashboard-card-config';
import {PageHeader,Card} from '@/components/ui';
import {HomePreferencesEditor} from '@/components/employee-home/preferences-editor';
import {HomePersonPrivacySection} from '@/components/employee-home/person-privacy-section';

export default async function HomePreferencesPage({searchParams}:{searchParams:Promise<{saved?:string;privacySaved?:string}>}){
 const {s}=await scopedSession(),t=await getTranslations('employeeHome.preferences'),privacy=await getTranslations('employeeHome.personPrivacy');
 const cards=await listEmployeeHomeCards(s),preferences=await getEmployeeHomePreferences(s,cards),query=await searchParams;
 return <div className="mx-auto max-w-3xl space-y-6"><PageHeader title={t('title')} description={t('intro')} back={{href:'/',label:t('back')}}/>
  {query.saved==='1'&&<p role="status" className="text-sm">{t('saved')}</p>}
  <Card className="p-4 sm:p-6"><HomePreferencesEditor key={JSON.stringify([preferences,cards])} initial={preferences} cards={cards}/></Card>
  <Card className="space-y-4 p-4 sm:p-6"><section aria-labelledby="home-person-privacy-heading" className="space-y-4">
   <div className="space-y-2"><h2 id="home-person-privacy-heading" className="font-semibold">{privacy('title')}</h2><p className="max-w-prose text-sm text-muted-foreground">{privacy('intro')}</p><p className="max-w-prose text-sm text-muted-foreground">{privacy('resetHelp')}</p></div>
   <Suspense fallback={<p role="status" className="text-sm">{privacy('loading')}</p>}><HomePersonPrivacySection session={s} saved={query.privacySaved==='1'}/></Suspense>
  </section></Card>
 </div>;
}

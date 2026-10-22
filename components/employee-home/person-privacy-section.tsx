import {getTranslations} from 'next-intl/server';
import {unstable_rethrow} from 'next/navigation';
import type {SessionContext} from '@/db/client';
import {readOwnHomePersonPrivacy} from '@/core/employee-home-person-privacy';
import {HomePersonPrivacyEditor} from './person-privacy-editor';

/** Failed reads never display unchecked defaults that could silently re-enable sharing on save. */
export async function HomePersonPrivacySection({session}:{session:SessionContext}){
 const t=await getTranslations('employeeHome.personPrivacy');
 let privacy:Awaited<ReturnType<typeof readOwnHomePersonPrivacy>>;
 try{privacy=await readOwnHomePersonPrivacy(session);}
 catch(error){unstable_rethrow(error);return <p role="alert" className="text-sm">{t('loadFailed')} <a href="/me/home" className="underline underline-offset-4">{t('reload')}</a></p>;}
 return privacy?<HomePersonPrivacyEditor key={JSON.stringify(privacy)} initial={privacy}/>:<p className="text-sm text-muted-foreground">{t('unlinked')}</p>;
}

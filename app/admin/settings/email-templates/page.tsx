import {redirect} from 'next/navigation';
import {getTranslations} from 'next-intl/server';
import {scopedSession} from '@/lib/scope';
import {isGroupAdmin} from '@/lib/authz-model';
import {listEmailDesigns} from '@/core/email-design/service';
import {PageHeader} from '@/components/ui';
import {EmailDesigner} from './designer';
export default async function EmailTemplatesPage(){
 const {s:session}=await scopedSession();if(!isGroupAdmin(session))redirect('/');
 const t=await getTranslations('emailDesign'),designs=await listEmailDesigns(session);
 return <div className="space-y-6"><PageHeader title={t('title')} description={t('description')}/><EmailDesigner designs={designs}/></div>;
}

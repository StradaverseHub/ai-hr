import {redirect} from 'next/navigation';
import {getTranslations} from 'next-intl/server';
import {scopedAdmin} from '@/lib/scope';
import {isGroupAdmin} from '@/lib/authz-model';
import {listEmailDesigns} from '@/core/email-design/service';
import {PageHeader} from '@/components/ui';
import {sampleEmailSystem} from '@/lib/email-design/catalogue';
import {emailKinds,emailLocale,type EmailKind,type EmailLocale} from '@/lib/email-design/model';
import type {EmailSystemContent} from '@/lib/email-design/render';
import {EmailDesigner} from './designer';
export default async function EmailTemplatesPage(){
 const {s:session}=await scopedAdmin();if(!isGroupAdmin(session))redirect('/');
 const t=await getTranslations('emailDesign'),designs=await listEmailDesigns(session);
 const sampleSystems=Object.fromEntries(emailKinds.map(kind=>[kind,Object.fromEntries(emailLocale.options.map(locale=>{const system=sampleEmailSystem(kind,locale);return [locale,{subject:system.subject,text:system.text,...('link' in system?{link:system.link}:{}),...('buttonLabel' in system?{buttonLabel:system.buttonLabel}:{})}];}))])) as Record<EmailKind,Record<EmailLocale,EmailSystemContent>>;
 return <div className="space-y-6"><PageHeader title={t('title')} description={t('description')}/><EmailDesigner key={session.tenantId+':'+session.userId} designs={designs} sampleSystems={sampleSystems}/></div>;
}

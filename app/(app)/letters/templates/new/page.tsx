import {notFound} from 'next/navigation';
import {getLocale,getTranslations} from 'next-intl/server';
import {requireModule} from '@/lib/authz';
import {scopedSession} from '@/lib/scope';
import {letterCompanyAccess} from '@/core/letters';
import {todayInKualaLumpur} from '@/lib/hr-date';
import {isLocale} from '@/i18n/config';
import {Card,PageHeader,pageWideCls} from '@/components/ui';
import {LetterTemplateForm} from '@/components/letters/template-form';
import {templateLabels} from '../labels';
export const dynamic='force-dynamic';
export default async function NewLetterTemplatePage({searchParams}:{searchParams:Promise<{companyId?:string}>}){
 await requireModule('employees');const {s,scopeIds}=await scopedSession(),sp=await searchParams,t=await getTranslations('letters.templates'),locale=await getLocale(),companies=(await letterCompanyAccess(s)).filter(company=>scopeIds.includes(company.id)&&company.template),company=sp.companyId?companies.find(company=>company.id===sp.companyId):companies[0];if(!company)notFound();
 return <div className={pageWideCls}><PageHeader title={t('page.create')} description={company.name} back={{href:'/letters/templates?companyId='+company.id,label:t('page.title')}}/><Card className="p-5"><LetterTemplateForm companyId={company.id} today={todayInKualaLumpur()} defaultLanguage={isLocale(locale)?locale:'en'} labels={await templateLabels()}/></Card></div>;
}

import {notFound} from 'next/navigation';
import {getTranslations} from 'next-intl/server';
import {requireModule} from '@/lib/authz';
import {scopedSession} from '@/lib/scope';
import {getLetterTemplate,letterCompanyAccess} from '@/core/letters';
import {LetterWorkflowError} from '@/lib/letter-workflow';
import {todayInKualaLumpur} from '@/lib/hr-date';
import {Card,PageHeader,pageWideCls} from '@/components/ui';
import {LetterTemplateForm} from '@/components/letters/template-form';
import {templateLabels} from '../../labels';
export const dynamic='force-dynamic';
export default async function EditLetterTemplatePage({params,searchParams}:{params:Promise<{versionId:string}>;searchParams:Promise<{copy?:string}>}){
 await requireModule('employees');const {s,scopeIds}=await scopedSession(),{versionId}=await params,sp=await searchParams,t=await getTranslations('letters.templates'),detail=await getLetterTemplate(s,versionId).catch(error=>{if(error instanceof LetterWorkflowError&&['permission','invalid'].includes(error.code))notFound();throw error;});if(!detail||!scopeIds.includes(detail.root.companyId))notFound();
 const access=(await letterCompanyAccess(s)).find(company=>company.id===detail.root.companyId);if(!access?.template)notFound();const copy=sp.copy==='yes',labels=await templateLabels();
 return <div className={pageWideCls}><PageHeader title={copy?t('page.duplicate'):t('page.edit')} description={detail.version.name} back={{href:'/letters/templates/'+versionId,label:t('page.title')}}/><Card className="p-5"><LetterTemplateForm companyId={detail.root.companyId} today={todayInKualaLumpur()} defaultLanguage={detail.version.document.language} labels={labels} initial={{...(copy?{}:{templateId:detail.root.id,revision:detail.root.revision}),code:copy?'':detail.root.code,name:detail.version.name,category:detail.version.category,effectiveFrom:todayInKualaLumpur(),document:detail.version.document,fields:detail.fields.map(field=>({id:field.id,definition:field.definition,ordinal:field.ordinal})),presentation:detail.version.presentation,headLabel:detail.appearance.letterhead_name??undefined,signatoryLabel:detail.appearance.signatory_name??undefined}}/></Card></div>;
}

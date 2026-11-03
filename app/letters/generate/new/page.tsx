import {randomUUID} from 'node:crypto';
import Link from 'next/link';
import {notFound} from 'next/navigation';
import {getTranslations} from 'next-intl/server';
import {requireModule} from '@/lib/authz';
import {scopedSession} from '@/lib/scope';
import {getLetterTemplate,letterCompanyAccess,getStaffLetter} from '@/core/letters';
import {LetterWorkflowError} from '@/lib/letter-workflow';
import {Card,PageHeader,pageWideCls} from '@/components/ui';
import {LetterGenerationCreate} from '@/components/letters/generation-forms';
import {generationLabels} from '../labels';
import {getLetterRequestForStaff} from '@/core/letter-requests';
export const dynamic='force-dynamic';
export default async function NewGenerationPage({searchParams}:{searchParams:Promise<{versionId?:string;reissueOf?:string;requestId?:string}>}){
 await requireModule('employees');const {s,scopeIds}=await scopedSession(),sp=await searchParams,t=await getTranslations('letters.generate');if(typeof sp.versionId!=='string')notFound();
 const template=await getLetterTemplate(s,sp.versionId,{forGeneration:true}).catch(error=>{if(error instanceof LetterWorkflowError){if(error.code==='configuration')return null;if(['permission','invalid'].includes(error.code))notFound();}throw error;});
 if(!template)return <div className={pageWideCls}><PageHeader title={t('page.title')}/><Card className="space-y-3 p-5"><p>{t('errors.configuration')}</p><Link href="/letters/generate" className="inline-flex min-h-11 items-center text-primary underline">{t('page.activeTemplates')}</Link></Card></div>;
 const company=(await letterCompanyAccess(s)).find(company=>company.id===template.root.companyId&&scopeIds.includes(company.id)&&company.read&&company.generate);if(!company)notFound();const labels=await generationLabels();
 const original=sp.reissueOf?await getStaffLetter(s,sp.reissueOf).catch(error=>{if(error instanceof LetterWorkflowError&&['permission','invalid'].includes(error.code))notFound();throw error;}):null;
 if(sp.reissueOf&&(!original||original.record.companyId!==company.id||!['issued','void'].includes(original.record.state)||!original.employee))notFound();
 // AI v2 Phase 1 slice 3: "Prepare letter" from an employee's request fixes the draft to that employee; the template must be the
 // request's own, and the request must still be open. createLetterDraftBatch links the draft and the database checks it again.
 const request=typeof sp.requestId==='string'&&!sp.reissueOf?await getLetterRequestForStaff(s,sp.requestId).catch(()=>null):null;
 if(sp.requestId&&(!request||request.companyId!==company.id||request.templateId!==template.root.id||!['requested','in_progress'].includes(request.status)))notFound();
 const fixedEmployee=original?.employee?{id:original.record.employmentId,label:original.employee.name+(original.employee.code?' · '+original.employee.code:'')}
  :request?{id:request.employmentId,label:(request.employeeName??'—')+(request.employeeCode?' · '+request.employeeCode:'')}:undefined;
 return <div className={pageWideCls}><PageHeader title={t('form.create')} description={company.name+' · '+template.version.name} back={{href:'/letters/generate?companyId='+company.id,label:t('page.title')}}/>{original&&<p className="rounded-md border p-4 text-sm">{t('page.reissue',{reference:original.record.reference})}</p>}{request&&<p className="rounded-md border p-4 text-sm">{t('requests.preparing',{type:request.letterTypeName})}</p>}<Card className="p-5"><LetterGenerationCreate companyId={company.id} reissueOf={original?.record.id} requestId={request?.id} fixedEmployee={fixedEmployee} versionId={template.version.id} operationKey={randomUUID()} fields={template.fields.map(field=>field.definition)} labels={labels.form} picker={labels.picker} errors={labels.errors}/></Card></div>;
}

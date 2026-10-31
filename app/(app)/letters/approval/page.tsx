import Link from 'next/link';
import {getLocale,getTranslations} from 'next-intl/server';
import {requireModule} from '@/lib/authz';
import {scopedSession} from '@/lib/scope';
import {letterCompanyAccess,listLetterApprovalQueue} from '@/core/letters';
import {LetterWorkflowError} from '@/lib/letter-workflow';
import {Card,PageHeader,Field,inputCls,btnPrimary,pageWideCls} from '@/components/ui';
import {LetterApprovalQueue} from '@/components/letters/approval-controls';
import {approvalLabels} from './labels';
export const dynamic='force-dynamic';
export default async function LetterApprovalPage({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
 await requireModule('employees');const {s,scopeIds}=await scopedSession(),sp=await searchParams,labels=await approvalLabels(),f=await getTranslations('letters.fields'),locale=await getLocale(),value=(key:string)=>typeof sp[key]==='string'?sp[key] as string:undefined;
 const companies=(await letterCompanyAccess(s)).filter(company=>scopeIds.includes(company.id)&&company.read&&company.approve),company=value('companyId')?companies.find(company=>company.id===value('companyId')):companies[0];
 if(!company)return <div className={pageWideCls}><PageHeader title={labels.copy.title}/><Card className="p-5 text-sm">{labels.copy.noAccess}</Card></div>;
 let error=Object.values(sp).some(item=>Array.isArray(item))?labels.errors.invalid:null;
 const page=error?null:await listLetterApprovalQueue(s,{companyId:company.id,cursor:value('after'),limit:25}).catch(reason=>{if(reason instanceof LetterWorkflowError){error=labels.errors[reason.code]??labels.errors.unavailable;return null;}throw reason;});
 const date=(at:Date)=>new Intl.DateTimeFormat(locale,{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kuala_Lumpur'}).format(new Date(at)),rows=page?.rows.map(row=>{if(!row.record.currentRevisionId)throw new LetterWorkflowError('configuration','revision');return {id:row.record.id,revisionId:row.record.currentRevisionId,lockVersion:row.record.lockVersion,reference:row.record.reference,employee:row.employeeName+(row.employeeCode?' · '+row.employeeCode:''),title:row.title,stage:row.stageLabel,due:date(row.dueAt),overdue:new Date(row.dueAt).getTime()<Date.now(),final:row.final};})??[];
 return <div className={pageWideCls}><PageHeader title={labels.copy.title} description={labels.copy.intro}/>{value('notice')==='completed'&&<p role="status" className="rounded-md border p-4 text-sm">{labels.copy.completed}</p>}<Card className="p-4"><form className="flex flex-wrap items-end gap-3"><Field label={f('company')}><select name="companyId" className={`${inputCls} min-h-11`} defaultValue={company.id}>{companies.map(company=><option key={company.id} value={company.id}>{company.name}</option>)}</select></Field><button type="submit" className={`${btnPrimary} min-h-11`}>{f('apply')}</button></form></Card>{error?<p role="alert" className="rounded-md border border-destructive p-4 text-sm text-destructive">{error}</p>:<LetterApprovalQueue key={company.id+rows.map(row=>row.id+row.revisionId+row.lockVersion).join('|')} rows={rows} labels={labels.copy} errors={labels.errors}/>}<div className="flex flex-wrap gap-5">{value('after')&&<Link href={'/letters/approval?companyId='+company.id} className="inline-flex min-h-11 items-center text-primary underline">{labels.copy.first}</Link>}{page?.nextCursor&&<Link href={'/letters/approval?companyId='+company.id+'&after='+page.nextCursor} className="inline-flex min-h-11 items-center text-primary underline">{f('next')}</Link>}</div></div>;
}

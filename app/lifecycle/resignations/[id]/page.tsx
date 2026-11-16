import {notFound} from 'next/navigation';
import {getSession} from '@/lib/session';
import {getTranslations} from 'next-intl/server';
import {resignationCase} from '@/packs/lifecycle/service';
import {ResignationCaseCard} from '@/components/resignation/case-card';
import {PageHeader} from '@/components/ui';
import {todayInKualaLumpur} from '@/lib/hr-date';
export default async function Page({params,searchParams}:{params:Promise<{id:string}>;searchParams:Promise<{document?:string}>}){
 const [{id},query,s,t]=await Promise.all([params,searchParams,getSession(),getTranslations('resignationJourney')]);
 let value;
 try{value=await resignationCase(s,id);}catch(error){if(error&&typeof error==='object'&&'code'in error&&(error.code==='forbidden'||error.code==='not_found'))notFound();throw error;}
 return <div className="mx-auto max-w-5xl space-y-5"><PageHeader title={t('title')} description={value.number}/><ResignationCaseCard initial={value} today={todayInKualaLumpur()} fyi={value.tasks.some(task=>task.kind==='fyi')&&!value.capabilities.accept&&!value.capabilities.offer} documentId={query.document}/></div>;
}

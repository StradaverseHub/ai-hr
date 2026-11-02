import {notFound} from 'next/navigation';
import {requireModule} from '@/lib/authz';
import {probationAdministrationOptions,probationSetup,probationLetterTemplates} from '@/packs/probation/service';
import {TemplateWorkspace} from './template-workspace';
export default async function Page({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
 const ctx=await requireModule('lifecycle'),query=await searchParams,options=await probationAdministrationOptions(ctx),company=typeof query.company==='string'?options.companies.find(c=>c.id===query.company):options.companies[0];if(!company)notFound();
 const setup=await probationSetup(ctx,company.id);if(!setup.canConfigure)notFound();
 return <TemplateWorkspace key={company.id} company={company} companies={options.companies} definitions={await probationLetterTemplates(ctx,company.id)}/>;
}

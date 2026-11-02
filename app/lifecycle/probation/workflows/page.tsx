import {notFound} from 'next/navigation';
import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {probationAdministrationOptions,probationSetup,listProbationWorkflows} from '@/packs/probation/service';
import {WorkflowWorkspace} from './workflow-workspace';
export default async function Page({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
 const ctx=await requireScopedLifecycleModule(),query=await searchParams,options=await probationAdministrationOptions(ctx),company=typeof query.company==='string'?options.companies.find(c=>c.id===query.company):options.companies[0];if(!company)notFound();
 const setup=await probationSetup(ctx,company.id);if(!setup.canConfigure)notFound();
 return <WorkflowWorkspace key={company.id} company={company} options={options} definitions={(await listProbationWorkflows(ctx)).filter(d=>d.companyId===company.id)}/>;
}

import {createHash} from 'node:crypto';
import {notFound} from 'next/navigation';
import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {probationIntakeCompanies,probationIntakeWorkspace} from '@/packs/probation/service';
import {Intake} from './intake';
export default async function Page({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
 const ctx=await requireScopedLifecycleModule(),query=await searchParams,companies=await probationIntakeCompanies(ctx),company=typeof query.company==='string'?companies.find(c=>c.id===query.company):companies[0];if(!company)notFound();
 const workspace=await probationIntakeWorkspace(ctx,company.id);
 const revision=createHash('sha256').update(JSON.stringify(workspace.candidates.map(c=>[c.source.employmentId,c.sourceDigest,c.disposition?.revision,c.offlineDecision?.revision,c.offlineDecision?.id,c.evidence.map(e=>e.id)]))).digest('hex');
 return <Intake key={company.id+':'+revision+':'+(typeof query.employment==='string'?query.employment:'')} company={company} companies={companies} workspace={workspace} canPrepare={company.canPrepare} selectedId={typeof query.employment==='string'?query.employment:undefined}/>;
}

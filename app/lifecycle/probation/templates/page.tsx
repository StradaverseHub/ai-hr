import {notFound} from 'next/navigation';
import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {readProbationLetterWorkspace} from './read-workspace';
import {TemplateWorkspace} from './template-workspace';
export default async function Page({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
 const ctx=await requireScopedLifecycleModule(),query=await searchParams;
 const workspace=await readProbationLetterWorkspace(ctx,typeof query.company==='string'?query.company:undefined);
 if(!workspace)notFound();
 return <TemplateWorkspace key={workspace.company.id} {...workspace}/>;
}

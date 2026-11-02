import {notFound} from 'next/navigation';
import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {probationCase,probationLetterTemplates,probationLetterTemplateChoices} from '@/packs/probation/service';
import {OutcomeEditor} from '../../../outcome-editor';
export default async function Page({params}:{params:Promise<{id:string;outcomeId:string}>}){
 const{id,outcomeId}=await params,ctx=await requireScopedLifecycleModule(),view=await probationCase(ctx,id),outcome=view.outcomes.find(o=>o.id===outcomeId);if(!outcome||!view.roles.some(r=>r==='pbp'||r==='gbs'))notFound();
 const [templates,choices]=await Promise.all([probationLetterTemplates(ctx,view.record.companyId),probationLetterTemplateChoices(ctx,outcome.id)]);
 return <OutcomeEditor key={outcome.id+':'+outcome.revision} caseId={id} outcome={outcome} templates={Array.from(templates)} choices={choices}/>;
}

import {notFound} from 'next/navigation';
import {requireModule} from '@/lib/authz';
import {probationCase,probationLetterTemplates} from '@/packs/probation/service';
import {OutcomeEditor} from '../../../outcome-editor';
export default async function Page({params}:{params:Promise<{id:string;outcomeId:string}>}){
 const{id,outcomeId}=await params,ctx=await requireModule('lifecycle'),view=await probationCase(ctx,id),outcome=view.outcomes.find(o=>o.id===outcomeId);if(!outcome||!view.roles.some(r=>r==='pbp'||r==='gbs'))notFound();
 return <OutcomeEditor key={outcome.id+':'+outcome.revision} caseId={id} outcome={outcome} templates={await probationLetterTemplates(ctx,view.record.companyId)}/>;
}

import '../../case.css';
import {notFound} from 'next/navigation';
import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {probationCase,probationLetterTemplates,probationLetterTemplateChoices} from '@/packs/probation/service';
import {OutcomeEditor} from '../../../outcome-editor';
import {OtherOutcomeDecision} from '../../../pbp-decisions';
export default async function Page({params}:{params:Promise<{id:string;outcomeId:string}>}){
 const{id,outcomeId}=await params,ctx=await requireScopedLifecycleModule(),view=await probationCase(ctx,id),outcome=view.outcomes.find(o=>o.id===outcomeId);if(!outcome||!view.roles.some(r=>r==='pbp'||r==='gbs'))notFound();
 // I3: an undecided Other outcome has no letter; the PBP chooses the real outcome here.
 if(outcome.outcome==='other'&&!outcome.releasedAt)return <OtherOutcomeDecision caseId={id} outcome={outcome} canDecide={view.runtimeEnabled&&outcome.state!=='completed'} extensionsLeft={view.record.extensionCount<(view.record.config.maxExtensions??2)}/>;
 const [templates,choices]=await Promise.all([view.runtimeEnabled?probationLetterTemplates(ctx,view.record.companyId):Promise.resolve([]),view.runtimeEnabled?probationLetterTemplateChoices(ctx,outcome.id):Promise.resolve(undefined)]);
 return <OutcomeEditor key={outcome.id+':'+outcome.revision} runtimeEnabled={view.runtimeEnabled} sourceMoved={view.sourceMoved} caseId={id} outcome={outcome} templates={Array.from(templates)} choices={choices}/>;
}

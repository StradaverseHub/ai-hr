import type {ReactNode} from 'react';
import {readProbationLetterWorkspace} from '@/app/lifecycle/probation/templates/read-workspace';
import {TemplateWorkspace} from '@/app/lifecycle/probation/templates/template-workspace';
import {ProbationError} from '@/packs/probation/service';
import {notFound} from 'next/navigation';
import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {listAutomationEmailTemplates,listAutomationRoutings,automationAssignmentGroups,automationPeopleNames} from '@/packs/automation/service';
import {automationPageAccess} from '../access';
import {readV9Workspace} from '@/app/lifecycle/v9/read-workspace';
import {V9Workspace} from '@/app/lifecycle/v9/workspace';
import {ProbationTemplateSection,ProbationOnlyTemplateHub} from './probation-template-section';

/** Each module loads through its own authority; Probation access never reads the V9 administrator payload. */
export async function TemplateHub({module,company}:{module?:string;company?:string}){
 const ctx=await requireScopedLifecycleModule(),access=await automationPageAccess(ctx);
 if(!access.legacy&&!access.probation)notFound();
 let probation:ReactNode;
 if(access.probation){
  const[stored,routings,groups]=await Promise.all([listAutomationEmailTemplates(ctx,{module:'probation'}),listAutomationRoutings(ctx),automationAssignmentGroups(ctx)]);
  const people=await automationPeopleNames(ctx,stored.flatMap(item=>item.template.cc.flatMap(recipient=>recipient.kind==='person'?[recipient.userId]:[])));
  const letters=await readProbationLetterWorkspace(ctx,company).catch(error=>{if(error instanceof ProbationError&&error.code==='forbidden')return null;throw error;});
  const documents=letters?[...new Map(letters.definitions.filter(definition=>definition.state!=='retired').map(definition=>[definition.key,{id:definition.key,name:definition.data.name,type:'Letter' as const}])).values()]:[];
  probation=<ProbationTemplateSection documents={documents} letters={letters?<TemplateWorkspace {...letters} embedded/>:undefined} emails={stored.map(item=>({template:item.template,revision:item.revision,retired:item.retired}))} refs={{routings:routings.map(row=>({id:row.routing.id,name:row.routing.name,retired:row.retired})),groups,people}}/>;
 }
 if(access.legacy){const workspace=await readV9Workspace(ctx);return <V9Workspace {...workspace} navigation="global" initialView="templates" probationTemplates={probation} initialTemplateModule={module==='probation'&&access.probation?'probation':module==='onb'||module==='off'?module:'all'}/>;}
 return <ProbationOnlyTemplateHub>{probation}</ProbationOnlyTemplateHub>;
}

import '@/app/automation/automation.css';
import '@/app/automation/pcg.css';
import '@/app/lifecycle/probation/probation.css';
import {lifecycleV9SenderName} from '@/lib/lifecycle-v9-sender';
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

/** Company letter configuration and tenant-wide email configuration keep their separate existing authorities. */
export async function TemplateHub({module,company}:{module?:string;company?:string}){
 const ctx=await requireScopedLifecycleModule(),access=await automationPageAccess(ctx);
 const letters=await readProbationLetterWorkspace(ctx,company).catch(error=>{if(error instanceof ProbationError&&error.code==='forbidden')return null;throw error;});
 const hasProbation=access.probation||Boolean(letters);
 if(!access.legacy&&!hasProbation)notFound();
 let probation:ReactNode;
 if(hasProbation){
  const[stored,routings,groups,sender]=access.probation?await Promise.all([listAutomationEmailTemplates(ctx,{module:'probation'}),listAutomationRoutings(ctx),automationAssignmentGroups(ctx),lifecycleV9SenderName(ctx.tenantId)]):[[],[],[],undefined] as const;
  const people=access.probation?await automationPeopleNames(ctx,stored.flatMap(item=>item.template.cc.flatMap(recipient=>recipient.kind==='person'?[recipient.userId]:[]))):[];
  const documents=letters?[...new Map(letters.definitions.filter(definition=>definition.state!=='retired').map(definition=>[definition.key,{id:definition.key,name:definition.data.name,type:'Letter' as const}])).values()]:[];
  probation=<ProbationTemplateSection canEditEmails={access.probation} sender={sender} documents={documents} letters={letters?<TemplateWorkspace {...letters} embedded/>:undefined} emails={stored.map(item=>({template:item.template,revision:item.revision,retired:item.retired}))} refs={{routings:routings.map(row=>({id:row.routing.id,name:row.routing.name,retired:row.retired})),groups:[...groups],people}}/>;
 }
 if(access.legacy){const workspace=await readV9Workspace(ctx);return <V9Workspace {...workspace} navigation="global" initialView="templates" probationTemplates={probation} initialTemplateModule={module==='probation'&&hasProbation?'probation':module==='onb'||module==='off'?module:'all'}/>;}
 return <ProbationOnlyTemplateHub>{probation}</ProbationOnlyTemplateHub>;
}

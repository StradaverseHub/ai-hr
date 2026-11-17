import {contractWorkflowEditorId} from '../editor-target';
import {getTranslations} from 'next-intl/server';
import {contractTerminationReasons} from '@/packs/contracts/service';
import {LifecycleWorkflowSection} from '../lifecycle-configuration';
import {v9Configuration} from '@/packs/lifecycle/service';
import {notFound} from 'next/navigation';
import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {automationTemplateChoices,automationAssignmentGroups,automationPeopleNames,automationRoutingOptions,listAutomationDocumentTemplates,listAutomationEmailTemplates,listAutomationRoutings,listAutomationWorkflows} from '@/packs/automation/service';
import {contractWorkflowRecipients} from '@/lib/contract-automation';
import {automationFilter,automationPageAccess} from '../access';
import {probationLetterChoices} from '../letter-templates';
import {PROBATION_DEFAULTS} from '../probation-defaults';
import type {WorkflowEditorReferences} from './workflow-editor';
import {WorkflowsWorkspace,type ListedWorkflow} from './workflows-workspace';

export default async function Page({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
 const ctx=await requireScopedLifecycleModule(),query=await searchParams,access=await automationPageAccess(ctx,'workflows');
 if(!access.any)notFound();
 const filter=automationFilter(query.module,access);
 const lifecycle=access.legacy&&(filter==='all'||filter==='onb'||filter==='off')?await v9Configuration(ctx):null;
 const refs:WorkflowEditorReferences={routings:[],groups:[],people:[],emailTemplates:[],letterTemplates:null,conditionValues:{}};
 let workflows:ListedWorkflow[]=[],defaultsMissing=0;
 if(access.probation&&(filter==='all'||filter==='probation')){
  // Bounded reads, a few at a time: definitions first, then reference data.
  const [stored,routings,emails]=await Promise.all([listAutomationWorkflows(ctx,{module:'probation'}),listAutomationRoutings(ctx),listAutomationEmailTemplates(ctx,{module:'probation'})]);
  const [groups,options,letters]=await Promise.all([automationAssignmentGroups(ctx),automationRoutingOptions(ctx),probationLetterChoices(ctx)]);
  const personIds=[...stored.flatMap(w=>w.workflow.steps.flatMap(s=>[...s.to,...s.cc])),...emails.flatMap(e=>e.template.cc)].flatMap(r=>r.kind==='person'?[r.userId]:[]);
  workflows=stored.map(w=>({workflow:w.workflow,revision:w.revision}));
  refs.routings=routings.map(r=>({id:r.routing.id,name:r.routing.name,retired:r.retired}));
  refs.groups=groups;
  refs.people=await automationPeopleNames(ctx,personIds);
  refs.emailTemplates=emails.map(e=>({id:e.template.id,name:e.template.name,active:e.template.active,retired:e.retired,subject:e.template.subject}));
  refs.letterTemplates=letters?.templates??null;
  // Organisation conditions store ids and show names (F5); a department name used in several companies names its company.
  const companyName=new Map(options.companies.map(o=>[o.id,o.name])),repeated=new Set(options.departments.filter((d,i,all)=>all.findIndex(x=>x.name===d.name)!==i).map(d=>d.name));
  const plain=(values:readonly string[])=>values.map(value=>({value,label:value}));
  refs.conditionValues={businessGroup:options.businessGroups.map(o=>({value:o.id,label:o.name})),company:options.companies.map(o=>({value:o.id,label:o.name})),
   department:options.departments.map(o=>({value:o.id,label:repeated.has(o.name)?`${o.name} · ${companyName.get(o.companyId)??''}`.replace(/ · $/,''):o.name})),jobGrade:plain(options.jobGrades),extensionsUsed:plain(['0','1','2'])};
  const present=new Set([...stored.map(w=>w.workflow.id),...emails.map(e=>e.template.id),...routings.map(r=>r.routing.id)]);
  defaultsMissing=[...PROBATION_DEFAULTS.workflows,...PROBATION_DEFAULTS.emailTemplates,...PROBATION_DEFAULTS.routings].filter(d=>!present.has(d.id)).length;
 }
 let contract:{workflows:ListedWorkflow[];refs:WorkflowEditorReferences}|undefined;
 if(access.contractStaff&&(filter==='all'||filter==='contract_staff')){
  const [stored,routings,choices]=await Promise.all([listAutomationWorkflows(ctx,{module:'contract_staff'}),listAutomationRoutings(ctx),automationTemplateChoices(ctx,'contract_staff')]);
  const [groups,options,reasons,reasonCopy]=await Promise.all([automationAssignmentGroups(ctx),automationRoutingOptions(ctx),contractTerminationReasons(ctx),getTranslations('people.detail.movement.terminationReason')]);
  const reasonChoices=reasons.map(reason=>({value:reason.code,label:reason.label??(reason.builtIn?reasonCopy(reason.code):reason.code)}));
  const personIds=stored.flatMap(w=>contractWorkflowRecipients(w.workflow)).flatMap(r=>r.kind==='person'?[r.userId]:[]);
  contract={workflows:stored.map(w=>({workflow:w.workflow,revision:w.revision})),refs:{routings:routings.map(r=>({id:r.routing.id,name:r.routing.name,retired:r.retired})),groups,people:await automationPeopleNames(ctx,personIds),
   emailTemplates:choices.emails,
   letterTemplates:choices.documents.map(d=>({id:d.id,name:d.name})),
   conditionValues:{businessGroup:options.businessGroups.map(o=>({value:o.id,label:o.name})),endReason:reasonChoices,declineReason:reasonChoices}}};
 }
 return <WorkflowsWorkspace initialContractWorkflowId={contractWorkflowEditorId(query)} contract={contract} onboardingSection={lifecycle?<LifecycleWorkflowSection initial={lifecycle} filter={filter==='onb'?'onb':filter==='off'?'off':'all'} initialSelected={typeof query.workflow==='string'?query.workflow:undefined}/>:undefined} filter={filter} access={access} workflows={workflows} refs={refs} defaultsMissing={defaultsMissing}/>;
}

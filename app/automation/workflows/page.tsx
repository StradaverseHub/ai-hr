import {notFound} from 'next/navigation';
import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {automationAssignmentGroups,automationPeopleNames,automationRoutingOptions,listAutomationEmailTemplates,listAutomationRoutings,listAutomationWorkflows} from '@/packs/automation/service';
import {automationFilter,automationPageAccess} from '../access';
import {probationLetterChoices} from '../letter-templates';
import {PROBATION_DEFAULTS} from '../probation-defaults';
import type {WorkflowEditorReferences} from './workflow-editor';
import {WorkflowsWorkspace,type ListedWorkflow} from './workflows-workspace';

export default async function Page({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
 const ctx=await requireScopedLifecycleModule(),query=await searchParams,access=await automationPageAccess(ctx);
 if(!access.any)notFound();
 const filter=automationFilter(query.module,access);
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
  refs.conditionValues={businessGroup:options.businessGroups.map(o=>o.name),company:options.companies.map(o=>o.name),department:[...new Set(options.departments.map(o=>o.name))],jobGrade:options.jobGrades,extensionsUsed:['0','1','2']};
  const present=new Set([...stored.map(w=>w.workflow.id),...emails.map(e=>e.template.id),...routings.map(r=>r.routing.id)]);
  defaultsMissing=[...PROBATION_DEFAULTS.workflows,...PROBATION_DEFAULTS.emailTemplates,...PROBATION_DEFAULTS.routings].filter(d=>!present.has(d.id)).length;
 }
 return <WorkflowsWorkspace filter={filter} access={access} workflows={workflows} refs={refs} defaultsMissing={defaultsMissing}/>;
}

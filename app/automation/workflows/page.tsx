import {offboardingSettings} from '@/lib/automation/offboarding';
import {LifecycleWorkflowSection} from '../lifecycle-configuration';
import {v9Configuration} from '@/packs/lifecycle/service';
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
 let offboarding:import('./workflows-workspace').OffboardingWorkspace|undefined;
 if(access.legacy&&(filter==='all'||filter==='off')){
  const [stored,routings,options]=await Promise.all([listAutomationWorkflows(ctx,{module:'off'}),listAutomationRoutings(ctx),automationRoutingOptions(ctx)]);
  const configuration=lifecycle!,config=configuration.config;
  offboarding={workflows:stored.map(w=>({workflow:w.workflow,revision:w.revision})),editable:configuration.editable,refs:{postingApproverGroupId:config?offboardingSettings(config).postingApproverGroupId:null,routings:routings.map(r=>({id:r.routing.id,name:r.routing.name,retired:r.retired})),groups:config?.groups??[],people:configuration.users,emailTemplates:(config?.emails??[]).filter(e=>e.module==='off').map(e=>({id:e.id,name:e.name,active:e.active,retired:false,subject:e.subject})),letterTemplates:(config?.templates??[]).filter(t=>t.module==='off'&&!t.retired).map(t=>({id:t.id,name:t.name})),conditionValues:{businessGroup:options.businessGroups.map(v=>({value:v.id,label:v.name})),company:options.companies.map(v=>({value:v.id,label:v.name})),department:options.departments.map(v=>({value:v.id,label:v.name})),jobTitle:options.jobTitles.map(v=>({value:v,label:v})),jobGrade:options.jobGrades.map(v=>({value:v,label:v}))}}};
 }
 return <WorkflowsWorkspace onboardingSection={lifecycle?<LifecycleWorkflowSection initial={lifecycle} filter={filter==='onb'?'onb':filter==='off'?'off':'all'} initialSelected={typeof query.workflow==='string'?query.workflow:undefined}/>:undefined} offboarding={offboarding} filter={filter} access={access} workflows={workflows} refs={refs} defaultsMissing={defaultsMissing}/>;
}

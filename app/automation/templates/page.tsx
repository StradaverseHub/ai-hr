import {contractTemplateEditorTarget} from '../editor-target';
import {contractTemplatePreviewCases} from '@/packs/contracts/service';
import {v9Configuration} from '@/packs/lifecycle/service';
import {LifecycleTemplateSection} from '../lifecycle-configuration';
import {FilterChips} from '../filter-chips';
import {ConfigHead} from '@/app/lifecycle/probation/settings/config-head';
import {notFound,redirect} from 'next/navigation';
import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {automationAssignmentGroups,automationPeopleNames,automationRoutingOptions,listAutomationDocumentTemplates,listAutomationEmailTemplates,listAutomationRoutings,listAutomationWorkflows} from '@/packs/automation/service';
import {automationFilter,automationPageAccess} from '../access';
import {probationLetterChoices} from '../letter-templates';
import {TemplatesWorkspace,type LetterSection,type ListedEmailTemplate} from './templates-workspace';
import type {ContractTemplatesData} from './contract-templates';

export default async function Page({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
 const ctx=await requireScopedLifecycleModule(),query=await searchParams,access=await automationPageAccess(ctx,'templates');
 if(!access.any)notFound();
 if(query.module==='probation'&&access.probation)redirect('/lifecycle/v9?view=templates&module=probation'+(typeof query.company==='string'?'&company='+encodeURIComponent(query.company):''));
 const filter=automationFilter(query.module,access);
 let emails:ListedEmailTemplate[]=[],letters:LetterSection=null;
 let sharedRoutings:Awaited<ReturnType<typeof listAutomationRoutings>>|undefined;
 const refs:{routings:{id:string;name:string;retired?:boolean}[];groups:{id:string;name:string}[];people:{id:string;name:string}[]}={routings:[],groups:[],people:[]};
 if(access.probation&&(filter==='all'||filter==='probation')){
  const [stored,routings,groups]=await Promise.all([listAutomationEmailTemplates(ctx,{module:'probation'}),listAutomationRoutings(ctx),automationAssignmentGroups(ctx)]);
  sharedRoutings=routings;
  letters=await probationLetterChoices(ctx,typeof query.company==='string'?query.company:undefined);
  emails=stored.map(e=>({template:e.template,revision:e.revision,retired:e.retired}));
  refs.routings=routings.map(r=>({id:r.routing.id,name:r.routing.name,retired:r.retired}));
  refs.groups=groups;
  refs.people=await automationPeopleNames(ctx,stored.flatMap(e=>e.template.cc.flatMap(r=>r.kind==='person'?[r.userId]:[])));
 }
 let contract:ContractTemplatesData|undefined;
 if(access.contractStaff&&(filter==='all'||filter==='contract_staff')){
  const [documents,stored,routings]=await Promise.all([listAutomationDocumentTemplates(ctx,'contract_staff'),listAutomationEmailTemplates(ctx,{module:'contract_staff'}),listAutomationRoutings(ctx)]);
  const [groups,options,previewCases]=await Promise.all([automationAssignmentGroups(ctx),automationRoutingOptions(ctx),contractTemplatePreviewCases(ctx)]);
  const peopleIds=[...documents.flatMap(d=>d.template.routing.flatMap(s=>s.who.kind==='people'?s.who.userIds:[])),...stored.flatMap(e=>e.template.cc.flatMap(r=>r.kind==='person'?[r.userId]:[]))];
  contract={documents,emails:stored.map(e=>({template:e.template,revision:e.revision,retired:e.retired})),refs:{routings:routings.map(r=>({id:r.routing.id,name:r.routing.name,retired:r.retired})),groups,previewCases,people:await automationPeopleNames(ctx,peopleIds),conditions:{businessGroup:options.businessGroups.map(o=>({value:o.id,label:o.name})),company:options.companies.map(o=>({value:o.id,label:o.name})),department:options.departments.map(o=>({value:o.id,label:o.name})),jobTitle:options.jobTitles.map(value=>({value,label:value}))}}};
 }
 const lifecycle=access.legacy&&(filter==='all'||filter==='onb'||filter==='off')?await v9Configuration(ctx):null;
 const [routes,sharedOffboarding]=await Promise.all([lifecycle?(sharedRoutings??listAutomationRoutings(ctx)):[],lifecycle&&(filter==='all'||filter==='off')?listAutomationWorkflows(ctx,{module:'off'}):[]]);
 const lifecycleSection=lifecycle?<LifecycleTemplateSection sharedWorkflows={sharedOffboarding.map(row=>row.workflow)} summaryRoutings={routes.map(r=>({id:r.routing.id,name:r.routing.name,retired:r.retired}))} initial={lifecycle} filter={filter==='onb'?'onb':filter==='off'?'off':'all'} choices={{routings:routes.filter(r=>!r.retired).map(r=>({id:r.routing.id,name:r.routing.name})),groups:lifecycle.config?.groups??[],people:lifecycle.users}}/>:null;
 if(filter==='onb'||filter==='off')return <main className="v9-stack pcg"><ConfigHead crumb="Configuration / Templates" title="Templates" sub="Document and email templates shared by the lifecycle modules."/><FilterChips path="/automation/templates" current={filter}/>{lifecycleSection??<p className="v9-notice">You cannot configure this module.</p>}</main>;
 return <TemplatesWorkspace lifecycleSection={lifecycleSection} filter={filter} access={access} emails={emails} letters={letters} refs={refs} contract={contract} initialContractTarget={contractTemplateEditorTarget(query)}/>;
}

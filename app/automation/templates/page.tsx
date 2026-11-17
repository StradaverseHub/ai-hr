import {v9Configuration} from '@/packs/lifecycle/service';
import {ContractTemplateSection} from '../contract-configuration';
import {LifecycleTemplateSection} from '../lifecycle-configuration';
import {FilterChips} from '../filter-chips';
import {ConfigHead} from '@/app/lifecycle/probation/settings/config-head';
import {notFound} from 'next/navigation';
import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {automationAssignmentGroups,automationPeopleNames,listAutomationEmailTemplates,listAutomationRoutings,listAutomationWorkflows} from '@/packs/automation/service';
import {automationFilter,automationPageAccess} from '../access';
import {probationLetterChoices} from '../letter-templates';
import {TemplatesWorkspace,type LetterSection,type ListedEmailTemplate} from './templates-workspace';

export default async function Page({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
 const ctx=await requireScopedLifecycleModule(),query=await searchParams,access=await automationPageAccess(ctx);
 if(!access.any)notFound();
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
 const lifecycle=access.legacy&&(filter==='all'||filter==='onb'||filter==='off')?await v9Configuration(ctx):null;
 const [routes,sharedOffboarding]=await Promise.all([lifecycle?(sharedRoutings??listAutomationRoutings(ctx)):[],lifecycle&&(filter==='all'||filter==='off')?listAutomationWorkflows(ctx,{module:'off'}):[]]);
 const lifecycleSection=lifecycle?<LifecycleTemplateSection sharedWorkflows={sharedOffboarding.map(row=>row.workflow)} summaryRoutings={routes.map(r=>({id:r.routing.id,name:r.routing.name,retired:r.retired}))} initial={lifecycle} filter={filter==='onb'?'onb':filter==='off'?'off':'all'} choices={{routings:routes.filter(r=>!r.retired).map(r=>({id:r.routing.id,name:r.routing.name})),groups:lifecycle.config?.groups??[],people:lifecycle.users}}/>:null;
 if(filter==='onb'||filter==='off')return <main className="v9-stack pcg"><ConfigHead crumb="Configuration / Templates" title="Templates" sub="Document and email templates shared by the lifecycle modules."/><FilterChips path="/automation/templates" current={filter}/>{lifecycleSection??<p className="v9-notice">You cannot configure this module.</p>}</main>;
 return <TemplatesWorkspace contractSection={access.contractStaff&&(filter==='all'||filter==='contract_staff')?<ContractTemplateSection ctx={ctx}/>:undefined} lifecycleSection={lifecycleSection} filter={filter} access={access} emails={emails} letters={letters} refs={refs}/>;
}

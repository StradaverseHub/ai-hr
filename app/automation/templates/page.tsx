import {notFound,redirect} from 'next/navigation';
import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {automationAssignmentGroups,automationPeopleNames,listAutomationEmailTemplates,listAutomationRoutings} from '@/packs/automation/service';
import {automationFilter,automationPageAccess} from '../access';
import {probationLetterChoices} from '../letter-templates';
import {TemplatesWorkspace,type LetterSection,type ListedEmailTemplate} from './templates-workspace';

export default async function Page({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
 const ctx=await requireScopedLifecycleModule(),query=await searchParams,access=await automationPageAccess(ctx);
 if(!access.any)notFound();
 if(query.module==='probation'&&access.probation)redirect('/lifecycle/v9?view=templates&module=probation'+(typeof query.company==='string'?'&company='+encodeURIComponent(query.company):''));
 const filter=automationFilter(query.module,access);
 let emails:ListedEmailTemplate[]=[],letters:LetterSection=null;
 const refs:{routings:{id:string;name:string;retired?:boolean}[];groups:{id:string;name:string}[];people:{id:string;name:string}[]}={routings:[],groups:[],people:[]};
 if(access.probation&&(filter==='all'||filter==='probation')){
  const [stored,routings,groups]=await Promise.all([listAutomationEmailTemplates(ctx,{module:'probation'}),listAutomationRoutings(ctx),automationAssignmentGroups(ctx)]);
  letters=await probationLetterChoices(ctx,typeof query.company==='string'?query.company:undefined);
  emails=stored.map(e=>({template:e.template,revision:e.revision,retired:e.retired}));
  refs.routings=routings.map(r=>({id:r.routing.id,name:r.routing.name,retired:r.retired}));
  refs.groups=groups;
  refs.people=await automationPeopleNames(ctx,stored.flatMap(e=>e.template.cc.flatMap(r=>r.kind==='person'?[r.userId]:[])));
 }
 return <TemplatesWorkspace filter={filter} access={access} emails={emails} letters={letters} refs={refs}/>;
}

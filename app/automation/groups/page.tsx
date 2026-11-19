import {offboardingSettings} from '@/lib/automation/offboarding';
import {v9Configuration} from '@/packs/lifecycle/service';
import {AssignmentGroups} from './assignment-groups';
import {BusinessPartnerRules} from './business-partner-rules';
import {LifecycleGroupSection} from '../lifecycle-configuration';
import {notFound} from 'next/navigation';
import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {automationAssignmentGroups,automationBusinessPartnerWorkspace,automationGroupWorkspace,automationPeopleNames,automationRoutingOptions,listAutomationRoutings,listAutomationWorkflows} from '@/packs/automation/service';
import {automationPageAccess} from '../access';
import {GroupsWorkspace,type ListedRouting} from './groups-workspace';

export default async function Page(){
 const ctx=await requireScopedLifecycleModule(),access=await automationPageAccess(ctx,'groups');
 if(!access.any)notFound();
 const [routings,groups,options,groupWorkspace,businessPartners]=await Promise.all([listAutomationRoutings(ctx),automationAssignmentGroups(ctx),automationRoutingOptions(ctx),access.contractStaff?automationGroupWorkspace(ctx):null,automationBusinessPartnerWorkspace(ctx)]);
 // Workflows the viewer may read (row security): where each routing is used, for the "Used in" note.
 const workflows=await listAutomationWorkflows(ctx);
 const usedBy=new Map<string,Set<string>>();
 for(const {workflow} of workflows)if(workflow.status!=='retired')for(const step of workflow.steps)for(const recipient of [...step.to,...step.cc])
  if(recipient.kind==='routing')usedBy.set(recipient.routingId,(usedBy.get(recipient.routingId)??new Set<string>()).add(workflow.name));
 const people=await automationPeopleNames(ctx,routings.flatMap(r=>r.routing.rows.flatMap(row=>row.assignTo.kind==='people'?row.assignTo.userIds:[])));
 const lifecycle=access.legacy?await v9Configuration(ctx):null;
 const groupUses:Record<string,string[]>={};
 const use=(id:string,label:string)=>{groupUses[id]??=[];if(!groupUses[id].includes(label))groupUses[id].push(label);};
 for(const {workflow}of workflows)for(const step of workflow.steps)for(const recipient of [...step.to,...step.cc,...(Array.isArray(step.params.watch)?step.params.watch:[])])if(recipient&&recipient.kind==='group')use(recipient.groupId,'Workflow: '+workflow.name);
 for(const r of routings)if(!r.retired)for(const row of r.routing.rows)if(row.assignTo.kind==='group')use(row.assignTo.groupId,'Routing: '+r.routing.name);
 for(const template of lifecycle?.config?.templates??[])for(const version of template.versions)for(const step of version.routing??[])if(step.who.kind==='group')use(step.who.groupId,'Template: '+template.name);
 const config=lifecycle?.config;
 const routeUse=(id:string,label:string)=>usedBy.set(id,(usedBy.get(id)??new Set<string>()).add(label));
 const recipientUse=(recipient:import('@/lib/automation/workflow').AutomationRecipient,label:string)=>{if(recipient.kind==='group')use(recipient.groupId,label);if(recipient.kind==='routing')routeUse(recipient.routingId,label);};
 const roleUse=(role:string,label:string)=>{if(role.startsWith('group:'))use(role.slice(6),label);if(role==='peopleOps'&&config?.peopleOpsGroup)use(config.peopleOpsGroup,label);};
 for(const {workflow}of workflows)for(const step of workflow.steps){for(const recipient of Array.isArray(step.params.watch)?step.params.watch:[])recipientUse(recipient,'Workflow: '+workflow.name);for(const layer of Array.isArray(step.params.layers)?step.params.layers:[])for(const recipient of layer.to??[])recipientUse(recipient,'Workflow: '+workflow.name);}
 for(const template of config?.templates??[])for(const version of template.versions)for(const step of version.routing??[])if(step.who.kind==='routing')routeUse(step.who.routingId,'Template: '+template.name);
 for(const email of config?.emails??[]){for(const role of email.cc)roleUse(role,'Email: '+email.name);for(const recipient of email.routingCc??[])recipientUse(recipient,'Email: '+email.name);for(const slot of email.slots)if(slot.by)recipientUse(slot.by,'Email: '+email.name);}
 for(const workflow of config?.workflows??[])for(const step of workflow.steps)if(step.type==='email'||step.type==='notify')for(const role of [...(Array.isArray(step.to)?step.to:[step.to]),...step.cc])roleUse(role,'Workflow: '+workflow.name);
 for(const checklist of config?.checklists??[])for(const task of checklist.tasks)if(task.group)use(task.group,'Checklist: '+checklist.name);
 if(config?.peopleOpsGroup)use(config.peopleOpsGroup,'Shared settings: GBS People Ops');
 const postingGroup=config?offboardingSettings(config).postingApproverGroupId:null;if(postingGroup)use(postingGroup,'Offboarding settings: Personnel postings approver');
 const listed:ListedRouting[]=routings.map(r=>({routing:r.routing,revision:r.revision,retired:r.retired,usedBy:[...usedBy.get(r.routing.id)??[]]}));
 return <GroupsWorkspace businessPartnerSection={businessPartners?<BusinessPartnerRules initial={businessPartners}/>:undefined} groupSection={groupWorkspace?<AssignmentGroups initial={groupWorkspace} usedBy={groupUses}/>:lifecycle?<LifecycleGroupSection initial={lifecycle} usedBy={groupUses}/>:undefined} access={access} groups={groups} routings={listed} options={{businessGroups:options.businessGroups,companies:options.companies,departments:options.departments,jobTitles:options.jobTitles}} people={people}/>;
}

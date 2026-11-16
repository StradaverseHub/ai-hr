import {notFound} from 'next/navigation';
import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {automationAssignmentGroups,automationGroupWorkspace,automationPeopleNames,automationRoutingOptions,listAutomationRoutings,listAutomationWorkflows} from '@/packs/automation/service';
import {AssignmentGroups} from './assignment-groups';
import {automationPageAccess} from '../access';
import {GroupsWorkspace,type ListedRouting} from './groups-workspace';

export default async function Page(){
 const ctx=await requireScopedLifecycleModule(),access=await automationPageAccess(ctx,'groups');
 if(!access.any)notFound();
 const [routings,groups,options,groupWorkspace]=await Promise.all([listAutomationRoutings(ctx),automationAssignmentGroups(ctx),automationRoutingOptions(ctx),access.contractStaff?automationGroupWorkspace(ctx):null]);
 // Workflows the viewer may read (row security): where each routing is used, for the "Used in" note.
 const workflows=await listAutomationWorkflows(ctx);
 const usedBy=new Map<string,Set<string>>();
 for(const {workflow} of workflows)if(workflow.status!=='retired')for(const step of workflow.steps)for(const recipient of [...step.to,...step.cc])
  if(recipient.kind==='routing')usedBy.set(recipient.routingId,(usedBy.get(recipient.routingId)??new Set<string>()).add(workflow.name));
 const listed:ListedRouting[]=routings.map(r=>({routing:r.routing,revision:r.revision,retired:r.retired,usedBy:[...usedBy.get(r.routing.id)??[]]}));
 const people=await automationPeopleNames(ctx,routings.flatMap(r=>r.routing.rows.flatMap(row=>row.assignTo.kind==='people'?row.assignTo.userIds:[])));
 const groupUses:Record<string,string[]>={};
 for(const group of groups)groupUses[group.id]=[...new Set([
  ...routings.filter(item=>!item.retired&&item.routing.rows.some(row=>row.assignTo.kind==='group'&&row.assignTo.groupId===group.id)).map(item=>'Routing: '+item.routing.name),
  ...workflows.filter(item=>item.workflow.status!=='retired'&&item.workflow.steps.some(step=>[...step.to,...step.cc,...(Array.isArray(step.params.watch)?step.params.watch:[]),...(Array.isArray(step.params.layers)?step.params.layers.flatMap(layer=>layer.to??[]):[])].some(recipient=>recipient?.kind==='group'&&recipient.groupId===group.id))).map(item=>'Workflow: '+item.workflow.name),
 ])];
 return <GroupsWorkspace groupSection={groupWorkspace?<AssignmentGroups initial={groupWorkspace} usedBy={groupUses}/>:undefined} access={access} groups={groups} routings={listed} options={{businessGroups:options.businessGroups,companies:options.companies,departments:options.departments,jobTitles:options.jobTitles}} people={people}/>;
}

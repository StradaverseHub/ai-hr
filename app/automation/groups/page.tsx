import {notFound} from 'next/navigation';
import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {automationAssignmentGroups,automationPeopleNames,automationRoutingOptions,listAutomationRoutings,listAutomationWorkflows} from '@/packs/automation/service';
import {automationPageAccess} from '../access';
import {GroupsWorkspace,type ListedRouting} from './groups-workspace';

export default async function Page(){
 const ctx=await requireScopedLifecycleModule(),access=await automationPageAccess(ctx);
 if(!access.any)notFound();
 const [routings,groups,options]=await Promise.all([listAutomationRoutings(ctx),automationAssignmentGroups(ctx),automationRoutingOptions(ctx)]);
 // Workflows the viewer may read (row security): where each routing is used, for the "Used in" note.
 const workflows=await listAutomationWorkflows(ctx);
 const usedBy=new Map<string,Set<string>>();
 for(const {workflow} of workflows)if(workflow.status!=='retired')for(const step of workflow.steps)for(const recipient of [...step.to,...step.cc])
  if(recipient.kind==='routing')usedBy.set(recipient.routingId,(usedBy.get(recipient.routingId)??new Set<string>()).add(workflow.name));
 const listed:ListedRouting[]=routings.map(r=>({routing:r.routing,revision:r.revision,retired:r.retired,usedBy:[...usedBy.get(r.routing.id)??[]]}));
 const people=await automationPeopleNames(ctx,routings.flatMap(r=>r.routing.rows.flatMap(row=>row.assignTo.kind==='people'?row.assignTo.userIds:[])));
 return <GroupsWorkspace access={access} groups={groups} routings={listed} options={{businessGroups:options.businessGroups,companies:options.companies,departments:options.departments,jobTitles:options.jobTitles}} people={people}/>;
}

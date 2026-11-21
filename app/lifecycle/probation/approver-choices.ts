import 'server-only';
import type {SessionContext} from '@/db/client';
import {automationAssignmentGroups,listAutomationRoutings} from '@/packs/automation/service';
import type {ApproverChoices} from './approval-routing-fields';
/**
 * Choices for the form editor's approver pickers (lane G1): the live shared routings and the assignment groups of HR
 * Automation, read through their existing readers (both answer only for someone who may configure automation, which a
 * Probation configurer may). Names only; group members stay with the On/Off Boarding configuration.
 */
export async function probationApproverChoices(ctx:SessionContext):Promise<ApproverChoices>{
 const routings=await listAutomationRoutings(ctx),groups=await automationAssignmentGroups(ctx);
 return{routings:routings.filter(r=>!r.retired).map(r=>({id:r.routing.id,name:r.routing.name})),groups:groups.map(g=>({id:g.id,name:g.name}))};
}

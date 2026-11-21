/** Contract's basic least-recently-assigned policy; share one chooser across effects in the same unit. */
import {routedStepChooser} from './routed-step-assignment';
import type {ContractAutomationContext} from './contract-automation-context';
export function contractRoutingChooser(context:ContractAutomationContext,today:string,lastAssigned:Record<string,string|null>){
 return routedStepChooser({today,groups:context.groups.map(group=>({...group,limit:0})),users:context.activePeople.map(id=>({id,load:0,lastAssigned:lastAssigned[id]??null,onLeave:false}))});
}

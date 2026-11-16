import 'server-only';
import type {SessionContext} from '@/db/client';
import {automationBuilderAccess} from '@/packs/automation/service';
import {lifecycleWorkflowAvailability} from '../lifecycle/workflow-availability';
import type {AutomationFilter,AutomationPageAccess} from './types';

/**
 * Who may open the shared builders and which modules they configure, from each module owner's existing fact:
 * On/Off Boarding V9 administration, the Probation module permission (as the shared store answers it, 5740) and
 * Contract staff configuration. Presentation only: every read and save checks again.
 */
export async function automationPageAccess(ctx:SessionContext):Promise<AutomationPageAccess>{
 const [modules,store]=await Promise.all([lifecycleWorkflowAvailability(ctx),automationBuilderAccess(ctx)]);
 const access={legacy:modules.legacy===true,probation:store.probation,contractStaff:store.contractStaff};
 return {...access,any:access.legacy||access.probation||access.contractStaff||store.any};
}
/** The requested filter when it is one of ours, otherwise the first module the viewer configures. */
export function automationFilter(value:unknown,access:AutomationPageAccess):AutomationFilter{
 if(value==='all'||value==='onb'||value==='off'||value==='contract_staff'||value==='probation')return value;
 return access.probation?'probation':access.legacy?'onb':access.contractStaff?'contract_staff':'all';
}

/** ADR-0170 step 4 — the explainers and the setup co-pilot as harness capabilities.
 *
 * Each entry runs its owner AS THE CALLER and returns the declared shape (core/semantic-model/entities-explain.ts,
 * entities-setup.ts); the harness discloses it under those declarations before the model sees it. Offered only
 * where the caller's module is enabled (and, for the co-pilot, to administrators): an offer is never authority,
 * each owner re-checks its own. Not imported by the production Assistant; core/harness/tools.ts binds these. */
import type {SessionContext} from '../../db/client';
import {isAdmin} from '../../lib/authz-model';
import {isModuleEnabled} from '../entitlements';
import {setupCopilot,SetupCopilotRefused} from '../setup-copilot/copilot';
import {explainOwnAttendanceDay} from './attendance';
import {explainOwnLeaveEntitlement} from './entitlement';
import {provenance,refuse,type ExplainerOutcome} from './outcome';
import {explainOwnPayslipStatutory} from './statutory';

export type TerasCapabilityScope=Readonly<{companyId:string;locale?:string}>;
export type TerasCapability=Readonly<{name:string;module:string|null;admin:boolean;run(ctx:SessionContext,input:Record<string,unknown>,scope:TerasCapabilityScope):Promise<ExplainerOutcome>}>;
const text=(value:unknown)=>typeof value==='string'?value:undefined;

async function copilot(ctx:SessionContext,scope:TerasCapabilityScope):Promise<ExplainerOutcome>{
 try{return{ok:true,...await setupCopilot(ctx,scope.companyId),provenance:provenance('core/setup-copilot/copilot.ts#setupCopilot','Not applicable: readiness checks are configuration state, not versioned rules.','/control-tower/readiness',
  'Ordered from the readiness owners; counts only, never people. A stage marked unknown could not be read for this person; claims setup has no readiness check yet.')};}
 catch(error){if(error instanceof SetupCopilotRefused)return refuse('not_permitted','The setup co-pilot is available to administrators only.');throw error;}
}
export const TERAS_CAPABILITIES:readonly TerasCapability[]=Object.freeze([
 {name:'explain_payslip_statutory',module:'payroll',admin:false,run:(ctx,input)=>explainOwnPayslipStatutory(ctx,{period:text(input.period),item:text(input.item)})},
 {name:'explain_leave_entitlement',module:'leave',admin:false,run:(ctx,input)=>explainOwnLeaveEntitlement(ctx,{leave_type:text(input.leave_type),as_of:text(input.as_of)})},
 {name:'explain_attendance_day',module:'attendance',admin:false,run:(ctx,input,scope)=>explainOwnAttendanceDay(ctx,{date:text(input.date)},scope.locale)},
 {name:'setup_copilot',module:null,admin:true,run:(ctx,_input,scope)=>copilot(ctx,scope)},
]);
/** Capabilities this caller may be offered. */
export const terasCapabilitiesFor=(ctx:SessionContext):readonly TerasCapability[]=>
 TERAS_CAPABILITIES.filter(row=>(!row.admin||isAdmin(ctx))&&(row.module===null||isModuleEnabled(ctx,row.module)));

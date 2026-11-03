/** ADR-0170 step 4 — the explainers and the setup co-pilot as harness capabilities; AI Centre issue 13b adds the
 * governed pay averages, offered only to callers with payroll access.
 *
 * Each entry runs its owner AS THE CALLER and returns the declared shape (core/semantic-model/entities-explain.ts,
 * entities-setup.ts); the harness discloses it under those declarations before the model sees it. Offered only
 * where the caller's module is enabled (and, for the co-pilot, to administrators), and the three explainers only while
 * the tenant's explainers worker may run (ADR-0170 §3.13: switched on and the tenant not stopped). An offer is never
 * authority, each owner re-checks its own. Not imported by the production Assistant; the Teras harness tool provider
 * binds these. */
import type {SessionContext} from '../../db/client';
import {canManagePayroll,isAdmin} from '../../lib/authz-model';
import {isModuleEnabled} from '../entitlements';
import {workerRunGate} from '../agent-registry/controls';
import {setupCopilot,SetupCopilotRefused} from '../setup-copilot/copilot';
import {payAverages,PAY_AVERAGE_MINIMUM_GROUP,type PayAverageCompany} from '../../packs/payroll/service';
import {explainOwnAttendanceDay} from './attendance';
import {explainOwnLeaveEntitlement} from './entitlement';
import {provenance,refuse,type ExplainerOutcome} from './outcome';
import {explainOwnPayslipStatutory} from './statutory';
import {explainOwnPayDifference} from './pay-difference';
import {explainOwnClaimLimit} from './claim-limit';

export type TerasCapabilityScope=Readonly<{companyId:string;locale?:string}>;
export type TerasCapability=Readonly<{name:string;module:string|null;admin:boolean;
 /** 'payroll': offered only to a caller with payroll access (lib/authz-model.ts canManagePayroll: an administrator or a
  * payroll partner). The owner re-checks the company scope in the database. */
 access?:'payroll';
 /** The registered worker whose run gate governs the offer (core/agent-registry/workers.ts), or null. */
 worker:'explainers'|null;run(ctx:SessionContext,input:Record<string,unknown>,scope:TerasCapabilityScope):Promise<ExplainerOutcome>}>;
const text=(value:unknown)=>typeof value==='string'?value:undefined;

async function copilot(ctx:SessionContext,scope:TerasCapabilityScope):Promise<ExplainerOutcome>{
 try{return{ok:true,...await setupCopilot(ctx,scope.companyId),provenance:provenance('core/setup-copilot/copilot.ts#setupCopilot','Not applicable: readiness checks are configuration state, not versioned rules.','/control-tower/readiness',
  'Ordered from the readiness owners; counts only, never people. A stage marked unknown could not be read for this person; claims setup has no readiness check yet.')};}
 catch(error){if(error instanceof SetupCopilotRefused)return refuse('not_permitted','The setup co-pilot is available to administrators only.');throw error;}
}
/** The pay averages as the model may read them: the owner's result without company ids (never disclosed, and not
 * needed to word the answer). Every figure is still disclosed as a band and restored for the person. */
async function payAggregates(ctx:SessionContext,input:Record<string,unknown>):Promise<ExplainerOutcome>{
 const result=await payAverages(ctx,{breakdown:input.breakdown==='department'?'department':'company'});
 if(!result.ok)return refuse(result.refusal,result.message);
 const companies=result.companies.map(({companyId:_companyId,...row}:PayAverageCompany)=>row);
 return{ok:true,measure:result.measure,measureLabel:result.measureLabel,breakdown:result.breakdown,overall:result.overall,companies,
  provenance:provenance('packs/payroll/pay-averages.ts#payAverages','Not applicable: averages of closed payslip figures, not a versioned rule.','/payroll/reports',
   `Group figures only, computed by the payroll service; never one person's pay. Groups under ${PAY_AVERAGE_MINIMUM_GROUP} people, groups whose complement in their company is under ${PAY_AVERAGE_MINIMUM_GROUP}, and groups withheld to protect them are not shown.`)};
}
export const TERAS_CAPABILITIES:readonly TerasCapability[]=Object.freeze([
 {name:'explain_payslip_statutory',module:'payroll',admin:false,worker:'explainers',run:(ctx,input)=>explainOwnPayslipStatutory(ctx,{period:text(input.period),item:text(input.item)})},
 {name:'explain_leave_entitlement',module:'leave',admin:false,worker:'explainers',run:(ctx,input)=>explainOwnLeaveEntitlement(ctx,{leave_type:text(input.leave_type),as_of:text(input.as_of)})},
 {name:'explain_attendance_day',module:'attendance',admin:false,worker:'explainers',run:(ctx,input,scope)=>explainOwnAttendanceDay(ctx,{date:text(input.date)},scope.locale)},
 {name:'setup_copilot',module:null,admin:true,worker:null,run:(ctx,_input,scope)=>copilot(ctx,scope)},
 {name:'pay_aggregates',module:'payroll',admin:false,access:'payroll',worker:null,run:(ctx,input)=>payAggregates(ctx,input)},
 // AI v2 W5: "Why?" on the pay difference and the claim limits, under the explainers worker switch like the three above.
 {name:'explain_pay_difference',module:'payroll',admin:false,worker:'explainers',run:(ctx,input)=>explainOwnPayDifference(ctx,{period:text(input.period),compare_to:text(input.compare_to)})},
 {name:'explain_claim_limit',module:'claims',admin:false,worker:'explainers',run:(ctx,input)=>explainOwnClaimLimit(ctx,{claim_type:text(input.claim_type)})},
]);
/** Capabilities this caller may be offered. A capability that belongs to a worker is offered only while that worker's
 * run gate is open (registered, switched on, tenant not stopped), read once per call in the caller's tenant. */
export async function terasCapabilitiesFor(ctx:SessionContext):Promise<readonly TerasCapability[]>{
 const candidates=TERAS_CAPABILITIES.filter(row=>(!row.admin||isAdmin(ctx))&&(row.access!=='payroll'||canManagePayroll(ctx))&&(row.module===null||isModuleEnabled(ctx,row.module)));
 const workers=[...new Set(candidates.flatMap(row=>row.worker?[row.worker]:[]))];
 const open=new Set<string>();
 for(const worker of workers)if((await workerRunGate(ctx,worker)).run)open.add(worker);
 return Object.freeze(candidates.filter(row=>row.worker===null||open.has(row.worker)));
}

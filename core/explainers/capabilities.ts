/** ADR-0170 step 4 — the explainers and the setup co-pilot as harness capabilities.
 *
 * Each entry runs its owner AS THE CALLER and returns the declared shape (core/semantic-model/entities-explain.ts,
 * entities-setup.ts); the harness discloses it under those declarations before the model sees it. Offered only
 * where the caller's module is enabled (and, for the co-pilot, to administrators), and the three explainers only while
 * the tenant's explainers worker may run (ADR-0170 §3.13: switched on and the tenant not stopped). An offer is never
 * authority, each owner re-checks its own. Not imported by the production Assistant; the Teras harness tool provider
 * binds these. */
import type {SessionContext} from '../../db/client';
import {isAdmin} from '../../lib/authz-model';
import {isModuleEnabled} from '../entitlements';
import {workerRunGate} from '../agent-registry/controls';
import {setupCopilot,SetupCopilotRefused} from '../setup-copilot/copilot';
import {explainOwnAttendanceDay} from './attendance';
import {explainOwnLeaveEntitlement} from './entitlement';
import {provenance,refuse,type ExplainerOutcome} from './outcome';
import {explainOwnPayslipStatutory} from './statutory';

export type TerasCapabilityScope=Readonly<{companyId:string;locale?:string}>;
export type TerasCapability=Readonly<{name:string;module:string|null;admin:boolean;
 /** The registered worker whose run gate governs the offer (core/agent-registry/workers.ts), or null. */
 worker:'explainers'|null;run(ctx:SessionContext,input:Record<string,unknown>,scope:TerasCapabilityScope):Promise<ExplainerOutcome>}>;
const text=(value:unknown)=>typeof value==='string'?value:undefined;

async function copilot(ctx:SessionContext,scope:TerasCapabilityScope):Promise<ExplainerOutcome>{
 try{return{ok:true,...await setupCopilot(ctx,scope.companyId),provenance:provenance('core/setup-copilot/copilot.ts#setupCopilot','Not applicable: readiness checks are configuration state, not versioned rules.','/control-tower/readiness',
  'Ordered from the readiness owners; counts only, never people. A stage marked unknown could not be read for this person; claims setup has no readiness check yet.')};}
 catch(error){if(error instanceof SetupCopilotRefused)return refuse('not_permitted','The setup co-pilot is available to administrators only.');throw error;}
}
/** Public page guidance is literal product knowledge, never a configuration or account read.
 * Keep these checks in the native owners: an offered capability is not execution authority. */
export async function passwordPolicyGuidance(ctx:SessionContext):Promise<ExplainerOutcome>{
 if(!isAdmin(ctx))return refuse('not_permitted','Password Policy guidance is available to administrators only.');
 const page='/admin/security-center/password-policy';
 return {ok:true,page,purpose:'Set password requirements and lockout policy for internal embedded HR login.',
  navigation:'Open Security Center, then Password Policy.',
  humanBoundary:'A group administrator chooses and saves policy changes, or unlocks a verified password-locked account through its native account controls. Password Policy requires internal embedded HR login; external-provider password controls remain with that provider. Disabled accounts and MFA are separate controls.',
  provenance:provenance('core/explainers/capabilities.ts#passwordPolicyGuidance','Not applicable: literal public page guidance, not a tenant policy read.',page,'Page purpose and human authority only. No password, policy, account state or provider operation is read or changed.')};
}
export async function correctionControlsGuidance(ctx:SessionContext,scope:TerasCapabilityScope):Promise<ExplainerOutcome>{
 if(!isAdmin(ctx)||!isModuleEnabled(ctx,'payroll',scope.companyId))return refuse('not_permitted','Correction Controls guidance requires an administrator with Payroll enabled.');
 const page='/payroll/setup/correction-controls';
 return {ok:true,page,purpose:'Review the control that makes native payroll correction actions available.',
  navigation:'Open Payroll Setup, then Correction Controls.',
  humanBoundary:'Administrators can review this page; only a group administrator may save the tenant-wide setting. An authorized human separately chooses any payroll correction action on the affected batch after reviewing its consequences and the native action requirements.',
  provenance:provenance('core/explainers/capabilities.ts#correctionControlsGuidance','Not applicable: literal public page guidance, not a payroll setting read.',page,'Page purpose and human authority only. No setting, batch, person, pay value or payroll action is read or changed.')};
}
export const TERAS_CAPABILITIES:readonly TerasCapability[]=Object.freeze([
 {name:'explain_payslip_statutory',module:'payroll',admin:false,worker:'explainers',run:(ctx,input)=>explainOwnPayslipStatutory(ctx,{period:text(input.period),item:text(input.item)})},
 {name:'explain_leave_entitlement',module:'leave',admin:false,worker:'explainers',run:(ctx,input)=>explainOwnLeaveEntitlement(ctx,{leave_type:text(input.leave_type),as_of:text(input.as_of)})},
 {name:'explain_attendance_day',module:'attendance',admin:false,worker:'explainers',run:(ctx,input,scope)=>explainOwnAttendanceDay(ctx,{date:text(input.date)},scope.locale)},
 {name:'setup_copilot',module:null,admin:true,worker:null,run:(ctx,_input,scope)=>copilot(ctx,scope)},
 {name:'password_policy_guidance',module:null,admin:true,worker:null,run:ctx=>passwordPolicyGuidance(ctx)},
 {name:'correction_controls_guidance',module:'payroll',admin:true,worker:null,run:(ctx,_input,scope)=>correctionControlsGuidance(ctx,scope)},
]);
/** Capabilities this caller may be offered. A capability that belongs to a worker is offered only while that worker's
 * run gate is open (registered, switched on, tenant not stopped), read once per call in the caller's tenant. */
export async function terasCapabilitiesFor(ctx:SessionContext):Promise<readonly TerasCapability[]>{
 const candidates=TERAS_CAPABILITIES.filter(row=>(!row.admin||isAdmin(ctx))&&(row.module===null||isModuleEnabled(ctx,row.module)));
 const workers=[...new Set(candidates.flatMap(row=>row.worker?[row.worker]:[]))];
 const open=new Set<string>();
 for(const worker of workers)if((await workerRunGate(ctx,worker)).run)open.add(worker);
 return Object.freeze(candidates.filter(row=>row.worker===null||open.has(row.worker)));
}

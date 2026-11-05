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
import {canManagePayroll,hasTeamAccess,isAdmin} from '../../lib/authz-model';
import {isModuleEnabled} from '../entitlements';
import {workerRunGate} from '../agent-registry/controls';
import {setupCopilot,SetupCopilotRefused} from '../setup-copilot/copilot';
import {payAverages,PAY_AVERAGE_MINIMUM_GROUP,type PayAverageCompany} from '../../packs/payroll/service';
import {workforceMetrics,WORKFORCE_MINIMUM_GROUP,type WorkforceCompany} from '../workforce-metrics';
import {explainOwnAttendanceDay} from './attendance';
import {explainOwnLeaveEntitlement} from './entitlement';
import {provenance,refuse,type ExplainerOutcome} from './outcome';
import {explainOwnPayslipStatutory} from './statutory';
import {explainOwnPayDifference} from './pay-difference';
import {explainOwnClaimLimit} from './claim-limit';
import {LoopViewRefused,loopPausedCompanies,loopsOverview} from '../loops/views';
import {loopCompanyLevels} from '../loops/autonomy-views';
import {maxLevel} from '../loops/autonomy';
import {levelKey} from '../loops/autonomy-types';
import {askMyPayrollReadiness} from '../pre-salary/ask';
import {payrollAuditStatus,payrollCycleStatus,payrollLoopSettings,salaryPayrollChecks} from './payroll-loops';
import {askPolicyHandbook} from '../handbook/ask';
import {askAiQuality} from '../learning/ask';
import {payrollLearningStatus} from './payroll-learning';

export type TerasCapabilityScope=Readonly<{companyId:string;locale?:string}>;
export type TerasCapability=Readonly<{name:string;module:string|null;admin:boolean;
 /** 'payroll': offered only to a caller with payroll access (lib/authz-model.ts canManagePayroll: an administrator or a
  * payroll partner). The owner re-checks the company scope in the database. 'team' (AI v2 W7): offered only to a manager
  * or an administrator (hasTeamAccess); the owner re-checks the administered companies or the My Team scope. */
 access?:'payroll'|'team';
 /** The registered worker whose run gate governs the offer (core/agent-registry/workers.ts), or null. */
 worker:'explainers'|null;
 /** Release merge (spec v22): served as this topic of product_guidance (core/product-context/tools.ts GUIDANCE_TOPICS),
  * never bound as a tool of its own, so the offer stays within the provider's tool ceiling. Same runner, same gating. */
 topic?:'password_policy'|'correction_controls';
 run(ctx:SessionContext,input:Record<string,unknown>,scope:TerasCapabilityScope):Promise<ExplainerOutcome>}>;
const text=(value:unknown)=>typeof value==='string'?value:undefined;

async function copilot(ctx:SessionContext,scope:TerasCapabilityScope):Promise<ExplainerOutcome>{
 try{return{ok:true,...await setupCopilot(ctx,scope.companyId),provenance:provenance('core/setup-copilot/copilot.ts#setupCopilot','Not applicable: readiness checks are configuration state, not versioned rules.','/payroll/setup?readiness=full',
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
/** AI v2 W7: workforce metrics as the model may read them: the owner's result without company ids or the threshold.
 * Every figure is still disclosed as a band and restored for the person. */
async function workforceAggregates(ctx:SessionContext,input:Record<string,unknown>):Promise<ExplainerOutcome>{
 const result=await workforceMetrics(ctx,{metric:text(input.metric),breakdown:text(input.breakdown),period:text(input.period),from:text(input.from),to:text(input.to),asOf:text(input.as_of)});
 if(!result.ok)return refuse(result.refusal,result.message);
 const {ok:_ok,minimumGroup:_minimum,companies,...rest}=result;
 return{ok:true,...rest,companies:companies.map(({companyId:_companyId,...row}:WorkforceCompany)=>row),
  provenance:provenance('core/workforce-metrics.ts#workforceMetrics','Not applicable: counts and sums of recorded employment, attendance and leave figures, not a versioned rule.','/analytics',
   `Group figures only, counted by the workforce service; never one person. Groups under ${WORKFORCE_MINIMUM_GROUP} people, groups whose complement is under ${WORKFORCE_MINIMUM_GROUP}, groups whose members share one figure, and groups withheld to protect them are not shown.`)};
}
/** AI v2 W8: the loops overview as an administrator may ask about it: the owner's rows without the sponsor (a person),
 * the window counts or the correction rate, plus where each loop is paused and (AI v2 Phase 2 P2-1) its level in each
 * company the administrator administers and the highest level it may reach. Every figure is still disclosed as a band
 * and restored for the person; the owner refuses anyone but an administrator. */
async function loopsStatus(ctx:SessionContext):Promise<ExplainerOutcome>{
 try{
  const overview=await loopsOverview(ctx),paused=await loopPausedCompanies(ctx),levels=await loopCompanyLevels(ctx);
  return{ok:true,canSwitch:overview.canSwitch,
   loops:overview.rows.map(row=>({loop:row.id,ceiling:levelKey(maxLevel(row.id)),levels:levels[row.id].map(item=>({company:item.companyName,level:levelKey(item.level)})),
    on:row.on,stopped:row.stopped,running:row.running,
    lastRun:row.lastRun?{at:row.lastRun.at.toISOString(),status:row.lastRun.status,capped:row.lastRun.capped}:null,
    openNow:row.openNow,waitingNow:row.waitingNow,pausedIn:paused[row.id].map(company=>({company}))})),
   provenance:provenance('core/loops/views.ts#loopsOverview','Not applicable: switches, pauses and card counts, not a versioned rule.','/control-tower/loops',
    'Counts and states only, read under the administrator\'s own access: never who a card is for, who switched a loop on, or a figure from pay. Loops are switched on or off and paused on the Loops page; a group administrator changes a loop\'s level on its own page, and pay, employment status, access, discipline and statutory filing loops stay at Prepare.')};
 }catch(error){if(error instanceof LoopViewRefused)return refuse('not_permitted','The loops overview is available to administrators only.');throw error;}
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
 {name:'password_policy_guidance',module:null,admin:true,worker:null,topic:'password_policy',run:ctx=>passwordPolicyGuidance(ctx)},
 {name:'correction_controls_guidance',module:'payroll',admin:true,worker:null,topic:'correction_controls',run:(ctx,_input,scope)=>correctionControlsGuidance(ctx,scope)},
 {name:'pay_aggregates',module:'payroll',admin:false,access:'payroll',worker:null,run:(ctx,input)=>payAggregates(ctx,input)},
 {name:'workforce_metrics',module:null,admin:false,access:'team',worker:null,run:(ctx,input)=>workforceAggregates(ctx,input)},
 // AI v2 W5: "Why?" on the pay difference and the claim limits, under the explainers worker switch like the three above.
 {name:'explain_pay_difference',module:'payroll',admin:false,worker:'explainers',run:(ctx,input)=>explainOwnPayDifference(ctx,{period:text(input.period),compare_to:text(input.compare_to)})},
 {name:'explain_claim_limit',module:'claims',admin:false,worker:'explainers',run:(ctx,input)=>explainOwnClaimLimit(ctx,{claim_type:text(input.claim_type)})},
 // AI v2 W8: the loops overview, administrators only (core/semantic-model/entities-loops.ts).
 {name:'loops_overview',module:null,admin:true,worker:null,run:ctx=>loopsStatus(ctx)},
 // AI v2 Phase 2 P2-3: "what do I need to do before payroll?", the person's own checklist (core/pre-salary/person-items.ts).
 {name:'my_payroll_readiness',module:null,admin:false,worker:null,run:(ctx,_input,scope)=>askMyPayrollReadiness(ctx,scope)},
 // AI v2 Phase 2 (wave 1 integration): the payroll-cycle loop pages, administrators only (core/semantic-model/entities-payroll-loops.ts).
 {name:'payroll_cycle_status',module:'payroll',admin:true,worker:null,run:(ctx,input)=>payrollCycleStatus(ctx,input)},
 {name:'salary_payroll_checks',module:'payroll',admin:true,worker:null,run:(ctx,input)=>salaryPayrollChecks(ctx,input)},
 {name:'payroll_loop_settings',module:'payroll',admin:true,worker:null,run:ctx=>payrollLoopSettings(ctx)},
 {name:'payroll_audit_status',module:'payroll',admin:true,worker:null,run:(ctx,input)=>payrollAuditStatus(ctx,input)},
 // AI v2 Phase 2 P2-5: "what does our policy say?", from the approved version in force only (core/handbook/ask.ts).
 {name:'my_policy_handbook',module:null,admin:false,worker:null,run:(ctx,input)=>askPolicyHandbook(ctx,{topic:text(input.topic)})},
 // AI v2 Phase 2 P2-6: AI quality for HR and group administrators (core/learning/ask.ts); the service checks again.
 {name:'ai_quality_summary',module:null,admin:true,worker:null,run:(ctx,input)=>askAiQuality(ctx,input)},
 // Payroll history learning (P2): "Learned this cycle", payroll administrators only (core/payroll-learning/status.ts), counts under the
 // small-group rule; the owner reads only the companies whose payroll the caller administers.
 {name:'payroll_learning_status',module:'payroll',admin:true,worker:null,run:(ctx,input)=>payrollLearningStatus(ctx,input)},
]);
/** Capabilities this caller may be offered. A capability that belongs to a worker is offered only while that worker's
 * run gate is open (registered, switched on, tenant not stopped), read once per call in the caller's tenant. */
export async function terasCapabilitiesFor(ctx:SessionContext):Promise<readonly TerasCapability[]>{
 const candidates=TERAS_CAPABILITIES.filter(row=>(!row.admin||isAdmin(ctx))&&(row.access!=='payroll'||canManagePayroll(ctx))&&(row.access!=='team'||hasTeamAccess(ctx))&&(row.module===null||isModuleEnabled(ctx,row.module)));
 const workers=[...new Set(candidates.flatMap(row=>row.worker?[row.worker]:[]))];
 const open=new Set<string>();
 for(const worker of workers)if((await workerRunGate(ctx,worker)).run)open.add(worker);
 return Object.freeze(candidates.filter(row=>row.worker===null||open.has(row.worker)));
}

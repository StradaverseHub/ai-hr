/** Code-owned action closure, not an executor or a permissions oracle. Source anchors are for
 * developer compatibility review, never model instructions or dynamic imports/function lookup.
 * Availability describes source integration only; it is NOT runtime/security/release evidence.
 */
import {z} from 'zod';
import {MODULE_CATALOG} from '../../packs/catalog';
import {MODULE_AGENT_CAPABILITIES,isAgentModuleCode,type AgentModuleCode,type AgentCapability} from './module-agents';
import {OWN_LEAVE_ACTION,OWN_LEAVE_CONTRACT_VERSION} from '../assistant-actions/own-leave-contract';
export const MODULE_AGENT_ACTION_CONTRACT_VERSION=1 as const;
export type ModuleActionPhase='read'|'explain'|'prepare'|'confirm';
export type ModuleActionStatus='implemented'|'read_context_only'|'human_workflow_only'|'pending_adapter'|'unavailable';
type ReadCapability<M extends AgentModuleCode>=Extract<typeof MODULE_AGENT_CAPABILITIES[number],readonly[M,unknown]>[1];
type EffectIds={employees:'employees.import';org:'org.reporting.change';leave:typeof OWN_LEAVE_ACTION;ess:'ess.profile.propose';approvals:'approvals.leave.decide';knowledge_base:'knowledge_base.article.create';payroll:'payroll.close';attendance:'attendance.correction.request';claims:'claims.submit';performance:'performance.review.submit';rewards:'rewards.post';lifecycle:'lifecycle.resignation.submit';toil:'toil.credit.grant';multi_cycle_payroll:'multi_cycle_payroll.create_run';typed_pay_components:'typed_pay_components.create';'country-my':'country-my.statutory.update';notifications:'notifications.mark_read';system_explorer:never;assistant:never;system_testing:'system_testing.record_result'};
export type ModuleEffectActionId=EffectIds[AgentModuleCode];
type CanonicalOwner='personnel'|'organization'|'leave'|'profile'|'knowledge_base'|'payroll'|'attendance'|'claims'|'performance'|'rewards'|'lifecycle'|'country_pack_my'|'notifications'|'schema_inventory'|'assistant_orchestration'|'system_testing';
type PhaseBoundary=Readonly<{status:ModuleActionStatus;adapter:'leave_own_review_v1'|null;inputSchema:string|null;outputSchema:string|null}>;
type Action<M extends AgentModuleCode>=Readonly<{id:EffectIds[M];owner:CanonicalOwner;publicBoundary:string;contractVersion:number;prepare:PhaseBoundary;confirm:PhaseBoundary;human:'canonical_workflow_required';outcome:'canonical_receipt_required'|'submitted_not_approved'}>;
type Declaration<M extends AgentModuleCode>=Readonly<{module:M;owner:CanonicalOwner;publicBoundary:string;source:string;coverage:'partial_actions'|'read_only'|'orchestration_only';money:'stored_kernel_amounts_only'|'canonical_engine_only'|'not_exposed';phases:Readonly<Record<ModuleActionPhase,ModuleActionStatus>>;read:Readonly<{id:ReadCapability<M>;status:'implemented';adapter:'canonical_module_read_v1';inputSchema:'AgentModuleCode';outputSchema:'createModuleAgentReaders.moduleWork:return'}>;actions:readonly Action<M>[]} >;
export type ModuleAgentActionDeclaration={[M in AgentModuleCode]:Declaration<M>}[AgentModuleCode];
const phase=(status:ModuleActionStatus):PhaseBoundary=>Object.freeze({status,adapter:null,inputSchema:null,outputSchema:null});
function pending<M extends AgentModuleCode>(id:EffectIds[M],owner:CanonicalOwner,boundary:string,status:'pending_adapter'|'human_workflow_only'='pending_adapter'):Action<M>{return Object.freeze({id,owner,publicBoundary:boundary,contractVersion:1,prepare:phase(status),confirm:phase(status),human:'canonical_workflow_required',outcome:'canonical_receipt_required'});}
const leaveApply:Action<'leave'>=Object.freeze({id:OWN_LEAVE_ACTION,owner:'leave',publicBoundary:'packs/leave/service.ts#requestLeave',contractVersion:OWN_LEAVE_CONTRACT_VERSION,
 prepare:Object.freeze({status:'implemented',adapter:'leave_own_review_v1',inputSchema:'OwnLeaveHumanSelection+OwnLeaveHumanText',outputSchema:'OwnLeavePreparedReview'}),
 confirm:Object.freeze({status:'implemented',adapter:'leave_own_review_v1',inputSchema:'OwnLeaveConfirmation',outputSchema:'OwnLeaveFinalReceipt'}),human:'canonical_workflow_required',outcome:'submitted_not_approved'});
function declaration<M extends AgentModuleCode>(module:M,owner:CanonicalOwner,publicBoundary:string,source:string,actions:readonly Action<M>[]=[],money:Declaration<M>['money']='not_exposed',coverage:Declaration<M>['coverage']='partial_actions'):Declaration<M>{
 const read=MODULE_AGENT_CAPABILITIES.find(row=>row[0]===module);if(!read)throw Error('Module action declaration unavailable.');
 return Object.freeze({module,owner,publicBoundary,source,coverage,money,phases:Object.freeze({read:'implemented',explain:'read_context_only',prepare:actions[0]?.prepare.status??'unavailable',confirm:actions[0]?.confirm.status??'unavailable'}),read:Object.freeze({id:read[1] as ReadCapability<M>,status:'implemented',adapter:'canonical_module_read_v1',inputSchema:'AgentModuleCode',outputSchema:'createModuleAgentReaders.moduleWork:return'}),actions:Object.freeze([...actions])});
}
/** Exhaustive over the actual module capability union; a newly typed module requires a declaration.
 * The one shared Assistant coordinates these module-owned boundaries; it owns no generic HR effect.
 */
export const MODULE_AGENT_ACTIONS=Object.freeze({
 employees:declaration('employees','personnel','core/workforce-commands.ts','core/module-agent-readers.ts#employees',[pending<'employees'>('employees.import','personnel','core/import.ts#commitEmployeeImport','human_workflow_only')]),
 org:declaration('org','organization','core/workforce-commands.ts#setReportingLine','core/module-agent-readers.ts#org',[pending<'org'>('org.reporting.change','organization','core/workforce-commands.ts#setReportingLine')]),
 leave:declaration('leave','leave','packs/leave/service.ts#requestLeave','core/assistant-actions/own-leave-store.ts#prepareOwnLeaveReviewTx+confirmOwnLeaveReview',[leaveApply]),
 ess:declaration('ess','profile','core/profile-edit.ts#submitOwnProfileEdit','core/record-readiness.ts#readinessSnapshot',[pending<'ess'>('ess.profile.propose','profile','core/profile-edit.ts#submitOwnProfileEdit')]),
 approvals:declaration('approvals','leave','packs/leave/service.ts#decideLeave','core/module-agent-readers.ts#approvals',[pending<'approvals'>('approvals.leave.decide','leave','packs/leave/service.ts#decideLeave')]),
 knowledge_base:declaration('knowledge_base','knowledge_base','core/knowledge-base.ts#createArticle','core/knowledge-base.ts#listDocuments',[pending<'knowledge_base'>('knowledge_base.article.create','knowledge_base','core/knowledge-base.ts#createArticle')]),
 payroll:declaration('payroll','payroll','packs/payroll/service.ts#closeBatch','core/read.ts#myPayslips',[pending<'payroll'>('payroll.close','payroll','packs/payroll/service.ts#closeBatch')],'stored_kernel_amounts_only'),
 attendance:declaration('attendance','attendance','packs/attendance/service.ts#requestAttendanceCorrection','core/read.ts#myAttendance',[pending<'attendance'>('attendance.correction.request','attendance','packs/attendance/service.ts#requestAttendanceCorrection')]),
 claims:declaration('claims','claims','packs/claims/service.ts#submitClaim','packs/claims/service.ts#ownClaimStatuses',[pending<'claims'>('claims.submit','claims','packs/claims/service.ts#submitClaim')]),
 performance:declaration('performance','performance','core/performance.ts#submitSelfReview','core/performance.ts#myReviews',[pending<'performance'>('performance.review.submit','performance','core/performance.ts#submitSelfReview')]),
 rewards:declaration('rewards','rewards','packs/rewards/service.ts#postRewardUnit','packs/rewards/service.ts#listRewardUnits',[pending<'rewards'>('rewards.post','rewards','packs/rewards/service.ts#postRewardUnit')],'canonical_engine_only'),
 lifecycle:declaration('lifecycle','lifecycle','core/offboarding.ts#submitResignation','core/lifecycle-self.ts#getMyOnboarding',[pending<'lifecycle'>('lifecycle.resignation.submit','lifecycle','core/offboarding.ts#submitResignation')]),
 toil:declaration('toil','leave','packs/leave/service.ts#grantLeaveCredit','core/read.ts#replacementLeaveLedger',[pending<'toil'>('toil.credit.grant','leave','packs/leave/service.ts#grantLeaveCredit')]),
 multi_cycle_payroll:declaration('multi_cycle_payroll','payroll','packs/payroll/service.ts#createAdditionalRun','core/read.ts#myReleasedPayslipRuns',[pending<'multi_cycle_payroll'>('multi_cycle_payroll.create_run','payroll','packs/payroll/service.ts#createAdditionalRun')],'stored_kernel_amounts_only'),
 typed_pay_components:declaration('typed_pay_components','payroll','packs/payroll/service.ts#createPayComponent','core/payslip-earning-lines.ts#storedComponentLines',[pending<'typed_pay_components'>('typed_pay_components.create','payroll','packs/payroll/service.ts#createPayComponent')],'stored_kernel_amounts_only'),
 'country-my':declaration('country-my','country_pack_my','localization/registry.ts#requirePackFor','localization/my/statutory.ts#setStatutoryProfileMY',[pending<'country-my'>('country-my.statutory.update','country_pack_my','localization/registry.ts#requirePackFor')],'canonical_engine_only'),
 notifications:declaration('notifications','notifications','core/notifications.ts#markNotificationRead','core/notifications.ts#listNotifications',[pending<'notifications'>('notifications.mark_read','notifications','core/notifications.ts#markNotificationRead')]),
 system_explorer:declaration('system_explorer','schema_inventory','core/schema-explorer.ts#listSchemaTables','core/module-agent-readers.ts#system_explorer',[],'not_exposed','read_only'),
 assistant:declaration('assistant','assistant_orchestration','core/module-agent-readers.ts#createModuleAgentReaders','lib/ai/module-agent-routing.ts',[],'not_exposed','orchestration_only'),
 system_testing:declaration('system_testing','system_testing','core/system-testing.ts#recordTestRun','core/system-testing.ts#listTestCases',[pending<'system_testing'>('system_testing.record_result','system_testing','core/system-testing.ts#recordTestRun')]),
} satisfies {[M in AgentModuleCode]:Declaration<M>});
const declarations:readonly ModuleAgentActionDeclaration[]=Object.freeze(Object.values(MODULE_AGENT_ACTIONS));
/** Static metadata only. This never checks a user's access or resolves a callable function. */
export function getModuleAgentAction(module:unknown,action:unknown){if(!isAgentModuleCode(module)||typeof action!=='string')return null;return declarations.find(row=>row.module===module)?.actions.find(row=>row.id===action)??null;}
const Nomination=z.object({module:z.string().max(80),action:z.string().max(120),phase:z.enum(['read','explain','prepare','confirm'])}).strict();
export type ModuleAgentActionNomination=Readonly<{kind:'read';module:AgentModuleCode;capability:AgentCapability;adapter:'canonical_module_read_v1'}>|Readonly<{kind:'prepare';module:'leave';action:'leave.apply';adapter:'leave_own_review_v1';requiresHumanSelection:true;effect:'none'}>;
/** Only a static server switch may consume the returned code. Model nominations cannot confirm a
 * human review, supply an actor/scope/employee, call services, compute money or gain module access. */
export function parseModuleAgentActionNomination(value:unknown):ModuleAgentActionNomination{
 const parsed=Nomination.safeParse(value);if(!parsed.success)throw Error('This module action is not available.');const p=parsed.data;if(!isAgentModuleCode(p.module))throw Error('This module action is not available.');const row=MODULE_AGENT_ACTIONS[p.module];
 if(p.phase==='read'&&p.action===row.read.id)return Object.freeze({kind:'read',module:p.module,capability:row.read.id,adapter:'canonical_module_read_v1'});
 const declared=getModuleAgentAction(p.module,p.action);
 if(p.module==='leave'&&p.action===OWN_LEAVE_ACTION&&p.action==='leave.apply'&&p.phase==='prepare'&&OWN_LEAVE_CONTRACT_VERSION===1&&declared?.contractVersion===1&&declared.prepare.status==='implemented'&&declared.prepare.adapter==='leave_own_review_v1')return Object.freeze({kind:'prepare',module:'leave',action:'leave.apply',adapter:'leave_own_review_v1',requiresHumanSelection:true,effect:'none'});
 throw Error('This module action is not available.');
}
const samePhase=(actual:PhaseBoundary|undefined,expected:PhaseBoundary)=>!!actual&&actual.status===expected.status&&actual.adapter===expected.adapter&&actual.inputSchema===expected.inputSchema&&actual.outputSchema===expected.outputSchema;
export type ModuleActionCoverageIssue=Readonly<{code:'missing_module'|'unknown_declaration'|'duplicate_catalogue_module'|'duplicate_declaration_module'|'duplicate_action'|'unknown_action'|'wrong_read_capability'|'unsupported_contract'|'malformed_declaration'|'missing_action'|'boundary_mismatch'|'phase_mismatch';module:string;action?:string}>;
/** Runtime closure check for catalogue changes/corrupt manifests. A closed result never proves
 * permissions or complete implementation: pending adapters and runtime evidence remain required.
 */
export function moduleAgentActionCoverage(catalogue:readonly{code:string}[]=MODULE_CATALOG,supplied:readonly unknown[]=declarations){
 const issues:ModuleActionCoverageIssue[]=[],catalogueSeen=new Set<string>(),seen=new Set<string>(),actions=new Set<string>();
 for(const entry of catalogue){if(catalogueSeen.has(entry.code))issues.push({code:'duplicate_catalogue_module',module:entry.code});catalogueSeen.add(entry.code);}
 for(const value of supplied){const row=value as ModuleAgentActionDeclaration;if(!row||typeof row.module!=='string'||!row.read||!Array.isArray(row.actions)){issues.push({code:'malformed_declaration',module:'unknown'});continue;}if(seen.has(row.module))issues.push({code:'duplicate_declaration_module',module:row.module});seen.add(row.module);
  if(!isAgentModuleCode(row.module)||!catalogueSeen.has(row.module)){issues.push({code:'unknown_declaration',module:row.module});continue;}
  const expected=MODULE_AGENT_ACTIONS[row.module];if(row.owner!==expected.owner||row.publicBoundary!==expected.publicBoundary||row.source!==expected.source)issues.push({code:'boundary_mismatch',module:row.module});if(row.read.id!==expected.read.id||row.read.status!==expected.read.status||row.read.adapter!==expected.read.adapter||row.read.inputSchema!==expected.read.inputSchema||row.read.outputSchema!==expected.read.outputSchema)issues.push({code:'wrong_read_capability',module:row.module});
  if(row.coverage!==expected.coverage||row.money!==expected.money||!row.phases||(['read','explain','prepare','confirm'] as const).some(phase=>row.phases[phase]!==expected.phases[phase]))issues.push({code:'phase_mismatch',module:row.module});
  for(const action of row.actions){if(!action||typeof action.id!=='string'){issues.push({code:'malformed_declaration',module:row.module});continue;}if(actions.has(action.id))issues.push({code:'duplicate_action',module:row.module,action:action.id});actions.add(action.id);
   const known=expected.actions.find(candidate=>candidate.id===action.id);if(!known)issues.push({code:'unknown_action',module:row.module,action:action.id});else if(action.owner!==known.owner||action.publicBoundary!==known.publicBoundary)issues.push({code:'boundary_mismatch',module:row.module,action:action.id});else if(!samePhase(action.prepare,known.prepare)||!samePhase(action.confirm,known.confirm)||action.human!==known.human||action.outcome!==known.outcome)issues.push({code:'phase_mismatch',module:row.module,action:action.id});if(action.contractVersion!==1||(row.module==='leave'&&action.id!=='leave.apply'))issues.push({code:'unsupported_contract',module:row.module,action:action.id});
  }
  for(const expectedAction of expected.actions)if(!row.actions.some(action=>action?.id===expectedAction.id))issues.push({code:'missing_action',module:row.module,action:expectedAction.id});
 }
 for(const code of catalogueSeen)if(!seen.has(code))issues.push({code:'missing_module',module:code});
 return Object.freeze({closed:issues.length===0,issues:Object.freeze(issues.map(issue=>Object.freeze(issue))),coverage:'source_declaration_only' as const});
}

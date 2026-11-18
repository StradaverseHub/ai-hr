/** Code-owned action closure, not an executor or a permissions oracle. Source anchors are for
 * developer compatibility review, never model instructions or dynamic imports/function lookup.
 * Availability describes source integration only; it is NOT runtime/security/release evidence.
 * WP7 (R3): every action and nomination here is derived from lib/ai/agent-action-registry.ts; only the
 * module-level facts (owner, boundary, source, money, coverage) are declared per module below.
 */
import {z} from 'zod';
import {MODULE_CATALOG} from '../../packs/catalog';
import {MODULE_AGENT_CAPABILITIES,isAgentModuleCode,type AgentModuleCode,type AgentCapability} from './module-agents';
import {agentActionById,agentActionsByModule,type AgentAction,type AgentActionServiceMember,type AgentActionAdapter,type AgentActionIdOfModule,type AgentActionOf,type AgentActionOwner,type AgentPreparableActionId} from './agent-action-registry';
export const MODULE_AGENT_ACTION_CONTRACT_VERSION=1 as const;
export type ModuleActionPhase='read'|'explain'|'prepare'|'confirm';
export type ModuleActionStatus='implemented'|'read_context_only'|'human_workflow_only'|'pending_adapter'|'unavailable';
type ReadCapability<M extends AgentModuleCode>=Extract<typeof MODULE_AGENT_CAPABILITIES[number],readonly[M,unknown]>[1];
type EffectIds={[M in AgentModuleCode]:AgentActionIdOfModule<M>};
export type ModuleEffectActionId=EffectIds[AgentModuleCode];
type CanonicalOwner=AgentActionOwner|'schema_inventory'|'assistant_orchestration';
type PhaseBoundary=Readonly<{status:ModuleActionStatus;adapter:AgentActionAdapter|null;inputSchema:string|null;outputSchema:string|null}>;
type Action<M extends AgentModuleCode>=Readonly<{id:EffectIds[M];owner:CanonicalOwner;publicBoundary:string;publicMember?:AgentActionServiceMember;observations?:'human_actual_only';contractVersion:number;prepare:PhaseBoundary;confirm:PhaseBoundary;human:'canonical_workflow_required';outcome:'canonical_receipt_required'|'submitted_not_approved'}>;
type Declaration<M extends AgentModuleCode>=Readonly<{module:M;owner:CanonicalOwner;publicBoundary:string;publicMember?:AgentActionServiceMember;source:string;coverage:'partial_actions'|'read_only'|'orchestration_only';money:'stored_kernel_amounts_only'|'canonical_engine_only'|'not_exposed';phases:Readonly<Record<ModuleActionPhase,ModuleActionStatus>>;read:Readonly<{id:ReadCapability<M>;status:'implemented';adapter:'canonical_module_read_v1';inputSchema:'AgentModuleCode';outputSchema:'createModuleAgentReaders.moduleWork:return'}>;actions:readonly Action<M>[]} >;
export type ModuleAgentActionDeclaration={[M in AgentModuleCode]:Declaration<M>}[AgentModuleCode];
/** Key order is part of specialistNativeContractDigest (JSON of MODULE_AGENT_ACTIONS[module]); keep it. */
const phaseOf=(phase:AgentAction['prepare']|AgentAction['confirm']):PhaseBoundary=>Object.freeze({status:phase.status,adapter:phase.adapter,inputSchema:phase.inputSchema,outputSchema:phase.outputSchema});
function actionOf(entry:AgentAction){
 return Object.freeze({id:entry.id,owner:entry.owner,publicBoundary:entry.service,...('serviceMember' in entry?{publicMember:entry.serviceMember}:{}),contractVersion:entry.contractVersion,...('observations' in entry?{observations:entry.observations}:{}),
  prepare:phaseOf(entry.prepare),confirm:phaseOf(entry.confirm),human:'canonical_workflow_required' as const,outcome:entry.outcome});
}
/** The action whose owning service IS the module's public boundary leads (it sets the module phases);
 * the others follow in registry order. WP13: Automatic-tier reminders are not chat actions (no model nominates,
 * prepares or confirms them; the agent principal runs them), so they stay out of the module contract and every
 * existing specialist native-contract digest is unchanged by adding one. */
function actionsOf<M extends AgentModuleCode>(module:M,publicBoundary:string):readonly Action<M>[]{
 const rows=(agentActionsByModule(module) as readonly AgentAction[]).filter(row=>row.policy.tier!=='automatic'),primary=rows.filter(row=>row.service===publicBoundary);
 return Object.freeze([...primary,...rows.filter(row=>!primary.includes(row))].map(actionOf)) as unknown as readonly Action<M>[];
}
function declaration<M extends AgentModuleCode>(module:M,owner:CanonicalOwner,publicBoundary:string,source:string,money:Declaration<M>['money']='not_exposed',coverage:Declaration<M>['coverage']='partial_actions'):Declaration<M>{
 const read=MODULE_AGENT_CAPABILITIES.find(row=>row[0]===module);if(!read)throw Error('Module action declaration unavailable.');const actions=actionsOf(module,publicBoundary);
 return Object.freeze({module,owner,publicBoundary,source,coverage,money,phases:Object.freeze({read:'implemented',explain:'read_context_only',prepare:actions[0]?.prepare.status??'unavailable',confirm:actions[0]?.confirm.status??'unavailable'}),read:Object.freeze({id:read[1] as ReadCapability<M>,status:'implemented',adapter:'canonical_module_read_v1',inputSchema:'AgentModuleCode',outputSchema:'createModuleAgentReaders.moduleWork:return'}),actions});
}
/** Exhaustive over the actual module capability union; a newly typed module requires a declaration.
 * The one shared Assistant coordinates these module-owned boundaries; it owns no generic HR effect.
 * Country action dispatch must resolve the actual company country through requirePackFor and call
 * its typed statutory.set member. System Testing may save only the human's real versioned observations.
 */
export const MODULE_AGENT_ACTIONS=Object.freeze({
 employees:declaration('employees','personnel','core/import.ts#commitEmployeeImport','app/admin/personnel/import/actions.ts#validateImportAction+commitImportAction'),
 org:declaration('org','organization','core/workforce-commands.ts#setReportingLine','core/assistant-actions/org-action-review-store.ts#prepareOrgActionReview+confirmOrgActionReview'),
 leave:declaration('leave','leave','packs/leave/service.ts#requestLeave','core/assistant-actions/own-leave-store.ts#prepareOwnLeaveReviewTx+confirmOwnLeaveReview'),
 ess:declaration('ess','profile','core/profile.ts#requestProfileChange','core/assistant-actions/module-action-review-store.ts#prepareProfileModuleActionReview+confirmProfileModuleActionReview'),
 approvals:declaration('approvals','leave','packs/leave/service.ts#decideLeave','core/assistant-actions/leave-decision-review-store.ts#prepareLeaveDecisionReview+confirmLeaveDecisionReview'),
 knowledge_base:declaration('knowledge_base','knowledge_base','core/knowledge-base.ts#createArticle','core/assistant-actions/knowledge-article-review-store.ts#prepareKnowledgeArticleReview+confirmKnowledgeArticleReview'),
 payroll:declaration('payroll','payroll','packs/payroll/service.ts#closeBatch','core/assistant-actions/payroll-close-review-store.ts#preparePayrollCloseReview+confirmPayrollCloseReview','stored_kernel_amounts_only'),
 attendance:declaration('attendance','attendance','packs/attendance/service.ts#requestAttendanceCorrection','core/assistant-actions/attendance-correction-review-store.ts#prepareAttendanceCorrectionReview+confirmAttendanceCorrectionReview'),
 claims:declaration('claims','claims','packs/claims/service.ts#submitDraftClaims','core/assistant-actions/module-action-review-store.ts#prepareClaimSubmissionModuleActionReview+confirmClaimSubmissionModuleActionReview','canonical_engine_only'),
 performance:declaration('performance','performance','core/performance.ts#acknowledgeReview','packs/performance/service.ts#ownPerformanceWorkStatusesTx'),
 rewards:declaration('rewards','rewards','packs/rewards/service.ts#postRewardUnit','core/assistant-actions/rewards-post-review-store.ts#prepareRewardsPostReview+confirmRewardsPostReview','canonical_engine_only'),
 lifecycle:declaration('lifecycle','lifecycle','core/lifecycle-self.ts#submitMyAcknowledgement','core/assistant-actions/lifecycle-ack-review-store.ts#prepareLifecycleAckReview+confirmLifecycleAckReview'),
 toil:declaration('toil','leave','packs/leave/service.ts#submitReplacementLeaveRequest','core/assistant-actions/toil-request-review-store.ts#prepareToilRequestReview+confirmToilRequestReview'),
 multi_cycle_payroll:declaration('multi_cycle_payroll','payroll','packs/payroll/service.ts#createAdditionalRun','core/assistant-actions/multi-cycle-run-review-store.ts#prepareMultiCycleRunReview+confirmMultiCycleRunReview','stored_kernel_amounts_only'),
 typed_pay_components:declaration('typed_pay_components','payroll','packs/payroll/service.ts#createPayComponent','core/assistant-actions/pay-component-review-store.ts#preparePayComponentReview+confirmPayComponentReview','stored_kernel_amounts_only'),
 'country-my':Object.freeze({...declaration('country-my','country_pack_my','localization/registry.ts#requirePackFor','core/assistant-actions/country-statutory-review-store.ts#prepareCountryStatutoryReview+confirmCountryStatutoryReview','canonical_engine_only'),publicMember:'statutory.set' as const}),
 notifications:declaration('notifications','notifications','core/notification-email.ts#saveNotificationEmailPreferences','core/assistant-actions/module-action-review-store.ts#prepareModuleActionReview+confirmModuleActionReview'),
 system_explorer:declaration('system_explorer','schema_inventory','core/schema-explorer.ts#listSchemaTables','core/module-agent-readers.ts#createModuleAgentReaders','not_exposed','read_only'),
 assistant:declaration('assistant','assistant_orchestration','core/module-agent-readers.ts#createModuleAgentReaders','core/module-agent-readers.ts#createModuleAgentReaders','not_exposed','orchestration_only'),
 system_testing:declaration('system_testing','system_testing','core/system-testing-workspace.ts#saveTestingExecution','core/system-testing-workspace.ts#ownTestingWorkStatusesTx'),
} satisfies {[M in AgentModuleCode]:Declaration<M>});
const declarations:readonly ModuleAgentActionDeclaration[]=Object.freeze(Object.values(MODULE_AGENT_ACTIONS));
/** Static metadata only. This never checks a user's access or resolves a callable function. */
export function getModuleAgentAction(module:unknown,action:unknown){if(!isAgentModuleCode(module)||typeof action!=='string')return null;return declarations.find(row=>row.module===module)?.actions.find(row=>row.id===action)??null;}
const Nomination=z.object({module:z.string().max(80),action:z.string().max(120),phase:z.enum(['read','explain','prepare','confirm'])}).strict();
type PrepareNomination<K extends AgentPreparableActionId>=Readonly<{kind:'prepare';module:AgentActionOf<K>['module'];action:K;adapter:NonNullable<AgentActionOf<K>['prepare']['adapter']>;requiresHumanSelection:true;effect:'none'}>;
export type ModuleAgentActionNomination=Readonly<{kind:'read';module:AgentModuleCode;capability:AgentCapability;adapter:'canonical_module_read_v1'}>|{[K in AgentPreparableActionId]:PrepareNomination<K>}[AgentPreparableActionId];
/** Only a static server switch may consume the returned code. Model nominations cannot confirm a
 * human review, supply an actor/scope/employee, call services, compute money or gain module access.
 * A prepare nomination needs the registry entry, its module and an implemented contract-v1 adapter. */
export function parseModuleAgentActionNomination(value:unknown):ModuleAgentActionNomination{
 const parsed=Nomination.safeParse(value);if(!parsed.success)throw Error('This module action is not available.');const p=parsed.data;if(!isAgentModuleCode(p.module))throw Error('This module action is not available.');const row=MODULE_AGENT_ACTIONS[p.module];
 if(p.phase==='read'&&p.action===row.read.id)return Object.freeze({kind:'read',module:p.module,capability:row.read.id,adapter:'canonical_module_read_v1'});
 const declared=getModuleAgentAction(p.module,p.action),entry=agentActionById(p.action);
 if(p.phase==='prepare'&&declared&&entry&&entry.module===p.module&&declared.id===entry.id&&declared.contractVersion===1&&entry.contractVersion===1
  &&declared.prepare.status==='implemented'&&entry.prepare.status==='implemented'&&declared.prepare.adapter!==null&&declared.prepare.adapter===entry.prepare.adapter)
  return Object.freeze({kind:'prepare',module:entry.module,action:entry.id,adapter:declared.prepare.adapter,requiresHumanSelection:true,effect:'none'}) as ModuleAgentActionNomination;
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
  const expected:ModuleAgentActionDeclaration=MODULE_AGENT_ACTIONS[row.module];if(row.owner!==expected.owner||row.publicBoundary!==expected.publicBoundary||row.source!==expected.source||row.publicMember!==expected.publicMember)issues.push({code:'boundary_mismatch',module:row.module});if(row.read.id!==expected.read.id||row.read.status!==expected.read.status||row.read.adapter!==expected.read.adapter||row.read.inputSchema!==expected.read.inputSchema||row.read.outputSchema!==expected.read.outputSchema)issues.push({code:'wrong_read_capability',module:row.module});
  if(row.coverage!==expected.coverage||row.money!==expected.money||!row.phases||(['read','explain','prepare','confirm'] as const).some(phase=>row.phases[phase]!==expected.phases[phase]))issues.push({code:'phase_mismatch',module:row.module});
  for(const action of row.actions){if(!action||typeof action.id!=='string'){issues.push({code:'malformed_declaration',module:row.module});continue;}if(actions.has(action.id))issues.push({code:'duplicate_action',module:row.module,action:action.id});actions.add(action.id);
   const known=expected.actions.find(candidate=>candidate.id===action.id);if(!known)issues.push({code:'unknown_action',module:row.module,action:action.id});else if(action.owner!==known.owner||action.publicBoundary!==known.publicBoundary||action.publicMember!==known.publicMember||action.observations!==known.observations)issues.push({code:'boundary_mismatch',module:row.module,action:action.id});else if(!samePhase(action.prepare,known.prepare)||!samePhase(action.confirm,known.confirm)||action.human!==known.human||action.outcome!==known.outcome)issues.push({code:'phase_mismatch',module:row.module,action:action.id});if(action.contractVersion!==1||(row.module==='leave'&&agentActionById(action.id)?.module!=='leave'))issues.push({code:'unsupported_contract',module:row.module,action:action.id});
  }
  for(const expectedAction of expected.actions)if(!row.actions.some(action=>action?.id===expectedAction.id))issues.push({code:'missing_action',module:row.module,action:expectedAction.id});
 }
 for(const code of catalogueSeen)if(!seen.has(code))issues.push({code:'missing_module',module:code});
 return Object.freeze({closed:issues.length===0,issues:Object.freeze(issues.map(issue=>Object.freeze(issue))),coverage:'source_declaration_only' as const});
}

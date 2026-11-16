/**
 * Lifecycle service facade (ADR-0080 D11, ADR-0095). The ONE module outside-the-pack callers import for
 * lifecycle services. Server-only in practice (drags in db/client).
 */
export { LifecycleError, LEVEL } from '../../core/lifecycle-base';
export * from '../../core/lifecycle-config';
export * from '../../core/lifecycle-cases';
export * from '../../core/lifecycle-it';
export * from '../../core/lifecycle-assets';
export * from '../../core/lifecycle-self';
export * from '../../core/lifecycle-import';
export * from '../../core/lifecycle-worklist';
export { lifecycleHubTileCounts } from '../../core/lifecycle-hub';
export * from '../../core/lifecycle-export';
export * from '../../core/lifecycle-rules';
export * from '../../core/lifecycle-defaults';

export * from './onboarding/service';
export * from './v9/entrypoints';
export type { Workspace as LifecycleV9Workspace, Command as LifecycleV9Command, OwnCase as LifecycleV9OwnCase, CaseDetail as LifecycleV9CaseDetail, UpdatedEmailPreview as LifecycleV9UpdatedEmailPreview, WorkflowRemovalPreview as LifecycleV9WorkflowRemovalPreview, WorkflowRemovalResult as LifecycleV9WorkflowRemovalResult } from './v9/service';
/** Narrow source handoff; the native owner supplies every canonical input and deduplicates its receipt. */
export async function createProbationOffboardingTx(tx:import('../../db/client').Tx,ctx:import('../../db/client').SessionContext,caseId:string):Promise<string>{
 const{sql}=await import('drizzle-orm');const[row]=await tx.execute<{intent:{employmentId:string;type:'Non-confirmation';noticeDate:string;lastDay:string;offboardingCaseId?:string}}>(sql`select app.probation_offboarding_intent(${caseId}::uuid) as intent`);
 if(row.intent.offboardingCaseId)return row.intent.offboardingCaseId;
 const{v9CreateOffboardingTx}=await import('./v9/service');return v9CreateOffboardingTx(tx,ctx,{employmentId:row.intent.employmentId,type:row.intent.type,noticeDate:row.intent.noticeDate,lastDay:row.intent.lastDay},{kind:'probation',caseId});
}
export {v9WorkflowNavigationAllowed} from './v9/navigation';
export * from './resignation/service';

/** Managed resignations hand off only native source facts within the caller's admitted transaction. */
export async function createResignationOffboardingTx(tx:import('../../db/client').Tx,ctx:import('../../db/client').SessionContext,caseId:string):Promise<string>{
 const {sql}=await import('drizzle-orm');
 // A failed constructor must roll back its writes and local admission before the
 // workflow records a recoverable domain failure in the surrounding transaction.
 return tx.transaction(async handoffTx=>{
  await handoffTx.execute(sql`select app.resignation_offboarding_admit(${caseId}::uuid)`);
  const [row]=await handoffTx.execute<{intent:{employmentId:string;type:'Resignation';noticeDate:string;lastDay:string;offboardingCaseId:string|null}}>(sql`select app.resignation_offboarding_intent(${caseId}::uuid) as intent`);
  let result=row.intent.offboardingCaseId;
  if(!result){
   const {v9CreateOffboardingTx}=await import('./v9/service');
   result=await v9CreateOffboardingTx(handoffTx,ctx,{employmentId:row.intent.employmentId,type:row.intent.type,noticeDate:row.intent.noticeDate,lastDay:row.intent.lastDay},{kind:'resignation',caseId});
  }
  await handoffTx.execute(sql`select set_config('app.resignation_handoff','',true)`);
  return result;
 });
}

/** Lifecycle owns resignation posting composition; Personnel remains the movement writer. */
export {offboardingPostingAccess,offboardingPostingChoices,rejectOffboardingPosting} from '../../core/resignation-clearance';
/** Admit only the deterministic email payload being queued, never a caller-selected runtime claim. */
export async function prepareResignationEmailTx(tx:import('../../db/client').Tx,ctx:import('../../db/client').SessionContext,input:{caseId:string;key:string;to:readonly string[];cc:readonly string[];subject:string;body:string;content?:import('../../lib/automation-email-ipc').AutomationEmailContent}):Promise<void>{
 const {prepareResignationProofTx}=await import('../../core/resignation-proof');
 await prepareResignationProofTx(tx,ctx,{operation:'email',caseId:input.caseId,args:{key:input.key,to:[...input.to],cc:[...input.cc],subject:input.subject,body:input.body,content:input.content??null}});
}

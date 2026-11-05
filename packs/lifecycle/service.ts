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
export type { Workspace as LifecycleV9Workspace, Command as LifecycleV9Command, OwnCase as LifecycleV9OwnCase, CaseDetail as LifecycleV9CaseDetail, UpdatedEmailPreview as LifecycleV9UpdatedEmailPreview } from './v9/service';
/** Narrow source handoff; the native owner supplies every canonical input and deduplicates its receipt. */
export async function createProbationOffboardingTx(tx:import('../../db/client').Tx,ctx:import('../../db/client').SessionContext,caseId:string):Promise<string>{
 const{sql}=await import('drizzle-orm');const[row]=await tx.execute<{intent:{employmentId:string;type:'Non-confirmation';noticeDate:string;lastDay:string;offboardingCaseId?:string}}>(sql`select app.probation_offboarding_intent(${caseId}::uuid) as intent`);
 if(row.intent.offboardingCaseId)return row.intent.offboardingCaseId;
 const{v9CreateOffboardingTx}=await import('./v9/service');return v9CreateOffboardingTx(tx,ctx,{employmentId:row.intent.employmentId,type:row.intent.type,noticeDate:row.intent.noticeDate,lastDay:row.intent.lastDay},{kind:'probation',caseId});
}
export {v9WorkflowNavigationAllowed} from './v9/navigation';

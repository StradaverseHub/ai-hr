/** AI v2 Phase 2, P2-6 — a recommendation the approver decided against, as a learning signal. Its own light module: the
 * approvals page calls it after a decision, so it loads only ./capture.ts and the outcome follow-ups.
 *
 * Recorded only once the recommender's own follow-up (core/recommenders/leave-decision.ts recordRecommendationDecision)
 * says the approver disagreed, for the approver's own recommendation record; at most once per record. */
import {and,eq} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../../db/client';
import {terasOutcomeFollowup} from '../../db/teras-schema';
import {NOT_RECORDED,RECOMMENDER_IDENTITY,UUID,capture,insertSignalTx,localeOf,ownRecordTx,person,roleBand,type SignalOutcome} from './capture';

export async function recordRecommendationSignal(supplied:SessionContext,input:Readonly<{recordId:unknown;locale?:unknown}>):Promise<SignalOutcome>{
 const ctx=capture(supplied);
 if(!person(ctx)||typeof input.recordId!=='string'||!UUID.test(input.recordId))return NOT_RECORDED;
 const recordId=input.recordId;
 return withTenant(ctx,async tx=>{
  const record=await ownRecordTx(tx,ctx,{id:recordId});
  if(!record||record.agentIdentity!==RECOMMENDER_IDENTITY)return NOT_RECORDED;
  const f=terasOutcomeFollowup;
  const [rejected]=await tx.select({id:f.id}).from(f).where(and(eq(f.tenantId,ctx.tenantId),eq(f.recordId,record.id),eq(f.kind,'decision'),eq(f.decision,'rejected'))).limit(1);
  if(!rejected)return NOT_RECORDED;
  return {recorded:await insertSignalTx(tx,{tenantId:ctx.tenantId,companyId:record.companyId,recordId:record.id,signalKey:'recommendation',
   kind:'recommendation_rejected',action:'approvals.leave.decide',area:'approvals',role:roleBand(ctx),locale:localeOf(input.locale),proposalId:null,byUserId:ctx.userId})};
 });
}

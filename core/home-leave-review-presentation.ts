import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {OwnLeaveReviewIndexResult} from '../lib/assistant-actions/own-leave-http';
import {LeaveCancellationReviewIndex,OWN_LEAVE_CANCELLATION_ACTION} from '../lib/assistant-actions/own-leave-change-contract';
import {LeaveDecisionReviewIndex} from '../lib/assistant-actions/leave-decision-review-contract';
import {REVIEWED_LEAVE_DECISION_ACTION} from '../lib/assistant-actions/reviewed-leave-decision-contract';
import {assertAiPresentationPrincipalTx} from './ai-principal';
import {TENANT_STATUS_GOOD_STANDING} from './entitlement-types';
import {boundNativeOutcomeTransactionTx} from './module-native-outcome-bounds';

type Action='leave.apply'|typeof OWN_LEAVE_CANCELLATION_ACTION|typeof REVIEWED_LEAVE_DECISION_ACTION;

/** Home only discovers metadata. Explicit reopening and confirmation still use custody owners. */
async function readIndex(ctx:SessionContext,action:Action){
 const captured={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};
 try{
  // The former apply and decision indices refused the read-only suspension carrier.
  const status=captured.entitlements?.tenantStatus;
  if(action!==OWN_LEAVE_CANCELLATION_ACTION&&status!=null&&!TENANT_STATUS_GOOD_STANDING.has(status))
   throw new Error('Leave review index unavailable.');
  return await withTenant(captured,async tx=>{
   if(action==='leave.apply')await boundNativeOutcomeTransactionTx(tx);
   await assertAiPresentationPrincipalTx(tx,captured);
   const rows=await tx.execute<{action:unknown;actionId:unknown;state:unknown;createdAt:unknown;expiresAt:unknown}>(sql`
    select action,action_id as "actionId",state,
     to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",
     to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "expiresAt"
    from app.home_leave_presentation_index(${action})`);
   return Array.from(rows);
  },{readOnlySnapshot:true});
 }catch{throw new Error('Leave review index unavailable.');}
}

export async function readHomeOwnLeaveReviewIndex(ctx:SessionContext){
 const rows=await readIndex(ctx,'leave.apply');
 return OwnLeaveReviewIndexResult.parse({kind:'review_index',reviews:rows.map(({actionId,state,createdAt,expiresAt})=>({actionId,state,createdAt,expiresAt}))});
}

export async function readHomeLeaveCancellationReviewIndex(ctx:SessionContext){
 const rows=await readIndex(ctx,OWN_LEAVE_CANCELLATION_ACTION);
 return LeaveCancellationReviewIndex.parse({kind:'leave_cancellation_review_index',reviews:rows.map(row=>({...row,contractVersion:1}))});
}

export async function readHomeLeaveDecisionReviewIndex(ctx:SessionContext){
 const rows=await readIndex(ctx,REVIEWED_LEAVE_DECISION_ACTION);
 return LeaveDecisionReviewIndex.parse({kind:'leave_decision_review_index',reviews:rows.map(row=>({...row,contractVersion:1}))});
}

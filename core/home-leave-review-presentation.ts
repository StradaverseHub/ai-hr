import {sql,type SQL} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {OwnLeaveReviewIndexResult} from '../lib/assistant-actions/own-leave-http';
import {LeaveCancellationReviewIndex,OWN_LEAVE_CANCELLATION_ACTION} from '../lib/assistant-actions/own-leave-change-contract';
import {LeaveDecisionReviewIndex} from '../lib/assistant-actions/leave-decision-review-contract';
import {REVIEWED_LEAVE_DECISION_ACTION} from '../lib/assistant-actions/reviewed-leave-decision-contract';
import {aiPresentationPrincipalSql,assertAiPresentationPrincipalTx} from './ai-principal';
import {ownerCardSectionReads} from './home-owner-reads';
import {TENANT_STATUS_GOOD_STANDING} from './entitlement-types';
import {boundNativeOutcomeTransactionTx} from './module-native-outcome-bounds';

type Action='leave.apply'|typeof OWN_LEAVE_CANCELLATION_ACTION|typeof REVIEWED_LEAVE_DECISION_ACTION;

type IndexRow={action:unknown;actionId:unknown;state:unknown;createdAt:unknown;expiresAt:unknown};
const UNAVAILABLE='Leave review index unavailable.';
/** The index function's columns as Home reads them (instants as UTC ISO text with milliseconds). */
const INDEX_COLUMNS=sql`action,action_id as "actionId",state,
     to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",
     to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "expiresAt"`;
/** The former apply and decision indices refused the read-only suspension carrier. */
const tenantAdmits=(ctx:SessionContext,action:Action)=>{
 const status=ctx.entitlements?.tenantStatus;
 return action===OWN_LEAVE_CANCELLATION_ACTION||status==null||TENANT_STATUS_GOOD_STANDING.has(status);
};

/** Home only discovers metadata. Explicit reopening and confirmation still use custody owners. */
async function readIndex(ctx:SessionContext,action:Action){
 const captured={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};
 try{
  if(!tenantAdmits(captured,action))throw new Error(UNAVAILABLE);
  return await withTenant(captured,async tx=>{
   if(action==='leave.apply'){
    await boundNativeOutcomeTransactionTx(tx);
    // Decision 13: the bounded own transaction sends the presentation proof and the index as one statement. A false
    // proof reads nothing (the CASE) and refuses as the proof did; a refusal inside the function fails the statement
    // and refuses as it did; both are this reader's one "unavailable".
    const proof=aiPresentationPrincipalSql(captured);
    if(proof&&!ownerCardSectionReads()){
     const [row]=await tx.execute<{rows:unknown}>(sql`select ${indexRowsCaseSql(proof,action)} as rows`);
     return indexRowsFromJson(row?.rows);
    }
   }
   await assertAiPresentationPrincipalTx(tx,captured);
   const rows=await tx.execute<IndexRow>(sql`
    select ${INDEX_COLUMNS}
    from app.home_leave_presentation_index(${action})`);
   return Array.from(rows);
  },{readOnlySnapshot:true});
 }catch{throw new Error(UNAVAILABLE);}
}

const ownIndex=(rows:readonly IndexRow[])=>OwnLeaveReviewIndexResult.parse({kind:'review_index',reviews:rows.map(({actionId,state,createdAt,expiresAt})=>({actionId,state,createdAt,expiresAt}))});
const cancellationIndex=(rows:readonly IndexRow[])=>LeaveCancellationReviewIndex.parse({kind:'leave_cancellation_review_index',reviews:rows.map(row=>({...row,contractVersion:1}))});
const decisionIndex=(rows:readonly IndexRow[])=>LeaveDecisionReviewIndex.parse({kind:'leave_decision_review_index',reviews:rows.map(row=>({...row,contractVersion:1}))});

export async function readHomeOwnLeaveReviewIndex(ctx:SessionContext){
 return ownIndex(await readIndex(ctx,'leave.apply'));
}

export async function readHomeLeaveCancellationReviewIndex(ctx:SessionContext){
 return cancellationIndex(await readIndex(ctx,OWN_LEAVE_CANCELLATION_ACTION));
}

export async function readHomeLeaveDecisionReviewIndex(ctx:SessionContext){
 return decisionIndex(await readIndex(ctx,REVIEWED_LEAVE_DECISION_ACTION));
}

/** The index rows in the function's own row order, read only where `proof` holds and the function cannot refuse:
 * its own admission (the calling login of this tenant, no agent principal, a repeatable-read read-only snapshot, a
 * current principal snapshot and an unarchived, unblocked login) is what the presentation proof establishes, and the
 * application role and agent setting are checked beside it. Null JSON: the proof failed. */
function indexRowsCaseSql(proof:SQL,action:Action):SQL{
 return sql`(case when (${proof}) and session_user='ai_hr_app' and nullif(current_setting('app.agent_principal_id',true),'') is null
  then (select coalesce(jsonb_agg(jsonb_build_object('action',index_row.action,'actionId',index_row."actionId",'state',index_row.state,
    'createdAt',index_row."createdAt",'expiresAt',index_row."expiresAt") order by index_row.ord),'[]'::jsonb)
   from (select ${INDEX_COLUMNS},ord from app.home_leave_presentation_index(${action}) with ordinality
    as presented(action,action_id,state,created_at,expires_at,ord)) index_row) end)`;
}
/** Rows as the driver returns the index select: the same keys, in its column order. */
function indexRowsFromJson(value:unknown):IndexRow[]{
 if(value===null||value===undefined)throw new Error(UNAVAILABLE);
 if(!Array.isArray(value))throw new Error('Bundled review index is not a row array.');
 return value.map(raw=>{
  const row=raw as Record<string,unknown>;
  for(const key of ['action','actionId','state','createdAt','expiresAt'])if(!(key in row))throw new Error('Bundled review index row is incomplete.');
  return {action:row.action,actionId:row.actionId,state:row.state,createdAt:row.createdAt,expiresAt:row.expiresAt};
 });
}

/** The cancellation and decision indices as sections of Today's Needs you statement (core/needs-you-bundle.ts,
 * decision 13), each the owner's own index call behind the owner's own proof (`proof`: aiPresentationPrincipalSql, null
 * where that proof answers false without reading). A section that can only refuse is 'refused' without SQL: the tenant
 * standing check, a proof that reads nothing, and (cancellations) a login without a person, which the function refuses.
 * The apply index keeps its own bounded transaction. */
export type HomeLeaveReviewIndexKind='cancellations'|'decisions';
const KIND_ACTION:Readonly<Record<HomeLeaveReviewIndexKind,Action>>={cancellations:OWN_LEAVE_CANCELLATION_ACTION,decisions:REVIEWED_LEAVE_DECISION_ACTION};
export function homeLeaveReviewIndexBundleSql(ctx:SessionContext,kind:HomeLeaveReviewIndexKind,proof:SQL|null):SQL|'refused'{
 const action=KIND_ACTION[kind];
 if(!tenantAdmits(ctx,action)||!proof||(action===OWN_LEAVE_CANCELLATION_ACTION&&!ctx.personId))return 'refused';
 return indexRowsCaseSql(proof,action);
}
/** readHomeLeaveCancellationReviewIndex / readHomeLeaveDecisionReviewIndex over the section's rows; throws exactly where
 * the owner throws (its one "unavailable" for a refused proof, the owner's own schema refusal for a malformed row). */
export function homeLeaveReviewIndexFromBundle(kind:'cancellations',value:unknown):ReturnType<typeof cancellationIndex>;
export function homeLeaveReviewIndexFromBundle(kind:'decisions',value:unknown):ReturnType<typeof decisionIndex>;
export function homeLeaveReviewIndexFromBundle(kind:HomeLeaveReviewIndexKind,value:unknown){
 const rows=indexRowsFromJson(value);
 return kind==='cancellations'?cancellationIndex(rows):decisionIndex(rows);
}

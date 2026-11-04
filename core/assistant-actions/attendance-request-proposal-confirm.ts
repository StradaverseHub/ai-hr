/** AI v2 Phase 1 W2 — Confirm and Edit for an attendance correction or overtime card prepared in chat
 * (core/proposals/attendance-request.ts).
 *
 * Confirm submits only on the person's explicit Confirm (`confirm: true`), under their own login:
 *  1. the signed proposal must verify for THIS caller (signature, expiry, tenant, login and person), so a tampered,
 *     expired or someone else's proposal is refused before any read;
 *  2. it becomes the existing review store's own confirmation (the custody handle and the reviewed digest), and the
 *     store's confirm command re-runs every owner check in its own top-level transaction: the actor and Assistant grant,
 *     the attendance module, the AI and per-action pauses, own employment, and then the attendance service's own
 *     preparation again, which must reproduce the reviewed digest exactly (the day on record, the rules, a request
 *     already waiting, the versioned approval route of ADR-0121) before the request and its approval snapshot are
 *     written. Any refusal writes nothing. The request goes to the existing approval; it is never approved here.
 * Errors are bounded to a refusal code; no source detail, private text or SQL parameter escapes. No model call. */
import type {SessionContext} from '../../db/client';
import {withAgentActionPauseScope} from '../agent-action-pause-scope';
import {ATTENDANCE_CORRECTION_ACTION,attendanceEditHref,attendanceReviewConfirmation,type AttendanceEditResult,type AttendanceProposalRefusal} from '../proposals/attendance-request';
import {confirmAttendanceCorrectionReview} from './attendance-correction-review-store';
import {overtimeRequestReviews} from './overtime-request-review-store';

export type AttendanceRequestConfirmResult=Readonly<{kind:'submitted';action:string;requestId:string}>
 |Readonly<{kind:'refused';reason:AttendanceProposalRefusal|'not_confirmed'|'unavailable'|'retired'}>;

const refused=(reason:Extract<AttendanceRequestConfirmResult,{kind:'refused'}>['reason']):AttendanceRequestConfirmResult=>Object.freeze({kind:'refused' as const,reason});
const capture=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))});

export async function confirmAttendanceRequestProposal(supplied:SessionContext,input:Readonly<{proposal:unknown;confirm:unknown}>,now:Date=new Date()):Promise<AttendanceRequestConfirmResult>{
 const ctx=capture(supplied);
 // Only the person's explicit Confirm submits; anything else (absent, "true", 1) is not a confirmation.
 if(input.confirm!==true)return refused('not_confirmed');
 let named:ReturnType<typeof attendanceReviewConfirmation>;
 // Proposals fail closed without their configured secret (ProposalUnavailable): nothing is submitted.
 try{named=attendanceReviewConfirmation(input.proposal,ctx,now);}catch{return refused('unavailable');}
 if(!named.ok)return refused(named.reason);
 const {action,confirmation}=named;
 try{
  // The review command owns its top-level transaction: never wrapped in another one here.
  return await withAgentActionPauseScope(action,async()=>{
   if(action===ATTENDANCE_CORRECTION_ACTION){
    const result=await confirmAttendanceCorrectionReview(ctx,confirmation);
    return result.kind==='completed'?Object.freeze({kind:'submitted' as const,action,requestId:result.receipt.receipt.correctionId}):refused('retired');
   }
   const result=await overtimeRequestReviews.confirm(ctx,{actionId:confirmation.actionId,reviewedDigest:confirmation.reviewedDigest});
   return result.kind==='completed'?Object.freeze({kind:'submitted' as const,action,requestId:result.receipt.receipt.correctionId}):refused('retired');
  });
 }catch{return refused('unavailable');}
}

/** Edit: the existing form for a verified attendance card, prefilled and validated as the caller. */
export async function editAttendanceRequestProposal(supplied:SessionContext,proposal:unknown,now:Date=new Date()):Promise<AttendanceEditResult>{
 try{return await attendanceEditHref(capture(supplied),proposal,now);}catch{return Object.freeze({ok:false as const,reason:'unavailable' as const});}
}

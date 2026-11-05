/** AI v2 W8 — Confirm on the missed clock-out card in Today's "Needs you".
 *
 * The card asks the person why the clock-out was missed: "Forgot to clock out", "Device problem" or "Other", which they
 * type. The reason is only ever theirs: the server turns the option they picked into its label in their language, or
 * takes the words they typed, and it reaches the attendance service as their own reason. The model is not involved.
 *
 * Confirm submits only on the person's explicit press (`confirm: true`), under their own login:
 *  1. the loop case is read as the caller under row-level security (migration 0960): an open missed clock-out case
 *     addressed to them, for their own employment, while the loop may run and is not paused for the company. The date
 *     and the proposed clock-out come from the case, never from the post;
 *  2. the slice 1 attendance correction (core/proposals/attendance-request.ts) prepares the review as the caller, for the
 *     case's own employment (refused unless it is the caller's own and current; never their first active employment),
 *     with the attendance service's own read of the day; what it prepared must be what the card showed (the employment,
 *     the date, the clock-in on record and the proposed clock-out), or nothing is sent and the person is pointed to Edit;
 *  3. the correction's own Confirm (core/assistant-actions/attendance-request-proposal-confirm.ts) re-runs every
 *     owner check and sends the request for the usual approval. It is never approved here.
 * Errors are bounded to a refusal code; nothing private escapes. Never throws. */
import {and,eq} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../../db/client';
import {employment} from '../../db/schema';
import {terasLoopCase,terasLoopPause} from '../../db/teras-schema';
import {workerRunGateTx} from '../agent-registry/controls';
import {prepareChatAttendanceCorrectionProposal} from '../proposals/attendance-request';
import {confirmAttendanceRequestProposal} from '../assistant-actions/attendance-request-proposal-confirm';
import type {ClockOutConfirmResult,ClockOutRefusal} from '../../lib/today/clock-out-reasons';

const LOOP='loop_missed_clock_outs' as const;
const refused=(reason:ClockOutRefusal):ClockOutConfirmResult=>Object.freeze({kind:'refused' as const,reason});

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isDate=(value:unknown):value is string=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value);
const isClock=(value:unknown):value is string=>typeof value==='string'&&/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
const capture=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))});

type CaseFacts=Readonly<{employmentId:string;date:string;checkIn:string;proposedCheckOut:string}>;
/** The caller's own open missed clock-out case, as row-level security lets them read it, or why not. */
async function ownOpenCase(ctx:SessionContext,caseId:string):Promise<CaseFacts|'retired'|'unavailable'>{
 return withTenant(ctx,async tx=>{
  const [row]=await tx.select({workerId:terasLoopCase.workerId,state:terasLoopCase.state,recipient:terasLoopCase.recipient,companyId:terasLoopCase.companyId,
   employmentId:terasLoopCase.employmentId,facts:terasLoopCase.facts,personId:employment.personId})
   .from(terasLoopCase).leftJoin(employment,eq(employment.id,terasLoopCase.employmentId))
   .where(and(eq(terasLoopCase.tenantId,ctx.tenantId),eq(terasLoopCase.id,caseId))).limit(1);
  if(!row||row.workerId!==LOOP||row.recipient!=='employee'||!row.employmentId||!ctx.personId||row.personId!==ctx.personId)return 'unavailable';
  if(row.state!=='open')return 'retired';
  if(!(await workerRunGateTx(tx,ctx,LOOP)).run)return 'retired';
  const [paused]=await tx.select({paused:terasLoopPause.paused}).from(terasLoopPause)
   .where(and(eq(terasLoopPause.tenantId,ctx.tenantId),eq(terasLoopPause.workerId,LOOP),eq(terasLoopPause.companyId,row.companyId))).limit(1);
  if(paused?.paused)return 'retired';
  const {date,checkIn,proposedCheckOut}=row.facts as Record<string,unknown>;
  return isDate(date)&&isClock(checkIn)&&isClock(proposedCheckOut)?Object.freeze({employmentId:row.employmentId,date,checkIn,proposedCheckOut}):'unavailable';
 });
}

export async function confirmMissedClockOut(supplied:SessionContext,input:Readonly<{caseId:unknown;reason:string|null;confirm:unknown}>,now:Date=new Date()):Promise<ClockOutConfirmResult>{
 const ctx=capture(supplied);
 // Only the person's explicit Confirm submits; anything else (absent, "true", 1) is not a confirmation.
 if(input.confirm!==true)return refused('not_confirmed');
 if(typeof input.caseId!=='string'||!UUID.test(input.caseId)||!input.reason)return refused('invalid');
 try{
  if(!ctx.userId||!ctx.personId||ctx.agent)return refused('access');
  const shown=await ownOpenCase(ctx,input.caseId);
  if(shown==='retired'||shown==='unavailable')return refused(shown);
  // The case's own employment: a person with two employments, or serving notice, corrects the day the case is about.
  const prepared=await prepareChatAttendanceCorrectionProposal(ctx,{date:shown.date,checkOut:shown.proposedCheckOut,reason:input.reason},input.reason,now,{employmentId:shown.employmentId,dayOnRecord:true});
  if(!prepared)return refused('unavailable');
  if(prepared.kind!=='proposal')return refused('changed');
  // What the attendance service prepared must be what the card showed: the employment, the day, its clock-in and the
  // proposed clock-out.
  const facts=prepared.proposal.body.facts as Readonly<Record<string,unknown>>;
  if(prepared.proposal.body.forWhom.subjectId!==shown.employmentId)return refused('unavailable');
  if(facts.startDate!==shown.date||facts.checkOut!==shown.proposedCheckOut||facts.recordedCheckIn!==shown.checkIn||facts.recordedCheckOut!==undefined)return refused('changed');
  const result=await confirmAttendanceRequestProposal(ctx,{proposal:prepared.proposal,confirm:true},now);
  if(result.kind==='submitted')return Object.freeze({kind:'submitted' as const});
  const reason=result.reason;
  return refused(reason==='expired'?'expired':reason==='retired'?'retired':reason==='authority_mismatch'||reason==='authority_unsupported'?'access':'unavailable');
 }catch{return refused('unavailable');}
}

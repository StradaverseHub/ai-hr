/** Historical loop actions remain readable. Missed-clock-out undo requires a new human review
 * without an automatic application or recorded undo. The missing-data request loop retains its
 * existing authorised withdrawal, atomically recorded with its notice and undo receipt, and the passports loop's
 * renewal request (13 November 2026) is withdrawn the same way. The probation loop's opened review is cancelled through
 * the employment-review owner (owner decision, 13 November 2026: cancelLoopOpenedReviewTx), by HR only: an employee never
 * cancels their own probation review. */
import {and,eq,sql} from 'drizzle-orm';
import {withTenant,type Grant,type SessionContext} from '../../db/client';
import {appendEvent} from '../../db/events';
import {employment} from '../../db/schema';
import {terasLoopAction,terasLoopActionUndo} from '../../db/teras-autonomy-schema';
import {isAdmin} from '../../lib/authz-model';
import {LoopUndoRefused} from './act-clock-outs';
import {withdrawRequestTx} from './act-requests';
import {withdrawPassportRequestTx} from './act-passports';
import {cancelLoopOpenedReviewTx} from '../employment-review';
import type {UndoneBy} from './autonomy-types';
import type {LoopId} from './types';

export type LoopUndoRefusal='not_confirmed'|'invalid'|'unavailable'|'expired'|'changed'|'access'|'ask_hr'|'human_review_required';
export type LoopUndoResult=Readonly<{kind:'undone';by:UndoneBy}>|Readonly<{kind:'refused';reason:LoopUndoRefusal}>;
const refused=(reason:LoopUndoRefusal):LoopUndoResult=>Object.freeze({kind:'refused' as const,reason});
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const capture=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))});

/** A login's current authority from the database, or null when it is gone, blocked, of another tenant or no longer an
 * administrator. Entitlements are the tenant's, from the caller. */
export async function currentAuthority(caller:SessionContext,userId:string):Promise<SessionContext|null>{
 const resolved=await withTenant(caller,async tx=>{
  const [principal]=await tx.execute(sql`select p.tenant_id,p.person_id,p.grants,app.login_blocked(${userId}::uuid) as blocked from app.principal(${userId}::uuid) p`) as unknown as
   {tenant_id:string;person_id:string|null;grants:Grant[]|null;blocked:boolean}[];
  return principal??null;
 });
 if(!resolved||resolved.tenant_id!==caller.tenantId||resolved.blocked)return null;
 const grants=(resolved.grants??[]).map(grant=>({role:grant.role,companyId:grant.companyId??null}));
 const ctx:SessionContext={tenantId:caller.tenantId,userId,personId:resolved.person_id??null,grants,roles:[...new Set(grants.map(grant=>grant.role))],entitlements:caller.entitlements};
 return isAdmin(ctx)?ctx:null;
}

type Seen=Readonly<{workerId:LoopId;employmentId:string;personId:string|null;state:string;undoUntil:Date;undone:boolean;sponsorUserId:string;agentPrincipalId:string;
 facts:Readonly<Record<string,string|number|boolean|null>>;admin:boolean}>;
const UNDOABLE:ReadonlySet<string>=new Set(['loop_missed_clock_outs','loop_missing_employee_data','loop_document_expiry','loop_probation_ending']);

export async function undoLoopAction(supplied:SessionContext,input:Readonly<{actionId:unknown;confirm:unknown}>,now:Date=new Date()):Promise<LoopUndoResult>{
 const ctx=capture(supplied);
 if(input.confirm!==true)return refused('not_confirmed');
 if(typeof input.actionId!=='string'||!UUID.test(input.actionId))return refused('invalid');
 const actionId=input.actionId;
 try{
  if(!ctx.userId||ctx.agent)return refused('access');
  // 1. The action as the caller may read it.
  const seen:Seen|null=await withTenant(ctx,async tx=>{
   const [row]=await tx.select({workerId:terasLoopAction.workerId,employmentId:terasLoopAction.employmentId,personId:employment.personId,state:terasLoopAction.state,
    undoUntil:terasLoopAction.undoUntil,undone:terasLoopActionUndo.actionId,sponsorUserId:terasLoopAction.sponsorUserId,agentPrincipalId:terasLoopAction.agentPrincipalId,facts:terasLoopAction.facts,
    admin:sql<boolean>`app.can_admin_employment(${terasLoopAction.employmentId})`})
    .from(terasLoopAction).leftJoin(terasLoopActionUndo,eq(terasLoopActionUndo.actionId,terasLoopAction.id))
    .leftJoin(employment,eq(employment.id,terasLoopAction.employmentId))
    .where(and(eq(terasLoopAction.tenantId,ctx.tenantId),eq(terasLoopAction.id,actionId))).limit(1);
   return row?{...row,personId:row.personId??null,undone:row.undone!==null,admin:row.admin===true}:null;
  });
  if(!seen||!UNDOABLE.has(seen.workerId))return refused('unavailable');
  if(seen.undone||seen.state!=='applied')return refused('changed');
  if(now.getTime()>seen.undoUntil.getTime())return refused('expired');
  const own=!!ctx.personId&&seen.personId===ctx.personId;
  if(!own&&!seen.admin)return refused('access');
  // A probation review is HR's: the employee it is about never cancels it, not even their own.
  if(seen.workerId==='loop_probation_ending'&&own)return refused('access');
  // Keep historical records intact; the attendance editor starts a separately authorised human review.
  if(seen.workerId==='loop_missed_clock_outs')return refused('human_review_required');
  // 2. Whose authority compensates.
  const by:UndoneBy=own?'employee':'hr';
  const authority=own?await currentAuthority(ctx,seen.sponsorUserId):ctx;
  if(!authority)return refused('ask_hr');
  // 3. Compensate through the owner, and record the undo in the same transaction.
  await withTenant(authority,async tx=>{
   await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`teras-loop-undo:${ctx.tenantId}:${actionId}`},0))`);
   const [current]=await tx.select({state:terasLoopAction.state,undone:terasLoopActionUndo.actionId,facts:terasLoopAction.facts,ownerRef:terasLoopAction.ownerRef})
    .from(terasLoopAction).leftJoin(terasLoopActionUndo,eq(terasLoopActionUndo.actionId,terasLoopAction.id))
    .where(and(eq(terasLoopAction.tenantId,ctx.tenantId),eq(terasLoopAction.id,actionId))).limit(1);
   if(!current||current.state!=='applied'||current.undone!==null)throw new LoopUndoRefused('changed');
   let compensationRef:string;
   compensationRef=seen.workerId==='loop_probation_ending'
    ?await cancelLoopOpenedReviewTx(tx,authority,{reviewId:current.ownerRef!,loopActionId:actionId})
    :seen.workerId==='loop_document_expiry'
    ?await withdrawPassportRequestTx(tx,authority,{actionId,employmentId:seen.employmentId,by,askedByUserId:ctx.userId!})
    :await withdrawRequestTx(tx,authority,{actionId,employmentId:seen.employmentId,facts:current.facts,by,askedByUserId:ctx.userId!});
   await tx.insert(terasLoopActionUndo).values({actionId,tenantId:ctx.tenantId,undoneBy:by,undoneByUserId:ctx.userId!,compensationRef});
   await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'teras-loop-action',aggregateId:actionId,eventType:'teras-loop.action.undone',
    actor:{type:'user',id:ctx.userId!},subjectEmploymentId:seen.employmentId,payload:{workerId:seen.workerId,by,compensationRef,date:current.facts.date??null}});
  });
  return Object.freeze({kind:'undone' as const,by});
 }catch(error){
  if(error instanceof LoopUndoRefused)return refused(error.reason==='changed'?'changed':'unavailable');
  return refused('unavailable');
 }
}

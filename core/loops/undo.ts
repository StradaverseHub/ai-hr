/** AI v2 Phase 2 P2-1 — Undo on an automatic loop action, by the employee it concerns or by HR, within its window.
 *
 * Undo is a compensating correction through the owner, recorded as its own row and event, never a delete or an edit of
 * the action (migration 0963 teras_loop_action_undo, append-only, at most one per action):
 *  1. The action is read as the caller under row-level security: the employee reads their own, an administrator those
 *     of employments they administer. It must be applied, not undone yet, and before its deadline.
 *  2. Whose authority compensates: HR's own, for an administrator of the employment undoing someone else's day. For the
 *     employee's own undo, the loop compensates its own action under its sponsor's CURRENT authority, re-read from the
 *     database (the same resolution the runner uses), and records the employee who asked; a sponsor who lost
 *     administrator access cannot, and the employee is told to ask HR.
 *  3. The owner compensates, in a transaction carrying the loop's attribution with who asked (core/loops/attribution.ts),
 *     so the compensating record says the loop carried it out at the employee's or HR's request, for its sponsor: a
 *     missed clock-out's compensating correction (core/loops/act-clock-outs.ts compensateClockOutTx), or the withdrawal of
 *     a sent request (core/loops/act-requests.ts withdrawRequestTx). In the same transaction the undo row and an audit
 *     event are written. The database refuses the undo row after the deadline, for an action not applied, or by anyone
 *     who does not administer the employment.
 * The case then reopens on the loop's next run as a card for the person to confirm their own time. Only the person's
 * explicit press undoes (`confirm: true`). Errors are bounded to a refusal code. No model. Never throws. */
import {and,eq,sql} from 'drizzle-orm';
import {withTenant,type Grant,type SessionContext} from '../../db/client';
import {appendEvent} from '../../db/events';
import {employment} from '../../db/schema';
import {terasLoopAction,terasLoopActionUndo} from '../../db/teras-autonomy-schema';
import {isAdmin} from '../../lib/authz-model';
import {LoopUndoRefused,compensateClockOutTx} from './act-clock-outs';
import {withdrawRequestTx} from './act-requests';
import {attributionForTx,setLoopAttributionTx} from './attribution';
import type {UndoneBy} from './autonomy-types';
import type {LoopId} from './types';

export type LoopUndoRefusal='not_confirmed'|'invalid'|'unavailable'|'expired'|'changed'|'access'|'ask_hr';
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
const UNDOABLE:ReadonlySet<string>=new Set(['loop_missed_clock_outs','loop_missing_employee_data']);

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
  // 2. Whose authority compensates.
  const by:UndoneBy=own?'employee':'hr';
  const authority=own?await currentAuthority(ctx,seen.sponsorUserId):ctx;
  if(!authority)return refused('ask_hr');
  // 3. Compensate through the owner, and record the undo in the same transaction.
  await withTenant(authority,async tx=>{
   await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`teras-loop-undo:${ctx.tenantId}:${actionId}`},0))`);
   const [current]=await tx.select({state:terasLoopAction.state,undone:terasLoopActionUndo.actionId,facts:terasLoopAction.facts})
    .from(terasLoopAction).leftJoin(terasLoopActionUndo,eq(terasLoopActionUndo.actionId,terasLoopAction.id))
    .where(and(eq(terasLoopAction.tenantId,ctx.tenantId),eq(terasLoopAction.id,actionId))).limit(1);
   if(!current||current.state!=='applied'||current.undone!==null)throw new LoopUndoRefused('changed');
   // The loop carries the compensation out, at the employee's or HR's request, for its sponsor.
   await setLoopAttributionTx(tx,await attributionForTx(tx,{workerId:seen.workerId,principalId:seen.agentPrincipalId,actionId,employmentId:seen.employmentId,
    sponsorUserId:seen.sponsorUserId,askedBy:by,askedByUserId:ctx.userId!}));
   const compensationRef=seen.workerId==='loop_missed_clock_outs'
    ?await compensateClockOutTx(tx,authority,{actionId,employmentId:seen.employmentId,facts:current.facts,by})
    :await withdrawRequestTx(tx,authority,{actionId,employmentId:seen.employmentId,facts:current.facts,by,principalId:seen.agentPrincipalId});
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

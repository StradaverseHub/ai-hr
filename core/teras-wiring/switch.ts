/** ADR-0169 §5.1 and ADR-0170 §11.3 change 4 — which path the live chat takes for this caller.
 *
 * The Noveri conversation is a registered worker (core/agent-registry/workers.ts, id `conversation`) switched in
 * teras_worker_control: off by default, changed only by a group administrator through AI centre › Workers (or the
 * staging operator path), every change audited. The harness path is taken only when, in the caller's own
 * transaction, the worker gate is open (switched on, tenant not stopped) and the caller may use the Assistant (the
 * module is on and they hold a grant). Anything else, including any failure to read the switch, takes the closed
 * request grammar, unchanged. Nothing here turns anything on.
 *
 * The harness permit (core/harness/permit.ts) is issued here and nowhere else, for this tenant and login, once. */
import {and,eq} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../../db/client';
import {terasWorkerControl,type TerasAttestedProvider} from '../../db/teras-schema';
import {workerRunGateTx} from '../agent-registry/controls';
import {mayUseAssistant} from '../assistant-grant';
import {issueHarnessPermit,type HarnessPermit} from '../harness/permit';

export const CONVERSATION_WORKER='conversation' as const;
export type ConversationRoute=Readonly<{route:'closed'}>|Readonly<{route:'harness';permit:HarnessPermit;attestedProvider:TerasAttestedProvider|null;
 /** The explainers worker's own gate (ADR-0170 §3.13): off, and the turn is not offered the "Why?" explainers. */
 explainers:boolean}>;
const CLOSED:ConversationRoute=Object.freeze({route:'closed'});

export async function conversationRoute(supplied:SessionContext):Promise<ConversationRoute>{
 const ctx:SessionContext={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(grant=>({...grant}))};
 if(!ctx.userId||ctx.agent)return CLOSED;
 const userId=ctx.userId;
 try{
  return await withTenant(ctx,async tx=>{
   if(!(await workerRunGateTx(tx,ctx,CONVERSATION_WORKER)).run)return CLOSED;
   if(!(await mayUseAssistant(ctx,tx)).allowed)return CLOSED;
   const [row]=await tx.select({attestedProvider:terasWorkerControl.attestedProvider}).from(terasWorkerControl)
    .where(and(eq(terasWorkerControl.tenantId,ctx.tenantId),eq(terasWorkerControl.workerId,CONVERSATION_WORKER))).limit(1);
   const explainers=(await workerRunGateTx(tx,ctx,'explainers')).run;
   return Object.freeze({route:'harness' as const,permit:issueHarnessPermit(ctx.tenantId,userId),attestedProvider:row?.attestedProvider??null,explainers});
  });
 }catch{return CLOSED;}
}

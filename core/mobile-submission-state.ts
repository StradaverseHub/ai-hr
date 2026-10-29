/** Internal transaction helper. Callers verify own active employment and hold the submission writer's lock. */
import {and,eq} from 'drizzle-orm';
import {domainEvent} from '../db/schema';
import {actorOf,appendEvent} from '../db/events';
import type {SessionContext,Tx} from '../db/client';
type Kind='clock'|'leave';
export async function submissionAbandonedTx(tx:Tx,ctx:SessionContext,employmentId:string,kind:Kind,requestId:string){
  if(!ctx.userId)return false;
  const [event]=await tx.select({id:domainEvent.id}).from(domainEvent).where(and(
    eq(domainEvent.tenantId,ctx.tenantId),eq(domainEvent.aggregateType,`mobile-${kind}-abandonment`),
    eq(domainEvent.aggregateId,requestId),eq(domainEvent.actorId,ctx.userId),
    eq(domainEvent.subjectEmploymentId,employmentId),eq(domainEvent.eventType,'mobile.submission.abandoned'),
  )).limit(1);
  return !!event;
}
export async function abandonSubmissionTx(tx:Tx,ctx:SessionContext,employmentId:string,kind:Kind,requestId:string){
  if(!ctx.userId)throw new Error('Authenticated actor required');
  if(await submissionAbandonedTx(tx,ctx,employmentId,kind,requestId))return;
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:`mobile-${kind}-abandonment`,aggregateId:requestId,
    eventType:'mobile.submission.abandoned',actor:actorOf(ctx),subjectEmploymentId:employmentId,payload:{kind}});
}

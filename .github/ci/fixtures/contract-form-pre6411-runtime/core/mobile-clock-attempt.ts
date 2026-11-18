/** An immutable employee-reported attempt. This service never creates or adjusts attendance. */
import {and,desc,eq,sql} from 'drizzle-orm';
import {domainEvent} from '../db/schema';
import {appendEvent,actorOf} from '../db/events';
import type {SessionContext} from '../db/client';
import {withAttendanceTenant} from './module-gate';
import {resolveOwnClockEmployment,OwnClockEmploymentUnavailableError} from './attendance-clock-subject';
import {ClockPreparation,type ClockAttemptReceipt,type ClockAttemptsResponse} from '../lib/clock-attempt';
export class ClockAttemptConflict extends Error{}
export async function ownReportedClockAttempts(ctx:SessionContext,employmentId:string):Promise<ClockAttemptsResponse>{
  const own=await resolveOwnClockEmployment(ctx,employmentId);
  if(!own||!ctx.userId)throw new OwnClockEmploymentUnavailableError();
  return withAttendanceTenant(ctx,async tx=>{
    const rows=await tx.select({requestId:domainEvent.aggregateId,payload:domainEvent.payload,receivedAt:domainEvent.occurredAt}).from(domainEvent).where(and(
      eq(domainEvent.tenantId,ctx.tenantId),eq(domainEvent.aggregateType,'mobile-clock-attempt'),eq(domainEvent.actorId,ctx.userId!),
      eq(domainEvent.subjectEmploymentId,own.employmentId),eq(domainEvent.eventType,'mobile.clock.attempt.reported'),
    )).orderBy(desc(domainEvent.occurredAt),desc(domainEvent.sequence)).limit(20);
    return {items:rows.map(row=>{const input=ClockPreparation.parse(row.payload);if(input.requestId.toLowerCase()!==row.requestId.toLowerCase())throw new Error('Invalid attempt record');return {...input,receivedAt:row.receivedAt.toISOString()};})};
  });
}
export async function reportOwnClockAttempt(ctx:SessionContext,employmentId:string,input:unknown):Promise<ClockAttemptReceipt>{
  const command=ClockPreparation.parse(input),own=await resolveOwnClockEmployment(ctx,employmentId);
  if(!own||!ctx.userId)throw new OwnClockEmploymentUnavailableError();
  return withAttendanceTenant(ctx,async tx=>{
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ctx.tenantId+':'+own.employmentId},0))`);
    const lookup=()=>tx.select({payload:domainEvent.payload,createdAt:domainEvent.occurredAt}).from(domainEvent).where(and(
      eq(domainEvent.tenantId,ctx.tenantId),eq(domainEvent.aggregateType,'mobile-clock-attempt'),eq(domainEvent.aggregateId,command.requestId),
      eq(domainEvent.actorId,ctx.userId!),eq(domainEvent.subjectEmploymentId,own.employmentId),eq(domainEvent.eventType,'mobile.clock.attempt.reported'),
    )).limit(1);
    const [existing]=await lookup();
    if(existing){
      const original=ClockPreparation.parse(existing.payload);
      if(original.action!==command.action||original.claimedAt!==command.claimedAt)throw new ClockAttemptConflict('This reference describes a different attempt');
      return {requestId:command.requestId,receivedAt:existing.createdAt.toISOString()};
    }
    await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'mobile-clock-attempt',aggregateId:command.requestId,
      eventType:'mobile.clock.attempt.reported',actor:actorOf(ctx),subjectEmploymentId:own.employmentId,payload:command});
    const [recorded]=await lookup();
    if(!recorded)throw new Error('Attempt receipt unavailable');
    return {requestId:command.requestId,receivedAt:recorded.createdAt.toISOString()};
  });
}

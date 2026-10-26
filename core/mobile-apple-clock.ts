/** Internal signed online clock carrier. Deployment configuration is not loaded by a public route. */
import {and,eq} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext} from '../db/client';
import {attendanceClockCapture,domainEvent} from '../db/schema';
import {actorOf,appendEvent} from '../db/events';
import {clockCommandContext} from '../lib/clock-command-context';
import {captureNativeClockInTx,ClockConflictError} from './attendance-clock';
import {OutsideGeofenceError,appendGeofenceBlockedEvent} from './attendance';
import {withAttendanceTenant} from './module-gate';
import {myOwnEmploymentSubjectsTx} from './read';
import {OwnClockEmploymentUnavailableError} from './attendance-clock-subject';
import {createAppleClockAssertionService,type AppleClockAssertionInput} from './mobile-apple-clock-assertion';

/** The audit link describes checked historical enrollment evidence; no trust tier or assertion of
 * physical presence is created. Native receipt recovery remains available separately.
 */
export function createAppleClockService(settings:unknown){
  const assertions=createAppleClockAssertionService(settings);
  return {
    begin:assertions.begin,
    async complete(ctx:SessionContext,input:AppleClockAssertionInput,proof:{challengeId:string;assertion:Buffer}){
      const employmentId=z.string().uuid().parse(input.employmentId).toLowerCase(),requestId=z.string().uuid().parse(input.command.requestId).toLowerCase();
      const challengeId=z.string().uuid().parse(proof.challengeId).toLowerCase();
      try{
        const result=await assertions.consume(ctx,input,{challengeId,assertion:proof.assertion},async(tx,checked)=>{
          const {photo:photoMetadata,...command}=checked.context.command,scope=checked.context.scope;
          const receipt=await captureNativeClockInTx(ctx,{...command,employmentId:scope.employmentId,
            clockContext:clockCommandContext(scope.tenantId,scope.actorId,scope.employmentId),
            ...(checked.photo?{photo:checked.photo,mime:photoMetadata!.mimeType}:{}),deviceToken:checked.deviceToken},tx);
          await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'attendance-clock-capture',aggregateId:receipt.id,
            eventType:'attendance.clock.integrity.checked',actor:actorOf(ctx),subjectEmploymentId:scope.employmentId,
            payload:{challengeId:checked.context.challenge.id,keyId:scope.deviceKeyId,counter:checked.nextCounter,proofKind:checked.proofKind}});
          return receipt;
        });
        if(result.state==='consumed')return result.value;
        // Consumption has already checked the immutable command binding and never reruns the writer.
        // Recover only a capture linked to THIS challenge and actor; a prior v1 capture is insufficient.
        return withAttendanceTenant(ctx,async tx=>{
          if(!ctx.userId||!ctx.personId||!(await myOwnEmploymentSubjectsTx(tx,ctx,{profileEdit:true})).some(e=>e.employmentId===employmentId))throw new OwnClockEmploymentUnavailableError();
          const rows=await tx.select({capture:attendanceClockCapture,payload:domainEvent.payload}).from(attendanceClockCapture)
            .innerJoin(domainEvent,and(eq(domainEvent.aggregateId,attendanceClockCapture.id),eq(domainEvent.aggregateType,'attendance-clock-capture'),
              eq(domainEvent.eventType,'attendance.clock.integrity.checked'),eq(domainEvent.actorId,ctx.userId),eq(domainEvent.tenantId,ctx.tenantId)))
            .where(and(eq(attendanceClockCapture.employmentId,employmentId),eq(attendanceClockCapture.requestId,requestId))).limit(2);
          const found=rows.find(row=>(row.payload as {challengeId?:string}).challengeId===challengeId);
          if(!found)throw new ClockConflictError('The checked clock receipt is unavailable');
          const c=found.capture;return {id:c.id,direction:c.direction,recordedAt:c.serverRecordedAt.toISOString(),date:c.attendanceDate,
            photoAvailable:c.photoDigest!=null&&c.photoPurgedAt==null};
        });
      }catch(error){
        if(error instanceof OutsideGeofenceError)await appendGeofenceBlockedEvent(ctx,error);
        throw error;
      }
    },
  };
}

/** A batch is a bounded set of independent decisions over the existing application owner. */
import type { SessionContext } from '../../db/client';
import { attendanceApplicationDetail } from '../../core/attendance-application-history';
import { decideAttendanceCorrection } from '../../core/attendance';
import { attendanceHistoryId } from '../../lib/attendance-history-filter';
import { publicErrorMessage } from '../../lib/public-error';
export type AttendanceHistorySelection={id:string;stage:number|null;participantSlot?:string|null};
export async function decideAttendanceHistorySelection(ctx:SessionContext,companyIds:string[],p:{items:AttendanceHistorySelection[];decision:'approved'|'rejected';reason:string}){
  if(!Array.isArray(p.items)||!p.items.length||p.items.length>100)throw new Error('Select between one and 100 applications on this page.');
  if(!['approved','rejected'].includes(p.decision)||typeof p.reason!=='string'||p.reason.length>1000||(p.decision==='rejected'&&!p.reason.trim()))throw new Error('A rejection requires remarks of at most 1000 characters.');
  const seen=new Set<string>(),results:{id:string;status:'approved'|'rejected'|'pending'|'failed';message?:string}[]=[];
  for(const item of p.items){
    try{
      if(!item||typeof item.id!=='string'||!attendanceHistoryId(item.id)||seen.has(item.id)||(item.stage!==null&&(!Number.isInteger(item.stage)||item.stage<0)))throw new Error('Invalid or duplicate selection.');
      seen.add(item.id);
      const detail=await attendanceApplicationDetail(ctx,companyIds,item.id);
      if(!detail?.canDecide)throw new Error('This application is not available for your decision.');
      if((detail.workflow?.currentStage??null)!==item.stage)throw new Error('The approval stage changed. Reload before deciding.');
      if(detail.workflow?.routingVersion===3&&(typeof item.participantSlot!=='string'||item.participantSlot!==detail.workflow.currentParticipantSlot))throw new Error('The approval participant changed. Reload before deciding.');
      const outcome=await decideAttendanceCorrection(ctx,{correctionId:item.id,decision:p.decision,rejectReason:p.reason.trim(),remarks:p.reason.trim(),expectedStageIndex:item.stage??undefined,expectedParticipantSlot:item.participantSlot??undefined});
      results.push({id:item.id,status:outcome.status});
    }catch(error){results.push({id:item?.id??'',status:'failed',message:publicErrorMessage(error)});}
  }
  return results;
}

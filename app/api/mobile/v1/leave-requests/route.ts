import { listLeaveRequestsPage } from '@/core/read';
import { submitMobileLeave,MobileLeaveReplayConflict } from '@/core/mobile-leave-command';
import * as leave from '@/packs/leave/service';
import { LeaveRequestsResponse,LeaveCommand,LeaveResult } from '@/lib/mobile-api/contract';
import { mobileRoute,MobileBadRequest } from '@/lib/mobile-api/handler';
import { mobileEmployment } from '@/lib/mobile-api/request';
import { mobileForm } from '@/lib/mobile-api/body';
export const GET = mobileRoute(LeaveRequestsResponse,async(s,req)=>{
  const employmentId=await mobileEmployment(s,req);
  const page=employmentId?await listLeaveRequestsPage(s,{employmentIds:[employmentId],limit:50,offset:0}):{total:0,rows:[]};
  return {employmentId,total:page.total,items:page.rows.map(r=>({id:r.id,type:r.leaveType,from:r.startDate,to:r.endDate,status:r.status,partial:!!r.hasRejectedDates}))};
});
export const POST = mobileRoute(LeaveResult,async(s,req)=>{
  const employmentId=await mobileEmployment(s,req);
  if(!employmentId)throw new MobileBadRequest('No own employment');
  const form=await mobileForm(req,['command','document'],11*1024*1024);
  let command:ReturnType<typeof LeaveCommand.parse>;
  try{command=LeaveCommand.parse(JSON.parse(String(form.get('command'))));}catch{throw new MobileBadRequest('Invalid command');}
  const file=form.get('document');
  if(file!=null&&(!(file instanceof File)||!file.size||file.name.length>200))throw new MobileBadRequest('Invalid document');
  try{
    return await submitMobileLeave(s,employmentId,command,file instanceof File?{fileName:file.name,mimeType:file.type,content:Buffer.from(await file.arrayBuffer())}:undefined);
  }catch(e){
    // Only explicit domain error constructors may send a message. Never database/driver/Error.message.
    const domain=Object.entries(leave).some(([name,value])=>/^(Leave|InsufficientLeave|NegativeLeave|CombinedLeave|UnpaidConsent|DuplicateLeave|MarriageLeave|HourlyLeave|MissingReject).*Error$/.test(name)&&typeof value==='function'&&e instanceof (value as typeof Error));
    if(domain||e instanceof MobileLeaveReplayConflict)return {outcome:'refused' as const,code:'leave_refused' as const,message:(e as Error).message};
    throw e;
  }
});

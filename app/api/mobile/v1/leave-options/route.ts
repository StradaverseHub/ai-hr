import { listEligibleLeaveTypesFor } from '@/core/read';
import { leaveTypeIs } from '@/packs/leave/service';
import { LeaveOptionsResponse } from '@/lib/mobile-api/contract';
import { mobileRoute } from '@/lib/mobile-api/handler';
import { mobileEmployment,mobileLocale } from '@/lib/mobile-api/request';
export const GET = mobileRoute(LeaveOptionsResponse,async(s,req)=>{
  const employmentId=await mobileEmployment(s,req);
  const types=employmentId?await listEligibleLeaveTypesFor(s,employmentId,mobileLocale(req)):[];
  return {employmentId,items:types.map(t=>({id:t.id,name:t.name,code:t.code,durations:['full_day' as const,...(t.durations??[]).filter((v):v is 'half_day_am'|'half_day_pm'|'hourly'=>['half_day_am','half_day_pm','hourly'].includes(v))],requiresDocument:t.requiresDocument??false,mandatoryAfterDays:t.mandatoryAfterDays??null,allowedMimeTypes:t.allowedMimeTypes??[],maxDocBytes:t.maxDocBytes??10*1024*1024,employeeRemarkRequired:t.employeeRemarkRequired??false,emergencySplit:leaveTypeIs(t,'emergency')&&t.balanceSourceTypeId==null,maternity:leaveTypeIs(t,'maternity'),notice:typeof t.customMessages?.applyNotice==='string'?t.customMessages.applyNotice:null}))};
});

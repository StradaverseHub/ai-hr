import { listEligibleLeaveTypesFor } from '@/core/read';
import { previewLeaveDeduction } from '@/packs/leave/service';
import { LeaveCommand,LeavePreviewResponse } from '@/lib/mobile-api/contract';
import { mobileRoute,MobileBadRequest } from '@/lib/mobile-api/handler';
import { mobileEmployment } from '@/lib/mobile-api/request';
import { mobileInput } from '@/lib/mobile-api/body';
import { todayInKualaLumpur } from '@/lib/hr-date';
export const POST = mobileRoute(LeavePreviewResponse,async(s,req)=>{
  const employmentId=await mobileEmployment(s,req);
  const command=LeaveCommand.safeParse(await mobileInput(req));
  if(!employmentId||!command.success)throw new MobileBadRequest('Invalid preview');
  if(!(await listEligibleLeaveTypesFor(s,employmentId)).some(t=>t.id===command.data.leaveTypeId))throw new MobileBadRequest('Type not available');
  // Day-based preview is core's existing contract. Hourly figures are never invented from a day count.
  if(command.data.durationType==='hourly')return {days:null,unpaidDays:null,emergencySplit:false,overrides:[]};
  const result=await previewLeaveDeduction(s,{...command.data,employmentId,today:todayInKualaLumpur()});
  return {days:result.days,unpaidDays:result.unpaidDays??null,emergencySplit:result.isEmergencySplit,overrides:(result.overrides??[]).map(o=>({consentToken:o.consentToken,needsConsent:o.needsConsent,action:o.action,fromTypeName:o.fromTypeName,toTypeName:o.toTypeName,daysInAdvance:o.daysInAdvance,minAdvanceDays:o.minAdvanceDays,minAdvanceDayType:o.minAdvanceDayType,paidDays:o.paidDays,unpaidDays:o.unpaidDays}))};
});

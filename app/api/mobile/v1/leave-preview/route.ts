import { listEligibleLeaveTypesFor } from '@/core/read';
import { HourlyLeaveTimeRangeError,previewLeaveDeduction } from '@/packs/leave/service';
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
  // Hourly: only a complete From/To window is previewed, through the rule requestLeave deducts by (core D5(c)
  // hourlyLeaveWindow/hourlyLeaveDays). An incomplete or malformed window keeps v1's original answer, days null:
  // a figure is never invented, and the submission refuses the window itself.
  const NO_FIGURE={days:null,unpaidDays:null,emergencySplit:false,overrides:[]};
  const hourly=command.data.durationType==='hourly';
  if(hourly&&(!command.data.fromTime||!command.data.toTime))return NO_FIGURE;
  let result:Awaited<ReturnType<typeof previewLeaveDeduction>>;
  try{result=await previewLeaveDeduction(s,{...command.data,employmentId,today:todayInKualaLumpur()});}
  catch(e){if(hourly&&e instanceof HourlyLeaveTimeRangeError)return NO_FIGURE;throw e;}
  return {days:result.days,unpaidDays:result.unpaidDays??null,emergencySplit:result.isEmergencySplit,overrides:(result.overrides??[]).map(o=>({consentToken:o.consentToken,needsConsent:o.needsConsent,action:o.action,fromTypeName:o.fromTypeName,toTypeName:o.toTypeName,daysInAdvance:o.daysInAdvance,minAdvanceDays:o.minAdvanceDays,minAdvanceDayType:o.minAdvanceDayType,paidDays:o.paidDays,unpaidDays:o.unpaidDays}))};
});

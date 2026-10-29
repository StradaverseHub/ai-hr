import {reportOwnClockAttempt,ownReportedClockAttempts,ClockAttemptConflict} from '@/packs/attendance/service';
import {ClockPreparation,ClockAttemptReceipt,ClockAttemptsResponse} from '@/lib/mobile-api/contract';
import {mobileRoute,MobileBadRequest} from '@/lib/mobile-api/handler';
import {mobileEmployment} from '@/lib/mobile-api/request';
import {mobileInput} from '@/lib/mobile-api/body';
import {isModuleEnabled} from '@/core/entitlements';
export const GET = mobileRoute(ClockAttemptsResponse,async(s,req)=>{
  if(!isModuleEnabled(s,'attendance'))return {items:[]};
  const employmentId=await mobileEmployment(s,req);
  return employmentId?ownReportedClockAttempts(s,employmentId):{items:[]};
});
export const POST = mobileRoute(ClockAttemptReceipt,async(s,req)=>{
  if(!isModuleEnabled(s,'attendance'))throw new MobileBadRequest('Attendance is unavailable');
  const employmentId=await mobileEmployment(s,req);
  if(!employmentId)throw new MobileBadRequest('No own employment');
  const input=ClockPreparation.safeParse(await mobileInput(req,512));
  if(!input.success)throw new MobileBadRequest('Invalid attempt');
  try{return await reportOwnClockAttempt(s,employmentId,input.data);}
  catch(error){if(error instanceof ClockAttemptConflict)throw new MobileBadRequest('Conflicting attempt');throw error;}
});

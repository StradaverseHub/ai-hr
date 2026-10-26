import {reportOwnClockAttempt,ClockAttemptConflict} from '@/packs/attendance/service';
import {ClockPreparation,ClockAttemptReceipt} from '@/lib/mobile-api/contract';
import {mobileRoute,MobileBadRequest} from '@/lib/mobile-api/handler';
import {mobileEmployment} from '@/lib/mobile-api/request';
import {mobileInput} from '@/lib/mobile-api/body';
export const POST = mobileRoute(ClockAttemptReceipt,async(s,req)=>{
  const employmentId=await mobileEmployment(s,req);
  if(!employmentId)throw new MobileBadRequest('No own employment');
  const input=ClockPreparation.safeParse(await mobileInput(req,512));
  if(!input.success)throw new MobileBadRequest('Invalid attempt');
  try{return await reportOwnClockAttempt(s,employmentId,input.data);}
  catch(error){if(error instanceof ClockAttemptConflict)throw new MobileBadRequest('Conflicting attempt');throw error;}
});

import {previewOwnClockLocation} from '@/packs/attendance/service';
import {ClockLocationCommand,ClockLocationResponse} from '@/lib/mobile-api/contract';
import {mobileRoute,MobileBadRequest} from '@/lib/mobile-api/handler';
import {mobileEmployment} from '@/lib/mobile-api/request';
import {mobileInput} from '@/lib/mobile-api/body';
/** Location stays out of URLs. This bounded POST performs no attendance or evidence writes. */
export const POST = mobileRoute(ClockLocationResponse,async(s,req)=>{
  const employmentId=await mobileEmployment(s,req);
  if(!employmentId)throw new MobileBadRequest('No own employment');
  const parsed=ClockLocationCommand.safeParse(await mobileInput(req,512));
  if(!parsed.success)throw new MobileBadRequest('Invalid location');
  return previewOwnClockLocation(s,employmentId,parsed.data);
});

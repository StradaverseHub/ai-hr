import {abandonNativeClock} from '@/packs/attendance/service';
import {abandonMobileLeave} from '@/core/mobile-leave-command';
import {SubmissionAbandonCommand,SubmissionAbandonResponse} from '@/lib/mobile-api/contract';
import {mobileRoute,MobileBadRequest} from '@/lib/mobile-api/handler';
import {mobileEmployment} from '@/lib/mobile-api/request';
import {mobileInput} from '@/lib/mobile-api/body';

/** Explicitly prevents an unaccepted request from recording; accepted facts keep their original receipt. */
export const POST=mobileRoute(SubmissionAbandonResponse,async(s,req)=>{
  const employmentId=await mobileEmployment(s,req);
  if(!employmentId)throw new MobileBadRequest('Own employment required');
  const parsed=SubmissionAbandonCommand.safeParse(await mobileInput(req,512));
  if(!parsed.success)throw new MobileBadRequest('Invalid submission selector');
  const {kind,requestId}=parsed.data;
  return kind==='clock'?{kind,requestId,...await abandonNativeClock(s,employmentId,requestId)}:
    {kind,requestId,...await abandonMobileLeave(s,employmentId,requestId)};
});

import {z} from 'zod';
import {ownNativeClockReceipt} from '@/packs/attendance/service';
import {ownMobileLeaveReceipt} from '@/core/mobile-leave-command';
import {SubmissionReceiptResponse} from '@/lib/mobile-api/contract';
import {mobileRoute,MobileBadRequest} from '@/lib/mobile-api/handler';
import {mobileEmployment} from '@/lib/mobile-api/request';
const selector=z.object({kind:z.enum(['clock','leave']),requestId:z.string().uuid()});
export const GET = mobileRoute(SubmissionReceiptResponse,async(s,req)=>{
  const params=new URL(req.url).searchParams;
  if(params.getAll('kind').length!==1||params.getAll('requestId').length!==1)throw new MobileBadRequest('Invalid receipt selector');
  const parsed=selector.safeParse({kind:params.get('kind'),requestId:params.get('requestId')});
  const employmentId=await mobileEmployment(s,req);
  if(!employmentId||!parsed.success)throw new MobileBadRequest('Invalid receipt selector');
  const {kind,requestId}=parsed.data;
  return kind==='clock'?{kind,requestId,receipt:await ownNativeClockReceipt(s,employmentId,requestId)}:
    {kind,requestId,receipt:await ownMobileLeaveReceipt(s,employmentId,requestId)};
});

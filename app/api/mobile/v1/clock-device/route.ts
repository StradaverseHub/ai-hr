import { registerDevice } from '@/packs/attendance/service';
import { assertModuleEnabled } from '@/core/entitlements';
import { DeviceCommand,DeviceResponse } from '@/lib/mobile-api/contract';
import { mobileRoute,MobileBadRequest } from '@/lib/mobile-api/handler';
import { mobileEmployment } from '@/lib/mobile-api/request';
import { mobileInput } from '@/lib/mobile-api/body';
/** Basic registration enforces the existing device policy; it is not hardware attestation. */
export const POST = mobileRoute(DeviceResponse,async(s,req)=>{
  assertModuleEnabled(s,'attendance');
  const employmentId=await mobileEmployment(s,req);
  if(!employmentId)throw new MobileBadRequest('No own employment');
  const parsed=DeviceCommand.safeParse(await mobileInput(req));
  if(!parsed.success)throw new MobileBadRequest('Invalid registration');
  return registerDevice(s,{employmentId,label:parsed.data.label});
});
